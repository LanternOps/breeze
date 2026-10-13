import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  AGENTSIM_SCHEMA,
  GATED,
  InvalidRunError,
  KPI_SCHEMA,
  THRESHOLD,
  buildKpiRecord,
  compare,
  confirm,
  interpolateAt,
} from './kpi.mjs';

const fx = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const readJson = (name) => JSON.parse(readFileSync(fx(name), 'utf8'));
const clone = (v) => structuredClone(v);

/** Minimal CSV reader for the fixtures only (cli.mjs owns the validating one). */
function readSamples(name) {
  const [, ...lines] = readFileSync(fx(name), 'utf8').trim().split('\n');
  return lines.map((line) => {
    const [ts, cpu, xact, ws, elu, lag, pool, ok] = line.split(',');
    return {
      ts: new Date(ts),
      cpuSeconds: Number(cpu),
      xactCommit: Number(xact),
      wsConnections: Number(ws),
      elu: Number(elu),
      lagMax: Number(lag),
      poolWaiting: Number(pool),
      scrapeOk: ok === '1',
    };
  });
}

const HARDWARE = { cpuModel: 'Fixture CPU @ 3.00GHz', cpus: 8, memGiB: 31, kernel: '6.8.0-fixture', dockerVersion: '27.0.0' };
const STACK = { profile: 'wt-stack-dev', role: 'all', admissionMode: 'observe', e2eMode: true };

function build(over = {}) {
  return buildKpiRecord({
    report: readJson('agentsim-report.json'),
    samples: readSamples('samples.csv'),
    idle: readSamples('idle.csv'),
    hardware: HARDWARE,
    stack: STACK,
    gitSha: '0123456789abcdef0123456789abcdef01234567',
    profile: 'nightly-200',
    measuredAt: '2026-10-13T03:45:00Z',
    ...over,
  });
}

/** A candidate = baseline with some gated KPIs overridden. */
function candidate(kpis, extra = {}) {
  const c = clone(readJson('baseline.json'));
  Object.assign(c.kpis, kpis);
  return Object.assign(c, extra);
}
const baseline = () => readJson('baseline.json');

test('constants match the plan', () => {
  assert.equal(KPI_SCHEMA, 'breeze.perf.kpi/v1');
  assert.equal(AGENTSIM_SCHEMA, 'breeze.agentsim.report/v1');
  assert.equal(THRESHOLD, 0.15);
  assert.deepEqual(GATED, {
    agentCostCpuMsPerAgentMin: { floor: 2 },
    heartbeatP95Ms: { floor: 10 },
    dbTxPerAgentMin: { floor: 0.25 },
  });
});

test('1. buildKpiRecord computes the gated KPIs from the fixtures', () => {
  const rec = build();
  assert.equal(rec.schema, KPI_SCHEMA);
  assert.equal(rec.profile, 'nightly-200');
  assert.equal(rec.runId, 'fixture-run-0001');
  assert.equal(rec.window.agentMinutes, 4000);
  // CPU: 0.139 s/s over 1200 s = 166.8 s -> 166800 ms / 4000 agent-min = 41.7
  assert.ok(Math.abs(rec.kpis.agentCostCpuMsPerAgentMin - 41.7) < 0.01, String(rec.kpis.agentCostCpuMsPerAgentMin));
  // xact: 13/s over 1200 s = 15600 / 4000 agent-min = 3.9
  assert.ok(Math.abs(rec.kpis.dbTxPerAgentMin - 3.9) < 1e-6, String(rec.kpis.dbTxPerAgentMin));
  assert.equal(rec.kpis.heartbeatP95Ms, 38.2);
  assert.equal(rec.kpis.heartbeatP50Ms, 12.0);
  assert.equal(rec.kpis.heartbeatP99Ms, 90.1);
  assert.equal(rec.kpis.requestsPerAgentMin, 5.2);
  assert.equal(rec.kpis.elu.max, 0.48);
  assert.equal(rec.kpis.lagMaxSeconds, 0.04);
  assert.equal(rec.kpis.poolWaitingMax, 1);
  assert.ok(Math.abs(rec.kpis.idleCpuMsPerMin - 950) < 1);
  assert.deepEqual(rec.hardware, HARDWARE);
  assert.deepEqual(rec.stack, STACK);
});

test('2. interpolateAt is linear between samples and refuses edges more than 30 s from a sample', () => {
  const s = [
    { ts: new Date('2026-10-13T00:00:00Z'), cpuSeconds: 10, scrapeOk: true },
    { ts: new Date('2026-10-13T00:00:10Z'), cpuSeconds: 20, scrapeOk: true },
  ];
  assert.equal(interpolateAt(s, 'cpuSeconds', new Date('2026-10-13T00:00:04Z')), 14);
  assert.equal(interpolateAt(s, 'cpuSeconds', new Date('2026-10-13T00:00:10Z')), 20);
  const far = [
    { ts: new Date('2026-10-13T00:00:00Z'), cpuSeconds: 10, scrapeOk: true },
    { ts: new Date('2026-10-13T00:02:00Z'), cpuSeconds: 20, scrapeOk: true },
  ];
  assert.throws(() => interpolateAt(far, 'cpuSeconds', new Date('2026-10-13T00:01:00Z')), InvalidRunError);
  // No sample after the instant at all.
  assert.throws(() => interpolateAt(s, 'cpuSeconds', new Date('2026-10-13T00:05:00Z')), InvalidRunError);
});

