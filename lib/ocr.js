// 本地 OCR（Tesseract.js）—— 跑在扩展页面里，完全不消耗 API token
//
// 为什么用本地方案：DeepSeek 没有 OCR 能力（只有"看图说话"，拿不到文字坐标），
// 而"把译文放回原位置"必须有坐标。用另一个云 OCR 又要多一个 Key 和付费，
// 与「只填一个 DeepSeek Key」的架构冲突，所以选了本地引擎。
//
// 资源全部在 lib/ocr/ 下（不联网下载）：
//   tesseract.min.js            主库（由 sidepanel.html 的 <script> 加载，挂在 window.Tesseract）
//   worker.min.js               识别 worker
//   tesseract-core-simd.wasm.js + .wasm   WASM 内核
//   eng.traineddata.gz / chi_sim.traineddata.gz   fast 版语言包
//
// 首次识别要加载约 10MB 资源（一次），之后由浏览器缓存复用。

const OCR_DIR = 'lib/ocr';
// 箭头、山体轮廓这些图形很容易被识别成零散的"文字"（比如 ∠ / \ ママ），
// 置信度通常偏低。阈值定高一点，宁可少识别几条，也别把图搞乱。
const MIN_CONFIDENCE = 55; // 置信度低于这个的行直接丢掉（通常是噪点或误识）

let currentWorker = null;
let currentLangs = '';
let loadingPromise = null;

function ocrUrl(file) {
  try {
    return chrome.runtime.getURL(`${OCR_DIR}/${file}`);
  } catch {
    return `${OCR_DIR}/${file}`;
  }
}

/**
 * 懒加载一个 OCR worker。同一种语言组合复用同一个实例，
 * 换语言时才销毁重建（重建代价很高，所以不要每次识别都建）。
 */
