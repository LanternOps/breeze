import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../permissions';
const { mfaRef, dbMocks } = vi.hoisted(() => ({
  mfaRef: { current: true },
  dbMocks: { select: vi.fn(), update: vi.fn() },
}));
vi.mock('../../db', () => ({ db: dbMocks, withDbTransaction: vi.fn() }));
vi.mock('../auditService', () => ({ createAuditLog: vi.fn() }));
vi.mock('../../middleware/auth', () => ({
  hasSatisfiedMfa: vi.fn(() => mfaRef.current),
}));
import {
  assertTopologyTemplateAccess,
  createTopologyTemplateSchema,
  updateTopologyTemplate,
} from './templateLibrary';
const org = '00000000-0000-4000-8000-000000000001';
const partner = '00000000-0000-4000-8000-000000000002';
const templateId = '00000000-0000-4000-8000-000000000003';
const permissions = {
  permissions: [
    { resource: 'topology', action: 'read' },
    { resource: 'topology', action: 'write' },
    { resource: 'devices', action: 'read' },
    { resource: 'devices', action: 'write' },
  ],
  scope: 'organization',
  orgId: org,
  partnerId: partner,
} as UserPermissions;
function auth(extra: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'user-1', email: 'operator@example.test' },
    scope: 'organization',
    orgId: org,
    partnerId: partner,
    canAccessOrg: (id) => id === org,
    ...extra,
  } as AuthContext;
}
beforeEach(() => {
  mfaRef.current = true;
  dbMocks.select.mockReset();
  dbMocks.update.mockReset();
});
describe('template library ownership authority', () => {
  it('permits unrestricted own-org reads and writes', () => {
    for (const write of [false, true])
      expect(() =>
        assertTopologyTemplateAccess(
          auth(),
          permissions,
          { orgId: org, partnerId: null },
          write,
        ),
      ).not.toThrow();
  });
  it.each([{ allowedSiteIds: [] }, { allowedSiteIds: [org] }])(
    'denies site ceiling $allowedSiteIds library access',
    ({ allowedSiteIds }) => {
      for (const write of [false, true])
        expect(() =>
          assertTopologyTemplateAccess(
            auth({ allowedSiteIds }),
            permissions,
            { orgId: org, partnerId: null },
            write,
          ),
        ).toThrow();
    },
  );
  it('denies foreign org even when its row was visible', () =>
    expect(() =>
      assertTopologyTemplateAccess(
        auth(),
        permissions,
        { orgId: partner, partnerId: null },
        true,
      ),
    ).toThrow());
  it('denies own partner library to org users', () =>
    expect(() =>
      assertTopologyTemplateAccess(
        auth(),
        permissions,
        { orgId: null, partnerId: partner },
        false,
      ),
    ).toThrow());
  it('selected partner access permits read but cannot administer whole partner', () => {
    const a = auth({ scope: 'partner', partnerOrgAccess: 'selected' });
    expect(() =>
      assertTopologyTemplateAccess(
        a,
        permissions,
        { orgId: null, partnerId: partner },
        false,
      ),
    ).not.toThrow();
    expect(() =>
      assertTopologyTemplateAccess(
        a,
        permissions,
        { orgId: null, partnerId: partner },
        true,
      ),
    ).toThrow();
  });
  it('full partner may edit only its own library', () => {
    const a = auth({ scope: 'partner', partnerOrgAccess: 'all' });
    expect(() =>
      assertTopologyTemplateAccess(
        a,
        permissions,
        { orgId: null, partnerId: partner },
        true,
      ),
    ).not.toThrow();
    expect(() =>
      assertTopologyTemplateAccess(
        a,
        permissions,
        { orgId: null, partnerId: org },
        true,
      ),
    ).toThrow();
  });
  it('does not accept caller-supplied partner or scope authority', () => {
    expect(
      createTopologyTemplateSchema.safeParse({
        ownerScope: 'partner',
        partnerId: partner,
        key: 'key',
        name: 'Name',
      }).success,
    ).toBe(false);
  });
  it('requires both topology and device grants', () => {
    for (const resource of ['topology', 'devices'])
      expect(() =>
        assertTopologyTemplateAccess(
          auth(),
          {
            ...permissions,
            permissions: permissions.permissions.filter(
              (p) => p.resource !== resource,
            ),
          },
          { orgId: org, partnerId: null },
          true,
        ),
      ).toThrow();
  });
  it('permits an unsatisfied-MFA session to read', () => {
    mfaRef.current = false;
    expect(() =>
      assertTopologyTemplateAccess(
        auth(),
        permissions,
        { orgId: org, partnerId: null },
        false,
      ),
    ).not.toThrow();
  });
  it('denies a write from a session that has not satisfied MFA', () => {
    mfaRef.current = false;
    expect(() =>
      assertTopologyTemplateAccess(
        auth(),
        permissions,
        { orgId: org, partnerId: null },
        true,
      ),
    ).toThrow();
  });
  it('denies a write from an AI-agent principal regardless of MFA', () => {
    expect(() =>
      assertTopologyTemplateAccess(
        auth({ principal: { kind: 'ai_agent' } as never }),
        permissions,
        { orgId: org, partnerId: null },
        true,
      ),
    ).toThrow();
  });
});
describe('template lifecycle transitions', () => {
  function mockTemplateRow(overrides: Record<string, unknown> = {}) {
    const row = {
      id: templateId,
      orgId: org,
      partnerId: null,
      revision: 1n,
      lifecycle: 'active',
      ...overrides,
    };
    dbMocks.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([row]) })),
      })),
    });
    return row;
  }
  function mockUpdateReturns(row: Record<string, unknown>) {
    dbMocks.update.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([row]),
        })),
      })),
    });
  }
  it('refuses to move a revoked template back to active', async () => {
    mockTemplateRow({ lifecycle: 'revoked' });
    mockUpdateReturns({ id: templateId, revision: 2n, lifecycle: 'active' });
    await expect(
      updateTopologyTemplate(auth(), permissions, templateId, {
        expectedRevision: '1',
        lifecycle: 'active',
      }),
    ).rejects.toMatchObject({ code: 'template_revocation_terminal' });
    expect(dbMocks.update).not.toHaveBeenCalled();
  });
  it('still allows editing a revoked template without touching lifecycle', async () => {
    mockTemplateRow({ lifecycle: 'revoked' });
    mockUpdateReturns({
      id: templateId,
      revision: 2n,
      lifecycle: 'revoked',
      name: 'New name',
    });
    await expect(
      updateTopologyTemplate(auth(), permissions, templateId, {
        expectedRevision: '1',
        name: 'New name',
      }),
    ).resolves.toMatchObject({ lifecycle: 'revoked' });
  });
});
