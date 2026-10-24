import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createQueue } from "../extension/queue.js";

const unavailable = () => Object.assign(new Error("模型账户保存失败，请检查组件安装目录，或通过安装向导更新。"), { code: "KEY_SAVE_FAILED", status: 503 });

// Only the Windows helper sees DPAPI. Keys travel through pipes, never arguments.
function keyTool(executable, action, input = "") {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, [action], { windowsHide: true, timeout: 8000, maxBuffer: 16384, encoding: "utf8" },
      (error, output) => error ? reject(unavailable()) : resolve(output.trim()));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export class Credentials {
  constructor(directory, run = keyTool) {
    this.executable = join(directory, "AutoReplyHost.exe");
    this.file = join(directory, "config", "openrouter-key.dat");
    this.run = run;
    this.signature = null;
    this.enqueue = createQueue();
  }

  async read(settings) {
    let file;
    try { file = await stat(this.file, { bigint: true }); }
    catch (error) { if (error.code !== "ENOENT") throw unavailable(); }
    const signature = file ? `${file.mtimeNs}:${file.ctimeNs}:${file.ino}:${file.size}` : "missing";
    if (signature === this.signature) return;
    settings.apiKey = file ? await this.run(this.executable, "--read-key") : "";
    this.signature = signature;
  }

  refresh(settings) { return this.enqueue(() => this.read(settings)); }

  save(value, settings) {
    const key = typeof value === "string" ? value.trim() : "";
    if (!key || key.length > 4096 || /[\s\x00-\x1f\x7f]/.test(key)) {
      return Promise.reject(Object.assign(new Error("请填写有效的 API Key，不要包含换行或空格。"), { code: "INPUT_INVALID", status: 400 }));
    }
    return this.enqueue(async () => {
      await this.run(this.executable, "--save-key", key);
      this.signature = null;
      await this.read(settings);
      if (!settings.apiKey) throw unavailable();
    });
  }
}
