import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { compareVersions, version, updateError } from "./update-store.js";

const REPO = "https://api.github.com/repos/kyle-1227/AutoReply";
const PREFIX = "https://github.com/kyle-1227/AutoReply/releases/download/";
const headers = { Accept: "application/vnd.github+json", "User-Agent": "AutoReply-Updater" };
const timeout = signal => signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
async function json(url, signal) {
  const response = await fetch(url, { headers, signal: timeout(signal) });
  if (!response.ok) throw updateError(response.status === 403 || response.status === 429 ? "GitHub 暂时限制检查频率，请稍后重试。" : "无法读取正式发布信息，请检查网络后重试。");
  const text = await response.text();
  if (text.length > 1024 * 1024) throw updateError("发布信息过大，已停止更新。");
  try { return JSON.parse(text); } catch { throw updateError("发布信息格式无效。"); }
}
function asset(release, name) {
  const matches = release.assets?.filter(item => item.name === name && item.state === "uploaded");
  const result = matches?.length === 1 && matches[0];
  if (!result || !result.browser_download_url?.startsWith(`${PREFIX}${release.tag_name}/`) ||
      !Number.isSafeInteger(result.size) || result.size < 1 || result.size > 300 * 1024 * 1024) throw updateError("正式发布缺少匹配的安装包或校验文件。");
  return result;
}
export async function checkRelease(installed, signal) {
  version(installed);
  const release = await json(`${REPO}/releases/latest`, signal);
  if (release.draft || release.prerelease || typeof release.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw updateError("没有可用的正式发布版本。");
  const target = release.tag_name.slice(1);
  if (compareVersions(target, installed) < 0) return { version: target, available: false, message: "本地版本领先于正式发布，不会降级。" };
  const installer = asset(release, `AutoReply-Setup-${target}-win-x64.exe`), metadata = asset(release, "CURRENT.json");
  const index = await json(metadata.browser_download_url, signal);
  const entry = index.files?.filter(file => file.name === installer.name);
  if (index.version !== target || entry?.length !== 1 || entry[0].bytes !== installer.size || !/^[a-f0-9]{64}$/i.test(entry[0].sha256) ||
      installer.digest && installer.digest !== `sha256:${entry[0].sha256.toLowerCase()}`) throw updateError("安装包版本、大小或校验信息不一致。");
  return { version: target, available: compareVersions(target, installed) > 0, message: compareVersions(target, installed) ? "发现可用更新。" : "当前已是最新正式版本。",
    installer: { name: installer.name, url: installer.browser_download_url, size: installer.size, sha256: entry[0].sha256.toLowerCase() } };
}
export async function downloadInstaller(asset, destination, onProgress = async () => {}, signal) {
  if (!asset.url.startsWith(PREFIX) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw updateError("安装包来源无效。");
  const response = await fetch(asset.url, { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw updateError("安装包下载失败，请检查网络后重试。");
  const file = await open(destination, "wx"), hash = createHash("sha256");
  let size = 0, notified = 0;
  try {
    for await (const bytes of response.body) {
      size += bytes.length;
      if (size > asset.size) throw updateError("安装包大小超出发布记录，已停止更新。");
      hash.update(bytes); await file.write(bytes);
      if (size - notified >= 1024 * 1024 || size === asset.size) { notified = size; await onProgress(size); }
    }
    await file.sync();
  } finally { await file.close(); }
  if (size !== asset.size || hash.digest("hex") !== asset.sha256) throw updateError("安装包 SHA-256 校验失败，未执行安装。");
}
