// 侧边栏主逻辑：做题时的分析工作台
import { getSettings, saveSettings, onSettingsChanged, takePendingTask, onPendingTask, isRetiredModel, suggestModel } from '../lib/store.js';
import { chatCompletion, parseLooseJson } from '../lib/deepseek.js';
import { buildMessages, extractSearchQuery, stripSearchQuery } from '../lib/prompts.js';
import { renderMarkdown } from '../lib/markdown.js';
import { searchWeb, buildQueries, formatResultsForPrompt } from '../lib/websearch.js';
import { deepseekWebSearch } from '../lib/dssearch.js';

const MODES = {
  reading: {
    inputTitle: '题目（Questions）',
    passageTitle: '阅读原文（Passage，可留空）',
    resultTitle: '阅读答案与解析',
    tip: '原文和题目分两个框：「抓取本页」会按版面自动分配；也可以分别在网页上划选后，点各自的「用选中文字」。',
    button: '分析阅读题',
    dual: true
  },
  listening: {
    inputTitle: '听力题目 / 听写文本',
    resultTitle: '听力答案与分析',
    tip: '划选题目（或把听到的内容打下来）→「用选中文字」。它会先判断题目出处、给出参考答案，再讲每题怎么听出来。',
    button: '分析听力题'
  },
  writing: {
    inputTitle: '作文题目与要求',
    resultTitle: '写作思路与范文',
    tip: '贴上作文题目和要求，它会给出审题拆解、立场、段落框架、高分句式和一篇范文。小作文有图表的话，可以在下面加图片。',
    button: '生成写作方案',
    image: true
  },
  review: {
    inputTitle: '题目 + 你的作文',
    resultTitle: '批改结果',
    tip: '把题目和你写的作文一起贴进来，按雅思四项评分标准批改，并给出改写。小作文有图表的话，可以在下面加图片。',
    button: '批改我的作文',
    image: true
  },
  chat: {
    inputTitle: '要精讲的句子 / 你的提问',
    resultTitle: '精讲与回答',
    tip: '划词气泡里点「深入精讲」会送到这里；也可以在这里直接提问，多轮对话会保留上下文。',
    button: '精讲 / 提问'
  }
};

const IELTS_HINTS = [
  /reading passage/i,
  /questions?\s+\d+/i,
  /not given/i,
  /\btrue\b[\s\S]{0,30}\bfalse\b/i,
  /choose the correct letter/i,
  /write your answers/i,
  /\blistening\b/i,
  /\bielts\b/i,
  /task\s*[12]\b/i,
  /section\s+[1-4]\b/i,
  /label the diagram/i,
  /complete the (table|notes|summary|sentences)/i,
  /writing task/i
];

const els = {
  tabs: document.getElementById('tabs'),
  noKey: document.getElementById('noKey'),
  modelWarn: document.getElementById('modelWarn'),
  modelWarnText: document.getElementById('modelWarnText'),
  modelWarnFix: document.getElementById('modelWarnFix'),
  goOptions: document.getElementById('goOptions'),
  btnGear: document.getElementById('btnGear'),
  composer: document.getElementById('composer'),
  input: document.getElementById('input'),
  inputTitle: document.getElementById('inputTitle'),
  inputMeta: document.getElementById('inputMeta'),
  passageBlock: document.getElementById('passageBlock'),
  passage: document.getElementById('passage'),
  passageTitle: document.getElementById('passageTitle'),
  examSourceRow: document.getElementById('examSourceRow'),
  examSource: document.getElementById('examSource'),
  imageRow: document.getElementById('imageRow'),
  imageList: document.getElementById('imageList'),
  imageFile: document.getElementById('imageFile'),
  pickImage: document.getElementById('pickImage'),
  captureTab: document.getElementById('captureTab'),
  grabImages: document.getElementById('grabImages'),
  clearImages: document.getElementById('clearImages'),
  briefMode: document.getElementById('briefMode'),
  toggleExpand: document.getElementById('toggleExpand'),
  taskRow: document.getElementById('taskRow'),
  taskSeg: document.getElementById('taskSeg'),
  run: document.getElementById('run'),
  stop: document.getElementById('stop'),
  modeTip: document.getElementById('modeTip'),
  grabPage: document.getElementById('grabPage'),
  useSelection: document.getElementById('useSelection'),
  clearPassage: document.getElementById('clearPassage'),
  grabPageSecondary: document.getElementById('grabPageSecondary'),
  useSelectionSecondary: document.getElementById('useSelectionSecondary'),
  clearInput: document.getElementById('clearInput'),
  result: document.getElementById('result'),
  resultTitle: document.getElementById('resultTitle'),
  status: document.getElementById('status'),
  copyResult: document.getElementById('copyResult'),
  searchAnswer: document.getElementById('searchAnswer'),
  clearResult: document.getElementById('clearResult')
};

const state = {
  mode: 'reading',
  task: 'task2',
  settings: null,
  chatHistory: [],
  answer: '',
  drafts: {}, // 每个板块各自的输入内容 { [mode]: { passage, text, examSource } }
  results: {}, // 每个板块各自的分析结果 { [mode]: markdown }
  imagesByMode: {}, // 每个板块各自的图片 { [mode]: [{ dataUrl | src, alt }] }（写作 / 批改用）
  running: false,
  controller: null,
  webController: null,
  pageTitle: '',
  pageUrl: ''
};

/* ---------------- 基础 UI ---------------- */

/** 把当前输入框的内容和结果存回「当前板块」 */
function captureCurrent() {
  state.drafts[state.mode] = {
    passage: els.passage.value,
    text: els.input.value,
    examSource: els.examSource.value
  };
  state.results[state.mode] = state.answer;
}

/** 把「目标板块」自己的内容和结果恢复到界面上（板块之间互不干扰） */
function restoreFor(mode) {
  // 切板块时先取消还在排队的流式渲染：它是模块级单例，120ms 后会把**旧板块**的
  // markdown 画到新板块的结果区上，而之后的 onDelta 因 isCurrent() 为 false 不再更新，
  // 界面就会停在那段错内容上（直到你再切一次板块）。
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  latestMarkdown = '';

  const draft = state.drafts[mode] || { passage: '', text: '', examSource: '' };
  els.passage.value = draft.passage || '';
  els.input.value = draft.text || '';
  els.examSource.value = draft.examSource || '';

  state.answer = state.results[mode] || '';
  if (state.answer) {
    renderResult(state.answer);
  } else {
    els.result.classList.add('empty');
    els.result.textContent = '分析结果会显示在这里。';
  }
  updateMeta();
}

