/**
 * The exported recipient operations (full-control W18 PR B, #6789) with the AI
 * tool's options: Decision 5's delivery gate on every add and convert, and
 * convert limited to an address already in config.emailRecipients. The REST
 * paths (no options) stay covered by recipients.test.ts, unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const REPORT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTACT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GATE_BODY = {
  error: 'Setting or changing email recipients on a report requires the export permission and an MFA-verified session',
};

const state = vi.hoisted(() => ({
  results: [] as unknown[][],
  inserted: [] as unknown[],
  deleted: [] as unknown[],
  updated: [] as unknown[],
  transactions: 0,
  lockedConfig: {} as Record<string, unknown>,
  locks: [] as string[],
  gateMfa: true,
  getReport: vi.fn(),
  createContact: vi.fn(),
}));

function selectChain(result: unknown[]) {
  const chain: Record<string, any> = {};
  for (const m of ['from', 'innerJoin', 'orderBy', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  chain.for = vi.fn((mode: string) => { state.locks.push(mode); return Promise.resolve(result); });
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

function handle() {
  return {
    select: vi.fn((projection?: Record<string, unknown>) =>
      projection?.config === 'reports.config'
        ? selectChain([{ config: state.lockedConfig, seriesId: null }])
        : selectChain(state.results.shift() ?? [])),
    insert: vi.fn(() => ({
      values: vi.fn((value: unknown) => {
        state.inserted.push(value);
        const returning = vi.fn(() => Promise.resolve([{ id: 'recipient-1' }]));
        return {
          onConflictDoUpdate: vi.fn(() => ({ returning })),
          onConflictDoNothing: vi.fn(() => ({ returning, then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r) })),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn((condition: unknown) => {
        state.deleted.push(condition);
        return { returning: vi.fn(() => Promise.resolve([])) };
      }),
    })),
    update: vi.fn(() => ({ set: vi.fn((value: unknown) => { state.updated.push(value); return { where: vi.fn(() => Promise.resolve()) }; }) })),
  };
}

vi.mock('../../db', () => {
  const root = handle();
  return {
    db: {
      ...root,
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => { state.transactions += 1; return fn(handle()); }),
    },
  };
});
vi.mock('../../db/schema', () => ({
  contacts: { id: 'contacts.id', orgId: 'contacts.orgId', name: 'contacts.name', email: 'contacts.email' },
  reportScheduleRecipients: { id: 'r.id', reportId: 'r.reportId', orgId: 'r.orgId', contactId: 'r.contactId', mode: 'r.mode' },
  reports: { id: 'reports.id', orgId: 'reports.orgId', config: 'reports.config', seriesId: 'reports.seriesId' },
}));
vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ type: 'and', conditions }),
  asc: (column: unknown) => ({ type: 'asc', column }),
  eq: (column: unknown, value: unknown) => ({ type: 'eq', column, value }),
  isNull: (column: unknown) => ({ type: 'isNull', column }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ type: 'sql', strings: [...strings], values }),
}));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
  hasSatisfiedMfa: () => state.gateMfa,
}));
vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    REPORTS_READ: { resource: 'reports', action: 'read' },
    REPORTS_WRITE: { resource: 'reports', action: 'write' },
    REPORTS_EXPORT: { resource: 'reports', action: 'export' },
  },
  hasPermission: (perms: any, resource: string, action: string) =>
    (perms?.permissions ?? []).some((p: any) => (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*')),
}));
vi.mock('./helpers', () => ({ getReportWithOrgCheck: state.getReport }));
vi.mock('../../services/contacts/crud', () => ({ createContact: state.createContact }));
vi.mock('../../services/contacts/audit', () => ({ contactCreateAuditEvent: vi.fn(), writeContactAudit: vi.fn() }));

import {
  addReportRecipient,
  convertReportRecipient,
  listReportRecipients,
  RECIPIENT_NOT_A_LEGACY_ADDRESS,
  removeReportRecipient,
} from './recipients';

const auth = { scope: 'organization', orgId: ORG_ID, user: { id: 'user-1' }, token: { mfa: true } } as never;
const ALL = { permissions: [{ resource: '*', action: '*' }] } as never;
const WRITE_ONLY = { permissions: [{ resource: 'reports', action: 'write' }, { resource: 'reports', action: 'read' }] } as never;
const plain = { id: REPORT_ID, orgId: ORG_ID, partnerId: null, type: 'device_inventory', seriesId: null };
const seriesChild = { ...plain, seriesId: 'series-1' };

beforeEach(() => {
  state.results = [];
  state.inserted = [];
  state.deleted = [];
  state.updated = [];
  state.transactions = 0;
  state.lockedConfig = {};
  state.locks = [];
  state.gateMfa = true;
  state.getReport.mockReset();
  state.createContact.mockReset();
});

describe('addReportRecipient with the tool delivery gate (Decision 5)', () => {
  it.each([['plain', plain], ['series', seriesChild]])('%s definition: refused without reports:export, and without MFA', async (_label, report) => {
    state.getReport.mockResolvedValue(report);
    expect(await addReportRecipient(REPORT_ID, auth, WRITE_ONLY, { contactId: CONTACT_ID }, { requireDeliveryGate: true }))
      .toEqual({ ok: false, status: 403, body: GATE_BODY });
    state.gateMfa = false;
    expect(await addReportRecipient(REPORT_ID, auth, ALL, { contactId: CONTACT_ID }, { requireDeliveryGate: true }))
      .toEqual({ ok: false, status: 403, body: GATE_BODY });
    expect(state.inserted).toEqual([]);
  });

  it('plain definition: allowed with export + MFA; without the option (REST) reports:write alone suffices', async () => {
    state.getReport.mockResolvedValue(plain);
    state.results = [[{ id: CONTACT_ID }], [{ id: CONTACT_ID }]];
    expect((await addReportRecipient(REPORT_ID, auth, ALL, { contactId: CONTACT_ID }, { requireDeliveryGate: true })).ok).toBe(true);
    expect((await addReportRecipient(REPORT_ID, auth, WRITE_ONLY, { contactId: CONTACT_ID })).ok).toBe(true);
  });

  it('a contact from another org is NOT_FOUND and nothing is written', async () => {
    state.getReport.mockResolvedValue(plain);
    state.results = [[]];
    expect(await addReportRecipient(REPORT_ID, auth, ALL, { contactId: CONTACT_ID }, { requireDeliveryGate: true }))
      .toEqual({ ok: false, status: 404, body: { error: 'Contact not found' } });
    expect(state.inserted).toEqual([]);
  });

  it('a report hidden from the caller is NOT_FOUND', async () => {
    state.getReport.mockResolvedValue(null);
    expect(await addReportRecipient(REPORT_ID, auth, ALL, { contactId: CONTACT_ID }, { requireDeliveryGate: true }))
      .toEqual({ ok: false, status: 404, body: { error: 'Report not found' } });
    expect((await listReportRecipients(REPORT_ID, auth, ALL))).toEqual({ ok: false, status: 404, body: { error: 'Report not found' } });
  });

  it("partner-owned, system-managed and partner-only-delivery definitions: writes refused with the route's code", async () => {
    state.getReport.mockResolvedValue({ ...plain, orgId: null, partnerId: 'p-1' });
    expect(await addReportRecipient(REPORT_ID, auth, ALL, { contactId: CONTACT_ID }, { requireDeliveryGate: true }))
      .toEqual({ ok: false, status: 409, body: { error: 'partner_owned_report' } });
    expect(await removeReportRecipient(REPORT_ID, auth, ALL, CONTACT_ID)).toEqual({ ok: false, status: 409, body: { error: 'partner_owned_report' } });
    expect(await listReportRecipients(REPORT_ID, auth, ALL)).toEqual({ ok: true, status: 200, value: [] });
    state.getReport.mockResolvedValue({ ...plain, type: 'ai_org_narrative' });
    expect(await addReportRecipient(REPORT_ID, auth, ALL, { contactId: CONTACT_ID }, { requireDeliveryGate: true }))
      .toEqual({ ok: false, status: 409, body: { error: 'report_type_system_managed', type: 'ai_org_narrative' } });
    state.getReport.mockResolvedValue({ ...plain, type: 'ar_aging' });
    expect(await convertReportRecipient(REPORT_ID, auth, ALL, { email: 'a@x.test' }, 'user-1', { requireDeliveryGate: true, requireLegacyAddress: true }))
      .toEqual({ ok: false, status: 409, body: { error: 'report_type_partner_only_delivery', type: 'ar_aging' } });
    expect(state.inserted).toEqual([]);
  });
});

describe('removeReportRecipient (conditional predicate moved intact)', () => {
  it("remove of a series 'remove' row without export + MFA is refused and the row stays", async () => {
    state.getReport.mockResolvedValue(seriesChild);
    state.results = [[{ id: 'override-1' }]];
    expect(await removeReportRecipient(REPORT_ID, auth, WRITE_ONLY, CONTACT_ID)).toEqual({ ok: false, status: 403, body: GATE_BODY });
    // The DELETE ran restricted to mode 'add' rows, so the 'remove' override was never deleted.
    expect(JSON.stringify(state.deleted[0])).toContain('"column":"r.mode","value":"add"');
  });

  it("remove of a series 'remove' row with reports:export but no MFA is refused too", async () => {
    state.getReport.mockResolvedValue(seriesChild);
    state.gateMfa = false;
    state.results = [[{ id: 'override-1' }]];
    expect(await removeReportRecipient(REPORT_ID, auth, ALL, CONTACT_ID)).toEqual({ ok: false, status: 403, body: GATE_BODY });
    expect(JSON.stringify(state.deleted[0])).toContain('"column":"r.mode","value":"add"');
  });

  it("remove of an 'add' row needs only reports:write", async () => {
    state.getReport.mockResolvedValue(plain);
    const out = await removeReportRecipient(REPORT_ID, auth, WRITE_ONLY, CONTACT_ID);
    // The fake DELETE matched no row; what matters is that it ran unrestricted, with no gate refusal.
    expect(out).toEqual({ ok: false, status: 404, body: { error: 'Recipient not found' } });
    expect(JSON.stringify(state.deleted[0])).not.toContain('r.mode');
  });
});

describe('convertReportRecipient with the tool options (Decision 5)', () => {
  it('an address not in config.emailRecipients is refused under the lock, and nothing is written', async () => {
    state.getReport.mockResolvedValue(plain);
    state.lockedConfig = { emailRecipients: ['someone@x.test'] };
    expect(await convertReportRecipient(REPORT_ID, auth, ALL, { email: 'Dana@X.test' }, 'user-1', { requireDeliveryGate: true, requireLegacyAddress: true }))
      .toEqual({ ok: false, status: 409, body: RECIPIENT_NOT_A_LEGACY_ADDRESS });
    expect(state.locks).toEqual(['update']);
    expect(state.createContact).not.toHaveBeenCalled();
    expect(state.inserted).toEqual([]);
    expect(state.updated).toEqual([]);
  });

  it('a listed address converts (case-insensitive) and the created contact comes back for the audit event', async () => {
    state.getReport.mockResolvedValue(plain);
    state.lockedConfig = { emailRecipients: [' dana@x.test ', 'other@x.test'] };
    state.results = [[]];
    state.createContact.mockResolvedValue({ id: CONTACT_ID, name: null, email: 'dana@x.test', isPrimary: false, roles: [] });
    const out = await convertReportRecipient(REPORT_ID, auth, ALL, { email: 'Dana@X.test' }, 'user-1', { requireDeliveryGate: true, requireLegacyAddress: true });
    expect(out.ok && out.value.createdContact?.id).toBe(CONTACT_ID);
    expect(out.ok && out.value.orgId).toBe(ORG_ID);
    expect(state.updated).toEqual([expect.objectContaining({ config: { emailRecipients: ['other@x.test'] } })]);
  });

  it('without reports:export the gate refuses before the transaction opens', async () => {
    state.getReport.mockResolvedValue(plain);
    expect(await convertReportRecipient(REPORT_ID, auth, WRITE_ONLY, { email: 'a@x.test' }, 'user-1', { requireDeliveryGate: true, requireLegacyAddress: true }))
      .toEqual({ ok: false, status: 403, body: GATE_BODY });
    expect(state.transactions).toBe(0);
  });
});
