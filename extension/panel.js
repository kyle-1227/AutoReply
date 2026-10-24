import { counts, MANUAL_REASON, isActive, isFinished, emptyTask } from "./model.js";
import { addFiles, releaseFile, releaseAllFiles, renderMedia } from "./media.js";
import { initializeProducts } from "./products.js";
import { $, element, sendMessage } from "./ui.js";
import { createQueue } from "./queue.js";
import { isReviewPage } from "./review-reader.js";
import { renderReviews } from "./review-list.js";

const tabs = ["tasks", "add", "manual"];
const enqueueDraft = createQueue();
const runLabels = { idle: "未开始", running: "运行中", paused: "已暂停", recovering: "页面恢复中", completed: "本轮完成", ended: "已结束" };

let state = null;
let context = null;
let productEditor = null;
let panelPort = null;
let initialized = false;
let activeTab = "tasks";
let lastReviewTab = "tasks";
let draftAttachments = [];
let draftWrites = Promise.resolve();
let controlBusy = false;
let pauseRequested = false;
let toastTimer;
let manualReviewId = null;
let mediaReviewId = null;
let readBusy = false;
let savingKey = false;

function notify(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
}

function onAction(callback) {
  return event => Promise.resolve(callback(event)).catch(error => notify(error.message));
}

function loadDraft(draft = {}) {
  $("review-text").value = draft.text || "";
  $("manual-check").checked = Boolean(draft.manual);
  $("manual-reason").value = draft.reason || "";
  updateManualField();
}

function applySnapshot(next, restoreDraft = false) {
  if (!next || (context?.contextId && next.contextId !== context.contextId)) return;
  if (next.busy && !next.state) {
    context = { ...context, ...next };
    renderAccess();
    return;
  }
  const changedTask = context?.taskId && context.taskId !== next.taskId;
  if (!changedTask && state && next.state.revision < state.revision) return;
  context = next;
  state = next.state;
  if (next.expired) {
    state = emptyTask();
    loadDraft(); productEditor?.restoreDraft();
    releaseAllFiles();
    draftAttachments = [];
    renderDraftMedia();
  }
  if (restoreDraft || changedTask) {
    loadDraft(next.draft);
    productEditor?.restoreDraft(next.productDraft);
  }
  if (changedTask) {
    releaseAllFiles();
    draftAttachments = [];
    renderDraftMedia();
  }
  render();
}

function request(type, fields = {}) {
  if (!context?.contextId) throw new Error("面板正在准备，请稍后重试。");
  return sendMessage({ type, contextId: context.contextId, taskId: context.taskId, ...fields });
}

async function command(name, payload) {
  const response = await request("COMMAND", { command: name, payload });
  applySnapshot(response.snapshot, ["IMPORT_LEGACY", "RESTORE_RECORD"].includes(name));
  return response.snapshot.state;
}

