import { createLlmCall } from "./llm-call.js";
import { DEFAULT_PROMPT, buildLlmRequest, getProductContext, parseReplyResult } from "./context.js";

export const DEFAULT_SETTINGS = Object.freeze({ apiKey: "", model: "anthropic/claude-haiku-5.5",
  videoModel: "meta/muse-spark-1.3-contributor" });

export async function generateReply(review, { source, products, categoryIds = [], settings, signal, onStateChange, costs } = {}) {
  if (!settings.apiKey) throw Object.assign(new Error("后端未配置 OPENROUTER_API_KEY。"), { code: "KEY_MISSING" });
  const productContext = getProductContext({ products, product: review.product });
  const model = review.attachments.some(item => item.kind === "video") ? settings.videoModel : settings.model;
  const request = buildLlmRequest({ review, source, model, productContext, categoryIds, structuredOutputs: settings.structuredOutputs });
  const call = createLlmCall({ apiKey: settings.apiKey, model, messages: request.messages, parameters: request.parameters, signal, costs }, {
    onStateChange: state => { if (state.status !== "cancelled") onStateChange?.(state); },
  });
  try {
    const response = await call.start();
    signal?.throwIfAborted();
    return { result: parseReplyResult(response, { productContext }), record: {
      model: response.model || model, promptVersion: DEFAULT_PROMPT.version, contextKey: request.contextKey,
      categoryId: request.category.id, categorySource: request.category.source,
      product: productContext ? { id: productContext.documentId, name: productContext.name, version: productContext.version } : null,
      usage: response.usage || null, requestId: response.id || null, generatedAt: Date.now(),
    } };
  } finally { call.cancel(); }
}
