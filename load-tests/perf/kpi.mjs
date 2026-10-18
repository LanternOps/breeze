// load-tests/perf/kpi.mjs — pure KPI record + regression comparator (scaling W07, #8146).
// No I/O, no dependencies beyond Node built-ins. cli.mjs does the file and CSV work.

export const KPI_SCHEMA = 'breeze.perf.kpi/v1';
export const AGENTSIM_SCHEMA = 'breeze.agentsim.report/v1';

/** Gated KPIs: regressed when worse by more than THRESHOLD *and* by more than `floor` in absolute terms (D4). */
export const GATED = {
  agentCostCpuMsPerAgentMin: { floor: 2 },
  heartbeatP95Ms: { floor: 10 },
  dbTxPerAgentMin: { floor: 0.25 },
};
export const THRESHOLD = 0.15;

const HEARTBEAT_ROUTE = 'POST /agents/:id/heartbeat';
const EDGE_MAX_GAP_MS = 30_000;

/** A run that did not measure what the baseline measured (D6): the CLI exits 2. */
export class InvalidRunError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRunError';
  }
}

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const toMs = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());

/**
 * Linearly interpolate `field` at `at` between the samples around it.
 * Throws InvalidRunError when a bracketing sample is more than 30 s away, missing,
 * or came from a failed scrape.
 */
export function interpolateAt(samples, field, at) {
  const t = toMs(at);
  if (!Number.isFinite(t)) throw new InvalidRunError(`interpolateAt: invalid instant ${String(at)}`);
  let before = null;
  let after = null;
  for (const s of samples) {
    const ms = toMs(s.ts);
    if (ms <= t && (before === null || ms > toMs(before.ts))) before = s;
    if (ms >= t && (after === null || ms < toMs(after.ts))) after = s;
  }
  const iso = new Date(t).toISOString();
  if (!before || !after) throw new InvalidRunError(`no ${field} sample on both sides of ${iso} (window edge not covered)`);
  const tb = toMs(before.ts);
  const ta = toMs(after.ts);
  if (t - tb > EDGE_MAX_GAP_MS || ta - t > EDGE_MAX_GAP_MS) {
    throw new InvalidRunError(`no ${field} sample within 30 s on both sides of ${iso}`);
  }
  if (!before.scrapeOk || !after.scrapeOk) throw new InvalidRunError(`scrape failed at window edge ${iso}`);
  const vb = before[field];
  const va = after[field];
  if (!isFiniteNumber(vb) || !isFiniteNumber(va)) throw new InvalidRunError(`non-numeric ${field} at window edge ${iso}`);
  if (ta === tb) return vb;
  return vb + ((va - vb) * (t - tb)) / (ta - tb);
}

/** Delta of a monotonic counter across [start, end]; a decrease anywhere inside is a process restart. */
function counterDelta(samples, field, start, end) {
  const startMs = toMs(start);
  const endMs = toMs(end);
  const first = interpolateAt(samples, field, start);
  const last = interpolateAt(samples, field, end);
  const inner = samples
    .filter((s) => s.scrapeOk && isFiniteNumber(s[field]) && toMs(s.ts) > startMs && toMs(s.ts) < endMs)
    .sort((a, b) => toMs(a.ts) - toMs(b.ts));
  let prev = first;
  for (const s of [...inner.map((x) => x[field]), last]) {
    if (s < prev) throw new InvalidRunError(`${field} decreased inside the window (restart inside the window): one process was not measured`);
    prev = s;
  }
  return last - first;
}

/**
 * Every point of the window must be within 30 s of a good sample on each side.
 * The edges are interpolated, so a mid-window outage (API stalled or
 * crash-looping) would otherwise vanish into a straight line between two
 * distant samples.
 */
