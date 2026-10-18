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
  { id: 'ielts-writing', title: '雅思助手：帮我写这套作文', contexts: ['selection', 'page'] }
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
