// 配置存取：所有设置存在 chrome.storage.local.settings
export const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash', // deepseek-flash（V4.1-Flash，快且便宜）| deepseek-v4-pro（更强、更贵）
  temperature: 0.3,
  maxTokens: 0, // 0 = 不限制，交给服务端默认
  explainLang: 'zh', // 讲解语言：zh=中文讲解，en=英文讲解
  language: 'zh', // 界面语言：zh=简体中文，en=English，ja=日本語，ko=한국어，vi=Tiếng Việt
  targetBand: '7', // 目标分数，用于写作建议
  bubbleEnabled: true, // 划词气泡总开关
  bubbleOpacity: 1, // 划词气泡/小圆点的透明度（0.15~1，鼠标移上去会恢复不透明）
  imageHoverButton: true, // 鼠标移到图片上时显示「图译」小按钮（关掉后仍可用右键菜单翻译单张图）
  copyFormat: 'zh', // 气泡里 📋 复制什么：zh=只要中文译文，en=只要英文原文，both=英文+中文
  autoTranslate: false, // 划词后自动弹出译文（否则只显示小按钮）
  stream: true, // 侧边栏长回答流式输出
  translateEngine: 'smart', // 翻译方式：local=只用内置离线词表，smart=能离线就离线，ai=一律用 AI
  webSearch: true, // 分析阅读/听力前，先联网检索题目出处（剑桥雅思）
  webSearchEngine: 'deepseek', // 检索方式：deepseek=DeepSeek 官方 Web Search，browser=扩展自己抓必应/DDG
  smartSplit: true, // 抓取页面时角色判断不确定，就用 AI 判一下哪些是原文 / 题目
  manualExamSource: false, // true = 手动指定题目出处（关闭则自动从页面提取线索）
  examSource: '', // 手动填写的题目出处，如 "Cambridge 18 Test 2 Passage 1"
  briefMode: false // 简洁模式：只要答案和极简分析，明显省 token
};

/** 官方已停用的旧模型名（公告：2026-07-24 起停止使用） */
const RETIRED_MODELS = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash'
};

export function isRetiredModel(model) {
  return Boolean(RETIRED_MODELS[String(model || '').trim()]);
}

export function suggestModel(model) {
  return RETIRED_MODELS[String(model || '').trim()] || '';
}

const KEY = 'settings';

export async function getSettings() {
  const raw = await chrome.storage.local.get(KEY);
  const merged = { ...DEFAULTS, ...(raw[KEY] || {}) };

  // 旧模型名（deepseek-chat / deepseek-reasoner）已被官方停用，加载时自动迁到新名并落盘，
  // 否则用户会一直撞在「模型不存在」的报错上。
  const suggested = suggestModel(merged.model);
  if (suggested) {
    merged.migratedFrom = String((raw[KEY] || {}).model || '');
    merged.model = suggested;
    try {
      await chrome.storage.local.set({ [KEY]: merged });
    } catch {
      /* 写不进去也不影响本次使用 */
    }
  }
  return merged;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** 监听设置变化（返回取消监听函数） */
export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area === 'local' && changes[KEY]) {
      callback({ ...DEFAULTS, ...(changes[KEY].newValue || {}) });
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** 监听侧边栏待处理任务（划词气泡点“深入分析”时写入） */
const PENDING_KEY = 'pendingTask';

export async function setPendingTask(task) {
  await chrome.storage.session.set({ [PENDING_KEY]: { ...task, _ts: Date.now() } });
}

export async function takePendingTask() {
  const raw = await chrome.storage.session.get(PENDING_KEY);
  const task = raw[PENDING_KEY];
  if (!task) return null;
  await chrome.storage.session.remove(PENDING_KEY);
  return task;
}

export function onPendingTask(callback) {
  const listener = (changes, area) => {
    if (area === 'session' && changes[PENDING_KEY] && changes[PENDING_KEY].newValue) {
      callback(changes[PENDING_KEY].newValue);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
