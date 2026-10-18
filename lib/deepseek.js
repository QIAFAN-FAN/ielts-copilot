// DeepSeek API 调用封装（OpenAI 兼容协议）

/** 把 baseUrl 规整成 chat/completions 的完整地址（官方同时支持不带 /v1 与带 /v1 两种写法） */
export function chatEndpoint(baseUrl) {
  const base = (baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

/**
 * 带退避重试的 fetch：只对 429（限速）和 5xx 重试，
 * 且只在「还没开始读响应体」的阶段重试，所以不会影响流式。
 */
async function fetchWithRetry(url, options, maxRetries = 2) {
  let response = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    response = await fetch(url, options);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxRetries) return response;
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
  }
  return response;
}

export class DeepSeekError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
    this.detail = detail;
  }
}

function buildBody({ settings, messages, stream, jsonMode }) {
  const body = {
    model: settings.model || 'deepseek-flash',
    messages,
    stream: !!stream
  };
  // deepseek-reasoner 不支持 temperature / response_format
  if (!/reasoner/.test(body.model)) {
    body.temperature = typeof settings.temperature === 'number' ? settings.temperature : 0.3;
    if (jsonMode) body.response_format = { type: 'json_object' };
  }
  const maxTokens = Number(settings.maxTokens);
  if (maxTokens > 0) body.max_tokens = maxTokens;
  return body;
}

/**
 * 调用 DeepSeek。
 * @returns {Promise<string>} 完整回答文本（流式时会边回调 onDelta 边返回全量）
 */
export async function chatCompletion({ settings, messages, stream = false, jsonMode = false, onDelta, signal }) {
  if (!settings?.apiKey) {
    throw new DeepSeekError('还没有配置 DeepSeek API Key，请到侧边栏「设置」里填写。', 401);
  }

  const res = await fetchWithRetry(chatEndpoint(settings.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify(buildBody({ settings, messages, stream, jsonMode })),
    signal
  });

  if (!res.ok) {
    let detail = '';
    try {
      const text = await res.text();
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || text;
      } catch {
        detail = text;
      }
    } catch {
      /* ignore */
    }
    const hint =
      res.status === 401
        ? 'API Key 无效或已过期。'
        : res.status === 402
          ? '账户余额不足。'
          : res.status === 429
            ? '请求过于频繁或额度受限，稍后再试。'
            : res.status === 400
              ? '请求被拒绝（可能是内容过长或模型名不对）。'
              : '';
    const suffix = detail ? `：${detail.slice(0, 300)}` : '';
    throw new DeepSeekError(
      `${hint || 'API 请求失败'}（HTTP ${res.status}）${suffix}`,
      res.status,
      detail
    );
  }

  if (!stream) {
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    if (!content) throw new DeepSeekError('模型没有返回内容，请重试。', 200, JSON.stringify(data).slice(0, 300));
    return content;
  }

  return readStream(res, onDelta);
}

async function readStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta;
        const piece = delta?.content || '';
        if (piece) {
          full += piece;
          if (onDelta) onDelta(piece, full);
        }
      } catch {
        /* 忽略半包/非 JSON 行 */
      }
    }
  }
  return full;
}

/** 从模型输出里抽取 JSON（容忍 ```json 包裹和前后废话） */
export function parseLooseJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      /* 继续尝试截取最外层大括号 */
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}
