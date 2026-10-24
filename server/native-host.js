import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReplyService } from "./service.js";
import { DEFAULT_SETTINGS } from "./reply-generator.js";
import { PROTOCOL_VERSION, MAX_MESSAGE_BYTES } from "../extension/protocol.js";
import { Credentials } from "./credentials.js";
import { isActive } from "../extension/model.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const fail = message => { throw Object.assign(new Error(message), { status: 400, code: "INPUT_INVALID" }); };

export function dispatch(service, command, payload, credentials = null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("请求参数格式无效。");
  if (command === "health") return { protocolVersion: PROTOCOL_VERSION, componentVersion: version,
    hasModelKey: Boolean(service.settings.apiKey), canSaveKey: Boolean(credentials) };
  if (command === "credentials") {
    if (!credentials) fail("请安装支持插件内填写 API Key 的新版本机组件。");
    if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, "apiKey")) fail("模型账户参数无效。");
    if ([...service.runs.values()].some(isActive)) fail("请先暂停本浏览器环境中的生成任务，再更新 API Key。");
    return credentials.save(payload.apiKey, service.settings).then(() => ({ hasModelKey: Boolean(service.settings.apiKey) }));
  }
  const { taskId, ...input } = payload;
  if (typeof taskId !== "string" || !/^[\w-]{1,100}$/.test(taskId)) fail("任务标识无效。");
  if (command === "control") return service.control(taskId, input);
  if (command === "heartbeat") return service.heartbeat(taskId, input.generation);
  if (command === "generate") {
    if (Object.keys(input).some(key => !["generation", "review", "product"].includes(key))) fail("生成只接受评价、当前商品资料和执行代次。");
    return service.submit(taskId, input);
  }
  if (command === "operation" && /^[a-f0-9]{64}$/.test(input.operationId || "")) return service.operation(input.operationId, taskId);
  fail("无法识别本机处理命令。");
}

// Each stdout write is one complete frame. No logs or credentials enter stdout.
export function startHost(service, { input = process.stdin, output = process.stdout, credentials = null } = {}) {
  let buffer = Buffer.alloc(0), closed = false;
  const timer = setInterval(() => service.cleanup(), 60000);
  const close = () => {
    if (closed) return;
    closed = true; clearInterval(timer); buffer = Buffer.alloc(0); service.close();
    input.removeListener("data", receive);
  };
  const send = message => {
    if (closed) return;
    let body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_MESSAGE_BYTES) body = Buffer.from(JSON.stringify({ requestId: message.requestId, ok: false,
      error: { status: 413, code: "MESSAGE_TOO_LARGE", message: "本机响应超过 1 MiB，未截断结果。" } }));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    output.write(Buffer.concat([header, body]));
  };
  const handle = async message => {
    const requestId = message?.requestId;
    try {
      if (typeof requestId !== "string" || requestId.length > 100) fail("请求标识无效。");
      if (credentials && ["health", "control", "generate"].includes(message.command)) await credentials.refresh(service.settings);
      const data = await dispatch(service, message.command, message.payload, credentials);
      send({ requestId, ok: true, data });
    } catch (error) {
      const status = error.status || 500;
      send({ requestId, ok: false, error: { status, code: error.code || "COMPONENT_ERROR",
        message: status === 500 ? "本机处理失败。" : error.message } });
    }
  };
  function receive(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (!length || length > MAX_MESSAGE_BYTES) { close(); input.destroy(); return; }
      if (buffer.length < length + 4) return;
      let message;
      try { message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")); }
      catch { close(); input.destroy(); return; }
      buffer = buffer.subarray(length + 4);
      void handle(message);
    }
  }
  input.on("data", receive);
  input.once("end", close); input.once("error", close); output.once("error", close);
  return close;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = new ReplyService({ settings: { ...DEFAULT_SETTINGS } });
  const credentials = new Credentials(fileURLToPath(new URL("..", import.meta.url)));
  const close = startHost(service, { credentials });
  process.once("SIGTERM", () => { close(); process.exit(0); });
  process.once("SIGINT", () => { close(); process.exit(0); });
}
