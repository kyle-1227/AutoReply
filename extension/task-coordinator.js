import { BINDINGS_KEY, counts } from "./model.js";
import { TaskRunner } from "./task-runner.js";
import { WorkspaceStore, createRecord } from "./workspace-store.js";
import { createQueue } from "./queue.js";
import { readReviews } from "./review-reader.js";
import { generateReply } from "./reply-generator.js";

export const ordinaryPage = tab => Number.isInteger(tab?.id) && /^https?:\/\//.test(tab.url || "");
export const panelPath = tab => `panel.html?tabId=${tab.id}&windowId=${tab.windowId}`;
const occupiedStatuses = new Set(["running", "paused", "recovering"]);

/** Owns task identity and window locks; TaskRunner owns only a single queue. */
export class TaskCoordinator {
  constructor({ browser, onChange = () => {}, onWindowChange = async () => {}, runnerOptions = {} }) {
    Object.assign(this, { browser, onChange, onWindowChange, runnerOptions });
    this.store = new WorkspaceStore(browser.storage.local);
    this.records = new Map();
    this.runners = new Map();
    this.contexts = new Map();
    this.enqueue = createQueue();
    this.restoring = true;
  }

  async initialize() {
    await this.store.load();
    for (const record of Object.values(this.store.data.records)) this.records.set(record.id, record);
    const session = (await this.browser.storage.session.get(BINDINGS_KEY))[BINDINGS_KEY];
    for (const context of session?.contexts || []) {
      const tab = await this.browser.tabs.get(context.tabId).catch(() => null);
      if (!this.records.has(context.taskId)) continue;
      const record = this.records.get(context.taskId);
      if (!tab || tab.windowId !== context.windowId || tab.url !== context.url) {
        if (context.occupied) {
          record.state.status = "ended";
          record.state.endReason = "来源页面已关闭、移出原窗口或更换网址，任务已结束。";
        }
        continue;
      }
      context.showFloating = Boolean(context.showFloating || context.showCompleted);
      delete context.showCompleted;
      this.contexts.set(context.id, context);
      context.occupied = context.occupied && occupiedStatuses.has(record.state.status);
      if (context.occupied && tab.status === "loading" && record.state.status === "running") record.state.status = "recovering";
      if (context.occupied && tab.status === "complete" && record.state.status === "recovering") record.state.status = "running";
    }
    for (const record of this.records.values()) {
      const context = this.contextForTask(record.id);
      await this.runner(record.id).restore({ newBrowserSession: !context || !context.occupied });
    }
    this.restoring = false;
    await this.saveBindings();
    for (const context of this.contexts.values()) {
      if (context.occupied && !occupiedStatuses.has(this.runner(context.taskId).state.status)) await this.release(context);
    }
  }

  runner(taskId) {
    if (!this.runners.has(taskId)) {
      const runner = new TaskRunner({
        ...this.runnerOptions,
        load: async () => structuredClone(this.records.get(taskId).state),
        save: async state => {
          const record = this.records.get(taskId);
          record.state = state;
          record.updatedAt = Date.now();
          await this.store.saveRecord(record);
        },
        publish: state => {
          this.records.get(taskId).state = state;
          if (!this.restoring) this.enqueue(() => this.changed(taskId)).catch(console.error);
        },
        canProcess: () => this.checkSource(taskId),
        canRead: () => this.checkReadSource(taskId),
        readReviews: options => {
          const context = this.contextForTask(taskId);
          if (!context) throw new Error("评价来源页已失效。");
          return (this.runnerOptions.readReviews || readReviews)(context, { browser: this.browser, ...options });
        },
        generateReply: (review, options) => (this.runnerOptions.generateReply || generateReply)(review, {
          ...options, products: this.store.products, settings: this.store.settings,
        }),
      });
      this.runners.set(taskId, runner);
    }
    return this.runners.get(taskId);
  }

