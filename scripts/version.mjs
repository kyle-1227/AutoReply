import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// package.json is authoritative; protocol.js carries the same value into both runtimes.
const documents = ["README.md", "安装说明.md", "评价接入约定.md", "项目需求文档.md"];
export async function syncVersion(root, requested, check = false) {
  const names = ["package.json", "extension/manifest.json", "extension/protocol.js", ...documents];
  const originals = new Map(await Promise.all(names.map(async name => [name, await readFile(join(root, name), "utf8")])));
  const metadata = JSON.parse(originals.get("package.json"));
  const version = requested || metadata.version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Use a stable major.minor.patch version.");
  const manifest = JSON.parse(originals.get("extension/manifest.json"));
  const protocol = originals.get("extension/protocol.js");
  if (!/export const APP_VERSION = "[^"]+";/.test(protocol)) throw new Error("Missing shared application version.");
  const runtimeVersion = metadata.engines.node.match(/\d+\.\d+\.\d+/)[0];
  const contents = new Map([
    ["package.json", JSON.stringify({ ...metadata, version }, null, 2) + "\n"],
    ["extension/manifest.json", JSON.stringify({ ...manifest, version }, null, 2) + "\n"],
    ["extension/protocol.js", protocol.replace(/export const APP_VERSION = "[^"]+";/, `export const APP_VERSION = "${version}";`)],
  ]);
  for (const name of documents) {
    const text = originals.get(name);
    contents.set(name, text.replace(/\d+\.\d+\.\d+/g, found => found === runtimeVersion ? found : version));
  }
  for (const [name, contentsToWrite] of contents) {
    const existing = originals.get(name);
    if (existing.replaceAll("\r\n", "\n") === contentsToWrite.replaceAll("\r\n", "\n")) continue;
    if (check) throw new Error(`Version drift in ${name}; run npm.cmd run version:sync.`);
    await writeFile(join(root, name), contentsToWrite);
  }
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const version = await syncVersion(fileURLToPath(new URL("..", import.meta.url)), process.argv.slice(2).find(arg => arg !== "--check"), check);
  console.log(`Application version ${version}: ${check ? "consistent" : "synchronized"}.`);
}
