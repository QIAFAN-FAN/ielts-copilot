// 翻译调度：先查 AI 结果缓存 → 再试离线词表 → 需要时才调用 AI。
// 目标：常用划词完全零 token，重复内容只花一次钱。

import { translateLocal, setLearnedWords } from './dict.js';
import { chatCompletion, parseLooseJson } from './deepseek.js';
import { buildMessages } from './prompts.js';
import {
  getGlossary,
  getLearningBundle,
  filterGlossary,
  recordCandidate
} from './glossary.js';

const CACHE_KEY = 'transCache';
const CACHE_MAX = 500;
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const CACHE_VERSION = 'v3'; // 提示词/参数变化时改这里，旧缓存自动失效
const CACHE_TOTAL_CHARS = 2_000_000; // 缓存正文总字符上限，避免整篇翻译把 storage.local 撑爆

/**
 * L1 内存缓存：短时间内反复划同一句话（来回对照原文）时，
 * 内存 Map 比读 chrome.storage 快得多，连 storage 的异步往返都省了。
 */
const memoryCache = new Map();
const MEMORY_MAX = 120;

function memoryGet(key) {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  // 顺带做个 LRU：命中就挪到末尾
  memoryCache.delete(key);
  memoryCache.set(key, hit);
  return hit;
}

function memorySet(key, result) {
  if (!result?.ok || !result.translation) return result;
  memoryCache.set(key, result);
  while (memoryCache.size > MEMORY_MAX) {
    memoryCache.delete(memoryCache.keys().next().value);
  }
  return result;
}

/** 智能档下判定「离线直译已经够用」的门槛：覆盖率够高、句子不长、没有生词也没有从句，才不调 AI */
const SMART_OFFLINE_COVERAGE = 0.95;
const SMART_OFFLINE_MAX_WORDS = 25;
/** 有从句的句子逐词直译出来语序很乱，宁可直接调 AI */
const CLAUSE_RE = /\b(which|that|who|whom|whose|because|although|though|whereas|whilst)\b/i;

/**
 * 缓存键必须覆盖「所有会影响译文的输入」。
 * 同一句话「带上下文 / 不带上下文」「中文讲解 / 英文讲解」「换模型」得到的译文都可能不同，
 * 只按纯文本做 key 会把这些结果串在一起（划词时拿到的是上一次带上下文的译文）。
 */
function hashKey({ text, contextText = '', explainLang = '', model = '', glossaryVersion: gv = 0 }) {
  const seed = `${text}\u0000${contextText}\u0000${explainLang}\u0000${model}\u0000${gv}\u0000${CACHE_VERSION}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}-${seed.length}`;
}

async function readCache(key) {
  try {
    const raw = await chrome.storage.local.get(CACHE_KEY);
    const entry = (raw[CACHE_KEY] || {})[key];
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) return null;
    return entry.data;
  } catch {
    return null;
  }
}

async function writeCache(key, data) {
  try {
    const raw = await chrome.storage.local.get(CACHE_KEY);
    const cache = raw[CACHE_KEY] || {};
    cache[key] = { ts: Date.now(), data, size: JSON.stringify(data).length };

    // 先按条数裁
    let keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => (cache[a]?.ts || 0) - (cache[b]?.ts || 0));
      for (const old of keys.slice(0, keys.length - CACHE_MAX)) delete cache[old];
    }
    // 再按总体积裁（保留最新的）
    keys = Object.keys(cache);
    let total = keys.reduce((sum, item) => sum + (cache[item]?.size || 0), 0);
    if (total > CACHE_TOTAL_CHARS) {
      keys.sort((a, b) => (cache[a]?.ts || 0) - (cache[b]?.ts || 0));
      for (const old of keys) {
        if (total <= CACHE_TOTAL_CHARS) break;
        total -= cache[old]?.size || 0;
        delete cache[old];
      }
    }
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

export async function clearTranslationCache() {
  await chrome.storage.local.remove(CACHE_KEY);
}

export async function translationCacheSize() {
  const raw = await chrome.storage.local.get(CACHE_KEY);
  return Object.keys(raw[CACHE_KEY] || {}).length;
}

async function aiTranslate({ text, contextText, settings, signal }) {
  // 只把「真的出现在这段文字里」的术语注入 prompt，整库塞进去反而拖慢又降质
  let glossary = {};
  try {
    glossary = filterGlossary(await getGlossary(), text);
  } catch {
    /* 术语库读不到就当没有 */
  }

  const { messages, jsonMode } = buildMessages('translate', {
    text,
    contextText: contextText || '',
    explainLang: settings.explainLang,
    glossary
  });
  const raw = await chatCompletion({ settings, messages, jsonMode, stream: false, signal });
  const data = parseLooseJson(raw) || {};
  const vocab = Array.isArray(data.vocab) ? data.vocab : [];

  // 顺手把 AI 给出的词级释义记进候选池：同一个词攒够 3 次一致，就会进离线词表，
  // 以后含它的句子离线就认识 → 零 token。不 await，不拖慢这次的翻译。
  for (const item of vocab) {
    recordCandidate(item?.en, item?.zh).catch(() => {});
  }

  return {
    translation: data.translation || raw.trim(),
    key: data.key || '',
    vocab
  };
}

