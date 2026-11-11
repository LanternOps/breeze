// apps/api/src/services/workerRegistry.scriptExecutionRetention.test.ts
import { describe, expect, it } from 'vitest';
import { selectWorkers, WORKER_REGISTRY } from './workerRegistry';
import { RETENTION_JOB_NAMES } from './retentionMetrics';
import { WORKER_READINESS_MANIFEST } from '../jobs/workerReadinessManifest';
import { JOB_SCHEDULES, jobSchedule } from '../jobs/scheduleRegistry';

describe('scriptExecutionRetention registration (#4342 W2)', () => {
  it('holds an allocated daily slot, not a bare interval', () => {
    const slot = jobSchedule('script-execution-retention');
    expect(slot).toBe('8 12 * * *');
    expect(slot).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(Object.values(JOB_SCHEDULES).filter((p) => p === slot)).toHaveLength(1);
  });

  it('is a global-placement, lazily-loaded entry, so BREEZE_ROLE=worker runs it', async () => {
    const entry = WORKER_REGISTRY.find((e) => e.name === 'scriptExecutionRetention');
    expect(entry).toBeDefined();
    expect(entry?.placement).toBe('global');
    expect(selectWorkers('worker').map((e) => e.name)).toContain('scriptExecutionRetention');
    const loaded = await entry!.load();
    expect(typeof loaded.init).toBe('function');
    expect(typeof loaded.shutdown).toBe('function');
  }, 60_000);

  it('declares its consumer so /ready waits for it', () => {
    const entry = WORKER_READINESS_MANIFEST.find(
      (e) => e.kind === 'consumers' && e.initializer === 'scriptExecutionRetention',
    );
    expect(entry).toMatchObject({ consumers: ['scriptExecutionRetention'], requiredWhen: 'redis' });
  });

  it('publishes one bounded retention metric name per target', () => {
    for (const name of ['script_execution_output_retention', 'script_execution_retention', 'script_execution_batch_retention'] as const) {
      expect(RETENTION_JOB_NAMES).toContain(name);
    }
  });
});