test('3. a counter that decreases inside the window is a restart', () => {
  const samples = readSamples('samples.csv');
  const mid = samples.findIndex((x) => x.ts.toISOString() === '2026-10-13T03:30:00.000Z');
  assert.ok(mid > 0);
  for (let i = mid; i < samples.length; i++) samples[i].cpuSeconds -= 120; // process restarted
  assert.throws(() => build({ samples }), (e) => e instanceof InvalidRunError && /restart inside the window/.test(e.message));
});

test('4. window, schema and route hard gates', () => {
  const zero = readJson('agentsim-report.json');
  zero.window.agentMinutes = 0;
  assert.throws(() => build({ report: zero }), InvalidRunError);

  const v2 = readJson('agentsim-report.json');
  v2.schema = 'breeze.agentsim.report/v2';
  assert.throws(() => build({ report: v2 }), (e) => e instanceof InvalidRunError && /breeze\.agentsim\.report\/v2/.test(e.message));

  const noHb = readJson('agentsim-report.json');
  noHb.routes = noHb.routes.filter((r) => r.route !== 'POST /agents/:id/heartbeat');
  assert.throws(() => build({ report: noHb }), (e) => e instanceof InvalidRunError && /heartbeat/.test(e.message));

  const nan = readJson('agentsim-report.json');
  nan.window.agentMinutes = 'NaN';
  assert.throws(() => build({ report: nan }), InvalidRunError);
});

test('5. compare applies 15 % and the absolute floors', () => {
  // +14.9 % on cost (41.7 -> 47.9133), above the 2 ms floor: pass
  let r = compare(baseline(), candidate({ agentCostCpuMsPerAgentMin: 41.7 * 1.149 }));
  assert.equal(r.verdict, 'pass');

  // +15.1 %: regression naming the KPI
  r = compare(baseline(), candidate({ agentCostCpuMsPerAgentMin: 41.7 * 1.151 }));
  assert.equal(r.verdict, 'regression');
  assert.deepEqual(r.rows.filter((x) => x.regressed).map((x) => x.kpi), ['agentCostCpuMsPerAgentMin']);

  // +40 % but only +1.5 CPU-ms (below the 2 ms floor): pass
  r = compare(candidate({ agentCostCpuMsPerAgentMin: 3.75 }), candidate({ agentCostCpuMsPerAgentMin: 5.25 }));
  assert.equal(r.verdict, 'pass');

  // p95 +16 % and +12 ms: regression
  r = compare(candidate({ heartbeatP95Ms: 75 }), candidate({ heartbeatP95Ms: 87 }));
  assert.equal(r.verdict, 'regression');
  assert.deepEqual(r.rows.filter((x) => x.regressed).map((x) => x.kpi), ['heartbeatP95Ms']);

  // -20 %: pass, flagged improved
  r = compare(baseline(), candidate({ agentCostCpuMsPerAgentMin: 41.7 * 0.8 }));
  assert.equal(r.verdict, 'pass');
  const row = r.rows.find((x) => x.kpi === 'agentCostCpuMsPerAgentMin');
  assert.equal(row.improved, true);
  assert.equal(row.regressed, false);
  assert.ok(Math.abs(row.deltaPct - -20) < 0.01);

  // rows cover exactly the gated KPIs
  assert.deepEqual(r.rows.map((x) => x.kpi).sort(), Object.keys(GATED).sort());
});

test('6. compare refuses runs that did not measure what the baseline measured', () => {
  const bad = (cand, re) => assert.throws(() => compare(baseline(), cand), (e) => e instanceof InvalidRunError && re.test(e.message));
  const withHw = (patch) => candidate({}, { hardware: { ...HARDWARE, ...patch } });
  bad(withHw({ cpuModel: 'Other CPU' }), /cpuModel/);
  bad(withHw({ cpus: 16 }), /cpus/);
  bad(withHw({ memGiB: 64 }), /memGiB/);
  bad(candidate({}, { stack: { ...STACK, profile: 'prod-image' } }), /stack\.profile/);
  bad(candidate({}, { stack: { ...STACK, role: 'api' } }), /stack\.role/);

  const noKpi = baseline();
  delete noKpi.kpis.dbTxPerAgentMin;
  assert.throws(() => compare(noKpi, candidate({})), (e) => e instanceof InvalidRunError && /dbTxPerAgentMin/.test(e.message));
  bad(candidate({ heartbeatP95Ms: Number.NaN }), /heartbeatP95Ms/);
  bad(candidate({ agentCostCpuMsPerAgentMin: Infinity }), /agentCostCpuMsPerAgentMin/);
  const nanBase = baseline();
  nanBase.kpis.heartbeatP95Ms = null;
  assert.throws(() => compare(nanBase, candidate({})), InvalidRunError);

  // kernel / docker differences are information only (D9)
  const r = compare(baseline(), withHw({ kernel: '7.0.0', dockerVersion: '28.0.0' }));
  assert.equal(r.verdict, 'pass');
});

