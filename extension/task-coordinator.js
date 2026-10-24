import { BINDINGS_KEY, RETENTION_MS, counts, isActive, holdsWindow } from "./model.js";
import { TaskRunner } from "./task-runner.js";
import { WorkspaceStore, createRecord } from "./workspace-store.js";
import { createQueue } from "./queue.js";
import { readReviews, isReviewPage } from "./review-reader.js";
import { generateReply, NativeClient } from "./native-client.js";
import { ProductCatalog, catalogKey } from "./product-catalog.js";

export const ordinaryPage = tab => Number.isInteger(tab?.id) && /^https?:\/\//.test(tab.url || "");
export const panelPath = tab => `panel.html?tabId=${tab.id}&windowId=${tab.windowId}`;

/** Owns task identity and window locks; TaskRunner owns only a single queue. */
export class TaskCoordinator {
  constructor({ browser, onChange = () => {}, onWindowChange = async () => {}, runnerOptions = {} }) {
    Object.assign(this, { browser, onChange, onWindowChange, runnerOptions });
    this.store = new WorkspaceStore(browser.storage.local);
    this.catalog = new ProductCatalog(browser.storage.local);
    this.records = new Map();
    this.runners = new Map();
    this.contexts = new Map();
    this.enqueue = createQueue();
    this.restoring = true;
    this.component = { status: "checking", message: "正在准备本机组件…" };
    this.native = new NativeClient(browser.runtime, { onDisconnect: error => { void this.componentDisconnected(error).catch(console.error); } });
  }

