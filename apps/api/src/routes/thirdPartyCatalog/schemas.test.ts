import { describe, expect, it } from 'vitest';

import { upsertCatalogSchema } from './schemas';

describe('third-party catalog schemas', () => {
  it('accepts osvEcosystem on create', () => {
    const parsed = upsertCatalogSchema.parse({
      packageId: 'Example.Package',
      vendor: 'Example',
      friendlyName: 'Example Package',
      osvEcosystem: 'test-ecosystem',
    });

    expect(parsed.osvEcosystem).toBe('test-ecosystem');
  });

  it('accepts osvEcosystem on update', () => {
    const parsed = upsertCatalogSchema.partial().parse({
      osvEcosystem: 'test-ecosystem',
    });

    expect(parsed.osvEcosystem).toBe('test-ecosystem');
  });
});
