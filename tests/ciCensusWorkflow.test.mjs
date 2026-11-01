import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const censusSpec = readFileSync(new URL('./browser/chart-multi-market-census.spec.ts', import.meta.url), 'utf8');

function jobBlock(name) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `CI job ${name} must exist`);
  const end = lines.findIndex((line, index) => index > start && /^  [\w-]+:$/.test(line));
  return lines.slice(start + 1, end === -1 ? lines.length : end).join('\n');
}

function listedCensusTests(shard) {
  const args = ['--no-install', 'playwright', 'test', '--project=census', '--fully-parallel', '--workers=1', '--list', '--reporter=json'];
  if (shard) args.push(`--shard=${shard}/2`);
  const result = spawnSync('npx', args, { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  assert.equal(result.status, 0, `Playwright census listing failed: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  const names = [];
  const visit = (suite) => {
    for (const child of suite.suites ?? []) visit(child);
    for (const spec of suite.specs ?? []) {
      for (const item of spec.tests ?? []) {
        assert.equal(typeof spec.id, 'string', 'each census spec needs a string id');
        assert.ok(spec.id.trim().length > 0, 'each census spec needs a nonempty id');
        names.push(`${spec.id} :: ${spec.title} :: ${item.projectName}`);
      }
    }
  };
  for (const suite of report.suites ?? []) visit(suite);
  return names;
}

function runGateFor(result) {
  const script = jobBlock('census');
  const match = script.match(/run:\s*\|\n((?:\s+.*\n?)+)/);
  assert.ok(match, 'aggregate census job must execute a bounded shell gate');
  const indents = match[1].split(/\r?\n/).filter((line) => line.trim()).map((line) => line.match(/^\s*/)[0].length);
  const indent = Math.min(...indents);
  const command = match[1].split(/\r?\n/).filter((line) => line.trim()).map((line) => line.slice(indent)).join('\n').trim();
  assert.match(command, /^if \[ "\$\{\{ needs\.census-shards\.result \}\}" != "success" \]; then\n  echo "Census shards did not all succeed"\n  exit 1\nfi$/);
  const executable = command.replace('${{ needs.census-shards.result }}', result);
  return spawnSync('bash', ['-e', '-c', executable], { encoding: 'utf8' });
}

test('CI partitions the selected census tests and fails closed on incomplete shards', () => {
  const shardBlock = jobBlock('census-shards');
  assert.match(shardBlock, /if:\s*github\.event_name\s*==\s*'pull_request'/);
  assert.match(shardBlock, /strategy:[\s\S]*?fail-fast:\s*false/);
  assert.match(shardBlock, /matrix:[\s\S]*?shard:\s*\[1,\s*2\]/);
  assert.match(shardBlock, /--project=census/);
  assert.match(shardBlock, /npm ci --no-audit --no-fund/);
  assert.match(shardBlock, /if: failure\(\)/);
  assert.match(shardBlock, /name: census-results-\$\{\{ matrix\.shard \}\}/);
  assert.match(shardBlock, /--fully-parallel/);
  assert.match(shardBlock, /--workers=1/);
  assert.match(shardBlock, /--shard=\$\{\{\s*matrix\.shard\s*\}\}\/2/);

  const browserBlock = jobBlock('browser');
  assert.match(browserBlock, /if:\s*github\.event_name\s*==\s*'pull_request'/);

  const censusGate = jobBlock('census');
  assert.match(censusGate, /if:\s*\$\{\{\s*always\(\)\s*&&\s*github\.event_name\s*==\s*'pull_request'\s*\}\}/);
  assert.match(censusGate, /needs:\s*census-shards/);
  assert.match(censusGate, /name:\s*census/);
  for (const result of ['failure', 'cancelled', 'skipped', '', 'missing', 'unknown']) {
    assert.notEqual(runGateFor(result).status, 0, `${JSON.stringify(result)} shard result must fail the gate`);
  }
  assert.equal(runGateFor('success').status, 0, 'only successful shards pass the gate');

  const first = listedCensusTests(1);
  const second = listedCensusTests(2);
  const all = listedCensusTests();
  assert.ok(first.length > 0, 'shard 1 must select tests');
  assert.ok(second.length > 0, 'shard 2 must select tests');
  assert.equal(new Set([...first, ...second]).size, first.length + second.length,
    'shards must be disjoint');
  assert.deepEqual([...first, ...second].sort(), all.sort(),
    'shards must cover the complete unsharded census selection');
  assert.ok(all.some((name) => name.includes('census minute-sample validator')),
    'the census qualification regression test remains selected');
  assert.ok(!all.some((name) => /#308 L[2-9]/.test(name)),
    'PR census must exclude L2-L9 report-only scenarios (#61)');
  assert.ok(all.some((name) => name.includes('#377')), 'census includes #377');
  assert.ok(all.some((name) => name.includes('#392')), 'census includes #392');
  assert.ok(all.some((name) => name.includes('#308 Tam')), 'census includes #308 Tam');
  assert.ok(all.some((name) => name.includes('#308 burst')), 'census includes #308 burst');
  assert.match(censusSpec, /test\.skip\(ENDURANCE_MINUTES <= 0/,
    'runtime endurance remains an explicit conditional skip, not a workflow filter');
  assert.doesNotMatch(shardBlock, /CHART_ENDURANCE_(?:MINUTES|PROFILE)\s*:/,
    'regular census shards must not activate weekly endurance');
});

test('census-load project selects intermediate report-only load profiles (L2-L9) for scheduled runs (#61)', () => {
  const args = ['--no-install', 'playwright', 'test', '--project=census-load', '--list', '--reporter=json'];
  const result = spawnSync('npx', args, { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  assert.equal(result.status, 0, `Playwright census-load listing failed: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  const names = [];
  const visit = (suite) => {
    for (const child of suite.suites ?? []) visit(child);
    for (const spec of suite.specs ?? []) {
      for (const item of spec.tests ?? []) {
        names.push(`${spec.id} :: ${spec.title} :: ${item.projectName}`);
      }
    }
  };
  for (const suite of report.suites ?? []) visit(suite);
  assert.equal(names.length, 8, 'census-load must contain exactly 8 scenarios (L2-L9)');
  for (let l = 2; l <= 9; l++) {
    assert.ok(names.some((name) => name.includes(`#308 L${l}`)), `census-load contains L${l}`);
  }
});

test('Chart Endurance PR trigger restricts paths and excludes harness/** (#63)', () => {
  const enduranceYaml = readFileSync(new URL('../.github/workflows/chart-endurance.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(enduranceYaml, /-\s*["']?harness\/\*\*["']?/, 'endurance PR paths must not trigger on harness/**');
  assert.match(enduranceYaml, /-\s*"\.github\/workflows\/chart-endurance\.yml"/);
  assert.match(enduranceYaml, /-\s*"tests\/browser\/chart-multi-market-census\.spec\.ts"/);
});

test('dependabot.yml is configured for github-actions and npm with weekly schedule and groups (#64)', () => {
  const dependabotYaml = readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8');
  assert.match(dependabotYaml, /version:\s*2/);
  assert.match(dependabotYaml, /package-ecosystem:\s*["']?github-actions["']?/);
  assert.match(dependabotYaml, /package-ecosystem:\s*["']?npm["']?/);
  assert.match(dependabotYaml, /interval:\s*["']?weekly["']?/);
  assert.match(dependabotYaml, /groups:/);
});

test('all workflows use pinned ubuntu-24.04 runner and unified @v7 actions without ubuntu-latest (#64)', () => {
  const workflows = ['ci.yml', 'release.yml', 'chart-endurance.yml', 'census-load.yml'];
  for (const file of workflows) {
    const yaml = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(yaml, /runs-on:\s*ubuntu-latest/, `${file} must not use unpinned ubuntu-latest`);
    assert.match(yaml, /runs-on:\s*ubuntu-24\.04/, `${file} must use ubuntu-24.04`);
    assert.doesNotMatch(yaml, /actions\/checkout@v[1-6]\b/, `${file} must not use outdated actions/checkout`);
    assert.doesNotMatch(yaml, /actions\/upload-artifact@v[1-6]\b/, `${file} must not use outdated actions/upload-artifact`);
  }
});
