import { readFile, readdir, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extension = join(root, "extension");
const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const files = await readdir(extension);
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
  execFileSync(process.execPath, ["--check", join(extension, name)], { stdio: "pipe" });
  const source = await readFile(join(extension, name), "utf8");
  references.push(...[...source.matchAll(/from\s+"(\.\/[^\"]+)"/g)].map(match => match[1]));
  for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) if (!ids.has(id)) throw new Error(`Missing element ${id} used by ${name}.`);
}
for (const name of new Set([manifest.background.service_worker, manifest.side_panel.default_path,
  ...Object.values(manifest.icons), "floating.js", "busy.html", ...references])) {
  await access(join(extension, name));
}
await access(join(root, "安装说明.md"));
if (metadata.version !== manifest.version) throw new Error("Package and extension versions must match.");
if (manifest.manifest_version !== 3) throw new Error("Expected Manifest V3.");
if (manifest.host_permissions?.join(",") !== "http://*/*,https://*/*") throw new Error("Expected ordinary-page access for the moving status badge.");
if (manifest.permissions.join(",") !== "sidePanel,storage,alarms,tabs,scripting") throw new Error("Unexpected permissions.");
if (Number(manifest.minimum_chrome_version) < 142) throw new Error("Side panel close events require Chromium 142+.");
console.log(`Extension check passed: ${files.filter(name => name.endsWith(".js")).length} JavaScript modules, valid manifest and local assets.`);
