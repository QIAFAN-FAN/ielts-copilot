// DeepSeek 官方联网搜索
//
// 依据官方文档（api-docs.deepseek.com）：
// - 联网搜索走 **Anthropic 兼容端点**：POST https://api.deepseek.com/anthropic/v1/messages
//   （官方文档在「使用 Responses API → Tools」里写明：Responses API 的内置工具会被“忽略”，
//     所以不能走 /responses；Claude Code 接入页明确“DeepSeek API 原生支持 Web Search 功能”）
// - 认证头用 x-api-key；anthropic-version 官方会忽略，传上无妨
// - 工具是**服务端工具**，由 DeepSeek 在服务端执行搜索；结果以
//   `server_tool_use` / `web_search_tool_result` 内容块返回（官方兼容性表里这两项都标“支持”）
// - 官方提醒：一次搜索会产生一整轮模型调用的延迟与 token 开销
//
// 工具声明的版本号官方文档没有明说，所以这里按 Anthropic 标准依次尝试几种写法，
// 并把成功的那种记下来，后续优先使用。

// 工具声明只保留 Anthropic 规范的「带版本号」写法：
// 无版本号的 { type: 'web_search' } 是 OpenAI Responses API 的写法，在 Anthropic 端点上不会被识别，
// 只会白白多耗一轮超时。web_search_20250305 是第三方项目实测可用的基础版，
// web_search_20260209 是较新的动态过滤版（token 更省）。
const TOOL_VARIANTS = [
  { type: 'web_search_20250305', name: 'web_search' },
  { type: 'web_search_20260209', name: 'web_search' }
];

const VARIANT_KEY = 'dsSearchToolVariant';
const FAIL_KEY = 'dsSearchFailStreak';

/** 由 OpenAI 格式的 base_url 推出 Anthropic 端点 */
export function anthropicEndpoint(baseUrl) {
  const base = String(baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  if (/\/v1\/messages$/.test(base)) return base;
  if (/\/anthropic$/.test(base)) return `${base}/v1/messages`;
  return `${base}/anthropic/v1/messages`;
}

/**
 * 搜索固定用快而便宜的 flash 级模型。
 * 官方明确提醒「一次搜索会产生完整模型轮次的 token 开销」，用 v4-pro 搜太浪费。
 */
export function pickSearchModel() {
  return 'deepseek-flash';
}

/** 搜索连续失败次数（只统计接口报错/未真正执行搜索，不统计「搜了但没结果」） */
export async function searchFailStreak() {
  try {
    const raw = await chrome.storage.local.get(FAIL_KEY);
    return Number(raw?.[FAIL_KEY] || 0);
  } catch {
    return 0;
  }
}

async function bumpFailStreak() {
  const next = (await searchFailStreak()) + 1;
  try {
    await chrome.storage.local.set({ [FAIL_KEY]: next });
  } catch {
    /* 忽略 */
  }
  return next;
}

async function resetFailStreak() {
  try {
    await chrome.storage.local.set({ [FAIL_KEY]: 0 });
  } catch {
    /* 忽略 */
  }
}

async function readVariant() {
  try {
    const raw = await chrome.storage.local.get(VARIANT_KEY);
    const index = raw?.[VARIANT_KEY];
    return Number.isInteger(index) && index >= 0 && index < TOOL_VARIANTS.length ? index : 0;
  } catch {
    return 0;
  }
}

async function saveVariant(index) {
  try {
    await chrome.storage.local.set({ [VARIANT_KEY]: index });
  } catch {
    /* 忽略 */
  }
}

/** 解析 Anthropic 格式响应，取出「是否真的搜了」「来源清单」「文本总结」 */
export function parseSearchResponse(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  const rawSources = [];
  const texts = [];
  let searched = false;
  let toolName = '';

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'server_tool_use') {
      searched = true;
      if (block.name) toolName = block.name;
    }
    if (block.type === 'web_search_tool_result') {
      searched = true;
      if (Array.isArray(block.content)) {
        for (const item of block.content) {
          if (item?.type === 'web_search_result' && item.url) {
            rawSources.push({ title: item.title || item.url, url: item.url });
          }
        }
      }
    }
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      texts.push(block.text.trim());
      // 文本块上的 citations 也可能带来源
      if (Array.isArray(block.citations)) {
        for (const cite of block.citations) {
          if (cite?.url) rawSources.push({ title: cite.title || cite.url, url: cite.url });
        }
      }
    }
  }

  // 官方建议：来源从结构化结果块取，且按 URL 去重
  const seen = new Set();
  const sources = [];
  for (const item of rawSources) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    sources.push(item);
  }

  return { searched, toolName, sources, text: texts.join('\n\n').trim() };
}

async function postMessages({ baseUrl, apiKey, model, body, signal }) {
  const response = await fetch(anthropicEndpoint(baseUrl), {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON，下面按错误处理 */
  }

  if (!response.ok) {
    const message =
      data?.error?.message || data?.message || (text ? text.slice(0, 200) : '无响应内容');
    const error = new Error(`HTTP ${response.status}：${message}`);
    error.status = response.status;
    throw error;
  }
  if (!data) throw new Error('返回内容不是合法 JSON');
  return data;
}

/**
 * 用 DeepSeek 官方 Web Search 搜一次并拿到模型总结。
 * @returns {{ok:boolean, summary:string, sources:Array, variant:string, error:string}}
 */
export async function deepseekWebSearch({ query, settings, signal, maxUses = 3, maxTokens = 1600 }) {
  const apiKey = settings?.apiKey;
  const question = String(query || '').trim();
  if (!apiKey) return { ok: false, summary: '', sources: [], variant: '', error: 'NO_API_KEY' };
  if (!question) return { ok: false, summary: '', sources: [], variant: '', error: 'EMPTY_QUERY' };

  const model = pickSearchModel();
  const start = await readVariant();
  let lastError = '';

  for (let offset = 0; offset < TOOL_VARIANTS.length; offset += 1) {
    const index = (start + offset) % TOOL_VARIANTS.length;
    const variant = TOOL_VARIANTS[index];
    try {
      const payload = await postMessages({
        baseUrl: settings?.baseUrl,
        apiKey,
        model,
        signal,
        body: {
          model,
          max_tokens: maxTokens,
          system:
            '你是雅思真题检索助手。请务必先用 web_search 工具联网核实，再简明作答（简体中文）。' +
            '回答里要写清楚：题目出自哪一套剑桥雅思（第几册、Test 几、Passage/Section 几）；这一部分的参考答案；以及你参考的来源。' +
            '如果联网后仍无法确定出处，就明确说“未能确认出处”，不要编造。',
          messages: [{ role: 'user', content: [{ type: 'text', text: question }] }],
          tools: [{ type: variant.type, name: variant.name, max_uses: maxUses }],
          tool_choice: { type: 'auto' }
        }
      });

      const parsed = parseSearchResponse(payload);
      if (parsed.searched && (parsed.sources.length || parsed.text)) {
        await saveVariant(index);
        await resetFailStreak();
        return {
          ok: true,
          summary: parsed.text,
          sources: parsed.sources,
          variant: variant.type,
          error: '',
          failStreak: 0
        };
      }
      lastError = `接口返回成功但没有执行联网搜索（工具写法 ${variant.type} 可能不被支持）`;
    } catch (err) {
      lastError = String(err?.message || err);
    }
  }

  // 只有「接口报错」或「接口没真正执行搜索」才计入失败；搜了但没结果属于正常情况。
  const failStreak = await bumpFailStreak();
  return { ok: false, summary: '', sources: [], variant: '', error: lastError || '搜索失败', failStreak };
}
