// apps/api/src/services/workerRegistry.scriptReviewWorker.test.ts
import { describe, expect, it } from 'vitest';
import { WORKER_REGISTRY } from './workerRegistry';
import { WORKER_READINESS_MANIFEST } from '../jobs/workerReadinessManifest';

describe('scriptReviewWorker registration (W02, #5612)', () => {
  it('is registered in WORKER_REGISTRY as a global-placement, lazily-loaded entry', async () => {
    const entry = WORKER_REGISTRY.find((e) => e.name === 'scriptReviewWorker');
    expect(entry).toBeDefined();
    expect(entry?.placement).toBe('global');
    const loaded = await entry!.load();
    expect(typeof loaded.init).toBe('function');
    expect(typeof loaded.shutdown).toBe('function');
  });

  it('is registered in WORKER_READINESS_MANIFEST under the same name, Redis-required', () => {
    const entry = WORKER_READINESS_MANIFEST.find(
      (e) => e.kind === 'consumers' && e.initializer === 'scriptReviewWorker',
    );
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ consumers: ['scriptReviewWorker'], requiredWhen: 'redis' });
  });
});