function switchTab(name, focus = false) {
  activeTab = name;
  const productsOpen = name === "products";
  if (!productsOpen) lastReviewTab = name;
  $("open-products").setAttribute("aria-expanded", String(productsOpen));
  for (const tab of tabs) {
    const selected = tab === name;
    $(`tab-${tab}`).setAttribute("aria-selected", String(selected));
    $(`tab-${tab}`).tabIndex = selected ? 0 : -1;
  }
  $("quick-add").hidden = name === "add";
  renderAccess();
  if (focus) (productsOpen ? $("product-name") : $(`tab-${name}`)).focus();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderAccess() {
  const blocked = Boolean(context?.busy || context?.valid === false);
  $("context-notice").hidden = !blocked;
  $("source-card").hidden = blocked || !context?.source;
  $("open-products").disabled = blocked || !initialized;
  $("suspend-button").disabled = blocked || !initialized;
  $("open-account").disabled = blocked || !initialized;
  $("save-account").disabled = savingKey || !context?.component?.canSaveKey || (state?.mode === "llm" && isActive(state));
  $("save-account").textContent = savingKey ? "正在保存…" : "保存 API Key";
  $("cancel-account").disabled = savingKey;
  $("account-key").disabled = savingKey;
  $("account-status").textContent = context?.component?.canSaveKey
    ? state?.mode === "llm" && isActive(state) ? "请先暂停生成任务，再更新 API Key。"
      : context.component.status === "ready" ? "当前电脑已配置 API Key。填写新 Key 可替换。" : "当前电脑尚未配置 API Key。"
    : context?.component?.status === "ready" || context?.component?.status === "missing-key"
      ? "请先更新本机组件，以支持在插件内保存 API Key。" : context?.component?.message || "正在检查本机组件…";
  $("read-reviews").disabled = blocked || !initialized || readBusy || state?.reading || isActive(state) || !isReviewPage(context?.source?.url);
  $("read-reviews").textContent = state?.reading ? "正在读取…" : "读取未回复";
  $("read-reviews").title = isReviewPage(context?.source?.url) ? "读取全部评分的未回复评价，不提交店铺回复" : "请在 TikTok Shop 马来西亚站或新加坡站商品评分页打开插件";
  document.querySelector(".tabs").hidden = blocked || activeTab === "products";
  for (const name of [...tabs, "products"]) $(`view-${name}`).hidden = blocked || name !== activeTab;
  // Keep Pause available while processing; idle forms have their own actions.
  document.querySelector(".control-dock").hidden = blocked ||
    (["add", "products"].includes(activeTab) && !isActive(state) && !state?.reading);
  if (blocked) {
    $("context-notice-title").textContent = context.busy ? "此窗口正在使用" : context.expired ? "记录已自动清理" : "来源页面已改变";
    $("context-notice-text").textContent = context.busy
      ? "任务仍绑定原评价页。请返回已有任务，或在新窗口开始其他任务。"
      : context.expired ? "本轮记录已超过保存时间。请在目标网页重新打开插件。"
      : "原任务已结束，记录已保存。请在目标网页点击工具栏的 AutoReply 图标重新打开。";
    $("context-return").hidden = !context.busy;
  } else if (context?.source) {
    $("source-label").textContent = context.bound ? "固定处理的页面" : "准备使用的页面";
    $("source-title").textContent = context.source.title;
    $("source-title").title = `${context.bound ? "固定处理" : "准备使用"}：${context.source.title}\n${context.source.url}`;
    $("source-url").textContent = context.source.url;
    $("source-url").title = context.source.url;
    $("end-button").hidden = !context.bound;
    $("end-button").disabled = controlBusy;
  }
}

function renderRecovery() {
  $("import-legacy").hidden = !context.legacyAvailable || context.bound || state.reviews.length > 0;
  $("retention-status").hidden = !context.expiresAt || !isFinished(state);
  $("retention-status").textContent = context.expiresAt ? `本轮记录于 ${new Date(context.expiresAt).toLocaleString()} 自动清理` : "";
  const history = context.history || [];
  $("recovery-controls").hidden = context.bound || !history.length;
  const selected = $("saved-records").value;
  $("saved-records").replaceChildren(...history.map(record => {
    const option = element("option", "", `${record.source.title || record.source.url} · ${runLabels[record.status]} · ${record.replied + (record.generated || 0)}/${record.total}`);
    option.value = record.id;
    return option;
  }));
  if (history.some(record => record.id === selected)) $("saved-records").value = selected;
}

function render() {
  if (!state) return;
  const totals = counts(state);
  $("component-status").textContent = context?.component?.message || "";
  const running = isActive(state) || state.reading;
  const displayStatus = pauseRequested ? "paused" : state.status;
  $("count-pending").textContent = state.reviews.filter(review => review.status === "pending").length;
  $("count-replied").textContent = totals.generated + totals.replied;
  $("result-count-label").textContent = state.mode === "llm" ? "已生成" : "模拟已回复";
  $("read-summary").textContent = state.reviewSource ? `店铺未回复 ${state.pagination?.total ?? 0} 条` : "";
  document.querySelectorAll('[data-command="SAMPLES"]').forEach(button => { button.hidden = state.mode === "llm"; });
  $("count-manual").textContent = totals.manual;
  $("manual-tab-count").textContent = totals.manual;
  $("manual-tab-count").hidden = !totals.manual;
  $("manual-page-count").textContent = `${totals.manual} 条`;
  $("run-status").textContent = pauseRequested ? "正在暂停" : state.reading ? "读取中" : state.callState?.status === "retry_wait" ? "重试等待中" : runLabels[state.status];
  $("run-status").dataset.status = displayStatus;
  $("task-empty").hidden = totals.total > 0;
  $("task-content").hidden = totals.total === 0;
  const processed = totals.replied + totals.generated + totals.manual;
  $("progress-value").textContent = `${processed}/${totals.total}`;
  const progress = totals.total ? processed / totals.total : 0;
  $("progress-percent").textContent = `${Math.round(progress * 100)}%`;
  $("progress-fill").style.transform = `scaleX(${progress})`;
  $("task-progress").setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  $("clear-button").disabled = running;
  $("error-banner").hidden = !state.error && !state.endReason;
  $("error-banner").textContent = state.error || state.endReason;
  const action = `${state.status === "paused" ? "继续" : "开始"}${state.mode === "llm" ? "生成" : "演示"}`;
  $("run-button").textContent = pauseRequested ? "正在暂停…" : running ? "立即暂停" : state.status === "completed" ? "本轮已完成" : action;
  $("run-button").disabled = controlBusy || (!running && !totals.pending && !(state.mode === "llm" && state.status === "paused")) || state.status === "completed";
  $("run-button").setAttribute("aria-label", pauseRequested ? "正在暂停" : running ? "立即暂停当前处理" : $("run-button").textContent);
  renderReviews(state, pauseRequested);
  renderRecovery();
  renderAccess();
}

function saveDraft() {
  const draft = {
    text: $("review-text").value,
    manual: $("manual-check").checked,
    reason: $("manual-reason").value,
  };
  draftWrites = enqueueDraft(() => request("COMMAND", { command: "DRAFT", payload: draft }));
  draftWrites.catch(() => {
    $("form-error").hidden = false;
    $("form-error").textContent = "文字草稿未能保存在本机，请重试或检查可用存储空间。";
  });
}

function renderDraftMedia() {
  $("attachment-count").textContent = `${draftAttachments.length} 个附件`;
  renderMedia($("draft-media"), draftAttachments, id => {
    draftAttachments = draftAttachments.filter(item => item.id !== id);
    releaseFile(id);
    renderDraftMedia();
  });
}

function receiveFiles(files) {
  const added = addFiles(files);
  draftAttachments.push(...added.attachments);
  renderDraftMedia();
  $("form-error").hidden = true;
  if (added.rejected.length) notify(`已跳过 ${added.rejected.length} 个文件，请选择图片或视频。`);
}

function updateManualField() {
  $("manual-reason-field").hidden = !$("manual-check").checked;
  $("add-button").textContent = $("manual-check").checked ? "加入待人工清单" : "加入待处理列表";
}

function showMedia(id) {
  const review = state.reviews.find(item => item.id === id);
  if (!review) return;
  mediaReviewId = id;
  $("reselect-button").hidden = Boolean(review.platformReview);
  renderMedia($("dialog-media"), review.attachments);
  $("media-dialog").showModal();
}

document.querySelector(".tabs").addEventListener("click", event => {
  const button = event.target.closest("[data-tab]");
  if (button) switchTab(button.dataset.tab, true);
});
$("open-products").addEventListener("click", () => switchTab("products", true));
$("open-account").addEventListener("click", () => {
  $("account-error").hidden = true;
  $("account-dialog").showModal();
});
$("account-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (savingKey) return;
  const input = $("account-key");
  const apiKey = input.value.trim();
  if (!apiKey) {
    $("account-error").textContent = "请填写 API Key。";
    $("account-error").hidden = false;
    input.focus();
    return;
  }
  savingKey = true;
  renderAccess();
  try {
    const result = await request("CREDENTIALS", { payload: { apiKey } });
    context.component = result.component;
    $("account-dialog").close();
    notify("API Key 已加密保存在当前电脑。");
  } catch (error) {
    $("account-error").textContent = error.message;
    $("account-error").hidden = false;
  } finally {
    input.value = "";
    savingKey = false;
    render();
  }
});
$("account-dialog").addEventListener("close", () => { $("account-key").value = ""; });
$("account-dialog").addEventListener("cancel", event => { if (savingKey) event.preventDefault(); });
$("products-back").addEventListener("click", () => switchTab(lastReviewTab, true));
$("suspend-button").addEventListener("click", onAction(async () => {
  $("suspend-button").disabled = true;
  try {
    await draftWrites;
    await productEditor?.prepareToClose();
    await request("SUSPEND");
  } finally { renderAccess(); }
}));
const suspendControl = document.querySelector(".suspend-control");
$("suspend-button").addEventListener("keydown", event => {
  if (event.key === "Escape") suspendControl.classList.add("tooltip-dismissed");
});
suspendControl.addEventListener("mouseleave", () => suspendControl.classList.remove("tooltip-dismissed"));
$("suspend-button").addEventListener("blur", () => suspendControl.classList.remove("tooltip-dismissed"));
document.querySelector(".tabs").addEventListener("keydown", event => {
  const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
  if (!keys.includes(event.key)) return;
  event.preventDefault();
  const current = tabs.indexOf(activeTab);
  const index = event.key === "Home" ? 0 : event.key === "End" ? 2 :
    (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  switchTab(tabs[index], true);
});

document.addEventListener("click", onAction(async event => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.dataset.go) switchTab(button.dataset.go, true);
  if (button.dataset.close) $(button.dataset.close).close();
  if (button.dataset.command) {
    button.disabled = true;
    try {
      await command(button.dataset.command);
      switchTab("tasks");
      notify("已添加 3 条演示评价，其中 1 条已标记待人工。");
    } finally { button.disabled = false; }
  }
  if (button.dataset.action === "media") showMedia(button.dataset.id);
  if (button.dataset.action === "manual") {
    manualReviewId = button.dataset.id;
    $("dialog-reason").value = "";
    $("manual-dialog").showModal();
  }
  if (button.dataset.action === "remove") {
    const review = state.reviews.find(item => item.id === button.dataset.id);
    await command("REMOVE", { id: review.id });
    review.attachments.forEach(item => releaseFile(item.id));
    notify("已移除这条评价。");
  }
}));

