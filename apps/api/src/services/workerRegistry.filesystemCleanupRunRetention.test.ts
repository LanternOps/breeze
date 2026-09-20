// apps/api/src/services/workerRegistry.filesystemCleanupRunRetention.test.ts
import { describe, expect, it } from 'vitest';
import { WORKER_REGISTRY } from './workerRegistry';
import { RETENTION_JOB_NAMES } from './retentionMetrics';
import { WORKER_READINESS_MANIFEST } from '../jobs/workerReadinessManifest';
import { JOB_SCHEDULES, jobSchedule } from '../jobs/scheduleRegistry';

describe('filesystemCleanupRunRetention registration (Disk Cleanup v2 W03)', () => {
  it('holds an allocated daily slot, not a bare interval', () => {
    // Minute 3 keeps the daily = 3 (mod 5) lane; hour 22 previously held only
    // user-risk-scan at :57, so nothing else in the registry shares the minute.
    expect(jobSchedule('filesystem-cleanup-run-retention')).toBe('3 22 * * *');
    const patterns = Object.values(JOB_SCHEDULES);
    expect(patterns.filter((p) => p === '3 22 * * *')).toHaveLength(1);
  });

  it('is registered in WORKER_REGISTRY as a global-placement, lazily-loaded entry', async () => {
    const entry = WORKER_REGISTRY.find((e) => e.name === 'filesystemCleanupRunRetention');
    expect(entry).toBeDefined();
    expect(entry?.placement).toBe('global');
    const loaded = await entry!.load();
    expect(typeof loaded.init).toBe('function');
    expect(typeof loaded.shutdown).toBe('function');
  });

  it('declares its consumer so /ready waits for it', () => {
    const entry = WORKER_READINESS_MANIFEST.find(
      (e) => e.kind === 'consumers' && e.initializer === 'filesystemCleanupRunRetention',
    );
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      consumers: ['filesystemCleanupRunRetention'],
      requiredWhen: 'redis',
    });
  });

  it('publishes a bounded retention metric name', () => {
    expect(RETENTION_JOB_NAMES).toContain('filesystem_cleanup_run_retention');
  });
});