function checkCoverage(samples, start, end) {
  const a = toMs(start);
  const b = toMs(end);
  const good = samples
    .filter((s) => s.scrapeOk && isFiniteNumber(s.cpuSeconds) && isFiniteNumber(s.xactCommit))
    .map((s) => toMs(s.ts))
    .filter((t) => t >= a - EDGE_MAX_GAP_MS && t <= b + EDGE_MAX_GAP_MS)
    .sort((x, y) => x - y);
  for (let i = 1; i < good.length; i++) {
    const gap = good[i] - good[i - 1];
    if (good[i] > a && good[i - 1] < b && gap > EDGE_MAX_GAP_MS) {
      throw new InvalidRunError(
        `no good sample for ${Math.round(gap / 1000)} s inside the window (${new Date(good[i - 1]).toISOString()} → ${new Date(good[i]).toISOString()}): the API was not observed`,
      );
    }
  }
}

function windowSamples(samples, start, end) {
  const a = toMs(start);
  const b = toMs(end);
  return samples.filter((s) => s.scrapeOk && toMs(s.ts) >= a && toMs(s.ts) <= b);
}

function finiteValues(rows, field) {
  return rows.map((r) => r[field]).filter(isFiniteNumber);
}

function idleCpuMsPerMin(idle) {
  if (!Array.isArray(idle)) return null;
  const ok = idle.filter((s) => s.scrapeOk && isFiniteNumber(s.cpuSeconds)).sort((a, b) => toMs(a.ts) - toMs(b.ts));
  if (ok.length < 2) return null;
  const minutes = (toMs(ok[ok.length - 1].ts) - toMs(ok[0].ts)) / 60_000;
  if (minutes <= 0) return null;
  const delta = ok[ok.length - 1].cpuSeconds - ok[0].cpuSeconds;
  return delta < 0 ? null : (delta * 1000) / minutes;
}

/**
 * samples/idle: [{ ts: Date, cpuSeconds, xactCommit, wsConnections, elu, lagMax, poolWaiting, scrapeOk }]
 */
export function buildKpiRecord({ report, samples, idle, hardware, stack, gitSha, profile, measuredAt, sources }) {
  if (!report || report.schema !== AGENTSIM_SCHEMA) {
    throw new InvalidRunError(`unsupported agentsim report schema ${JSON.stringify(report?.schema)}; expected ${AGENTSIM_SCHEMA}`);
  }
  const win = report.window;
  const agentMinutes = win?.agentMinutes;
  if (!isFiniteNumber(agentMinutes) || agentMinutes <= 0) {
    throw new InvalidRunError(`window.agentMinutes must be a positive number, got ${JSON.stringify(agentMinutes)}`);
  }
  const start = new Date(win.start);
  const end = new Date(win.end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new InvalidRunError(`window.start/end invalid: ${JSON.stringify([win.start, win.end])}`);
  }
  const hb = (report.routes ?? []).find((r) => r.route === HEARTBEAT_ROUTE);
  const lat = hb?.latencyMs;
  if (!lat || !isFiniteNumber(lat.p95)) {
    throw new InvalidRunError(`report has no usable ${HEARTBEAT_ROUTE} route latency (heartbeat route missing)`);
  }
  if (!Array.isArray(samples)) throw new InvalidRunError('samples must be an array');

  checkCoverage(samples, start, end);
  const cpuDelta = counterDelta(samples, 'cpuSeconds', start, end);
  const xactDelta = counterDelta(samples, 'xactCommit', start, end);
  const inWindow = windowSamples(samples, start, end);
  const elu = finiteValues(inWindow, 'elu');

  const kpis = {
    agentCostCpuMsPerAgentMin: (cpuDelta * 1000) / agentMinutes,
    heartbeatP95Ms: lat.p95,
    dbTxPerAgentMin: xactDelta / agentMinutes,
    heartbeatP50Ms: isFiniteNumber(lat.p50) ? lat.p50 : null,
    heartbeatP99Ms: isFiniteNumber(lat.p99) ? lat.p99 : null,
    idleCpuMsPerMin: idleCpuMsPerMin(idle),
    requestsPerAgentMin: isFiniteNumber(report.totals?.requestsPerAgentMinute) ? report.totals.requestsPerAgentMinute : null,
    elu: {
      mean: elu.length ? elu.reduce((a, b) => a + b, 0) / elu.length : null,
      max: elu.length ? Math.max(...elu) : null,
    },
    lagMaxSeconds: finiteValues(inWindow, 'lagMax').reduce((a, b) => Math.max(a, b), 0),
    poolWaitingMax: finiteValues(inWindow, 'poolWaiting').reduce((a, b) => Math.max(a, b), 0),
  };
  for (const name of Object.keys(GATED)) {
    if (!isFiniteNumber(kpis[name])) throw new InvalidRunError(`gated KPI ${name} is not a finite number: ${kpis[name]}`);
  }

  return {
    schema: KPI_SCHEMA,
    profile,
    gitSha,
    runId: report.runId,
    measuredAt,
    hardware,
    stack,
    window: {
      start: start.toISOString().replace('.000Z', 'Z'),
      end: end.toISOString().replace('.000Z', 'Z'),
      seconds: isFiniteNumber(win.seconds) ? win.seconds : (end - start) / 1000,
      agentMinutes,
    },
    kpis,
    sources: sources ?? {},
  };
}