async function controlTask(action) {
  if (controlBusy || !state) return;
  controlBusy = true;
  pauseRequested = action !== "START";
  render();
  try {
    await command(action);
    if (action === "END") notify("任务已结束，此窗口可以开始其他任务。记录已保留。");
  }
  finally { controlBusy = false; pauseRequested = false; render(); }
}
$("run-button").addEventListener("click", onAction(() => controlTask(isActive(state) || state.reading ? "PAUSE" : "START")));
$("read-reviews").addEventListener("click", onAction(async () => {
  if (readBusy) return;
  readBusy = true;
  renderAccess();
  try {
    await command("READ_REVIEWS");
    switchTab("tasks");
    notify(`已读取 ${state.pagination.total} 条店铺未回复评价，仅生成回复，不自动发布。`);
  } finally { readBusy = false; renderAccess(); }
}));
$("end-button").addEventListener("click", onAction(() => controlTask("END")));

$("context-return").addEventListener("click", onAction(async () => {
  await request("RETURN_SOURCE", { taskId: context.busy.taskId });
}));

$("import-legacy").addEventListener("click", onAction(async () => {
  await command("IMPORT_LEGACY");
  notify("旧版记录已恢复，确认来源页后可继续演示。");
}));

$("restore-record").addEventListener("click", onAction(async () => {
  const id = $("saved-records").value;
  const record = context.history.find(item => item.id === id);
  if (!record || !confirm(`将“${record.source.title || record.source.url}”的记录恢复到当前页面？\n${context.source.url}\n恢复后等待手动开始，当前记录另行保留。`)) return;
  await draftWrites;
  await productEditor?.prepareToClose();
  await command("RESTORE_RECORD", { id });
  notify("记录已恢复到此页，点击开始或继续后才会运行。");
}));

