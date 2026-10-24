import { $, element } from "./ui.js";
import { renderMedia, mediaKey } from "./media.js";

const reviewLabels = { pending: "待处理", generated: "已生成 · 待确认", replied: "模拟已回复", manual: "待人工" };
const groupLabels = { ...reviewLabels, pending: "剩余评价队列" };

let currentPreviewKey = "";
let renderedListKey = "";

// Render snapshots without owning or mutating task state.
export function renderReviews(state, pauseRequested = false) {
  const filter = $("review-filter").value;
  renderCurrent(state, pauseRequested, filter);
  renderLists(state.reviews, filter);
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

function reviewAction(label, action, id) {
  const button = element("button", "button text-button", label);
  button.type = "button";
  button.dataset.action = action;
  button.dataset.id = id;
  return button;
}

function productDescription(review) {
  const input = review.platformReview;
  return input ? [input.rating === null ? "评分未知" : `${input.rating} 星`, input.product.title, input.product.variant].filter(Boolean).join(" · ") : "";
}

function statusBadge(status) {
  const badge = element("span", "badge", reviewLabels[status]);
  badge.dataset.status = status;
  return badge;
}

function reviewCard(review, number) {
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
    heading.append(element("span", "review-number", `评价 ${String(number).padStart(2, "0")}`), statusBadge(review.status));
    card.append(heading);
  }
  // Pending queue items already show their full text in the expanded summary.
  if (number !== undefined || review.status !== "pending") {
    const text = element("p", "review-text", review.text || "仅图片／视频评价");
    card.append(text);
  }
  const actions = element("div", "card-actions");
  if (review.attachments.length) {
    actions.append(reviewAction(`${review.attachments.length} 个附件 · 查看素材`, "media", review.id));
  }
  if (review.status === "pending") {
    const buttons = element("div");
    buttons.append(reviewAction("转人工", "manual", review.id), reviewAction("移除", "remove", review.id));
    actions.append(buttons);
  }
  if (actions.childElementCount) card.append(actions);
  if (review.reply && ["replied", "generated"].includes(review.status)) {
    const reply = element("div", "reply-box");
    renderReply(reply, review.reply);
    card.append(reply);
  }
  if (review.generationRecord) {
    const record = review.generationRecord, provenance = element("details", "review-provenance");
    provenance.append(element("summary", "", record.product ? "商品资料回复" : "通用回复"), element("p", "", `模型：${record.model}\n规则版本：${record.promptVersion || "旧版"}\n商品资料：${record.product ? `${record.product.name || record.product.id} / ${record.product.version}` : "无，通用回复"}`));
    card.append(provenance);
  }
  if (review.status === "manual") {
    const reason = element("div", "manual-reason");
    reason.append(element("strong", "", "标记原因"), element("span", "", review.manualReason));
    card.append(reason);
  }
  return card;
}

function queueItem(review, number, open) {
  const item = element("details", "queue-item");
  item.dataset.reviewId = review.id;
  item.dataset.status = review.status;
  item.open = open;
  const summary = element("summary", "review-summary");
  const copy = element("span", "queue-copy");
  const snippet = element("span", "review-snippet", review.text || "仅图片／视频评价");
  if (review.status !== "pending") {
    const meta = element("span", "review-meta");
    meta.append(statusBadge(review.status), element("span", "review-number", `评价 ${String(number).padStart(2, "0")}`));
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
  item.append(summary, reviewCard(review));
  return item;
}

function renderLists(reviews, filter) {
  const key = JSON.stringify([filter, reviews]);
  if (key === renderedListKey) return; // Keep focus and disclosure state on unchanged snapshots.
  renderedListKey = key;
  const expanded = new Set([...$("review-list").querySelectorAll("details[data-review-id][open]")].map(item => item.dataset.reviewId));
  const groups = { pending: [], generated: [], replied: [], manual: [] }, manual = [];
  reviews.forEach((review, index) => {
    groups[review.status]?.push(queueItem(review, index + 1, expanded.has(review.id)));
    if (review.status === "manual") manual.push(reviewCard(review, index + 1));
  });
  const sections = [];
  for (const [status, label] of Object.entries(groupLabels)) {
    if (filter !== "all" && filter !== status) continue;
    const items = groups[status];
    if (filter === "all" && status !== "pending" && !items.length) continue;
    const section = element("section", "queue-group");
    section.dataset.reviewGroup = status;
    const heading = element("h3", "group-heading", label);
    heading.id = `group-${status}`;
    heading.append(element("span", "group-count", items.length));
    section.setAttribute("aria-labelledby", heading.id);
    section.append(heading, ...(items.length ? items : [element("p", "queue-empty", `暂无${status === "pending" ? "待处理" : label}评价`)]));
    sections.push(section);
  }
  $("review-list").replaceChildren(...sections);
  $("manual-list").replaceChildren(...manual);
  $("manual-empty").hidden = manual.length > 0;
}
