import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./catalogService', () => {
  class CatalogServiceError extends Error {
    constructor(
      message: string,
      public status: 400 | 403 | 404 | 409 = 400,
      public code?: string,
    ) {
      super(message);
      this.name = 'CatalogServiceError';
    }
  }

  return {
    CatalogServiceError,
    escapeLikePattern: vi.fn((term: string) => term),
    createCatalogItem: vi.fn().mockResolvedValue({ id: 'cat-1', name: 'Managed service' }),
    updateCatalogItem: vi.fn().mockResolvedValue({ id: 'cat-1', name: 'Updated service' }),
    archiveCatalogItem: vi.fn().mockResolvedValue({ id: 'cat-1', isActive: false }),
    setOrgPriceOverride: vi.fn().mockResolvedValue({ catalogItemId: 'cat-1', orgId: 'org-1', unitPrice: '99.00' }),
    removeOrgPriceOverride: vi.fn().mockResolvedValue({ ok: true }),
    setBundleComponents: vi.fn().mockResolvedValue({ item: { id: 'bundle-1' }, components: [] }),
  };
});

import { registerCatalogTools } from './aiToolsCatalog';
import * as catalogService from './catalogService';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
import { CatalogServiceError } from './catalogService';

const auth: AuthContext = {
  user: { id: 'u-1', email: 'user@example.test', name: 'User', isPlatformAdmin: false },
  token: {
    sub: 'u-1',
    email: 'user@example.test',
    roleId: null,
    orgId: null,
    partnerId: 'p-1',
    scope: 'partner',
    type: 'access',
    mfa: true,
  },
  partnerId: 'p-1',
  orgId: null,
  scope: 'partner',
  accessibleOrgIds: ['org-1'],
  orgCondition: () => undefined,
  canAccessOrg: (orgId) => orgId === 'org-1',
};

const actor = { userId: 'u-1', partnerId: 'p-1', accessibleOrgIds: ['org-1'] };

function getTool(): AiTool {
  const map = new Map<string, AiTool>();
  registerCatalogTools(map);
  const t = map.get('manage_catalog');
  if (!t) throw new Error('manage_catalog not registered');
  return t;
}

describe('manage_catalog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create_item calls createCatalogItem with item payload and actor built from auth', async () => {
    const item = {
      itemType: 'service',
      name: 'Managed service',
      billingType: 'recurring',
      unitPrice: 99,
      unitOfMeasure: 'month',
      taxable: true,
      isBundle: false,
      attributes: {},
    };

    const out = await getTool().handler({ action: 'create_item', item }, auth);

    expect(catalogService.createCatalogItem).toHaveBeenCalledWith(item, actor);
    expect(JSON.parse(out)).toEqual({ id: 'cat-1', name: 'Managed service' });
  });

  it('update_item calls updateCatalogItem with catalogId, item patch, and actor', async () => {
    const item = { name: 'Updated service', unitPrice: 129 };

    const out = await getTool().handler(
      { action: 'update_item', catalogId: 'cat-1', item },
      auth,
    );

    expect(catalogService.updateCatalogItem).toHaveBeenCalledWith('cat-1', item, actor);
    expect(JSON.parse(out)).toEqual({ id: 'cat-1', name: 'Updated service' });
  });

  it('archive_item calls archiveCatalogItem with catalogId and actor', async () => {
    const out = await getTool().handler({ action: 'archive_item', catalogId: 'cat-1' }, auth);

    expect(catalogService.archiveCatalogItem).toHaveBeenCalledWith('cat-1', actor);
    expect(JSON.parse(out)).toEqual({ id: 'cat-1', isActive: false });
  });

  it('set_org_price calls setOrgPriceOverride with item id, org id, override payload, and actor', async () => {
    const override = { unitPrice: 99 };

    const out = await getTool().handler(
      { action: 'set_org_price', catalogId: 'cat-1', orgId: 'org-1', override },
      auth,
    );

    expect(catalogService.setOrgPriceOverride).toHaveBeenCalledWith(
      'cat-1',
      'org-1',
      override,
      actor,
    );
    expect(JSON.parse(out)).toEqual({ catalogItemId: 'cat-1', orgId: 'org-1', unitPrice: '99.00' });
  });

  it('remove_org_price calls removeOrgPriceOverride with item id, org id, and actor', async () => {
    const out = await getTool().handler(
      { action: 'remove_org_price', catalogId: 'cat-1', orgId: 'org-1' },
      auth,
    );

    expect(catalogService.removeOrgPriceOverride).toHaveBeenCalledWith('cat-1', 'org-1', actor);
    expect(JSON.parse(out)).toEqual({ ok: true });
  });

  it('set_bundle_components passes components through to setBundleComponents with actor', async () => {
    const components = [
      { componentItemId: 'cat-1', quantity: 2, showOnInvoice: true, revenueAllocation: 50 },
    ];

    const out = await getTool().handler(
      { action: 'set_bundle_components', catalogId: 'bundle-1', components },
      auth,
    );

    expect(catalogService.setBundleComponents).toHaveBeenCalledWith(
      'bundle-1',
      components,
      actor,
    );
    expect(JSON.parse(out)).toEqual({ item: { id: 'bundle-1' }, components: [] });
  });

  it('returns a JSON error when a service action rejects with CatalogServiceError', async () => {
    vi.mocked(catalogService.setOrgPriceOverride).mockRejectedValueOnce(
      new CatalogServiceError('Organization not accessible', 403, 'ORG_DENIED'),
    );

    const out = await getTool().handler(
      { action: 'set_org_price', catalogId: 'cat-1', orgId: 'org-2', override: { unitPrice: 99 } },
      auth,
    );

    expect(JSON.parse(out)).toEqual({ error: 'Organization not accessible', code: 'ORG_DENIED' });
  });

  it('re-throws non-service errors from service actions', async () => {
    const err = new Error('database unavailable');
    vi.mocked(catalogService.archiveCatalogItem).mockRejectedValueOnce(err);

    await expect(
      getTool().handler({ action: 'archive_item', catalogId: 'cat-1' }, auth),
    ).rejects.toBe(err);
  });

  it('unknown action returns a JSON error', async () => {
    const out = await getTool().handler({ action: 'nope' }, auth);

    expect(JSON.parse(out)).toHaveProperty('error');
  });

  it('update_item without catalogId returns a structured VALIDATION_ERROR instead of coercing "undefined" (#2362 sweep)', async () => {
    const out = await getTool().handler({ action: 'update_item', item: { name: 'x' } }, auth);

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('catalogId');
    expect(catalogService.updateCatalogItem).not.toHaveBeenCalled();
  });
});
