// @ts-check
// Build first; verify the ChartRuntime's static graph excludes optional GPU modules.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/features/chart/ChartRuntime.js");
const forbidden = /(?:^|\/)features\/chart\/heatmap\/gpu\/heatmapGpu(?:Renderer|Shaders)|(?:^|\/)core\/gpu\/webgpu\/(?:webgpuDevice|webgpuSurface)(?:\.js)?$/;
const seen = new Set();
const pending = [root];
const importPattern = /(?:\bimport\s*(?:\([^)]*\)\s*|(?:[^"'()]*?\s+from\s*)?)|\bexport\s+[^"'()]*?\s+from\s*)["']([^"']+)["']/g;

while (pending.length) {
  const file = pending.pop();
  if (!file || seen.has(file)) continue;
  seen.add(file);
  const relative = file.replaceAll("\\", "/").replace(/^.*\/dist\//, "");
  if (forbidden.test(relative)) {
    console.error(`Forbidden optional GPU module in default static import graph: ${relative}`);
    process.exitCode = 1;
    continue;
  }
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const target = resolve(dirname(file), specifier);
    // Dynamic imports are not part of this graph; match groups starting at "import(".
    if (/^import\s*\(/.test(match[0])) continue;
    pending.push(target);
  }
}
if (!process.exitCode) console.log(`Default ChartRuntime static graph OK (${seen.size} modules)`);