/**
 * 统一翻译入口。
 * settings.translateEngine:
 *   'local' —— 只用内置词表（零 token，句子给直译）
 *   'smart' —— 能离线就离线，生词多/句子复杂才用 AI（默认）
 *   'ai'    —— 一律走 AI（命中过缓存就用缓存）
 * forceAi：气泡里的「AI 精译」按钮，跳过离线词表直接走 AI（但仍先查缓存）
 * preferOffline：「先出结果」模式。只算离线词表就返回，并在结果里带 needAi 标记，
 *                让气泡先瞬间显示直译、再决定要不要补一次 AI。划词速度主要靠它。
 */
export async function translateText({
  text,
  contextText,
  settings,
  signal,
  forceAi = false,
  preferOffline = false
}) {
  const value = String(text || '').trim();
  if (!value) return { ok: false, error: 'EMPTY' };

  const engine = settings?.translateEngine || 'smart';

  // 一次读回「术语约束 + AI 学到的词」。学到的词先注入离线词表：
  // 它们让原本查不到的词变成「认识」，覆盖率上去了就能走离线、不再消耗 token。
  const bundle = await getLearningBundle();
  setLearnedWords(bundle.learned, bundle.version);

  // 缓存键把「上下文 / 讲解语言 / 模型 / 术语库版本」都算进去：
  // 前面几项不同译文就不同，术语库改了也要让旧缓存自动失效。
  const cacheKey = hashKey({
    text: value,
    contextText: contextText || '',
    explainLang: settings?.explainLang || '',
    model: settings?.model || '',
    glossaryVersion: bundle.version
  });

  // L1 内存缓存：反复划同一句时直接命中，连 storage 往返都省掉。
  // 注意 forceAi（气泡里的「AI 精译」）必须跳过它 —— 用户明确要 AI 结果，
  // 不能拿刚才那份离线直译糊弄过去，否则按钮看着像坏了。
  if (!forceAi) {
    const cachedInMemory = memoryGet(cacheKey);
    if (cachedInMemory) return cachedInMemory;
  }

  // 缓存优先（forceAi 也走缓存，避免同一段文字反复烧 token）
  if (engine !== 'local' && !preferOffline) {
    const cached = await readCache(cacheKey);
    if (cached?.translation) {
      return memorySet(cacheKey, {
        ...cached,
        ok: true,
        exact: true,
        engine: 'cache',
        quality: 'exact'
      });
    }
  }

  // 「AI 精译」：跳过离线词表，直接调 AI
  if (forceAi) {
    if (!settings?.apiKey) return { ok: false, error: 'NO_API_KEY' };
    try {
      const ai = await aiTranslate({ text: value, contextText, settings, signal });
      if (ai.translation) {
        await writeCache(cacheKey, ai);
        return memorySet(cacheKey, { ...ai, ok: true, exact: true, quality: 'exact', engine: 'ai' });
      }
    } catch (err) {
      // AI 失败就退回离线词典，至少让用户看到点东西
      const fallback = translateLocal(value);
      if (fallback?.ok) return { ...fallback, engine: 'local', degraded: String(err?.message || err) };
      throw err;
    }
    return { ok: false, error: 'EMPTY_RESULT' };
  }

  const local = engine === 'ai' ? null : translateLocal(value);

  if (engine === 'local') {
    if (local?.ok) return { ...local, engine: 'local', exact: Boolean(local.exact) };
    return {
      ok: false,
      error: 'LOCAL_MISS',
      message: '内置词表里没有这段内容。可以在设置里把「翻译方式」改成「AI 翻译」或「智能」。'
    };
  }

  // 智能档：能离线就不花 token
  if (engine === 'smart' && local?.ok) {
    // 整段文字在词表里精确命中（划单词/词组）→ 直接给，永远不走 AI。这是最快的路径。
    // 离线结果**不进内存缓存**：它算起来纯本地、几乎不花时间，
    // 而缓存起来会让「AI 精译」拿到这份离线结果（forceAi 找不到真 AI 结果）。
    if (local.exact) return { ...local, engine: 'local' };

    // 逐词直译只在「短、全认识、没有从句」时才敢用：
    // 覆盖率宽松会让生词多的句子也硬翻出来，读起来是断的，不如老老实实调 AI。
    const unknownCount = (local.vocab || []).filter((item) => item.zh === '词表未收录').length;
    const reliable =
      (local.coverage || 0) >= SMART_OFFLINE_COVERAGE &&
      (local.wordCount || 0) <= SMART_OFFLINE_MAX_WORDS &&
      unknownCount === 0 &&
      !CLAUSE_RE.test(value);
    if (reliable) return { ...local, engine: 'local', quality: 'gloss-ok' };

    // 「先出结果」模式（划词气泡用）：立刻把离线直译还回去，同时标记值得再调一次 AI，
    // 由调用方决定要不要发第二次请求。这样划词几乎是瞬间出结果，而不是干等模型。
    if (preferOffline) return { ...local, engine: 'local', quality: 'gloss', needAi: true };
  }

  if (!settings?.apiKey) {
    if (local?.ok) return { ...local, engine: 'local', degraded: 'NO_API_KEY' };
    return { ok: false, error: 'NO_API_KEY' };
  }

  try {
    const ai = await aiTranslate({ text: value, contextText, settings, signal });
    if (ai.translation) {
      await writeCache(cacheKey, ai);
      return memorySet(cacheKey, { ...ai, ok: true, exact: true, quality: 'exact', engine: 'ai' });
    }
  } catch (err) {
    if (local?.ok) {
      return { ...local, engine: 'local', degraded: String(err?.message || err) };
    }
    throw err;
  }

  if (local?.ok) return { ...local, engine: 'local' };
  return { ok: false, error: 'EMPTY_RESULT' };
}
