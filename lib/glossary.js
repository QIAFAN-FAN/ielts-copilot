// 术语库 + 词汇学习。
//
// 两个职责，共用一个 storage 记录（一次读取就能拿到全部，翻译时不用来回读）：
//
// ① 术语库（custom / disabled）：用户指定「这个词必须翻成这个意思」，翻译时注入 prompt 约束。
//    解决 bank 该翻「河岸」而不是「银行」这类问题。
//
// ② 词汇学习（learned / candidates）：AI 翻译时会顺手返回这条句子里生词的词级释义
//    （vocab:[{en,zh}]），把这些词攒下来。同一个词被 AI 释义 3 次且结果一致，就收进
//    `learned` —— 而 learned 会喂给内置离线词表，于是**这个词以后离线就认识了，
//    再划到含它的句子直接走离线、零 token**。这就是「翻得越多越省」的闭环。
//
// 存储（chrome.storage.local 的 glossary 键）：
//   {
//     custom:     { "bank": "河岸" },          // 术语约束（用户手动）
//     disabled:   ["article"],                  // 被屏蔽的内置术语
//     learned:    { "mitigate": "缓解" },       // AI 学到的词（喂给离线词表）
//     candidates: { "bank": { "河岸": 2 } },    // 候选池
//     version:    3                             // 每次 custom/disabled 变更 +1
//   }
//
// version 只跟术语约束有关：它参与翻译缓存键（改了术语，旧译文自动重算）。
// 词汇学习**不动 version**，否则每学一个词就会让全部翻译缓存失效。

import { GLOSSARY_RAW } from './glossary-data.js';
import { lookupEnglish } from './dict.js';

const KEY = 'glossary';

/** 同一个词被 AI 释义这么多次、且结果一致，才敢收进离线词表 */
const CANDIDATE_MIN_HITS = 3;
/** 占比门槛：避免一个词两种意思各占一半时被错误收录 */
const CANDIDATE_AGREEMENT = 0.8;
/** 试了这么多次还定不下来（释义太杂），放弃这个词 */
const CANDIDATE_MAX_ATTEMPTS = 8;
/** 已学词表条数上限，防止 storage 无限膨胀（超了丢最早的） */
const LEARNED_MAX = 4000;
/** 明显不是词条的内容不记录（AI 偶尔会把整句塞进 en） */
const MAX_WORD_LEN = 40;
const MAX_MEANING_LEN = 60;

/** 预置术语（英文小写 → 中文译名）。解析规则：跳过空行和注释行，只认含 | 的行。 */
export const PRESET = (() => {
  const map = {};
  for (const line of GLOSSARY_RAW.split('\n')) {
    const text = line.trim();
    if (!text || !text.includes('|')) continue;
    const index = text.indexOf('|');
    const en = text.slice(0, index).trim().toLowerCase();
    const zh = text.slice(index + 1).trim();
    if (en && zh) map[en] = zh;
  }
  return map;
})();

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

async function readStore() {
  try {
    const raw = await chrome.storage.local.get(KEY);
    const data = raw?.[KEY];
    return {
      custom: plainObject(data?.custom),
      disabled: Array.isArray(data?.disabled) ? [...data.disabled] : [],
      learned: plainObject(data?.learned),
      candidates: plainObject(data?.candidates),
      version: Number(data?.version) || 0
    };
  } catch {
    return { custom: {}, disabled: [], learned: {}, candidates: {}, version: 0 };
  }
}

/** bump: 只有术语约束发生变化时才 +1（版本号参与翻译缓存键，学习不该让缓存失效） */
async function writeStore(store, { bump = false } = {}) {
  await chrome.storage.local.set({
    [KEY]: {
      custom: store.custom,
      disabled: store.disabled,
      learned: store.learned,
      candidates: store.candidates,
      version: bump ? (Number(store.version) || 0) + 1 : Number(store.version) || 0
    }
  });
}

/* ---------------- 术语库 ---------------- */

/** 合并后的完整术语表：用户自定义覆盖预置，disabled 里的预置条目被屏蔽 */
export async function getGlossary() {
  const store = await readStore();
  const merged = { ...PRESET, ...store.custom };
  for (const en of store.disabled) delete merged[String(en).toLowerCase()];
  return merged;
}

