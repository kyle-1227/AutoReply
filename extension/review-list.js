import { $, element, actionButton } from "./ui.js";
import { renderMedia, mediaKey } from "./media.js";
import { CATEGORY_SOURCE_NAMES, categoryName } from "./categories.js";
import { pendingReviews } from "./review-queue.js";
import { FAILURE_REASONS } from "./review-context.js";

const reviewLabels = { pending: "待处理", failed: "生成失败", generated: "已生成 · 待确认", replied: "模拟已回复", manual: "待人工" };
const groupLabels = { ...reviewLabels, pending: "剩余评价队列" };

let currentPreviewKey = "";
let renderedListKey = "";

// Render snapshots without owning or mutating task state.
export function renderReviews(state, pauseRequested = false) {
  const filter = $("review-filter").value;
  renderCurrent(state, pauseRequested, filter);
  renderLists(state, filter);
}

function renderReply(container, text) {
  container.hidden = !text;
  if (!text || container.lastElementChild?.textContent === text) return;
  const copy = element("p", "", text);
  container.replaceChildren(element("span", "field-caption", "生成回复"), copy);
}

function renderCurrent(state, pauseRequested, filter) {
  const current = state.reviews.find(review => review.id === state.currentId);
  $("current-card").hidden = !current || pauseRequested || !["all", "pending"].includes(filter);
  if ($("current-card").hidden) $("current-media").querySelectorAll("video").forEach(video => video.pause());
  if (!current) {
    if (currentPreviewKey) renderMedia($("current-media"), []);
    currentPreviewKey = "";
    return;
  }
  $("current-text").textContent = current.text || "这是一条仅包含图片／视频的评价。";
  $("current-product").textContent = productDescription(current);
  $("current-product").hidden = !current.platformReview;
  renderReply($("current-reply-box"), current.reply);
  $("current-media-button").hidden = !current.attachments.length;
  $("current-media-button").dataset.id = current.id;
  const key = `${current.id}:${mediaKey(current.attachments)}`;
  if (key !== currentPreviewKey) {
    renderMedia($("current-media"), current.attachments);
    currentPreviewKey = key;
  }
}

function productDescription(review) {
  const input = review.platformReview;
  return input ? [input.rating === null ? "评分未知" : `${input.rating} 星`, input.product.title, input.product.variant].filter(Boolean).join(" · ") : "";
}

function statusBadge(review) {
  const { status } = review;
  const label = status === "replied" && review.platformReview ? "已发布"
    : review.publishState === "uncertain" ? "发布待核对" : reviewLabels[status];
  const badge = element("span", "badge", label);
  badge.dataset.status = status;
  return badge;
}

function routingDescription(routing) {
  return [`首选模型：${routing.primaryModel}`, `回退模型：${routing.fallbackModel || "未调用"}`,
    `视频输入：${routing.videoOmitted ? "回退时已省略，未识别" : "已提供给视频模型"}`,
    ...routing.attempts.map(attempt => `${attempt.stage === "video" ? "视频模型" : "Haiku 回退"}：${attempt.outcome === "failed" ? FAILURE_REASONS[attempt.reasonCode] || "调用失败" : attempt.outcome === "manual" ? "转人工" : "生成成功"}${attempt.httpStatus ? `（HTTP ${attempt.httpStatus}）` : ""}${attempt.requestId ? `\n请求 ID：${attempt.requestId}` : ""}`)].join("\n");
}

function reviewCard(review, number, reading = false) {
  const card = element("article", "review-card");
  card.dataset.reviewId = review.id;
  if (review.platformReview) {
    card.append(element("p", "review-product", productDescription(review)));
    const identity = element("details", "review-provenance");
    identity.append(element("summary", "", "评价与商品编号"),
      element("p", "", `店铺 ID：${review.source.shopId}\n评价 ID：${review.platformReview.reviewId}\n商品 ID：${review.platformReview.product.productId}\nSKU ID：${review.platformReview.product.skuId ?? "未知"}`));
    card.append(identity);
  }
  if (number !== undefined) {
    const heading = element("div", "card-heading");
    heading.append(element("span", "review-number", `评价 ${String(number).padStart(2, "0")}`), statusBadge(review));
    card.append(heading);
  }
  // Pending queue items already show their full text in the expanded summary.
  if (number !== undefined || review.status !== "pending") {
    const text = element("p", "review-text", review.text || "仅图片／视频评价");
    card.append(text);
  }
  const actions = element("div", "card-actions");
  if (review.attachments.length) {
    actions.append(actionButton(`${review.attachments.length} 个附件 · 查看素材`, "media", review.id));
  }
  if (["pending", "failed"].includes(review.status)) {
    const buttons = element("div");
    if (review.status === "failed") {
      const retry = actionButton("重试", "retry", review.id);
      retry.disabled = reading;
      buttons.append(retry);
    }
    buttons.append(actionButton("转人工", "manual", review.id), actionButton("移除", "remove", review.id));
    actions.append(buttons);
  }
  if (actions.childElementCount) card.append(actions);
  if (review.reply) {
    const reply = element("div", "reply-box");
    renderReply(reply, review.reply);
    card.append(reply);
  }
  if (review.generationRecord) {
    const record = review.generationRecord, provenance = element("details", "review-provenance");
    provenance.append(element("summary", "", record.product ? "商品资料回复" : "通用回复"), element("p", "", `模型：${record.model}\n规则版本：${record.promptVersion || "旧版"}\n商品资料：${record.product ? `${record.product.name || record.product.id} / ${record.product.version}` : "无，通用回复"}`));
    if (Object.hasOwn(record, "categoryId")) provenance.append(element("p", "", `类目规则：${categoryName(record.categoryId)}\n类目来源：${CATEGORY_SOURCE_NAMES[record.categorySource] || "未记录"}`));
    if (record.routing) provenance.append(element("p", "", routingDescription(record.routing)));
    card.append(provenance);
  }
  if (review.failureRecord) {
    const failure = element("details", "review-provenance failure-details");
    failure.append(element("summary", "", "失败详情"), element("p", "", routingDescription(review.failureRecord.routing)));
    card.append(failure);
  }
  if (review.status === "manual") {
    const reason = element("div", "manual-reason");
    reason.append(element("strong", "", "标记原因"), element("span", "", review.manualReason));
    card.append(reason);
  }
  return card;
}

