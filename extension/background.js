import { WAKE_ALARM } from "./model.js";
import { TaskCoordinator, ordinaryPage, panelPath } from "./task-coordinator.js";
import { FloatingController } from "./floating-controller.js";
import { createQueue } from "./queue.js";
import { CATALOG_PREFIX } from "./product-catalog.js";

const floating = new FloatingController(chrome);
const configured = new Map();
const uiJobs = new Map();
const panelPorts = new Map();
const coordinator = new TaskCoordinator({
  browser: chrome,
  onChange: snapshot => chrome.runtime.sendMessage({ type: "STATE_CHANGED", snapshot }).catch(() => {}),
  onWindowChange: windowId => syncWindow(windowId),
  runnerOptions: { wakeup: () => syncAlarm() },
});

async function syncAlarm() {
  // Also expires completed records while every panel is closed.
  if (!await chrome.alarms.get(WAKE_ALARM)) await chrome.alarms.create(WAKE_ALARM, { periodInMinutes: 0.5 });
}

async function configureTab(tab) {
  const owner = coordinator.owner(tab.windowId);
  const blocked = owner && owner.tabId !== tab.id;
  const options = { tabId: tab.id, path: panelPath(tab), enabled: ordinaryPage(tab) && !blocked };
  const popup = blocked ? `busy.html?windowId=${tab.windowId}&taskId=${owner.taskId}` : "";
  const key = JSON.stringify([options, popup]);
  if (configured.get(tab.id) !== key) {
    await chrome.sidePanel.setOptions(options);
    await chrome.action.setPopup({ tabId: tab.id, popup });
    configured.set(tab.id, key);
  }
  const state = owner && coordinator.runner(owner.taskId).state;
  const label = state ? ({ running: "运行", paused: "暂停", recovering: "恢复" }[state.status] || "") : "";
  await chrome.action.setBadgeText({ tabId: tab.id, text: label });
  await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: state?.status === "running" ? "#386650" : "#8b651b" });
  await chrome.action.setTitle({ tabId: tab.id, title: owner
    ? `AutoReply · ${label} · ${owner.title} · 点击返回原任务`
    : "打开 AutoReply 侧边栏" });
}

// UI work is serialized per window, independently of task execution.
function syncWindow(windowId) {
  if (!uiJobs.has(windowId)) uiJobs.set(windowId, createQueue());
  return uiJobs.get(windowId)(async () => {
    const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
    await Promise.all(tabs.map(tab => configureTab(tab).catch(() => {})));
    const active = tabs.find(tab => tab.active);
    const context = coordinator.floatingContext(windowId);
    const panels = context ? await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }) : [];
    // Edge reports -1 for side-panel tab/window IDs, so compare the trusted URL.
    const visible = context && panels.some(panel => panel.documentUrl === chrome.runtime.getURL(panelPath({ id: context.tabId, windowId })));
    if (!context || (context.panelOpen && active?.id === context.tabId && visible)) await floating.hide(windowId);
    else await floating.show(windowId, context.taskId, coordinator.runner(context.taskId).snapshot());
  });
}

const ready = (async () => {
  if (!chrome.sidePanel.onClosed) throw new Error("请使用 Edge 142 或更新版本；当前版本缺少侧边栏关闭事件。");
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  await chrome.sidePanel.setOptions({ enabled: false });
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await coordinator.initialize();
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  await Promise.all(windows.map(window => syncWindow(window.id)));
  await syncAlarm();
})();
const afterReady = job => ready.then(job).catch(console.error);

function reply(operation, respond) {
  operation.then(result => respond({ ok: true, ...result }))
    .catch(error => respond({ ok: false, error: error.message }));
  return true; // Keep the browser's response channel open for asynchronous work.
}

