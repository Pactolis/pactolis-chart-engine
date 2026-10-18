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
  const args = ['--no-install', 'playwright', 'test', '--list', '--project=census', '--reporter=json'];
  if (shard) args.push('--fully-parallel', '--workers=1', `--shard=${shard}/2`);
  const result = spawnSync('npx', args, { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  assert.equal(result.status, 0, `Playwright census listing failed: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  const names = [];
  const visit = (suite) => {
    for (const child of suite.suites ?? []) visit(child);
    for (const spec of suite.specs ?? []) {
      for (const item of spec.tests ?? []) names.push(`${spec.file}:${spec.line} :: ${spec.title} :: ${spec.projectName}`);
    }
  };
  for (const suite of report.suites ?? []) visit(suite);
  return names;
}

function runGateFor(result) {
  const script = jobBlock('census');
  const match = script.match(/run:\s*\|\n((?:\s{6,}.*\n?)+)/);
  assert.ok(match, 'aggregate census job must execute a bounded shell gate');
  const command = match[1].split(/\r?\n/).map((line) => line.replace(/^      /, '')).join('\n').trim();
  assert.match(command, /^if \[ "\$\{\{ needs\.census-shards\.result \}\}" != "success" \]; then\n  echo "Census shards did not all succeed"\n  exit 1\nfi$/);
  const executable = command.replace('${{ needs.census-shards.result }}', result);
  return spawnSync('bash', ['-e', '-c', executable], { encoding: 'utf8' });
}

test('CI partitions the selected census tests and fails closed on incomplete shards', () => {
  const shardBlock = jobBlock('census-shards');
  assert.match(shardBlock, /strategy:[\s\S]*?fail-fast:\s*false/);
  assert.match(shardBlock, /matrix:[\s\S]*?shard:\s*\[1,\s*2\]/);
  assert.match(shardBlock, /--project=census/);
  assert.match(shardBlock, /npm ci --no-audit --no-fund/);
  assert.match(shardBlock, /if: failure\(\)/);
  assert.match(shardBlock, /name: census-results-\$\{\{ matrix\.shard \}\}/);
  assert.match(shardBlock, /--fully-parallel/);
  assert.match(shardBlock, /--workers=1/);
  assert.match(shardBlock, /--shard=\$\{\{\s*matrix\.shard\s*\}\}\/2/);

  const censusGate = jobBlock('census');
  assert.match(censusGate, /if:\s*\$\{\{\s*always\(\)\s*\}\}/);
  assert.match(censusGate, /needs:\s*census-shards/);
  assert.match(censusGate, /name:\s*census/);
  for (const result of ['failure', 'cancelled', 'skipped', 'missing']) {
    assert.notEqual(runGateFor(result).status, 0, `${result} shard result must fail the gate`);
  }
  assert.equal(runGateFor('success').status, 0, 'only successful shards pass the gate');

  const first = listedCensusTests(1);
  const second = listedCensusTests(2);
  const all = listedCensusTests();
  assert.ok(all.every((name) => !name.includes('undefined')), 'each census test needs a stable identity');
  assert.ok(first.length > 0, 'shard 1 must select tests');
  assert.ok(second.length > 0, 'shard 2 must select tests');
  assert.equal(new Set([...first, ...second]).size, first.length + second.length,
    'shards must be disjoint');
  assert.deepEqual([...first, ...second].sort(), all.sort(),
    'shards must cover the complete unsharded census selection');
  assert.ok(all.some((name) => name.includes('census minute-sample validator')),
    'the census qualification regression test remains selected');
  assert.match(censusSpec, /test\.skip\(ENDURANCE_MINUTES <= 0/,
    'runtime endurance remains an explicit conditional skip, not a workflow filter');
  assert.doesNotMatch(shardBlock, /CHART_ENDURANCE_(?:MINUTES|PROFILE)\s*:/,
    'regular census shards must not activate weekly endurance');
}
);