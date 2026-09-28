import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TopologyPage } from '../pages/TopologyPage';
import {
  PROJECTION_SPEC, REFERENCE_THROTTLE, calibrate, installProbes, serveProjection, throttle,
  type Probe, type ProjectionName, type ThrottleProfile,
} from '../helpers/topologyPerformance';

/**
 * M1 enablement gate: topology explorer browser performance (design spec §9,
 * M1 plan Task 25, INDEX rollback thresholds). Run ONLY through
 * `playwright.topology-performance.config.ts` — see e2e-tests/README.md.
 *
 * What one sample is: an independent open of the discovery topology tab in a
 * fresh page (§9: "30 independent browser opens per projection"), under 4x CPU
 * throttling and 100 ms RTT / 10 Mbps emulation, at 1440x900, against the BUILT
 * production bundle with its real module layout worker and ELK engine worker.
 * The first open of each projection runs with an empty HTTP cache and is
 * reported separately as the cold open; it is not part of p50/p95.
 *
 * Timing points (all `performance.now()` in the page):
 *   t0          graph response complete (resource timing `responseEnd`)
 *   request     layout request posted to the worker (the one finally applied)
 *   result      that request's worker reply
 *   applied     explorer applied the layout (draft marked dirty)
 *   painted     two animation frames after applied
 *   interactive end of the last main-thread long task before a 500 ms
 *               long-task-free window, searching from `painted`
 *
 * Measured quantities and §9 budgets (enforced only with TOPOLOGY_PERF_REFERENCE=1):
 *   interactiveMs = interactive - t0   V200, V500 p95 <= 2000 ms (<=500 visible nodes)
 *   layoutMs      = result - request   V200 p95 <= 1000 ms ("initial layout")
 *                                      V1000 p95 <= 3000 ms ("expanded worker layout")
 *   interactiveMs (INDEX rollback line) every projection p95 <= 4000 ms
 *   layout fallback (worker ELK failure, controller 3 s timeout, worker crash)
 *                 <= 1% of all measured layouts (INDEX rollback line); with the
 *                 default 90 measured layouts that means zero fallbacks
 *
 * CPU throttling reaches the page main thread only: Chromium rejects
 * `Emulation.setCPUThrottlingRate` on worker targets, so the layout workers run
 * at host speed. A calibration loop on both threads records the effective
 * ratios in the artifact, and the main-thread ratio is asserted.
 *
 * Without TOPOLOGY_PERF_REFERENCE=1 the run RECORDS and soft-reports: a laptop
 * is not the reference profile and must never read as having passed the gate.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..');
const REFERENCE = process.env.TOPOLOGY_PERF_REFERENCE === '1';
const SAMPLES = Number(process.env.TOPOLOGY_PERF_SAMPLES ?? 30);
const ALL: ProjectionName[] = ['V200', 'V500', 'V1000'];
const PROJECTIONS = (process.env.TOPOLOGY_PERF_PROJECTIONS?.split(',').map((value) => value.trim()) ?? ALL) as ProjectionName[];
const CPU_RATE = Number(process.env.TOPOLOGY_PERF_CPU_RATE ?? REFERENCE_THROTTLE.cpuRate);
const PROFILE: ThrottleProfile = { ...REFERENCE_THROTTLE, cpuRate: CPU_RATE };
const QUIET_MS = 500;
const OUTPUT = path.resolve(process.env.TOPOLOGY_PERF_OUTPUT ?? path.join(here, '..', 'test-results', 'topology-performance.json'));
/** Per-projection results; the gate test reads them back (a failed test restarts the worker process). */
const PARTS = path.join(here, '..', 'test-results', 'topology-performance-parts');
const REFERENCE_CPU = /i7-12700/;
const MIN_REFERENCE_SAMPLES = 30;

const BUDGETS = {
  interactiveP95Ms: { V200: 2_000, V500: 2_000 } as Partial<Record<ProjectionName, number>>,
  layoutP95Ms: { V200: 1_000, V1000: 3_000 } as Partial<Record<ProjectionName, number>>,
  rollbackInteractiveP95Ms: 4_000,
  maxFallbackRate: 0.01,
};

