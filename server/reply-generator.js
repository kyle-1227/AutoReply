import { createLlmCall, errorStatus } from "./llm-call.js";
import { DEFAULT_PROMPT, HAIKU_MODEL, buildLlmRequest, getProductContext, parseReplyResult } from "./context.js";

export const DEFAULT_SETTINGS = Object.freeze({ apiKey: "", model: HAIKU_MODEL,
  videoModel: "meta/muse-spark-1.3-contributor" });

const systemErrors = new Set(["KEY_MISSING", "INPUT_INVALID", "MEDIA_UNAVAILABLE", "CONTEXT_INVALID", "COST_STORAGE_FAILED", "MODEL_REFUSED"]);
function canFallback(error) {
  const status = errorStatus(error);
  if (error.name === "AbortError" || systemErrors.has(error.code) || [401, 402, 403].includes(status)) return false;
  return status >= 400 || error.isNetworkError === true || ["TimeoutError", "SyntaxError"].includes(error.name) || error.code === "OUTPUT_INVALID";
}
function reasonCode(error, status) {
  if (error.name === "TimeoutError") return "timeout";
  if (error.isNetworkError) return "network";
  if (error.code === "OUTPUT_INVALID" || error.name === "SyntaxError") return "output_invalid";
  if (status === 404) return "endpoint_unavailable";
  if (status === 429) return "rate_limited";
  if (status) return "http_error";
  return error.code === "MODEL_REFUSED" ? "refused" : "unknown";
}
const requestId = response => typeof response?.id === "string" && /^gen-[\w-]{1,190}$/.test(response.id) ? response.id : null;

export async function generateReply(review, { source, products, categoryIds = [], settings, signal, onStateChange, costs } = {}) {
  if (!settings.apiKey) throw Object.assign(new Error("后端未配置 OPENROUTER_API_KEY。"), { code: "KEY_MISSING" });
  signal?.throwIfAborted();
  const productContext = getProductContext({ products, product: review.product });
  const video = review.attachments.some(item => item.kind === "video"), primary = video ? settings.videoModel : settings.model;
  const primaryRequest = buildLlmRequest({ review, source, model: primary, productContext, categoryIds, structuredOutputs: settings.structuredOutputs });
  const routing = video ? { primaryModel: primary, fallbackModel: null, videoOmitted: false, trigger: null, attempts: [] } : null;
  const record = (model, response, request) => ({ model, promptVersion: DEFAULT_PROMPT.version, contextKey: request.contextKey,
    categoryId: request.category.id, categorySource: request.category.source,
    product: productContext ? { id: productContext.documentId, name: productContext.name, version: productContext.version } : null,
    usage: response?.usage || null, requestId: response?.id || null, generatedAt: Date.now(),
    ...(routing ? { routing: structuredClone(routing) } : {}) });

  async function attempt(model, request, stage) {
    signal?.throwIfAborted();
    const call = createLlmCall({ apiKey: settings.apiKey, model, messages: request.messages, parameters: request.parameters, signal, costs }, {
      maxAttempts: video ? 1 : undefined,
      onStateChange: state => { if (state.status !== "cancelled") onStateChange?.({ ...state, model, stage }); },
    });
    let response;
    try {
      response = await call.start();
      signal?.throwIfAborted();
      const result = parseReplyResult(response, { productContext });
      routing?.attempts.push({ stage, model, outcome: result.decision, reasonCode: null, httpStatus: 200, requestId: requestId(response) });
      return { result, record: record(response.model || model, response, request) };
    } catch (error) {
      const httpStatus = errorStatus(error);
      routing?.attempts.push({ stage, model, outcome: "failed", reasonCode: reasonCode(error, httpStatus), httpStatus, requestId: requestId(response || { id: error.requestId }) });
      throw error;
    } finally { call.cancel(); }
  }

  try { return await attempt(primary, primaryRequest, video ? "video" : "text"); }
  catch (error) {
    signal?.throwIfAborted();
    if (!video || !canFallback(error)) throw error;
    routing.trigger = routing.attempts[0].reasonCode;
    routing.videoOmitted = true;
  }
  const fallbackReview = { ...review, attachments: review.attachments.filter(item => item.kind === "image") };
  if (!fallbackReview.text.trim() && !fallbackReview.attachments.length) {
    return { result: { decision: "manual", replyText: "", reason: "视频模型调用失败，评价没有可用文字或图片，请人工查看视频。", usedFactIds: [] },
      record: record(null, null, primaryRequest) };
  }
  signal?.throwIfAborted();
  routing.fallbackModel = HAIKU_MODEL;
  const fallbackRequest = buildLlmRequest({ review: fallbackReview, source, model: HAIKU_MODEL, productContext, categoryIds, videoOmitted: true });
  try { return await attempt(HAIKU_MODEL, fallbackRequest, "haiku"); }
  catch (error) {
    signal?.throwIfAborted();
    if (errorStatus(error) === 429 || !canFallback(error)) throw error;
    throw Object.assign(new Error("视频模型与 Haiku 回退均失败，请稍后重试这条评价。"), {
      code: "VIDEO_FALLBACK_FAILED", status: errorStatus(error), failureRecord: { occurredAt: Date.now(), routing },
    });
  }
}
