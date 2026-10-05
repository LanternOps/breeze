import { describe, expect, it } from 'vitest';
import { WORKER_REGISTRY } from './workerRegistry';
import { WORKER_READINESS_MANIFEST } from '../jobs/workerReadinessManifest';

describe('autopay reminder worker registration', () => {
  it('has exactly one global worker with lifecycle exports', async () => {
    const entries = WORKER_REGISTRY.filter(row => row.name === 'autopayWorker');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.placement).toBe('global');
    const loaded = await entries[0]!.load();
    expect(typeof loaded.init).toBe('function');
    expect(typeof loaded.shutdown).toBe('function');
  });
  it('is available whenever Redis is available', () => {
    expect(WORKER_READINESS_MANIFEST.find(entry =>
      entry.kind === 'consumers' && entry.initializer === 'autopayWorker',
    )).toMatchObject({ consumers: ['autopayWorker'], requiredWhen: 'redis' });
  });
});
