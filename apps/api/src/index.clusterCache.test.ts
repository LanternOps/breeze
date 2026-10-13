import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source-level assertions on the W05 (#8144) cluster cache subscriber wiring,
 * like index.agentAdmission.test.ts: the bus's behaviour is proven in
 * clusterCacheBus.test.ts and the integration suite, never that index.ts
 * starts it before serving and stops it before the shared Redis goes away.
 *
 * Anchors are statement regexes at line start, so a comment naming the call
 * cannot satisfy them.
 */
const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const stmt = (pattern: RegExp): number => {
  const match = pattern.exec(indexSource);
  expect(match, String(pattern)).not.toBeNull();
  return match!.index;
};
const escape = (code: string) => code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineStart = (code: string): RegExp => new RegExp(`^[ \\t]*${escape(code)}`, 'm');

describe('cluster cache subscriber wiring (index.ts)', () => {
  it('awaits the bounded start after the startup Redis check and before the server listens', () => {
    const start = stmt(/^[ \t]*const clusterCacheOutcome = startupChecks\.redisOk\s*\?\s*await getClusterCacheBus\(\)\.start\(\)/m);
    expect(start).toBeGreaterThan(stmt(lineStart('await runStartupChecks();')));
    expect(start).toBeLessThan(stmt(lineStart('server = serve({')));
  });

  it('stops the subscriber in its own shutdown phase, before the shared Redis quits', () => {
    const phases = stmt(lineStart('const report = await runShutdownPhases(['));
    const phase = stmt(/^[ \t]*\{ name: 'cluster-cache-bus', tasks: \[\(\) => getClusterCacheBus\(\)\.stop\(\)\] \}/m);
    const redis = stmt(lineStart("{ name: 'redis', tasks: [closeRedis] },"));
    expect(phase).toBeGreaterThan(phases);
    expect(phase).toBeLessThan(redis);
  });

  it('is not started by the worker entrypoint (D8: only the API subscribes)', () => {
    const workerSource = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8');
    expect(workerSource).not.toMatch(/getClusterCacheBus\(\)\.start\(/);
  });
});