function queueItem(review, number, open, reading) {
  const item = element("details", "queue-item");
  item.dataset.reviewId = review.id;
  item.dataset.status = review.status;
  item.open = open;
  const summary = element("summary", "review-summary");
  const copy = element("span", "queue-copy");
  const snippet = element("span", "review-snippet", review.text || "仅图片／视频评价");
  if (review.status !== "pending") {
    const meta = element("span", "review-meta");
    meta.append(statusBadge(review), element("span", "review-number", `评价 ${String(number).padStart(2, "0")}`));
    copy.append(meta);
  }
  copy.append(snippet);
  const chevron = element("img", "icon queue-chevron");
  chevron.src = "icons/chevron-right.svg";
  chevron.alt = "";
  summary.append(copy);
  if (review.attachments.length) {
    const count = element("span", "attachment-summary");
    count.setAttribute("aria-label", `${review.attachments.length} 个附件`);
    const icon = element("img", "icon");
    icon.src = "icons/image.svg";
    icon.alt = "";
    count.append(icon, document.createTextNode(review.attachments.length));
    summary.append(count);
  }
  summary.append(chevron);
  item.append(summary);
  const showDetails = () => item.append(reviewCard(review, undefined, reading));
  if (open) showDetails();
  else item.addEventListener("toggle", showDetails, { once: true });
  return item;
}

function renderLists(state, filter) {
  const { reviews } = state;
  const key = JSON.stringify([filter, reviews, state.queueCursor, state.reading, state.mode]);
  if (key === renderedListKey) return; // Keep focus and disclosure state on unchanged snapshots.
  renderedListKey = key;
  const expanded = new Set([...$("review-list").querySelectorAll("details[data-review-id][open]")].map(item => item.dataset.reviewId));
  const focused = document.activeElement;
  const focusedReview = focused?.closest("details[data-review-id]")?.dataset.reviewId;
  const groups = { pending: [], failed: [], generated: [], replied: [], manual: [] };
  if (filter === "all" || filter === "pending") groups.pending = pendingReviews(state).map(review => ({ review }));
  reviews.forEach((review, index) => {
    if (review.status !== "pending") groups[review.status]?.push({ review, number: index + 1 });
  });
  const sections = [];
  for (const [status, baseLabel] of Object.entries(groupLabels)) {
    const label = status === "replied" && state.mode === "llm" ? "已发布" : baseLabel;
    if (filter !== "all" && filter !== status) continue;
    const items = groups[status];
    if (filter === "all" && status !== "pending" && !items.length) continue;
    const section = element("section", "queue-group");
    section.dataset.reviewGroup = status;
    const heading = element("h3", "group-heading", label);
    heading.id = `group-${status}`;
    heading.append(element("span", "group-count", items.length));
    section.setAttribute("aria-labelledby", heading.id);
    const header = element("div", "group-header");
    header.append(heading);
    if (status === "failed" && items.length) {
      const retry = actionButton("重试全部失败", "retry-all");
      retry.disabled = Boolean(state.reading);
      header.append(retry);
    }
    section.append(header);
    if (items.length) section.append(...items.map(({ review, number }) => queueItem(review, number, expanded.has(review.id), state.reading)));
    else section.append(element("p", "queue-empty", `暂无${status === "pending" ? "待处理" : label}评价`));
    sections.push(section);
  }
  $("review-list").replaceChildren(...sections);
  $("manual-list").replaceChildren(...groups.manual.map(({ review, number }) => reviewCard(review, number)));
  $("manual-empty").hidden = groups.manual.length > 0;
  if (focusedReview) {
    const row = [...$("review-list").querySelectorAll("details[data-review-id]")].find(item => item.dataset.reviewId === focusedReview);
    const target = focused.dataset.action ? [...(row?.querySelectorAll("button") || [])].find(button => button.dataset.action === focused.dataset.action) : row?.firstElementChild;
    target?.focus({ preventScroll: true });
  }
}