function panelIdentity(sender, message, initial = false) {
  const url = new URL(sender.url || "about:blank");
  if (url.origin !== new URL(chrome.runtime.getURL("/")).origin || url.pathname !== "/panel.html") {
    throw new Error("请从插件侧边栏进行操作。");
  }
  const tabId = Number(url.searchParams.get("tabId"));
  const windowId = Number(url.searchParams.get("windowId"));
  if (!url.searchParams.has("tabId") || !url.searchParams.has("windowId") || !Number.isInteger(tabId) || !Number.isInteger(windowId)) {
    throw new Error("面板缺少来源页，请在目标网页点击工具栏的 AutoReply 图标重新打开。");
  }
  if (!initial) {
    const context = coordinator.require(message.contextId, message.taskId);
    if (context.tabId !== tabId || context.windowId !== windowId) throw new Error("这个操作不属于当前页面的任务。");
    return context;
  }
  return { tabId, windowId };
}

function returnToSource(taskId, windowId) {
  const context = coordinator.contextForTask(taskId);
  if (!context || context.windowId !== windowId) return Promise.reject(new Error("原任务已结束或来源页已关闭，请重新打开插件。"));
  // Invoke both APIs directly in the click's user gesture; no storage awaits here.
  const activation = chrome.tabs.update(context.tabId, { active: true });
  const opening = chrome.sidePanel.open({ tabId: context.tabId });
  return Promise.all([activation, opening]).then(() => coordinator.panelVisibility(context.tabId, true));
}

chrome.action.onClicked.addListener(tab => {
  const owner = coordinator.owner(tab.windowId);
  if ((owner && owner.tabId !== tab.id) || !ordinaryPage(tab)) {
    const popup = owner ? `busy.html?windowId=${tab.windowId}&taskId=${owner.taskId}` : "busy.html?restricted=1";
    chrome.action.setPopup({ tabId: tab.id, popup }).catch(console.error);
    chrome.action.openPopup({ windowId: tab.windowId }).catch(console.error);
    return;
  }
  // Configure using only this trusted toolbar event, before any storage work.
  if (!configured.has(tab.id)) {
    chrome.sidePanel.setOptions({ tabId: tab.id, path: panelPath(tab), enabled: true }).catch(console.error);
  }
  chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "FLOATING_RESTORE") {
    if (!sender.tab || sender.frameId !== 0 || !floating.owns(sender.tab.windowId, sender.tab.id, message.taskId)) return;
    return reply(returnToSource(message.taskId, sender.tab.windowId), respond);
  }
  if (message?.type === "RETURN_SOURCE") {
    try {
      const url = new URL(sender.url);
      const isBusy = url.href.startsWith(chrome.runtime.getURL("busy.html?"));
      const windowId = isBusy ? Number(url.searchParams.get("windowId")) : panelIdentity(sender, message, true).windowId;
      if (isBusy && url.searchParams.get("taskId") !== message.taskId) throw new Error("提醒中的任务已改变，请重新点击插件图标。");
      return reply(returnToSource(message.taskId, windowId), respond);
    } catch (error) { respond({ ok: false, error: error.message }); }
    return true;
  }
  const types = new Set(["HELLO", "COMMAND", "SUSPEND", "PRODUCTS", "BUSY_STATE", "CREDENTIALS"]);
  if (!types.has(message?.type)) return;
  const operation = async () => {
    await ready;
    if (message.type === "BUSY_STATE") {
      const url = new URL(sender.url || "about:blank");
      if (!url.href.startsWith(chrome.runtime.getURL("busy.html?"))) throw new Error("无法读取窗口状态。");
      const owner = coordinator.owner(Number(url.searchParams.get("windowId")));
      return { busy: owner ? coordinator.busySummary(owner) : null };
    }
    if (message.type === "HELLO") {
      const identity = panelIdentity(sender, message, true);
      const snapshot = await coordinator.open(identity.tabId, identity.windowId);
      void coordinator.checkComponent();
      return { snapshot };
    }
    const context = panelIdentity(sender, message);
    if (message.type === "CREDENTIALS") return coordinator.saveKey(context, message.payload);
    if (message.type === "SUSPEND") {
      await chrome.sidePanel.close({ tabId: context.tabId });
      await coordinator.panelVisibility(context.tabId, false);
      return {};
    }
    if (message.type === "PRODUCTS") {
      const result = await coordinator.products(context, message.action, message.payload || {});
      if (!["LIST", "EXPORT"].includes(message.action)) chrome.runtime.sendMessage({ type: "PRODUCTS_CHANGED", shop: result.shop }).catch(() => {});
      return result;
    }
    if (message.command === "READ_REVIEWS") return { snapshot: await coordinator.read(context.id, context.taskId) };
    const commands = ["GET_STATE", "START", "PAUSE", "END", "ADD", "SAMPLES", "MANUAL", "ATTACHMENTS", "REMOVE", "CLEAR", "DRAFT", "PRODUCT_DRAFT", "IMPORT_LEGACY", "RESTORE_RECORD"];
    if (!commands.includes(message.command)) throw new Error("无法识别这个操作。");
    return { snapshot: await coordinator.command(context.id, context.taskId, message.command, message.payload) };
  };
  return reply(operation(), respond);
});

