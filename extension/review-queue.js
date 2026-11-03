// The stored array keeps arrival order. Execution and UI share this derived view.
export const reviewProductId = review => review?.platformReview?.product.productId || null;

export function pendingReviews(state) {
  const pending = state.reviews.filter(review => review.status === "pending");
  if (state.mode !== "llm") return pending;
  const groups = new Map();
  for (const review of pending) {
    const key = reviewProductId(review) || review;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(review);
  }
  const interrupted = pending.find(review => review.id === state.queueCursor?.reviewId);
  const key = interrupted ? reviewProductId(interrupted) || interrupted : state.queueCursor?.productId;
  const active = groups.get(key) || [];
  groups.delete(key);
  return [...(interrupted ? [interrupted, ...active.filter(review => review !== interrupted)] : active), ...[...groups.values()].flat()];
}
