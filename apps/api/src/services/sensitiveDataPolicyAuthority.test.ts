import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({ rows: [] as unknown[][] }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const promise = Promise.resolve(dbState.rows.shift() ?? []);
      const chain: any = {
        from: vi.fn(() => chain),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: promise.then.bind(promise),
      };
      return chain;
    }),
  },
  runOutsideDbContext: vi.fn((callback: () => unknown) => callback()),
  withSystemDbAccessContext: vi.fn((callback: () => unknown) => callback()),
}));

vi.mock('./roleInheritance', () => ({
  getRoleGrantRows: vi.fn(async () => []),
}));

import type { AuthContext } from '../middleware/auth';
import {
  captureSensitiveDataAuthority,
  captureSystemSensitiveDataAuthority,
  decodeSensitiveDataAuthority,
  resolveSensitiveDataAuthorityInCurrentSystemContext,
  type PersistedSensitiveDataAuthority,
  type SensitiveDataPolicyOwner,
} from './sensitiveDataPolicyAuthority';
import { getRoleGrantRows } from './roleInheritance';

const ORG = '11111111-1111-1111-1111-111111111111';
const PARTNER = '22222222-2222-2222-2222-222222222222';
const SITE_A = '33333333-3333-3333-3333-333333333333';
const SITE_B = '44444444-4444-4444-4444-444444444444';

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    scope: 'organization',
    user: { id: '55555555-5555-5555-5555-555555555555', email: 'actor@example.test', name: 'Actor' },
    orgId: ORG, partnerId: PARTNER, partnerOrgAccess: null,
    accessibleOrgIds: [ORG], orgCondition: () => undefined,
    canAccessOrg: (id: string) => id === ORG,
    allowedSiteIds: [SITE_B, SITE_A, SITE_A],
    canAccessSite: (id: string | null) => id === SITE_A || id === SITE_B,
    ...overrides,
  } as unknown as AuthContext;
}

function row(owner: SensitiveDataPolicyOwner, overrides: Partial<PersistedSensitiveDataAuthority> = {}) {
  const captured = captureSensitiveDataAuthority(auth(), owner)!;
  return { ...owner, ...captured, ...overrides } as PersistedSensitiveDataAuthority;
}

describe('sensitive-data recurring execution authority', () => {
  it('normalizes and verifies an organization selected-site ceiling', () => {
    const decoded = decodeSensitiveDataAuthority(row({ orgId: ORG, partnerId: null }));
    expect(decoded).toMatchObject({
      kind: 'organization_restricted',
      siteIds: [SITE_A, SITE_B],
      principalKind: 'user',
    });
  });

  it('rejects a modified site ceiling and an owner-axis replay', () => {
    const original = row({ orgId: ORG, partnerId: null });
    expect(decodeSensitiveDataAuthority({ ...original, executionAuthoritySiteIds: [SITE_A] })).toBeNull();
    expect(decodeSensitiveDataAuthority({ ...original, orgId: null, partnerId: PARTNER })).toBeNull();
    expect(decodeSensitiveDataAuthority({
      ...original,
      executionAuthorityGeneration: '66666666-6666-4666-8666-666666666666',
    })).toBeNull();
  });

  it('mints a collision-safe generation and fingerprint on every approval', () => {
    const first = captureSensitiveDataAuthority(auth(), { orgId: ORG, partnerId: null })!;
    const second = captureSensitiveDataAuthority(auth(), { orgId: ORG, partnerId: null })!;
    expect(first.executionAuthorityGeneration).not.toBe(second.executionAuthorityGeneration);
    expect(first.executionAuthorityFingerprint).not.toBe(second.executionAuthorityFingerprint);
  });

  it('fails closed for malformed principal, fingerprint, and site-ceiling shapes', () => {
    const original = row({ orgId: ORG, partnerId: null });
    expect(decodeSensitiveDataAuthority({
      ...original,
      executionAuthorityPrincipalKind: 'system',
    })).toBeNull();
    expect(decodeSensitiveDataAuthority({
      ...original,
      executionAuthorityFingerprint: '0'.repeat(64),
    })).toBeNull();
    expect(decodeSensitiveDataAuthority({
      ...original,
      executionAuthoritySiteIds: [],
    })).toBeNull();

    const unrestricted = row(
      { orgId: ORG, partnerId: null },
      captureSensitiveDataAuthority(auth({ allowedSiteIds: undefined }), { orgId: ORG, partnerId: null })!,
    );
    expect(decodeSensitiveDataAuthority({
      ...unrestricted,
      executionAuthoritySiteIds: [SITE_A],
    })).toBeNull();
  });

  it('permits partner-wide capture only for full-partner and keeps HTTP system users creator-bound', () => {
    const owner = { orgId: null, partnerId: PARTNER } as const;
    expect(captureSensitiveDataAuthority(auth({ scope: 'partner', partnerOrgAccess: 'selected' }), owner)).toBeNull();
    expect(captureSensitiveDataAuthority(auth({ scope: 'partner', partnerOrgAccess: 'all' }), owner))
      .toMatchObject({ executionAuthorityKind: 'partner_unrestricted', executionAuthorityPrincipalKind: 'user' });
    expect(captureSensitiveDataAuthority(auth({ scope: 'system' }), owner))
      .toMatchObject({
        executionAuthorityKind: 'partner_unrestricted',
        executionAuthorityPrincipalKind: 'user',
        executionAuthorityUserId: '55555555-5555-5555-5555-555555555555',
      });
    expect(captureSystemSensitiveDataAuthority(owner))
      .toMatchObject({ executionAuthorityKind: 'partner_unrestricted', executionAuthorityPrincipalKind: 'system' });
  });
});