/** 术语库版本号：供翻译缓存失效用 */
export async function glossaryVersion() {
  const store = await readStore();
  return store.version;
}

/** 手动添加 / 覆盖一条术语 */
export async function addTerm(en, zh) {
  const word = String(en || '').trim().toLowerCase();
  const meaning = String(zh || '').trim();
  if (!word || !meaning) return { ok: false, error: 'EMPTY' };

  const store = await readStore();
  store.custom[word] = meaning;
  store.disabled = store.disabled.filter((item) => item !== word);
  await writeStore(store, { bump: true });
  return { ok: true, word, meaning };
}

/**
 * 删除一条术语。
 * 预置条目删不掉（它是代码里的常量），但可以「屏蔽」，效果一样。
 */
export async function removeTerm(en) {
  const word = String(en || '').trim().toLowerCase();
  if (!word) return { ok: false, error: 'EMPTY' };

  const store = await readStore();
  const wasCustom = Object.prototype.hasOwnProperty.call(store.custom, word);
  delete store.custom[word];
  if (!wasCustom && Object.prototype.hasOwnProperty.call(PRESET, word)) {
    if (!store.disabled.includes(word)) store.disabled.push(word);
  }
  await writeStore(store, { bump: true });
  return { ok: true, word };
}

/** 恢复所有被屏蔽的预置术语 */
export async function resetDisabled() {
  const store = await readStore();
  store.disabled = [];
  await writeStore(store, { bump: true });
  return { ok: true };
}

/**
 * 只保留「真的出现在这段文字里」的术语。
 * 整库往里塞会把 system prompt 撑大，反而降低翻译质量和速度。
 *
 * 用**词边界**匹配而不是 includes：否则 willing 会命中 will、lastly 会命中 last、
 * 一个子串就可能把无关的约束注入进去。
 */