function setMode(mode) {
  if (!MODES[mode]) return;
  if (mode !== state.mode) captureCurrent(); // 切板块前先存档当前内容与结果
  state.mode = mode;
  for (const button of els.tabs.querySelectorAll('.tab')) {
    button.classList.toggle('active', button.dataset.mode === mode);
  }
  const meta = MODES[mode];
  els.inputTitle.textContent = meta.inputTitle;
  els.resultTitle.textContent = meta.resultTitle;
  els.modeTip.textContent = meta.tip;
  els.run.textContent = meta.button;
  els.taskRow.classList.toggle('hidden', !(mode === 'writing' || mode === 'review'));
  els.passageBlock.classList.toggle('hidden', !meta.dual);
  els.composer.classList.toggle('dual', Boolean(meta.dual));
  if (meta.passageTitle) els.passageTitle.textContent = meta.passageTitle;
  refreshModeVisibility();
  restoreFor(mode); // 恢复该板块自己的内容与结果
  renderImages();
}

/** 刷新那些「由设置开关控制显隐」的区块（切板块、或设置页刚改过开关时调用） */
function refreshModeVisibility() {
  const showExamSource =
    state.settings?.manualExamSource === true &&
    (state.mode === 'reading' || state.mode === 'listening');
  els.examSourceRow.classList.toggle('hidden', !showExamSource);
  els.imageRow.classList.toggle('hidden', !MODES[state.mode]?.image);
}

/* ---------------- 图片（小作文的图表） ---------------- */

function currentImages() {
  if (!Array.isArray(state.imagesByMode[state.mode])) state.imagesByMode[state.mode] = [];
  return state.imagesByMode[state.mode];
}

function imageUrl(item) {
  return item?.dataUrl || item?.src || '';
}

