import { $, sendMessage } from "./ui.js";
let taskId;

async function initialize() {
  if (new URL(location.href).searchParams.has("restricted")) {
    $("busy-title").textContent = "请打开普通网页";
    $("busy-description").textContent = "浏览器内部页面不能作为任务来源。请前往需要处理评价的网页，再点击插件图标。";
    $("return-source").hidden = true;
    return;
  }
  const response = await sendMessage({ type: "BUSY_STATE" });
  if (!response.busy) {
    $("busy-title").textContent = "窗口已空闲";
    $("busy-description").textContent = "原任务已经完成或结束，请关闭此提醒，再点击插件图标。";
    $("return-source").hidden = true;
    return;
  }
  taskId = response.busy.taskId;
  $("busy-description").textContent = response.busy.sourceAway ? "来源页已离开，等待返回。此任务仍占用窗口，返回评价页后手动继续。" : response.busy.status === "paused"
    ? "原任务已暂停，仍占用此窗口。可返回继续，或结束任务后使用其他页面。"
    : "原任务继续在来源页处理。可返回查看进度，或在新窗口开始其他任务。";
  $("busy-source").textContent = response.busy.title;
  $("return-source").textContent = response.busy.sourceAway ? "返回评价页" : "返回任务页";
  $("return-source").disabled = false;
}

$("return-source").addEventListener("click", async () => {
  $("return-source").disabled = true;
  try {
    await sendMessage({ type: "RETURN_SOURCE", taskId });
    window.close();
  } catch (error) {
    $("busy-error").hidden = false;
    $("busy-error").textContent = error.message;
    $("return-source").disabled = false;
  }
});
initialize().catch(error => {
  $("busy-error").hidden = false;
  $("busy-error").textContent = error.message;
});