export function filterGlossary(glossary, text) {
  const lower = String(text || '').toLowerCase();
  const out = {};
  for (const [en, zh] of Object.entries(glossary || {})) {
    const word = String(en || '').toLowerCase();
    if (!word) continue;
    if (!lower.includes(word)) continue; // 先粗筛，绝大多数条目在这里就跳过了
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![a-z])${escaped}(?![a-z])`).test(lower)) out[en] = zh;
  }
  return out;
}

/** 给设置页用：返回可直接渲染的术语列表 */
export async function listGlossary() {
  const store = await readStore();
  const rows = [];
  for (const [en, zh] of Object.entries(PRESET)) {
    if (store.disabled.includes(en)) continue;
    rows.push({ en, zh, custom: Object.prototype.hasOwnProperty.call(store.custom, en) });
  }
  for (const [en, zh] of Object.entries(store.custom)) {
    if (Object.prototype.hasOwnProperty.call(PRESET, en)) continue;
    rows.push({ en, zh, custom: true });
  }
  rows.sort((a, b) => a.en.localeCompare(b.en));
  return rows;
}

/* ---------------- 词汇学习 ---------------- */

/**
 * 翻译流程用：一次把「学到的词 + 版本号」读回来，
 * 交给 dict.js 的 setLearnedWords 注入离线词表。
 */
export async function getLearningBundle() {
  const store = await readStore();
  return { learned: store.learned, version: store.version };
}

/**
 * 记录一次 AI 给出的词级释义。
 * 同一个词被释义 CANDIDATE_MIN_HITS 次、且这个释义占比 ≥ CANDIDATE_AGREEMENT，
 * 就收进 learned（它会被喂给内置离线词表，以后这个词离线就认识 → 零 token）。
 */
export async function recordCandidate(en, zh) {
  const word = String(en || '').trim().toLowerCase();
  const meaning = String(zh || '').trim();
  if (!word || !meaning) return { ok: false, reason: 'EMPTY' };
  if (meaning.includes('词表未收录')) return { ok: false, reason: 'UNKNOWN' };
  if (word.length > MAX_WORD_LEN || meaning.length > MAX_MEANING_LEN) return { ok: false, reason: 'TOO_LONG' };
  if (!/^[a-z][a-z' -]*$/.test(word)) return { ok: false, reason: 'NOT_A_WORD' };
  // 内置词表（含已学到的）里已经有，就不用再学了
  try {
    if (lookupEnglish(word)) return { ok: false, reason: 'ALREADY_KNOWN' };
  } catch {
    /* 查不到就当没有，继续记录 */
  }

  const store = await readStore();
  if (Object.prototype.hasOwnProperty.call(store.learned, word)) return { ok: false, reason: 'ALREADY_LEARNED' };

  const bucket = plainObject(store.candidates[word]);
  bucket[meaning] = (Number(bucket[meaning]) || 0) + 1;
  store.candidates[word] = bucket;

  const entries = Object.entries(bucket).sort((a, b) => b[1] - a[1]);
  const [topMeaning, topCount] = entries[0];
  const total = entries.reduce((sum, [, count]) => sum + count, 0);

  // 【防歧义】只要出现过两种以上释义，说明这个词有多个含义
  // （bank 河岸/银行、address 处理/地址、subject 使遭受/主题…）。
  // 这种情况**永不自动收录** —— 宁可不省这次 token，也不能把一个会翻错的意思写进词表。
  if (entries.length > 1) {
    delete store.candidates[word];
    await writeStore(store);
    return { ok: true, learned: false, ambiguous: true, word, meanings: entries.slice(0, 3) };
  }

  if (topCount >= CANDIDATE_MIN_HITS) {
    store.learned[word] = topMeaning;
    delete store.candidates[word];
    // 超上限就丢掉最早学到的，避免 storage 无限膨胀
    const keys = Object.keys(store.learned);
    while (keys.length > LEARNED_MAX) {
      delete store.learned[keys.shift()];
    }
    await writeStore(store); // 学习不动 version
    return { ok: true, learned: true, word, meaning: topMeaning, count: topCount };
  }

  if (total > CANDIDATE_MAX_ATTEMPTS) {
    delete store.candidates[word]; // 试太多次还定不下来，放弃
    await writeStore(store);
    return { ok: true, learned: false, dropped: true, word };
  }

  await writeStore(store);
  return { ok: true, learned: false, word, meaning: topMeaning, count: topCount, need: CANDIDATE_MIN_HITS };
}

/** 已学词表（喂给离线词表的那份） */
export async function listLearned() {
  const store = await readStore();
  return Object.entries(store.learned)
    .map(([en, zh]) => ({ en, zh }))
    .sort((a, b) => a.en.localeCompare(b.en));
}

/** 删掉一个学错的词 */
export async function removeLearned(en) {
  const word = String(en || '').trim().toLowerCase();
  if (!word) return { ok: false, error: 'EMPTY' };
  const store = await readStore();
  delete store.learned[word];
  await writeStore(store);
  return { ok: true, word };
}

/** 清空已学词表 */
export async function clearLearned() {
  const store = await readStore();
  store.learned = {};
  store.candidates = {};
  await writeStore(store);
  return { ok: true };
}

/** 候选池（给设置页显示「AI 正在攒这些词」的进度） */
export async function listCandidates() {
  const store = await readStore();
  return Object.entries(store.candidates)
    .map(([en, bucket]) => {
      const entries = Object.entries(plainObject(bucket)).sort((a, b) => b[1] - a[1]);
      return {
        en,
        meaning: entries[0]?.[0] || '',
        count: entries[0]?.[1] || 0,
        need: CANDIDATE_MIN_HITS
      };
    })
    .sort((a, b) => b.count - a.count || a.en.localeCompare(b.en));
}

/** 手动把候选词直接收进词表（提前确认） */
export async function promoteCandidate(en) {
  const word = String(en || '').trim().toLowerCase();
  if (!word) return { ok: false, error: 'EMPTY' };
  const store = await readStore();
  const bucket = plainObject(store.candidates[word]);
  const entries = Object.entries(bucket).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { ok: false, error: 'NO_CANDIDATE' };
  store.learned[word] = entries[0][0];
  delete store.candidates[word];
  await writeStore(store);
  return { ok: true, word, meaning: entries[0][0] };
}
