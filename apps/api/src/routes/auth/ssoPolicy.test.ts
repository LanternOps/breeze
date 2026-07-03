import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  ssoProviders: {
    id: 'ssoProviders.id',
    orgId: 'ssoProviders.orgId',
    partnerId: 'ssoProviders.partnerId',
    status: 'ssoProviders.status',
    enforceSSO: 'ssoProviders.enforceSSO',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((left, right) => ({ op: 'eq', left, right })),
  and: vi.fn((...conditions) => ({ op: 'and', conditions })),
}));

import { db } from '../../db';
import {
  assertPasswordAuthAllowedBySso,
  isPasswordAuthDisabledBySso,
  SsoPasswordAuthRequiredError,
} from './ssoPolicy';

function mockProviderRows(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>);
}

describe('SSO password auth policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables password auth for organization contexts with an active enforcing provider', async () => {
    mockProviderRows([{ id: 'provider-1' }]);

    await expect(isPasswordAuthDisabledBySso({ scope: 'organization', orgId: 'org-1', partnerId: null })).resolves.toBe(true);
  });

  it('allows password auth when no active enforcing provider exists', async () => {
    mockProviderRows([]);

    await expect(isPasswordAuthDisabledBySso({ scope: 'organization', orgId: 'org-1', partnerId: null })).resolves.toBe(false);
  });

  it('does not apply customer-org SSO policy to partner or system contexts', async () => {
    await expect(isPasswordAuthDisabledBySso({ scope: 'partner', orgId: null, partnerId: null })).resolves.toBe(false);
    await expect(isPasswordAuthDisabledBySso({ scope: 'system', orgId: null, partnerId: null })).resolves.toBe(false);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('throws a typed error when password auth is disabled by SSO', async () => {
    mockProviderRows([{ id: 'provider-1' }]);

    await expect(assertPasswordAuthAllowedBySso({ scope: 'organization', orgId: 'org-1', partnerId: null }))
      .rejects.toBeInstanceOf(SsoPasswordAuthRequiredError);
  });
});

describe('isPasswordAuthDisabledBySso — partner scope (#2183)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('true for partner-scope context when an active enforceSSO partner provider exists', async () => {
    mockProviderRows([{ id: 'provider-1' }]);

    await expect(
      isPasswordAuthDisabledBySso({ scope: 'partner', orgId: null, partnerId: 'partner-1' })
    ).resolves.toBe(true);
    expect(db.select).toHaveBeenCalled();
  });

  it('false when the partner provider is testing (break-glass preserved)', async () => {
    // The query only matches status='active' rows, so a 'testing' provider
    // never surfaces here — this is what enforces the break-glass invariant.
    mockProviderRows([]);

    await expect(
      isPasswordAuthDisabledBySso({ scope: 'partner', orgId: null, partnerId: 'partner-1' })
    ).resolves.toBe(false);
  });

  it('false for partner scope with no partner provider', async () => {
    mockProviderRows([]);

    await expect(
      isPasswordAuthDisabledBySso({ scope: 'partner', orgId: null, partnerId: 'partner-1' })
    ).resolves.toBe(false);
  });

  it('org behavior unchanged', async () => {
    mockProviderRows([{ id: 'provider-1' }]);

    await expect(
      isPasswordAuthDisabledBySso({ scope: 'organization', orgId: 'org-1', partnerId: null })
    ).resolves.toBe(true);

    vi.clearAllMocks();
    mockProviderRows([]);

    // Org-scope users are never affected by a partner provider's enforceSSO.
    await expect(
      isPasswordAuthDisabledBySso({ scope: 'organization', orgId: 'org-1', partnerId: 'partner-1' })
    ).resolves.toBe(false);
  });
});