test('6b. baselineGrade: false never compares against a baseline-grade record', () => {
  const nonGrade = (extra = {}) => candidate({}, { hardware: { ...HARDWARE, baselineGrade: false, ...extra } });
  assert.throws(() => compare(baseline(), nonGrade()), (e) => e instanceof InvalidRunError && /baselineGrade/.test(e.message));
  assert.throws(() => compare(nonGrade(), baseline()), (e) => e instanceof InvalidRunError && /baselineGrade/.test(e.message));
  // two non-baseline-grade records compare fine (same-machine local smoke)
  assert.equal(compare(nonGrade(), nonGrade()).verdict, 'pass');
  // an explicit baselineGrade: true is baseline-grade too
  assert.equal(compare(baseline(), candidate({}, { hardware: { ...HARDWARE, baselineGrade: true } })).verdict, 'pass');
});

test('7. confirm fails only on the same KPI', () => {
  const first = compare(baseline(), candidate({ agentCostCpuMsPerAgentMin: 60 }));
  assert.equal(first.verdict, 'regression');

  const otherKpi = compare(baseline(), candidate({ heartbeatP95Ms: 60 }));
  assert.equal(otherKpi.verdict, 'regression');
  assert.deepEqual(confirm(first, otherKpi), { verdict: 'pass', kpis: [] });

  const same = compare(baseline(), candidate({ agentCostCpuMsPerAgentMin: 58 }));
  assert.deepEqual(confirm(first, same), { verdict: 'regression', kpis: ['agentCostCpuMsPerAgentMin'] });

  const clean = compare(baseline(), candidate({}));
  assert.deepEqual(confirm(first, clean), { verdict: 'pass', kpis: [] });
});

test('8. a failed scrape at a window edge is invalid; mid-window failures are ignored', () => {
  const edge = readSamples('samples.csv');
  // window opens 03:20:05; the bracketing samples are 03:20:00 and 03:20:10
  const i = edge.findIndex((x) => x.ts.toISOString() === '2026-10-13T03:20:10.000Z');
  edge[i].scrapeOk = false;
  assert.throws(() => build({ samples: edge }), (e) => e instanceof InvalidRunError && /scrape failed at window edge/.test(e.message));

  const mid = readSamples('samples.csv');
  const j = mid.findIndex((x) => x.ts.toISOString() === '2026-10-13T03:30:00.000Z');
  mid[j].scrapeOk = false;
  mid[j].cpuSeconds = Number.NaN;
  mid[j].elu = Number.NaN;
  const rec = build({ samples: mid });
  assert.ok(Math.abs(rec.kpis.agentCostCpuMsPerAgentMin - 41.7) < 0.01);
});

test('8b. a failed scrape at the closing window edge is invalid too', () => {
  const edge = readSamples('samples.csv');
  // window closes 03:40:05; the bracketing samples are 03:40:00 and 03:40:10
  const i = edge.findIndex((x) => x.ts.toISOString() === '2026-10-13T03:40:00.000Z');
  edge[i].scrapeOk = false;
  assert.throws(() => build({ samples: edge }), (e) => e instanceof InvalidRunError && /scrape failed at window edge/.test(e.message));
});

test('8c. a mid-window outage longer than 30 s without a good sample is invalid', () => {
  // two consecutive failed scrapes at a 10 s interval leave a 30 s gap: still fine
  const ok = readSamples('samples.csv');
  for (const t of ['03:30:00', '03:30:10']) {
    const k = ok.findIndex((x) => x.ts.toISOString() === `2026-10-13T${t}.000Z`);
    ok[k].scrapeOk = false;
  }
  assert.ok(Number.isFinite(build({ samples: ok }).kpis.agentCostCpuMsPerAgentMin));

  // three in a row leave a 40 s gap: the run did not watch the API through the window
  const gap = readSamples('samples.csv');
  for (const t of ['03:30:00', '03:30:10', '03:30:20']) {
    const k = gap.findIndex((x) => x.ts.toISOString() === `2026-10-13T${t}.000Z`);
    gap[k].scrapeOk = false;
  }
  assert.throws(() => build({ samples: gap }), (e) => e instanceof InvalidRunError && /no good sample for 40 s/.test(e.message));
});