async function getWorker(langs, onProgress) {
  if (!langs) throw new Error('OCR 未指定语言');
  if (currentWorker && currentLangs === langs) return currentWorker;
  if (loadingPromise) return loadingPromise;

  const Tesseract = globalThis.Tesseract;
  if (!Tesseract) {
    throw new Error('OCR 引擎没有加载（sidepanel.html 里缺少 tesseract.min.js）');
  }

  loadingPromise = (async () => {
    if (currentWorker) {
      try {
        await currentWorker.terminate();
      } catch {
        /* 忽略 */
      }
      currentWorker = null;
      currentLangs = '';
    }
    const worker = await Tesseract.createWorker(langs, 1, {
      workerPath: ocrUrl('worker.min.js'),
      // 传目录：Tesseract 会自己在后面拼核心文件名
      corePath: ocrUrl(''),
      langPath: ocrUrl(''),
      // 【关键】Tesseract 默认会把 worker 脚本包成 blob: URL 再 new Worker()，
      // 而 MV3 的 CSP 不允许 blob: 作为 worker 源 —— 会报
      // "Failed to execute 'importScripts' on 'WorkerGlobalScope'"。
      // 关掉它，直接用 chrome-extension:// 下的真实地址。
      workerBlobURL: false,
      gzip: true,
      logger: (info) => {
        if (typeof onProgress === 'function') onProgress(info);
      }
    });
    currentWorker = worker;
    currentLangs = langs;
    return worker;
  })();

  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

/**
 * 识别一张图里的文字，并给出每一行的位置。
 *
 * @param {string} dataUrl  图片的 dataURL（content script 已经把跨域问题处理好了）
 * @param {{lang?: string, onProgress?: Function}} options
 * @returns {Promise<{text: string, lines: Array<{text: string, bbox: {x0:number,y0:number,x1:number,y1:number}, confidence: number}>}>}
 *          `lines[].bbox` 是**图片像素坐标**，调用方要按显示尺寸换算。
 */
/** 这段文字值不值得翻译（滤掉图形被误认成的零散符号） */
function isMeaningfulText(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // 必须含字母 / 汉字 / 假名
  const letters = t.match(/[A-Za-z\u4e00-\u9fff\u3040-\u30ff]/g);
  if (!letters || !letters.length) return false;
  // "ママ""aa""///" 这类重复符号，基本是轮廓
  if (t.length <= 3 && /^(.)\1+$/.test(t)) return false;
  return true;
}

/**
 * 把一行按「词间距」拆成若干独立段落。
 *
 * 为什么必须拆：Tesseract 的 line 是**外接矩形**。示意图里常有多个标签水平排在
 * 同一带上（比如「③ Moist air rises and cools」「Windward side」「Leeward side」），
 * Tesseract 会把它们并成一个 line —— 于是译文挤成一块、位置只取最左上角，
 * 看起来就是「译文到处乱放」。
 */
function splitLineByGaps(line) {
  const bbox = line.bbox || {};
  const fallback = () => [
    {
      text: String(line.text || '').replace(/\s+/g, ' ').trim(),
      bbox,
      confidence: Number(line.confidence) || 0
    }
  ];
  if (typeof bbox.x0 !== 'number') return [];

  const words = (line.words || []).filter(
    (w) => w && w.bbox && typeof w.bbox.x0 === 'number' && String(w.text || '').trim()
  );
  if (words.length <= 1) return fallback();

  const lineH = Math.max(1, (bbox.y1 || 0) - (bbox.y0 || 0));
  // 间距超过约 1.8 个字高就认为不是同一句话
  const gapLimit = Math.max(lineH * 1.8, 16);

  const groups = [];
  let cur = [words[0]];
  for (let i = 1; i < words.length; i += 1) {
    const prev = words[i - 1].bbox;
    const box = words[i].bbox;
    const gap = (box.x0 || 0) - (prev.x1 || 0);
    const dy = Math.abs((box.y0 || 0) - (prev.y0 || 0));
    if (gap > gapLimit || dy > lineH * 0.6) {
      groups.push(cur);
      cur = [words[i]];
    } else {
      cur.push(words[i]);
    }
  }
  groups.push(cur);

  return groups.map((g) => ({
    text: g
      .map((w) => String(w.text || '').trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
    bbox: {
      x0: Math.min(...g.map((w) => w.bbox.x0)),
      y0: Math.min(...g.map((w) => w.bbox.y0)),
      x1: Math.max(...g.map((w) => w.bbox.x1)),
      y1: Math.max(...g.map((w) => w.bbox.y1))
    },
    confidence: Math.min(...g.map((w) => Number(w.confidence) || 0))
  }));
}

export async function recognizeImage(dataUrl, { lang = 'eng+chi_sim+jpn', onProgress } = {}) {
  const worker = await getWorker(lang, onProgress);
  // 需要 words 才能按间距拆行
  const { data } = await worker.recognize(dataUrl, {}, { blocks: true, text: true });

  const lines = [];
  for (const line of data.lines || []) {
    for (const seg of splitLineByGaps(line)) {
      const text = String(seg.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (!(seg.confidence >= MIN_CONFIDENCE)) continue;
      if (!isMeaningfulText(text)) continue;
      const box = seg.bbox || {};
      if (typeof box.x0 !== 'number') continue;
      lines.push({ text, bbox: box, confidence: seg.confidence });
    }
  }

  // 按「从上到下、从左到右」排序，保证翻译序号稳定
  lines.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);

  return { text: String(data.text || '').trim(), lines };
}

/** 把若干行汉字/英文拼成适合翻译的段落（保持顺序，按行合并） */
export function buildOcrParagraphs(lines, { maxChars = 1200 } = {}) {
  const paragraphs = [];
  let buffer = [];
  let length = 0;
  for (const line of lines || []) {
    if (length + line.text.length > maxChars && buffer.length) {
      paragraphs.push(buffer.join('\n'));
      buffer = [];
      length = 0;
    }
    buffer.push(line.text);
    length += line.text.length + 1;
  }
  if (buffer.length) paragraphs.push(buffer.join('\n'));
  return paragraphs;
}

/** 释放 worker（侧边栏关闭或换语言时调用，避免占内存） */
export async function disposeOcr() {
  if (!currentWorker) return;
  try {
    await currentWorker.terminate();
  } catch {
    /* 忽略 */
  }
  currentWorker = null;
  currentLangs = '';
}

/** OCR 是否已经就绪（引擎脚本加载成功） */
export function isOcrAvailable() {
  return Boolean(globalThis.Tesseract);
}
