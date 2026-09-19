import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../permissions';
vi.mock('../../db', () => ({ db: {}, withDbTransaction: vi.fn() }));
vi.mock('../auditService', () => ({ createAuditLog: vi.fn() }));
import {
  assertTopologyTemplateAccess,
  createTopologyTemplateSchema,
} from './templateLibrary';
const org = '00000000-0000-4000-8000-000000000001';
const partner = '00000000-0000-4000-8000-000000000002';
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
    scope: 'organization',
    orgId: org,
    partnerId: partner,
    canAccessOrg: (id) => id === org,
    ...extra,
  } as AuthContext;
}
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
});
