import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');
const FX = path.join(HERE, 'fixtures');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'perf-cli-'));

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: '', ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const HARDWARE = { cpuModel: 'Fixture CPU @ 3.00GHz', cpus: 8, memGiB: 31, kernel: '6.8.0-fixture', dockerVersion: '27.0.0' };
const STACK = { profile: 'wt-stack-dev', role: 'all', admissionMode: 'observe', e2eMode: true };

function writeJson(dir, name, value) {
  const p = path.join(dir, name);
  writeFileSync(p, JSON.stringify(value));
  return p;
}

function buildArgs(dir, over = {}) {
  const o = {
    report: path.join(FX, 'agentsim-report.json'),
    samples: path.join(FX, 'samples.csv'),
    idle: path.join(FX, 'idle.csv'),
    hardware: writeJson(dir, 'hardware.json', HARDWARE),
    stack: writeJson(dir, 'stack.json', STACK),
    'git-sha': '0123456789abcdef0123456789abcdef01234567',
    profile: 'nightly-200',
    out: path.join(dir, 'kpi.json'),
    ...over,
  };
  return ['build', ...Object.entries(o).flatMap(([k, v]) => [`--${k}`, v])];
}

const baseline = () => JSON.parse(readFileSync(path.join(FX, 'baseline.json'), 'utf8'));
function candidate(dir, name, kpis, extra = {}) {
  const c = baseline();
  Object.assign(c.kpis, kpis);
  Object.assign(c, extra);
  return writeJson(dir, name, c);
}
const BASE = path.join(FX, 'baseline.json');

