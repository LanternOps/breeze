// apps/api/src/services/workerRegistry.networkMonitorResultRetention.test.ts
import { describe, expect, it } from 'vitest';
import { selectWorkers, WORKER_REGISTRY } from './workerRegistry';
import { RETENTION_JOB_NAMES } from './retentionMetrics';
import { WORKER_READINESS_MANIFEST } from '../jobs/workerReadinessManifest';
import { JOB_SCHEDULES, jobSchedule } from '../jobs/scheduleRegistry';

describe('networkMonitorResultRetention registration (#4342 W1)', () => {
  it('holds an allocated daily slot, not a bare interval', () => {
    const slot = jobSchedule('network-monitor-result-retention');
    expect(slot).toBe('33 11 * * *');
    expect(slot).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(Object.values(JOB_SCHEDULES).filter((p) => p === slot)).toHaveLength(1);
  });

  it('is a global-placement, lazily-loaded entry, so BREEZE_ROLE=worker runs it', async () => {
    const entry = WORKER_REGISTRY.find((e) => e.name === 'networkMonitorResultRetention');
    expect(entry).toBeDefined();
    expect(entry?.placement).toBe('global');
    expect(selectWorkers('worker').map((e) => e.name)).toContain('networkMonitorResultRetention');
    const loaded = await entry!.load();
    expect(typeof loaded.init).toBe('function');
    expect(typeof loaded.shutdown).toBe('function');
  }, 60_000);

  it('declares its consumer so /ready waits for it', () => {
    const entry = WORKER_READINESS_MANIFEST.find(
      (e) => e.kind === 'consumers' && e.initializer === 'networkMonitorResultRetention',
    );
    expect(entry).toMatchObject({ consumers: ['networkMonitorResultRetention'], requiredWhen: 'redis' });
  });

  it('publishes a bounded retention metric name', () => {
    expect(RETENTION_JOB_NAMES).toContain('network_monitor_result_retention');
  });
});
