// 设置页逻辑
import { getSettings, saveSettings, DEFAULTS } from '../lib/store.js';
import { chatCompletion } from '../lib/deepseek.js';
import {
  listGlossary,
  addTerm,
  removeTerm,
  resetDisabled,
  PRESET,
  listLearned,
  listCandidates,
  removeLearned,
  clearLearned,
  promoteCandidate
} from '../lib/glossary.js';
import { clearTranslationCache, translationCacheSize } from '../lib/translate.js';
import { applyI18nToDocument } from '../lib/i18n.js';

const els = {
  language: document.getElementById('language'),
  apiKey: document.getElementById('apiKey'),
  toggleKey: document.getElementById('toggleKey'),
  baseUrl: document.getElementById('baseUrl'),
  model: document.getElementById('model'),
  temperature: document.getElementById('temperature'),
  temperatureValue: document.getElementById('temperatureValue'),
  targetBand: document.getElementById('targetBand'),
  explainLang: document.getElementById('explainLang'),
  translateEngine: document.getElementById('translateEngine'),
  manualExamSource: document.getElementById('manualExamSource'),
  smartSplit: document.getElementById('smartSplit'),
  bubbleEnabled: document.getElementById('bubbleEnabled'),
  bubbleOpacity: document.getElementById('bubbleOpacity'),
  bubbleOpacityValue: document.getElementById('bubbleOpacityValue'),
  copyFormat: document.getElementById('copyFormat'),
  autoTranslate: document.getElementById('autoTranslate'),
  stream: document.getElementById('stream'),
  webSearch: document.getElementById('webSearch'),
  webSearchEngine: document.getElementById('webSearchEngine'),
  maxTokens: document.getElementById('maxTokens'),
  test: document.getElementById('test'),
  testStatus: document.getElementById('testStatus'),
  termEn: document.getElementById('termEn'),
  termZh: document.getElementById('termZh'),
  termAdd: document.getElementById('termAdd'),
  termStatus: document.getElementById('termStatus'),
  termReset: document.getElementById('termReset'),
  termSearch: document.getElementById('termSearch'),
  termCount: document.getElementById('termCount'),
  termList: document.getElementById('termList'),
  termBulk: document.getElementById('termBulk'),
  termImport: document.getElementById('termImport'),
  termBulkStatus: document.getElementById('termBulkStatus'),
  learnClear: document.getElementById('learnClear'),
  cacheClear: document.getElementById('cacheClear'),
  learnStatus: document.getElementById('learnStatus'),
  learnSearch: document.getElementById('learnSearch'),
  learnCount: document.getElementById('learnCount'),
  learnList: document.getElementById('learnList'),
  candList: document.getElementById('candList'),
  save: document.getElementById('save'),
  saveStatus: document.getElementById('saveStatus')
};

let settings = { ...DEFAULTS };

function setSaveStatus(text, kind = '') {
  els.saveStatus.textContent = text || '';
  els.saveStatus.className = `status ${kind}`.trim();
}

function setTestStatus(text, kind = '') {
  els.testStatus.textContent = text || '';
  els.testStatus.className = `status ${kind}`.trim();
}

function fillUI(value) {
  els.apiKey.value = value.apiKey || '';
  els.baseUrl.value = value.baseUrl || DEFAULTS.baseUrl;
  els.model.value = value.model || DEFAULTS.model;
  els.temperature.value = String(value.temperature ?? DEFAULTS.temperature);
  els.temperatureValue.textContent = Number(els.temperature.value).toFixed(1);
  els.targetBand.value = String(value.targetBand ?? DEFAULTS.targetBand);
  els.explainLang.value = value.explainLang || DEFAULTS.explainLang;
  els.translateEngine.value = value.translateEngine || DEFAULTS.translateEngine;
  els.manualExamSource.checked = value.manualExamSource === true;
  els.smartSplit.checked = value.smartSplit !== false;
  els.bubbleEnabled.checked = value.bubbleEnabled !== false;
  els.bubbleOpacity.value = String(value.bubbleOpacity ?? DEFAULTS.bubbleOpacity);
  els.bubbleOpacityValue.textContent = `${Math.round(Number(els.bubbleOpacity.value) * 100)}%`;
  els.copyFormat.value = value.copyFormat || DEFAULTS.copyFormat;
  els.autoTranslate.checked = value.autoTranslate === true;
  els.stream.checked = value.stream !== false;
  els.webSearch.checked = value.webSearch !== false;
  els.webSearchEngine.value = value.webSearchEngine || DEFAULTS.webSearchEngine;
  els.maxTokens.value = String(value.maxTokens ?? 0);
  // 界面语言：填完表单后立刻套用（包括 <html lang> 和窗口标题）
  els.language.value = value.language || DEFAULTS.language;
  applyI18nToDocument(els.language.value, 'optTitle');
}