// Edge versions can expose onClosed without emitting it for the native X.
// A document's port disconnect provides the same lifecycle signal.
chrome.runtime.onConnect.addListener(port => {
  if (!port.name.startsWith("panel:") || port.sender?.id !== chrome.runtime.id) return;
  const contextId = port.name.slice(6);
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
    if (panelPorts.get(contextId) !== port) return;
    panelPorts.delete(contextId);
    const context = coordinator.contexts.get(contextId);
    if (context) coordinator.panelVisibility(context.tabId, false).catch(console.error);
  });
  ready.then(() => {
    const context = coordinator.contexts.get(contextId);
    if (!context || disconnected) return;
    panelIdentity(port.sender, { contextId, taskId: context.taskId });
    panelPorts.set(contextId, port);
  }).catch(() => port.disconnect());
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === WAKE_ALARM) afterReady(() => coordinator.wake());
});
chrome.runtime.onStartup.addListener(() => ready.catch(console.error));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.keys(changes).some(key => key.startsWith(CATALOG_PREFIX))) return;
  afterReady(async () => {
    await coordinator.catalogChanged(changes);
    await chrome.runtime.sendMessage({ type: "PRODUCTS_CHANGED" }).catch(() => {});
  });
});
chrome.runtime.onInstalled.addListener(() => ready.catch(console.error));
chrome.sidePanel.onOpened?.addListener(info => {
  if (Number.isInteger(info.tabId)) afterReady(() => coordinator.panelVisibility(info.tabId, true));
});
chrome.sidePanel.onClosed?.addListener(info => {
  if (Number.isInteger(info.tabId)) afterReady(() => coordinator.panelVisibility(info.tabId, false));
});
chrome.tabs.onActivated.addListener(info => {
  afterReady(() => syncWindow(info.windowId));
});
chrome.tabs.onCreated.addListener(tab => {
  afterReady(() => syncWindow(tab.windowId));
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  // Navigation clears Edge's tab-specific action state, including busy popups.
  if (change.url || change.status) configured.delete(tabId);
  // Invalidate source callbacks at event delivery, before waiting for UI work.
  const update = coordinator.tabUpdated(tabId, change, tab);
  afterReady(async () => {
    await update;
    if (change.status === "complete") await floating.forget(tabId);
    await syncWindow(tab.windowId);
  });
});
chrome.tabs.onRemoved.addListener(tabId => {
  configured.delete(tabId);
  const closing = coordinator.closeTab(tabId);
  afterReady(async () => { await closing; await floating.forget(tabId); });
});
chrome.tabs.onDetached.addListener(tabId => {
  configured.delete(tabId);
  coordinator.closeTab(tabId).catch(console.error);
});
chrome.tabs.onAttached.addListener((tabId, info) => {
  afterReady(() => syncWindow(info.newWindowId));
});
chrome.windows.onRemoved.addListener(windowId => {
  const closing = coordinator.closeWindow(windowId);
  afterReady(async () => { await closing; await floating.hide(windowId); uiJobs.delete(windowId); });
});
ready.catch(console.error);
