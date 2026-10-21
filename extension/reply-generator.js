import { createLlmCall } from "./llm-call.js";
import { DEFAULT_PROMPT, REPLY_POLICY, buildLlmRequest, getProductContext, parseReplyResult } from "./review-context.js";

export const SETTINGS_KEY = "autoreply.generation.v1";
export const DEFAULT_SETTINGS = Object.freeze({
  apiKey: "", model: "anthropic/claude-haiku-5.5", videoModel: "minimax/minimax-m3.1-flash:free",
  prompt: DEFAULT_PROMPT, structuredOutputs: false,
});

export function validateSettings(settings) {
  for (const key of ["model", "videoModel"]) {
    if (typeof settings[key] !== "string" || !settings[key].trim()) throw new Error("请填写模型 ID。");
  }
  if (typeof settings.apiKey !== "string" || /[\r\n]/.test(settings.apiKey)) throw new Error("API Key 格式无效。");
  if (!settings.prompt || ["id", "version", "text"].some(key => typeof settings.prompt[key] !== "string" || !settings.prompt[key].trim())) {
    throw new Error("请填写 Prompt 正文、编号和版本。");
  }
  if (typeof settings.structuredOutputs !== "boolean") throw new Error("结构化输出设置无效。");
  return settings;
}

/** No publishing: returns a validated decision plus provenance for this one review. */
export async function generateReply(review, { source, products, settings, signal, onStateChange } = {}) {
  validateSettings(settings);
  if (!settings.apiKey.trim()) throw Object.assign(new Error("请先在生成设置中保存 API Key。"), { code: "KEY_MISSING" });
  const input = review.platformReview || {
    reviewId: review.id, product: { productId: null, skuId: null, title: null, variant: null },
    rating: null, text: review.text, attachments: review.attachments,
    platformReply: { count: 0, canReply: true }, modifiedAt: null,
  };
  const productContext = getProductContext({ products, source, product: input.product });
  const prompt = structuredClone(settings.prompt);
  const request = buildLlmRequest({ review: input, prompt, productContext, structuredOutputs: settings.structuredOutputs });
  const model = input.attachments.some(attachment => attachment.kind === "video") ? settings.videoModel : settings.model;
  const call = createLlmCall({ ...request, apiKey: settings.apiKey, model, signal }, {
    onStateChange: state => { if (state.status !== "cancelled") onStateChange?.(state); },
  });
  try {
    const response = await call.start();
    signal?.throwIfAborted();
    const result = parseReplyResult(response, { productContext });
    return { result, record: {
      model: typeof response.model === "string" ? response.model : model,
      prompt, productContext, replyPolicy: { ...REPLY_POLICY },
      usage: response.usage ? structuredClone(response.usage) : null, generatedAt: Date.now(),
    } };
  } finally { call.cancel(); }
}