test('build writes a kpi record from the fixtures', () => {
  const dir = tmp();
  const r = run(buildArgs(dir));
  assert.equal(r.code, 0, r.err);
  const rec = JSON.parse(readFileSync(path.join(dir, 'kpi.json'), 'utf8'));
  assert.equal(rec.schema, 'breeze.perf.kpi/v1');
  assert.ok(Math.abs(rec.kpis.agentCostCpuMsPerAgentMin - 41.7) < 0.01);
  assert.equal(rec.gitSha, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(rec.sources.samples, 'samples.csv');
  assert.equal(rec.sources.agentsimReport, 'agentsim-report.json');
  assert.match(rec.measuredAt, /^\d{4}-\d\d-\d\dT/);
});

test('build exits 2 naming file and line for a malformed samples CSV', () => {
  const dir = tmp();
  const header = 'ts,cpu_seconds,xact_commit,ws_connections,elu,lag_max,pool_waiting,scrape_ok';
  const row = '2026-10-13T03:20:00Z,100,50000,200,0.2,0.01,0,1';
  const cases = [
    ['wrong-header.csv', `ts,cpu\n${row}\n`, /wrong-header\.csv.*line 1/s],
    ['short-row.csv', `${header}\n${row}\n2026-10-13T03:20:10Z,100,50000\n`, /short-row\.csv.*line 3/s],
    ['non-numeric.csv', `${header}\n${row.replace('50000', 'abc')}\n`, /non-numeric\.csv.*line 2/s],
    ['bad-ts.csv', `${header}\nnot-a-time,100,50000,200,0.2,0.01,0,1\n`, /bad-ts\.csv.*line 2/s],
    ['bad-flag.csv', `${header}\n${row.replace(/,1$/, ',2')}\n`, /bad-flag\.csv.*line 2/s],
  ];
  for (const [name, body, re] of cases) {
    const file = path.join(dir, name);
    writeFileSync(file, body);
    const r = run(buildArgs(dir, { samples: file }));
    assert.equal(r.code, 2, `${name}: ${r.err}`);
    assert.match(r.err, re, name);
  }
});

test('build accepts NaN fields only on failed-scrape rows', () => {
  const dir = tmp();
  const lines = readFileSync(path.join(FX, 'samples.csv'), 'utf8').trim().split('\n');
  lines[50] = '2026-10-13T03:27:30Z,NaN,NaN,NaN,NaN,NaN,NaN,0';
  const ok = path.join(dir, 'nan-ok.csv');
  writeFileSync(ok, `${lines.join('\n')}\n`);
  assert.equal(run(buildArgs(dir, { samples: ok })).code, 0);

  lines[50] = '2026-10-13T03:27:30Z,NaN,NaN,NaN,NaN,NaN,NaN,1';
  const bad = path.join(dir, 'nan-bad.csv');
  writeFileSync(bad, `${lines.join('\n')}\n`);
  assert.equal(run(buildArgs(dir, { samples: bad })).code, 2);
});

test('build exits 64 on missing required flags', () => {
  const r = run(['build', '--report', 'x']);
  assert.equal(r.code, 64);
  assert.match(r.err, /usage|missing/i);
});

test('compare exit codes: 0 pass, 1 regression, 2 invalid, 64 usage', () => {
  const dir = tmp();
  const good = candidate(dir, 'good.json', {});
  const slow = candidate(dir, 'slow.json', { agentCostCpuMsPerAgentMin: 60 });
  const otherHw = candidate(dir, 'hw.json', {}, { hardware: { ...HARDWARE, cpus: 64 } });

  let r = run(['compare', '--baseline', BASE, '--candidate', good]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /agentCostCpuMsPerAgentMin/);

  r = run(['compare', '--baseline', BASE, '--candidate', slow]);
  assert.equal(r.code, 1);
  assert.match(r.out, /regression/i);
  assert.match(r.out, /agentCostCpuMsPerAgentMin/);

  r = run(['compare', '--baseline', BASE, '--candidate', otherHw]);
  assert.equal(r.code, 2);
  assert.match(r.err, /hardware\.cpus/);

  r = run(['compare', '--baseline', BASE, '--candidate', path.join(dir, 'missing.json')]);
  assert.equal(r.code, 2);
  assert.match(r.err, /missing\.json/);

  assert.equal(run(['compare', '--baseline', BASE]).code, 64);
  assert.equal(run(['nope']).code, 64);
  assert.equal(run([]).code, 64);
  assert.equal(run(['compare', '--baseline', BASE, '--candidate', good, '--expect', 'bogus']).code, 64);
});

test('--confirm: a first-run regression passes when the confirm run is clean, fails when it repeats', () => {
  const dir = tmp();
  const slow = candidate(dir, 'slow.json', { agentCostCpuMsPerAgentMin: 60 });
  const clean = candidate(dir, 'clean.json', {});
  const slow2 = candidate(dir, 'slow2.json', { agentCostCpuMsPerAgentMin: 58 });
  const otherKpi = candidate(dir, 'other.json', { heartbeatP95Ms: 80 });

  assert.equal(run(['compare', '--baseline', BASE, '--candidate', slow, '--confirm', clean]).code, 0);
  assert.equal(run(['compare', '--baseline', BASE, '--candidate', slow, '--confirm', slow2]).code, 1);
  assert.equal(run(['compare', '--baseline', BASE, '--candidate', slow, '--confirm', otherKpi]).code, 0);
  // a clean first run never needs the confirm file
  assert.equal(run(['compare', '--baseline', BASE, '--candidate', clean, '--confirm', slow]).code, 0);
});

test('--expect regression swaps 0/1 and requires both cost and p95 named', () => {
  const dir = tmp();
  const both = candidate(dir, 'both.json', { agentCostCpuMsPerAgentMin: 75, heartbeatP95Ms: 70 });
  const costOnly = candidate(dir, 'cost.json', { agentCostCpuMsPerAgentMin: 75 });
  const clean = candidate(dir, 'clean.json', {});

  let r = run(['compare', '--baseline', BASE, '--candidate', both, '--expect', 'regression']);
  assert.equal(r.code, 0, r.out + r.err);
  r = run(['compare', '--baseline', BASE, '--candidate', costOnly, '--expect', 'regression']);
  assert.equal(r.code, 1);
  assert.match(r.err, /missing heartbeatP95Ms/);
  const p95Only = candidate(dir, 'p95.json', { heartbeatP95Ms: 70 });
  r = run(['compare', '--baseline', BASE, '--candidate', p95Only, '--expect', 'regression']);
  assert.equal(r.code, 1);
  assert.match(r.err, /missing agentCostCpuMsPerAgentMin/);
  r = run(['compare', '--baseline', BASE, '--candidate', clean, '--expect', 'regression']);
  assert.equal(r.code, 1);
  // invalid stays invalid
  const bad = candidate(dir, 'bad.json', {}, { stack: { ...STACK, role: 'api' } });
  assert.equal(run(['compare', '--baseline', BASE, '--candidate', bad, '--expect', 'regression']).code, 2);
});

test('compare appends a Markdown table to $GITHUB_STEP_SUMMARY', () => {
  const dir = tmp();
  const slow = candidate(dir, 'slow.json', { agentCostCpuMsPerAgentMin: 60 });
  const summary = path.join(dir, 'summary.md');
  writeFileSync(summary, 'existing line\n');
  const r = run(['compare', '--baseline', BASE, '--candidate', slow], { GITHUB_STEP_SUMMARY: summary });
  assert.equal(r.code, 1);
  const md = readFileSync(summary, 'utf8');
  assert.match(md, /^existing line\n/);
  assert.match(md, /\| KPI \| Baseline \| Candidate \| Δ % \| Verdict \|/);
  assert.match(md, /\| --- \|/);
  assert.match(md, /\| agentCostCpuMsPerAgentMin \| 41\.7 \| 60 \|/);
  assert.match(md, /regression/i);
});
