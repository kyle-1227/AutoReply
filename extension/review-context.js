// Platform data validation shared by the reader and backend. No business Prompt.
function invalid(message, code = "INPUT_INVALID") {
  return Object.assign(new Error(message), { code });
}
const object = value => value && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && Boolean(value.trim());
const nullableText = value => value === null || typeof value === "string";
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
  return batch;
}
