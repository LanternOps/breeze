// apps/api/src/services/workerRegistry.aiTranscriptRetention.test.ts
import { describe, expect, it } from 'vitest';
import { selectWorkers, WORKER_REGISTRY } from './workerRegistry';
import { RETENTION_JOB_NAMES } from './retentionMetrics';
import { WORKER_READINESS_MANIFEST } from '../jobs/workerReadinessManifest';
import { JOB_SCHEDULES, jobSchedule } from '../jobs/scheduleRegistry';

describe('aiTranscriptRetention registration (#4342 W4)', () => {
  it('holds an allocated daily slot, not a bare interval', () => {
    const slot = jobSchedule('ai-transcript-retention');
    expect(slot).toBe('8 15 * * *');
    expect(slot).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(Object.values(JOB_SCHEDULES).filter((p) => p === slot)).toHaveLength(1);
  });

  it('is a global-placement, lazily-loaded entry, so BREEZE_ROLE=worker runs it', async () => {
    const entry = WORKER_REGISTRY.find((e) => e.name === 'aiTranscriptRetention');
    expect(entry).toBeDefined();
    expect(entry?.placement).toBe('global');
    expect(selectWorkers('worker').map((e) => e.name)).toContain('aiTranscriptRetention');
    const loaded = await entry!.load();
    expect(typeof loaded.init).toBe('function');
    expect(typeof loaded.shutdown).toBe('function');
  }, 60_000);

  it('declares its consumer so /ready waits for it', () => {
    const entry = WORKER_READINESS_MANIFEST.find(
      (e) => e.kind === 'consumers' && e.initializer === 'aiTranscriptRetention',
    );
    expect(entry).toMatchObject({ consumers: ['aiTranscriptRetention'], requiredWhen: 'redis' });
  });

  it('publishes its retention metric name, keeping the list sorted', () => {
    expect(RETENTION_JOB_NAMES).toContain('ai_transcript_retention');
    expect([...RETENTION_JOB_NAMES]).toEqual([...RETENTION_JOB_NAMES].sort());
  });
});
