// 划词气泡：鼠标划选英文 → 一键翻译 → 可送入侧边栏精讲
(() => {
  if (window.__IELTS_COPILOT_LOADED__) return;
  window.__IELTS_COPILOT_LOADED__ = true;

  const MAX_SELECTION = 4000;
  const MAX_PAGE_TEXT = 40000;

  let settings = {
    bubbleEnabled: true,
    autoTranslate: false,
    bubbleOpacity: 1,
    copyFormat: 'zh',
    imageHoverButton: true
  };
  let host = null;
  let shadow = null;
  let chip = null;
  let bubble = null;
  let lastSelection = '';
  let lastRect = null;

  /* ---------------- 设置 ---------------- */

  function loadSettings() {
    try {
      chrome.storage.local.get('settings', (raw) => {
        if (chrome.runtime.lastError) return;
        const s = raw?.settings || {};
        settings.bubbleEnabled = s.bubbleEnabled !== false;
        settings.autoTranslate = s.autoTranslate === true;
        settings.bubbleOpacity = s.bubbleOpacity === undefined ? 1 : Number(s.bubbleOpacity);
        settings.copyFormat = ['zh', 'en', 'both'].includes(s.copyFormat) ? s.copyFormat : 'zh';
        settings.imageHoverButton = s.imageHoverButton !== false;
        applyOpacity();
        if (!settings.bubbleEnabled) hideAll();
      });
    } catch {
      /* 扩展上下文失效（重载后旧页面）时忽略 */
    }
  }

  /**
   * 把透明度应用到气泡和小圆点。
   * 用 CSS 变量写在 host 上 —— 自定义属性会继承进 shadow DOM，所以里面的元素能直接用。
   * 鼠标悬停时由样式表恢复成不透明，避免"调太低了自己也看不清"。
   */
  function applyOpacity() {
    if (!host) return; // host 还没建，等 ensureHost 时再应用
    const raw = Number(settings.bubbleOpacity);
    const value = Number.isFinite(raw) ? Math.min(1, Math.max(0.15, raw)) : 1;
    host.style.setProperty('--ielts-opacity', String(value));
  }

  loadSettings();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) loadSettings();
    });
  } catch {
    /* ignore */
  }

  /* ---------------- 取词 ---------------- */

  function getSelectedText() {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (typeof start === 'number' && typeof end === 'number' && end > start) {
        return active.value.slice(start, end);
      }
      return '';
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return '';
    return sel.toString();
  }

  function getSelectionRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return rect;
  }

  function getContextText(text) {
    // 输入框 / 可编辑区域里的选区拿不到 range，但输入框里已有的内容本身就是最好的上下文
    const active = document.activeElement;
    if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) {
      const value = String(active.value || active.innerText || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (value && value !== text.replace(/\s+/g, ' ').trim()) return value.slice(0, 1200);
      const placeholder = String(active.getAttribute?.('placeholder') || '').trim();
      if (placeholder) return placeholder.slice(0, 300);
    }

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return '';
    const node = sel.getRangeAt(0).startContainer;
    const parent = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const container = parent?.closest('p, li, td, div, article, section') || parent;
    const raw = (container?.innerText || '').replace(/\s+/g, ' ').trim();
    if (!raw || raw === text.replace(/\s+/g, ' ').trim()) return '';
    return raw.slice(0, 1200);
  }

  /* ---------------- UI ---------------- */

  /** 是否运行在内嵌框架里：iframe 中的气泡只能画在这个小区域内，需要给用户一句提示 */
  const inFrame = (() => {
    try {
      return window.top !== window.self;
    } catch {
      return true; // 跨域 iframe 读 top 会抛错，说明确实在框架里
    }
  })();

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .chip, .bubble { position: fixed; z-index: 2147483647; }
    /* 透明度可调（设置页「气泡透明度」）：变量由 host 上的 --ielts-opacity 决定，默认 1 */
    .chip, .bubble { opacity: var(--ielts-opacity, 1); transition: opacity .18s ease; }
    /* 鼠标移上去恢复不透明，免得调太低之后自己也看不清 */
    .chip:hover, .bubble:hover { opacity: 1; }
    .chip {
      display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; padding: 0; border-radius: 50%; cursor: pointer;
      background: #1a73e8; color: #fff; font-size: 13px; font-weight: 700; line-height: 1;
      box-shadow: 0 2px 8px rgba(0,0,0,.24); border: none; user-select: none;
    }
    .chip:hover { background: #1765cc; }
    .bubble {
      width: 380px; max-width: calc(100vw - 24px);
      background: #fff; color: #202124; border-radius: 12px;
      box-shadow: 0 10px 32px rgba(0,0,0,.22); border: 1px solid #e3e6eb;
      overflow: hidden; font-size: 14px; line-height: 1.6;
    }
    .head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 10px 8px 12px; background: #f7f9fc; border-bottom: 1px solid #eceff4;
      cursor: grab; user-select: none; touch-action: none;
    }
    .bubble.dragging .head { cursor: grabbing; }
    .mini.pin { display: inline-flex; align-items: center; padding: 3px 5px; border-radius: 6px; }
    .mini.pin svg { display: block; fill: #5f6368; }
    .mini.pin:hover svg { fill: #1a73e8; }
    .mini.pin.active { background: #eaf1fd; }
    .mini.pin.active svg { fill: #1a73e8; }
    .bubble.pinned { border-color: #1a73e8; box-shadow: 0 10px 32px rgba(26,115,232,.3); }
    .badge { font-size: 12px; font-weight: 700; color: #1a73e8; letter-spacing: .3px; }
    .head-actions { display: flex; align-items: center; gap: 6px; }
    .frame-tip { font-size: 11px; color: #b26a00; background: #fff7e6; border: 1px solid #ffe0a3; border-radius: 999px; padding: 1px 6px; cursor: help; }
    .mini { border: none; background: transparent; color: #5f6368; font-size: 13px; cursor: pointer; padding: 2px 4px; }
    .mini:hover { color: #1a73e8; }
    .body { padding: 12px; max-height: 340px; overflow-y: auto; }
    .body::-webkit-scrollbar { width: 8px; }
    .body::-webkit-scrollbar-thumb { background: #d7dbe2; border-radius: 4px; }
    .translation { font-size: 15px; font-weight: 600; color: #1f2430; white-space: pre-wrap; }
    .translation-row { display: flex; align-items: flex-start; gap: 6px; }
    .translation-row .translation { flex: 1; min-width: 0; }
    .copy-one { flex: none; opacity: .45; font-size: 13px; padding: 0 2px; line-height: 1.6; }
    .copy-one:hover { opacity: 1; }
    .key { margin-top: 8px; color: #4d5566; font-size: 13px; }
    .vocab { margin: 10px 0 0; padding: 0; list-style: none; }
    .vocab li { display: flex; gap: 8px; font-size: 13px; padding: 3px 0; border-top: 1px dashed #eef1f5; }
    .vocab b { color: #1a73e8; font-weight: 600; }
    .vocab .term { margin-left: auto; opacity: .55; font-size: 13px; padding: 0 2px; }
    .vocab .term:hover { opacity: 1; }

    /* 图片翻译：图上的「图译」小按钮 */
    .img-chip {
      position: fixed; z-index: 2147483647;
      padding: 3px 9px; border: none; border-radius: 999px;
      background: #1a73e8; color: #fff; font-size: 12px; font-weight: 700;
      cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.24);
      opacity: var(--ielts-opacity, 1); transition: opacity .18s ease;
    }
    .img-chip:hover { background: #1765cc; opacity: 1; }

    /* 图片翻译：覆盖在图片上的译文层 */
    .ocr-overlay {
      z-index: 2147483646; cursor: pointer;
      background: rgba(255,255,255,.06);
    }
    .ocr-line {
      position: absolute; overflow: hidden; white-space: nowrap;
      text-overflow: ellipsis; padding: 0 3px; box-sizing: border-box;
      background: rgba(255,255,255,.94); color: #1f2430;
      border-radius: 3px; font-weight: 500;
    }
    .ocr-close {
      position: absolute; right: -8px; top: -10px;
      width: 20px; height: 20px; border-radius: 50%; border: none;
      background: #202124; color: #fff; font-size: 11px; line-height: 1;
      cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,.3);
    }
    .status { color: #5f6368; font-size: 13px; }
    .error { color: #c5221f; font-size: 13px; }
    .retry {
      margin-top: 8px; font-size: 12.5px; color: #5f6368;
      display: flex; align-items: center; gap: 4px;
    }
    .retry .mini { color: #1a73e8; font-weight: 700; text-decoration: underline; }
    .meta-row {
      margin-top: 10px; padding-top: 8px; border-top: 1px dashed #eef1f5;
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    }
    .tag {
      font-size: 11px; font-weight: 700; color: #1a73e8;
      background: #eaf1fd; border-radius: 999px; padding: 1px 7px;
    }
    .note { font-size: 11.5px; color: #8b93a1; }
    .foot { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #eceff4; background: #fafbfd; }
    .btn {
      flex: 1; padding: 7px 10px; border-radius: 8px; cursor: pointer; font-size: 13px;
      border: 1px solid #d7dbe2; background: #fff; color: #3c4257; font-weight: 600;
    }
    .btn:hover { border-color: #1a73e8; color: #1a73e8; }
    .btn.primary { background: #1a73e8; border-color: #1a73e8; color: #fff; }
    .btn.primary:hover { background: #1765cc; color: #fff; }
    .toast {
      position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%);
      background: #202124; color: #fff; padding: 10px 16px; border-radius: 8px;
      font-size: 13px; z-index: 2147483647; box-shadow: 0 6px 20px rgba(0,0,0,.3);
    }
  `;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.style.cssText = 'all: initial;';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);
    (document.body || document.documentElement).appendChild(host);
    applyOpacity(); // host 刚建好，把用户设的透明度补上
  }

  function hideChip() {
    if (chip && chip.isConnected) chip.remove();
    chip = null;
  }

  function hideBubble() {
    if (bubble && bubble.isConnected) bubble.remove();
    bubble = null;
  }

  /**
   * 气泡还"活着"吗？
   *
   * 划词用久了按钮不出来，主要就是这个：页面重渲染（Vue/React 这类站点会清空 body 再建）
   * 会把我们的 host 从 DOM 里摘掉，但 `bubble` 变量还指着那个已经不在页面上的元素。
   * 于是 handleSelection 里 `if (bubble) return`（"气泡已经开着，不打断"）永远成立，
   * 后续划词既不弹气泡、也不弹小圆点 —— 看起来就是"按钮再也不出来了"。
   * 这里顺手把悬空引用清掉，让下一次划词能正常走。
   */
  function bubbleAlive() {
    if (bubble && !bubble.isConnected) {
      bubble = null;
      pinned = false; // 气泡都没了，固定状态也就没意义了
    }
    return Boolean(bubble);
  }

  function hideAll() {
    hideChip();
    hideBubble();
  }

  /* ---------------- 气泡位置与「固定」 ---------------- */

  const POS_KEY = 'bubblePos';
  const PIN_KEY = 'bubblePinned';
  let pinned = false;
  let bubblePos = null;
  let dragging = null;

  function loadBubbleState() {
    try {
      chrome.storage.local.get([POS_KEY, PIN_KEY], (raw) => {
        if (chrome.runtime.lastError) return;
        const pos = raw?.[POS_KEY];
        if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') bubblePos = pos;
        pinned = raw?.[PIN_KEY] === true;
      });
    } catch {
      /* 忽略 */
    }
  }

  function saveBubbleState() {
    try {
      chrome.storage.local.set({ [POS_KEY]: bubblePos, [PIN_KEY]: pinned });
    } catch {
      /* 忽略 */
    }
  }

  function togglePin() {
    pinned = !pinned;
    saveBubbleState();
    if (bubble) {
      bubble.classList.toggle('pinned', pinned);
      bubble.querySelector('[data-act="pin"]')?.classList.toggle('active', pinned);
    }
    toast(
      pinned
        ? '已固定：接下来划选别的句子会直接翻译到这个框里（再点图钉取消）'
        : '已取消固定'
    );
  }

  /** 拖头部即可移动气泡（位置会记住，下次沿用） */
  function makeDraggable(el) {
    const handle = el.querySelector('[data-role="drag-handle"]');
    if (!handle) return;

    handle.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      const rect = el.getBoundingClientRect();
      dragging = {
        el,
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* 忽略 */
      }
      el.classList.add('dragging');
      event.preventDefault();
    });

    handle.addEventListener('pointermove', (event) => {
      if (!dragging || dragging.el !== el || event.pointerId !== dragging.pointerId) return;
      const maxLeft = Math.max(4, window.innerWidth - el.offsetWidth - 4);
      const maxTop = Math.max(4, window.innerHeight - 48);
      const left = Math.max(4, Math.min(event.clientX - dragging.offsetX, maxLeft));
      const top = Math.max(4, Math.min(event.clientY - dragging.offsetY, maxTop));
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
      bubblePos = { left: Math.round(left), top: Math.round(top) };
    });

    const finish = (event) => {
      if (!dragging || dragging.el !== el) return;
      try {
        handle.releasePointerCapture(dragging.pointerId);
      } catch {
        /* 忽略 */
      }
      dragging = null;
      el.classList.remove('dragging');
      if (bubblePos) saveBubbleState();
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  // 注意：必须在上面的 let pinned / bubblePos 声明之后再调用，否则会命中暂时性死区
  loadBubbleState();

  function positionAt(el, rect, { below = true } = {}) {
    const width = el.offsetWidth || 120;
    const height = el.offsetHeight || 30;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = below ? rect.bottom + 8 : rect.top - height - 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 8);
    if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - height - 8);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function showChip(rect) {
    ensureHost();
    hideChip();
    chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = '译';
    chip.addEventListener('mousedown', (e) => e.preventDefault());
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      hideChip();
      translateSelection();
    });
    shadow.appendChild(chip);
    positionAt(chip, rect);
  }

  function showBubble(rect) {
    ensureHost();
    hideChip();
    hideBubble();
    bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = `
      <div class="head" data-role="drag-handle">
        <span class="badge">雅思助手</span>
        <div class="head-actions">
          ${
            inFrame
              ? '<span class="frame-tip" title="这段内容在网页的内嵌框架（iframe）里，气泡只能显示在这个小区域内，可能会被裁掉。可以改用侧边栏，或在新标签页里打开原文。">⧉ 框架内</span>'
              : ''
          }
          <button class="mini pin" data-act="pin" title="固定在这里：固定后再划别的句子会直接翻译到这个框里">
            <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="5"></circle><rect x="11" y="12" width="2" height="9" rx="1"></rect></svg>
          </button>
          <button class="mini" data-act="settings" title="打开设置">设置</button>
          <button class="mini" data-act="close" title="关闭">✕</button>
        </div>
      </div>
      <div class="body"><div class="status">正在翻译…</div></div>
      <div class="foot">
        <button class="btn primary" data-act="explain">深入精讲</button>
        <button class="btn" data-act="copy">复制译文</button>
      </div>
    `;
    bubble.addEventListener('mousedown', (e) => {
      if (e.target.tagName !== 'INPUT') e.stopPropagation();
    });
    bubble.addEventListener('click', (e) => {
      // 必须用 closest 而不是 e.target：固定按钮里是 <svg>，点下去 e.target 常常是里面的
      // <circle>/<rect>，直接读 e.target.dataset.act 拿到的是 undefined → 点了没反应。
      const hit = e.target?.closest?.('[data-act]');
      const act = hit?.dataset?.act;
      if (!act) return;
      e.stopPropagation();
      if (act === 'close') hideAll();
      if (act === 'copy') copyText();
      if (act === 'copy-one') copyText(buildCopyText(bubble?.querySelector('.translation')?.textContent));
      if (act === 'explain') sendToPanel('explain');
      if (act === 'settings') openOptions();
      if (act === 'pin') togglePin();
      if (act === 'pin-term') pinTerm(hit.dataset.en, hit.dataset.zh);
    });
    shadow.appendChild(bubble);
    if (bubblePos) {
      bubble.style.left = `${bubblePos.left}px`;
      bubble.style.top = `${bubblePos.top}px`;
    } else {
      positionAt(bubble, rect);
    }
    if (pinned) {
      bubble.classList.add('pinned');
      bubble.querySelector('[data-act="pin"]')?.classList.add('active');
    }
    makeDraggable(bubble);
    return bubble.querySelector('.body');
  }

  /** 收藏为术语：以后这段文字里的这个词会被要求按指定译名翻译 */
  async function pinTerm(en, zh) {
    const word = String(en || '').trim();
    const meaning = String(zh || '').trim();
    if (!word || !meaning) {
      toast('这个条目没有可收藏的释义');
      return;
    }
    const res = await sendMessage({ type: 'glossary', action: 'add', en: word, zh: meaning });
    toast(res?.ok ? `已收藏术语：${word} → ${meaning}` : `收藏失败：${res?.error || '未知错误'}`);
  }

  /**
   * 按设置里选的格式拼出要复制的内容。
   * zh=只要中文译文，en=只要英文原文，both=英文原文 + 换行 + 中文译文。
   */
  function buildCopyText(translation) {
    const en = String(lastSelection || '').trim();
    const zh = String(translation || '').trim();
    const format = settings.copyFormat || 'zh';
    if (format === 'en') return en || zh;
    if (format === 'both') return en && zh ? `${en}\n${zh}` : en || zh;
    return zh || en;
  }

  /** 不传参数时复制当前气泡里的译文（底部「复制译文」按钮用） */
  function copyText(value) {
    const text = String(value ?? bubble?.querySelector('.translation')?.textContent ?? '').trim();
    if (!text) {
      toast('没有可复制的内容');
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => toast('已复制'),
      () => toast('复制失败，请手动选择')
    );
  }

  function openOptions() {
    // 内容脚本里直接调 chrome.runtime.openOptionsPage() 不一定生效，交给后台页面打开更稳
    try {
      chrome.runtime.sendMessage({ type: 'openOptions' }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      /* ignore */
    }
  }

  function toast(message) {
    ensureHost();
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    shadow.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  /* ---------------- 与后台通信 ---------------- */

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: '扩展已更新，请刷新本页面后重试。' });
            return;
          }
          resolve(response || { ok: false, error: '没有收到响应' });
        });
      } catch {
        resolve({ ok: false, error: '扩展已更新，请刷新本页面后重试。' });
      }
    });
  }

  /** 记住这次划选（用户点侧边栏时页面选区会被清掉，靠它兜底） */
  function rememberSelection(text) {
    try {
      chrome.runtime.sendMessage({ type: 'rememberSelection', text, url: location.href }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      /* 忽略 */
    }
  }

  let rememberTimer = null;

  /** 连续划选时不必每一笔都发消息，稍等一下合并成一次 */
  function rememberSelectionDebounced(text) {
    clearTimeout(rememberTimer);
    rememberTimer = setTimeout(() => rememberSelection(text), 250);
  }

  /**
   * 划词序号：只认最新一次划词的结果。
   * 连续划 A、B 两句时，如果 A 的请求慢一点回来，它会盖掉 B 的译文 ——
   * 用户看到的是「我明明划的是 B，框里却是 A 的翻译」。用序号把旧结果直接丢掉。
   */
  let requestToken = 0;

  async function translateSelection({ forceAi = false, token = 0 } = {}) {
    const text = (getSelectedText() || lastSelection || '').trim();
    if (!text) {
      toast('没有取到文字，请重新划选一次');
      return;
    }
    const clipped = text.slice(0, MAX_SELECTION);
    const truncated = text.length > MAX_SELECTION;
    rememberSelection(clipped);

    const rect = lastRect || getSelectionRect() || { left: 40, top: 40, bottom: 40, width: 0, height: 0 };
    const myToken = token || (requestToken += 1);
    // 气泡可能已经被页面重渲染摘掉（SPA 清空 body），这时 showBubble 会重新建一个，
    // 否则译文会写进一个用户看不见的 DOM，气泡永远停在「AI 精译中…」。
    const body = bubbleAlive() ? bubble.querySelector('.body') : showBubble(rect);
    body.innerHTML = `<div class="status">${forceAi ? '正在用 AI 精译…' : '正在翻译…'}</div>`;

    const res = await sendMessage({
      type: 'translate',
      text: clipped,
      contextText: getContextText(clipped),
      forceAi,
      // 第一次请求只要离线结果（几乎瞬间），值得再调 AI 时后台会回 needAi，由下面自动补一发
      preferOffline: !forceAi
    });

    // 已经划了更新的内容 / 气泡被关掉了 → 这次结果是过期的，丢掉
    if (myToken !== requestToken) return;
    if (!bubble || !bubble.isConnected) return;
    const live = bubble.querySelector('.body');
    if (!live) return;

    if (!res.ok) {
      live.innerHTML = renderError(res);
      return;
    }

    const data = res.data || {};
    const notes = [];
    if (truncated) {
      notes.push(
        `<div class="status">内容较长，只翻译了前 ${MAX_SELECTION} 字（原文共 ${text.length} 字）。</div>`
      );
    }

    // 离线直译已经够看 → 直接显示；不够看 → 先显示直译，再自动补一发 AI 精译
    if (data.needAi && !data.exact) {
      notes.push('<div class="status" data-role="ai-pending">AI 精译中…</div>');
      live.innerHTML = renderTranslation(data) + notes.join('');
      translateSelection({ forceAi: true, token: myToken });
      return;
    }

    live.innerHTML = renderTranslation(data) + notes.join('');
    const retry = live.querySelector('[data-act="ai"]');
    if (retry) {
      retry.addEventListener('click', (event) => {
        event.stopPropagation();
        translateSelection({ forceAi: true, token: myToken });
      });
    }
  }

  /** 渲染翻译结果：区分「词表精确释义」和「离线直译」 */
  function renderTranslation(data) {
    const translation = data.translation || '';
    const engine = data.engine || 'local';
    const quality = data.quality || 'exact';
    const coverage = typeof data.coverage === 'number' ? data.coverage : 1;
    const vocab = Array.isArray(data.vocab) ? data.vocab : [];
    const isGloss = quality !== 'exact';

    const engineLabel =
      engine === 'ai' ? 'AI 翻译' : engine === 'cache' ? 'AI 翻译（缓存命中）' : '离线词表';

    const notes = [];
    if (isGloss) notes.push('离线直译，仅供看大意');
    if (data.degraded === 'NO_API_KEY') notes.push('未配置 API Key，只能离线直译');
    else if (data.degraded) notes.push('AI 调用失败，已用离线结果兜底');
    if (isGloss && coverage < 0.999) notes.push(`词表覆盖 ${Math.round(coverage * 100)}%`);

    const aiHint =
      isGloss && engine !== 'ai'
        ? '<div class="retry">离线直译不太准？<button class="mini" data-act="ai">AI 精译</button></div>'
        : '';

    return `
      <div class="translation-row">
        <div class="translation">${escapeHtml(translation)}</div>
        <button class="mini copy-one" data-act="copy-one" title="复制（复制内容可在设置里选：中文 / 英文 / 英+中）">📋</button>
      </div>
      ${data.key ? `<div class="key">${escapeHtml(data.key)}</div>` : ''}
      ${
        vocab.length
          ? `<ul class="vocab">${vocab
              .slice(0, 5)
              .map(
                (v) =>
                  `<li><b>${escapeHtml(v.en || '')}</b><span>${escapeHtml(v.zh || '')}</span>` +
                  `<button class="mini term" data-act="pin-term" data-en="${escapeHtml(v.en || '')}" data-zh="${escapeHtml(v.zh || '')}" title="收藏为术语：以后翻译这句话里的这个词都按这个译名">📌</button></li>`
              )
              .join('')}</ul>`
          : ''
      }
      ${aiHint}
      <div class="meta-row">
        <span class="tag">${escapeHtml(engineLabel)}</span>
        ${notes.length ? `<span class="note">${escapeHtml(notes.join('；'))}</span>` : ''}
      </div>
    `;
  }

  async function sendToPanel(mode) {
    const text = (getSelectedText() || lastSelection || '').trim();
    if (!text) {
      toast('请先划选一段文字');
      return;
    }
    const payload = {
      mode,
      text: text.slice(0, MAX_SELECTION),
      pageText: '',
      pageTitle: document.title || '',
      pageUrl: location.href,
      origin: 'bubble'
    };
    const res = await sendMessage({ type: 'openPanel', payload });
    if (!res.ok) {
      toast(res.error === 'NO_API_KEY' ? '请先在设置里填写 DeepSeek API Key' : res.error || '打开失败');
      return;
    }
    if (res.data?.opened) {
      hideAll();
    } else {
      toast('内容已送入侧边栏，请点击工具栏的「雅思助手」图标查看。');
    }
  }

  function renderError(res) {
    if (res.error === 'NO_API_KEY') {
      return '<div class="error">还没有配置 DeepSeek API Key。点击右上角「设置」填写后再试。</div>';
    }
    return `<div class="error">${escapeHtml(res.error || '请求失败')}</div>`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* ---------------- 事件绑定 ---------------- */

  function handleSelection(event) {
    if (!settings.bubbleEnabled) return;
    if (host && event.composedPath && event.composedPath().includes(host)) return;

    setTimeout(() => {
      const text = (getSelectedText() || '').trim();
      if (!text || text.length < 2) {
        if (!bubble) hideChip();
        return;
      }
      // 纯中文也允许：内置词表支持中译英，别把这个入口关掉。
      // 只有既没英文也没中文（纯数字 / 符号）才不弹气泡。
      if (!/[A-Za-z]/.test(text) && !/[\u4e00-\u9fa5]/.test(text)) {
        if (!bubble) hideChip();
        return;
      }
      lastSelection = text;
      rememberSelectionDebounced(text);
      lastRect = getSelectionRect();
      if (!lastRect) {
        // 在 <input> / <textarea> 里划选时 window.getSelection 拿不到位置，
        // 退回用输入框自身的位置来放气泡
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
          lastRect = active.getBoundingClientRect();
        }
      }
      if (!lastRect) {
        // 还是拿不到位置（跨 shadow DOM、折叠区域、程序化选中等）就用视口中上部兜底。
        // 以前这里直接 return，表现为"划了词什么都不弹"，很难判断是失效了还是没识别到。
        lastRect = { left: window.innerWidth / 2 - 12, top: 140, bottom: 164, width: 24, height: 24 };
      }
      if (bubbleAlive() && pinned) {
        // 钉住气泡时：划选新内容直接翻到这个框里
        translateSelection();
        return;
      }
      if (bubbleAlive()) return; // 气泡已经开着，不打断
      if (settings.autoTranslate) translateSelection();
      else showChip(lastRect);
    }, 10);
  }

  document.addEventListener('mouseup', handleSelection, true);
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' || e.key.startsWith('Arrow')) handleSelection(e);
  }, true);

  document.addEventListener('mousedown', (event) => {
    if (host && event.composedPath && event.composedPath().includes(host)) return;
    if (pinned) {
      hideChip(); // 固定状态下保留气泡，只收掉小圆点
      return;
    }
    // 双击 / 三击选词时，第二下 mousedown 落在选区上，不能当成「点了空白处」，
    // 否则小圆点刚出现就被收掉 —— 表现就是"按钮闪一下就没了"。
    const selection = window.getSelection?.();
    if (selection && selection.rangeCount && !selection.isCollapsed) {
      try {
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        const inside =
          event.clientX >= rect.left - 8 &&
          event.clientX <= rect.right + 8 &&
          event.clientY >= rect.top - 8 &&
          event.clientY <= rect.bottom + 8;
        if (inside) return;
      } catch {
        /* 选区取不到范围就当没点中 */
      }
    }
    hideAll();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (pinned) {
      pinned = false;
      saveBubbleState();
    }
    hideAll();
  }, true);

  // 鼠标移到图片上 → 右上角出「图译」小按钮（可在设置里关掉这个按钮，改用右键菜单）
  //
  // 这里必须非常小心，否则按钮会闪：
  // 鼠标从图片移到按钮上时，mouseover 的目标变成按钮（不再是 img），
  // 如果此时判定"不是图片就隐藏"，按钮会被删掉；按钮一消失鼠标又落回图片上，
  // 又会重新建出来 —— 无限循环，而且按钮在闪烁中不断被重建，点击事件会丢失。
  // 所以：显示/隐藏都做延时，且鼠标在自己的浮层里时不动它。
  let imgChipHideTimer = null;
  let imgChipShowTimer = null;
  let imgChipTargetImg = null;

  function clearImgChipHideTimer() {
    if (imgChipHideTimer) {
      clearTimeout(imgChipHideTimer);
      imgChipHideTimer = null;
    }
  }

  function clearImgChipShowTimer() {
    if (imgChipShowTimer) {
      clearTimeout(imgChipShowTimer);
      imgChipShowTimer = null;
    }
  }

  /** 延时隐藏：给用户时间从图片移到按钮上 */
  function scheduleHideImgChip(delay = 300) {
    clearImgChipShowTimer();
    clearImgChipHideTimer();
    imgChipHideTimer = setTimeout(() => {
      imgChipHideTimer = null;
      // 鼠标已经停在按钮上就别收
      if (imgChip && imgChip.isConnected && imgChip.matches(':hover')) return;
      imgChipTargetImg = null;
      hideImgChip();
    }, delay);
  }

  /** 延时显示：扫过图片时不会闪出一个按钮 */
  function scheduleShowImgChip(img, delay = 220) {
    clearImgChipHideTimer();
    if (imgChip && imgChip.isConnected && imgChipTargetImg === img) return; // 已经在显示这张图
    clearImgChipShowTimer();
    imgChipShowTimer = setTimeout(() => {
      imgChipShowTimer = null;
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      imgChipTargetImg = img;
      showImgChip(img, rect);
    }, delay);
  }

  document.addEventListener(
    'mouseover',
    (event) => {
      // 鼠标进入我们自己的浮层（含「图译」按钮）→ 取消隐藏，绝不动它
      if (host && event.composedPath && event.composedPath().includes(host)) {
        clearImgChipHideTimer();
        return;
      }
      if (!settings.bubbleEnabled || !settings.imageHoverButton) return;

      const img = event.target?.closest?.('img, canvas');
      if (!img) return; // 移到非图片：不立即隐藏，交给 mouseout 的延时逻辑

      const rect = img.getBoundingClientRect();
      // 图标、装饰小图不值得翻
      if (rect.width < IMG_MIN_W || rect.height < IMG_MIN_H) return;
      if (rect.bottom < 0 || rect.top > window.innerHeight) return;
      scheduleShowImgChip(img);
    },
    true
  );

  document.addEventListener(
    'mouseout',
    (event) => {
      // 从按钮移出：延时隐藏；如果又回到图片上，上面的 mouseover 会取消这个计时
      if (host && event.composedPath && event.composedPath().includes(host)) {
        scheduleHideImgChip(200);
        return;
      }
      const img = event.target?.closest?.('img, canvas');
      if (!img) return;
      // 同一张图内部的冒泡（子元素之间移动）不处理，避免误收
      if (event.relatedTarget && img.contains(event.relatedTarget)) return;
      scheduleHideImgChip(300);
    },
    true
  );

  // 气泡画在屏幕坐标上（position: fixed），页面一滚动它就跟原文错位、甚至挡住内容。
  // 所以未「固定」的气泡随页面滚动关闭；用户主动固定（📌）的保留。
  let lastScrollY = window.scrollY;

  function onPageScroll(event) {
    // capture 阶段能收到所有元素上的 scroll。气泡自己滚动看长译文时不该把气泡关掉，
    // 所以这里把气泡内部的滚动排除掉。
    if (host && event?.target && event.target !== document && host.contains(event.target)) return;

    hideImgChip(); // 图片小按钮固定在屏幕坐标上，滚动后位置会错，直接收掉

    // 划词时页面常有几像素的抖动（触控板惯性、浏览器把选区滚进视野、SPA 布局微调），
    // 以前任何一点滚动都会收掉小圆点，表现就是"按钮闪一下就没了"。小幅滚动直接忽略。
    const moved = Math.abs(window.scrollY - lastScrollY);
    lastScrollY = window.scrollY;
    if (moved < 24) return;

    hideChip();
    if (bubble && !pinned) hideBubble();
  }

  window.addEventListener('scroll', onPageScroll, { passive: true, capture: true });

  /* ---------------- 图片翻译 ---------------- */

  const IMG_MIN_W = 90; // 太小的图标不值得翻
  const IMG_MIN_H = 60;

  let imgChip = null;
  let imgOverlay = null;
  let imgBusy = false;
  let lastImageFetchError = '';

  function hideImgChip() {
    if (imgChip && imgChip.isConnected) imgChip.remove();
    imgChip = null;
  }

  /** 在图片右上角放一个「图译」小按钮 */
  function showImgChip(img, rect) {
    ensureHost();
    hideImgChip();
    imgChip = document.createElement('button');
    imgChip.className = 'img-chip';
    imgChip.textContent = '图译';
    imgChip.title = '翻译这张图里的文字（本地识别，识别本身不花 API 费用）';
    imgChip.addEventListener('mousedown', (e) => e.preventDefault());
    imgChip.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      hideImgChip();
      translateImage(img, rect);
    });
    shadow.appendChild(imgChip);
    imgChip.style.cssText =
      `position:fixed;left:${Math.round(rect.left + rect.width - 48)}px;` +
      `top:${Math.round(rect.top + 6)}px;`;
  }

  /**
   * 把页面上的图片转成 dataURL。
   *
   * 按「成功率高 → 低」排，最后一级是截屏兜底 —— 只要这张图在屏幕上显示着，
   * 就一定能拿到像素，不会再出现「取不到」。
   *
   *   ① data: 直接就有
   *   ② 同源 canvas
   *   ③ 带 crossOrigin 重新加载一次（有些 CDN 允许匿名跨域，原页面没开而已）
   *   ④ blob: 在页面内读
   *   ⑤ 交给后台按 URL 抓（有 host 权限，不受页面 CORS 限制）
   *   ⑥ 截当前可见区域再裁出这张图（兜底，必成）
   */
  async function imageToDataUrl(img) {
    const isCanvas = img.tagName === 'CANVAS';
    const raw = isCanvas ? '' : img.currentSrc || img.src || '';

    if (raw.startsWith('data:')) return raw;

    // ② 本地 canvas（同源可行，也省一次网络）
    try {
      const canvas = document.createElement('canvas');
      const w = isCanvas ? img.width : img.naturalWidth || img.width;
      const h = isCanvas ? img.height : img.naturalHeight || img.height;
      if (w && h) {
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const url = canvas.toDataURL('image/png');
        // 跨域被污染时 toDataURL 会抛错，走不到这里
        if (url && url.length > 200) return url;
      }
    } catch {
      /* 跨域污染：继续往下兜底 */
    }
    if (isCanvas) {
      // canvas 抓不到（极罕见）就直接截屏裁
      const shot = await captureRegionAsDataUrl(img);
      return shot || '';
    }

    // ③ 带 crossOrigin 重新加载 —— 很多图床/CDN 其实允许匿名跨域，
    //    只是页面上那张 img 没加 crossOrigin 属性，导致 canvas 被污染
    if (/^https?:/i.test(raw)) {
      const cors = await reloadWithCors(raw);
      if (cors) return cors;
    }

    // ④ blob: 图片（前端生成的图，题库站很常见）——在页面里能直接读到
    if (raw.startsWith('blob:')) {
      try {
        const res = await fetch(raw);
        const blob = await res.blob();
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => resolve('');
          reader.readAsDataURL(blob);
        });
      } catch {
        /* 读不到就继续往下 */
      }
    }

    // ⑤ http(s)：内容脚本受页面 CORS 限制，交给后台带权限去抓
    if (/^https?:/i.test(raw)) {
      const res = await sendMessage({ type: 'fetchImage', url: raw });
      if (res?.ok && res.data?.dataUrl) return res.data.dataUrl;
      lastImageFetchError = res?.error || '';
    }

    // ⑥ 兜底：截屏裁剪。图片只要显示在屏幕上就一定能拿到，
    //    不管它有没有防盗链、URL 是否过期、是不是 blob。
    const shot = await captureRegionAsDataUrl(img);
    if (shot) {
      lastImageFetchError = '';
      return shot;
    }
    return '';
  }

  /** 带 crossOrigin 重新加载一张图，成功返回 dataURL（失败返回空串，8 秒超时） */
  function reloadWithCors(src) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      try {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => {
          try {
            const c = document.createElement('canvas');
            c.width = im.naturalWidth || im.width;
            c.height = im.naturalHeight || im.height;
            if (!c.width || !c.height) return finish('');
            c.getContext('2d').drawImage(im, 0, 0);
            const url = c.toDataURL('image/png');
            finish(url && url.length > 200 ? url : '');
          } catch {
            finish('');
          }
        };
        im.onerror = () => finish('');
        setTimeout(() => finish(''), 3000);
        im.src = src;
      } catch {
        finish('');
      }
    });
  }

  /**
   * 截取屏幕上这张图所在的区域并裁出来（真正的兜底，几乎不会失败）。
   * 用 captureVisibleTab 拿整屏，再用 canvas 按元素位置裁。
   */
  async function captureRegionAsDataUrl(img) {
    try {
      const rect = img.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const left = Math.max(0, Math.floor(rect.left * dpr));
      const top = Math.max(0, Math.floor(rect.top * dpr));
      const width = Math.floor(rect.width * dpr);
      const height = Math.floor(rect.height * dpr);
      if (width < 8 || height < 8) return '';

      const res = await sendMessage({ type: 'captureRegion' });
      const shot = res?.data?.dataUrl;
      if (!shot) return '';

      const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
      // 浏览器截图可能带缩放，按实际尺寸比例换算
      const scaleX = bitmap.width / (window.innerWidth * dpr);
      const scaleY = bitmap.height / (window.innerHeight * dpr);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas
        .getContext('2d')
        .drawImage(
          bitmap,
          Math.round(left * scaleX),
          Math.round(top * scaleY),
          Math.round(width * scaleX),
          Math.round(height * scaleY),
          0,
          0,
          width,
          height
        );
      const url = canvas.toDataURL('image/png');
      return url && url.length > 200 ? url : '';
    } catch {
      return '';
    }
  }

  /** 量出这张 dataURL 的实际像素尺寸（OCR 的 bbox 就是相对它的） */
  async function measureDataUrl(dataUrl) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return size;
    } catch {
      return null;
    }
  }
  /** 把译文按原坐标覆盖回图片上；点遮罩或右上角 ✕ 收起 */
  function renderImageOverlay(img, lines, rect, sourceSize) {
    removeImageOverlay();
    ensureHost();
    const overlay = document.createElement('div');
    overlay.className = 'ocr-overlay';

    // 用页面坐标（absolute），图片跟着页面滚动时覆盖层也一起走
    overlay.style.cssText =
      `position:absolute;left:${rect.left + window.scrollX}px;` +
      `top:${rect.top + window.scrollY}px;` +
      `width:${rect.width}px;height:${rect.height}px;`;

    // ★ 关键：坐标基准必须是「真正送进 OCR 的那张图」的像素尺寸，
    // 而不是 img.naturalWidth —— 走截屏兜底时送进去的是显示尺寸的裁剪图，
    // 用原图像素做基准会让整张译文按错误比例缩放、位置全偏。
    const naturalW = (sourceSize && sourceSize.width) || (img && (img.naturalWidth || img.width)) || rect.width;
    const naturalH = (sourceSize && sourceSize.height) || (img && (img.naturalHeight || img.height)) || rect.height;
    const scaleX = rect.width / (naturalW || rect.width);
    const scaleY = rect.height / (naturalH || rect.height);

    // 用一个离屏 canvas 量字宽，用来自适应字号
    const measure = document.createElement('canvas').getContext('2d');
    const FONT = '600 __SIZE__px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    const textWidth = (text, size) => {
      measure.font = FONT.replace('__SIZE__', String(size));
      return measure.measureText(text).width;
    };

    let painted = 0;
    for (const line of lines || []) {
      const zh = String(line?.translated || '').trim();
      if (!zh) continue;
      const box = line.bbox || {};
      if (typeof box.x0 !== 'number') continue;

      // 原文这一行的位置（相对覆盖层）
      const rawLeft = Math.max(0, box.x0 * scaleX);
      const rawTop = Math.max(0, box.y0 * scaleY);
      const rawW = Math.max(4, (box.x1 - box.x0) * scaleX);
      const rawH = Math.max(4, (box.y1 - box.y0) * scaleY);

      // ① 判断竖排：必须「又窄又高」才算。
      //    别把两行文字的标签（如 Windward / side）误判成竖排 ——
      //    那种 bbox 也是高大于宽，但它其实是横排的两行。
      const isVertical = rawH > rawW * 1.6 && rawW <= Math.max(34, rawH * 0.32) && rawH >= 24;

      // ② 位置严格贴合原文 bbox：用户要「覆盖哪里就翻译在哪里」，
      //    所以不为了塞下字而挪动位置。
      let boxLeft = rawLeft;
      let boxTop = rawTop;
      let boxW = rawW;
      let boxH = rawH;

      const minFont = 8;

      // ③ 字号严格跟随原文字高（不设 30px 上限 —— 那会让小字被放大成大字）。
      //    下限 8px 只为还能看见；放不下时靠横向压缩，绝不靠放大字号。
      let fontSize;
      if (isVertical) {
        // 竖排：一个字的宽度决定字号
        fontSize = Math.max(minFont, boxW * 0.92);
      } else {
        fontSize = Math.max(minFont, boxH * 0.86);
      }

      // ④ 白块只需要包住译文自身
      const need = textWidth(zh, fontSize);
      if (isVertical) {
        // 竖排：宽度约等于一个字宽，高度按文字长度
        boxW = Math.max(fontSize * 1.1, Math.min(boxW, fontSize * 1.3));
        boxH = Math.min(Math.ceil(need) + 4, rect.height - boxTop);
      } else {
        boxW = Math.min(Math.ceil(need) + 6, rect.width - boxLeft);
      }

      // ⑤ 收尾：不越界
      if (boxLeft < 0) boxLeft = 0;
      if (boxTop < 0) boxTop = 0;
      if (boxW < 4) boxW = 4;
      if (boxH < 4) boxH = 4;
      if (boxLeft + boxW > rect.width) boxW = Math.max(4, rect.width - boxLeft);
      if (boxTop + boxH > rect.height) boxH = Math.max(4, rect.height - boxTop);

      // ⑥ 真的放不下就轻微压缩（不放大字号、不挪位置）
      let squeeze = 1;
      const limit = isVertical ? boxH - 2 : boxW - 2;
      if (need > limit && limit > 0) {
        squeeze = Math.max(0.62, limit / need);
      }
      const item = document.createElement('div');
      item.className = 'ocr-line';
      item.style.cssText =
        `position:absolute;left:${boxLeft}px;top:${boxTop}px;` +
        `width:${boxW}px;height:${boxH}px;` +
        `font-size:${fontSize}px;` +
        (isVertical
          ? `writing-mode:vertical-rl;text-orientation:upright;` +
            `display:block;line-height:${boxW}px;text-align:center;`
          : `display:flex;align-items:center;justify-content:flex-start;`) +
        `overflow:hidden;white-space:nowrap;` +
        (squeeze < 1
          ? isVertical
            ? `transform:scaleY(${squeeze.toFixed(3)});transform-origin:center top;`
            : `transform:scaleX(${squeeze.toFixed(3)});transform-origin:left center;`
          : '');
      item.textContent = zh;
      item.title = `${zh}\n（原文：${String(line.text || '').trim()}）`;
      overlay.appendChild(item);
      painted += 1;
    }

    if (!painted) {
      toast('识别出了文字，但翻译没成功 —— 可以再点一次');
      return;
    }

    const close = document.createElement('button');
    close.className = 'ocr-close';
    close.textContent = '✕';
    close.title = '收起译文';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      removeImageOverlay();
    });
    overlay.appendChild(close);

    overlay.addEventListener('click', (e) => {
      if (e.target === close) return;
      removeImageOverlay();
    });

    shadow.appendChild(overlay);
    imgOverlay = overlay;
    toast(`已翻译 ${painted} 行，点一下遮罩即可收起`);
  }

  function removeImageOverlay() {
    // 只删变量指向的那个是不够的：变量一旦被别处清空、DOM 里的旧覆盖层就永远留着，
    // 于是上一张图的译文会叠到下一张图上。这里按 DOM 实际存在的节点清。
    if (shadow) {
      for (const el of shadow.querySelectorAll('.ocr-overlay')) el.remove();
    }
    if (imgOverlay && imgOverlay.isConnected) imgOverlay.remove();
    imgOverlay = null;
    // 页面里可能残留多个 host（ensureHost 重建过），把它们的覆盖层也一起清掉
    for (const node of document.querySelectorAll('div')) {
      if (!node.shadowRoot || node === host) continue;
      for (const el of node.shadowRoot.querySelectorAll('.ocr-overlay')) el.remove();
    }
  }

  /** 翻译一张图片：取图 → 后台 OCR + 翻译 → 覆盖回原位 */
  async function translateImage(img, rect) {
    if (imgBusy) {
      toast('上一张还在识别，稍等一下');
      return;
    }
    imgBusy = true;
    lastImageFetchError = '';
    try {
      const dataUrl = await imageToDataUrl(img);
      if (!dataUrl) {
        // 到这一步说明连截屏兜底都失败了（图片太小/不在可视区），
        // 把原因讲清楚，并且只提真正存在的办法
        const reason = lastImageFetchError ? `（${lastImageFetchError}）` : '';
        toast(
          `取不到这张图的像素${reason}。请让这张图完整显示在屏幕上，再点一次「图译」；` +
            '或者先把图片另存到本地，用设置页下方的「上传图片」翻译。'
        );
        return;
      }
      await runImageTranslation(img, rect, dataUrl, await measureDataUrl(dataUrl));
    } finally {
      imgBusy = false;
    }
  }

  /**
   * 翻译「当前这一屏」：不管页面上是什么（图片、canvas、甚至是 PDF/视频里的画面），
   * 直接截图识别。右键菜单「翻译这一屏」走这条路。
   */
  async function translateCapture() {
    if (imgBusy) {
      toast('上一张还在识别，稍等一下');
      return;
    }
    imgBusy = true;
    try {
      const res0 = await sendMessage({ type: 'captureRegion' });
      const shot = res0?.data?.dataUrl;
      if (!shot) {
        toast(res0?.error || '截屏失败，可能是当前页面不允许截取');
        return;
      }
      // 只用屏幕可见区域，坐标用视口坐标
      const rect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      await runImageTranslation(null, rect, shot, await measureDataUrl(shot));
    } catch (err) {
      toast(`翻译这一屏失败：${String(err?.message || err)}`);
    } finally {
      imgBusy = false;
    }
  }

  /** 拿到 dataUrl 之后共用的一段：OCR + 翻译 + 覆盖回原位 */
  async function runImageTranslation(img, rect, dataUrl, sourceSize) {
    toast('正在识别图片文字…（首次要加载本地 OCR 模型，会慢一点）');
    const res = await sendMessage({
      type: 'translateImage',
      dataUrl,
      jobId: `img-${Date.now()}`
    });
    if (!res?.ok) {
      toast(res?.error || '图片翻译失败');
      return;
    }
    renderImageOverlay(img, res.data?.lines || [], rect, sourceSize);
  }

  /* ---------------- 响应后台请求 ---------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'translateCapture') {
      // 右键菜单「翻译这一屏」进来的：整屏截图识别
      translateCapture();
      sendResponse({ ok: true });
      return false;
    }

    if (msg?.type === 'translateImageByUrl') {
      // 右键菜单进来的：找到页面上的那张图，走同一套翻译流程
      const url = String(msg.url || '');
      const candidates = Array.from(document.querySelectorAll('img, canvas'));
      const img =
        candidates.find((el) => el.currentSrc === url || el.src === url) ||
        candidates.find((el) => {
          const src = el.currentSrc || el.src || '';
          if (!src || !url) return false;
          // 有些站点给图片加了缩放参数，用文件名兜底匹配
          const name = (s) => s.split('?')[0].split('/').pop();
          return name(src) && name(src) === name(url);
        });
      if (!img) {
        toast('没找到地应那张图片，可能它已经不在页面上了');
        sendResponse({ ok: false });
        return false;
      }
      const rect = img.getBoundingClientRect();
      translateImage(img, rect);
      sendResponse({ ok: true });
      return false;
    }

    if (msg?.type === 'toast') {
      toast(msg.message || '');
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'extractPageText') {
      sendResponse({ ok: true, text: extractPageText(), title: document.title, url: location.href });
      return false;
    }
    if (msg?.type === 'extractPageBlocks') {
      sendResponse({ ok: true, blocks: extractPageBlocks(), title: document.title, url: location.href });
      return false;
    }
    if (msg?.type === 'getSelectionText') {
      sendResponse({ ok: true, text: (getSelectedText() || lastSelection || '').trim() });
      return false;
    }
    if (msg?.type === 'extractPageImages') {
      // 里面要把 blob: 转成 dataURL，所以是异步响应
      extractPageImages()
        .then((result) => sendResponse({ ok: true, images: result.images, stats: result.stats }))
        .catch(() => sendResponse({ ok: true, images: [], stats: {} }));
      return true;
    }
    return false;
  });

  /* ---------------- 正文提取 ---------------- */

  /* ---------------- 文本提取（保留表格结构） ---------------- */

  /**
   * 在离屏容器里读 innerText。
   * 脱离文档的元素 innerText 不可靠（会退化成 textContent、丢失换行），
   * 所以先临时挂到一个不可见容器里再读，读完立刻移除。
   */
  function renderText(node) {
    const holder = document.createElement('div');
    holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText =
      'position:fixed;left:-100000px;top:0;width:1200px;visibility:hidden;pointer-events:none;';
    holder.appendChild(node);
    (document.body || document.documentElement).appendChild(holder);
    try {
      return node.innerText || node.textContent || '';
    } finally {
      holder.remove();
    }
  }

  /**
   * 表格 → 保留行列结构的文本：单元格之间用 ` | ` 分隔，单元格里的输入框标成 `[空]`。
   * 雅思听力题大量使用表格（Complete the table below），展平成一堆碎片后模型就看不懂了。
   */
  function tableToText(table) {
    const rows = [];
    for (const tr of table.querySelectorAll('tr')) {
      const cells = [];
      for (const cell of tr.querySelectorAll('th, td')) {
        let text = (cell.innerText || '').replace(/\s+/g, ' ').trim();
        // 读输入框「已经填了什么」：机考刷题时页面上往往已经填了答案，
        // 只标 [空] 的话模型看到的还是空白，没法帮你对答案。
        const fields = Array.from(cell.querySelectorAll('input, select, textarea'));
        if (fields.length) {
          const marks = fields
            .map((el) => {
              const value = String(el.value || el.getAttribute('value') || '').replace(/\s+/g, ' ').trim();
              if (value) return value;
              const placeholder = String(el.getAttribute('placeholder') || '').trim();
              return placeholder ? `[空:${placeholder}]` : '[空]';
            })
            .join(' ');
          text = text ? `${text} ${marks}` : marks;
        }
        cells.push(text);
      }
      const line = cells.join(' | ').trim();
      if (line.replace(/[|\s]/g, '')) rows.push(line);
    }
    return rows.join('\n');
  }

  /** 读节点的可读文本；含表格时做结构保留，没有表格就直接读 innerText（省开销） */
  function readableText(node) {
    const tables = node.querySelectorAll('table');
    if (!tables.length) return (node.innerText || '').trim();

    const texts = Array.from(tables).map(tableToText); // 必须在活 DOM 上读
    const clone = node.cloneNode(true);
    let index = 0;
    clone.querySelectorAll('table').forEach((table) => {
      const replacement = document.createElement('p');
      replacement.textContent = `\n${texts[index] || ''}\n`;
      index += 1;
      table.replaceWith(replacement);
    });
    return (renderText(clone) || '').trim();
  }

  function extractPageText() {
    const source = document.body || document.documentElement;
    if (!source) return '';
    const clone = source.cloneNode(true);

    // 先把表格换成保留行列结构的文本（顺序与活 DOM 一致）
    const tableTexts = Array.from(source.querySelectorAll('table')).map(tableToText);
    let tableIndex = 0;
    clone.querySelectorAll('table').forEach((table) => {
      const replacement = document.createElement('p');
      replacement.textContent = `\n${tableTexts[tableIndex] || ''}\n`;
      tableIndex += 1;
      table.replaceWith(replacement);
    });

    clone
      .querySelectorAll(
        'script, style, noscript, svg, iframe, nav, footer, header, aside, [aria-hidden="true"], [role="navigation"], [role="banner"], .advertisement, .ad, .ads'
      )
      .forEach((node) => node.remove());
    let text = renderText(clone);
    text = text
      .replace(/\u00a0/g, ' ')
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .filter((line, index, arr) => line || arr[index - 1])
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text.length > MAX_PAGE_TEXT) {
      text = text.slice(0, MAX_PAGE_TEXT) + '\n\n[内容过长，已截断]';
    }
    return text;
  }

  /* ---------------- 版面分块：识别「原文」和「题目」 ---------------- */

  const BLOCK_MIN_CHARS = 80;
  const BLOCK_LIMIT = 5;
  const BLOCK_MAX_CHARS = 20000;
  const SCAN_LIMIT = 4000;
  const COLUMN_MIN_CHARS = 200;

  /** 题目区特征打分：命中越多越像题 */
  function scoreQuestions(text) {
    let score = 0;
    if (/questions?\s*\d+\s*[-–—]\s*\d+/i.test(text)) score += 3;
    if (/questions?\s*\d+\s*[:.]/i.test(text)) score += 2;
    if (/\btrue\b[\s\S]{0,40}\bfalse\b/i.test(text)) score += 3;
    if (/not given/i.test(text)) score += 3;
    if (/choose\s+(the\s+)?(correct\s+)?(one\s+)?(word|words|letter|letters|option|answer|phrase|heading)/i.test(text)) score += 2;
    if (/complete the (table|notes|summary|sentences|form|diagram)/i.test(text)) score += 2;
    if (/label the (diagram|map|plan)/i.test(text)) score += 2;
    if (/\b(labelling|labeling)\b/i.test(text)) score += 2;
    if (/write your answers/i.test(text)) score += 1;
    if (/write (no more than|one word|the correct)/i.test(text)) score += 2;
    // 听力常见题型与指令（多选 / 配对 / 地图 / 流程图）
    if (/choose\s+(two|three|four)\s+(letters?|answers?|words?)/i.test(text)) score += 2;
    if (/\bwhich\s+(two|three)\b/i.test(text)) score += 2;
    if (/\bmatch(ing)?\b[\s\S]{0,40}\b(with|to|each|the)\b/i.test(text)) score += 2;
    if (/complete\s+the\s+flow[\s-]?chart/i.test(text)) score += 2;
    if (/from\s+the\s+(list|box)\s+of\s+(options|words|phrases)/i.test(text)) score += 2;
    if (/\b(listening|section\s*[1-4]|audio|recording)\b/i.test(text)) score += 1;
    if (/\bA\s*,\s*B\s+(or\s+)?C\b/.test(text)) score += 1;
    if (/\bA\s*[-–]\s*[E-J]\b/.test(text)) score += 1;
    if (/_{3,}/.test(text)) score += 1;

    const numbered = (text.match(/(?:^|\n)\s*\d{1,2}[.)]\s+\S/g) || []).length;
    if (numbered >= 3) score += 2;
    else if (numbered >= 1) score += 1;

    const options = (text.match(/(?:^|\n)\s*[A-D][.)]\s+\S/g) || []).length;
    if (options >= 3) score += 2;
    else if (options >= 1) score += 1;

    return score;
  }

  /** 原文特征打分 */
  function scoreArticles(text) {
    let score = 0;
    if (/reading passage\s*\d*/i.test(text)) score += 3;
    if (/\bpassage\s*[1-3]\b/i.test(text)) score += 2;
    if (/you should spend about/i.test(text)) score += 2;
    if (/\(\s*20 minutes\s*\)/i.test(text)) score += 1;

    const lines = text.split('\n').filter((line) => line.trim());
    const longLines = lines.filter((line) => line.trim().length > 100).length;
    const avg = lines.length ? text.length / lines.length : 0;
    if (longLines >= 5) score += 3;
    else if (longLines >= 3) score += 2;
    else if (longLines >= 1) score += 1;
    if (avg > 70) score += 1;
    return score;
  }

  function classifyBlock(text, inputCount) {
    const q = scoreQuestions(text) + (inputCount >= 3 ? 3 : 0);
    const a = scoreArticles(text);
    let role = 'unknown';
    if (q >= 2 && q > a) role = 'questions';
    else if (a >= 2 && a >= q) role = 'article';
    else if (q > a && q >= 1) role = 'questions';
    else if (a > q && a >= 1) role = 'article';
    return { role, q, a };
  }

  function sideOfRect(rect, viewportWidth) {
    const center = rect.left + rect.width / 2;
    if (center < viewportWidth * 0.45) return 'left';
    if (center > viewportWidth * 0.55) return 'right';
    return 'full';
  }

  /**
   * 找页面上的「左右两栏」主容器 —— 雅思在线题库基本都是这种布局：
   * 左边是 Reading Passage 原文，右边是 Questions 题目。
   * 定位到两栏后就直接采用，比通用分块可靠得多。
   */
  function detectColumns() {
    const vw = window.innerWidth || document.documentElement.clientWidth || 1200;
    const vh = window.innerHeight || 800;
    const mid = vw / 2;
    const found = [];
    let scanned = 0;

    for (const node of document.querySelectorAll('div, section, article, main, td, aside')) {
      scanned += 1;
      if (scanned > SCAN_LIMIT) break;
      if (host && (node === host || node.contains(host))) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < vw * 0.25 || rect.width > vw * 0.75) continue; // 栏宽要合理
      if (rect.height < vh * 0.3) continue; // 要够高，排除小卡片
      if (rect.width * rect.height < vw * vh * 0.12) continue; // 面积要够大
      const text = (node.innerText || '').trim();
      if (text.length < COLUMN_MIN_CHARS) continue;
      // 机考形态的题库（如 idictation、ieltscb）题目区里有大量输入框，这是极强的「题目」信号
      const inputCount = node.querySelectorAll('input, select, textarea').length;
      found.push({ rect, text, inputCount });
    }
    if (found.length < 2) return null;

    const leftSide = found.filter((item) => item.rect.left + item.rect.width / 2 < mid);
    const rightSide = found.filter((item) => item.rect.left + item.rect.width / 2 >= mid);
    if (!leftSide.length || !rightSide.length) return null;

    const biggest = (list) => list.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    const left = biggest(leftSide);
    const right = biggest(rightSide);

    // 两边内容互相包含（父子容器 / 嵌套布局）说明没分干净，放弃两栏、退回通用分块；
    // 否则同一段内容会被当成「原文」和「题目」各来一份，字数翻倍。
    const normLeft = left.text.replace(/\s+/g, '');
    const normRight = right.text.replace(/\s+/g, '');
    if (!normLeft || !normRight) return null;
    if (normLeft === normRight || normLeft.includes(normRight) || normRight.includes(normLeft)) {
      return null;
    }

    const scoreSide = (item) => ({
      q: scoreQuestions(item.text) + (item.inputCount >= 3 ? 4 : 0),
      a: scoreArticles(item.text)
    });
    const leftScore = scoreSide(left);
    const rightScore = scoreSide(right);

    // 默认「左原文、右题目」；只有右边明显更像文章时才交换
    let passage = left;
    let questions = right;
    if (rightScore.a > rightScore.q + 2 && leftScore.q > leftScore.a) {
      passage = right;
      questions = left;
    }
    return { passage, questions };
  }

  function extractPageBlocks() {
    const root = document.body;
    if (!root) return [];

    const vw = window.innerWidth || document.documentElement.clientWidth || 1200;
    const buildBlock = (item, role) => ({
      role,
      side: sideOfRect(item.rect, vw),
      questionScore: scoreQuestions(item.text),
      articleScore: scoreArticles(item.text),
      length: item.text.length,
      preview: item.text.replace(/\s+/g, ' ').slice(0, 160),
      top: Math.round(item.rect.top + window.scrollY),
      left: Math.round(item.rect.left),
      text:
        item.text.length > BLOCK_MAX_CHARS
          ? item.text.slice(0, BLOCK_MAX_CHARS) + '\n[区块过长，已截断]'
          : item.text
    });

    // ① 优先按「左右两栏」定向提取 —— 雅思在线题库基本都是左原文、右题目
    const columns = detectColumns();
    if (columns) {
      return [buildBlock(columns.passage, 'article'), buildBlock(columns.questions, 'questions')];
    }

    // ② 没有明显的两栏结构，退化为通用分块
    let scanned = 0;
    const candidates = [];
    for (const node of root.querySelectorAll('div, section, article, main, td, li')) {
      scanned += 1;
      if (scanned > SCAN_LIMIT) break;
      if (host && (node === host || node.contains(host))) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 150 || rect.height < 60) continue;
      if (rect.width * rect.height < 20000) continue;
      if ((node.textContent || '').trim().length < BLOCK_MIN_CHARS) continue;
      const text = readableText(node); // 含表格时保留行列结构
      if (text.length < BLOCK_MIN_CHARS) continue;
      const inputs = node.querySelectorAll('input, select, textarea').length;
      candidates.push({ text, rect, inputs });
    }
    if (!candidates.length) return [];

    // 只保留「最小包含块」：把包住别的小块的父容器淘汰掉
    candidates.sort((a, b) => a.text.length - b.text.length);
    const minimal = [];
    for (const candidate of candidates) {
      const prefix = candidate.text.slice(0, 200);
      if (minimal.some((picked) => picked.text.includes(prefix))) continue;
      minimal.push(candidate);
    }

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1200;
    const enriched = minimal.map((item) => {
      const { role, q, a } = classifyBlock(item.text, item.inputs);
      const rect = item.rect;
      const center = rect.left + rect.width / 2;
      const side = center < viewportWidth * 0.45 ? 'left' : center > viewportWidth * 0.55 ? 'right' : 'full';
      return {
        role,
        side,
        questionScore: q,
        articleScore: a,
        length: item.text.length,
        preview: item.text.replace(/\s+/g, ' ').slice(0, 160),
        top: Math.round(rect.top + window.scrollY),
        left: Math.round(rect.left),
        text:
          item.text.length > BLOCK_MAX_CHARS
            ? item.text.slice(0, BLOCK_MAX_CHARS) + '\n[区块过长，已截断]'
            : item.text
      };
    });

    // 按版面顺序排（上→下、左→右）
    enriched.sort((x, y) => Math.round(x.top / 60) - Math.round(y.top / 60) || x.left - y.left);

    // 挑选时先保证「题目」「原文」各留下最像的，再按体量补足，避免题目块被大文章挤掉
    const picked = [];
    const takeBy = (role, key, limit) => {
      enriched
        .filter((block) => block.role === role)
        .sort((x, y) => y[key] - x[key] || y.length - x.length)
        .slice(0, limit)
        .forEach((block) => {
          if (!picked.includes(block)) picked.push(block);
        });
    };
    takeBy('questions', 'questionScore', 2);
    takeBy('article', 'articleScore', 2);
    enriched
      .filter((block) => !picked.includes(block))
      .sort((x, y) => y.length - x.length)
      .slice(0, Math.max(0, BLOCK_LIMIT - picked.length))
      .forEach((block) => picked.push(block));

    return picked.sort((x, y) => Math.round(x.top / 60) - Math.round(y.top / 60) || x.left - y.left);
  }

  /* ---------------- 页面图片（小作文 Task 1 的图表） ---------------- */

  /** 把 blob: 地址读成 dataURL（页面内的 blob URL 在扩展页面里取不到，必须在这里转） */
  function blobUrlToDataUrl(url) {
    return new Promise((resolve) => {
      try {
        fetch(url)
          .then((resp) => resp.blob())
          .then((blob) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => resolve('');
            reader.readAsDataURL(blob);
          })
          .catch(() => resolve(''));
      } catch {
        resolve('');
      }
    });
  }

  /**
   * 抓页面上「看起来是图表/照片」的图片。覆盖四种常见形态：
   * ① <img>（含懒加载的 data-src / data-original / data-lazy-src）
   * ② CSS 背景图（很多题库用 div + background-image 显示图表）
   * ③ <canvas>（前端绘制的图表）
   * ④ blob: 地址（前端生成的图，需要转成 dataURL 才能给模型）
   */
  async function extractPageImages() {
    const MIN_W = 120;
    const MIN_H = 80;
    const found = [];
    const stats = { img: 0, background: 0, canvas: 0, frames: 1 };

    const push = (src, rect, extra = {}) => {
      if (!src || !/^(https?:|data:|blob:)/.test(src)) return;
      if (found.some((item) => item.src === src)) return;
      found.push({
        src,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        area: Math.round(rect.width * rect.height),
        ...extra
      });
    };

    // ① <img>
    let scanned = 0;
    for (const img of document.querySelectorAll('img')) {
      scanned += 1;
      if (scanned > 1500) break;
      if (host && host.contains(img)) continue;
      stats.img += 1;
      const rect = img.getBoundingClientRect();
      if (rect.width < MIN_W || rect.height < MIN_H) continue;
      const src =
        img.currentSrc ||
        img.src ||
        img.getAttribute('data-src') ||
        img.getAttribute('data-original') ||
        img.getAttribute('data-lazy-src') ||
        '';
      push(src, rect, { alt: (img.alt || '').slice(0, 60) });
    }

    // ② CSS 背景图（先按尺寸筛，避免对几千个元素都算一次样式）
    scanned = 0;
    for (const el of document.querySelectorAll('div, section, article, figure, td, span, a')) {
      scanned += 1;
      if (scanned > 3000) break;
      if (host && host.contains(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < MIN_W || rect.height < MIN_H) continue;
      if (rect.width * rect.height < 20000) continue;
      let bg = '';
      try {
        bg = window.getComputedStyle(el).backgroundImage || '';
      } catch {
        continue;
      }
      if (!bg || bg === 'none' || !bg.includes('url(')) continue;
      const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (!match) continue;
      stats.background += 1;
      push(match[1], rect, { alt: '页面背景图' });
    }

    // ③ <canvas>
    for (const canvas of document.querySelectorAll('canvas')) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < MIN_W || rect.height < MIN_H) continue;
      stats.canvas += 1;
      try {
        const dataUrl = canvas.toDataURL('image/png');
        if (/^data:image\//.test(dataUrl) && dataUrl.length > 200) {
          push(dataUrl, rect, { alt: '页面图表（canvas）' });
        }
      } catch {
        /* 跨域画布会抛错，忽略 */
      }
    }

    // ④ blob: → dataURL
    for (const item of found) {
      if (/^blob:/.test(item.src)) {
        const dataUrl = await blobUrlToDataUrl(item.src);
        if (dataUrl) item.dataUrl = dataUrl;
      }
    }

    const images = found.sort((a, b) => b.area - a.area).slice(0, 4);
    return { images, stats: { ...stats, total: found.length, picked: images.length } };
  }

  // 暴露给 background 的 executeScript，跨 frame 抓取正文时复用同一套清理逻辑
  try {
    window.__IELTS_EXTRACT__ = extractPageText;
    window.__IELTS_BLOCKS__ = extractPageBlocks;
    window.__IELTS_CLASSIFY__ = classifyBlock; // 便于自检 / 调试
    window.__IELTS_TABLE__ = tableToText; // 便于自检 / 调试
    window.__IELTS_IMAGES__ = extractPageImages; // 便于自检 / 调试
  } catch {
    /* 个别页面环境下不可写，忽略 */
  }
})();
