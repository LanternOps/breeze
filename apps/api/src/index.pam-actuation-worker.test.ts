import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORKER_REGISTRY } from './services/workerRegistry';
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

  it('the workers shutdown phase precedes Redis teardown in the shutdown plan', () => {
    const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const workersPhase = indexSource.indexOf("{ name: 'workers', tasks: workerShutdownTasks }");
    const redisPhase = indexSource.indexOf("{ name: 'redis', tasks: [closeRedis] }");
    expect(workersPhase).toBeGreaterThan(-1);
    expect(redisPhase).toBeGreaterThan(workersPhase);
  });
});
