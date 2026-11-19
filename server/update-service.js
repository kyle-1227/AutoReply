import { mkdir, unlink, rm, cp, stat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { APP_VERSION } from "../extension/protocol.js";
import { createQueue } from "../extension/queue.js";
import { BitBrowser } from "./bitbrowser.js";
import { checkRelease, downloadInstaller } from "./releases.js";
import { PROBE_FILE, createHome, readJson, writeJson, updateState, publicUpdate, liveClients, processAlive, managedDirectories, compareVersions, terminal, updateError } from "./update-store.js";

const updateMember = ({ id, clientId, directory, browser, version }) => ({ id, clientId, directory, browser, version });
export class UpdateService {
  constructor({ root, send, prepare = () => {}, browser = { pid: Number(process.env.AUTOREPLY_BROWSER_PID) || 0, kind: process.env.AUTOREPLY_BROWSER_KIND || "unknown" },
    release = checkRelease, download = downloadInstaller, launch, isAlive = processAlive, prepareTimeout = 30000,
    bitRoot = process.env.APPDATA && join(process.env.APPDATA, "BitBrowser", "BitExtensions") }) {
    Object.assign(this, { root: resolve(root), send, prepare, browser, release, download, launch, isAlive, prepareTimeout, bitRoot });
    this.id = randomUUID(); this.probes = new Map(); this.bit = new BitBrowser(this.root); this.leaseWrites = createQueue();
    this.ready = this.initialize();
  }
  async initialize() {
    this.root = await realpath(this.root);
    this.home = await createHome(this.root);
    this.client = { id: this.id, pid: process.pid, browser: this.browser, directory: null, version: null };
    this.leasePath = join(this.home, "clients", `${this.id}.json`);
    await writeJson(this.leasePath, this.client);
    const pending = await readJson(join(this.home, "current.json"));
    const worker = pending?.work && await readJson(join(pending.work, "worker.lock", "pid.json"));
    if (pending && !terminal(pending.phase) && !this.isAlive(pending.ownerPid) && !this.isAlive(pending.workerPid) && !this.isAlive(worker?.pid)) {
      if (["preparing", "downloading"].includes(pending.phase)) {
        await updateState(this.home, pending, { phase: "failed", message: "上次更新在安装前中断，原文件未替换，请重新检查。" });
        await rm(join(this.home, "lock"), { recursive: true, force: true });
      } else if (pending.work === join(this.home, pending.jobId)) await this.spawnWorker(pending);
    }
    this.timer = setInterval(() => this.poll().catch(() => {}), 750); this.timer.unref();
  }
  clients() { return liveClients(this.home, this.isAlive); }
  async poll() {
    await this.ready;
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const job = await readJson(join(this.home, "current.json"));
      if (job?.phase === "preparing" && this.notified !== job.prepareToken) {
        this.notified = job.prepareToken;
        this.prepare();
        this.send({ type: "UPDATE_PREPARE", jobId: job.jobId, prepareToken: job.prepareToken, version: job.version });
      }
      if (job?.phase === "installing" && this.detaching !== job.prepareToken) {
        this.detaching = job.prepareToken;
        this.send({ type: "UPDATE_DETACH", jobId: job.jobId, version: job.version });
      }
    } finally { this.polling = false; }
  }
  async makeProbe() {
    if (!await stat(join(this.root, "AutoReplySetup.exe")).catch(() => null)) throw updateError("请先手动安装支持一键更新的配套组件。");
    const directories = await managedDirectories(this.root, this.bitRoot);
    const file = `${PROBE_FILE}.${this.id}.json`, expiresAt = Date.now() + 60000;
    this.probes.clear();
    for (const directory of directories) {
      const nonce = randomUUID(); this.probes.set(nonce, { directory, expiresAt });
      await writeJson(join(directory, file), { nonce, expiresAt });
    }
    return { file };
  }
  async register({ nonce, clientVersion, clientId }) {
    compareVersions(clientVersion, APP_VERSION);
    if (typeof clientId !== "string" || !/^[a-f0-9-]{36}$/.test(clientId)) throw updateError("更新客户端编号无效。");
    const probe = this.probes.get(nonce);
    const directory = probe?.expiresAt > Date.now() ? probe.directory : null;
    await this.leaseWrites(async () => {
      if (this.client.version === clientVersion && this.client.directory === directory && this.client.clientId === clientId) return;
      const client = { ...this.client, version: clientVersion, directory, clientId };
      await writeJson(this.leasePath, client);
      this.client = client;
    });
    return { registered: Boolean(directory), browser: this.browser.kind };
  }
  async check(clientVersion) {
    const floor = compareVersions(clientVersion, APP_VERSION) > 0 ? clientVersion : APP_VERSION;
    const previous = await readJson(join(this.home, "current.json"));
    const resume = previous?.phase === "restart_failed" && previous.version === floor;
    if (resume) return { version: previous.version, available: true, managed: Boolean(this.client.directory), browser: this.browser.kind, message: previous.message };
    const result = await this.release(floor);
    const repair = result.version === floor && clientVersion !== APP_VERSION;
    return { ...result, installer: undefined, available: Boolean(result.installer && (result.available || repair)), managed: Boolean(this.client.directory), browser: this.browser.kind,
      message: !this.client.directory ? "当前插件不在受控安装目录，请先在扩展中心加载安装器提供的本地插件。" : result.message };
  }
  async command(command, payload) {
    await this.ready;
    if (command === "update_probe") return this.makeProbe();
    if (command === "update_register") return this.register(payload);
    if (command === "update_check") return this.check(payload.clientVersion);
    if (command === "update_settings") {
      await mkdir(join(this.root, "config"), { recursive: true });
      return payload.port === undefined ? this.bit.status() : this.bit.save(payload);
    }
    if (command === "update_test") { await this.bit.call("health"); await this.bit.call("browser/pids/all"); return { connected: true }; }
    if (command === "update_status") return this.status();
    if (command === "update_confirm") {
      const job = await readJson(join(this.home, "current.json"));
      if (!job || job.jobId !== payload.jobId || job.version !== this.client.version || APP_VERSION !== job.version || !this.client.directory) throw updateError("更新核验未通过，版本或加载目录不一致。");
      await writeJson(join(this.home, `${job.jobId}.${this.client.id}.verified.json`), { clientId: this.client.clientId, directory: this.client.directory, version: APP_VERSION, browser: this.browser });
      return { verified: true };
    }
    if (command === "update_ready") {
      const job = await readJson(join(this.home, "current.json"));
      if (!job || job.jobId !== payload.jobId || job.prepareToken !== payload.prepareToken || job.phase !== "preparing" || typeof payload.ok !== "boolean") throw updateError("更新准备请求已失效。");
      await writeJson(join(this.home, `${job.jobId}.${this.id}.prepared.json`), { prepareToken: payload.prepareToken, ok: payload.ok });
      return { accepted: true };
    }
    if (command === "update_start") return this.start(payload.version);
    throw updateError("不支持此更新操作。");
  }
  async status() {
    await this.ready;
    return publicUpdate(await readJson(join(this.home, "current.json")));
  }
  async blocked() {
    await this.ready;
    const job = await readJson(join(this.home, "current.json"));
    return Boolean(job && !terminal(job.phase));
  }
  async start(target) {
    await this.ready;
    const previous = await readJson(join(this.home, "current.json"));
    if (previous && !terminal(previous.phase)) return this.status();
    const clients = await this.clients();
    if (clients.some(client => !client.directory || !client.version || !["chrome", "edge", "bitbrowser"].includes(client.browser.kind))) throw updateError("有环境尚未确认插件目录或浏览器类型，请先完成初始化后重试。");
    const directories = await managedDirectories(this.root, this.bitRoot);
    let floor = clients.reduce((value, client) => compareVersions(value, client.version) < 0 ? client.version : value, APP_VERSION);
    for (const directory of directories) {
      const manifest = await readJson(join(directory, "manifest.json"));
      if (compareVersions(manifest.version, floor) > 0) floor = manifest.version;
    }
    const resume = previous?.phase === "restart_failed" && previous.version === target && compareVersions(target, floor) >= 0 &&
      (await readJson(join(previous.work, "journal.json")))?.installed;
    const candidate = resume ? null : await this.release(floor);
    if (!resume && (!candidate.installer || candidate.version !== target || compareVersions(target, floor) < 0)) throw updateError("没有匹配且不降级的正式安装包。");
    const profiles = await this.bit.profiles(clients);
    try { await mkdir(join(this.home, "lock")); }
    catch (error) { if (error.code === "EEXIST") throw updateError("已有更新正在进行，请重新检查更新状态。"); throw error; }
    const job = resume ? previous : { jobId: randomUUID(), version: target, root: this.root,
      directories, profiles, expected: clients.map(updateMember), installer: candidate.installer };
    const unlock = () => rm(join(this.home, "lock"), { recursive: true, force: true });
    try {
      await updateState(this.home, job, { ownerPid: process.pid, prepareToken: randomUUID(), phase: "preparing",
        message: resume ? "正在保存相关任务并重试环境重开／核验…" : "正在保存并暂停所有相关环境的任务…" });
    } catch (error) { await unlock(); throw error; }
    this.performing = this.perform(job, clients, resume).catch(async error => {
      const message = error.code === "UPDATE_FAILED" ? error.message : "更新未完成，请重新检查更新，任务保持暂停。";
      await updateState(this.home, job, { phase: resume ? "restart_failed" : "failed", message }).catch(() => {});
      await unlock();
    });
    return this.status();
  }
  async perform(job, initialClients, resume) {
    const deadline = Date.now() + this.prepareTimeout;
    // Save acknowledgements belong to this connection. Version verification survives reconnects.
    const connections = new Map(initialClients.map(client => [client.id, client]));
    let members;
    while (true) {
      for (const client of await this.clients()) connections.set(client.id, client);
      members = [...connections.values()];
      const acknowledgements = await Promise.all(members.map(client => readJson(join(this.home, `${job.jobId}.${client.id}.prepared.json`))));
      if (acknowledgements.some(ack => ack?.prepareToken === job.prepareToken && !ack.ok)) throw updateError("有环境无法保存任务或费用，已停止更新，任务保持暂停。");
      if (members.length && members.every(client => client.directory && client.clientId) && acknowledgements.every(ack => ack?.prepareToken === job.prepareToken && ack.ok)) break;
      if (Date.now() >= deadline) throw updateError("30 秒内未收到全部环境的保存确认，未替换文件。");
      await delay(100);
    }
    if (members.some(client => !["chrome", "edge", "bitbrowser"].includes(client.browser?.kind) || !job.directories.includes(client.directory) || compareVersions(client.version, job.version) > 0)) throw updateError("有环境的浏览器、目录或版本发生变化，请重新检查更新，未替换文件。");
    const expected = new Map((resume ? job.expected : []).map(client => [client.clientId, client]));
    for (const client of members) expected.set(client.clientId, updateMember(client));
    job.expected = [...expected.values()];
    const live = await this.clients();
    const profiles = await this.bit.profiles(live);
    job.profiles = [...new Set([...job.profiles, ...profiles])];
    if ((await readJson(join(this.home, job.jobId, "journal.json")))?.installed) {
      await this.spawnWorker(job);
      await updateState(this.home, job, { phase: "installing", message: "正在重新核验已安装版本…" }); return;
    }
    const directory = join(this.home, job.jobId); await mkdir(directory);
    job.work = directory;
    await updateState(this.home, job, { phase: "downloading", size: job.installer.size, message: "正在下载已发布的配套安装包…" });
    await this.download(job.installer, join(directory, "setup.exe"), bytes => updateState(this.home, job, { bytes }));
    const current = await this.clients();
    if (current.some(client => {
      const prepared = connections.get(client.id);
      return !prepared || prepared.directory !== client.directory || prepared.clientId !== client.clientId;
    })) throw updateError("下载期间有新环境连接，请重新更新以保存全部环境的任务。");
    await this.bit.profiles(current);
    // The worker and its runtime live outside the files that the installer replaces.
    const source = fileURLToPath(new URL("..", import.meta.url));
    await cp(join(source, "server"), join(directory, "code", "server"), { recursive: true });
    await cp(join(source, "extension"), join(directory, "code", "extension"), { recursive: true });
    await cp(join(source, "package.json"), join(directory, "code", "package.json"));
    await cp(join(this.root, "runtime", "node.exe"), join(directory, "node.exe"));
    await this.spawnWorker(job);
    await updateState(this.home, job, { phase: "installing", message: "安装包校验通过，正在断开组件并安装…" });
  }
  async spawnWorker(job) {
    if (this.launch) await this.launch(job);
    else {
      const child = spawn(join(job.work, "node.exe"), [join(job.work, "code", "server", "update-worker.js"), this.root, job.jobId], { detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, OPENROUTER_API_KEY: "" } });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); child.unref();
    }
  }
  close() {
    this.closed = true; clearInterval(this.timer);
    return this.ready.then(() => this.leaseWrites(() => unlink(this.leasePath).catch(() => {})));
  }
}
