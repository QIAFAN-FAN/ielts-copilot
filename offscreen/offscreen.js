// offscreen 文档：后台跑本地 OCR
//
// 为什么放在这里：MV3 的 service worker 拿不到 DOM，也跑不了 WASM 版 Tesseract；
// 而内容脚本直接跑会被目标网页的 CSP 拦住。offscreen 文档是官方为此准备的——
// 它能用扩展自己的 CSP、能跑 WASM，而且不用打开侧边栏打扰用户。

import { recognizeImage, getLastOcrError, disposeOcr, isOcrAvailable } from '../lib/ocr.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;

  if (msg.type === 'ocr:ping') {
    sendResponse({ ok: true, ready: isOcrAvailable() });
    return false;
  }

  if (msg.type === 'ocr:recognize') {
    (async () => {
      try {
        const result = await recognizeImage(msg.dataUrl, {
          lang: msg.lang || 'eng+chi_sim',
          onProgress: (info) => {
            // 把进度转给页面，让用户知道"正在识别"，而不是干等
            try {
              chrome.runtime.sendMessage({
                target: 'progress',
                type: 'ocr:progress',
                jobId: msg.jobId,
                status: info?.status || '',
                progress: typeof info?.progress === 'number' ? info.progress : 0
              });
            } catch {
              /* 页面可能已经关了 */
            }
          }
        });
        sendResponse({ ok: true, ...result });
      } catch (err) {
        // 把 WASM 内部的真实错误也带上，否则用户只看到笼统的崩溃，
        // 我们也不知道到底是内存不足还是模型问题。
        const wasmErr = (() => {
          try { return getLastOcrError(); } catch { return ''; }
        })();
        const msgText = String(err?.message || err || '识别失败');
        sendResponse({
          ok: false,
          error: wasmErr && !msgText.includes(wasmErr) ? `${msgText}（内部：${wasmErr.slice(0, 120)}）` : msgText
        });
      }
    })();
    return true; // 异步响应
  }

  if (msg.type === 'ocr:dispose') {
    disposeOcr().then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: true })
    );
    return true;
  }

  return false;
});