  contextForTask(taskId) { return [...this.contexts.values()].find(item => item.taskId === taskId); }
  contextForTab(tabId) { return [...this.contexts.values()].find(item => item.tabId === tabId); }
  owner(windowId) { return [...this.contexts.values()].find(item => item.windowId === windowId && item.occupied); }
  floatingContext(windowId) {
    return this.owner(windowId) || [...this.contexts.values()].find(item => item.windowId === windowId && item.showFloating);
  }

  setPanelVisibility(context, open) {
    for (const item of this.contexts.values()) {
      if (item.windowId !== context.windowId) continue;
      item.showFloating = false;
      if (open) item.panelOpen = false;
    }
    context.panelOpen = open;
    context.showFloating = !open && this.runner(context.taskId).state.status !== "ended";
  }

  async saveBindings() {
    await this.browser.storage.session.set({ [BINDINGS_KEY]: { contexts: [...this.contexts.values()] } });
  }

  async open(tabId, windowId) {
    return this.enqueue(async () => {
      const tab = await this.browser.tabs.get(tabId).catch(() => null);
      if (!ordinaryPage(tab) || tab.windowId !== windowId) throw new Error("请在需要处理的普通网页中打开插件。");
      const owner = this.owner(windowId);
      if (owner && owner.tabId !== tabId) return { busy: this.busySummary(owner) };
      let context = this.contextForTab(tabId);
      if (context && context.url !== tab.url) {
        await this.detach(context, "来源页面已更换网址，任务已结束。");
        context = null;
      }
      if (!context) {
        const record = createRecord({ url: tab.url, title: tab.title || tab.url });
        await this.store.saveRecord(record);
        this.records.set(record.id, record);
        context = { id: crypto.randomUUID(), taskId: record.id, tabId, windowId, url: tab.url,
          title: tab.title || tab.url, occupied: false, panelOpen: false, originalAutoDiscardable: null };
        this.contexts.set(context.id, context);
        await this.runner(record.id).restore();
      }
      this.setPanelVisibility(context, true);
      await this.saveBindings();
      await this.onWindowChange(windowId);
      return this.snapshot(context.id);
    });
  }

  busySummary(owner) {
    return { taskId: owner.taskId, tabId: owner.tabId, windowId: owner.windowId, url: owner.url,
      title: owner.title, status: this.runner(owner.taskId).state.status };
  }

  history() {
    const attached = new Set([...this.contexts.values()].map(item => item.taskId));
    return [...this.records.values()].filter(record => !attached.has(record.id) &&
      (record.state.reviews.length || record.draft.text || record.productDraft.name || record.productDraft.details))
      .sort((a, b) => b.updatedAt - a.updatedAt).map(record => ({
        id: record.id, source: record.source, status: record.state.status, ...counts(record.state), updatedAt: record.updatedAt,
      }));
  }

  snapshot(contextId) {
    const context = this.contexts.get(contextId);
    if (!context) throw new Error("这个面板已失效，请在目标页面点击插件图标重新打开。");
    const record = this.records.get(context.taskId);
    const owner = this.owner(context.windowId);
    return { contextId, taskId: context.taskId, state: this.runner(context.taskId).snapshot(),
      source: { tabId: context.tabId, windowId: context.windowId, url: context.url, title: context.title },
      bound: context.occupied, valid: true, busy: owner && owner.id !== contextId ? this.busySummary(owner) : null,
      draft: structuredClone(record.draft), productDraft: structuredClone(record.productDraft),
      history: this.history(), legacyAvailable: this.store.hasLegacy() };
  }

  require(contextId, taskId) {
    const context = this.contexts.get(contextId);
    if (!context || context.taskId !== taskId) throw new Error("任务归属已改变，请重新打开插件后重试。");
    const owner = this.owner(context.windowId);
    if (owner && owner.id !== contextId) throw new Error("此窗口正在使用，请返回原任务页。");
    return context;
  }