function checkRecord(rec, label) {
  if (!rec || rec.schema !== KPI_SCHEMA) {
    throw new InvalidRunError(`${label} is not a ${KPI_SCHEMA} record (schema ${JSON.stringify(rec?.schema)})`);
  }
  for (const name of Object.keys(GATED)) {
    const v = rec.kpis?.[name];
    if (v === undefined || v === null) throw new InvalidRunError(`${label} is missing gated KPI ${name}`);
    if (!isFiniteNumber(v)) throw new InvalidRunError(`${label} has non-finite gated KPI ${name}: ${v}`);
  }
}

function checkComparable(base, cand) {
  for (const f of ['cpuModel', 'cpus', 'memGiB']) {
    if (base.hardware?.[f] !== cand.hardware?.[f]) {
      throw new InvalidRunError(`hardware.${f} differs: baseline ${JSON.stringify(base.hardware?.[f])} vs candidate ${JSON.stringify(cand.hardware?.[f])}`);
    }
  }
  const baseGrade = base.hardware?.baselineGrade !== false;
  const candGrade = cand.hardware?.baselineGrade !== false;
  if (baseGrade !== candGrade) {
    throw new InvalidRunError('hardware.baselineGrade differs: a baseline-grade record cannot be compared with a non-baseline-grade (e.g. macOS) record');
  }
  for (const f of ['profile', 'role']) {
    if (base.stack?.[f] !== cand.stack?.[f]) {
      throw new InvalidRunError(`stack.${f} differs: baseline ${JSON.stringify(base.stack?.[f])} vs candidate ${JSON.stringify(cand.stack?.[f])}`);
    }
  }
  if (base.profile !== cand.profile) {
    throw new InvalidRunError(`profile differs: baseline ${JSON.stringify(base.profile)} vs candidate ${JSON.stringify(cand.profile)}`);
  }
}

/** → { verdict: 'pass'|'regression', rows: [{ kpi, baseline, candidate, deltaPct, regressed, improved }] } */
export function compare(baseline, candidate) {
  checkRecord(baseline, 'baseline');
  checkRecord(candidate, 'candidate');
  checkComparable(baseline, candidate);
  const rows = Object.entries(GATED).map(([kpi, { floor }]) => {
    const b = baseline.kpis[kpi];
    const c = candidate.kpis[kpi];
    const delta = c - b;
    const rel = b > 0 ? delta / b : delta > 0 ? Infinity : 0;
    return {
      kpi,
      baseline: b,
      candidate: c,
      deltaPct: b > 0 ? rel * 100 : null,
      regressed: rel > THRESHOLD && delta > floor,
      improved: rel < -THRESHOLD,
    };
  });
  return { verdict: rows.some((r) => r.regressed) ? 'regression' : 'pass', rows };
}

/** D5: fail only if the confirm run regresses on at least one KPI that regressed first. */
export function confirm(first, second) {
  const firstSet = new Set(first.rows.filter((r) => r.regressed).map((r) => r.kpi));
  const kpis = second.rows.filter((r) => r.regressed && firstSet.has(r.kpi)).map((r) => r.kpi);
  return { verdict: kpis.length ? 'regression' : 'pass', kpis };
}
