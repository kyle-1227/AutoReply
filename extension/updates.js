import { $, sendMessage } from "./ui.js";
import { APP_VERSION } from "./protocol.js";
import { finishedUpdate } from "./update-protocol.js";

export function initializeUpdates({ componentVersion = () => null } = {}) {
  let candidate = null, busy = false, revision = -1, jobId = null;
  function render(update) {
    if (update.componentVersion) $("component-version").textContent = `v${update.componentVersion}`;
    if (update.version) $("latest-version").textContent = `v${update.version}`;
    const job = update.job || (update.jobId ? update : null);
    if (job && (job.jobId !== jobId || job.revision >= revision)) {
      jobId = job.jobId; revision = job.revision;
      busy = !finishedUpdate(job.phase);
      $("update-status").textContent = job.phase === "completed" && update.job && update.message ? update.message : job.message;
      $("update-progress").hidden = job.phase !== "downloading";
      $("update-progress").max = job.size || 1; $("update-progress").value = job.bytes || 0;
    } else $("update-status").textContent = update.message || "";
    if (!job || finishedUpdate(job.phase)) busy = false;
    $("install-update").disabled = busy || !candidate?.available || !candidate?.managed;
    $("install-update").textContent = busy ? "正在更新…" : "一键更新";
    $("check-component").disabled = busy;
    $("update-settings").inert = busy;
  }
  async function check() {
    if (busy) return;
    $("check-component").disabled = true; $("install-update").disabled = true;
    $("update-status").textContent = "正在检查正式版本和本机组件…";
    try { const result = await sendMessage({ type: "UPDATE_CHECK" }); candidate = result.update; render(candidate); }
    catch (error) { candidate = null; render({ message: error.message }); }
    finally { $("check-component").disabled = busy; }
  }
  $("open-updates").addEventListener("click", () => {
    $("extension-version").textContent = `v${APP_VERSION}`;
    $("component-version").textContent = componentVersion() ? `v${componentVersion()}` : "检查中…";
    $("update-dialog").showModal(); void check();
  });
  $("check-component").addEventListener("click", () => { void check(); });
  $("install-update").addEventListener("click", async () => {
    if (busy || !candidate?.available || !candidate.managed) return;
    busy = true; $("install-update").disabled = true; $("check-component").disabled = true;
    $("update-status").textContent = "正在准备更新，同机相关任务将保存并暂停…";
    try { const result = await sendMessage({ type: "UPDATE_START", version: candidate.version }); render(result.update); }
    catch (error) { busy = false; render({ message: error.message }); }
  });
  $("update-connection").addEventListener("toggle", async () => {
    if (!$("update-connection").open) return;
    try { const { settings } = await sendMessage({ type: "UPDATE_SETTINGS" }); $("bit-port").value = settings.port; $("bit-status").textContent = settings.hasToken ? "已保存认证信息。" : "未设置认证信息。"; }
    catch (error) { $("bit-status").textContent = error.message; }
  });
  $("update-settings").addEventListener("submit", async event => {
    event.preventDefault();
    const token = $("bit-token").value; $("bit-token").value = "";
    try { await sendMessage({ type: "UPDATE_SETTINGS", payload: { port: Number($("bit-port").value), token } }); $("bit-status").textContent = "连接设置已保存在本机组件。"; }
    catch (error) { $("bit-status").textContent = error.message; }
  });
  $("test-bit").addEventListener("click", async () => {
    $("test-bit").disabled = true;
    try { await sendMessage({ type: "UPDATE_TEST" }); $("bit-status").textContent = "BitBrowser Local API 连接正常。"; }
    catch (error) { $("bit-status").textContent = error.message; }
    finally { $("test-bit").disabled = false; }
  });
  chrome.runtime.onMessage.addListener(message => { if (message.type === "UPDATE_CHANGED") render(message.update); });
}
