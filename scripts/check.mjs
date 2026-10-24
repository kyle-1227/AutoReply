import { readFile, readdir, access } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extension = join(root, "extension");
const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const files = await readdir(extension);
const scripts = new Map();
for (const directory of ["extension", "server", "scripts", "tests"]) {
  for (const name of await readdir(join(root, directory), { recursive: true })) {
    if (!/\.(?:mjs|js)$/.test(name)) continue;
    const path = join(root, directory, name);
    execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
    scripts.set(path, await readFile(path, "utf8"));
  }
}
const ids = new Set();
const references = [];
for (const name of files.filter(name => name.endsWith(".html"))) {
  const html = await readFile(join(extension, name), "utf8");
  const pageIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  if (new Set(pageIds).size !== pageIds.length) throw new Error(`Duplicate HTML ID in ${name}.`);
  pageIds.forEach(id => ids.add(id));
  for (const [, values] of html.matchAll(/\b(?:for|aria-controls|aria-labelledby|aria-describedby|data-close)="([^"]+)"/g)) {
    for (const id of values.split(/\s+/)) if (!pageIds.includes(id)) throw new Error(`Missing ${id} in ${name}.`);
  }
  references.push(...[...html.matchAll(/\b(?:src|href)="([^"#]+)"/g)].map(match => match[1]));
}
for (const name of files.filter(name => name.endsWith(".js"))) {
  const source = scripts.get(join(extension, name));
  for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) if (!ids.has(id)) throw new Error(`Missing element ${id} used by ${name}.`);
}
for (const name of new Set([manifest.background.service_worker, manifest.side_panel.default_path,
  ...Object.values(manifest.icons), "floating.js", "busy.html", ...references])) {
  await access(join(extension, name));
}
// Validate relative imports against their actual module, including server imports
// of shared extension validators.
for (const [path, source] of scripts) {
  if (path.startsWith(join(root, "server")) && /node:sqlite|DatabaseSync|editProduct\(|service\.catalog\(/.test(source)) {
    throw new Error(`Product storage must stay in the browser environment: ${path}`);
  }
  for (const [, reference] of source.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/g)) {
    await access(resolve(dirname(path), reference));
  }
}
for (const name of files.filter(name => /\.(js|html)$/.test(name))) {
  const source = await readFile(join(extension, name), "utf8");
  if (/Write a concise, natural public seller reply|api\/v1\/chat\/completions|id="prompt-text"|127\.0\.0\.1:8787|connection-token|open-settings/.test(source)) throw new Error(`Backend-only or obsolete connection content in ${name}`);
}
await access(join(root, "安装说明.md"));
if (metadata.version !== manifest.version) throw new Error("Package and extension versions must match.");
if (manifest.manifest_version !== 3) throw new Error("Expected Manifest V3.");
if (manifest.host_permissions?.join(",") !== "http://*/*,https://*/*") throw new Error("Expected ordinary-page access for the moving status badge.");
if (manifest.permissions.join(",") !== "sidePanel,storage,alarms,tabs,scripting,nativeMessaging") throw new Error("Unexpected permissions.");
if (!manifest.key) throw new Error("A stable extension identity is required.");
if (!manifest.content_security_policy.extension_pages.includes("connect-src 'none'")) throw new Error("Extension network requests must go through Native Messaging.");
if (Number(manifest.minimum_chrome_version) < 142) throw new Error("Side panel close events require Chromium 142+.");
console.log(`Source check passed: ${scripts.size} JavaScript files, valid imports, UI references, manifest and local assets.`);
