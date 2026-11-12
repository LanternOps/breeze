// apps/api/src/services/workerRegistry.historyRetention.test.ts
import { describe, expect, it } from 'vitest';
import { selectWorkers, WORKER_REGISTRY } from './workerRegistry';
import { RETENTION_JOB_NAMES } from './retentionMetrics';
import { WORKER_READINESS_MANIFEST } from '../jobs/workerReadinessManifest';
import { JOB_SCHEDULES, jobSchedule } from '../jobs/scheduleRegistry';

describe('historyRetention registration (#4342 W5)', () => {
  it('holds an allocated daily slot, not a bare interval', () => {
    const slot = jobSchedule('history-retention');
    expect(slot).toBe('8 16 * * *');
    expect(slot).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(Object.values(JOB_SCHEDULES).filter((p) => p === slot)).toHaveLength(1);
  });

  it('is a global-placement, lazily-loaded entry, so BREEZE_ROLE=worker runs it', async () => {
    const entry = WORKER_REGISTRY.find((e) => e.name === 'historyRetention');
    expect(entry).toBeDefined();
    expect(entry?.placement).toBe('global');
    expect(selectWorkers('worker').map((e) => e.name)).toContain('historyRetention');
    const loaded = await entry!.load();
    expect(typeof loaded.init).toBe('function');
    expect(typeof loaded.shutdown).toBe('function');
  }, 60_000);

  it('declares its consumer so /ready waits for it', () => {
    const entry = WORKER_READINESS_MANIFEST.find(
      (e) => e.kind === 'consumers' && e.initializer === 'historyRetention',
    );
    expect(entry).toMatchObject({ consumers: ['historyRetention'], requiredWhen: 'redis' });
  });

  it('publishes a bounded retention metric name per target', () => {
    for (const name of [
      'ai_agent_run_retention',
      'patch_job_result_retention',
      'security_posture_snapshot_retention',
      'cis_baseline_result_retention',
      'automation_run_retention',
      'report_run_retention',
      'user_notification_read_retention',
      'user_notification_retention',
      'remote_session_retention',
      'support_session_retention',
      'auth_session_retention',
      'network_change_event_retention',
    ]) {
      expect(RETENTION_JOB_NAMES).toContain(name);
    }
  });
});
