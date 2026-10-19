// File objects and object URLs live only in this sidebar document.
const sessionFiles = new Map();

export function addFiles(files) {
  const attachments = [];
  const rejected = [];
  for (const file of files) {
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      rejected.push(file.name);
      continue;
    }
    const id = crypto.randomUUID();
    sessionFiles.set(id, { file, url: URL.createObjectURL(file) });
    attachments.push({ id, name: file.name, type: file.type, size: file.size });
  }
  return { attachments, rejected };
}

export function releaseFile(id) {
  const entry = sessionFiles.get(id);
  if (entry) URL.revokeObjectURL(entry.url);
  sessionFiles.delete(id);
}

export function releaseAllFiles() {
  for (const id of sessionFiles.keys()) releaseFile(id);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function mediaKey(attachments) {
  return attachments.map(item => `${item.id}:${sessionFiles.has(item.id)}`).join(",");
}

function missingPreview(isVideo, error = false) {
  const box = element("div", `media-missing${error ? " media-error" : ""}`);
  box.append(element("strong", "", isVideo ? "视频" : "图片"),
    element("span", "", error ? "无法预览，请换用浏览器可播放的格式" : "附件未保留，请重新选择"));
  return box;
}

export function renderMedia(container, attachments, onRemove) {
  container.querySelectorAll("video").forEach(video => video.pause());
  container.replaceChildren();
  for (const attachment of attachments) {
    const entry = sessionFiles.get(attachment.id);
    const isVideo = attachment.type.startsWith("video/");
    const card = element("div", "media-card");
    if (entry) {
      const preview = element(isVideo ? "video" : "img");
      if (isVideo) {
        preview.controls = true;
        preview.preload = "metadata";
        preview.setAttribute("aria-label", attachment.name);
      } else {
        preview.alt = attachment.name;
        preview.loading = "lazy";
      }
      preview.addEventListener("error", () => preview.replaceWith(missingPreview(isVideo, true)), { once: true });
      preview.src = entry.url;
      card.append(preview);
    } else {
      card.append(missingPreview(isVideo));
    }
    const meta = element("div", "media-meta");
    const name = element("p", "media-name", attachment.name);
    name.title = attachment.name;
    meta.append(name, element("p", "media-size", `${isVideo ? "视频" : "图片"} · ${formatSize(attachment.size)}`));
    card.append(meta);
    if (onRemove) {
      const remove = element("button", "media-remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `移除 ${attachment.name}`);
      remove.addEventListener("click", () => onRemove(attachment.id));
      card.append(remove);
    }
    container.append(card);
  }
}
import { element } from "./ui.js";