function collect() {
  return {
    language: els.language.value,
    apiKey: els.apiKey.value.trim(),
    baseUrl: els.baseUrl.value.trim() || DEFAULTS.baseUrl,
    model: els.model.value,
    temperature: Number(els.temperature.value),
    targetBand: els.targetBand.value,
    explainLang: els.explainLang.value,
    translateEngine: els.translateEngine.value,
    manualExamSource: els.manualExamSource.checked,
    smartSplit: els.smartSplit.checked,
    bubbleEnabled: els.bubbleEnabled.checked,
    bubbleOpacity: Number(els.bubbleOpacity.value),
    copyFormat: els.copyFormat.value,
    autoTranslate: els.autoTranslate.checked,
    stream: els.stream.checked,
    webSearch: els.webSearch.checked,
    webSearchEngine: els.webSearchEngine.value,
    maxTokens: Math.max(0, Number(els.maxTokens.value) || 0)
  };
}

/** 自定义接口地址需要先拿到该域名的访问权限 */
async function ensureHostPermission(baseUrl) {
  let origin;
  try {
    const url = new URL(baseUrl);
    // 明文 http 会让 API Key 以明文发出，只允许本机调试用
    const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !isLocal) {
      setSaveStatus('接口地址必须是 https://（本机调试可用 localhost / 127.0.0.1）。', 'error');
      return false;
    }
    origin = `${url.protocol}//${url.host}/*`;
  } catch {
    setSaveStatus('接口地址格式不正确，请填写完整地址，例如 https://api.deepseek.com', 'error');
    return false;
  }

  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
  } catch {
    /* 继续往下尝试 */
  }
  try {
    // 扩展已静态声明 <all_urls>，正常情况下上面就返回了；
    // 这里保留申请逻辑，用于将来缩减权限声明时的兼容。
    if (await chrome.permissions.request({ origins: [origin] })) return true;
  } catch {
    /* 忽略，最后再复核一次 */
  }
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

async function handleSave() {
  const patch = collect();
  // 保存不强制要求 API Key：可以先把模型 / 翻译方式等偏好存下来
  if (patch.baseUrl !== settings.baseUrl) {
    const granted = await ensureHostPermission(patch.baseUrl);
    if (!granted) {
      setSaveStatus('没有获得该域名的访问权限，接口地址没有保存。', 'error');
      return;
    }
  }
  settings = await saveSettings(patch);
  fillUI(settings);
  setSaveStatus(
    patch.apiKey ? '已保存，回到侧边栏即可使用。' : '已保存（还没有填 API Key，AI 功能会在填好后可用）。',
    'ok'
  );
}

async function handleTest() {
  const patch = collect();
  if (!patch.apiKey) {
    setTestStatus('请先填写 API Key。', 'error');
    return;
  }
  const granted = await ensureHostPermission(patch.baseUrl);
  if (!granted) {
    setTestStatus('没有获得该域名的访问权限。', 'error');
    return;
  }

  els.test.disabled = true;
  setTestStatus('正在测试…');
  try {
    const answer = await chatCompletion({
      settings: { ...patch, stream: false },
      messages: [{ role: 'user', content: '只回复两个字：正常' }],
      stream: false
    });
    settings = await saveSettings(patch);
    setTestStatus(`连接成功（模型回答：${answer.trim().slice(0, 30)}），设置已保存。`, 'ok');
    setSaveStatus('已保存。', 'ok');
  } catch (err) {
    setTestStatus(String(err?.message || err), 'error');
  } finally {
    els.test.disabled = false;
  }
}

