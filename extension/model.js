// Shared, serializable data. Media files themselves never enter this model.
export const TASK_KEY = "autoreply.task.v1";
export const DRAFT_KEY = "autoreply.draft.v1";
export const WAKE_ALARM = "autoreply.demo.wake";
export const WORKSPACE_KEY = "autoreply.workspace.v2";
export const BINDINGS_KEY = "autoreply.bindings.v2";
export const PRODUCTS_KEY = "autoreply.products.v1";
export const PHASES = ["读取评价", "生成示例回复", "模拟回复"];
export const STEP_MS = 1800;
export const MANUAL_REASON = "运营手动标记，待人工后续处理。";
export const isActive = task => ["running", "recovering"].includes(task?.status);

export function emptyTask() {
  return {
    version: 1,
    revision: 0,
    status: "idle",
    reviews: [],
    currentId: null,
    phase: 0,
    nextStepAt: null,
    error: "",
    generation: 0,
    endReason: "",
  };
}

export function newReview({ text = "", attachments = [], manualReason = "" }) {
  const cleanText = String(text).trim();
  const cleanReason = String(manualReason).trim();
  if (!cleanText && !attachments.length) {
    throw new Error("请填写评价文字，或添加至少一个图片／视频附件。");
  }
  return {
    id: crypto.randomUUID(),
    text: cleanText,
    attachments: attachments.map(({ id, name, type, size }) => ({ id, name, type, size })),
    status: cleanReason ? "manual" : "pending",
    manualReason: cleanReason,
    reply: "",
    createdAt: Date.now(),
    completedAt: null,
  };
}

export function counts(task) {
  return task.reviews.reduce((result, review) => {
    result.total += 1;
    if (review.status === "pending" || review.status === "processing") result.pending += 1;
    if (review.status === "replied") result.replied += 1;
    if (review.status === "manual") result.manual += 1;
    return result;
  }, { total: 0, pending: 0, replied: 0, manual: 0 });
}

export function floatingSummary(task) {
  const totals = counts(task);
  return {
    revision: task.revision,
    status: task.status,
    completed: totals.replied,
    total: totals.total - totals.manual,
    manual: totals.manual,
    error: Boolean(task.error),
  };
}

export function demoReviews() {
  return [
    newReview({ text: "The parcel arrived today. The fabric feels soft and the colour matches the photos." }),
    newReview({ text: "The size runs a little smaller than I expected, but the stitching looks neat." }),
    newReview({
      text: "I received a different item. Could someone help me check my order?",
      manualReason: "人工核对订单。",
    }),
  ];
}

export function demoReply(review) {
  // Deliberately fixed copy: this prototype makes no model or media-analysis claims.
  return review.text
    ? "Thank you for taking the time to share your experience. We appreciate your feedback and will share it with our team."
    : "Thank you for sharing your photos or video. We appreciate you taking the time to leave a review.";
}
