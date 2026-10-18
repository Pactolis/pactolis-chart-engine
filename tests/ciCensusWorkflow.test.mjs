import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

function jobBlock(name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [\\w-]+:|\\Z)`, 'm'));
  assert.ok(match, `CI job ${name} must exist`);
  return match[1];
}

function listedCensusTests(shard) {
  const result = spawnSync('npx', [
    '--no-install', 'playwright', 'test', '--list', '--project=census',
    `--shard=${shard}/2`, '--reporter=json',
  ], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  assert.equal(result.status, 0, `Playwright census listing failed: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  const names = [];
  const visit = (suite) => {
    for (const child of suite.suites ?? []) visit(child);
    for (const spec of suite.specs ?? []) {
      for (const item of spec.tests ?? []) names.push(`${spec.file} :: ${item.title}`);
    }
  };
  for (const suite of report.suites ?? []) visit(suite);
  return names;
}

test('CI partitions the selected census tests and fails closed on incomplete shards', () => {
  const shardBlock = jobBlock('census-shards');
  assert.match(shardBlock, /strategy:[\s\S]*?fail-fast:\s*false/);
  assert.match(shardBlock, /matrix:[\s\S]*?shard:\s*\[1,\s*2\]/);
  assert.match(shardBlock, /--project=census/);
  assert.match(shardBlock, /--fully-parallel/);
  assert.match(shardBlock, /--workers=1/);
  assert.match(shardBlock, /--shard=\$\{\{\s*matrix\.shard\s*\}\}\/2/);

  const censusGate = jobBlock('census');
  assert.match(censusGate, /if:\s*\$\{\{\s*always\(\)\s*\}\}/);
  assert.match(censusGate, /needs:\s*census-shards/);
  assert.match(censusGate, /needs\.census-shards\.result\s*==\s*'success'/);
  assert.match(censusGate, /name:\s*census/);

  const first = listedCensusTests(1);
  const second = listedCensusTests(2);
  assert.ok(first.length > 0, 'shard 1 must select tests');
  assert.ok(second.length > 0, 'shard 2 must select tests');
  assert.equal(new Set([...first, ...second]).size, first.length + second.length,
    'shards must be disjoint');
  assert.deepEqual([...first, ...second].sort(), listedCensusTests(undefined).sort(),
    'shards must cover the complete unsharded census selection');
});