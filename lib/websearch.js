// 内置联网检索：先把题目相关的公开网页摘要抓回来，再交给模型判断与引用。
//
// 说明：DeepSeek 官方 API 本身**不具备联网搜索能力**（只有文本推理），
// 所以「先搜索」这一步由扩展自己在浏览器里完成，再把检索结果作为材料喂给模型。
// 只有确实搜到东西时才附给模型；搜不到就退化成「凭模型知识推断」。

const ENGINES = [
  { name: 'bing-cn', build: (q) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}`, parse: parseBing },
  { name: 'bing', build: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`, parse: parseBing },
  {
    name: 'duckduckgo',
    build: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    parse: parseDuckDuckGo
  }
];

function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBing(html) {
  const results = [];
  const blocks = String(html).split(/<li class="b_algo"/i).slice(1);
  for (const block of blocks) {
    const title = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!title) continue;
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const item = {
      url: title[1],
      title: stripTags(title[2]),
      snippet: snippet ? stripTags(snippet[1]) : ''
    };
    if (item.title && /^https?:/i.test(item.url)) results.push(item);
    if (results.length >= 8) break;
  }
  return results;
}

function parseDuckDuckGo(html) {
  const results = [];
  const blocks = String(html).split(/class="result results_links/i).slice(1);
  for (const block of blocks) {
    const title = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!title) continue;
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const item = {
      url: title[1],
      title: stripTags(title[2]),
      snippet: snippet ? stripTags(snippet[1]) : ''
    };
    if (item.title) results.push(item);
    if (results.length >= 8) break;
  }
  return results;
}

async function fetchHtml(url, signal) {
  const response = await fetch(url, {
    signal,
    credentials: 'omit',
    headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8' }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

/**
 * 在公开搜索引擎里查一条，返回 { engine, results }。
 * 依次尝试多个引擎，谁先返回结果就用谁；全部失败返回空结果。
 */
/**
 * 把「外部 signal（用户点停止）」和「内部超时」合并成一个 signal。
 * 这样点「停止生成」时，浏览器检索也会立刻中止，不会白等超时。
 */
function withTimeoutSignal(externalSignal, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  if (!externalSignal) return { signal: controller.signal, clear: () => clearTimeout(timer) };

  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return {
      signal: AbortSignal.any([externalSignal, controller.signal]),
      clear: () => clearTimeout(timer)
    };
  }
  // 老版本兜底：外部一 abort 就跟着 abort
  if (externalSignal.aborted) controller.abort();
  else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export async function searchWeb(query, { limit = 5, timeout = 9000, signal: externalSignal } = {}) {
  const text = String(query || '').trim();
  if (!text) return { engine: null, results: [] };

  for (const engine of ENGINES) {
    if (externalSignal?.aborted) break; // 用户已经点了停止，不用再试下一个引擎
    const { signal, clear } = withTimeoutSignal(externalSignal, timeout);
    try {
      const html = await fetchHtml(engine.build(text), signal);
      if (!html || html.length < 400) continue;
      const results = engine.parse(html).slice(0, limit);
      if (results.length) return { engine: engine.name, results };
    } catch {
      /* 换下一个引擎继续试 */
    } finally {
      clear();
    }
  }
  return { engine: null, results: [] };
}

/** 从材料里找一句最像原文/题干的长句，用来精确检索 */
function pickQuotableSentence(text) {
  const candidates = String(text || '')
    .split(/[\n。！？!?;；]+|(?<=[a-z\)])\.(?=\s|$)/)
    .map((line) =>
      line
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.,;:]+$/, '')
    )
    .filter(
      (line) =>
        /^[A-Za-z][A-Za-z\s,'"()-]*$/.test(line) &&
        line.split(' ').length >= 8 &&
        line.length >= 45 &&
        line.length < 200
    );
  if (!candidates.length) return '';
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0].split(' ').slice(0, 13).join(' ');
}

/**
 * 生成 1-2 条检索式：
 * 1）能认出「Cambridge IELTS N / Test N / Passage N / Section N」就拼成精确检索式
 * 2）否则用材料里最长的英文句子做引号精确检索
 */
export function buildQueries(sourceText) {
  const source = String(sourceText || '');
  const queries = [];
  const brand = /cambridge\s*ielts/i.test(source) ? 'Cambridge IELTS' : 'IELTS';
  const number = source.match(/cambridge\s*ielts\s*(\d{1,2})/i);
  const test = source.match(/\btest\s*(\d{1,2})\b/i);
  const passage = source.match(/\bpassage\s*(\d)\b/i);
  const section = source.match(/\bsection\s*(\d)\b/i);

  const parts = [brand];
  if (number) parts.push(number[1]);
  if (test) parts.push(`Test ${test[1]}`);
  if (passage) parts.push(`Passage ${passage[1]}`);
  else if (section) parts.push(`Section ${section[1]}`);
  if (number || test || passage || section) parts.push('answers');
  if (parts.length > 1) queries.push(parts.join(' '));

  const sentence = pickQuotableSentence(source);
  if (sentence) {
    queries.push(`"${sentence}" IELTS`);
    if (!number) queries.push(`${sentence} Cambridge IELTS answers`);
  }

  const unique = [];
  for (const query of queries) {
    if (query && !unique.includes(query)) unique.push(query);
  }
  return unique.slice(0, 2);
}

/** 把检索结果整理成给模型看的材料块 */
export function formatResultsForPrompt(results, engine) {
  if (!Array.isArray(results) || !results.length) return '';
  const lines = results.map((item, index) => {
    const snippet = item.snippet ? `\n   ${item.snippet}` : '';
    return `${index + 1}. ${item.title}${snippet}\n   来源：${item.url}`;
  });
  return `\n\n【联网检索到的公开资料】（搜索引擎：${engine || '未知'}；这些内容未必相关，请只用来佐证题目出处，不要照抄）\n${lines.join('\n')}`;
}
