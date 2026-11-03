import { findProduct } from "./product-catalog.js";
import { NATIVE_HOST, APP_VERSION, PROTOCOL_VERSION, COST_TRACKING_VERSION, MAX_MESSAGE_BYTES } from "./protocol.js";
import { createQueue } from "./queue.js";

const componentError = message => Object.assign(new Error(message), { code: "COMPONENT_UNAVAILABLE" });
const missingComponent = () => componentError("本机组件未安装或无法启动，请运行 AutoReply 安装程序。");

function waitFor(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

// One Native Messaging connection per browser environment, shared by its tasks.
export class NativeClient {
  constructor(runtime, { onDisconnect = () => {}, onHealth = async () => {}, onCosts = async () => {}, timeoutMs = 8000 } = {}) {
    Object.assign(this, { runtime, onDisconnect, onHealth, onCosts, timeoutMs });
    this.port = null;
    this.healthPromise = null;
    this.pending = new Map();
    this.costMessages = createQueue();
    this.costSessionId = null;
    this.costError = null;
  }

  get connected() { return Boolean(this.port); }

  connect() {
    if (this.port) return;
    try { this.port = this.runtime.connectNative(NATIVE_HOST); }
    catch { throw missingComponent(); }
    const port = this.port;
    this.costError = null;
    port.onMessage.addListener(message => {
      if (this.port !== port) return;
      if (message?.type === "COST_EVENT") {
        void this.costMessages(async () => {
          if (this.port !== port || message.sessionId !== this.costSessionId) return;
          let accepted = true;
          try { await this.onCosts(message); }
          catch { accepted = false; this.costError = Object.assign(new Error("费用记录无法保存，任务已暂停，未发起新的模型请求。"), { code: "COST_STORAGE_FAILED" }); }
          try { await this.rawRequest("cost_ack", { sessionId: message.sessionId, sequence: message.sequence, taskId: message.taskId, accepted }); }
          finally { if (!accepted && this.port === port) port.disconnect(); }
        }).catch(() => {});
        return;
      }
      const request = this.pending.get(message?.requestId);
      if (!request) return;
      if (typeof message.ok !== "boolean") { request.reject(componentError("本机组件返回格式无效，请更新组件。")); return; }
      if (message.ok) request.resolve(message.data);
      else request.reject(Object.assign(new Error(message.error?.message || "本机处理失败。"),
        { code: message.error?.code || "COMPONENT_ERROR", status: message.error?.status }));
    });
    port.onDisconnect.addListener(() => {
      const error = this.costError || (this.runtime.lastError ? missingComponent() : componentError("本机组件连接已中断，请确认组件后继续任务。"));
      if (this.port !== port) return;
      const sessionId = this.costSessionId;
      this.port = null; this.healthPromise = null; this.costSessionId = null;
      for (const request of [...this.pending.values()]) request.reject(error);
      this.onDisconnect(error, sessionId);
    });
  }

  rawRequest(command, payload, signal) {
    signal?.throwIfAborted();
    const requestId = crypto.randomUUID(), message = { requestId, command, payload };
    if (new TextEncoder().encode(JSON.stringify(message)).length > MAX_MESSAGE_BYTES) {
      return Promise.reject(Object.assign(new Error("本条评价和商品资料超过 1 MiB，未截断或发送。"), { code: "INPUT_INVALID" }));
    }
    return new Promise((resolve, reject) => {
      const finish = callback => value => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        this.pending.delete(requestId); callback(value);
      };
      const abort = () => request.reject(signal.reason);
      const timeout = command === "credentials" ? this.timeoutMs * 3 : this.timeoutMs;
      const timer = setTimeout(() => request.reject(componentError("本机组件响应超时，请稍后继续。")), timeout);
      const request = { resolve: finish(resolve), reject: finish(reject) };
      this.pending.set(requestId, request);
      signal?.addEventListener("abort", abort, { once: true });
      try { this.port.postMessage(message); } catch { request.reject(missingComponent()); }
    });
  }

  check(signal) {
    try { signal?.throwIfAborted(); this.connect(); } catch (error) { return Promise.reject(error); }
    if (!this.healthPromise) {
      const promise = this.rawRequest("health", {}).then(async health => {
        if (health?.protocolVersion !== PROTOCOL_VERSION || health?.componentVersion !== APP_VERSION) {
          throw Object.assign(componentError(`本机组件版本不兼容（插件 ${APP_VERSION}，组件 ${health?.componentVersion || "未知"}），请同步更新插件和组件。`),
            { componentVersion: typeof health?.componentVersion === "string" ? health.componentVersion : null });
        }
        this.costSessionId = health.costTrackingVersion === COST_TRACKING_VERSION ? health.costSessionId : null;
        await this.onHealth(health);
        return health;
      }).catch(error => { if (this.healthPromise === promise) this.healthPromise = null; throw error; });
      this.healthPromise = promise;
    }
    return waitFor(this.healthPromise, signal);
  }

  async request(command, payload, signal) {
    await this.check(signal);
    signal?.throwIfAborted();
    return this.rawRequest(command, payload, signal);
  }

  disconnect() { this.port?.disconnect(); }
}

function delay(signal) {
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, 700);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function generateReply(review, { client, taskId, generation, products, signal, onStateChange }) {
  const input = review.platformReview || { reviewId: review.id,
    product: { productId: null, skuId: null, title: null, variant: null }, rating: null,
    text: review.text, attachments: review.attachments, platformReply: { count: 0, canReply: true }, modifiedAt: null };
  const product = findProduct(products, input.product);
  let operation = await client.request("generate", { taskId, generation, review: input, product }, signal);
  while (operation.status === "pending") {
    if (operation.callState) onStateChange?.(operation.callState);
    await delay(signal);
    operation = await client.request("operation", { taskId, operationId: operation.id }, signal);
  }
  signal?.throwIfAborted();
  if (operation.status === "succeeded") return operation.data;
  if (operation.data?.retryAt) onStateChange?.({ status: "failed", nextRetryAt: operation.data.retryAt });
  if (operation.data?.code === "COST_STORAGE_FAILED") client.disconnect?.();
  throw Object.assign(new Error(operation.data?.message || "生成已中断，请检查后继续。"),
    { code: operation.data?.code || "GENERATION_FAILED", status: operation.data?.status });
}
