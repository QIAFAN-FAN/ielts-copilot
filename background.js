// Service worker：负责菜单、侧边栏、以及替内容脚本代理 DeepSeek 请求
import { getSettings, setPendingTask } from './lib/store.js';
import { chatCompletion } from './lib/deepseek.js';
import { buildMessages } from './lib/prompts.js';
import { translateText } from './lib/translate.js';
import {
  addTerm,
  removeTerm,
  resetDisabled,
  listGlossary,
  getGlossary,
  listLearned,
  listCandidates,
  removeLearned,
  clearLearned,
  promoteCandidate
} from './lib/glossary.js';

const MENUS = [
  { id: 'ielts-translate', title: '雅思助手：翻译选中的文字', contexts: ['selection'] },
  { id: 'ielts-selection-detail', title: '雅思助手：精讲选中的文字', contexts: ['selection'] },
  { id: 'ielts-reading', title: '雅思助手：分析本页阅读题', contexts: ['page', 'selection'] },
  { id: 'ielts-listening', title: '雅思助手：分析选中的听力题', contexts: ['selection', 'page'] },
  { id: 'ielts-writing', title: '雅思助手：帮我写这套作文', contexts: ['selection', 'page'] },
  { id: 'ielts-image', title: '雅思助手：翻译这张图片里的文字', contexts: ['image'] }
];

async function setupExtension() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn('[雅思助手] setPanelBehavior 失败', err);
  }
  await chrome.contextMenus.removeAll();
  for (const menu of MENUS) chrome.contextMenus.create(menu);
}

chrome.runtime.onInstalled.addListener(setupExtension);
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

/* ------------------------- 右键菜单 ------------------------- */

const MENU_TO_MODE = {
  'ielts-translate': 'translate',
  'ielts-selection-detail': 'explain',
  'ielts-reading': 'reading',
  'ielts-listening': 'listening',
  'ielts-writing': 'writing'
};

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // 图片翻译：右键图片 → 让页面那张图自己走一遍翻译流程
  if (info.menuItemId === 'ielts-image') {
    if (!tab?.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'translateImageByUrl',
        url: info.srcUrl || ''
      });
    } catch {
      /* 页面可能还没加载 content script，忽略 */
    }
    return;
  }

  const mode = MENU_TO_MODE[info.menuItemId];
  if (!mode || !tab?.id) return;

  // 抓页面正文（阅读/写作需要整页内容；翻译/精讲只用选中文字）
  let pageText = '';
  let pageBlocks = [];
  if (mode === 'reading' || mode === 'writing' || !info.selectionText) {
    const [page, blockResult] = await Promise.all([
      readPageDetailed(tab.id),
      readBlocksDetailed(tab.id)
    ]);
    pageText = page.text;
    pageBlocks = blockResult.blocks;
  }

  const task = {
    mode,
    text: info.selectionText || '',
    pageText,
    pageBlocks,
    pageTitle: tab.title || '',
    pageUrl: tab.url || '',
    origin: 'contextMenu'
  };

  await setPendingTask(task);
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.warn('[雅思助手] 侧边栏需手动打开（缺少用户手势）', err);
    notifyTab(tab.id, '已收到内容，请点击浏览器工具栏上的「雅思助手」图标打开侧边栏。');
  }
});

/* ------------------------- 页面抓取 ------------------------- */

const MAX_PAGE_TEXT = 40000;
const MIN_FRAME_TEXT = 60;

/** 在页面的所有 frame 里执行采集函数；error 保留原始失败原因，用于给用户诊断 */
async function collectFromFrames(tabId, func) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func
    });
    const values = [];
    for (const item of results || []) {
      if (item?.error) continue;
      if (item?.result !== undefined && item?.result !== null) values.push(item.result);
    }
    return { values, error: '' };
  } catch (err) {
    return { values: [], error: String(err?.message || err) };
  }
}

/** 直连内容脚本（不依赖 scripting 权限，作为 executeScript 的兜底通道） */
async function askContentScript(tabId, type) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type });
    return { ok: true, data: response || null };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

const EXTRACT_FUNC = () => {
  try {
    if (typeof window.__IELTS_EXTRACT__ === 'function') return window.__IELTS_EXTRACT__();
  } catch {
    /* 走下面的兜底 */
  }
  return (document.body?.innerText || '').trim();
};

const BLOCKS_FUNC = () => {
  try {
    if (typeof window.__IELTS_BLOCKS__ === 'function') return window.__IELTS_BLOCKS__();
  } catch {
    /* 交给上层用全文兜底 */
  }
  return [];
};

