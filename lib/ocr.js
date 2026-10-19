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
// 置信度低于这个的段落丢掉。定 38 而不是更高：
// 示意图、截图上的字常常偏小或带背景，置信度天然偏低，
// 阈值定高了会出现「很多词根本没被翻译」。
const MIN_CONFIDENCE = 38;

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
    // 【关键】分页模式。默认的自动分页（PSM 3）是为整页文档设计的，
    // 遇到示意图/截图这种「稀疏分布的独立文字块」会漏掉大量文字，
    // 表现为「很多词汇没有翻译」。SPARSE_TEXT（11）正是为这种场景设计的。
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: '11',
        preserve_interword_spaces: '1',
          user_defined_dpi: '300'
      });
    } catch {
      /* 老版本可能不支持，忽略即可，不影响基本功能 */
    }
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

/**
 * 送进 OCR 之前先做预处理 —— 这是提升识别率最有效的一步。
 *
 * Tesseract 对字号极敏感：字高在 30~40px 时最准，字小了笔画糊在一起，
 * 识别率会断崖式下降。示意图/截图上的字常常只有 18~26px，
 * 所以先放大到合适尺寸，再做灰度和轻度对比度拉伸。
 *
 * 注意：**不做硬二值化**。Tesseract 自己会二值化，我们再二值一次
 * 容易把抗锯齿的细小笔画弄断，反而变差。
 *
 * @returns {{dataUrl:string, scale:number, width:number, height:number}}
 *          scale 用来把 OCR 给出的坐标换算回原图坐标系。
 */
async function preprocessForOcr(dataUrl) {
  const identity = { dataUrl, scale: 1, width: 0, height: 0 };
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const srcW = bitmap.width || 0;
    const srcH = bitmap.height || 0;
    if (!srcW || !srcH) return identity;

    // 目标宽度 1400 左右；最多放大 3 倍（再大只是变慢，准确率不再涨）
    let scale = 1;
    if (srcW < 1400) scale = Math.min(3, 1400 / srcW);
    if (scale < 1.08) scale = 1;

    const w = Math.round(srcW * scale);
    const h = Math.round(srcH * scale);

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    // 灰度 + 以 128 为中心拉伸对比度（1.3 倍），让深色笔画更实、浅底更白
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      let v = (g - 128) * 1.3 + 128;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);

    const outBlob = await canvas.convertToBlob({ type: 'image/png' });
    const outUrl = await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => resolve('');
      fr.readAsDataURL(outBlob);
    });
    if (!outUrl) return identity;
    return { dataUrl: outUrl, scale, width: w, height: h };
  } catch {
    // 预处理失败不影响主流程，直接拿原图识别
    return identity;
  }
}
/**
 * 把「同一段话被迫折行」的多行合并回一段。
 *
 * 场景：图上 `Windward` / `side` 分两行写，或者
 * `Moist air` / `rises and` / `cools` 分三行写。
 * Tesseract 会当成三条独立的 line，如果逐条翻译就会变成
 * 「迎风」「侧」「湿润空气」「上升和」「冷却」这种碎词。
 *
 * 合并条件（必须同时满足，避免把相邻的两个不同标签并掉）：
 *   ① 垂直间距很小（紧贴上一行下方，不超过 0.8 倍行高）
 *   ② 左边界接近（同一段的续行通常左对齐）
 *   ③ 字高相近（差不超过 35%）
 *   ④ 水平方向有足够重叠
 */
