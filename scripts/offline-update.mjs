import { cp, mkdir, realpath, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

// Runs only from the Windows installer's embedded resource, after download verification.
async function install({ root, installer, version, bytes, sha256 }) {
  root = await realpath(root);
  const load = path => import(pathToFileURL(path).href);
  const { compareVersions, createHome, liveClients, managedDirectories, readJson, terminal, updateError, updateState } =
    await load(join(root, "server", "update-store.js"));
  const home = await createHome(root), lock = join(home, "lock");
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === "EEXIST") throw updateError("已有更新正在进行，请在 AutoReply 中确认其状态后重试。");
    throw error;
  }
  let job, handedOff = false;
  try {
    const previous = await readJson(join(home, "current.json"));
    if (previous && !terminal(previous.phase)) throw updateError("有未结束的更新，请在 AutoReply 中确认其状态。");
    if ((await liveClients(home)).length) throw updateError("请先暂停任务并关闭使用 AutoReply 的浏览器环境。");
    const bitRoot = process.env.APPDATA && join(process.env.APPDATA, "BitBrowser", "BitExtensions");
    const directories = await managedDirectories(root, bitRoot);
    const current = await readJson(join(root, "package.json"));
    const manifests = await Promise.all(directories.map(directory => readJson(join(directory, "manifest.json"))));
    if ([current, ...manifests].some(file => compareVersions(version, file.version) < 0))
      throw updateError("有组件或受控扩展版本高于目标版本，已保留本机版本。");
    if (!directories.includes(join(root, "extension"))) throw updateError("安装目录中的扩展身份无法核对。");

    const jobId = randomUUID(), work = join(home, jobId);
    await mkdir(work);
    await cp(installer, join(work, "setup.exe"));
    // Keep the recovery worker and runtime outside the files the installer replaces.
    for (const name of ["server", "extension", "package.json"])
      await cp(join(root, name), join(work, "code", name), { recursive: true });
    await cp(process.execPath, join(work, "node.exe"));
    const { applyUpdate } = await load(join(work, "code", "server", "update-worker.js"));
    if ((await liveClients(home)).length) throw updateError("有浏览器环境重新连接，请关闭后重试。");
    job = { jobId, root, work, directories, profiles: [], expected: [], version, ownerPid: process.pid,
      installer: { size: bytes, sha256 } };
    await updateState(home, job, { phase: "installing", message: "正在从统一安装器更新 AutoReply…" });
    handedOff = true;
    await applyUpdate(root, jobId);
    const updated = await readJson(join(home, "current.json"));
    if (updated?.jobId !== jobId || updated.phase !== "completed")
      throw updateError(updated?.jobId === jobId ? updated.message : "安装后的版本核验未完成。");
  } finally {
    if (!handedOff) {
      if (job) await updateState(home, job, { phase: "failed", message: "统一安装器未能完成准备，任务已保留。" }).catch(() => {});
      await rmdir(lock).catch(() => {});
    }
  }
}

try {
  let input = "";
  for await (const chunk of process.stdin.setEncoding("utf8")) {
    input += chunk;
    if (input.length > 16384) throw new Error("Unexpected installer input");
  }
  await install(JSON.parse(input));
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, message: error.code === "UPDATE_FAILED" ? error.message :
    "覆盖安装未完成，请关闭相关浏览器环境并重试。" }));
  process.exitCode = 1;
}