/** 抓正文（含 iframe），失败时自动改走内容脚本 */
async function readPageDetailed(tabId) {
  const notes = [];
  const injected = await collectFromFrames(tabId, EXTRACT_FUNC);
  if (injected.error) notes.push(`注入失败：${injected.error}`);

  let texts = injected.values
    .map((value) => String(value || '').trim())
    .filter((value) => value.length > MIN_FRAME_TEXT);

  if (!texts.length) {
    const fallback = await askContentScript(tabId, 'extractPageText');
    const fallbackText = String(fallback.data?.text || '').trim();
    if (fallbackText.length > MIN_FRAME_TEXT) {
      texts = [fallbackText];
      notes.push('已通过内容脚本兜底取文');
    } else if (fallback.error) {
      notes.push(`内容脚本兜底失败：${fallback.error}`);
    }
  }

  const seen = new Set();
  const parts = [];
  for (const text of texts) {
    const key = text.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(text);
  }

  let merged = parts.join('\n\n').trim();
  if (merged.length > MAX_PAGE_TEXT) {
    merged = merged.slice(0, MAX_PAGE_TEXT) + '\n\n[内容过长，已截断]';
  }
  return { text: merged, notes };
}

/** 识别版面分区（原文 / 题目），同样带内容脚本兜底 */
async function readBlocksDetailed(tabId) {
  const notes = [];
  const injected = await collectFromFrames(tabId, BLOCKS_FUNC);
  if (injected.error) notes.push(`注入失败：${injected.error}`);

  let collected = injected.values.flat().filter(Boolean);

  if (!collected.length) {
    const fallback = await askContentScript(tabId, 'extractPageBlocks');
    if (Array.isArray(fallback.data?.blocks)) collected = fallback.data.blocks;
  }

  // 跨 frame / 嵌套容器很容易收到「同一段内容的多个副本」（前后空白或换行略有差异）。
  // 按「去掉所有空白后的全文」判重；关键是要**从最短的块开始处理**：
  // 如果先收下一个把很多子块都包住的大容器，后面那些更细的题目块会被它判成重复而全部丢掉。
  const norm = (value) => String(value || '').replace(/\s+/g, '');
  const cleaned = collected
    .map((block) => ({ ...block, text: String(block?.text || '').trim() }))
    .filter((block) => block.text.length >= 80 && norm(block.text))
    .sort((a, b) => norm(a.text).length - norm(b.text).length);

  const blocks = [];
  for (const block of cleaned) {
    const key = norm(block.text);
    if (blocks.some((kept) => norm(kept.text).includes(key))) continue;
    blocks.push(block);
  }
  return { blocks, notes };
}

/** 抓不到时给出具体原因（本地文件 / PDF / 内部页面 / 注入被拒） */
function diagnoseGrabFailure(tab, notes) {
  const url = tab?.url || '';
  const detail = notes.length ? `（技术细节：${notes.slice(0, 2).join('；')}）` : '';
  if (!url) return `抓不到页面文字。${detail}`;
  if (/^(chrome|edge|about|devtools|chrome-extension):/i.test(url) || /^https:\/\/chromewebstore\.google\.com/i.test(url)) {
    return `这是浏览器内部页面或扩展商店页面，Chrome 不允许任何扩展读取，请换到正常网页上使用。${detail}`;
  }
  if (url.startsWith('file://')) {
    return `这是本地文件（file://）。请到 chrome://extensions/ 找到「雅思助手」，打开「允许访问文件网址」，再刷新该文件页重试。${detail}`;
  }
  if (/\.pdf($|[?#])/i.test(url)) {
    return `这看起来是 PDF。Chrome 内置的 PDF 阅读器不允许扩展读取文字：请用 PDF 工具栏的「选择工具」划选文字后点「用选中文字」，或把 PDF 下载后用其他阅读器打开。${detail}`;
  }
  return `这个页面抓不到文字：可能是还没加载完、页面结构特殊，或该网站限制了扩展注入。可以直接在页面上划选文字后点「用选中文字」。${detail}`;
}

function notifyTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, { type: 'toast', message }, { frameId: 0 }).catch(() => {});
}

/* ------------------------- 划选取文 ------------------------- */

const SELECTION_KEY = 'lastSelection';
const SELECTION_TTL = 30 * 60 * 1000;