function renderImages() {
  const list = currentImages();
  els.imageList.innerHTML = '';
  if (!list.length) {
    const tip = document.createElement('span');
    tip.className = 'empty-tip';
    tip.textContent =
      '还没有图片。可以「上传图片」「截取当前画面」「抓取本页图片」，也可以直接把图片拖到这里，或复制图片后按 Ctrl+V。';
    els.imageList.appendChild(tip);
    return;
  }
  list.forEach((item, index) => {
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const img = document.createElement('img');
    img.src = imageUrl(item);
    img.alt = item.alt || `图片 ${index + 1}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✕';
    del.title = '移除这张图';
    del.addEventListener('click', () => {
      list.splice(index, 1);
      renderImages();
      saveDraft(); // 删图也要落盘，否则关掉侧边栏后图片又"回来"了
    });
    thumb.append(img, del);
    els.imageList.appendChild(thumb);
  });
}

function addImages(items) {
  const list = currentImages();
  let added = 0;
  for (const item of items) {
    const url = imageUrl(item);
    if (!url) continue;
    if (list.some((kept) => imageUrl(kept) === url)) continue;
    list.push(item);
    added += 1;
    if (list.length >= 6) break;
  }
  renderImages();
  // 图片变了就要立刻存草稿：否则用户拖进图、还没打字就关掉侧边栏，图片就没了
  if (added) saveDraft();
  return added;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

/**
 * 处理拖进来 / 粘贴进来的图片。
 * 从本地拖文件时 dataTransfer 里有 File；从网页上拖图片时通常只有 URL（text/uri-list / text/html）。
 */
async function handleDroppedData(dataTransfer) {
  if (!dataTransfer) return;

  const items = [];

  // ① 本地文件，或从浏览器拖图时给出的文件数据
  for (const file of Array.from(dataTransfer.files || [])) {
    if (!/^image\//.test(file.type)) continue;
    if (file.size > 8 * 1024 * 1024) continue;
    const dataUrl = await readFileAsDataUrl(file);
    if (dataUrl) items.push({ dataUrl, alt: file.name || '拖入的图片' });
  }

  // ② 从网页拖图片：通常拿不到 File，只有 URL
  if (!items.length) {
    const uri = String(dataTransfer.getData('text/uri-list') || '')
      .split('\n')[0]
      .trim();
    if (/^https?:|^data:/.test(uri)) items.push({ src: uri, alt: '拖入的图片' });
  }
  if (!items.length) {
    const html = dataTransfer.getData('text/html') || '';
    const match = html.match(/<img[^>]+src=["']([^"']+)["']/i) || html.match(/src=["']([^"']+)["']/i);
    if (match && /^https?:|^data:/.test(match[1])) items.push({ src: match[1], alt: '拖入的图片' });
  }
  if (!items.length) {
    const text = String(dataTransfer.getData('text/plain') || '').trim();
    if (/^https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i.test(text)) {
      items.push({ src: text, alt: '拖入的图片' });
    }
  }

  if (!items.length) {
    setStatus('没读到图片内容。可以改用「上传图片」，或把图片拖到图片区、复制后按 Ctrl+V 粘贴。', 'warn');
    return;
  }
  const added = addImages(items);
  if (added) setStatus(`已加入 ${added} 张图片。`, 'ok');
}

function setStatus(text, kind = '') {
  els.status.textContent = text || '';
  els.status.className = `status ${kind}`.trim();
}

function setTip(text, kind = '') {
  els.modeTip.textContent = text;
  els.modeTip.className = `tips ${kind}`.trim();
}

function resetTip() {
  els.modeTip.textContent = MODES[state.mode].tip;
  els.modeTip.className = 'tips';
}

function updateKeyBanner() {
  els.noKey.classList.toggle('hidden', !!state.settings?.apiKey);
}

/**
 * 模型名已被官方停用时给一条常驻横幅。
 * 之前是写进 status 栏的，但切板块 / 恢复草稿都会覆盖 status，用户可能一直看不到。
 */
function updateModelWarn() {
  const model = state.settings?.model;
  const suggestion = suggestModel(model);
  if (!suggestion) {
    els.modelWarn.classList.add('hidden');
    return;
  }
  els.modelWarnText.textContent = `当前模型名「${model}」已被 DeepSeek 停用，建议改成 ${suggestion}。`;
  els.modelWarn.classList.remove('hidden');
}

function updateMeta() {
  const main = els.input.value.trim().length;
  const extra = els.passageBlock.classList.contains('hidden') ? 0 : els.passage.value.trim().length;
  const total = main + extra;
  if (!total) {
    els.inputMeta.textContent = '';
    return;
  }
  els.inputMeta.textContent = extra ? `${total} 字（题目 ${main} / 原文 ${extra}）` : `${total} 字`;
}

function setRunning(running) {
  state.running = running;
  els.run.disabled = running;
  els.stop.classList.toggle('hidden', !running);
  els.run.textContent = running ? '生成中…' : MODES[state.mode].button;
}

/* ---------------- 结果渲染 ---------------- */

let renderTimer = null;
let latestMarkdown = '';

function renderResult(markdown, { streaming = false } = {}) {
  const target = els.result;
  const wasNearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 90;
  target.classList.remove('empty');
  target.innerHTML = renderMarkdown(markdown || '');
  // 流式输出时，如果用户正在往上翻阅，就不要把视图拉回底部
  if (!streaming || wasNearBottom) {
    target.scrollTop = target.scrollHeight;
  }
}

function scheduleRender(markdown) {
  // 只记住最新值，让定时器渲染「最新一帧」；否则 120ms 窗口内后续的 delta 会被 return 丢掉，
  // 界面会停在这一窗口的第一帧，看起来一段段跳、甚至正文结束后还显示旧内容。
  latestMarkdown = markdown;
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderResult(latestMarkdown, { streaming: true });
  }, 120);
}

/* ---------------- 与后台通信 ---------------- */

function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: '没有收到响应' });
      });
    } catch (err) {
      resolve({ ok: false, error: String(err?.message || err) });
    }
  });
}

/* ---------------- 核心：生成 ---------------- */

async function streamAnswer(messages, mode = state.mode) {
  if (!state.settings?.apiKey) {
    updateKeyBanner();
    setStatus('还没有配置 DeepSeek API Key，请先点右上角 ⚙ 填写。', 'error');
    return null;
  }

  setRunning(true);
  setStatus('正在思考…');
  const controller = new AbortController();
  state.controller = controller;

  const settings = { ...state.settings };
  const useStream = settings.stream !== false;
  let full = '';
  let errorMessage = '';
  let aborted = false;
  // 用户在流式过程中可能切到别的板块，结果必须归到「发起时」的那个板块
  const isCurrent = () => state.mode === mode;

  try {
    if (useStream) {
      full = await chatCompletion({
        settings,
        messages,
        stream: true,
        signal: controller.signal,
        onDelta: (_piece, all) => {
          full = all;
          if (isCurrent()) scheduleRender(stripSearchQuery(all));
        }
      });
    } else {
      full = await chatCompletion({ settings, messages, stream: false, signal: controller.signal });
    }
  } catch (err) {
    if (err?.name === 'AbortError') aborted = true;
    else errorMessage = String(err?.message || err);
  } finally {
    state.controller = null;
    setRunning(false);
  }

  if (errorMessage) {
    if (isCurrent()) setStatus(errorMessage, 'error');
    return null;
  }

  // 点「停止」且还一个字都没生成出来时，**不要覆盖已有结果**：
  // 否则等于把上一轮的分析清空，紧跟的 saveDraft 还会把空结果落盘，关了侧边栏也回不来。
  // 注意只挡 `aborted && !full`；`aborted && full` 是"保留已生成的部分"，行为不变。
  if (aborted && !full) {
    if (isCurrent()) setStatus('已停止生成（原有结果已保留）。');
    return null;
  }

  state.results[mode] = full;
  if (isCurrent()) {
    state.answer = full;
    renderResult(stripSearchQuery(full));
  }
  // 结果一落定就写草稿：否则用户生成了分析、没碰过输入框就关掉侧边栏，结果会丢
  saveDraft();

  if (aborted) {
    if (isCurrent()) setStatus('已停止生成（保留已生成部分）。');
    return null;
  }

  const query = extractSearchQuery(full);
  if (isCurrent()) {
    setStatus(
      query ? `生成完成。点「搜答案核对」可按题目出处上网核对：${query}` : '生成完成。',
      'ok'
    );
  }
  return full;
}

async function run() {
  if (state.running) return;
  const text = els.input.value.trim();
  const passageValue = usesPassageField() ? els.passage.value.trim() : '';
  const examSourceValue = els.examSource.value.trim();
  // 只填了题目出处也要能分析（听力尤其常见：题目在网上，手头只有出处）
  if (!text && !passageValue && !examSourceValue) {
    setTip('请先划选题目、抓取本页、填写题目出处，或直接粘贴内容。', 'warn');
    els.input.focus();
    return;
  }
  if (!state.settings?.apiKey) {
    updateKeyBanner();
    setStatus('还没有配置 DeepSeek API Key，请先点右上角 ⚙ 填写。', 'error');
    return;
  }
  resetTip();

  const mode = state.mode;
  const examSource = examSourceValue;
  const brief = els.briefMode.checked === true;
  const images = (state.imagesByMode[mode] || []).map(imageUrl).filter(Boolean);
  const params = {
    text,
    passage: passageValue,
    examSource,
    brief,
    images,
    targetBand: state.settings.targetBand,
    explainLang: state.settings.explainLang,
    pageTitle: state.pageTitle,
    pageUrl: state.pageUrl
  };
  if (mode === 'writing' || mode === 'review') params.task = state.task;

  if (!text && !passageValue && examSource) {
    setStatus(`只提供了出处「${examSource}」，本次主要依赖联网检索来回答。`);
  }

  // 阅读/听力：先联网检索题目出处，把找到的公开资料一并交给模型判断
  let confidence = '';
  if (mode === 'reading' || mode === 'listening') {
    const reference = await collectWebReference(`${passageValue}\n${text}`);
    params.webBlock = reference.block;
    confidence = reference.confidence || '';
    if (reference.info) setStatus(reference.info);
  }

  const messages =
    mode === 'chat'
      ? buildMessages('chat', { ...params, history: state.chatHistory }).messages
      : buildMessages(mode, params).messages;

  const answer = await streamAnswer(messages, mode);
  if (answer == null) return;

  // 在结果最上方插入可信度标签，让「这答案有多可信」一眼可见
  if (confidence && state.mode === mode) {
    const summary = stripSearchQuery(answer);
    state.answer = `${confidence}\n\n${summary}`;
    state.results[mode] = state.answer;
    renderResult(state.answer);
  }

  if (mode === 'chat') {
    state.chatHistory.push({ role: 'user', content: text });
    state.chatHistory.push({ role: 'assistant', content: answer });
    if (state.chatHistory.length > 12) state.chatHistory = state.chatHistory.slice(-12);
    els.input.value = '';
    captureCurrent();
    updateMeta();
  }
}

async function runTranslate(text) {
  // 翻译不强制要求 API Key：没配 Key 也会走内置离线词表
  setRunning(true);
  setStatus('正在翻译…');
  try {
    const res = await sendMessage({ type: 'translate', text });
    if (!res.ok) {
      setStatus(res.error === 'NO_API_KEY' ? '请先配置 API Key，或在设置里把翻译方式改成「离线词表」。' : res.error || '翻译失败', 'error');
      return;
    }
    const { translation = '', key = '', vocab = [], engine = 'local', quality = 'exact' } = res.data || {};
    const engineLabel = engine === 'ai' ? 'AI 翻译' : engine === 'cache' ? 'AI 翻译（缓存命中）' : '离线词表';
    const parts = [`### 译文\n\n${translation}`];
    if (key) parts.push(`### 要点\n\n${key}`);
    if (Array.isArray(vocab) && vocab.length) {
      const rows = vocab.map((v) => `| ${v.en || ''} | ${v.zh || ''} |`).join('\n');
      parts.push(`### 生词\n\n| 词汇 | 释义 |\n| --- | --- |\n${rows}`);
    }
    parts.push(`> 引擎：${engineLabel}${quality === 'exact' ? '' : '（离线直译，仅供看大意）'}`);
    const markdown = parts.join('\n\n');
    state.answer = markdown;
    state.results[state.mode] = markdown;
    renderResult(markdown);
    saveDraft();
    setStatus(`翻译完成（${engineLabel}）。`, 'ok');
  } catch (err) {
    setStatus(String(err?.message || err), 'error');
  } finally {
    setRunning(false);
  }
}

/* ---------------- 抓取与填入 ---------------- */

function looksLikeIelts(text) {
  if (!text || text.length < 120) return false;
  let hits = 0;
  for (const pattern of IELTS_HINTS) {
    if (pattern.test(text)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

const ROLE_LABEL = { article: '原文', questions: '题目', unknown: '内容' };
const SIDE_LABEL = { left: '左侧', right: '右侧', full: '整宽' };

/** 拼接多个区块，顺便按「去掉空白后的全文」做双向去重，避免同一段内容出现两遍 */
/**
 * 把多个区块合成一段文本，并去掉重复/被包含的内容。
 *
 * 关键：**从最短的块开始判断**（保留"最小包含块"），最后再按原始顺序输出。
 * 以前的写法是「先到先得」——如果先收到一个把 Section 1+2 都包住的大容器，
 * 后面更细的题目块会被判成重复全丢掉；反过来，先收到小块、再收到大块时，
 * 大块会被"已被包含"丢掉。两种都会导致**只读到一部分题目**（用户报的"听力只读到后半段"）。
 * 输出必须恢复原始顺序，否则听力题目的题号会乱。
 */
function joinUniqueBlocks(list) {
  const items = [];
  (list || []).forEach((block, index) => {
    const text = String(block?.text || '').trim();
    const norm = text.replace(/\s+/g, '');
    if (!text || !norm) return;
    items.push({ text, norm, index });
  });

  const kept = [];
  for (const item of items.slice().sort((a, b) => a.norm.length - b.norm.length)) {
    if (kept.some((other) => other.norm.includes(item.norm))) continue;
    kept.push(item);
  }
  kept.sort((a, b) => a.index - b.index); // 恢复原始顺序（题号不能乱）
  return kept.map((item) => item.text).join('\n\n');
}

/** 把后台识别出的版面分块拼成带标签的文本，方便模型分清「原文」和「题目」 */
function formatBlocks(blocks) {
  // 和 joinUniqueBlocks 一样：**最短块优先**，避免先收到的大容器把后面更细的题目块吞掉；
  // 但这里要保留块对象（role / side 前缀），所以单独写一份筛选。
  const items = [];
  (blocks || []).forEach((block, index) => {
    const norm = String(block?.text || '').replace(/\s+/g, '');
    if (!norm) return;
    items.push({ block, norm, index });
  });
  const kept = [];
  for (const item of items.slice().sort((a, b) => a.norm.length - b.norm.length)) {
    if (kept.some((other) => other.norm.includes(item.norm))) continue;
    kept.push(item);
  }
  kept.sort((a, b) => a.index - b.index); // 恢复原始顺序

  const counter = {};
  return kept
    .map((item) => {
      const block = item.block;
      const role = ROLE_LABEL[block.role] || '内容';
      counter[role] = (counter[role] || 0) + 1;
      const side = SIDE_LABEL[block.side] || '';
      return `【${role}${counter[role]}｜页面${side}】\n${block.text}`;
    })
    .join('\n\n');
}

/**
 * 按角色把识别出的区块分到「阅读原文」和「题目」两个框。
 * 关键：**绝不用整页兜底** —— 认不出来就留空并标记 needsAi，交给 AI 或用户，
 * 这样题目框永远不会混进原文。
 */
function splitBlocks(blocks) {
  const articles = blocks.filter((block) => block.role === 'article');
  const questions = blocks.filter((block) => block.role === 'questions');
  const unknown = blocks.filter((block) => block.role === 'unknown');

  let passageBlocks = [];
  let questionBlocks = [];
  let needsAi = false;

  if (articles.length && questions.length) {
    passageBlocks = articles;
    questionBlocks = questions;
  } else if (articles.length) {
    passageBlocks = articles;
    needsAi = unknown.length > 0;
  } else if (questions.length) {
    questionBlocks = questions;
    needsAi = unknown.length > 0;
  } else {
    needsAi = blocks.length > 0;
  }

  return {
    passage: formatBlocks(passageBlocks),
    questions: formatBlocks(questionBlocks),
    unknownBlocks: unknown,
    needsAi
  };
}

/** 让 AI 判断哪些区块是原文、哪些是题目 */
async function aiClassifyBlocks(blocks) {
  const listing = blocks
    .map((block, index) => {
      const preview = String(block.preview || block.text || '')
        .replace(/\s+/g, ' ')
        .slice(0, 150);
      const size = block.length || String(block.text || '').length;
      return `#${index}｜位置:${SIDE_LABEL[block.side] || '未知'}｜约${size}字\n${preview}`;
    })
    .join('\n\n');

  const messages = [
    {
      role: 'system',
      content:
        '你在帮一个雅思做题插件区分网页上的区块。雅思阅读题页面通常包含「阅读原文（Reading Passage）」和「题目（Questions）」两部分。' +
        '判断依据：连续的文章正文段落属于原文；出现题号（1. 2. 3.）、题目指令（Questions 1-6、TRUE/FALSE/NOT GIVEN、Choose the correct letter、Complete the table）、' +
        '选项（A) B) C) D)）、填空下划线等属于题目。' +
        '只输出 JSON，不要任何解释。'
    },
    {
      role: 'user',
      content: `把下面这些区块分类，输出 {"passage":[索引],"questions":[索引],"other":[索引]}（索引就是下面的 # 编号，可以有多项，也可以为空）：\n\n${listing}`
    }
  ];

  const raw = await chatCompletion({ settings: state.settings, messages, jsonMode: true, stream: false });
  return parseLooseJson(raw);
}

/** 把 AI 的分类结果套回区块 */
function applyAiSplit(blocks, result) {
  const pick = (list) =>
    (Array.isArray(list) ? list : []).map((index) => blocks[Number(index)]).filter(Boolean);
  return {
    passage: formatBlocks(pick(result?.passage)),
    questions: formatBlocks(pick(result?.questions)),
    unknownBlocks: [],
    needsAi: false,
    usedAi: true
  };
}

/**
 * 决定「原文 / 题目」分别放什么：先走启发式，角色不确定时（可选）让 AI 再判一次。
 * 无论哪条路径，都不会把整页塞进题目框。
 */
async function resolveBlocks(blocks) {
  const base = blocks.length
    ? splitBlocks(blocks)
    : { passage: '', questions: '', unknownBlocks: [], needsAi: false };

  if (!base.needsAi) return base;
  if (state.settings?.smartSplit === false || !state.settings?.apiKey) return base;

  setStatus('正在用 AI 判断哪些是原文、哪些是题目…');
  try {
    const result = await aiClassifyBlocks(blocks);
    if (result) {
      const applied = applyAiSplit(blocks, result);
      if (applied.passage || applied.questions) return applied;
    }
  } catch (err) {
    console.warn('[雅思助手] AI 分块失败：', err?.message || err);
  }
  return base;
}

/** 当前标签页是否用了「原文 + 题目」双输入框 */
function usesPassageField() {
  return Boolean(MODES[state.mode]?.dual);
}

async function grabPage() {
  const res = await sendMessage({ type: 'grabPage' });
  if (!res.ok) return { ok: false, error: res.error || '抓取失败' };
  const data = res.data || {};
  state.pageTitle = data.title || state.pageTitle;
  state.pageUrl = data.url || state.pageUrl;
  return { ok: true, text: data.text || '', blocks: Array.isArray(data.blocks) ? data.blocks : [] };
}

/**
 * 从整页文本里去掉某一段（用于把已知的那部分从另一个框里剔除掉）。
 * 注意：传进来的 part 通常是 formatBlocks 的输出，带「【原文1｜页面左侧】」这类前缀，
 * 所以这里按「行」比对，而不是拿前缀去 indexOf —— 否则永远找不到、会原样返回整页。
 */
function removePart(pageText, part) {
  const target = String(part || '');
  if (!target.trim()) return pageText;

  const partLines = new Set(
    target
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 10)
  );
  if (!partLines.size) return pageText;

  const kept = String(pageText)
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^【.{1,40}】$/.test(trimmed)) return false; // 我们自己的区块标题行
      return !partLines.has(trimmed);
    });

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 「抓取本页」：只填它自己所属的那个框，不动另一个框。
 * @param {'passage'|'main'} target passage = 上面的「阅读原文」框，main = 下面的「题目」框
 */
async function handleGrabClick(target = 'main') {
  els.grabPage.disabled = true;
  els.grabPageSecondary.disabled = true;
  const dual = usesPassageField();
  const label = target === 'passage' ? '原文' : dual ? '题目' : '内容';
  setStatus(`正在识别本页内容（找「${label}」）…`);

  try {
    const result = await grabPage();
    if (!result.ok) {
      setStatus(result.error, 'error');
      return;
    }
    const { text, blocks } = result;
    const split = await resolveBlocks(blocks);

    /* ---------- 上面的「阅读原文」框 ---------- */
    if (target === 'passage') {
      let passageText = split?.passage || '';
      if (!passageText) {
        // 没识别出文章块：从整页里剥掉已知的题目部分，剩下的当原文
        const known = split?.questions || '';
        passageText = known ? removePart(text, known) : text;
      }
      if (!passageText) {
        setStatus('没识别到「原文」区块：请先在网页上划选文章，再点这个框的「用选中文字」。', 'error');
        return;
      }
      els.passage.value = passageText;
      updateMeta();
      setStatus(
        split?.passage
          ? `已把识别到的原文填进上面这框（${passageText.length} 字），题目框没动。`
          : `这一页没识别出分栏，已把整页文字放进上面这框（${passageText.length} 字），题目框没动。`,
        'ok'
      );
      return;
    }

    /* ---------- 单框板块（听力 / 写作 / 批改 / 精讲）：不分原文题目，只取内容 ---------- */
    if (!dual) {
      if (!blocks.length && !text) {
        setStatus('这个页面没抓到内容，请改用「用选中文字」或手动粘贴。', 'error');
        return;
      }
      // 这类板块的页面通常只有题目：优先只取被判定为「题目」的区块，不要把原文一起拼进来。
      // 但听力页面的 Section 1（填空/表格）经常因为缺乏 A/B/C 之类特征被判成 article，
      // 严格按 role 过滤会把它整段丢掉 —— 表现就是"只读到后半段题目"。
      // 所以：questions 块覆盖得够多就用它（避免混进导航），太少就退到整页。
      const questionBlocks = blocks.filter((block) => block.role === 'questions');
      const allContent = joinUniqueBlocks(blocks) || text;
      const questionsContent = joinUniqueBlocks(questionBlocks);
      const looksIncomplete =
        !questionsContent || questionsContent.length < allContent.length * 0.5;
      const content = looksIncomplete ? allContent : questionsContent;

      els.input.value = content;
      updateMeta();
      if (!looksIncomplete) {
        setStatus(
          `已抓取本页的题目部分（${content.length} 字，已自动排除原文区块）。`,
          'ok'
        );
      } else {
        setStatus(`已抓取本页内容（${content.length} 字），可以开始分析了。`, 'ok');
        if (!looksLikeIelts(text)) {
          setTip('本页没检测到明显的雅思题目特征，你也可以只保留题目部分再分析。', 'warn');
        }
      }
      return;
    }

    // 双框模式：题目框只放题目
    if (split?.questions) {
      els.input.value = split.questions;
      updateMeta();
      setStatus(
        `已把识别到的题目填进下面这框（${split.questions.length} 字），原文框没动。`,
        'ok'
      );
      return;
    }

    // 没识别出题目：只有当原文框已有内容、且整页里确实还剩下别的东西时才填剩余部分，
    // 绝不把整页（含原文）塞进题目框
    const remaining = els.passage.value ? removePart(text, els.passage.value) : '';
    if (remaining) {
      els.input.value = remaining;
      updateMeta();
      setStatus(
        blocks.length >= 2
          ? '这一页没识别到「题目」区块，已把除原文外的其余内容填进来，请核对一下。'
          : '这一页没识别出分栏，已把剩余内容（已剔除原文部分）填进这框，请核对一下。',
        'ok'
      );
      return;
    }

    setStatus(
      blocks.length >= 2
        ? '这一页没识别到「题目」区块（可能整页都是文章）。请先在网页上划选题目，再点这个框的「用选中文字」。'
        : '没抓到可用内容。请先用鼠标划选题目，再点这个框的「用选中文字」。',
      'error'
    );
  } finally {
    els.grabPage.disabled = false;
    els.grabPageSecondary.disabled = false;
  }
}

/** 把网页上刚划选的文字填到指定输入框（main = 题目框，passage = 原文框） */
async function handleUseSelection(target = 'main') {
  const res = await sendMessage({ type: 'getActiveTab' });
  if (!res.ok) {
    setStatus(res.error || '读取失败', 'error');
    return;
  }
  state.pageTitle = res.data.title || state.pageTitle;
  state.pageUrl = res.data.url || state.pageUrl;
  const selection = (res.data.selection || '').trim();
  if (!selection) {
    setStatus('没取到选中的文字：请先在网页上用鼠标划选一次，再回来点这个按钮。', 'error');
    return;
  }
  if (target === 'passage' && usesPassageField()) {
    els.passage.value = selection;
    setStatus(`已填入「阅读原文」（${selection.length} 字）。`, 'ok');
  } else {
    els.input.value = selection;
    setStatus(`已填入「${usesPassageField() ? '题目' : '输入框'}」（${selection.length} 字）。`, 'ok');
  }
  updateMeta();
}

async function autoGrabIfIeltsPage() {
  if (els.input.value.trim() || els.passage.value.trim()) return;
  const result = await grabPage();
  if (!result.ok) return;
  const { text, blocks } = result;
  if (!text && !blocks.length) return;

  const looksIelts = looksLikeIelts(text) || blocks.some((block) => block.role === 'questions');
  if (!looksIelts) {
    setTip('本页没识别到雅思题目。划选题目后点「用选中文字」，或直接粘贴内容。');
    return;
  }

  if (usesPassageField()) {
    const split = await resolveBlocks(blocks);
    const questions = split.questions || '';
    // 原则：整页内容只进「原文」框，题目框只放明确识别出的题目
    let passage = split.passage;
    if (!passage) passage = questions ? removePart(text, questions) : text;

    if (passage) els.passage.value = passage;
    if (questions) els.input.value = questions;
    updateMeta();
    setStatus(
      questions
        ? '已自动识别本页：原文与题目分别填进上下两框，点「开始分析」即可。'
        : '已把本页内容放进「原文」框；没找到题目区块，请划选题目后点「题目」框的「用选中文字」。',
      'ok'
    );
    return;
  }

  // 单框板块（听力/写作/批改/精讲）：优先只取题目标区块，并按内容去重
  const questionBlocks = blocks.filter((block) => block.role === 'questions');
  const content = joinUniqueBlocks(questionBlocks.length ? questionBlocks : blocks) || text;
  if (!content) return;
  els.input.value = content;
  updateMeta();
  setStatus(`已自动识别本页内容（${content.length} 字），点「开始分析」即可。`, 'ok');
}

/* ---------------- 联网检索（先搜剑桥雅思题，再交给模型判断） ---------------- */

/** 给官方搜索提的问题：既要出处，也要答案 */
function buildSearchQuestion(queries, sourceText) {
  const snippet = String(sourceText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);
  return [
    '请联网检索下面这道雅思题目，核实它的出处与答案：',
    `检索线索：${queries.join(' / ')}`,
    '',
    '题目与原文片段：',
    snippet,
    '',
    '请回答：① 它出自哪一套剑桥雅思（第几册、Test 几、Passage/Section 几），不确定就直说不确定；② 这一部分的参考答案；③ 你参考了哪些来源。'
  ].join('\n');
}

/** 结果可信度标签：贴在分析结果最上方，让用户一眼看清这份答案有多可信 */
const CONFIDENCE = {
  HIGH: '> 🟢 **已核对出处**：官方搜索给出了明确的题目出处与参考答案，可信度较高。',
  PARTIAL: '> 🟡 **部分匹配**：搜到了相关资料但出处不够明确，答案请再核对一次。',
  NONE: '> 🔴 **未找到公开出处**：以下为 AI 依据题目逻辑推断，仅供参考。'
};

/** 把官方搜索结果整理成给模型看的参考块 */
function formatDeepSeekReference(result) {
  const lines = ['\n\n【DeepSeek 官方联网搜索结果】（由 DeepSeek 服务端检索并总结。仍请自行判断，不要照抄）'];
  if (result.summary) lines.push(`总结：${result.summary}`);
  if (result.sources?.length) {
    lines.push('来源：');
    result.sources.slice(0, 6).forEach((item, index) => {
      lines.push(`${index + 1}. ${item.title} — ${item.url}`);
    });
  } else {
    lines.push('（DeepSeek 返回了总结，但没有给出具体来源 URL，请把出处判断当作参考）');
  }
  return lines.join('\n');
}

async function collectWebReference(sourceText) {
  if (state.settings?.webSearch === false) return { block: '', info: '', confidence: '' };

  // 手动出处模式：用用户填的出处当检索词；没填就退化为纯 AI 推理
  let queries = [];
  if (state.settings?.manualExamSource === true) {
    const manual = els.examSource.value.trim();
    if (!manual) {
      return { block: '', info: '未填写题目出处，本次直接由 AI 分析。', confidence: CONFIDENCE.NONE };
    }
    queries = [manual, `${manual} answers`];
  } else {
    queries = buildQueries(sourceText);
  }
  if (!queries.length) return { block: '', info: '', confidence: '' };

  const engine = state.settings?.webSearchEngine || 'deepseek';

  // 首选：DeepSeek 官方联网搜索（服务端执行）
  if (engine === 'deepseek' && state.settings?.apiKey) {
    setStatus('正在用 DeepSeek 官方联网搜索核对题目出处（约 20~40 秒）…');
    const controller = new AbortController();
    state.webController = controller;
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const result = await deepseekWebSearch({
        query: buildSearchQuestion(queries, sourceText),
        settings: state.settings,
        signal: controller.signal,
        maxUses: 3
      });
      if (result.ok) {
        return {
          block: formatDeepSeekReference(result),
          info: `DeepSeek 官方搜索完成（${result.sources.length} 个来源），正在分析…`,
          confidence: result.sources.length ? CONFIDENCE.HIGH : CONFIDENCE.PARTIAL
        };
      }
      // 连续失败到一定次数就提醒用户换方式（不擅自改设置）
      const streak = Number(result.failStreak || 0);
      setStatus(
        streak >= 3
          ? `官方搜索已连续失败 ${streak} 次（${result.error}）。可在设置里把「联网检索方式」换成浏览器检索。`
          : `官方搜索没成功（${result.error}），改用浏览器检索…`
      );
    } catch (err) {
      const message = err?.name === 'AbortError' ? '超时或已取消' : String(err?.message || err);
      setStatus(`官方搜索出错（${message}），改用浏览器检索…`);
    } finally {
      clearTimeout(timer);
      state.webController = null;
    }
  }

  // 回落：扩展自己抓搜索引擎（同样受「停止生成」控制）
  const controller = new AbortController();
  state.webController = controller;
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    for (const query of queries) {
      if (controller.signal.aborted) break;
      setStatus(`正在联网检索：${query}`);
      const found = await searchWeb(query, { limit: 4, signal: controller.signal });
      if (found.results.length) {
        return {
          block: formatResultsForPrompt(found.results, found.engine),
          info: `已检索到 ${found.results.length} 条公开资料（${found.engine}），正在分析…`,
          confidence: CONFIDENCE.PARTIAL
        };
      }
    }
  } finally {
    clearTimeout(timer);
    state.webController = null;
  }
  return { block: '', info: '没检索到公开资料，本次改用模型自身知识分析。', confidence: CONFIDENCE.NONE };
}

