// Platform data validation shared by the reader and backend. No business Prompt.
function invalid(message, code = "INPUT_INVALID") {
  return Object.assign(new Error(message), { code });
}
const object = value => value && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && Boolean(value.trim());
const nullableText = value => value === null || typeof value === "string";
export const FAILURE_REASONS = Object.freeze({ endpoint_unavailable: "端点不可用", rate_limited: "服务限流", timeout: "请求超时",
  network: "网络错误", output_invalid: "输出格式不合规", http_error: "服务请求失败", refused: "模型拒绝处理", unknown: "调用失败" });

// Only technical fields cross the native boundary; discard all other properties.
export function readFailureRecord(value) {
  const route = value?.routing;
  const model = name => typeof name === "string" && /^[\w.:-]+\/[\w.:/-]{1,180}$/.test(name);
  if (!object(value) || !Number.isFinite(value.occurredAt) || value.occurredAt < 0 || !object(route) ||
      !model(route.primaryModel) || !model(route.fallbackModel) || route.videoOmitted !== true ||
      typeof route.trigger !== "string" || !Object.hasOwn(FAILURE_REASONS, route.trigger) || !Array.isArray(route.attempts) || route.attempts.length !== 2) return null;
  const attempts = route.attempts.map((attempt, i) => {
    if (!object(attempt) || attempt.stage !== (i ? "haiku" : "video") || attempt.outcome !== "failed" ||
        attempt.model !== (i ? route.fallbackModel : route.primaryModel) || typeof attempt.reasonCode !== "string" || !Object.hasOwn(FAILURE_REASONS, attempt.reasonCode) ||
        !(attempt.httpStatus === null || Number.isInteger(attempt.httpStatus) && attempt.httpStatus >= 100 && attempt.httpStatus <= 599) ||
        !(attempt.requestId === null || typeof attempt.requestId === "string" && /^gen-[\w-]{1,190}$/.test(attempt.requestId))) return null;
    return { stage: attempt.stage, model: attempt.model, outcome: "failed", reasonCode: attempt.reasonCode,
      httpStatus: attempt.httpStatus, requestId: attempt.requestId };
  });
  if (attempts.some(attempt => !attempt)) return null;
  return { occurredAt: value.occurredAt, routing: { primaryModel: route.primaryModel, fallbackModel: route.fallbackModel,
    videoOmitted: true, trigger: route.trigger, attempts } };
}
export const reviewIdentity = (source, review) => JSON.stringify([source.platform, source.market, source.shopId, review.reviewId]);

export function validateReview(review) {
  if (!object(review) || !text(review.reviewId) || !object(review.product) || !(review.product.productId === null || text(review.product.productId)) ||
      !(review.product.skuId === null || text(review.product.skuId)) ||
      !nullableText(review.product.title) || !nullableText(review.product.variant) ||
      !(review.rating === null || (Number.isInteger(review.rating) && review.rating >= 1 && review.rating <= 5)) ||
      typeof review.text !== "string" || !Array.isArray(review.attachments) || !nullableText(review.modifiedAt) ||
      !object(review.platformReply) || !Number.isInteger(review.platformReply.count) || review.platformReply.count < 0 ||
      typeof review.platformReply.canReply !== "boolean") {
    throw invalid("评价字段不完整或格式发生变化，请重新读取评价页。");
  }
  for (const attachment of review.attachments) {
    if (!["image", "video"].includes(attachment?.kind) || !text(attachment.url) || !/^https:\/\//i.test(attachment.url)) {
      throw invalid("评价附件类型或地址无法识别，未忽略该附件。", "MEDIA_UNAVAILABLE");
    }
  }
  if (!review.text.trim() && !review.attachments.length && review.rating === null) throw invalid("评价缺少可供生成的文字、附件或评分。");
  return review;
}

export function validateReviewBatch(batch) {
  if (!object(batch) || batch.source?.platform !== "tiktok_shop" || !["MY", "SG"].includes(batch.source.market) ||
      !text(batch.source.shopId) || !Array.isArray(batch.reviews) || !object(batch.pagination) ||
      ![batch.pagination.page, batch.pagination.pageSize].every(n => Number.isInteger(n) && n > 0) ||
      !Number.isInteger(batch.pagination.total) || batch.pagination.total < 0) {
    throw invalid("评价列表未完整加载，不能将读取失败视为没有评价。", "PAGE_INVALID");
  }
  batch.reviews.forEach(review => {
    validateReview(review);
    if (!text(review.product.productId)) throw invalid("平台评价缺少商品 ID。", "PAGE_INVALID");
  });
  const p = batch.pagination;
  if (Object.hasOwn(p, "complete") && (typeof p.complete !== "boolean" ||
      !Number.isInteger(p.readCount) || p.readCount !== batch.reviews.length ||
      !Number.isInteger(p.rawCount) || p.rawCount < p.readCount ||
      p.complete !== (p.readCount === p.total) || p.page < Math.ceil(p.total / p.pageSize))) {
    throw invalid("评价读取统计无效，不能将未完成分页视为完整读取。", "PAGE_INVALID");
  }
  return batch;
}
