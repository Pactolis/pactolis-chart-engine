// @ts-check
// `node --test` gained isolation control under two different spellings: Node 22
// only accepts `--experimental-test-isolation`, Node 23+ only accepts
// `--test-isolation`. Hard-coding either one breaks `npm test` on the other half
// of the supported `engines` range, so resolve it from the running interpreter.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODERN_ISOLATION_MAJOR = 23;

/** @param {string} version */
export function isolationFlag(version) {
  const major = Number.parseInt(String(version).replace(/^v/, "").split(".")[0] ?? "", 10);
  if (!Number.isInteger(major)) throw new Error(`UNRECOGNIZED_NODE_VERSION:${version}`);
  return major >= MODERN_ISOLATION_MAJOR ? "--test-isolation=none" : "--experimental-test-isolation=none";
}

const patterns = process.argv.slice(2);

function isMain() {
  return process.argv[1] !== undefined &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMain()) {
  if (!patterns.length) throw new Error("MISSING_TEST_PATTERN");
  // Node 25+ exposes a global `localStorage` that warns on first access unless
  // --localstorage-file is set. Unit tests model a storage-less environment
  // (and install their own fakes where storage matters), so turn it off instead
  // of letting the first module that probes storage print an ExperimentalWarning.
  // The preload stands in for the host application's engine wiring.
  const preload = pathToFileURL(resolve("tests/support/testWiring.mjs")).href;
  const child = spawn(
    process.execPath,
    ["--test", "--test-force-exit", "--no-experimental-webstorage", "--import", preload, isolationFlag(process.version), ...patterns],
    { stdio: "inherit" },
  );
  child.on("exit", (code, signal) => {
    process.exit(signal ? 1 : code ?? 1);
  });
}