/* ---------------- 划词/右键菜单送来的任务 ---------------- */

async function applyTask(task) {
  if (!task) return;
  const mode = task.mode;

  // 正在生成时又送来一个任务：不能并发（两个流会互相覆盖 state.answer、还会把 controller 弄丢
  // 导致「停止生成」失效）。这里直接拒绝，由调用方决定是否保留任务。
  if (state.running) {
    setStatus('正在生成中，等这次完成或先点「停止」再做别的。', 'warn');
    return;
  }

  if (mode === 'translate' && task.text) {
    setMode('chat');
    els.input.value = task.text;
    updateMeta();
    await runTranslate(task.text);
    return;
  }

  if (mode === 'explain' && task.text) {
    setMode('chat');
    els.input.value = task.text;
    updateMeta();
    const messages = buildMessages('explain', {
      text: task.text,
      contextText: '',
      pageTitle: task.pageTitle,
      explainLang: state.settings?.explainLang
    }).messages;
    await streamAnswer(messages);
    return;
  }

  if (MODES[mode]) setMode(mode);
  if (task.pageTitle) state.pageTitle = task.pageTitle;
  if (task.pageUrl) state.pageUrl = task.pageUrl;

  const selection = (task.text || '').trim();
  const pageText = (task.pageText || '').trim();
  const blocks = Array.isArray(task.pageBlocks) ? task.pageBlocks : [];

  // 阅读/听力是「原文 + 题目」双框：能判断出角色就分开填
  if (usesPassageField()) {
    const split = await resolveBlocks(blocks);
    const passageText = split.passage || pageText;
    const questionText = selection || split.questions || '';
    if (passageText && passageText !== questionText) els.passage.value = passageText;
    // 题目框只放明确的题目，否则放「整页减去原文」的剩余部分，绝不放整页
    els.input.value = questionText || (els.passage.value ? removePart(pageText, els.passage.value) : '');
    if (!els.input.value.trim() && !els.passage.value.trim()) return;
    updateMeta();
    await run();
    return;
  }

  let content = '';
  if (pageText && selection && selection.length < 1500 && !pageText.includes(selection.slice(0, 80))) {
    content = `${selection}\n\n--- 页面正文 ---\n${pageText}`;
  } else if (pageText) {
    content = pageText;
  } else {
    content = selection;
  }
  if (!content) return;
  els.input.value = content;
  updateMeta();
  await run();
}

