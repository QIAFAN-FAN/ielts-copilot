// 离线词典与直译引擎：单词、短语、句子、短文都能出结果，不联网、不花 token。
//
// 英文→中文：词典精确查词（含短语匹配、词形还原）+ 功能词表 + 逐词直译 + "A of B" 倒装
// 中文→英文：反向索引 + 最长匹配分词
//
// 直译结果是"能看懂大意"的水平，不追求地道；需要精准译文时由上层回落到 AI。

import { DICT_RAW, ZH_EXTRA } from './dict-data.js';

const EN2ZH = new Map(); // 英文（小写）→ 中文释义
const ZH2EN = new Map(); // 中文义项 → 英文（从英文释义反推，较弱）
const ZH2EN_STRONG = new Map(); // 中文词条显式指定的英文（较强），查询时优先
const EN_PHRASES = []; // 多词短语，用于最长匹配
let maxEnPhraseWords = 1;
let maxZhPhraseChars = 1;

/**
 * AI 学到的词（「翻得越多越省」靠它）：翻译时 AI 会返回生词的词级释义，
 * 同一个词被释义 3 次一致就收进这里。放进这个 Map 后，它对离线词表就是「认识」的词，
 * 以后含它的句子覆盖率上去了、直接走离线，不再消耗 token。
 * 一个 Map 存两份：userDict 用于精确查词，userPhrases 用于短语最长匹配。
 */
const userDict = new Map();
let userDictVersion = -1;

/** 注入 AI 学到的词。版本号没变就直接跳过，避免每次翻译都重建索引。 */
export function setLearnedWords(learned, version = 0) {
  const stamp = Number(version) || 0;
  const count = learned ? Object.keys(learned).length : 0;
  const key = stamp * 1_000_000 + count; // 版本 + 条数一起当指纹（学习不动 version）
  if (key === userDictVersion) return;
  userDictVersion = key;

  userDict.clear();
  for (const [en, zh] of Object.entries(learned || {})) {
    const word = String(en || '').trim().toLowerCase();
    const meaning = String(zh || '').trim();
    if (word && meaning) userDict.set(word, meaning);
  }

  // 学到的词组也要能被 matchPhrase 匹配到，补齐进短语表
  for (const word of userDict.keys()) {
    if (!word.includes(' ')) continue;
    if (!EN_PHRASES.includes(word)) {
      EN_PHRASES.push(word);
      maxEnPhraseWords = Math.max(maxEnPhraseWords, word.split(/\s+/).length);
    }
  }
  EN_PHRASES.sort((a, b) => b.length - a.length);
}

/** 已学词条数（给测试和诊断用） */
export function learnedWordCount() {
  return userDict.size;
}

/**
 * 统一查词：**内置词表优先，AI 学到的只在其后兜底**。
 * 这样即使 learned 里混进了某个词，它也永远不会覆盖内置词表的释义。
 */
function dictLookup(word) {
  return EN2ZH.get(word) || userDict.get(word) || null;
}

/** 高频虚词：词典里不必收录，但句子直译离不开它们 */
const FUNCTION_WORDS = {
  a: '',
  an: '',
  the: '',
  is: '是',
  are: '是',
  am: '是',
  was: '是',
  were: '是',
  be: '是',
  been: '是',
  being: '是',
  do: '',
  does: '',
  did: '',
  have: '有',
  has: '有',
  had: '有',
  and: '和',
  or: '或',
  but: '但是',
  so: '所以',
  because: '因为',
  since: '因为',
  if: '如果',
  that: '那',
  which: '这',
  who: '谁',
  whom: '谁',
  whose: '谁的',
  when: '当…时',
  while: '而',
  where: '哪里',
  why: '为什么',
  how: '如何',
  this: '这',
  these: '这些',
  those: '那些',
  it: '它',
  its: '它的',
  they: '它们',
  them: '它们',
  their: '它们的',
  we: '我们',
  us: '我们',
  our: '我们的',
  you: '你',
  your: '你的',
  he: '他',
  him: '他',
  his: '他的',
  she: '她',
  her: '她的',
  i: '我',
  me: '我',
  my: '我的',
  in: '在',
  on: '在',
  at: '在',
  to: '到',
  for: '为了',
  with: '和',
  from: '从',
  by: '通过',
  as: '作为',
  into: '进入',
  about: '关于',
  after: '之后',
  before: '之前',
  during: '在…期间',
  between: '在…之间',
  among: '在…之中',
  through: '通过',
  over: '超过',
  under: '在…之下',
  above: '在…之上',
  below: '在…之下',
  up: '向上',
  down: '向下',
  out: '出',
  off: '离开',
  not: '不',
  no: '没有',
  will: '将',
  would: '会',
  can: '能够',
  could: '能够',
  should: '应该',
  may: '可能',
  might: '可能',
  must: '必须',
  shall: '将',
  more: '更多',
  most: '最',
  much: '许多',
  many: '许多',
  very: '非常',
  also: '也',
  too: '也',
  than: '比',
  then: '然后',
  there: '那里',
  here: '这里',
  all: '全部',
  both: '两者都',
  each: '每个',
  every: '每个',
  some: '一些',
  any: '任何',
  few: '很少',
  little: '少量',
  other: '其他',
  another: '另一个',
  such: '这样的',
  same: '相同的',
  only: '只有',
  just: '只是',
  still: '仍然',
  even: '甚至',
  however: '然而',
  therefore: '因此',
  thus: '因此',
  of: '的',
  per: '每',
  etc: '等等'
};

