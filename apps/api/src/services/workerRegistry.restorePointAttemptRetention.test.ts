// apps/api/src/services/workerRegistry.restorePointAttemptRetention.test.ts
import { describe, expect, it } from 'vitest';
import { selectWorkers, WORKER_REGISTRY } from './workerRegistry';
import { RETENTION_JOB_NAMES } from './retentionMetrics';
import { WORKER_READINESS_MANIFEST } from '../jobs/workerReadinessManifest';
import { JOB_SCHEDULES, jobSchedule } from '../jobs/scheduleRegistry';

describe('restorePointAttemptRetention registration (#8581)', () => {
  it('holds an allocated daily slot, not a bare interval', () => {
    expect(jobSchedule('restore-point-attempt-retention')).toBe('8 22 * * *');
    expect(Object.values(JOB_SCHEDULES).filter((p) => p === '8 22 * * *')).toHaveLength(1);
  });

  it('is a global-placement, lazily-loaded entry, so BREEZE_ROLE=worker runs it', async () => {
    const entry = WORKER_REGISTRY.find((e) => e.name === 'restorePointAttemptRetention');
    expect(entry).toBeDefined();
    expect(entry?.placement).toBe('global');
    expect(selectWorkers('worker').map((e) => e.name)).toContain('restorePointAttemptRetention');
    const loaded = await entry!.load();
    expect(typeof loaded.init).toBe('function');
    expect(typeof loaded.shutdown).toBe('function');
    // The first dynamic import of the job's module graph is slow on a loaded host.
  }, 60_000);

  it('declares its consumer so /ready waits for it', () => {
    const entry = WORKER_READINESS_MANIFEST.find(
      (e) => e.kind === 'consumers' && e.initializer === 'restorePointAttemptRetention',
    );
    expect(entry).toMatchObject({
      consumers: ['restorePointAttemptRetention'],
      requiredWhen: 'redis',
    });
  });

  it('publishes a bounded retention metric name', () => {
    expect(RETENTION_JOB_NAMES).toContain('restore_point_attempt_retention');
  });
});