  command(contextId, taskId, name, payload = {}) {
    const context = this.require(contextId, taskId);
    if (["PAUSE", "END"].includes(name)) this.runner(taskId).cancelTick();
    return this.enqueue(async () => {
      this.require(contextId, taskId);
      const runner = this.runner(taskId);
      if (name === "START") await this.start(context);
      else if (name === "DRAFT" || name === "PRODUCT_DRAFT") {
        const record = this.records.get(taskId);
        record[name === "DRAFT" ? "draft" : "productDraft"] = structuredClone(payload);
        await this.store.saveRecord(record);
      } else if (name === "IMPORT_LEGACY") {
        if (context.occupied || runner.state.reviews.length) throw new Error("请在空白且未开始的评价列表中恢复旧版记录。");
        const record = await this.store.importLegacy(this.records.get(taskId));
        this.records.set(taskId, record);
        runner.cancelTick();
        await runner.restore({ newBrowserSession: true });
      } else if (name === "RESTORE_RECORD") await this.restoreRecord(context, payload.id);
      else if (name !== "GET_STATE") {
        if (name === "END" && !context.occupied) throw new Error("当前没有占用窗口的任务。");
        await runner.command(name, payload);
        if (name === "END") await this.release(context);
      }
      this.broadcastWindow(context.windowId);
      await this.onWindowChange(context.windowId);
      return this.snapshot(contextId);
    });
  }

  async read(contextId, taskId) {
    this.require(contextId, taskId);
    const runner = this.runner(taskId);
    await runner.read();
    this.require(contextId, taskId);
    this.broadcastWindow(this.contexts.get(contextId).windowId);
    return this.snapshot(contextId);
  }

  async checkReadSource(taskId) {
    const context = this.contextForTask(taskId);
    if (!context) return false;
    this.require(context.id, taskId);
    const tab = await this.browser.tabs.get(context.tabId).catch(() => null);
    return Boolean(tab && tab.url === context.url && tab.windowId === context.windowId && tab.status === "complete");
  }

  async start(context) {
    const runner = this.runner(context.taskId);
    const owner = this.owner(context.windowId);
    if (owner && owner.id !== context.id) throw new Error("此窗口正在使用，请返回原任务页。");
    if (!counts(runner.state).pending && !(runner.state.mode === "llm" && runner.state.reviewSource)) throw new Error("请先添加需要自动处理的评价。");
    if (runner.state.mode === "llm" && !this.store.settings.apiKey.trim()) throw new Error("请先在生成设置中保存 API Key。");
    const tab = await this.browser.tabs.get(context.tabId);
    if (tab.windowId !== context.windowId || tab.url !== context.url) throw new Error("来源页面已改变，请在目标页面重新打开插件。");
    const wasOccupied = context.occupied;
    context.occupied = true;
    context.showFloating = false;
    if (!wasOccupied) {
      context.originalAutoDiscardable = tab.autoDiscardable ?? true;
      await this.browser.tabs.update(context.tabId, { autoDiscardable: false }).catch(() => {});
    }
    try {
      await this.saveBindings();
      await runner.command("START");
      if (tab.status === "loading") await runner.command("RECONNECTING");
    } catch (error) {
      runner.cancelTick();
      if (!wasOccupied) await this.release(context);
      throw error;
    }
  }

  async restoreRecord(context, recordId) {
    if (context.occupied) throw new Error("请先结束当前任务，再恢复保存记录。");
    const record = this.records.get(recordId);
    if (!record || this.contextForTask(recordId)) throw new Error("这份记录已在其他页面使用，请重新选择。");
    const tab = await this.browser.tabs.get(context.tabId);
    if (tab.url !== context.url || tab.windowId !== context.windowId) throw new Error("目标页面已改变，请重新打开插件。");
    context.taskId = recordId;
    context.showFloating = false;
    record.source = { url: context.url, title: context.title };
    const runner = this.runner(recordId);
    runner.cancelTick();
    await runner.restore({ newBrowserSession: true });
    await this.saveBindings();
    this.broadcastAll();
  }

