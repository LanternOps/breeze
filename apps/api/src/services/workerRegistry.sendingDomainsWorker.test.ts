// apps/api/src/services/workerRegistry.sendingDomainsWorker.test.ts
import { describe, expect, it } from 'vitest';
import { WORKER_REGISTRY } from './workerRegistry';
import { WORKER_READINESS_MANIFEST } from '../jobs/workerReadinessManifest';

describe('sendingDomainsWorker registration (W03, partner sending domains)', () => {
  it('is registered in WORKER_REGISTRY as a global-placement, lazily-loaded entry', async () => {
    const entry = WORKER_REGISTRY.find((e) => e.name === 'sendingDomainsWorker');
    expect(entry).toBeDefined();
    expect(entry?.placement).toBe('global');
    const loaded = await entry!.load();
    expect(typeof loaded.init).toBe('function');
    expect(typeof loaded.shutdown).toBe('function');
  });

  it('is declared CONDITIONALLY, so an unconfigured instance is never pinned not-ready', () => {
    const entry = WORKER_READINESS_MANIFEST.find(
      (e) => e.kind === 'consumers' && e.initializer === 'sendingDomainsWorker',
    );
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      consumers: ['sendingDomainsWorker'],
      requiredWhen: 'sending_domains_configured',
    });
  });
});
