/**
 * The created-contacts routes (#8313 W4b; spec 2026-10-19 §5.7, §5.13): who
 * may list and remove, the 409 while a run is active, and the audit trail of
 * a removal (one live `contact.delete` row per contact, one partner row).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  auth: { value: null as Record<string, unknown> | null },
  getSource: vi.fn(),
  lockSource: vi.fn(),
  activeRunOf: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  routeAudit: vi.fn(),
  contactAudit: vi.fn(),
  log: [] as string[],
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!mocks.auth.value) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', mocks.auth.value);
    return next();
  },
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!scopes.includes(auth.scope)) return c.json({ error: 'Insufficient scope' }, 403);
    return next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  withAuthDbAccessContext: async (_auth: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: mocks.routeAudit }));
vi.mock('../../services/contacts/audit', () => ({ writeContactAudit: mocks.contactAudit }));
vi.mock('../../services/ticketImport/sourceStore', async (orig) => ({
  ...(await orig<typeof import('../../services/ticketImport/sourceStore')>()),
  getSource: mocks.getSource,
  lockSource: mocks.lockSource,
  activeRunOf: mocks.activeRunOf,
}));
vi.mock('../../services/ticketImport/createdContacts', () => ({
  listCreatedContacts: mocks.list,
  removeCreatedContacts: mocks.remove,
}));

import { TicketImportError } from '../../services/ticketImport/importErrors';
import { ticketImportRoutes } from './index';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const SOURCE = '55555555-5555-4555-8555-555555555555';
const RUN = '66666666-6666-4666-8666-666666666666';
const ORG = '88888888-8888-4888-8888-888888888888';
const CONTACT_A = '99999999-9999-4999-8999-999999999991';
const CONTACT_B = '99999999-9999-4999-8999-999999999992';

function signIn(overrides: Record<string, unknown> = {}) {
  mocks.auth.value = {
    scope: 'partner',
    partnerId: PARTNER,
    partnerOrgAccess: 'all',
    user: { id: USER, email: 'admin@example.test' },
    ...overrides,
  };
}

function send(method: string, path: string) {
  const app = new Hono();
  app.route('/ticket-imports', ticketImportRoutes);
  return app.request(`/ticket-imports${path}`, { method, headers: { 'content-type': 'application/json' } });
}

const removal = {
  removed: [
    { contactId: CONTACT_A, orgId: ORG, name: 'Maya', isPrimary: false },
    { contactId: CONTACT_B, orgId: ORG, name: null, isPrimary: false },
  ],
  skipped: 3,
  skippedBy: { portal_login: 1, role: 0, other_link: 1, edited: 2 },
  remaining: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.log.length = 0;
  signIn();
  mocks.getSource.mockResolvedValue({ id: SOURCE, partnerId: PARTNER });
  mocks.lockSource.mockImplementation(async () => { mocks.log.push('lock'); return { id: SOURCE }; });
  mocks.activeRunOf.mockImplementation(async () => { mocks.log.push('active?'); return null; });
  mocks.list.mockResolvedValue({ contacts: [{ contactId: CONTACT_A, keptBecause: [] }], next: null });
  mocks.remove.mockImplementation(async () => { mocks.log.push('remove'); return removal; });
});

describe('GET /ticket-imports/sources/:id/created-contacts', () => {
  it('lists the source\'s created contacts for a partner-wide admin, with the page cursor', async () => {
    const res = await send('GET', `/sources/${SOURCE}/created-contacts?limit=50&after=${CONTACT_A}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ contactId: CONTACT_A, keptBecause: [] }], next: null });
    expect(mocks.getSource).toHaveBeenCalledWith(PARTNER, SOURCE);
    expect(mocks.list).toHaveBeenCalledWith(SOURCE, { limit: 50, after: CONTACT_A });
  });

  it('answers 404 for a source of another partner (or none), and lists nothing', async () => {
    mocks.getSource.mockResolvedValue(null);
    const res = await send('GET', `/sources/${SOURCE}/created-contacts`);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('TICKET_IMPORT_SOURCE_NOT_FOUND');
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('refuses an admin without partner-wide access, and an org-scope caller', async () => {
    signIn({ partnerOrgAccess: 'selected' });
    expect((await send('GET', `/sources/${SOURCE}/created-contacts`)).status).toBe(403);
    signIn({ scope: 'organization' });
    expect((await send('GET', `/sources/${SOURCE}/created-contacts`)).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe('POST /ticket-imports/sources/:id/created-contacts/remove', () => {
  it('locks the source, checks for an active run, then removes; audits each contact and the set', async () => {
    const res = await send('POST', `/sources/${SOURCE}/created-contacts/remove`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { removed: 2, skipped: 3, skippedBy: removal.skippedBy, remaining: 0 } });
    expect(mocks.log).toEqual(['lock', 'active?', 'remove']);
    expect(mocks.lockSource).toHaveBeenCalledWith(PARTNER, SOURCE);
    expect(mocks.remove).toHaveBeenCalledWith(SOURCE, { userId: USER, destinationSource: 'technician' });
    // The live contact.delete row, per contact removed.
    expect(mocks.contactAudit).toHaveBeenCalledTimes(2);
    expect(mocks.contactAudit.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ orgId: ORG, action: 'contact.delete', contactId: CONTACT_A, contactName: 'Maya' }),
      expect.objectContaining({ orgId: ORG, action: 'contact.delete', contactId: CONTACT_B, contactName: null }),
    ]);
    expect(mocks.routeAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: null,
      action: 'ticket_import.created_contacts_removed',
      resourceId: SOURCE,
      details: expect.objectContaining({ partnerId: PARTNER, removed: 2, skipped: 3 }),
    }));
  });

  it('answers 409 TICKET_IMPORT_RUN_ACTIVE while a run is queued or running, and removes nothing', async () => {
    mocks.activeRunOf.mockResolvedValue(RUN);
    const res = await send('POST', `/sources/${SOURCE}/created-contacts/remove`);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('TICKET_IMPORT_RUN_ACTIVE');
    expect(body.details).toEqual({ runId: RUN });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.contactAudit).not.toHaveBeenCalled();
    expect(mocks.routeAudit).not.toHaveBeenCalled();
  });

  it('answers 404 when the source is not the partner\'s', async () => {
    mocks.lockSource.mockRejectedValue(new TicketImportError('TICKET_IMPORT_SOURCE_NOT_FOUND', 'Ticket import source not found', 404));
    const res = await send('POST', `/sources/${SOURCE}/created-contacts/remove`);
    expect(res.status).toBe(404);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('is open to any partner-wide admin (it narrows), not only the principal\'s owner, and to no one else', async () => {
    signIn({ user: { id: '33333333-3333-4333-8333-333333333333', email: 'other@example.test' } });
    expect((await send('POST', `/sources/${SOURCE}/created-contacts/remove`)).status).toBe(200);
    signIn({ partnerOrgAccess: 'selected' });
    expect((await send('POST', `/sources/${SOURCE}/created-contacts/remove`)).status).toBe(403);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it('writes no audit row when nothing was removed but still reports the skips', async () => {
    mocks.remove.mockResolvedValue({ removed: [], skipped: 1, skippedBy: { portal_login: 0, role: 1, other_link: 0, edited: 0 }, remaining: 0 });
    const res = await send('POST', `/sources/${SOURCE}/created-contacts/remove`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ removed: 0, skipped: 1 });
    expect(mocks.contactAudit).not.toHaveBeenCalled();
  });
});