for (const name of PROJECTIONS) {
  if (!ALL.includes(name)) throw new Error(`TOPOLOGY_PERF_PROJECTIONS: unknown projection ${name}`);
}
if (!Number.isInteger(SAMPLES) || SAMPLES < 1) throw new Error('TOPOLOGY_PERF_SAMPLES must be a positive integer');

type Outcome = 'elk' | 'worker_fallback' | 'controller_fallback' | 'unattributed';
type Sample = {
  interactiveMs: number; layoutMs: number; graphToAppliedMs: number; graphToLayoutRequestMs: number;
  layoutRequests: number; outcome: Outcome; fallback: boolean; warningVisible: boolean;
  maxLongTaskDuringLayoutMs: number; longTaskMsAfterGraph: number; graphTiming: string;
  pageErrors: string[]; cspViolations: string[]; workerErrors: string[]; workerUrls: string[];
};
type Stats = { n: number; min: number; p50: number; p95: number; max: number; mean: number };
type Part = {
  projection: ProjectionName; nodes: number; edges: number; graphBytes: number; samples: Sample[]; cold: Sample;
  calibration: { unthrottled: CalibrationRun; throttled: CalibrationRun; mainRatio: number; workerRatio: number | null };
  topologyWrites: string[];
};
type CalibrationRun = Awaited<ReturnType<typeof calibrate>>;

/** Nearest-rank percentile: p95 of 30 samples is the 29th smallest. */
function percentile(sorted: number[], p: number) { return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!; }
function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    n: sorted.length, min: round(sorted[0]!), p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1)!), mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

function summarize(probe: Probe, pageErrors: string[]): Sample {
  const t0 = probe.graph?.responseEnd ?? probe.graphFetchAt;
  if (t0 === null || t0 === undefined) throw new Error('graph response was never observed');
  if (probe.appliedAt === null || probe.paintedAt === null) throw new Error('layout was never applied');
  const posted = probe.requests.filter((request) => request.at <= probe.appliedAt!);
  const request = posted.at(-1);
  if (!request) throw new Error('no layout request was posted before the layout was applied');
  const result = probe.results.find((entry) => entry.requestId === request.requestId && entry.at <= probe.appliedAt!);
  const outcome: Outcome = result
    ? (result.warning === 'layout_fallback' ? 'worker_fallback' : 'elk')
    : (probe.warningAtApply ? 'controller_fallback' : 'unattributed');
  const layoutEnd = result?.at ?? probe.appliedAt;

  let interactive = probe.paintedAt;
  const later = probe.longTasks.filter(([start, duration]) => start + duration > probe.paintedAt!).sort((a, b) => a[0] - b[0]);
  for (const [start, duration] of later) {
    if (start - interactive >= QUIET_MS) break;
    interactive = Math.max(interactive, start + duration);
  }
  const overlap = (from: number, to: number) => probe.longTasks
    .filter(([start, duration]) => start < to && start + duration > from)
    .map(([start, duration]) => Math.min(to, start + duration) - Math.max(from, start));
  return {
    interactiveMs: interactive - t0,
    layoutMs: layoutEnd - request.at,
    graphToAppliedMs: probe.appliedAt - t0,
    graphToLayoutRequestMs: (probe.requests[0]?.at ?? request.at) - t0,
    layoutRequests: posted.length,
    outcome, fallback: outcome !== 'elk', warningVisible: probe.warningAtApply,
    maxLongTaskDuringLayoutMs: Math.max(0, ...overlap(request.at, layoutEnd)),
    longTaskMsAfterGraph: overlap(t0, interactive).reduce((sum, value) => sum + value, 0),
    graphTiming: probe.graph?.source ?? 'fetch',
    pageErrors, cspViolations: probe.violations,
    workerErrors: probe.workerErrors.map((entry) => entry.message), workerUrls: [...new Set(probe.workers.map((url) => new URL(url, 'http://x').pathname))],
  };
}

