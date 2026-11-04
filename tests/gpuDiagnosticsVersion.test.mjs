import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { copyGpuDiagnosticsJson, getGpuDiagnostics } from "../dist/core/gpu/gpuDiagnostics.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("GPU diagnostics snapshot and JSON export use package.json version", () => {
  assert.equal(getGpuDiagnostics().engine, packageJson.version);
  assert.equal(JSON.parse(copyGpuDiagnosticsJson()).engine, packageJson.version);
});

test("package version assertion rejects a mismatched built diagnostics module in an isolated copy", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const tempRoot = mkdtempSync(join(tmpdir(), "gpu-diagnostics-version-"));

  try {
    const diagnosticsPath = join(repoRoot, "dist/core/gpu/gpuDiagnostics.js");
    const telemetryPath = join(repoRoot, "dist/core/performanceTelemetry.js");
    const diagnosticsSource = readFileSync(diagnosticsPath, "utf8");
    const versionLiteral = 'const ENGINE_VERSION = "0.2.7";';
    assert.equal(diagnosticsSource.split(versionLiteral).length - 1, 1, "expected exactly one built ENGINE_VERSION literal");

    const tempCorePath = join(tempRoot, "core");
    const tempGpuPath = join(tempCorePath, "gpu");
    mkdirSync(tempGpuPath, { recursive: true });
    writeFileSync(join(tempRoot, "package.json"), '{"type":"module"}', "utf8");
    const tempDiagnosticsPath = join(tempGpuPath, "gpuDiagnostics.js");
    const tempTelemetryPath = join(tempCorePath, "performanceTelemetry.js");
    const mismatchVersion = "0.0.0-negative-control";
    writeFileSync(tempDiagnosticsPath, diagnosticsSource.replace(versionLiteral, `const ENGINE_VERSION = "${mismatchVersion}";`), "utf8");
    writeFileSync(tempTelemetryPath, readFileSync(telemetryPath, "utf8"), "utf8");

    const assertionSource = `
      import assert from "node:assert/strict";
      import { pathToFileURL } from "node:url";
      const diagnostics = await import(pathToFileURL(process.argv[1]).href);
      const expected = JSON.parse(process.argv[2]).version;
      assert.equal(diagnostics.getGpuDiagnostics().engine, expected);
      assert.equal(JSON.parse(diagnostics.copyGpuDiagnosticsJson()).engine, expected);
    `;

    let failure;
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", assertionSource, tempDiagnosticsPath, JSON.stringify(packageJson)], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, "mismatched diagnostics module unexpectedly passed the package version assertion");
    assert.equal(failure.status, 1, "negative control failed for an unexpected process reason");
    assert.match(failure.stderr, /AssertionError/, "negative control did not fail with an assertion error");
    assert.match(failure.stderr, new RegExp(mismatchVersion));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