$("review-filter").addEventListener("change", () => renderReviews(state, pauseRequested));
$("review-text").addEventListener("input", saveDraft);
$("manual-reason").addEventListener("input", saveDraft);
$("manual-check").addEventListener("change", () => { updateManualField(); saveDraft(); });
$("drop-zone").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", event => { receiveFiles(event.target.files); event.target.value = ""; });

// Prevent dropped files from navigating the extension away from the current task.
document.addEventListener("dragover", event => event.preventDefault());
document.addEventListener("drop", event => event.preventDefault());
$("drop-zone").addEventListener("dragenter", () => $("drop-zone").classList.add("drag-over"));
$("drop-zone").addEventListener("dragleave", event => {
  if (!$("drop-zone").contains(event.relatedTarget)) $("drop-zone").classList.remove("drag-over");
});
$("drop-zone").addEventListener("drop", event => {
  event.preventDefault();
  $("drop-zone").classList.remove("drag-over");
  receiveFiles(event.dataTransfer.files);
});

$("review-form").addEventListener("submit", onAction(async event => {
  event.preventDefault();
  const text = $("review-text").value.trim();
  if (!text && !draftAttachments.length) {
    $("form-error").textContent = "请填写评价文字，或添加至少一个图片／视频附件。";
    $("form-error").hidden = false;
    $("review-text").focus();
    return;
  }
  $("add-button").disabled = true;
  try {
    const manual = $("manual-check").checked;
    await command("ADD", {
      text,
      attachments: draftAttachments,
      manualReason: manual ? $("manual-reason").value.trim() || MANUAL_REASON : "",
    });
    draftAttachments = []; // Files remain available to the task preview for this session.
    $("review-form").reset();
    $("form-error").hidden = true;
    updateManualField();
    renderDraftMedia();
    saveDraft();
    switchTab(manual ? "manual" : "tasks", true);
    notify(manual ? "已加入待人工清单。" : "已加入待处理列表。");
  } finally { $("add-button").disabled = false; }
}));

