import { requestLlm } from "./llm-client.js";

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 60000;

function retryTime(value) {
  if (typeof value !== "string" || !value.trim()) return 0;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Date.now() + Math.min(Number(text) * 1000, Number.MAX_SAFE_INTEGER);
  const time = /^[a-z]/i.test(text) ? Date.parse(text) : NaN;
  return Number.isFinite(time) ? Math.max(Date.now(), time) : 0;
}

function canRetry(error) {
  const status = error?.status === 200 && ["number", "string"].includes(typeof error.code)
    ? Number(error.code) : error?.status;
  return error?.isNetworkError === true || error?.name === "TimeoutError" || RETRY_STATUSES.has(status);
}

/** 一次逻辑调用复用一个控制器；业务任务负责保管控制器及接收完整结果。 */
export function createLlmCall(request, { onStateChange } = {}) {
  let args = { ...request };
  const externalSignal = args.signal;
  delete args.signal;
  if (Array.isArray(args.messages)) args.messages = structuredClone(args.messages);
  if (args.parameters && [Object.prototype, null].includes(Object.getPrototypeOf(args.parameters))) {
    args.parameters = structuredClone(args.parameters);
  }

  const state = { status: "idle", attempt: 0, nextRetryAt: null, error: null };
  let generation = 0;
  let active = null;
  let lastPromise = null;
  let lastError = null;
  let notBefore = 0;
  let stopReason = null;
  const getState = () => structuredClone(state);
  const current = run => active === run && generation === run.generation;
  const detach = () => externalSignal?.removeEventListener("abort", externalAbort);

  function errorInfo(error) {
    // 服务错误可能回显输入；快照只给出技术分类，原错误仍交给 Promise 调用方。
    const name = ["AbortError", "TimeoutError", "TypeError", "SyntaxError"].includes(error?.name) ? error.name : "Error";
    const info = { name, message: error?.isNetworkError ? "网络连接或响应读取失败。" :
      name === "TimeoutError" ? "模型请求超时。" : name === "AbortError" ? "调用已停止。" : "模型调用失败，请检查错误码及输入配置。" };
    if (typeof error?.status === "number") info.status = error.status;
    if (typeof error?.code === "number" || (typeof error?.code === "string" && /^[\w-]{1,64}$/.test(error.code))) {
      info.code = typeof error.code === "string" && typeof args?.apiKey === "string" && args.apiKey
        ? error.code.replaceAll(args.apiKey, "[REDACTED]") : error.code;
    }
    if (retryTime(error?.retryAfter)) info.retryAfter = error.retryAfter;
    return info;
  }

  function update(patch) {
    Object.assign(state, patch);
    try { onStateChange?.(getState()); }
    catch { /* 订阅方异常不能改变请求结果，也不记录可能包含敏感信息的异常。 */ }
  }

  function wait(run, delay) {
    return new Promise((resolve, reject) => {
      const signal = run.controller.signal;
      const abort = () => {
        clearTimeout(run.timer);
        run.timer = null;
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      run.timer = setTimeout(() => {
        run.timer = null;
        signal.removeEventListener("abort", abort);
        resolve();
      }, delay);
      if (signal.aborted) abort();
    });
  }

  async function execute(run) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (!current(run)) return;
      const delay = notBefore - Date.now();
      if (delay > MAX_WAIT_MS) throw lastError;
      if (delay > 0) {
        update({ status: "retry_wait", nextRetryAt: notBefore });
        if (!current(run)) return;
        await wait(run, delay);
        if (!current(run)) return;
      }
      notBefore = 0;
      update({ status: "requesting", attempt, nextRetryAt: null, error: null });
      if (!current(run)) return;
      try {
        const data = await requestLlm({ ...args, signal: run.controller.signal });
        if (!current(run)) return;
        return data;
      } catch (error) {
        if (!current(run)) return;
        lastError = error;
        notBefore = retryTime(error?.retryAfter);
        state.error = errorInfo(error);
        if (!canRetry(error) || attempt === MAX_ATTEMPTS) throw error;
        notBefore = Math.max(notBefore, Date.now() + 2000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 501));
      }
    }
  }

  function launch() {
    const run = { generation: ++generation, controller: new AbortController(), timer: null };
    run.promise = new Promise((resolve, reject) => Object.assign(run, { resolve, reject }));
    active = run;
    lastPromise = run.promise;
    // 先登记执行，再异步发请求，立即暂停可以阻止尚未发出的请求。
    Promise.resolve().then(() => execute(run)).then(data => {
      if (!current(run)) return;
      active = null;
      detach();
      args = null;
      lastError = null;
      notBefore = 0;
      run.resolve(data);
      update({ status: "succeeded", nextRetryAt: null, error: null });
    }, error => {
      if (!current(run)) return;
      active = null;
      run.reject(error);
      update({ status: "failed", nextRetryAt: notBefore > Date.now() ? notBefore : null, error: errorInfo(error) });
    });
    update({ status: notBefore > Date.now() ? "retry_wait" : "requesting", attempt: 0,
      nextRetryAt: notBefore > Date.now() ? notBefore : null, error: null });
    return run.promise;
  }

  function stop(status, reason) {
    if (["succeeded", "cancelled"].includes(state.status) || state.status === status) return getState();
    generation += 1;
    const run = active;
    active = null;
    stopReason = reason;
    if (run) {
      run.controller.abort(reason);
      run.reject(reason);
    }
    const error = status === "cancelled" ? errorInfo(reason) : null;
    if (status === "cancelled") {
      detach();
      args = null;
      lastError = null;
      notBefore = 0;
    }
    update({ status, nextRetryAt: notBefore > Date.now() ? notBefore : null, error });
    return getState();
  }

  function externalAbort() { stop("cancelled", externalSignal.reason); }
  if (externalSignal?.aborted) externalAbort();
  else externalSignal?.addEventListener("abort", externalAbort, { once: true });

  function start() {
    if (lastPromise) return lastPromise;
    if (state.status === "idle") return launch();
    return lastPromise = Promise.reject(stopReason);
  }

  return {
    start,
    resume: () => ["paused", "failed"].includes(state.status) ? launch() : start(),
    pause: () => stop("paused", new DOMException("调用已暂停。", "AbortError")),
    cancel: () => stop("cancelled", new DOMException("调用已取消。", "AbortError")),
    getState,
  };
}