  async initialize() {
    await this.store.load();
    await this.catalog.load();
    for (const record of Object.values(this.store.data.records)) this.records.set(record.id, record);
    const session = (await this.browser.storage.session.get(BINDINGS_KEY))[BINDINGS_KEY];
    for (const context of session?.contexts || []) {
      const tab = await this.browser.tabs.get(context.tabId).catch(() => null);
      const record = this.records.get(context.taskId);
      if (!tab || tab.windowId !== context.windowId) {
        if (context.occupied && record) {
          record.state.status = "ended";
          record.state.endReason = "来源页面已关闭或移出原窗口，任务已结束。";
        }
        continue;
      }
      context.showFloating = Boolean(context.showFloating || context.showCompleted);
      delete context.showCompleted;
      this.contexts.set(context.id, context);
      context.occupied = Boolean(context.occupied && record && holdsWindow(record.state));
      if (!context.occupied) await this.selectPage(context, tab);
      else this.observePage(context, tab);
      if (context.occupied && !context.sourceAway && tab.status === "loading" && record.state.status === "running") record.state.status = "recovering";
      if (context.occupied && !context.sourceAway && tab.status === "complete" && record.state.status === "recovering") record.state.status = "running";
    }
    for (const record of this.records.values()) {
      const context = this.contextForTask(record.id);
      await this.runner(record.id).restore({ newBrowserSession: !context || !context.occupied || context.sourceAway });
    }
    this.restoring = false;
    await this.saveBindings();
    for (const context of this.contexts.values()) {
      if (context.occupied && !holdsWindow(this.runner(context.taskId).state)) await this.release(context);
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
          record.expiresAt = await this.store.saveRecord(record);
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
        controlRun: async (payload, signal) => {
          if (this.runnerOptions.controlRun) return this.runnerOptions.controlRun(payload, signal);
          if (payload.status !== "running" && !this.native.connected) return;
          if (payload.status === "running" && !(await this.native.request("health", {}, signal)).hasModelKey) {
            throw new Error("请在插件的“模型账户”中填写 API Key，或通过安装向导配置。");
          }
          return this.native.request("control", { taskId, ...payload }, signal);
        },
        generateReply: (review, options) => (this.runnerOptions.generateReply || generateReply)(review, {
          ...options, taskId, client: this.native, products: this.runners.get(taskId).productSnapshot || [],
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

  observePage(context, tab) {
    context.bindingRevision ??= 0;
    context.observedUrl ??= context.url;
    const ready = ordinaryPage(tab) && tab.status === "complete" && !tab.discarded && !tab.frozen;
    if (context.observedUrl !== tab.url || (context.pageReady && !ready)) context.bindingRevision++;
    context.observedUrl = tab.url;
    context.pageReady = ready;
    context.sourceAway = Boolean(context.occupied && (tab.url !== context.url || (context.sourceAway && !ready)));
  }

  async syncBoundPage(context, tab, { departed = false, loading = false } = {}) {
    const runner = this.runner(context.taskId);
    this.observePage(context, tab);
    if (departed || context.sourceAway) {
      if (isActive(runner.state) || runner.work) await runner.command("PAUSE");
      else await runner.commit();
    } else {
      if (loading && runner.state.status === "running") await runner.command("RECONNECTING");
      if (context.pageReady && runner.state.status === "recovering") await runner.command("RECONNECTED");
    }
  }

  // One live panel, with independent preparation records for its tab's URLs.
  async selectPage(context, tab) {
    context.preparations ??= {};
    if (context.taskId) context.preparations[context.url] = context.taskId;
    this.observePage(context, tab);
    if (context.url !== tab.url) {
      const previous = this.runners.get(context.taskId);
      if (previous) { previous.cancelTick(); await previous.commit(); }
    }
    let record = this.records.get(context.preparations[tab.url]);
    const attached = record && this.contextForTask(record.id);
    if (!record || record.source.url !== tab.url || (record.expiresAt && record.expiresAt <= Date.now()) ||
        (attached && attached.id !== context.id) || isActive(record.state)) {
      record = createRecord({ url: tab.url, title: tab.title || tab.url });
      await this.store.saveRecord(record);
      this.records.set(record.id, record);
    }
    if (context.taskId && context.taskId !== record.id && context.url === tab.url) context.bindingRevision++;
    Object.assign(context, { taskId: record.id, url: tab.url, title: tab.title || tab.url });
    context.preparations[tab.url] = record.id;
    if (!this.restoring && !this.runners.has(record.id)) await this.runner(record.id).restore();
  }

  async open(tabId, windowId) {
    return this.enqueue(async () => {
      const tab = await this.browser.tabs.get(tabId).catch(() => null);
      let context = this.contextForTab(tabId);
      if (!tab || tab.windowId !== windowId || (!ordinaryPage(tab) && !context?.occupied)) throw new Error("请在需要处理的普通网页中打开插件。");
      const owner = this.owner(windowId);
      if (owner && owner.tabId !== tabId) return { busy: this.busySummary(owner) };
      if (!context) {
        context = { id: crypto.randomUUID(), taskId: null, tabId, windowId, url: tab.url,
          title: tab.title || tab.url, occupied: false, panelOpen: false, originalAutoDiscardable: null };
        this.contexts.set(context.id, context);
      }
      if (!context.occupied) await this.selectPage(context, tab);
      else await this.syncBoundPage(context, tab);
      this.setPanelVisibility(context, true);
      await this.saveBindings();
      await this.onWindowChange(windowId);
      return this.snapshot(context.id);
    });
  }

  busySummary(owner) {
    return { taskId: owner.taskId, tabId: owner.tabId, windowId: owner.windowId, url: owner.url,
      title: owner.title, status: this.runner(owner.taskId).state.status, sourceAway: Boolean(owner.sourceAway) };
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
    return { contextId, taskId: context.taskId, bindingRevision: context.bindingRevision,
      pageReady: context.pageReady && context.observedUrl === context.url && !context.sourceAway,
      sourceAway: Boolean(context.sourceAway), state: this.runner(context.taskId).snapshot(),
      source: { tabId: context.tabId, windowId: context.windowId, url: context.url, title: context.title },
      bound: context.occupied, valid: true, busy: owner && owner.id !== contextId ? this.busySummary(owner) : null,
      draft: structuredClone(record.draft), productDraft: structuredClone(record.productDraft),
      expiresAt: record.expiresAt, history: this.history(), legacyAvailable: this.store.hasLegacy(), component: { ...this.component } };
  }

  require(contextId, taskId, bindingRevision, draft = false) {
    const context = this.contexts.get(contextId);
    const current = context?.taskId === taskId && (bindingRevision === undefined || context.bindingRevision === bindingRevision);
    const parked = draft && context && Object.values(context.preparations || {}).includes(taskId) &&
      (!this.contextForTask(taskId) || this.contextForTask(taskId).id === contextId);
    if (!context || !this.records.has(taskId) || (!current && !parked) || bindingRevision > context.bindingRevision) {
      throw new Error("页面或任务归属已改变，请使用当前页面的操作。");
    }
    const owner = this.owner(context.windowId);
    if (owner && owner.id !== contextId) throw new Error("此窗口正在使用，请返回原任务页。");
    return context;
  }

  command(contextId, taskId, name, payload = {}, bindingRevision) {
    const draft = name === "DRAFT" || name === "PRODUCT_DRAFT";
    const context = this.require(contextId, taskId, bindingRevision, draft);
    if (["PAUSE", "END"].includes(name)) this.runner(taskId).cancelTick();
    return this.enqueue(async () => {
      this.require(contextId, taskId, bindingRevision, draft);
      const runner = this.runner(taskId);
      switch (name) {
        case "START":
          await this.start(context);
          break;
        case "DRAFT":
        case "PRODUCT_DRAFT": {
          if (name === "PRODUCT_DRAFT" && runner.state.reviewSource && this.catalogLocked(runner.state.reviewSource)) {
            throw new Error("当前店铺任务正在运行，请先暂停后修改资料。");
          }
          const record = this.records.get(taskId);
          const field = name === "DRAFT" ? "draft" : "productDraft";
          record[field] = structuredClone(payload);
          record.draftUpdatedAt = Date.now();
          if (runner.state.status === "idle") record.expiresAt = Date.now() + RETENTION_MS;
          await this.store.saveRecord(record);
          break;
        }
        case "IMPORT_LEGACY": {
          if (context.occupied || runner.state.reviews.length) throw new Error("请在空白且未开始的评价列表中恢复旧版记录。");
          const record = await this.store.importLegacy(this.records.get(taskId));
          this.records.set(taskId, record);
          runner.cancelTick();
          await runner.restore({ newBrowserSession: true });
          break;
        }
        case "RESTORE_RECORD":
          await this.restoreRecord(context, payload.id);
          break;
        case "GET_STATE":
          break;
        default:
          if (name === "END" && !context.occupied) throw new Error("当前没有占用窗口的任务。");
          await runner.command(name, payload);
          if (name === "END") await this.release(context);
      }
      this.broadcastWindow(context.windowId);
      await this.onWindowChange(context.windowId);
      return this.snapshot(contextId);
    });
  }

  async read(contextId, taskId, bindingRevision) {
    this.require(contextId, taskId, bindingRevision);
    if (!await this.checkReadSource(taskId)) throw new Error("请在已加载完成的店铺评论页读取评价。");
    this.require(contextId, taskId, bindingRevision);
    const runner = this.runner(taskId);
    await runner.read();
    this.require(contextId, taskId, bindingRevision);
    this.broadcastWindow(this.contexts.get(contextId).windowId);
    return this.snapshot(contextId);
  }

  async checkReadSource(taskId) {
    const context = this.contextForTask(taskId);
    if (!context) return false;
    this.require(context.id, taskId);
    const tab = await this.browser.tabs.get(context.tabId).catch(() => null);
    return Boolean(tab && isReviewPage(tab.url) && tab.url === context.url && tab.windowId === context.windowId &&
      tab.status === "complete" && !tab.discarded && !tab.frozen);
  }

  async start(context) {
    const runner = this.runner(context.taskId);
    const expected = runner.generation;
    const owner = this.owner(context.windowId);
    if (owner && owner.id !== context.id) throw new Error("此窗口正在使用，请返回原任务页。");
    if (!counts(runner.state).pending && !(runner.state.mode === "llm" && runner.state.reviewSource)) throw new Error("请先添加需要自动处理的评价。");
    const tab = await this.browser.tabs.get(context.tabId);
    if (tab.windowId !== context.windowId || tab.url !== context.url) throw new Error("来源页面已改变，请在目标页面重新打开插件。");
    if (runner.state.mode === "llm" && (!isReviewPage(tab.url) || tab.status !== "complete" || tab.discarded || tab.frozen)) {
      throw new Error("请在已加载完成的店铺评论页开始生成。");
    }
    // Freeze this run's material in memory; it never enters saved task records.
    if (runner.state.mode === "llm") runner.productSnapshot = (await this.catalog.read(runner.state.reviewSource)).products;
    if (runner.generation !== expected) return;
    const wasOccupied = context.occupied;
    context.occupied = true;
    context.showFloating = false;
    if (!wasOccupied) {
      context.originalAutoDiscardable = tab.autoDiscardable ?? true;
      await this.browser.tabs.update(context.tabId, { autoDiscardable: false }).catch(() => {});
    }
    try {
      await this.saveBindings();
      if (runner.generation !== expected) {
        if (!wasOccupied) await this.release(context);
        return;
      }
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
    context.bindingRevision++;
    context.preparations[context.url] = recordId;
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
    context.sourceAway = false;
    context.showFloating = completed;
    if (context.originalAutoDiscardable !== null) {
      await this.browser.tabs.update(context.tabId, { autoDiscardable: context.originalAutoDiscardable }).catch(() => {});
      context.originalAutoDiscardable = null;
    }
    if (this.contexts.has(context.id) && context.observedUrl !== context.url) {
      const tab = await this.browser.tabs.get(context.tabId).catch(() => null);
      if (tab && tab.windowId === context.windowId) await this.selectPage(context, tab);
    }
    await this.saveBindings();
  }

  async changed(taskId) {
    const context = this.contextForTask(taskId);
    if (!context) return;
    const state = this.runner(taskId).state;
    if (!isActive(state)) delete this.runner(taskId).productSnapshot;
    if (context.occupied && !holdsWindow(state)) await this.release(context, state.status === "completed");
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
    const departed = context.occupied && tab && (change.url || tab.url) !== context.url;
    if (tab && tab.windowId === context.windowId) this.observePage(context, tab);
    return this.enqueue(async () => {
      if (!this.contexts.has(context.id)) return;
      const latest = tab && await this.browser.tabs.get(tabId).catch(() => null);
      if (!latest || latest.windowId !== context.windowId) {
        await this.detach(context, "来源页面已关闭或移出原窗口，任务已结束。");
      } else if (!context.occupied) {
        if (invalid || loading) await this.runner(context.taskId).commit();
        await this.selectPage(context, latest);
        await this.saveBindings();
        this.onChange(this.snapshot(context.id));
      } else {
        await this.syncBoundPage(context, latest, { departed, loading });
        await this.saveBindings();
        this.onChange(this.snapshot(context.id));
      }
      await this.onWindowChange(context.windowId);
    });
  }

  async detach(context, reason) {
    const runner = this.runner(context.taskId);
    runner.cancelTick();
    if (context.occupied) await runner.command("END", { reason });
    const snapshot = this.snapshot(context.id);
    this.contexts.delete(context.id);
    await this.release(context);
    this.onChange({ ...snapshot, bound: false, sourceAway: false, valid: false });
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

  catalogLocked(source) {
    return [...this.runners.values()].some(runner => isActive(runner.state) && runner.state.reviewSource &&
      catalogKey(runner.state.reviewSource) === catalogKey(source));
  }

  async checkComponent() {
    try {
      const health = await this.native.request("health", {});
      this.component = { status: health.hasModelKey ? "ready" : "missing-key", message: health.hasModelKey
        ? "本机组件已就绪" : "请在“模型账户”填写 API Key。", canSaveKey: Boolean(health.canSaveKey) };
    } catch (error) { this.component = { status: "unavailable", message: error.message }; }
    this.broadcastAll();
    return this.component;
  }

  saveKey(context, payload) {
    return this.enqueue(async () => {
      this.require(context.id, context.taskId, context.bindingRevision);
      if ([...this.runners.values()].some(runner => runner.state.mode === "llm" && isActive(runner.state))) {
        throw new Error("请先暂停本浏览器环境中的生成任务，再更新 API Key。");
      }
      await this.native.request("credentials", payload);
      return { component: await this.checkComponent() };
    });
  }

  componentDisconnected(error) {
    this.component = { status: "unavailable", message: error.message };
    const active = [...this.runners.values()].filter(runner => runner.state.mode === "llm" && isActive(runner.state));
    return this.pauseRunners(active, "本机组件已断开，任务已暂停；点击继续时将自动连接。");
  }

  pauseRunners(runners, reason) {
    // Invalidate every call immediately, before waiting for queued writes.
    for (const runner of runners) runner.cancelTick();
    return this.enqueue(async () => {
      for (const runner of runners) await runner.command("PAUSE", { reason });
      if (!this.restoring) this.broadcastAll();
    });
  }

  products(context, action, payload = {}) {
    return this.enqueue(async () => {
      this.require(context.id, context.taskId, context.bindingRevision);
      const source = this.runner(context.taskId).state.reviewSource;
      if (!source) {
        if (action !== "LIST") throw new Error("请先读取当前店铺评价。");
        return { products: [], locked: true, shop: null, message: "先读取店铺评价，再管理该店铺资料。" };
      }
      const locked = this.catalogLocked(source);
      if (action !== "LIST" && locked) throw new Error("当前店铺任务正在运行，请先暂停后修改资料。");
      if (action === "EXPORT") return { backup: await this.catalog.backup(source) };
      let catalog;
      if (action === "LIST") catalog = await this.catalog.read(source);
      else if (action === "IMPORT_BACKUP") catalog = await this.catalog.restore(source, payload);
      else catalog = await this.catalog.edit(source, action, payload);
      return { ...catalog, locked };
    });
  }

  catalogChanged(changes) {
    const affected = [...this.runners.values()].filter(runner => {
      const source = runner.state.reviewSource, change = source && changes[catalogKey(source)];
      return change && isActive(runner.state) && JSON.stringify(change.newValue?.products || []) !== JSON.stringify(runner.productSnapshot || []);
    });
    return this.pauseRunners(affected, "店铺资料已从环境同步更新，请确认资料后继续任务。");
  }

  async wake() {
    await this.enqueue(async () => {
      const expired = await this.store.cleanup();
      for (const id of expired) {
        this.runners.get(id)?.cancelTick();
        this.runners.delete(id); this.records.delete(id);
      }
      if (expired.length) for (const context of [...this.contexts.values()]) {
        for (const [url, id] of Object.entries(context.preparations || {})) {
          if (expired.includes(id)) delete context.preparations[url];
        }
        if (!expired.includes(context.taskId)) continue;
        const tab = await this.browser.tabs.get(context.tabId).catch(() => null);
        if (!context.occupied && tab && tab.windowId === context.windowId) await this.selectPage(context, tab);
        else this.contexts.delete(context.id);
        await this.onWindowChange(context.windowId);
      }
      if (expired.length) { await this.saveBindings(); this.broadcastAll(); }
      for (const record of this.records.values()) {
        const saved = this.store.data.records[record.id];
        if (record.draftUpdatedAt && !saved.draftUpdatedAt) {
          record.draft = {}; record.productDraft = {}; delete record.draftUpdatedAt;
        }
      }
    });
    await Promise.all([...this.runners.entries()].map(async ([id, runner]) => {
      if (!isActive(runner.state)) {
        await runner.syncRun().catch(() => {});
        return;
      }
      if (runner.state.mode === "llm") {
        try { await this.native.request("heartbeat", { taskId: id, generation: runner.generation }); }
        catch (error) {
          await runner.command("PAUSE", { reason: error.message }).catch(() => {});
          return;
        }
      }
      if (runner.state.status === "running") await runner.tick();
    }));
  }
}
