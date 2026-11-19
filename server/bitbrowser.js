import { join } from "node:path";
import { readJson, writeJson, updateError } from "./update-store.js";
import { Credentials } from "./credentials.js";

export class BitBrowser {
  constructor(root, request = fetch) {
    this.root = root; this.request = request; this.auth = {};
    this.credentials = new Credentials(root, undefined, { filename: "bitbrowser-key.dat", readAction: "--read-update-key", saveAction: "--save-update-key" });
  }
  async settings() {
    const config = await readJson(join(this.root, "config", "bitbrowser.json"), { port: 54345 });
    if (!Number.isInteger(config?.port) || config.port < 1 || config.port > 65535) throw updateError("BitBrowser 本机 API 配置无效，请重新保存连接设置。");
    return config;
  }
  async save({ port, token }) {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== "string") throw updateError("请输入有效的本机 API 端口。");
    if (token.trim()) await this.credentials.save(token, this.auth);
    await writeJson(join(this.root, "config", "bitbrowser.json"), { port });
    return this.status();
  }
  async status() {
    const config = await this.settings();
    await this.credentials.read(this.auth);
    return { port: config.port, hasToken: Boolean(this.auth.apiKey) };
  }
  async call(command, payload = {}) {
    if (!["health", "browser/pids/all", "browser/close", "browser/open"].includes(command)) throw updateError("不支持此浏览器操作。");
    const config = await this.settings(); await this.credentials.read(this.auth);
    let response;
    try { response = await this.request(`http://127.0.0.1:${config.port}/${command}`, { method: "POST",
      headers: { "Content-Type": "application/json", ...(this.auth.apiKey ? { "x-api-key": this.auth.apiKey } : {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
    } catch { throw updateError("BitBrowser Local API 未连接，请确认程序、端口和认证设置。"); }
    if (!response.ok) throw updateError("BitBrowser API 不可用或没有操作权限，请检查连接设置。");
    const data = await response.json();
    if (data.success === false) throw updateError("BitBrowser API 拒绝了操作，请检查权限。");
    return data.data ?? data;
  }
  async profiles(clients) {
    const relevant = clients.filter(client => client.browser?.kind === "bitbrowser");
    if (!relevant.length) return [];
    const opened = await this.call("browser/pids/all");
    const ids = relevant.map(client => Object.keys(opened).find(id => Number(opened[id]) === client.browser.pid));
    if (ids.some(id => !id)) throw updateError("无法确认相关 BitBrowser 环境归属，未重启任何环境。");
    return [...new Set(ids)];
  }
}
