// Status overlay only. Never reads the host page's business content.
(() => {
  globalThis.__autoreplyFloating?.destroy();
  document.getElementById("autoreply-floating-badge")?.remove();
  const host = document.createElement("div");
  host.id = "autoreply-floating-badge";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial !important; position: fixed !important; z-index: 2147483647 !important; left: var(--autoreply-left, auto) !important; right: var(--autoreply-right, 20px) !important; top: var(--autoreply-top, 40%) !important; display: block !important; width: max-content !important; color-scheme: light !important; }
    * { box-sizing: border-box; }
    button { display: flex; flex-direction: column; align-items: center; gap: 7px; min-width: 116px; max-width: 180px; padding: 12px; border: 1px solid #e5e9e6; border-radius: 10px; background: #fff; color: #252b2a; font: 13px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif; box-shadow: 0 2px 10px rgba(32,42,33,.06); cursor: grab; touch-action: none; user-select: none; }
    button:hover { border-color: #b5c3b5; }
    button:focus-visible { outline: 2px solid #52735e; outline-offset: 3px; }
    button:active { cursor: grabbing; }
    .logo { position: relative; display: grid; place-items: center; width: 44px; height: 44px; margin-bottom: 2px; padding-bottom: 6px; border-radius: 10px; color: #fff; background: #252b2a; font-size: 39px; font-weight: 600; line-height: 1; }
    .logo i { position: absolute; right: 6px; top: 7px; width: 6px; height: 6px; background: #bccfbb; border-radius: 1px; }
    .completion, .manual { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .completion { color: #386650; }
    .manual { color: #68716e; }
    .manual.has-manual { color: #8b651b; }
    .completion.paused { color: #8b651b; }
    .completion.error { color: #a34d40; }
    .error-message { max-width: 156px; color: #a34d40; font-size: 13px; }
    [hidden] { display: none; }
  `;
  const button = document.createElement("button");
  button.type = "button";
  button.title = "点击打开侧边栏，拖动调整位置";
  const logo = document.createElement("span");
  logo.className = "logo";
  logo.setAttribute("aria-hidden", "true");
  logo.textContent = "a";
  logo.append(document.createElement("i"));
  const completion = document.createElement("span");
  completion.className = "completion";
  const manual = document.createElement("span");
  manual.className = "manual";
  const errorMessage = document.createElement("span");
  errorMessage.className = "error-message";
  errorMessage.setAttribute("role", "alert");
  errorMessage.hidden = true;
  button.append(logo, completion, manual, errorMessage);
  root.append(style, button);
  let revision = -1;
  let taskId = null;
  let drag = null;
  let suppressClick = false;
  let opening = false;

  function render(summary) {
    if (!summary || summary.revision < revision) return;
    revision = summary.revision;
    const labels = { idle: "未开始", running: "进行中", paused: "已暂停", recovering: "恢复中", completed: "已完成", ended: "已结束" };
    completion.textContent = `${summary.error ? "处理异常" : labels[summary.status] || "未开始"} ${summary.completed}/${summary.total}`;
    completion.className = `completion${summary.status === "paused" ? " paused" : ""}${summary.error ? " error" : ""}`;
    manual.textContent = `待人工 ${summary.manual}`;
    manual.classList.toggle("has-manual", summary.manual > 0);
    button.setAttribute("aria-label", `打开 AutoReply 侧边栏，${completion.textContent}，${manual.textContent}`);
  }

  function place(left, top) {
    const rect = host.getBoundingClientRect();
    const x = Math.max(8, Math.min(left, innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(top, innerHeight - rect.height - 8));
    // Custom properties cross the shadow boundary; outer inline positioning
    // cannot override the shadow host's important isolation rules.
    host.style.setProperty("--autoreply-left", `${x}px`);
    host.style.setProperty("--autoreply-top", `${y}px`);
    host.style.setProperty("--autoreply-right", "auto");
  }

  function resize() {
    const rect = host.getBoundingClientRect();
    place(rect.left, rect.top);
  }

  button.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    const rect = host.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    suppressClick = false;
    button.setPointerCapture(event.pointerId);
  });
  button.addEventListener("pointermove", event => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 5) drag.moved = true;
    if (drag.moved) place(drag.left + dx, drag.top + dy);
  });
  button.addEventListener("pointerup", () => {
    suppressClick = Boolean(drag?.moved);
    drag = null;
  });
  button.addEventListener("pointercancel", () => { drag = null; suppressClick = false; });
  button.addEventListener("click", async event => {
    if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
    if (opening) return;
    opening = true;
    errorMessage.hidden = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "FLOATING_RESTORE", taskId });
      if (!response?.ok) throw new Error();
    } catch {
      errorMessage.textContent = "请点击工具栏中的 AutoReply 图标重新打开。";
      errorMessage.hidden = false;
      resize();
    } finally { opening = false; }
  });

  function destroy() {
    host.remove();
    try { chrome.runtime.onMessage.removeListener(receive); }
    catch { /* The extension may have been reloaded while this page stayed open. */ }
    window.removeEventListener("resize", resize);
    window.removeEventListener("pagehide", destroy);
    delete globalThis.__autoreplyFloating;
  }

  function receive(message, sender, respond) {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === "FLOATING_SHOW") {
      if (taskId !== message.taskId) revision = -1;
      taskId = message.taskId;
      render(message.summary);
      if (!host.isConnected) {
        document.documentElement.append(host);
        resize();
      }
      respond({ ok: true });
    } else if (message.type === "FLOATING_UPDATE") {
      if (taskId !== message.taskId) return;
      render(message.summary);
      respond({ ok: true });
    } else if (message.type === "FLOATING_HIDE") {
      destroy();
      respond({ ok: true });
    }
  }

  chrome.runtime.onMessage.addListener(receive);
  window.addEventListener("resize", resize);
  window.addEventListener("pagehide", destroy, { once: true });
  globalThis.__autoreplyFloating = { destroy };
})();
