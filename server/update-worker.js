import { cp, rm, mkdir, readdir, readFile, stat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BitBrowser } from "./bitbrowser.js";
import { readJson, writeJson, updateState, liveClients, processAlive, extensionId, EXTENSION_ID, within, updateError } from "./update-store.js";

const exec = promisify(execFile);
const owned = ["extension", "server", "runtime", "AutoReplyHost.exe", "AutoReplySetup.exe", "native-host.json", "package.json", "Uninstall.exe",
  "README.md", "安装说明.md", "评价接入约定.md", "PRODUCT_POSITIONING.md", "项目需求文档.md"];
const exists = path => stat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
export async function hostHealth(root) {
  return new Promise((yes, no) => {
    const child = spawn(join(root, "AutoReplyHost.exe"), [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, AUTOREPLY_UPDATE_HEALTH: "1", OPENROUTER_API_KEY: "" } });
    let data = Buffer.alloc(0), finished = false;
    const timer = setTimeout(() => { child.kill(); no(updateError("新版组件未能启动。")); }, 15000);
    child.once("error", () => { clearTimeout(timer); no(updateError("新版组件未能启动。")); });
    child.stdout.on("data", bytes => {
      data = Buffer.concat([data, bytes]);
      if (data.length < 4) return;
      const length = data.readUInt32LE(0);
      if (length > 1024 * 1024) { child.kill(); clearTimeout(timer); no(updateError("组件核验返回无效。")); return; }
      if (data.length < length + 4 || finished) return;
      finished = true; clearTimeout(timer); child.stdin.end();
      try { const response = JSON.parse(data.subarray(4, length + 4)); response.ok ? yes(response.data) : no(updateError("组件核验未通过。")); }
      catch { no(updateError("组件核验返回无效。")); }
    });
    child.once("exit", () => { if (!finished) { clearTimeout(timer); no(updateError("组件核验未通过。")); } });
    const body = Buffer.from(JSON.stringify({ requestId: "update-health", command: "health", payload: {} })), size = Buffer.alloc(4); size.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([size, body]));
  });
}
async function recoveryCommand(job, enabled) {
  if (process.platform !== "win32") return;
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce", name = `AutoReplyUpdate-${job.jobId}`;
  if (!enabled) { await exec("reg.exe", ["delete", key, "/v", name, "/f"], { windowsHide: true }).catch(() => {}); return; }
  const quote = value => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  const command = [join(job.work, "node.exe"), join(job.work, "code", "server", "update-worker.js"), job.root, job.jobId].map(quote).join(" ");
  await exec("reg.exe", ["add", key, "/v", name, "/t", "REG_SZ", "/d", command, "/f"], { windowsHide: true });
}
export async function applyUpdate(root, jobId, options = {}) {
  root = resolve(root);
  if (!/^[a-f0-9-]{36}$/.test(jobId)) throw updateError("更新任务编号无效。");
  const home = join(root, ".updates"), job = await readJson(join(home, "current.json"));
  if (!job || job.jobId !== jobId || job.root !== root || resolve(job.work) !== join(home, jobId)) throw updateError("更新任务归属无效。");
  const bit = options.bit || new BitBrowser(root), health = options.health || hostHealth;
  const scheduleRecovery = options.scheduleRecovery || recoveryCommand;
  const install = options.install || (async () => {
    const args = ["/S", "/AUTOUPDATE", ...(await exists(join(root, ".autoreply-isolated")) ? ["/ISOLATED"] : []), `/D=${root}`];
    await exec(join(job.work, "setup.exe"), args, { windowsHide: true, windowsVerbatimArguments: true, timeout: 180000, maxBuffer: 16384 });
  });
  const journalPath = join(job.work, "journal.json"), backup = join(job.work, "backup");
  let journal = await readJson(journalPath, { backedUp: false, installing: false, installed: false, closed: [] });
  const checkpoint = async () => writeJson(journalPath, journal);
  async function restore() {
    for (const name of owned) {
      const destination = join(root, name);
      if (!within(root, destination)) throw updateError("恢复目录无效。");
      await rm(destination, { force: true, recursive: true });
      if (await exists(join(backup, name))) await cp(join(backup, name), destination, { recursive: true });
    }
    for (const [index, directory] of job.directories.entries()) {
      if (directory === join(root, "extension")) continue;
      await rm(directory, { recursive: true, force: true });
      await cp(join(backup, `cache-${index}`), directory, { recursive: true });
    }
    const metadata = await readJson(join(root, "package.json"));
    if (process.platform === "win32" && !await exists(join(root, ".autoreply-isolated"))) {
      await exec("reg.exe", ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AutoReply", "/v", "DisplayVersion", "/t", "REG_SZ", "/d", metadata.version, "/f"], { windowsHide: true });
    }
    journal.installed = false; journal.installing = false; await checkpoint();
  }
  async function openProfiles() {
    const failed = [];
    for (const id of journal.closed) {
      try { await bit.call("browser/open", { id }); }
      catch { failed.push(id); }
    }
    return failed;
  }
  let workerLocked = false;
  try {
    for (let i = 0; ["downloading", "preparing"].includes(job.phase) && i < 300; i++) {
      await delay(100); Object.assign(job, await readJson(join(home, "current.json")));
    }
    if (!["installing", "restarting", "verifying", "restart_failed", "recovery_required"].includes(job.phase)) throw updateError("更新任务未进入可安装阶段。");
    const lock = join(job.work, "worker.lock");
    try { await mkdir(lock); workerLocked = true; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const holder = await readJson(join(lock, "pid.json"));
      if (processAlive(holder?.pid)) return;
      await rm(lock, { recursive: true, force: true }); await mkdir(lock); workerLocked = true;
    }
    await writeJson(join(lock, "pid.json"), { pid: process.pid });
    job.workerPid = process.pid;
    // Recheck all target boundaries in the process that performs destructive operations.
    const bitRoot = process.env.APPDATA && join(process.env.APPDATA, "BitBrowser", "BitExtensions");
    for (const directory of job.directories) {
      if (directory !== join(root, "extension") && !(bitRoot && within(bitRoot, directory))) throw updateError("扩展更新目录不在允许范围内。");
      if (await realpath(directory) !== directory) throw updateError("扩展更新目录已重定向，未替换文件。");
      if (extensionId(await readJson(join(directory, "manifest.json"))) !== EXTENSION_ID) throw updateError("扩展身份发生变化，已停止更新。");
    }
    if (journal.installing && !journal.installed) {
      await restore(); const recovery = await openProfiles();
      await updateState(home, job, { phase: "rolled_back", message: "中断的安装已恢复到上一版本，任务保持暂停。", failedProfiles: recovery.failed }); return;
    }
    if (!journal.installed) {
      const bytes = await readFile(join(job.work, "setup.exe"));
      if (bytes.length !== job.installer.size || createHash("sha256").update(bytes).digest("hex") !== job.installer.sha256) throw updateError("安装包复核失败，未执行安装。");
      if (!options.install) {
        const info = await exec(join(root, "AutoReplyHost.exe"), ["--installer-version", join(job.work, "setup.exe")], { windowsHide: true });
        if (info.stdout.trim() !== job.version) throw updateError("安装程序的内部版本与发布版本不一致。");
      }
      for (const id of job.profiles) {
        await bit.call("browser/close", { id }); journal.closed.push(id); await checkpoint();
      }
      const deadline = Date.now() + 30000;
      while (!options.install) {
        let busy = (await liveClients(home)).length > 0;
        if (!busy) busy = await exec(join(root, "AutoReplyHost.exe"), ["--in-use"], { windowsHide: true }).then(() => false, () => true);
        if (!busy) break;
        if (Date.now() > deadline) throw updateError("组件仍被其他环境占用，未替换文件。");
        await delay(250);
      }
      await mkdir(backup, { recursive: true });
      for (const name of owned) if (await exists(join(root, name))) await cp(join(root, name), join(backup, name), { recursive: true });
      for (const [index, directory] of job.directories.entries()) if (directory !== join(root, "extension")) await cp(directory, join(backup, `cache-${index}`), { recursive: true });
      journal.backedUp = true; await checkpoint(); await scheduleRecovery(job, true);
      await updateState(home, job, { phase: "installing", message: "正在安装配套组件和插件…" });
      journal.installing = true; await checkpoint();
      await install(job);
      if (!options.install && (await exec(join(root, "AutoReplyHost.exe"), ["--component-version"], { windowsHide: true })).stdout.trim() !== job.version) throw updateError("组件启动器文件版本未更新，已停止核验。");
      const manifest = await readJson(join(root, "extension", "manifest.json"));
      if ((await readJson(join(root, "package.json")))?.version !== job.version || extensionId(manifest) !== EXTENSION_ID ||
          manifest.version !== job.version || (await health(root)).componentVersion !== job.version) throw updateError("新版组件或插件健康检查未通过。");
      for (const directory of job.directories) if (directory !== join(root, "extension")) {
        await rm(directory, { recursive: true, force: true }); await cp(join(root, "extension"), directory, { recursive: true });
      }
      journal.installed = true; journal.installing = false; await checkpoint();
    }
    await updateState(home, job, { phase: "restarting", message: "正在重新打开相关 BitBrowser 环境…" });
    const failedProfiles = await openProfiles();
    if (failedProfiles.length) { await updateState(home, job, { phase: "restart_failed", message: "新版已安装，部分环境未能重新打开，请重试。", failedProfiles }); return; }
    await updateState(home, job, { phase: "verifying", message: "新版已安装，正在核验各环境实际运行的插件和组件…" });
    const expected = new Set(job.expected.map(client => client.clientId));
    const deadline = Date.now() + (options.verifyTimeout ?? 90000);
    while (expected.size) {
      for (const name of await readdir(home)) if (name.startsWith(`${job.jobId}.`) && name.endsWith(".verified.json")) {
        const entry = await readJson(join(home, name));
        if (entry?.version === job.version) expected.delete(entry.clientId);
      }
      if (!expected.size) break;
      if (Date.now() > deadline) { await updateState(home, job, { phase: "restart_failed", message: "文件已更新，仍有环境未完成运行版本核验；重新打开插件后可重试核验。", failedProfiles: [...expected] }); return; }
      await delay(250);
    }
    await updateState(home, job, { phase: "completed", failedProfiles: [], message: "插件和组件已更新，任务保持暂停，请确认来源页后手动继续。" });
    await scheduleRecovery(job, false);
    await rm(join(job.work, "setup.exe"), { force: true });
  } catch (error) {
    let rolledBack = false;
    if (journal.installing && journal.backedUp) {
      try { await restore(); rolledBack = true; } catch { /* Keep recovery command and journal for the next launch. */ }
    }
    await updateState(home, job, { phase: journal.installing ? "recovery_required" : rolledBack ? "rolled_back" : "failed", failedProfiles: await openProfiles(),
      message: journal.installing ? "代码恢复尚未完成，请重启组件重试恢复或通过配套安装包修复，任务保持暂停。" : rolledBack ? "更新未通过核验，已恢复上一版本，任务保持暂停。" : error.code === "UPDATE_FAILED" ? error.message : "更新未完成，请通过配套安装包修复，任务保持暂停。" });
    if (!journal.installing) await scheduleRecovery(job, false);
  } finally {
    if (workerLocked) {
      await rm(join(job.work, "worker.lock"), { recursive: true, force: true });
      if (!journal.installing) await rm(join(home, "lock"), { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyUpdate(process.argv[2], process.argv[3]).catch(() => { process.exitCode = 1; });
}