/* ---------------- 草稿 ---------------- */

let draftTimer = null;
let lastDraftFingerprint = '';
const DRAFT_IMAGE_BUDGET = 2_000_000; // 草稿里图片的总体积上限（字符数），超了就只保留文字

/**
 * 草稿指纹：只比「结构和体积」，不去序列化图片内容本身。
 * 每敲一个字都把含 base64 图片（可能上 MB）的整份草稿重新 stringify + 写盘会明显卡顿，
 * 而图片只在增删时整体变化，用「数量 + 长度」判断已经足够。
 */
function draftFingerprint(images) {
  const img = Object.entries(images)
    .map(([mode, list]) => `${mode}:${list.map((item) => (item.dataUrl || item.src || '').length).join(',')}`)
    .join('|');
  const res = Object.entries(state.results)
    .map(([mode, text]) => `${mode}:${String(text || '').length}`)
    .join('|');
  return `${JSON.stringify(state.drafts)}##${img}##${res}`;
}

function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    captureCurrent();

    // 图片也一起存：只存 dataUrl（页面图片的 URL 常是带登录态的临时地址，回来后未必能访问）
    const images = {};
    let budget = DRAFT_IMAGE_BUDGET;
    for (const [mode, list] of Object.entries(state.imagesByMode)) {
      const kept = (list || []).filter((item) => {
        const url = item?.dataUrl || '';
        if (!url.startsWith('data:')) return false;
        if (url.length > budget) return false;
        budget -= url.length;
        return true;
      });
      if (kept.length) images[mode] = kept;
    }

    const fingerprint = draftFingerprint(images);
    if (fingerprint === lastDraftFingerprint) return; // 内容没变就别重写
    lastDraftFingerprint = fingerprint;

    chrome.storage.local
      .set({
        draft: {
          drafts: state.drafts,
          images,
          results: state.results,
          url: state.pageUrl,
          ts: Date.now()
        }
      })
      .catch(() => {});
  }, 400);
}