function bind() {
  // 界面语言切换立即生效（不必点「保存设置」）—— 找语言设置的人希望马上看到变化
  els.language.addEventListener('change', async () => {
    const lang = els.language.value;
    try {
      await saveSettings({ language: lang });
    } catch {
      /* 保存失败也要先把界面切过去 */
    }
    applyI18nToDocument(lang, 'optTitle');
  });

  els.temperature.addEventListener('input', () => {
    els.temperatureValue.textContent = Number(els.temperature.value).toFixed(1);
  });

  // 透明度滑块实时显示百分比（拖动时就能看到，不用先保存）
  els.bubbleOpacity.addEventListener('input', () => {
    els.bubbleOpacityValue.textContent = `${Math.round(Number(els.bubbleOpacity.value) * 100)}%`;
  });

  els.toggleKey.addEventListener('click', () => {
    const hidden = els.apiKey.type === 'password';
    els.apiKey.type = hidden ? 'text' : 'password';
    els.toggleKey.textContent = hidden ? '隐藏' : '显示';
  });

  els.save.addEventListener('click', handleSave);
  els.test.addEventListener('click', handleTest);

  els.apiKey.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleSave();
  });

  // ---------- 术语库 ----------
  els.termAdd.addEventListener('click', handleAddTerm);
  els.termImport.addEventListener('click', handleImportTerms);
  els.termReset.addEventListener('click', handleResetTerms);
  els.termSearch.addEventListener('input', renderTerms);
  for (const input of [els.termEn, els.termZh]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') handleAddTerm();
    });
  }

  // ---------- 词汇学习 ----------
  els.learnSearch.addEventListener('input', renderLearned);
  els.learnClear.addEventListener('click', handleClearLearned);
  els.cacheClear.addEventListener('click', handleClearCache);
  els.learnList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-learned]');
    if (button) handleRemoveLearned(button.dataset.learned);
  });
  els.candList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-promote]');
    if (button) handlePromote(button.dataset.promote);
  });
}

/* ---------------- 术语库 ---------------- */

let terms = [];

function setTermStatus(text, kind = '') {
  els.termStatus.textContent = text;
  els.termStatus.className = `status ${kind}`.trim();
}

function setBulkStatus(text, kind = '') {
  els.termBulkStatus.textContent = text;
  els.termBulkStatus.className = `status ${kind}`.trim();
}

async function loadTerms() {
  try {
    terms = await listGlossary();
  } catch {
    terms = [];
  }
  renderTerms();
}

function renderTerms() {
  const keyword = els.termSearch.value.trim().toLowerCase();
  const list = keyword
    ? terms.filter((row) => row.en.includes(keyword) || row.zh.toLowerCase().includes(keyword))
    : terms;

  els.termCount.textContent = String(terms.length);
  els.termList.innerHTML = list
    .map((row) => {
      const source = row.custom
        ? Object.prototype.hasOwnProperty.call(PRESET, row.en)
          ? '你的自定义'
          : '自定义'
        : '内置';
      return (
        `<li><b>${escapeHtml(row.en)}</b><span>${escapeHtml(row.zh)}</span>` +
        `<span class="src">${source}</span>` +
        `<button type="button" data-en="${escapeHtml(row.en)}">删除</button></li>`
      );
    })
    .join('');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function handleAddTerm() {
  const en = els.termEn.value.trim();
  const zh = els.termZh.value.trim();
  if (!en || !zh) {
    setTermStatus('英文和中文都要填。', 'error');
    return;
  }
  const res = await addTerm(en, zh);
  if (!res.ok) {
    setTermStatus('添加失败。', 'error');
    return;
  }
  els.termEn.value = '';
  els.termZh.value = '';
  setTermStatus(`已添加：${en} → ${zh}`, 'ok');
  await loadTerms();
}

async function handleImportTerms() {
  const lines = els.termBulk.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    setBulkStatus('文本框是空的。', 'error');
    return;
  }
  let added = 0;
  const failed = [];
  for (const line of lines) {
    const index = line.indexOf('|');
    if (index <= 0) {
      failed.push(line);
      continue;
    }
    const res = await addTerm(line.slice(0, index).trim(), line.slice(index + 1).trim());
    if (res.ok) added += 1;
    else failed.push(line);
  }
  els.termBulk.value = failed.join('\n');
  setBulkStatus(
    failed.length ? `成功导入 ${added} 条，${failed.length} 条格式不对（已留在文本框里）` : `成功导入 ${added} 条`,
    failed.length ? 'error' : 'ok'
  );
  await loadTerms();
}

