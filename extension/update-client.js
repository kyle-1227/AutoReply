import { APP_VERSION } from "./protocol.js";
import { UPDATE_VERSION, UPDATE_FILE, UPDATE_STATE_KEY, UPDATE_CLIENT_KEY, finishedUpdate } from "./update-protocol.js";
import { isActive } from "./model.js";
import { createQueue } from "./queue.js";

export class ExtensionUpdater {
  constructor({ browser, coordinator, ports = new Map(), read = async file => {
    const response = await fetch(browser.runtime.getURL(file), { cache: "no-store" });
    if (!response.ok) return null;
    return response.json();
  } }) {
    Object.assign(this, { browser, coordinator, ports, read });
    this.client = coordinator.native; this.waiters = new Map();
    this.stateWrites = createQueue();
    coordinator.updater = this;
  }
  async restoreGate() {
    this.state = (await this.browser.storage.local.get(UPDATE_STATE_KEY))[UPDATE_STATE_KEY] || null;
    const disk = await this.read(UPDATE_FILE).catch(() => null);
    if (disk?.jobId) await this.accept(disk);
    this.coordinator.updating = Boolean(this.state && !finishedUpdate(this.state.phase));
  }
  async register(health) {
    if (health.updateProtocolVersion !== UPDATE_VERSION) return { managed: false };
    if (this.registering) return this.registering;
    this.registering = (async () => {
      let id = (await this.browser.storage.local.get(UPDATE_CLIENT_KEY))[UPDATE_CLIENT_KEY];
      if (!id) { id = crypto.randomUUID(); await this.browser.storage.local.set({ [UPDATE_CLIENT_KEY]: id }); }
      let nonce = null;
      try {
        const proof = await this.client.rawRequest("update_probe", {});
        if (!/^\.autoreply-probe\.json\.[a-f0-9-]{36}\.json$/.test(proof.file)) throw new Error("目录校验文件无效。");
        const value = await this.read(proof.file);
        if (value?.expiresAt > Date.now()) nonce = value.nonce;
      } catch { /* Unmanaged source copies can still generate, but cannot update files. */ }
      const result = await this.client.rawRequest("update_register", { nonce, clientVersion: APP_VERSION, clientId: id });
      return { managed: result.registered, browser: result.browser };
    })().finally(() => { this.registering = null; });
    return this.registering;
  }
  async request(command, payload = {}) {
    if (this.state && ["installing", "restarting"].includes(this.state.phase)) throw new Error("正在安装或重启，请等待更新完成。");
    return this.client.updateRequest(command, payload, health => {
      this.health = health;
      return this.register(health);
    });
  }
  async check() {
    await this.poll();
    if (this.state && !finishedUpdate(this.state.phase)) return { job: this.state, componentVersion: this.health?.componentVersion, available: false };
    const result = await this.request("update_check", { clientVersion: APP_VERSION });
    return { ...result, componentVersion: this.health.componentVersion, job: this.state };
  }
  async start(version) {
    const job = await this.request("update_start", { version });
    await this.accept(job); this.schedule(); return job;
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.state && !finishedUpdate(this.state.phase)) this.timer = setTimeout(() => this.poll().catch(() => {}).finally(() => this.schedule()), 800);
  }
  accept(value) {
    return this.stateWrites(async () => {
      if (!value?.jobId || !Number.isSafeInteger(value.revision)) return;
      if (this.state?.jobId === value.jobId && this.state.revision >= value.revision) return;
      const updating = !finishedUpdate(value.phase);
      if (updating) this.coordinator.updating = true;
      await this.browser.storage.local.set({ [UPDATE_STATE_KEY]: value });
      this.state = value;
      this.coordinator.updating = updating;
      await this.browser.runtime.sendMessage({ type: "UPDATE_CHANGED", update: value }).catch(() => {});
    });
  }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const value = await this.read(UPDATE_FILE).catch(() => null);
      if (!value?.jobId) return;
      await this.accept(value);
      if (this.state?.jobId !== value.jobId || this.state.revision !== value.revision) return;
      if (["verifying", "completed", "restart_failed"].includes(value.phase)) {
        const key = "autoreply.update-reloaded.v1";
        if ((await this.browser.storage.local.get(key))[key] !== value.jobId) {
          await this.browser.storage.local.set({ [key]: value.jobId });
          this.browser.runtime.reload(); return;
        }
        if (APP_VERSION === value.version && this.confirmed !== value.jobId) {
          if (this.browser.runtime.getManifest && this.browser.runtime.getManifest().version !== APP_VERSION) throw new Error("浏览器实际加载版本尚未一致，请重新加载插件后核验。");
          await this.request("update_confirm", { jobId: value.jobId });
          this.confirmed = value.jobId;
          await this.coordinator.checkComponent();
          await this.browser.action.setBadgeText({ text: value.phase === "completed" ? "已更新" : "核验中" });
        }
      }
    } finally { this.polling = false; }
  }
  bindPort(port) {
    port.onMessage.addListener(message => {
      const pending = this.waiters.get(port);
      if (!pending || message?.type !== "UPDATE_UI_READY" || message.jobId !== pending.jobId) return;
      pending.finish(message.ok ? null : new Error("面板草稿未能保存，更新已停止。"));
    });
    port.onDisconnect.addListener(() => this.waiters.get(port)?.finish(new Error("有面板未确认保存，更新已停止。")));
  }
  async prepare(jobId, prepareToken) {
    if (this.preparing === prepareToken) return;
    this.preparing = prepareToken; this.coordinator.updating = true;
    try {
      await this.browser.storage.local.remove("autoreply.update-reloaded.v1");
      const runners = [...this.coordinator.runners.values()].filter(runner => isActive(runner.state) || runner.work || runner.state.reading);
      await this.coordinator.pauseRunners(runners, "正在更新插件和组件，任务已保存并暂停。");
      await Promise.all([...this.ports.values()].map(port => new Promise((yes, no) => {
        const finish = error => { clearTimeout(timer); this.waiters.delete(port); error ? no(error) : yes(); };
        const timer = setTimeout(() => finish(new Error("面板保存确认超时。")), 25000);
        this.waiters.set(port, { jobId, finish });
        try { port.postMessage({ type: "UPDATE_FLUSH", jobId }); } catch { finish(new Error("面板已断开。")); }
      })));
      await this.client.costMessages(() => {});
      await this.coordinator.costs.disconnected(this.client.costSessionId);
      await this.client.updateRequest("update_ready", { jobId, prepareToken, ok: true });
    } catch {
      await this.client.updateRequest("update_ready", { jobId, prepareToken, ok: false }).catch(() => {});
    }
    this.schedule();
  }
  async event(message) {
    if (message.type === "UPDATE_PREPARE") {
      const job = await this.client.updateRequest("update_status"); await this.accept(job);
      await this.prepare(message.jobId, message.prepareToken);
    } else if (message.type === "UPDATE_DETACH") {
      await this.poll();
      this.client.disconnect();
      this.schedule();
    }
  }
}
