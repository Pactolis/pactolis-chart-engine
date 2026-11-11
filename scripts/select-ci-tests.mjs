// @ts-check
// Change-based browser test selection for PR CI.
//
// Every PR still runs the full Node matrix (check, unit tests, exports, pack).
// The browser projects are selected from the files the PR changes, safe first:
//   - engine source, the harness, dependencies and browser config run every
//     browser test: specs reach the engine both through imports and at runtime
//     (page.goto("/harness/...") loads harness/chart.ts and the whole runtime),
//     which a static import scan cannot see;
//   - shared browser test support (tests/browser/support/**, or any test module
//     a spec imports) runs every browser test for the same reason;
//   - a changed spec file runs only that spec and any spec importing it; the
//     census spec runs the census job;
//   - files that cannot reach a browser test (docs, Node unit tests, other
//     workflows, repository scripts no browser config loads) select nothing;
//   - an unknown path, an unreadable diff or a suspicious file name runs all.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CENSUS_SPEC = "tests/browser/chart-multi-market-census.spec.ts";

/** Files that every browser test depends on, or that decide what runs. */
export const GLOBAL_RUNTIME = [
  /^src\//,
  /^package(-lock)?\.json$/,
  /^playwright\.config\.ts$/,
  /^vite\.config\.ts$/,
  /^tsconfig[^/]*\.json$/,
  /^harness\//,
  /^\.github\/workflows\/ci\.yml$/,
  /^scripts\/select-ci-tests\.mjs$/,
];

/** Files that no browser test can reach. */
export const NO_BROWSER_IMPACT = [
  /^md\//,
  /^[^/]+\.md$/,
  /^(LICENSE|NOTICE|\.gitignore)$/,
  /^\.github\/(dependabot\.yml|PULL_REQUEST_TEMPLATE\.md)$/,
  /^\.github\/workflows\/(census-load|chart-endurance|release)\.yml$/,
  /^scripts\/(check-exports|check-default-import-graph|run-tests|endurance-span-validation)\.mjs$/,
];

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const IMPORT_RE =
  /(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']|new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;

/**
 * @param {string} root
 * @param {string} fromFile absolute
 * @param {string} specifier
 */
function resolveImport(root, fromFile, specifier) {
  let base;
  if (specifier.startsWith("/")) base = join(root, specifier.slice(1));
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null;
  for (const candidate of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}.js`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Static import closure of each browser spec, as repository-relative paths.
 * @param {string} root
 * @returns {Map<string, Set<string>>}
 */
export function specClosures(root) {
  /** @type {Map<string, string[]>} */
  const edges = new Map();
  const depsOf = (/** @type {string} */ file) => {
    let deps = edges.get(file);
    if (deps) return deps;
    deps = [];
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const target = resolveImport(root, file, match[1] ?? match[2] ?? match[3] ?? match[4]);
      if (target) deps.push(target);
    }
    edges.set(file, deps);
    return deps;
  };
  const browserDir = join(root, "tests", "browser");
  const closures = new Map();
  for (const name of readdirSync(browserDir).filter((entry) => entry.endsWith(".spec.ts")).sort()) {
    const start = join(browserDir, name);
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      for (const dep of depsOf(/** @type {string} */ (stack.pop()))) {
        if (!seen.has(dep)) {
          seen.add(dep);
          stack.push(dep);
        }
      }
    }
    closures.set(
      relative(root, start).split(sep).join("/"),
      new Set([...seen].map((file) => relative(root, file).split(sep).join("/"))),
    );
  }
  return closures;
}

/**
 * @param {readonly string[]} changed repository-relative paths
 * @param {Map<string, Set<string>>} closures
 * @returns {{ browser: "none" | "all" | "list", specs: string[], census: boolean, reasons: string[] }}
 */
export function selectTests(changed, closures) {
  const all = (/** @type {string} */ reason) => ({ browser: /** @type {const} */ ("all"), specs: [], census: true, reasons: [reason] });
  if (changed.length === 0) return all("empty diff: running everything");
  const selected = new Set();
  const reasons = [];
  for (const file of changed) {
    if (!SAFE_PATH.test(file)) return all(`unexpected characters in path ${JSON.stringify(file)}`);
    if (GLOBAL_RUNTIME.some((pattern) => pattern.test(file))) return all(`${file}: shared browser runtime/config`);
    const reaching = [...closures].filter(([, closure]) => closure.has(file)).map(([spec]) => spec);
    if (file.startsWith("tests/browser/") && file.endsWith(".spec.ts") && !closures.has(file)) {
      reasons.push(`${file}: deleted browser spec`);
      continue;
    }
    if (closures.has(file)) {
      for (const spec of reaching) selected.add(spec);
      reasons.push(`${file}: browser spec${reaching.length > 1 ? ` (also imported by ${reaching.length - 1} other spec(s))` : ""}`);
      continue;
    }
    if (reaching.length > 0 || file.startsWith("tests/browser/")) {
      return all(`${file}: shared browser test support (can be used at runtime as well as imported)`);
    }
    if (file.startsWith("tests/")) {
      reasons.push(`${file}: Node test file, covered by the test matrix`);
      continue;
    }
    if (NO_BROWSER_IMPACT.some((pattern) => pattern.test(file))) {
      reasons.push(`${file}: cannot reach a browser test`);
      continue;
    }
    return all(`${file}: unclassified path`);
  }
  const census = selected.delete(CENSUS_SPEC);
  const specs = [...selected].sort();
  const allDefault = [...closures.keys()].filter((spec) => spec !== CENSUS_SPEC);
  const browser = specs.length === 0 ? "none" : specs.length === allDefault.length ? "all" : "list";
  return { browser, specs: browser === "list" ? specs : [], census, reasons };
}

function changedFiles() {
  // pull_request checks out the merge commit: its first parent is the base tip.
  const out = execFileSync("git", ["diff", "--name-only", "--no-renames", "HEAD^1", "HEAD"], { encoding: "utf8" });
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

function isMain() {
  return process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMain()) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let result;
  try {
    result = selectTests(changedFiles(), specClosures(root));
  } catch (error) {
    result = { browser: "all", specs: [], census: true, reasons: [`selection failed (${String(error)}): running everything`] };
  }
  const lines = [
    `browser=${result.browser}`,
    `browser_specs=${result.specs.join(" ")}`,
    `census=${result.census}`,
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      "### Change-based browser test selection",
      "",
      `- Default browser project: **${result.browser}**${result.specs.length ? ` (${result.specs.length} spec(s))` : ""}`,
      ...result.specs.map((spec) => `  - \`${spec}\``),
      `- Census: **${result.census ? "run" : "skip"}**`,
      "",
      "<details><summary>Reasons</summary>",
      "",
      ...result.reasons.map((reason) => `- ${reason}`),
      "",
      "</details>",
      "",
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
  }
}
