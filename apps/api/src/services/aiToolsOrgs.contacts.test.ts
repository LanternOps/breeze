import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./auditEvents', () => ({ writeAuditEvent: vi.fn(), requestLikeFromSnapshot: vi.fn() }));
vi.mock('./tenantLifecycle', () => ({}));
vi.mock('./tenantOffboarding', () => ({}));
vi.mock('./contacts/crud', async (orig) => ({
  ...await orig<typeof import('./contacts/crud')>(),
  listContacts: vi.fn(), countContacts: vi.fn(),
}));

import { db } from '../db';
import { and, eq, isNull } from 'drizzle-orm';
import { organizations } from '../db/schema';
import { listContacts, countContacts } from './contacts/crud';
import { registerOrgTools } from './aiToolsOrgs';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SITE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tools = new Map<string, AiTool>();
registerOrgTools(tools);
const auth = (over: Record<string, unknown> = {}) => ({
  scope: 'partner', accessibleOrgIds: [ORG], canAccessOrg: (id: string) => id === ORG,
  ...over,
}) as unknown as AuthContext;
const run = async (input: Record<string, unknown>, over = {}) =>
  JSON.parse(await tools.get('list_org_contacts')!.handler(input, auth(over)));
const limitQuery = vi.fn();
const where = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  limitQuery.mockResolvedValue([{ id: ORG }]);
  where.mockReturnValue({ limit: limitQuery });
  vi.mocked(db.select).mockReturnValue({ from: vi.fn(() => ({ where })) } as never);
  vi.mocked(listContacts).mockResolvedValue([]);
  vi.mocked(countContacts).mockResolvedValue(0);
});

describe('list_org_contacts', () => {
  it('is a Tier-1 accounts read', () => {
    expect(tools.get('list_org_contacts')).toMatchObject({ tier: 1, domain: 'accounts', deviceArgs: [] });
  });
  it.each([{}, { orgId: 'invalid' }])('requires a valid orgId: %j', async (input) => {
    expect((await run(input)).error).toMatch(/orgId/);
    expect(db.select).not.toHaveBeenCalled();
    expect(listContacts).not.toHaveBeenCalled();
  });
  it.each(['partner', 'organization'])('denies cross-org access for %s', async (scope) => {
    expect((await run({ orgId: OTHER }, { scope })).error).toMatch(/organization/i);
    expect(db.select).not.toHaveBeenCalled();
    expect(listContacts).not.toHaveBeenCalled();
    expect(countContacts).not.toHaveBeenCalled();
  });
  it('allows system scope without an org allowlist', async () => {
    await run({ orgId: OTHER }, { scope: 'system', canAccessOrg: () => false });
    expect(listContacts).toHaveBeenCalledWith(db, OTHER, {}, { limit: 25, offset: 0 });
  });
  it('denies explicit sites outside the allowlist', async () => {
    expect(await run({ orgId: ORG, siteId: SITE }, { allowedSiteIds: [OTHER] }))
      .toEqual({ error: 'Access to this site denied' });
    expect(listContacts).not.toHaveBeenCalled();
  });
  it('honors the route canAccessSite gate', async () => {
    expect((await run({ orgId: ORG, siteId: SITE }, { canAccessSite: () => false })).error)
      .toBe('Access to this site denied');
  });
  it('forwards site restrictions and role to both queries', async () => {
    await run({ orgId: ORG, siteId: SITE, role: 'billing', offset: 10 }, { allowedSiteIds: [SITE] });
    const filters = { siteId: SITE, role: 'billing', allowedSiteIds: [SITE] };
    expect(listContacts).toHaveBeenCalledWith(db, ORG, filters, { limit: 25, offset: 10 });
    expect(countContacts).toHaveBeenCalledWith(db, ORG, filters);
  });
  it('maps none to the service null site filter', async () => {
    await run({ orgId: ORG, siteId: 'none' });
    expect(countContacts).toHaveBeenCalledWith(db, ORG, { siteId: null });
  });
  it('short-circuits empty site scope', async () => {
    expect(await run({ orgId: ORG }, { allowedSiteIds: [] }))
      .toEqual({ contacts: [], total: 0, limit: 25, offset: 0 });
    expect(db.select).not.toHaveBeenCalled();
    expect(listContacts).not.toHaveBeenCalled();
    expect(countContacts).not.toHaveBeenCalled();
  });
  it('rejects invalid site and role filters', async () => {
    for (const input of [{ siteId: 'bad' }, { role: '' }, { role: 'x'.repeat(65) }]) {
      expect((await run({ orgId: ORG, ...input })).error).toBeTruthy();
    }
    expect(listContacts).not.toHaveBeenCalled();
  });
  it('checks the org exists and is not deleted', async () => {
    limitQuery.mockResolvedValue([]);
    expect((await run({ orgId: ORG })).error).toBe('Organization not found');
    expect(where).toHaveBeenCalledWith(and(eq(organizations.id, ORG), isNull(organizations.deletedAt)));
    expect(listContacts).not.toHaveBeenCalled();
  });
  it('returns the page, clamps limit and omits internal notes', async () => {
    vi.mocked(listContacts).mockResolvedValue([{ id: OTHER, name: 'Contact', notes: 'private' }] as never);
    vi.mocked(countContacts).mockResolvedValue(1);
    expect(await run({ orgId: ORG, limit: 999 })).toEqual({
      contacts: [{ id: OTHER, name: 'Contact' }], total: 1, limit: 100, offset: 0,
    });
    expect(listContacts).toHaveBeenCalledWith(db, ORG, {}, { limit: 100, offset: 0 });
  });
  it('does not expose service errors', async () => {
    vi.mocked(listContacts).mockRejectedValueOnce(new Error('private database detail'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await run({ orgId: ORG })).toEqual({ error: 'Operation failed. Check server logs for details.' });
    } finally { log.mockRestore(); }
  });
});
