import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORKER_REGISTRY, selectWorkers } from './services/workerRegistry';
import { initializePamActuationWorker, shutdownPamActuationWorker } from './jobs/pamActuationWorker';

describe('PAM actuation worker runtime lifecycle', () => {
  it('is registered in the lazy worker registry with readiness-tracked init and shutdown symmetry', async () => {
    const entry = WORKER_REGISTRY.find((w) => w.name === 'pamActuationWorker');
    expect(entry).toBeDefined();
    expect(entry!.placement).toBe('global');
    const mod = await entry!.load();
    expect(mod.init).toBe(initializePamActuationWorker);
    expect(mod.shutdown).toBe(shutdownPamActuationWorker);
  });

  it('runs on the worker and all roles, not api, now that it is global (#4142)', () => {
    const includesPam = (role: 'api' | 'worker' | 'all') =>
      selectWorkers(role).some((entry) => entry.name === 'pamActuationWorker');
    expect(includesPam('api')).toBe(false);
    expect(includesPam('all')).toBe(true);
    expect(includesPam('worker')).toBe(true);
  });

  it('the workers shutdown phase precedes Redis teardown in the shutdown plan', () => {
    const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const workersPhase = indexSource.indexOf("{ name: 'workers', tasks: workerShutdownTasks }");
    const redisPhase = indexSource.indexOf("{ name: 'redis', tasks: [closeRedis] }");
    expect(workersPhase).toBeGreaterThan(-1);
    expect(redisPhase).toBeGreaterThan(workersPhase);
  });
});
