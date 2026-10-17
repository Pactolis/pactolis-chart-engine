// @ts-check
// Every public entry point in package.json must exist in the built package and
// load in plain Node with no host wiring. Run after `npm run build`.
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const problems = [];
for (const [subpath, target] of Object.entries(pkg.exports)) {
  if (typeof target === "string") continue;
  for (const file of [target.types, target.default]) {
    if (!existsSync(new URL(`../${file}`, import.meta.url))) problems.push(`${subpath}: missing ${file}`);
  }
  try {
    await import(`${pkg.name}/${subpath.slice(2)}`);
  } catch (error) {
    problems.push(`${subpath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`${Object.keys(pkg.exports).length} exports OK`);
