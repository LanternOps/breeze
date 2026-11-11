// apps/api/src/services/workerRegistry.observationRetention.test.ts
import { describe, expect, it } from 'vitest';
import { selectWorkers, WORKER_REGISTRY } from './workerRegistry';
import { RETENTION_JOB_NAMES } from './retentionMetrics';
import { WORKER_READINESS_MANIFEST } from '../jobs/workerReadinessManifest';
import { JOB_SCHEDULES, jobSchedule } from '../jobs/scheduleRegistry';

describe('observationRetention registration (#11737)', () => {
  it('holds an allocated hourly slot, off the fine-grained ticks\' minutes, not a bare interval', () => {
    const slot = jobSchedule('observation-retention');
    expect(slot).toBe('41 * * * *');
    expect(Number(slot.split(' ')[0]) % 5).not.toBe(0);
    expect(Object.values(JOB_SCHEDULES).filter((p) => p === slot)).toHaveLength(1);
  });

  it('is a global-placement, lazily-loaded entry, so BREEZE_ROLE=worker runs it', async () => {
    const entry = WORKER_REGISTRY.find((e) => e.name === 'observationRetention');
    expect(entry).toBeDefined();
    expect(entry?.placement).toBe('global');
    expect(selectWorkers('worker').map((e) => e.name)).toContain('observationRetention');
    const loaded = await entry!.load();
    expect(typeof loaded.init).toBe('function');
    expect(typeof loaded.shutdown).toBe('function');
  }, 60_000);

  it('declares its consumer so /ready waits for it', () => {
    const entry = WORKER_READINESS_MANIFEST.find(
      (e) => e.kind === 'consumers' && e.initializer === 'observationRetention',
    );
    expect(entry).toMatchObject({ consumers: ['observationRetention'], requiredWhen: 'redis' });
  });

  it('publishes one bounded retention metric name per target', () => {
    expect(RETENTION_JOB_NAMES).toContain('agent_health_observation_retention');
    expect(RETENTION_JOB_NAMES).toContain('software_inventory_observation_retention');
  });
});