async function handleResetTerms() {
  await resetDisabled();
  // 按钮在「批量导入」折叠区里，反馈也放在同一处，用户才看得到
  setBulkStatus('已恢复被屏蔽的内置术语。', 'ok');
  await loadTerms();
}

async function handleRemoveTerm(en) {
  await removeTerm(en);
  setTermStatus(`已删除：${en}`, 'ok');
  await loadTerms();
}

/* ---------------- 词汇学习 ---------------- */

let learnedRows = [];

function setLearnStatus(text, kind = '') {
  els.learnStatus.textContent = text;
  els.learnStatus.className = `status ${kind}`.trim();
}

async function loadLearned() {
  try {
    learnedRows = await listLearned();
  } catch {
    learnedRows = [];
  }
  renderLearned();

  try {
    const candidates = await listCandidates();
    els.candList.innerHTML = candidates
      .slice(0, 60)
      .map(
        (row) =>
          `<li><b>${escapeHtml(row.en)}</b><span>${escapeHtml(row.meaning)}</span>` +
          `<span class="progress">${row.count}/${row.need}</span>` +
          `<button type="button" data-promote="${escapeHtml(row.en)}">现在就收录</button></li>`
      )
      .join('');
  } catch {
    els.candList.innerHTML = '';
  }
}

function renderLearned() {
  const keyword = els.learnSearch.value.trim().toLowerCase();
  const list = keyword
    ? learnedRows.filter((row) => row.en.includes(keyword) || row.zh.toLowerCase().includes(keyword))
    : learnedRows;

  els.learnCount.textContent = String(learnedRows.length);
  els.learnList.innerHTML = list
    .map(
      (row) =>
        `<li><b>${escapeHtml(row.en)}</b><span>${escapeHtml(row.zh)}</span>` +
        `<span class="src">AI 学到</span>` +
        `<button type="button" data-learned="${escapeHtml(row.en)}">删除</button></li>`
    )
    .join('');
}

async function handleRemoveLearned(en) {
  await removeLearned(en);
  setLearnStatus(`已删除：${en}（以后它不再参与离线翻译）`, 'ok');
  await loadLearned();
}

async function handleClearLearned() {
  await clearLearned();
  setLearnStatus('已清空学到的词，离线词表回到内置状态。', 'ok');
  await loadLearned();
}

/** 清空翻译缓存：改了术语或觉得某句翻得不对时，用它让旧译文重新生成 */
async function handleClearCache() {
  const before = await translationCacheSize();
  await clearTranslationCache();
  setLearnStatus(`已清空翻译缓存（原来有 ${before} 条），下次翻译会重新生成。`, 'ok');
}

async function handlePromote(en) {
  const res = await promoteCandidate(en);
  setLearnStatus(res.ok ? `已收录：${en} → ${res.meaning}` : '收录失败（候选词已不存在）。', res.ok ? 'ok' : 'error');
  await loadLearned();
}

async function init() {
  settings = await getSettings();
  fillUI(settings);
  bind();
  await loadTerms();
  await loadLearned();

  els.termList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-en]');
    if (button) handleRemoveTerm(button.dataset.en);
  });
}

init();