$("manual-dialog-form").addEventListener("submit", onAction(async event => {
  event.preventDefault();
  await command("MANUAL", { id: manualReviewId, reason: $("dialog-reason").value });
  $("manual-dialog").close();
  notify("已标记待人工。");
}));

$("media-dialog").addEventListener("close", () => {
  $("dialog-media").querySelectorAll("video").forEach(video => video.pause());
});
$("reselect-button").addEventListener("click", () => $("reselect-input").click());
$("reselect-input").addEventListener("change", onAction(async event => {
  const added = addFiles(event.target.files);
  event.target.value = "";
  if (!added.attachments.length) {
    if (added.rejected.length) notify("请选择图片或视频文件。");
    return;
  }
  const review = state.reviews.find(item => item.id === mediaReviewId);
  try {
    await command("ATTACHMENTS", { id: mediaReviewId, attachments: added.attachments });
  } catch (error) {
    added.attachments.forEach(item => releaseFile(item.id));
    throw error;
  }
  review.attachments.forEach(item => releaseFile(item.id));
  renderMedia($("dialog-media"), added.attachments);
  if (added.rejected.length) notify(`已跳过 ${added.rejected.length} 个非图片／视频文件。`);
}));

$("clear-button").addEventListener("click", onAction(async () => {
  if (!confirm("清空本机全部评价和生成记录？此操作不会影响店铺。")) return;
  const attachments = state.reviews.flatMap(review => review.attachments);
  await command("CLEAR");
  attachments.forEach(item => releaseFile(item.id));
  notify("本机记录已清空。");
}));

chrome.runtime.onMessage.addListener(message => {
  if (message.type === "STATE_CHANGED" && context?.contextId === message.snapshot?.contextId) applySnapshot(message.snapshot);
});
window.addEventListener("pagehide", releaseAllFiles);

async function initialize() {
  const response = await sendMessage({ type: "HELLO" });
  applySnapshot(response.snapshot, true);
  if (context?.contextId) {
    connectPanel();
    productEditor = initializeProducts({ notify, request, initialDraft: context.productDraft });
  }
  initialized = true;
  document.querySelectorAll("[data-initializing]").forEach(node => { node.inert = false; });
  renderAccess();
}

function connectPanel() {
  if (panelPort || !context?.contextId || context.valid === false) return;
  try {
    panelPort = chrome.runtime.connect({ name: `panel:${context.contextId}` });
    panelPort.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      panelPort = null;
      setTimeout(connectPanel, 1000);
    });
  } catch { /* Reloading the extension invalidates this document; its records remain saved. */ }
}

initialize().catch(error => {
  $("error-banner").textContent = error.message;
  $("error-banner").hidden = false;
});