/**
 * 取当前页面选中的文字。
 * 优先用实时选区；实时选区为空时（常见：用户划完字后点了侧边栏，浏览器把选区清掉了）
 * 回退到最近一次记下的选区，避免出现「没有选中文字」。
 */
async function readSelection(tabId, url) {
  const injected = await collectFromFrames(tabId, () => String(window.getSelection?.() || '').trim());
  let live = '';
  for (const value of injected.values) {
    const text = String(value || '').trim();
    if (text.length > live.length) live = text;
  }
  if (!live) {
    const fallback = await askContentScript(tabId, 'getSelectionText');
    live = String(fallback.data?.text || '').trim();
  }
  if (live) return live;

  try {
    const raw = await chrome.storage.session.get(SELECTION_KEY);
    const cached = raw?.[SELECTION_KEY];
    if (
      cached?.text &&
      Date.now() - (cached.ts || 0) < SELECTION_TTL &&
      (!url || !cached.url || cached.url === url)
    ) {
      return cached.text;
    }
  } catch {
    /* 忽略 */
  }
  return '';
}

async function rememberSelection(text, url) {
  const value = String(text || '').trim();
  if (!value) return;
  try {
    await chrome.storage.session.set({
      [SELECTION_KEY]: { text: value, url: url || '', ts: Date.now() }
    });
  } catch {
    /* 忽略 */
  }
}

/* ------------------------- 消息路由 ------------------------- */

const TIMEOUT_MS = 90000;

async function withTimeout(fn, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 确保 offscreen 文档存在（OCR 要在有 DOM + 能跑 WASM 的环境里执行，
 * service worker 两者都没有；内容脚本又会受目标网页 CSP 限制）。
 */
async function ensureOffscreen() {
  try {
    if (chrome.offscreen?.hasDocument) {
      const has = await chrome.offscreen.hasDocument();
      if (has) return;
    } else {
      const contexts = await chrome.runtime.getContexts?.({
        contextTypes: ['OFFSCREEN_DOCUMENT']
      });
      if (Array.isArray(contexts) && contexts.length) return;
    }
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['WORKERS'],
      justification: '本地 OCR 识别图片里的文字（不联网、不消耗 API）'
    });
  } catch (err) {
    const message = String(err?.message || err);
    // 已存在时创建会报错，忽略即可
    if (!/single offscreen|already/i.test(message)) throw err;
  }
}

/** 在 offscreen 里跑一次 OCR */
async function runOcr(dataUrl, jobId) {
  try {
    await ensureOffscreen();
  } catch (err) {
    return { ok: false, error: `OCR 环境启动失败：${String(err?.message || err)}` };
  }
  try {
    const res = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'ocr:recognize',
      dataUrl,
      lang: 'eng+chi_sim',
      jobId
    });
    if (!res) return { ok: false, error: 'OCR 没有返回结果（后台可能刚被回收，再点一次即可）。' };
    return res;
  } catch (err) {
    return { ok: false, error: `OCR 失败：${String(err?.message || err)}` };
  }
}

/**
 * 逐行翻译 OCR 结果。
 *
 * 关键：**一次请求翻全部行**，用「序号. 文本」的形式发过去并要求原样返回序号，
 * 这样能把译文按行对回去、放回原来的位置。逐行调用接口虽然更简单，但几十行就是
 * 几十次请求，又慢又贵。
 * 只有纯数字/符号的行会被跳过（不需要翻译，也省 token）。
 */
async function translateOcrLines(lines, settings) {
  const targets = [];
  lines.forEach((line, index) => {
    if (/[A-Za-z\u4e00-\u9fff]/.test(String(line?.text || ''))) {
      targets.push({ index, text: String(line.text) });
    }
  });
  if (!targets.length) return lines;

  const payload = targets.map((item, i) => `${i + 1}. ${item.text}`).join('\n');
  let raw = '';
  try {
    raw = await chatCompletion({
      settings,
      messages: [
        {
          role: 'system',
          content:
            '你是翻译助手。把用户给的编号文本逐行翻译成简体中文。' +
            '必须严格遵守：保持「序号. 译文」的格式；一个序号一行；不要合并、不要省略、不要增删行；不要输出任何解释、标题或前后缀。'
        },
        { role: 'user', content: payload }
      ],
      stream: false
    });
  } catch {
    // 翻译失败不算致命错误：把原文显示出来也比什么都不显示好
    return lines;
  }

  const map = new Map();
  for (const match of String(raw || '').matchAll(/(\d+)\s*[.、)]\s*([^\n]+)/g)) {
    map.set(Number(match[1]), match[2].trim());
  }

  return lines.map((line, index) => {
    const pos = targets.findIndex((item) => item.index === index);
    if (pos < 0) return line;
    const zh = map.get(pos + 1);
    return zh ? { ...line, translated: zh } : line;
  });
}

