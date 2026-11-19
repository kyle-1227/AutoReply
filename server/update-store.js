import { readFile, writeFile, rename, mkdir, readdir, realpath, unlink } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export { UPDATE_FILE } from "../extension/update-protocol.js";
import { UPDATE_FILE, finishedUpdate } from "../extension/update-protocol.js";
export const EXTENSION_ID = "iimkikmnlcfhpikaipbdfiflklnmfaao";
export const PROBE_FILE = ".autoreply-probe.json";
export const terminal = finishedUpdate;
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export const updateError = message => Object.assign(new Error(message), { code: "UPDATE_FAILED", status: 409 });
export async function readJson(path, fallback = null) {
  try { return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
export async function writeJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, path); return; }
      catch (error) {
        if (attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
        await delay(25 * (attempt + 1));
      }
    }
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}
export async function liveClients(home, isAlive = processAlive) {
  const directory = join(home, "clients");
  const files = (await readdir(directory)).filter(name => /^[\w-]+\.json$/.test(name));
  const clients = await Promise.all(files.map(name => readJson(join(directory, name))));
  return clients.filter(client => client && isAlive(client.pid));
}
export function version(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw updateError("更新版本格式无效。");
  const parts = value.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw updateError("更新版本格式无效。");
  return parts;
}
export function compareVersions(a, b) {
  const x = version(a), y = version(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
export function extensionId(manifest) {
  if (typeof manifest?.key !== "string") return null;
  return [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16)]
    .map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
}
export function within(root, path) {
  const part = relative(resolve(root), resolve(path));
  return !isAbsolute(part) && part !== ".." && !part.startsWith("..\\") && !part.startsWith("../");
}
export async function managedDirectories(root, bitRoot) {
  const found = new Set();
  async function visit(path, boundary, depth) {
    let resolved;
    try { resolved = await realpath(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!within(boundary, resolved)) return;
    const manifest = await readJson(join(resolved, "manifest.json"));
    if (manifest && extensionId(manifest) === EXTENSION_ID) { found.add(resolved); return; }
    if (!depth) return;
    for (const entry of await readdir(resolved, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(join(resolved, entry.name), boundary, depth - 1);
    }
  }
  await visit(join(root, "extension"), root, 0);
  if (bitRoot) await visit(bitRoot, bitRoot, 3);
  return [...found];
}
export function publicUpdate(job) {
  return job && { jobId: job.jobId, version: job.version, phase: job.phase, revision: job.revision,
    message: job.message || "", bytes: job.bytes || 0, size: job.size || 0, failedProfiles: job.failedProfiles || [] };
}
export async function updateState(home, job, patch = {}) {
  Object.assign(job, patch, { revision: (job.revision || 0) + 1, updatedAt: Date.now() });
  await writeJson(join(home, "current.json"), job);
  const publicState = publicUpdate(job);
  for (const directory of job.directories || []) await writeJson(join(directory, UPDATE_FILE), publicState);
  return publicState;
}
export async function createHome(root) {
  const home = join(root, ".updates");
  await mkdir(join(home, "clients"), { recursive: true });
  return home;
}