async function openOnce(context: BrowserContext, siteId: string): Promise<Sample> {
  const page = await context.newPage();
  try {
    await throttle(page, PROFILE);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await new TopologyPage(page).openDiscovery(siteId);
    await page.waitForFunction(() => (window as unknown as { topologyPerfProbe: Probe }).topologyPerfProbe.paintedAt !== null,
      null, { timeout: 60_000, polling: 100 });
    // Keep sampling long tasks until a quiet window has actually elapsed.
    await page.waitForFunction((quiet) => {
      const probe = (window as unknown as { topologyPerfProbe: Probe }).topologyPerfProbe;
      const lastEnd = Math.max(probe.paintedAt!, ...probe.longTasks.map(([start, duration]) => start + duration));
      return performance.now() - lastEnd >= quiet;
    }, QUIET_MS, { timeout: 60_000, polling: 100 });
    const probe = await page.evaluate(() => (window as unknown as { topologyPerfProbe: Probe }).topologyPerfProbe);
    return summarize(probe, pageErrors);
  } finally {
    await page.close();
  }
}

async function measureCalibration(context: BrowserContext) {
  const page = await context.newPage();
  try {
    await page.goto('/login');
    const unthrottled = await calibrate(page);
    const cdp = await throttle(page, PROFILE);
    const throttled = await calibrate(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    return {
      unthrottled, throttled,
      mainRatio: Math.round((throttled.mainMs / unthrottled.mainMs) * 100) / 100,
      workerRatio: throttled.workerMs && unthrottled.workerMs ? Math.round((throttled.workerMs / unthrottled.workerMs) * 100) / 100 : null,
    };
  } finally { await page.close(); }
}

const usedLayoutWorker = (sample: Sample) => sample.workerUrls.some((url) => /\/_astro\/layout\.worker-/.test(url));

// Integrity breaches for one projection. The projection test asserts the same
// conditions, but the artifact is the evidence copied off-host, so its verdict
// must fail on them too rather than on budgets alone.
function integrityBreaches(part: Part): number {
  const badOpens = [part.cold, ...part.samples]
    .filter((sample) => sample.cspViolations.length > 0 || sample.pageErrors.length > 0 || !usedLayoutWorker(sample)).length;
  return badOpens + part.topologyWrites.length;
}

test.describe('topology explorer browser performance (§9)', () => {
  test.beforeAll(() => {
    if (!REFERENCE) return;
    // The reference profile is a contract: no partial or reshaped runs count.
    if (SAMPLES < MIN_REFERENCE_SAMPLES) throw new Error(`reference runs need >= ${MIN_REFERENCE_SAMPLES} samples per projection`);
    if (PROJECTIONS.length !== ALL.length) throw new Error('reference runs measure every projection');
    if (CPU_RATE !== REFERENCE_THROTTLE.cpuRate) throw new Error('reference runs use the §9 4x CPU throttle');
  });

  for (const name of PROJECTIONS) {
    test(`${name}: ${SAMPLES} independent opens under the §9 profile`, async ({ browser }) => {
      // Worst case per open is ~60 s of waits; typical is a few seconds.
      test.setTimeout((SAMPLES + 4) * 90_000);
      const context = await browser.newContext();
      try {
        const server = await serveProjection(context, name);
        await installProbes(context);
        expect({ nodes: server.nodeCount, edges: server.edgeCount }).toEqual(PROJECTION_SPEC[name]);
        const cold = await openOnce(context, server.siteId);
        const samples: Sample[] = [];
        for (let index = 0; index < SAMPLES; index += 1) samples.push(await openOnce(context, server.siteId));
        const calibration = await measureCalibration(context);
        const part: Part = {
          projection: name, nodes: server.nodeCount, edges: server.edgeCount, graphBytes: server.graphBytes,
          samples, cold, calibration, topologyWrites: [...server.writes],
        };
        mkdirSync(PARTS, { recursive: true });
        writeFileSync(path.join(PARTS, `${name}.json`), JSON.stringify(part, null, 2));
        // Harness integrity, asserted in every mode: a measurement that ran the
        // production worker, stayed passive and loaded nothing the CSP refused.
        for (const sample of [cold, ...samples]) {
          expect(sample.cspViolations).toEqual([]);
          expect(sample.pageErrors).toEqual([]);
          expect(usedLayoutWorker(sample)).toBe(true);
        }
        expect(server.writes).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test('gate: §9 budgets and INDEX rollback lines', async ({ browser }, testInfo) => {
    const parts = PROJECTIONS.flatMap((name) => {
      const file = path.join(PARTS, `${name}.json`);
      return existsSync(file) ? [JSON.parse(readFileSync(file, 'utf8')) as Part] : [];
    });
    const missing = PROJECTIONS.filter((name) => !parts.some((part) => part.projection === name));
    const measured = parts.flatMap((part) => part.samples);
    const fallbacks = measured.filter((sample) => sample.fallback).length;
    const allowedFallbacks = Math.floor(BUDGETS.maxFallbackRate * measured.length);

    const verdicts: { check: string; budgetMs?: number; budget?: number; actual: number | null; pass: boolean }[] = [];
    const projections = Object.fromEntries(parts.map((part) => {
      const interactive = stats(part.samples.map((sample) => sample.interactiveMs));
      const layout = stats(part.samples.map((sample) => sample.layoutMs));
      const interactiveBudget = BUDGETS.interactiveP95Ms[part.projection];
      const layoutBudget = BUDGETS.layoutP95Ms[part.projection];
      if (interactiveBudget) verdicts.push({ check: `${part.projection} interactive p95 (§9)`, budgetMs: interactiveBudget, actual: interactive.p95, pass: interactive.p95 <= interactiveBudget });
      if (layoutBudget) verdicts.push({ check: `${part.projection} worker layout p95 (§9)`, budgetMs: layoutBudget, actual: layout.p95, pass: layout.p95 <= layoutBudget });
      verdicts.push({ check: `${part.projection} interactive p95 (INDEX rollback line)`, budgetMs: BUDGETS.rollbackInteractiveP95Ms, actual: interactive.p95, pass: interactive.p95 <= BUDGETS.rollbackInteractiveP95Ms });
      return [part.projection, {
        nodes: part.nodes, edges: part.edges, graphBytes: part.graphBytes,
        interactiveMs: interactive, layoutMs: layout,
        graphToAppliedMs: stats(part.samples.map((sample) => sample.graphToAppliedMs)),
        maxLongTaskDuringLayoutMs: stats(part.samples.map((sample) => sample.maxLongTaskDuringLayoutMs)),
        layoutRequestsPerOpen: stats(part.samples.map((sample) => sample.layoutRequests)),
        fallbacks: part.samples.filter((sample) => sample.fallback).length,
        outcomes: part.samples.reduce<Record<string, number>>((acc, sample) => ({ ...acc, [sample.outcome]: (acc[sample.outcome] ?? 0) + 1 }), {}),
        cold: part.cold, calibration: part.calibration, topologyWrites: part.topologyWrites, samples: part.samples,
      }];
    }));
    verdicts.push({ check: 'layout fallback rate (INDEX rollback line: <=1%)', budget: allowedFallbacks, actual: fallbacks, pass: fallbacks <= allowedFallbacks });
    for (const part of parts) {
      verdicts.push({ check: `${part.projection} main-thread CPU throttle in effect (calibration ratio >= 0.75x rate)`, budget: PROFILE.cpuRate * 0.75, actual: part.calibration.mainRatio, pass: part.calibration.mainRatio >= PROFILE.cpuRate * 0.75 });
      const breaches = integrityBreaches(part);
      verdicts.push({ check: `${part.projection} harness integrity (opens with CSP violations, page errors or no production layout worker, plus topology writes)`, budget: 0, actual: breaches, pass: breaches === 0 });
    }

    const cpus = os.cpus();
    const cpuModel = cpus[0]?.model ?? 'unknown';
    const hostMatches = process.platform === 'linux' && process.arch === 'x64' && REFERENCE_CPU.test(cpuModel);
    const artifact = {
      schema: 'breeze.topology-performance/v1',
      mode: REFERENCE ? 'reference' : 'record',
      verdict: REFERENCE ? (missing.length === 0 && verdicts.every((verdict) => verdict.pass) ? 'pass' : 'fail') : 'not-a-gate-run',
      generatedAt: new Date().toISOString(),
      commit: git(['rev-parse', 'HEAD']), dirty: (git(['status', '--porcelain']) ?? '').length > 0,
      lockfiles: { pnpm: sha256(path.join(REPO, 'pnpm-lock.yaml')), e2e: sha256(path.join(REPO, 'e2e-tests', 'package-lock.json')) },
      bundle: bundleIdentity(),
      host: {
        platform: process.platform, arch: process.arch, release: os.release(), cpuModel, logicalCpus: cpus.length,
        availableParallelism: os.availableParallelism(), totalMemGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
        governor: readOptional('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'),
        note: process.env.TOPOLOGY_PERF_HOST_NOTE ?? null,
        referenceProfile: { expected: 'Linux x86-64, Intel Core i7-12700 (8 P-cores), 16 GiB, SSD', matches: hostMatches },
      },
      browser: { name: browser.browserType().name(), version: browser.version(), viewport: { width: 1440, height: 900 } },
      profile: { ...PROFILE, samplesPerProjection: SAMPLES, quietWindowMs: QUIET_MS, percentile: 'nearest-rank' },
      budgets: BUDGETS, missingProjections: missing,
      limitations: [
        'Chromium applies CDP CPU throttling (Emulation.setCPUThrottlingRate) to the page main thread only; worker targets reject it '
          + '("Operation is only supported for pages, not workers"). The layout and ELK engine workers therefore run at host speed; '
          + 'calibration.workerRatio records this per projection. Worker timings are only comparable on the same reference host.',
        'The graph response is served by a controlled in-page API (every §9 browser budget is timed from graph response); '
          + 'the API read budget is a separate gate.',
      ],
      fallback: { measuredLayouts: measured.length, fallbacks, allowedFallbacks, rate: measured.length ? fallbacks / measured.length : null },
      verdicts, projections,
    };
    mkdirSync(path.dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, JSON.stringify(artifact, null, 2));
    await testInfo.attach('topology-performance.json', { path: OUTPUT, contentType: 'application/json' });

    const lines = [
      `topology browser performance — ${artifact.mode.toUpperCase()} (${artifact.verdict}) — ${cpuModel}, ${browser.version()}, CPU x${PROFILE.cpuRate}`,
      ...parts.map((part) => {
        const summary = projections[part.projection] as { interactiveMs: Stats; layoutMs: Stats; fallbacks: number };
        return `  ${part.projection.padEnd(5)} n=${summary.interactiveMs.n} interactive p50/p95/max ${summary.interactiveMs.p50}/${summary.interactiveMs.p95}/${summary.interactiveMs.max} ms · layout p50/p95/max ${summary.layoutMs.p50}/${summary.layoutMs.p95}/${summary.layoutMs.max} ms · fallbacks ${summary.fallbacks} · cold interactive ${Math.round(part.cold.interactiveMs)} ms`;
      }),
      ...verdicts.map((verdict) => `  ${verdict.pass ? 'ok  ' : 'MISS'} ${verdict.check}: ${verdict.actual} (budget ${verdict.budgetMs ?? verdict.budget})`),
      `  artifact: ${OUTPUT}`,
    ];
    console.log(lines.join('\n'));

    if (!REFERENCE) {
      testInfo.annotations.push({ type: 'record-only', description: 'TOPOLOGY_PERF_REFERENCE is not set: budgets reported, not enforced. Not gate evidence.' });
      expect(missing, 'every requested projection produced a result').toEqual([]);
      return;
    }
    expect(missing, 'every projection measured').toEqual([]);
    if (!hostMatches && process.env.TOPOLOGY_PERF_ALLOW_HOST_MISMATCH !== '1') {
      expect.soft(hostMatches, `host ${process.platform}/${process.arch} ${cpuModel} is not the §9 reference profile (set TOPOLOGY_PERF_ALLOW_HOST_MISMATCH=1 to record the mismatch explicitly)`).toBe(true);
    }
    for (const verdict of verdicts) expect.soft(verdict.pass, `${verdict.check}: ${verdict.actual} vs ${verdict.budgetMs ?? verdict.budget}`).toBe(true);
  });
});

function git(args: string[]) {
  try { return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim(); } catch { return null; }
}
function sha256(file: string) {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { return null; }
}
function readOptional(file: string) {
  try { return readFileSync(file, 'utf8').trim(); } catch { return null; }
}
function bundleIdentity() {
  const dist = path.join(REPO, 'apps', 'web', 'dist');
  try {
    return {
      builtAt: statSync(path.join(dist, 'server', 'entry.mjs')).mtime.toISOString(),
      workerAssets: readdirSync(path.join(dist, 'client', '_astro')).filter((file) => /worker-.*\.js$/.test(file)).sort(),
    };
  } catch { return null; }
}
