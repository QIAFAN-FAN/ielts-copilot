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
const MIN_CONFIDENCE = 30; // 置信度低于这个的行直接丢掉（通常是噪点或误识）

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
export async function recognizeImage(dataUrl, { lang = 'eng+chi_sim', onProgress } = {}) {
  const worker = await getWorker(lang, onProgress);
  const { data } = await worker.recognize(dataUrl);

  const lines = [];
  for (const line of data.lines || []) {
    const text = String(line.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const confidence = Number(line.confidence) || 0;
    if (confidence < MIN_CONFIDENCE) continue;
    const bbox = line.bbox || {};
    if (typeof bbox.x0 !== 'number') continue;
    lines.push({ text, bbox, confidence });
  }

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
