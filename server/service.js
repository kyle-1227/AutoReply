import { digest } from "./context.js";
import { generateReply } from "./reply-generator.js";
import { validateReview } from "../extension/review-context.js";
import { productDocument, shopKey } from "../extension/product-catalog.js";
import { RETENTION_MS, isActive, isFinished } from "../extension/model.js";

export const LEASE_MS = 90000;
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };

function generationError(error, retryAt) {
  // Provider errors may echo buyer data; expose only fixed classifications.
  const code = ["KEY_MISSING", "OUTPUT_INVALID", "INPUT_INVALID"].includes(error.code) ? error.code : "GENERATION_FAILED";
  const messages = {
    KEY_MISSING: "生成服务未配置模型 Key。",
    OUTPUT_INVALID: "模型输出未通过校验，请检查后继续。",
    401: "模型 Key 无效，请负责人通过安装向导更新模型账户。",
    402: "模型账户额度或支付受限，请检查 OpenRouter 账户。",
    404: "所选模型端点不可用，请负责人检查模型端点。",
    429: "模型服务限流，请等待后继续。",
  };
  return {
    code,
    message: messages[code] || messages[error.status] || "模型调用失败，请检查生成服务和网络后继续。",
    status: Number.isInteger(error.status) ? error.status : null,
    retryAt: retryAt || null,
  };
}

// Temporary processing only. Product libraries belong to browser profiles.
export class ReplyService {
  constructor({ settings, generate = generateReply, now = Date.now }) {
    Object.assign(this, { settings, generate, now });
    this.runs = new Map();
  }

  control(id, { source, generation, status }) {
    this.cleanup();
    const shop = shopKey(source), previous = this.runs.get(id);
    if (!Number.isSafeInteger(generation) || generation < 0 || !["running", "recovering", "paused", "completed", "ended"].includes(status)) fail("任务控制参数无效。", 400);
    if (previous && previous.shop !== shop) fail("任务不属于当前店铺。");
    if (previous && (previous.generation > generation || (previous.generation === generation && status === "running" && previous.status !== "running"))) {
      fail("任务执行已失效，请暂停后重新开始。");
    }
    if (previous && (generation > previous.generation || status !== "running")) this.cancelCalls(previous);
    const expiresAt = isFinished({ status }) ? previous?.expiresAt || this.now() + RETENTION_MS : null;
    const run = previous || { operations: new Map() };
    Object.assign(run, { shop, generation, status, heartbeat: this.now(), expiresAt });
    this.runs.set(id, run);
    return { status, generation, expiresAt };
  }

  requireRun(id, generation) {
    const run = this.runs.get(id);
    if (!run || run.generation !== generation) fail("任务执行已失效，请重新开始。");
    return run;
  }

  heartbeat(id, generation) {
    this.cleanup();
    const run = this.requireRun(id, generation);
    if (!isActive(run)) fail("本机任务已暂停，请重新开始。");
    run.heartbeat = this.now();
    return { status: run.status };
  }

  submit(id, { generation, review, product = null }) {
    this.cleanup();
    const run = this.requireRun(id, generation);
    if (run.status !== "running") fail("任务未运行，不能生成回复。");
    review = structuredClone(validateReview(review));
    product = product === null ? null : productDocument(product);
    const operationId = digest([id, generation, review.reviewId]), fingerprint = digest([review, product]);
    const previous = run.operations.get(operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail("同一操作的评价或商品资料内容发生变化，请重新开始。");
      return this.operation(operationId, id);
    }
    if (run.work) fail("该任务已有正在生成的评价。");
    run.operations.set(operationId, { fingerprint, status: "pending", data: null });
    const work = { id: operationId, controller: new AbortController(), callState: null };
    run.work = work;
    const current = () => this.runs.get(id)?.work === work && run.generation === generation && run.status === "running";
    const [platform, market, shopId] = JSON.parse(run.shop);
    Promise.resolve().then(() => {
      if (!current()) return;
      return this.generate(review, { source: { platform, market, shopId }, products: product ? [product] : [],
        settings: this.settings, signal: work.controller.signal, onStateChange: state => { if (current()) work.callState = state; } });
    }).then(result => {
      if (current()) Object.assign(run.operations.get(operationId), { status: "succeeded", data: result });
    }).catch(error => {
      if (!current()) return;
      const data = generationError(error, work.callState?.nextRetryAt);
      Object.assign(run.operations.get(operationId), { status: "failed", data });
    }).finally(() => { if (run.work === work) run.work = null; });
    return this.operation(operationId, id);
  }

  operation(id, runId) {
    this.cleanup();
    const run = this.runs.get(runId), operation = run?.operations.get(id);
    if (!operation) fail("生成记录不存在或已过期。", 404);
    return structuredClone({ id, status: operation.status, data: operation.data,
      callState: run.work?.id === id ? run.work.callState : null });
  }

  cancelCalls(run) {
    const work = run.work;
    run.work = null;
    if (!work) return;
    Object.assign(run.operations.get(work.id), { status: "cancelled", data: null });
    work.controller.abort();
  }

  cleanup() {
    const now = this.now();
    for (const [id, run] of this.runs) {
      if (isActive(run) && run.heartbeat + LEASE_MS <= now) {
        this.cancelCalls(run); run.status = "paused";
      }
      if ((run.expiresAt || run.heartbeat + RETENTION_MS) <= now) {
        this.cancelCalls(run); this.runs.delete(id);
      }
    }
  }

  close() {
    for (const run of this.runs.values()) this.cancelCalls(run);
    this.runs.clear();
  }
}
