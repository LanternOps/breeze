// apps/api/src/services/workerRegistry.webhookDeliveryRetention.test.ts
import { describe, expect, it } from 'vitest';
import { selectWorkers, WORKER_REGISTRY } from './workerRegistry';
import { RETENTION_JOB_NAMES } from './retentionMetrics';
import { WORKER_READINESS_MANIFEST } from '../jobs/workerReadinessManifest';
import { JOB_SCHEDULES, jobSchedule } from '../jobs/scheduleRegistry';

describe('webhookDeliveryRetention registration (#9128)', () => {
  it('holds an allocated daily slot, not a bare interval', () => {
    const slot = jobSchedule('webhook-delivery-retention');
    expect(slot).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(Object.values(JOB_SCHEDULES).filter((p) => p === slot)).toHaveLength(1);
  });

  it('is a global-placement, lazily-loaded entry, so BREEZE_ROLE=worker runs it', async () => {
    const entry = WORKER_REGISTRY.find((e) => e.name === 'webhookDeliveryRetention');
    expect(entry).toBeDefined();
    expect(entry?.placement).toBe('global');
    expect(selectWorkers('worker').map((e) => e.name)).toContain('webhookDeliveryRetention');
    const loaded = await entry!.load();
    expect(typeof loaded.init).toBe('function');
    expect(typeof loaded.shutdown).toBe('function');
  }, 60_000);

  it('declares its consumer so /ready waits for it', () => {
    const entry = WORKER_READINESS_MANIFEST.find(
      (e) => e.kind === 'consumers' && e.initializer === 'webhookDeliveryRetention',
    );
    expect(entry).toMatchObject({ consumers: ['webhookDeliveryRetention'], requiredWhen: 'redis' });
  });

  it('publishes a bounded retention metric name', () => {
    expect(RETENTION_JOB_NAMES).toContain('webhook_delivery_retention');
  });
});
