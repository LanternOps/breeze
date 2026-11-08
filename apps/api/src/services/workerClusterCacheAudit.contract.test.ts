import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Worker-role cluster-cache audit (#8639, W05 follow-up 5 of #8139).
 *
 * The cluster-invalidated hot-path caches (W05, #8144) are only dropped on a
 * remote write while this process runs the cluster cache bus subscriber.
 * `index.ts` starts it; `BREEZE_ROLE=worker` (`worker.ts`) is a separate
 * entrypoint. A worker that loads a cluster-cache module but never subscribes
 * serves those entries until TTL expiry (up to 5 min), ignoring every
 * invalidation published by the API tier.
 *
 * Audit result (the pinned set below): the worker's runtime import closure —
 * worker.ts plus every `global`-placement registry entry, following dynamic
 * imports — DOES reach four cluster-cache modules, so `worker.ts` starts the
 * bus (asserted below) and this test pins exactly which cache modules may be
 * reachable. A new cluster cache landing on the worker path fails here until
 * it is reviewed and added with a reason; a worker that stops subscribing
 * fails the first test.
 *
 * Static analysis only (regex import walk, no execution), same approach and
 * the same role-safe boundary as workerEntrypointClosure.contract.test.ts.
 */

const SRC_ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(SRC_ROOT, 'worker.ts');
const REGISTRY = path.join(SRC_ROOT, 'services', 'workerRegistry.ts');
/** Loaded by every placement; its only socket-local reach is a role-guarded dynamic import. */
const ROLE_SAFE_LEAVES = new Set([path.join(SRC_ROOT, 'services', 'agentCommandRelay.ts')]);
/** Files that implement the mechanism rather than own a cache. */
const MECHANISM = new Set([
  path.join(SRC_ROOT, 'services', 'hotPathCache.ts'),
  path.join(SRC_ROOT, 'services', 'clusterCacheRegistry.ts'),
]);

/**
 * Cluster-cache modules the worker may load, each with the worker-side reader
 * that justifies it. All are safe ONLY because worker.ts subscribes.
 */
const ALLOWED_WORKER_CACHE_MODULES: Record<string, string> = {
  'services/agentOrgSettingsCache.ts':
    'topology/flags.ts reads org topology flags from jobs/unifiTelemetryWorker.ts',
  'services/entitlements.ts': 'jobs/wispWakeScheduler.ts reads partner entitlements',
  'services/manifestSigning.ts':
    'worker-queued commands sign via commandQueue -> commandDelivery -> diagnosticAccess',
  'services/unifi/unifiCollectorService.ts':
    'jobs/unifiTelemetryWorker.ts reads the agent-collector absence cache',
};

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const IMPORT_RES = [
  /\b(?:import|export)\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
];

function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== '__tests__') yield* sourceFiles(p);
    } else if (p.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(p)) {
      yield p;
    }
  }
}

const rel = (f: string) => path.relative(SRC_ROOT, f).split(path.sep).join('/');

function workerSeeds(): string[] {
  const registry = strip(fs.readFileSync(REGISTRY, 'utf8'));
  const globalLoads = [
    ...registry.matchAll(/placement:\s*'global'[\s\S]*?await import\(\s*['"]([^'"]+)['"]/g),
  ].map((m) => resolveSpec(REGISTRY, m[1]!));
  return [WORKER, ...globalLoads.filter((f): f is string => f !== null)];
}

function workerClosure(seeds: string[]): { seen: Set<string>; parent: Map<string, string> } {
  const seen = new Set<string>();
  const parent = new Map<string, string>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (ROLE_SAFE_LEAVES.has(f)) continue;
    const src = strip(fs.readFileSync(f, 'utf8'));
    for (const re of IMPORT_RES) {
      for (const m of src.matchAll(re)) {
        const r = resolveSpec(f, m[1]!);
        if (r && !seen.has(r)) {
          if (!parent.has(r)) parent.set(r, f);
          stack.push(r);
        }
      }
    }
  }
  return { seen, parent };
}

function clusterCacheModules(): string[] {
  return [...sourceFiles(SRC_ROOT)].filter(
    (f) =>
      !MECHANISM.has(f) &&
      /cluster:\s*true|registerClusterCache\(/.test(strip(fs.readFileSync(f, 'utf8'))),
  );
}

describe('worker-role cluster cache audit (#8639)', () => {
  it('worker.ts starts the cluster cache bus after Redis is confirmed and stops it on shutdown', () => {
    const src = strip(fs.readFileSync(WORKER, 'utf8'));
    expect(src).toMatch(/getClusterCacheBus\(\)\.start\(\)/);
    expect(src).toMatch(/getClusterCacheBus\(\)\.stop\(\)/);
    expect(src.indexOf('getClusterCacheBus().start()')).toBeGreaterThan(src.indexOf('const redisOk = await probeRedis()'));
  });

  it('discovery is not vacuous: finds the known cache modules and walks a real closure', () => {
    const found = clusterCacheModules().map(rel);
    expect(found).toEqual(expect.arrayContaining(Object.keys(ALLOWED_WORKER_CACHE_MODULES)));
    expect(workerSeeds().length).toBeGreaterThan(10);
  });

  it('the worker path reaches only the reviewed cluster-cache modules', () => {
    const { seen, parent } = workerClosure(workerSeeds());
    const reached = clusterCacheModules().filter((f) => seen.has(f));
    const unreviewed = reached.map(rel).filter((r) => !(r in ALLOWED_WORKER_CACHE_MODULES));
    const chains = unreviewed.map((r) => {
      const chain: string[] = [];
      let cur: string | undefined = path.join(SRC_ROOT, r);
      while (cur) {
        chain.push(rel(cur));
        cur = parent.get(cur);
      }
      return chain.slice(0, 6).join(' <- ');
    });
    expect(
      unreviewed,
      `BREEZE_ROLE=worker now loads a cluster-invalidated cache not yet reviewed: ${chains.join('; ')}. ` +
        `worker.ts runs the cluster cache bus, so the cache is invalidated correctly — add the module to ` +
        `ALLOWED_WORKER_CACHE_MODULES with the worker-side reader that justifies it (or cut the import).`,
    ).toEqual([]);
  });

  it('every allowlisted module is still reached (drop stale entries)', () => {
    const { seen } = workerClosure(workerSeeds());
    const stale = Object.keys(ALLOWED_WORKER_CACHE_MODULES).filter(
      (r) => !seen.has(path.join(SRC_ROOT, r)),
    );
    expect(stale).toEqual([]);
  });
});
