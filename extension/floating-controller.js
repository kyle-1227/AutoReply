import { floatingSummary } from "./model.js";
import { createQueue } from "./queue.js";

/** UI only: moving a badge never changes the task's source tab. */
export class FloatingController {
  constructor(browser) {
    this.browser = browser;
    this.locations = new Map();
    this.enqueue = createQueue();
  }

  async remove(windowId) {
    const previous = this.locations.get(windowId);
    if (!previous) return;
    this.locations.delete(windowId);
    await this.browser.tabs.sendMessage(previous.tabId, { type: "FLOATING_HIDE" }, { frameId: 0 }).catch(() => {});
  }

  hide(windowId) { return this.enqueue(() => this.remove(windowId)); }

  show(windowId, taskId, task) {
    return this.enqueue(async () => {
      const [tab] = await this.browser.tabs.query({ active: true, windowId });
      const previous = this.locations.get(windowId);
      if (!tab || !/^https?:\/\//.test(tab.url || "")) {
        await this.remove(windowId);
        return false;
      }
      const message = { taskId, summary: floatingSummary(task) };
      if (previous?.tabId === tab.id && previous.taskId === taskId) {
        try {
          await this.browser.tabs.sendMessage(tab.id, { type: "FLOATING_UPDATE", ...message }, { frameId: 0 });
          return true;
        } catch { /* Reloaded pages need a fresh isolated content script. */ }
      }
      await this.remove(windowId);
      try {
        await this.browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["floating.js"] });
        await this.browser.tabs.sendMessage(tab.id, { type: "FLOATING_SHOW", ...message }, { frameId: 0 });
        this.locations.set(windowId, { tabId: tab.id, taskId });
        return true;
      } catch {
        await this.browser.tabs.sendMessage(tab.id, { type: "FLOATING_HIDE" }, { frameId: 0 }).catch(() => {});
        return false; // Restricted pages must never pause the source task.
      }
    });
  }

  forget(tabId) {
    return this.enqueue(async () => {
      for (const [windowId, location] of this.locations) {
        if (location.tabId === tabId) await this.remove(windowId);
      }
    });
  }

  owns(windowId, tabId, taskId) {
    const location = this.locations.get(windowId);
    return location?.tabId === tabId && location.taskId === taskId;
  }
}