async function handleMessage(msg) {
  switch (msg?.type) {
    case 'translate': {
      const settings = await getSettings();
      try {
        const data = await withTimeout((signal) =>
          translateText({
            text: msg.text,
            contextText: msg.contextText,
            settings,
            signal,
            forceAi: msg.forceAi === true,
            preferOffline: msg.preferOffline === true
          })
        );
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    }

    case 'glossary': {
      if (msg.action === 'add') {
        if (!msg.en || !msg.zh) return { ok: false, error: '请同时提供英文和中文。' };
        return { ok: true, data: await addTerm(msg.en, msg.zh) };
      }
      if (msg.action === 'remove') {
        if (!msg.en) return { ok: false, error: '缺少英文。' };
        return { ok: true, data: await removeTerm(msg.en) };
      }
      if (msg.action === 'resetDisabled') return { ok: true, data: await resetDisabled() };
      if (msg.action === 'list') return { ok: true, data: await listGlossary() };
      if (msg.action === 'full') return { ok: true, data: await getGlossary() };
      // 词汇学习（AI 学到的词会喂给离线词表，翻得越多越省）
      if (msg.action === 'learned') return { ok: true, data: await listLearned() };
      if (msg.action === 'candidates') return { ok: true, data: await listCandidates() };
      if (msg.action === 'promote') {
        if (!msg.en) return { ok: false, error: '缺少英文。' };
        return { ok: true, data: await promoteCandidate(msg.en) };
      }
      if (msg.action === 'removeLearned') {
        if (!msg.en) return { ok: false, error: '缺少英文。' };
        return { ok: true, data: await removeLearned(msg.en) };
      }
      if (msg.action === 'clearLearned') return { ok: true, data: await clearLearned() };
      return { ok: false, error: '未知的术语库操作。' };
    }

    case 'explain': {
      const settings = await getSettings();
      if (!settings.apiKey) return { ok: false, error: 'NO_API_KEY' };
      const { messages } = buildMessages('explain', {
        text: msg.text,
        contextText: msg.contextText,
        pageTitle: msg.pageTitle,
        explainLang: settings.explainLang
      });
      const answer = await withTimeout((signal) =>
        chatCompletion({ settings, messages, signal, stream: false })
      );
      return { ok: true, data: { answer } };
    }

    case 'openPanel': {
      const settings = await getSettings();
      if (!settings.apiKey) return { ok: false, error: 'NO_API_KEY' };
      await setPendingTask(msg.payload);
      const tabId = msg.tabId;
      try {
        if (tabId) await chrome.sidePanel.open({ tabId });
        else {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id });
        }
        return { ok: true, data: { opened: true } };
      } catch (err) {
        return { ok: true, data: { opened: false, reason: String(err?.message || err) } };
      }
    }

    case 'grabPage': {
      let tabId = msg.tabId;
      if (!tabId) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = tab?.id;
      }
      if (!tabId) return { ok: false, error: '找不到当前标签页。' };
      const [page, blockResult] = await Promise.all([
        readPageDetailed(tabId),
        readBlocksDetailed(tabId)
      ]);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const notes = [...page.notes, ...blockResult.notes];
      if (!page.text && !blockResult.blocks.length) {
        return { ok: false, error: diagnoseGrabFailure(tab, notes), data: { url: tab?.url || '' } };
      }
      return {
        ok: true,
        data: {
          text: page.text,
          blocks: blockResult.blocks,
          title: tab?.title || '',
          url: tab?.url || '',
          notes
        }
      };
    }

    case 'getActiveTab': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { ok: false, error: '找不到当前标签页。' };
      const selection = await readSelection(tab.id, tab.url);
      return { ok: true, data: { title: tab.title || '', url: tab.url || '', selection } };
    }

    case 'fetchImage': {
      // 跨域图片取像素：内容脚本受页面 CORS 限制，后台有 host 权限可以直接取
      if (!msg.url) return { ok: false, error: '缺少图片地址。' };
      try {
        const res = await fetch(msg.url, { credentials: 'include' });
        if (!res.ok) return { ok: false, error: `取图失败（HTTP ${res.status}）。` };
        const blob = await res.blob();
        if (!/^image\//.test(blob.type)) return { ok: false, error: '这个地址不是图片。' };
        if (blob.size > 8 * 1024 * 1024) return { ok: false, error: '图片太大（超过 8MB）。' };
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return { ok: true, data: { dataUrl: `data:${blob.type};base64,${btoa(binary)}` } };
      } catch (err) {
        return { ok: false, error: `取图失败：${String(err?.message || err)}` };
      }
    }

    case 'translateImage': {
      // 页面上的图片翻译：本地 OCR（offscreen 里跑）+ 一次批量翻译
      const settings = await getSettings();
      if (!settings.apiKey) return { ok: false, error: '还没有配置 DeepSeek API Key。' };
      if (!msg.dataUrl) return { ok: false, error: '没有拿到图片数据。' };

      const ocr = await runOcr(msg.dataUrl, msg.jobId);
      if (!ocr.ok) return ocr;
      const lines = Array.isArray(ocr.lines) ? ocr.lines : [];
      if (!lines.length) {
        return { ok: false, error: '这张图里没识别到文字（可能是纯图表，或字太小/太模糊）。' };
      }

      const translated = await translateOcrLines(lines, settings);
      return { ok: true, data: { lines: translated, count: translated.filter((l) => l.translated).length } };
    }

    case 'captureTab': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { ok: false, error: '找不到当前标签页。' };
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        if (!dataUrl) return { ok: false, error: '截图失败。' };
        return { ok: true, data: { dataUrl } };
      } catch (err) {
        return { ok: false, error: `截图失败：${String(err?.message || err)}` };
      }
    }

    case 'grabImages': {
      let tabId = msg.tabId;
      if (!tabId) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = tab?.id;
      }
      if (!tabId) return { ok: false, error: '找不到当前标签页。' };

      const injected = await collectFromFrames(tabId, () => {
        try {
          if (typeof window.__IELTS_IMAGES__ === 'function') return window.__IELTS_IMAGES__();
        } catch {
          /* 忽略 */
        }
        return null;
      });

      const stats = { img: 0, background: 0, canvas: 0, frames: 0 };
      let images = [];
      for (const value of injected.values) {
        if (!value) continue;
        stats.frames += 1;
        const list = Array.isArray(value) ? value : value.images || [];
        for (const item of list) images.push(item);
        const inner = value.stats || {};
        stats.img += inner.img || 0;
        stats.background += inner.background || 0;
        stats.canvas += inner.canvas || 0;
      }

      // 页面脚本兜底（有些页面 executeScript 拿不到，但内容脚本能拿到）
      if (!images.length) {
        const fallback = await askContentScript(tabId, 'extractPageImages');
        if (Array.isArray(fallback.data?.images)) images = fallback.data.images;
      }

      const seen = new Set();
      images = images
        .filter((item) => item && (item.dataUrl || item.src))
        .sort((a, b) => (b.area || 0) - (a.area || 0))
        .filter((item) => {
          const key = item.dataUrl || item.src;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 4);

      if (!images.length) {
        return {
          ok: false,
          error:
            `没找到能用的图片。这一页扫到 <img> ${stats.img} 个、CSS 背景图 ${stats.background} 个、canvas ${stats.canvas} 个，` +
            '但都不符合「尺寸够大（≥120×80）且地址可访问」。可以：① 用「截取当前画面」；② 把图片直接**拖进**下面的图片区；' +
            '③ 复制图片后在侧边栏按 Ctrl+V 粘贴。'
        };
      }
      return { ok: true, data: { images, stats } };
    }

    case 'rememberSelection': {
      await rememberSelection(msg.text, msg.url);
      return { ok: true };
    }

    case 'openOptions': {
      // 内容脚本里直接调 openOptionsPage 不一定生效，统一由后台打开
      chrome.runtime.openOptionsPage();
      return { ok: true };
    }

    case 'hasApiKey': {
      const settings = await getSettings();
      return { ok: true, data: { hasKey: !!settings.apiKey, bubbleEnabled: settings.bubbleEnabled } };
    }

    case 'checkKey': {
      const settings = await getSettings();
      if (!settings.apiKey) return { ok: false, error: 'NO_API_KEY' };
      try {
        await withTimeout(
          (signal) =>
            chatCompletion({
              settings,
              messages: [{ role: 'user', content: '回复两个字：正常' }],
              signal,
              stream: false
            }),
          30000
        );
        return { ok: true, data: { message: '连接正常' } };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    }

    default:
      return { ok: false, error: 'UNKNOWN_MESSAGE' };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  handleMessage(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // 异步响应
});
