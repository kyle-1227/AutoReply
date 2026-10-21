const API_URL = "https://openrouter.ai/api/v1/chat/completions";

function transportError(error, signal) {
  if (signal.aborted) return signal.reason;
  if (error instanceof TypeError) error.isNetworkError = true;
  return error;
}

/**
 * 发起一次非流式 LLM 请求，返回完整 API JSON。
 * 模型选择、消息组装和响应解释由调用方负责。
 */
export async function requestLlm({ apiKey, model, messages, parameters = {}, signal, timeoutMs = 25000 } = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new TypeError("请提供 API Key。");
  if (typeof model !== "string" || !model.trim()) throw new TypeError("请提供模型 ID。");
  if (!Array.isArray(messages) || !messages.length) throw new TypeError("messages 必须是非空数组。");
  if (!parameters || typeof parameters !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(parameters))) {
    throw new TypeError("parameters 必须是普通对象。");
  }
  if (["model", "messages", "stream"].some(key => Object.hasOwn(parameters, key))) {
    throw new TypeError("parameters 不能包含 model、messages 或 stream。");
  }

  signal?.throwIfAborted();
  const body = JSON.stringify({ ...parameters, model, messages, stream: false });
  // 原生 Request 先检查请求构造错误，避免把无效请求误判为断网。
  const request = new Request(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body,
  });
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response;
  try {
    response = await fetch(request, { signal: requestSignal });
  } catch (error) {
    throw transportError(error, requestSignal);
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    // 非 JSON 的错误响应仍保留 HTTP 状态；其余解析、网络、取消或超时错误原样抛出。
    if (requestSignal.aborted || response.ok || !(error instanceof SyntaxError)) {
      throw transportError(error, requestSignal);
    }
  }

  const apiError = data?.error;
  if (!response.ok || (apiError && typeof apiError === "object")) {
    const error = new Error(apiError?.message || `LLM 请求失败（HTTP ${response.status}）。`);
    error.status = response.status;
    if (apiError?.code !== undefined) error.code = apiError.code;
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter !== null) error.retryAfter = retryAfter;
    throw error;
  }
  return data;
}