function mergeAdjacentLines(segments) {
  if (!segments || segments.length < 2) return segments || [];

  const sorted = [...segments].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const used = new Array(sorted.length).fill(false);
  const out = [];

  for (let i = 0; i < sorted.length; i += 1) {
    if (used[i]) continue;
    const cur = {
      text: sorted[i].text,
      bbox: { ...sorted[i].bbox },
      confidence: sorted[i].confidence,
      lineHeight: sorted[i].lineHeight || sorted[i].bbox.y1 - sorted[i].bbox.y0
    };
    used[i] = true;

    let merged = true;
    while (merged) {
      merged = false;
      for (let j = i + 1; j < sorted.length; j += 1) {
        if (used[j]) continue;
        const nb = sorted[j];
        const nbH = nb.lineHeight || nb.bbox.y1 - nb.bbox.y0;
        const curH = cur.lineHeight;

        // ① 垂直：紧贴在下方
        const gap = nb.bbox.y0 - cur.bbox.y1;
        if (gap < -curH * 0.3 || gap > Math.max(curH, 6) * 0.8) continue;

        // ② 左边界接近（续行通常左对齐）
        if (Math.abs(nb.bbox.x0 - cur.bbox.x0) > curH * 1.3) continue;

        // ③ 字高相近
        if (Math.abs(curH - nbH) > Math.max(curH, nbH) * 0.35) continue;

        // ④ 水平有重叠
        const overlap = Math.min(cur.bbox.x1, nb.bbox.x1) - Math.max(cur.bbox.x0, nb.bbox.x0);
        const minW = Math.min(cur.bbox.x1 - cur.bbox.x0, nb.bbox.x1 - nb.bbox.x0);
        if (minW > 0 && overlap < minW * 0.35) continue;

        // 合并：文字接上，外框取并集
        cur.text = `${cur.text} ${nb.text}`.replace(/\s+/g, ' ').trim();
        cur.bbox = {
          x0: Math.min(cur.bbox.x0, nb.bbox.x0),
          y0: Math.min(cur.bbox.y0, nb.bbox.y0),
          x1: Math.max(cur.bbox.x1, nb.bbox.x1),
          y1: Math.max(cur.bbox.y1, nb.bbox.y1)
        };
        cur.confidence = Math.min(cur.confidence, nb.confidence);
        used[j] = true;
        merged = true;
      }
    }
    out.push(cur);
  }

  return out;
}
export async function recognizeImage(dataUrl, { lang = 'eng+chi_sim+jpn', onProgress } = {}) {
  const worker = await getWorker(lang, onProgress);

  // 先放大到合适字高再识别（这是提升识别率最有效的一步）
  const pre = await preprocessForOcr(dataUrl);
  const inv = pre.scale && pre.scale > 0 ? 1 / pre.scale : 1;

  // ① 先用预处理图正式识别；rotateAuto 让它自己判断文字方向
  let data = null;
  try {
    const r = await worker.recognize(pre.dataUrl, { rotateAuto: true }, { blocks: true, text: true });
    data = r.data;
  } catch {
    const r = await worker.recognize(pre.dataUrl, {}, { blocks: true, text: true });
    data = r.data;
  }

  const collect = (raw, invert) => {
    const out = [];
    for (const line of raw?.lines || []) {
      for (const seg of splitLineByGaps(line)) {
        const text = String(seg.text || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (!(seg.confidence >= MIN_CONFIDENCE)) continue;
        if (!isMeaningfulText(text)) continue;
        const box = seg.bbox || {};
        if (typeof box.x0 !== 'number') continue;
        // 坐标从「预处理图」换算回「原图」，否则覆盖层会整体放大错位
        out.push({
          text,
          bbox: {
            x0: box.x0 * invert,
            y0: box.y0 * invert,
            x1: box.x1 * invert,
            y1: box.y1 * invert
          },
          confidence: seg.confidence,
          // 单行高：合并成多行后总高会变大，渲染算字号必须用单行高
          lineHeight: (box.y1 - box.y0) * invert
        });
      }
    }
    return out;
  };

  let lines = collect(data, inv);

  // ② 兜底：如果预处理图几乎没识别出东西（比如彩色背景被灰度拉糊了），
  //    再用原图试一次，谁的结果多就用谁。
  if (lines.length < 3 && pre.scale !== 1) {
    try {
      const r2 = await worker.recognize(dataUrl, {}, { blocks: true, text: true });
      const lines2 = collect(r2.data, 1);
      if (lines2.length > lines.length) lines = lines2;
    } catch {
      /* 忽略，用第一次的结果 */
    }
  }

  // 按「从上到下、从左到右」排序，保证翻译序号稳定
  lines.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);

  // 把「同一句被迫折行」的多行合并回一段，避免被拆成一个词一个词翻译
  const mergedLines = mergeAdjacentLines(lines);
  mergedLines.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);

  return { text: String(data?.text || '').trim(), lines: mergedLines, scale: pre.scale };
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