describe('live devices:execute check uses inherited role grants (#11702)', () => {
  const ROLE = '77777777-7777-4777-8777-777777777777';
  const OTHER_PARTNER = '88888888-8888-4888-8888-888888888888';
  const partnerRow = () => row(
    { orgId: null, partnerId: PARTNER },
    captureSensitiveDataAuthority(auth({ scope: 'partner', partnerOrgAccess: 'all' }), { orgId: null, partnerId: PARTNER })!,
  );
  const grant = (overrides: Record<string, unknown> = {}) => ({
    roleId: ROLE, resource: 'devices', action: 'execute',
    roleScope: 'partner', roleIsSystem: false, roleOrgId: null, rolePartnerId: PARTNER,
    ...overrides,
  });
  const queueMembership = () => dbState.rows.push(
    [{ status: 'active', isPlatformAdmin: false, partnerId: PARTNER }],
    [{ roleId: ROLE, orgAccess: 'all' }],
  );

  beforeEach(() => {
    vi.clearAllMocks();
    dbState.rows.length = 0;
  });

  it('honours devices:execute held only through inheritance', async () => {
    queueMembership();
    vi.mocked(getRoleGrantRows).mockResolvedValueOnce([grant()]);
    await expect(resolveSensitiveDataAuthorityInCurrentSystemContext(partnerRow())).resolves.not.toBeNull();
    expect(getRoleGrantRows).toHaveBeenCalledWith([ROLE]);
  });

  it('honours an inherited wildcard grant', async () => {
    queueMembership();
    vi.mocked(getRoleGrantRows).mockResolvedValueOnce([grant({ resource: '*', action: '*' })]);
    await expect(resolveSensitiveDataAuthorityInCurrentSystemContext(partnerRow())).resolves.not.toBeNull();
  });

  it('refuses when the resolved grants lack devices:execute', async () => {
    queueMembership();
    vi.mocked(getRoleGrantRows).mockResolvedValueOnce([grant({ action: 'read' })]);
    await expect(resolveSensitiveDataAuthorityInCurrentSystemContext(partnerRow())).resolves.toBeNull();
  });

  it('refuses when the base role is owned by another partner', async () => {
    queueMembership();
    vi.mocked(getRoleGrantRows).mockResolvedValueOnce([grant({ rolePartnerId: OTHER_PARTNER })]);
    await expect(resolveSensitiveDataAuthorityInCurrentSystemContext(partnerRow())).resolves.toBeNull();
  });

  it('refuses a base role of the wrong scope', async () => {
    queueMembership();
    vi.mocked(getRoleGrantRows).mockResolvedValueOnce([grant({ roleScope: 'organization', roleOrgId: ORG })]);
    await expect(resolveSensitiveDataAuthorityInCurrentSystemContext(partnerRow())).resolves.toBeNull();
  });
});
