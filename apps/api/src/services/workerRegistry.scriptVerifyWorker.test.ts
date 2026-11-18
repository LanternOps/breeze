// apps/api/src/services/workerRegistry.scriptVerifyWorker.test.ts
import { describe, expect, it } from 'vitest';
import { WORKER_REGISTRY } from './workerRegistry';
import { WORKER_READINESS_MANIFEST } from '../jobs/workerReadinessManifest';

describe('scriptVerifyWorker registration (W03, #5612)', () => {
  it('is registered in WORKER_REGISTRY as a global, lazily-loaded entry', async () => {
    const entry = WORKER_REGISTRY.find((e) => e.name === 'scriptVerifyWorker');
    expect(entry).toBeDefined();
    // workerEntrypointClosure.contract.test.ts proves the closure no longer
    // reaches agentWs / agentCommandAwait (#4142 W2) — 'socket-owner' fails there.
    expect(entry?.placement).toBe('global');
    const loaded = await entry!.load();
    expect(typeof loaded.init).toBe('function');
    expect(typeof loaded.shutdown).toBe('function');
    // The load() pulls a large service graph — slow to compile.
  }, 30_000);

  it('is registered in WORKER_READINESS_MANIFEST under the same name, Redis-required', () => {
    const entry = WORKER_READINESS_MANIFEST.find(
      (e) => e.kind === 'consumers' && e.initializer === 'scriptVerifyWorker',
    );
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ consumers: ['scriptVerifyWorker'], requiredWhen: 'redis' });
  });
});