async function restoreDraft() {
  try {
    const { draft } = await chrome.storage.local.get('draft');
    const drafts = draft?.drafts;
    if (!drafts || typeof drafts !== 'object') return false;
    const fresh = Date.now() - (draft.ts || 0) < 2 * 60 * 60 * 1000;
    if (!fresh) return false;

    const hasContent = Object.values(drafts).some((item) => {
      if (!item) return false;
      // 注意 examSource：手动出处模式下可能只有出处、没有正文，不能当成空草稿丢掉
      return Boolean(
        (item.text || '').trim() || (item.passage || '').trim() || (item.examSource || '').trim()
      );
    });
    const hasImages = Object.values(draft.images || {}).some(
      (list) => Array.isArray(list) && list.length
    );
    const hasResults = Object.values(draft.results || {}).some((value) => String(value || '').trim());
    if (!hasContent && !hasImages && !hasResults) return false;

    state.drafts = drafts;
    if (draft.images && typeof draft.images === 'object') state.imagesByMode = draft.images;
    if (draft.results && typeof draft.results === 'object') state.results = draft.results;
    restoreFor(state.mode);
    setStatus('已恢复上次未完成的内容（各板块的文本 / 图片 / 结果分别保留）。点「清空」可重新抓取本页。');
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  els.tabs.addEventListener('click', (event) => {
    const mode = event.target?.dataset?.mode;
    if (!mode) return;
    if (state.mode === mode) return;
    setMode(mode);
    resetTip();
    setStatus('');
  });

  els.taskSeg.addEventListener('click', (event) => {
    const task = event.target?.dataset?.task;
    if (!task) return;
    state.task = task;
    for (const button of els.taskSeg.querySelectorAll('button')) {
      button.classList.toggle('active', button.dataset.task === task);
    }
  });

  els.run.addEventListener('click', () => run());
  els.stop.addEventListener('click', () => {
    state.controller?.abort();
    state.webController?.abort();
  });

  els.grabPage.addEventListener('click', () => handleGrabClick('passage')); // 上面的「阅读原文」框
  els.grabPageSecondary.addEventListener('click', () => handleGrabClick('main')); // 下面的「题目」框
  els.useSelection.addEventListener('click', () => handleUseSelection('passage'));
  els.useSelectionSecondary.addEventListener('click', () => handleUseSelection('main'));

  const onInputChange = () => {
    updateMeta();
    saveDraft();
  };
  els.input.addEventListener('input', onInputChange);
  els.passage.addEventListener('input', onInputChange);
  els.examSource.addEventListener('input', () => {
    captureCurrent();
    saveDraft();
  });

  // 侧边栏被隐藏（关闭）时，把还在跑的请求中止掉，别白烧 token
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    state.controller?.abort();
    state.webController?.abort();
  });

  els.input.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      run();
    }
  });

  els.clearInput.addEventListener('click', () => {
    els.input.value = '';
    captureCurrent();
    updateMeta();
    saveDraft();
    setStatus('');
    resetTip();
  });

  els.clearPassage.addEventListener('click', () => {
    els.passage.value = '';
    captureCurrent();
    updateMeta();
    saveDraft();
  });

  els.clearResult.addEventListener('click', () => {
    state.answer = '';
    state.results[state.mode] = '';
    els.result.classList.add('empty');
    els.result.textContent = '分析结果会显示在这里。';
    setStatus('');
    if (state.mode === 'chat') state.chatHistory = [];
    saveDraft(); // 清空要落盘，否则关掉侧边栏结果又回来了
  });

  els.copyResult.addEventListener('click', async () => {
    const text = stripSearchQuery(state.answer || '');
    if (!text) {
      setStatus('还没有可复制的内容。', 'warn');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus('已复制到剪贴板。', 'ok');
    } catch {
      setStatus('复制失败，请手动选择文本。', 'error');
    }
  });

  els.searchAnswer.addEventListener('click', () => {
    let query = extractSearchQuery(state.answer || '');
    let suffix = '';
    if (!query) {
      const text = els.input.value.trim();
      if (!text) {
        setStatus('没有可搜索的内容：先分析一次，或把题目贴进来。', 'warn');
        return;
      }
      query = text.replace(/\s+/g, ' ').slice(0, 120);
      suffix = ' IELTS answers';
    }
    // 用 cn.bing.com：国内访问更稳，也不会被重定向走
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(query + suffix)}`;
    chrome.tabs.create({ url });
  });

  els.btnGear.addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.goOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.modelWarnFix.addEventListener('click', () => chrome.runtime.openOptionsPage());

  // 结果区放大 / 还原
  els.toggleExpand.addEventListener('click', () => {
    const expanded = document.body.classList.toggle('result-expanded');
    els.toggleExpand.textContent = expanded ? '⛶ 还原' : '⛶ 放大';
    els.toggleExpand.title = expanded ? '还原结果区' : '放大结果区（占满侧边栏）';
  });

  // 「简洁」开关（记住选择）
  els.briefMode.addEventListener('change', () => {
    saveSettings({ briefMode: els.briefMode.checked }).catch(() => {});
  });

  // 图片：上传 / 截图 / 抓取本页 / 清空
  els.pickImage.addEventListener('click', () => els.imageFile.click());

  els.imageFile.addEventListener('change', async () => {
    const files = Array.from(els.imageFile.files || []).slice(0, 6);
    const items = [];
    for (const file of files) {
      if (!/^image\//.test(file.type)) continue;
      if (file.size > 8 * 1024 * 1024) continue;
      const dataUrl = await readFileAsDataUrl(file);
      if (dataUrl) items.push({ dataUrl, alt: file.name });
    }
    els.imageFile.value = '';
    if (!items.length) {
      setStatus('没读到可用图片（只支持图片文件，单张请小于 8MB）。', 'warn');
      return;
    }
    addImages(items);
    setStatus(`已添加 ${items.length} 张图片。`, 'ok');
  });

  els.captureTab.addEventListener('click', async () => {
    els.captureTab.disabled = true;
    setStatus('正在截取当前画面…');
    try {
      const res = await sendMessage({ type: 'captureTab' });
      if (!res.ok) {
        setStatus(res.error || '截图失败', 'error');
        return;
      }
      addImages([{ dataUrl: res.data.dataUrl, alt: '截屏' }]);
      setStatus('已把当前画面作为图片加入。', 'ok');
    } finally {
      els.captureTab.disabled = false;
    }
  });

  els.grabImages.addEventListener('click', async () => {
    els.grabImages.disabled = true;
    setStatus('正在抓取本页图片…');
    try {
      const res = await sendMessage({ type: 'grabImages' });
      if (!res.ok) {
        setStatus(res.error || '没找到图片', 'error');
        return;
      }
      addImages(res.data.images.map((item) => ({ src: item.src, alt: item.alt })));
      setStatus(`已加入 ${res.data.images.length} 张页面图片。`, 'ok');
    } finally {
      els.grabImages.disabled = false;
    }
  });

  els.clearImages.addEventListener('click', () => {
    state.imagesByMode[state.mode] = [];
    renderImages();
    saveDraft();
  });

  // 把图片直接拖进图片区
  for (const type of ['dragenter', 'dragover']) {
    els.imageList.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
      els.imageList.classList.add('dragover');
    });
  }
  els.imageList.addEventListener('dragleave', () => els.imageList.classList.remove('dragover'));
  els.imageList.addEventListener('drop', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    els.imageList.classList.remove('dragover');
    await handleDroppedData(event.dataTransfer);
  });
  // 拖到整个输入区也接受（但别让浏览器把页面导航成那张图）
  els.composer.addEventListener('dragover', (event) => {
    if (!els.imageRow.classList.contains('hidden')) event.preventDefault();
  });
  els.composer.addEventListener('drop', async (event) => {
    if (els.imageRow.classList.contains('hidden')) return;
    event.preventDefault();
    await handleDroppedData(event.dataTransfer);
  });

  // 复制图片后直接在侧边栏按 Ctrl+V
  document.addEventListener('paste', async (event) => {
    if (els.imageRow.classList.contains('hidden')) return;
    await handleDroppedData(event.clipboardData);
  });
}

/* ---------------- 启动 ---------------- */

async function init() {
  state.settings = await getSettings();
  updateKeyBanner();
  updateModelWarn();
  els.briefMode.checked = state.settings?.briefMode === true;
  setMode(state.mode);
  bindEvents();

  const restored = await restoreDraft();
  const pending = await takePendingTask();
  if (pending) {
    await applyTask(pending);
  } else if (!restored) {
    await autoGrabIfIeltsPage();
  }

  onPendingTask((task) => {
    // 先判断能不能接，再接：如果正在生成就先别把任务从 storage 里删掉，
    // 否则 applyTask 拒绝执行 + 任务已被清掉 = 用户点了「深入精讲」却什么都没发生，且永久丢失。
    if (state.running) {
      setStatus('正在生成中，等这次完成或先点「停止」再做别的。', 'warn');
      return;
    }
    takePendingTask(); // 清掉已消费的任务，避免下次打开侧边栏时重复执行
    applyTask(task);
  });

  onSettingsChanged((settings) => {
    state.settings = settings;
    updateKeyBanner();
    updateModelWarn();
    // 设置页里刚改过的开关（如「手动指定题目出处」）要立刻反映到当前板块
    refreshModeVisibility();
  });
}

init();