/**
 * 虚词集合：判断「这句话我认不认识」时不该把虚词计入分母。
 * 用 Set 而不是直接查 FUNCTION_WORDS，避免命中 Object.prototype 上的属性名（如 constructor）。
 */
const FUNCTION_SET = new Set(Object.keys(FUNCTION_WORDS));

const PUNCT_ONLY = /^[^\w\s']+$/;

function buildIndex() {
  // DICT_RAW 是「英文|中文」：建英中词典，并从中文释义反向建中英索引
  for (const line of DICT_RAW.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf('|');
    if (sep <= 0) continue;
    const en = trimmed.slice(0, sep).trim().toLowerCase();
    const zh = trimmed.slice(sep + 1).trim();
    if (!en || !zh) continue;

    if (!EN2ZH.has(en)) EN2ZH.set(en, zh);
    if (en.includes(' ')) {
      EN_PHRASES.push(en);
      maxEnPhraseWords = Math.max(maxEnPhraseWords, en.split(/\s+/).length);
    }
    for (const item of zh.split(/[；;，,、/]/)) {
      const key = item.trim();
      if (!key || key.length > 8) continue;
      if (!ZH2EN.has(key)) ZH2EN.set(key, en);
      maxZhPhraseChars = Math.max(maxZhPhraseChars, key.length);
    }
  }

  // ZH_EXTRA 是「中文|英文」：建中英索引；英文侧也补进英中词典，
  // 但绝不覆盖已有词条，也跳过功能词（否则「正在|is」会把英文 is 覆盖成「正在」）
  for (const line of ZH_EXTRA.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf('|');
    if (sep <= 0) continue;
    const zh = trimmed.slice(0, sep).trim();
    const en = trimmed.slice(sep + 1).trim();
    if (!zh || !en) continue;

    if (!ZH2EN_STRONG.has(zh)) ZH2EN_STRONG.set(zh, en);
    maxZhPhraseChars = Math.max(maxZhPhraseChars, zh.length);

    const enKey = en.toLowerCase();
    if (!EN2ZH.has(enKey) && FUNCTION_WORDS[enKey] === undefined) {
      EN2ZH.set(enKey, zh);
      if (enKey.includes(' ')) {
        EN_PHRASES.push(enKey);
        maxEnPhraseWords = Math.max(maxEnPhraseWords, enKey.split(/\s+/).length);
      }
    }
  }

  EN_PHRASES.sort((a, b) => b.length - a.length);
  maxZhPhraseChars = Math.min(maxZhPhraseChars, 6);
}

buildIndex();

/** 中→英查询：显式中文词条优先于从英文释义反推的结果 */
function lookupZh(word) {
  return ZH2EN_STRONG.get(word) || ZH2EN.get(word) || null;
}

/* ---------------- 词形还原 ---------------- */

function stemCandidates(word) {
  const out = [];
  const push = (value) => {
    if (value && value.length > 1 && !out.includes(value)) out.push(value);
  };

  if (word.endsWith('ies')) push(word.slice(0, -3) + 'y');
  if (word.endsWith('ied')) push(word.slice(0, -3) + 'y');
  if (word.endsWith('es')) push(word.slice(0, -2));
  if (word.endsWith('s') && !word.endsWith('ss')) push(word.slice(0, -1));
  if (word.endsWith('ing')) {
    push(word.slice(0, -3));
    push(word.slice(0, -3) + 'e');
  }
  if (word.endsWith('ed')) {
    push(word.slice(0, -2));
    push(word.slice(0, -1));
  }
  const doubled = word.match(/^(.+?)([bcdfghjklmnpqrstvwxz])\2(ing|ed)$/);
  if (doubled) push(doubled[1] + doubled[2]);
  if (word.endsWith('est')) {
    push(word.slice(0, -3));
    push(word.slice(0, -2));
  }
  if (word.endsWith('er')) {
    push(word.slice(0, -2));
    push(word.slice(0, -1));
  }
  if (word.endsWith('ily')) push(word.slice(0, -3) + 'y');
  if (word.endsWith('ally')) {
    push(word.slice(0, -4) + 'al');
    push(word.slice(0, -2));
  }
  if (word.endsWith('ly')) push(word.slice(0, -2));
  return out;
}

function normalizeWord(raw) {
  return raw.toLowerCase().replace(/^[^a-z]+|[^a-z']+$/g, '');
}

/** 精确查一个英文词或短语 */
export function lookupEnglish(raw) {
  const word = normalizeWord(raw);
  if (!word) return null;
  const direct = dictLookup(word);
  if (direct) return { word, base: word, meaning: direct };
  for (const candidate of stemCandidates(word)) {
    const hit = dictLookup(candidate);
    if (hit) return { word, base: candidate, meaning: hit };
  }
  if (FUNCTION_WORDS[word] !== undefined && FUNCTION_WORDS[word] !== '') {
    return { word, base: word, meaning: FUNCTION_WORDS[word] };
  }
  return null;
}

/** 精确查一个中文词或短语 */
export function lookupChinese(raw) {
  const word = String(raw || '').trim();
  if (!word) return null;
  const hit = lookupZh(word);
  return hit ? { word, meaning: hit } : null;
}

function lookupToken(token) {
  const word = normalizeWord(token);
  if (!word) return null;
  const dict = dictLookup(word);
  if (dict) return { text: dict.split(/[；;]/)[0], known: true, base: word, en: word };
  for (const candidate of stemCandidates(word)) {
    const hit = dictLookup(candidate);
    if (hit) return { text: hit.split(/[；;]/)[0], known: true, base: candidate, en: word };
  }
  if (FUNCTION_WORDS[word] !== undefined) {
    return { text: FUNCTION_WORDS[word], known: true, base: word, en: word, func: true };
  }
  return null;
}

/* ---------------- 英文 → 中文 ---------------- */

function tokenizeEnglish(line) {
  return line.match(/[A-Za-z][A-Za-z']*|\d+(?:[.,]\d+)*|[^\sA-Za-z\d]+/g) || [];
}

function matchPhrase(tokens, start) {
  const limit = Math.min(maxEnPhraseWords, tokens.length - start);
  for (let count = limit; count >= 2; count -= 1) {
    const slice = tokens.slice(start, start + count);
    if (!slice.every((token) => /^[A-Za-z]/.test(token))) continue;
    const phrase = slice.join(' ').toLowerCase();
    const hit = dictLookup(phrase);
    if (hit) return { zh: hit, count, en: phrase };
  }
  return null;
}

/** 把 "A of B" 调成 "B的A"，中文读起来更顺 */
function applyOfOrder(units) {
  const out = [];
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (unit.en === 'of') {
      let j = i + 1;
      while (j < units.length && units[j].en && FUNCTION_WORDS[units[j].en] === '') j += 1; // 跳过冠词
      const head = units[j];
      const prev = out.pop();
      if (head && prev && !head.punct && !prev.punct && head.text && prev.text) {
        out.push({ text: `${head.text}的${prev.text}`, known: head.known && prev.known });
        i = j;
        continue;
      }
      if (prev) out.push(prev);
      out.push({ text: '的', known: true });
      continue;
    }
    out.push(unit);
  }
  return out;
}

function joinZh(units) {
  let out = '';
  for (const unit of units) {
    if (!unit.text) continue;
    if (unit.punct) {
      out = out.replace(/\s+$/, '') + unit.text;
      continue;
    }
    const needSpace = /[A-Za-z0-9]\s*$/.test(out) && /^\s*[A-Za-z0-9]/.test(unit.text);
    out += (needSpace ? ' ' : '') + unit.text;
  }
  return out.replace(/\s+([,.;:!?，。；：！？])/g, '$1').trim();
}

function translateLineEnToZh(line) {
  const tokens = tokenizeEnglish(line);
  const units = [];
  const vocab = [];
  let known = 0;
  let total = 0;
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    if (/^[A-Za-z]/.test(token)) {
      const phrase = matchPhrase(tokens, i);
      if (phrase) {
        units.push({ text: phrase.zh, known: true, en: phrase.en });
        known += 1;
        total += 1;
        i += phrase.count;
        continue;
      }
      // 虚词（the / is / of / to …）既不算「生词」也不算「已掌握」：覆盖率只按实词算。
      // 否则一句满是生词的长句，只要塞了足够多 the/is/of，覆盖率就被虚词撑上去，
      // 判定成「离线够用」而不调 AI，给你一个很生硬的逐词直译。
      const isFunction = FUNCTION_SET.has(token.toLowerCase());
      if (!isFunction) total += 1;
      const hit = lookupToken(token);
      if (hit) {
        if (!isFunction) known += 1;
        units.push({ text: hit.text, known: true, en: hit.en, base: hit.base });
      } else {
        units.push({ text: token, known: false, en: token.toLowerCase() });
        vocab.push({ en: token, zh: '词表未收录' });
      }
      i += 1;
      continue;
    }
    if (PUNCT_ONLY.test(token)) {
      units.push({ text: token, known: true, punct: true });
      i += 1;
      continue;
    }
    units.push({ text: token, known: true });
    i += 1;
  }

  return {
    text: joinZh(applyOfOrder(units)),
    vocab,
    coverage: total ? known / total : 0,
    wordCount: total
  };
}

/* ---------------- 中文 → 英文 ---------------- */

/** 中文虚词：直译成英文反而添乱，分词时直接丢掉 */
const SKIP_ZH = new Set(['的', '地', '得', '了', '着', '吗', '呢', '吧', '啊']);

function segmentChinese(text) {
  const chars = Array.from(text);
  const out = [];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (!/[\u4e00-\u9fff]/.test(ch)) {
      out.push({ zh: ch, en: /[0-9A-Za-z]/.test(ch) ? ch : null, punct: true });
      i += 1;
      continue;
    }
    let matched = null;
    for (let len = Math.min(maxZhPhraseChars, chars.length - i); len >= 1; len -= 1) {
      const candidate = chars.slice(i, i + len).join('');
      if (ZH2EN_STRONG.has(candidate) || ZH2EN.has(candidate)) {
        matched = candidate;
        break;
      }
    }
    if (matched) {
      if (!SKIP_ZH.has(matched)) out.push({ zh: matched, en: lookupZh(matched) });
      i += matched.length;
    } else {
      if (!SKIP_ZH.has(ch)) out.push({ zh: ch, en: null });
      i += 1;
    }
  }
  return out;
}

function translateLineZhToEn(line) {
  const parts = [];
  const vocab = [];
  let known = 0;
  let total = 0;

  for (const segment of segmentChinese(line)) {
    if (segment.punct) {
      parts.push({ text: segment.zh, punct: true });
      continue;
    }
    total += 1;
    if (segment.en) {
      known += 1;
      parts.push({ text: segment.en });
    } else {
      parts.push({ text: segment.zh });
      vocab.push({ en: segment.zh, zh: '未收录中文词' });
    }
  }

  let out = '';
  for (const part of parts) {
    if (part.punct) {
      out = out.replace(/\s+$/, '') + part.text;
      continue;
    }
    out += (out && !/\s$/.test(out) ? ' ' : '') + part.text;
  }
  out = out.replace(/\s+([,.;:!?])/g, '$1').trim();
  if (total && out) out = out[0].toUpperCase() + out.slice(1);

  return { text: out, vocab, coverage: total ? known / total : 0, wordCount: total };
}

/* ---------------- 对外接口 ---------------- */

/**
 * 离线命中时给一句灰色提示（对应气泡里 `.key` 那一行）。
 *
 * AI 翻译会返回「关键结构 / 同义替换」的说明，而词表命中只有一串中文释义，
 * 在气泡里看起来就是"孤零零一个中文"。这里补一句：告诉用户这是词表通用释义、
 * 共几个义项、想要语境解释该点哪里。
 */
function sentenceHint(meaning) {
  const senses = String(meaning || '')
    .split(/[；;]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return senses.length > 1
    ? `词表释义，共 ${senses.length} 个义项；要看这句里具体取哪个，点「AI 精译」。`
    : '词表释义；要看语境解释，点「AI 精译」。';
}

/**
 * 离线翻译入口，支持单词 / 短语 / 句子 / 多段短文。
 * @returns {{ok:boolean, exact:boolean, direction:string, translation:string,
 *            vocab:Array, coverage:number, wordCount:number, quality:string}}
 */
export function translateLocal(rawText) {
  const text = String(rawText || '').replace(/\s+$/g, '');
  const empty = {
    ok: false,
    exact: false,
    direction: 'en->zh',
    translation: '',
    vocab: [],
    coverage: 0,
    wordCount: 0,
    quality: 'none'
  };
  if (!text.trim()) return empty;

  const hasHan = /[\u4e00-\u9fff]/.test(text);
  const hasLatin = /[A-Za-z]/.test(text);

  // 纯单词/短语：直接给词典释义
  if (hasLatin && !hasHan) {
    const words = text.trim().split(/\s+/);
    if (words.length <= 3 && words.every((word) => /^[A-Za-z][A-Za-z'-]*$/.test(word))) {
      const phraseHit = dictLookup(text.trim().toLowerCase());
      if (phraseHit) {
        return {
          ...empty,
          ok: true,
          exact: true,
          translation: phraseHit,
          quality: 'exact',
          wordCount: words.length,
          key: sentenceHint(phraseHit)
        };
      }
      if (words.length === 1) {
        const hit = lookupEnglish(words[0]);
        if (hit) {
          return {
            ...empty,
            ok: true,
            exact: true,
            translation: hit.meaning,
            quality: 'exact',
            wordCount: 1,
            base: hit.base,
            key: sentenceHint(hit.meaning)
          };
        }
        return empty;
      }
    }
  }

  if (hasHan && !hasLatin) {
    const trimmed = text.trim();
    const exactHit = lookupZh(trimmed);
    if (exactHit && trimmed.length <= 4) {
      return { ...empty, ok: true, exact: true, direction: 'zh->en', translation: exactHit, quality: 'exact', wordCount: 1 };
    }
    const lines = text.split('\n');
    const results = lines.map((line) => (line.trim() ? translateLineZhToEn(line) : { text: '', vocab: [], coverage: 1, wordCount: 0 }));
    const vocab = results.flatMap((item) => item.vocab);
    const translation = results.map((item) => item.text).join('\n');
    const total = results.reduce((sum, item) => sum + item.wordCount, 0);
    const known = results.reduce((sum, item) => sum + item.coverage * item.wordCount, 0);
    return {
      ok: Boolean(translation.trim()),
      exact: false,
      direction: 'zh->en',
      translation,
      vocab,
      coverage: total ? known / total : 0,
      wordCount: total,
      quality: 'gloss'
    };
  }

  // 英中混合或纯英文句子/短文
  const lines = text.split('\n');
  const results = lines.map((line) => (line.trim() ? translateLineEnToZh(line) : { text: '', vocab: [], coverage: 1, wordCount: 0 }));
  const vocab = results.flatMap((item) => item.vocab);
  const translation = results.map((item) => item.text).join('\n');
  const total = results.reduce((sum, item) => sum + item.wordCount, 0);
  const known = results.reduce((sum, item) => sum + item.coverage * item.wordCount, 0);
  const coverage = total ? known / total : 0;

  return {
    ok: Boolean(translation.trim()),
    exact: false,
    direction: 'en->zh',
    translation,
    vocab,
    coverage,
    wordCount: total,
    quality: coverage >= 0.75 ? 'gloss-ok' : 'gloss'
  };
}

export function dictSize() {
  return EN2ZH.size;
}