  async release(context, completed = false) {
    context.occupied = false;
    context.showFloating = completed;
    if (context.originalAutoDiscardable !== null) {
      await this.browser.tabs.update(context.tabId, { autoDiscardable: context.originalAutoDiscardable }).catch(() => {});
      context.originalAutoDiscardable = null;
    }
    await this.saveBindings();
  }

  async changed(taskId) {
    const context = this.contextForTask(taskId);
    if (!context) return;
    const state = this.runner(taskId).state;
    if (context.occupied && !occupiedStatuses.has(state.status)) await this.release(context, state.status === "completed");
    this.broadcastWindow(context.windowId);
    await this.onWindowChange(context.windowId);
  }

  broadcastWindow(windowId) {
    for (const context of this.contexts.values()) {
      if (context.windowId === windowId) this.onChange(this.snapshot(context.id));
    }
  }
  broadcastAll() { for (const context of this.contexts.values()) this.onChange(this.snapshot(context.id)); }

  async checkSource(taskId) {
    const context = this.contextForTask(taskId);
    if (!context?.occupied || this.owner(context.windowId)?.taskId !== taskId) return false;
    const tab = await this.browser.tabs.get(context.tabId).catch(() => null);
    if (!tab || tab.url !== context.url || tab.windowId !== context.windowId || tab.status === "loading" || tab.discarded || tab.frozen) {
      this.tabUpdated(context.tabId, { status: tab?.status, url: tab?.url }, tab).catch(console.error);
      return false;
    }
    return true;
  }

  tabUpdated(tabId, change, tab) {
    const context = this.contextForTab(tabId);
    if (!context) return Promise.resolve();
    const invalid = !tab || tab.windowId !== context.windowId || (change.url || tab.url) !== context.url;
    const loading = change.status === "loading" || tab?.discarded || tab?.frozen;
    if (invalid || loading) this.runner(context.taskId).cancelTick();
    return this.enqueue(async () => {
      if (!this.contexts.has(context.id)) return;
      if (invalid) await this.detach(context, "来源页面已关闭、移出原窗口或更换网址，任务已结束。");
      else if (context.occupied) {
        const runner = this.runner(context.taskId);
        if (loading && runner.state.status === "running") await runner.command("RECONNECTING");
        else if (!loading && tab.status === "complete" && runner.state.status === "recovering") await runner.command("RECONNECTED");
      }
      await this.onWindowChange(context.windowId);
    });
  }

  async detach(context, reason) {
    const runner = this.runner(context.taskId);
    runner.cancelTick();
    if (context.occupied) await runner.command("END", { reason });
    await this.release(context);
    const snapshot = this.snapshot(context.id);
    this.onChange({ ...snapshot, valid: false });
    this.contexts.delete(context.id);
    await this.saveBindings();
    this.broadcastAll();
  }

  closeTab(tabId) { return this.tabUpdated(tabId, {}, null); }

  closeWindow(windowId) {
    for (const context of this.contexts.values()) {
      if (context.windowId === windowId) this.runner(context.taskId).cancelTick();
    }
    return this.enqueue(async () => {
      for (const context of [...this.contexts.values()]) {
        if (context.windowId === windowId) await this.detach(context, "原任务窗口已关闭，任务已结束。");
      }
    });
  }

  panelVisibility(tabId, open) {
    return this.enqueue(async () => {
      const context = this.contextForTab(tabId);
      if (!context || context.panelOpen === open) return;
      this.setPanelVisibility(context, open);
      await this.saveBindings();
      await this.onWindowChange(context.windowId);
    });
  }

  async wake() {
    await Promise.all([...this.runners.values()].filter(runner => runner.state.status === "running").map(runner => runner.tick()));
  }
}
