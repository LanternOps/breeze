import { describe, expect, it } from 'vitest';
import { toPortalApprovalView, recipientRoleOf } from './portal';
import { normalizeApprovalEmail } from './requests';

const NOW = new Date('2026-12-01T12:00:00Z');

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', orgId: 'o1', ticketId: 't1', trigger: 'budget', origin: 'auto', status: 'pending', revision: 2,
  enforcement: 'soft', requestedByUserId: 'staff-1', requestedAt: new Date('2026-11-30T12:00:00Z'),
  expiresAt: new Date('2026-12-03T12:00:00Z'), message: 'We need two more hours to finish the migration.',
  budgetMinutesAtRequest: 600, consumedMinutesAtRequest: 585, budgetAmountAtRequest: '1500.00',
  consumedAmountAtRequest: '1462.50', currencyCode: 'USD', requestedExtensionMinutes: 150,
  requestedExtensionAmount: '375.00', coverageStartsAt: null, coverageEndsAt: null, afterHoursWorkTypeId: 'wt-1',
  approverEmails: ['approver@example.test'], notifyEmails: ['requester@example.test'],
  decidedAt: null, decisionOrigin: null, decidedByPortalUserId: null, decidedByUserId: 'staff-2',
  signerName: null, signerEmail: 'approver@example.test', decisionMethod: 'verbal', decisionReference: 'call with CFO',
  decisionNote: 'internal: they grumbled', decidedRevision: null, approvedExtensionMinutes: null,
  approvedExtensionAmount: null, ipAddress: '198.51.100.1', userAgent: 'UA', createdAt: NOW, updatedAt: NOW,
  ticketNumber: 'T-1042', ticketSubject: 'Server migration',
  ...over,
});

describe('normalizeApprovalEmail', () => {
  it('trims and lower-cases, and maps blank to null', () => {
    expect(normalizeApprovalEmail('  Approver@Example.TEST ')).toBe('approver@example.test');
    expect(normalizeApprovalEmail('   ')).toBeNull();
    expect(normalizeApprovalEmail(null)).toBeNull();
  });
});

describe('recipientRoleOf', () => {
  it('matches the session email the way resolveRecipients stored it', () => {
    expect(recipientRoleOf(row() as never, ' APPROVER@example.test')).toBe('approver');
    expect(recipientRoleOf(row() as never, 'Requester@Example.test')).toBe('notify');
    expect(recipientRoleOf(row() as never, 'stranger@example.test')).toBeNull();
    expect(recipientRoleOf(row() as never, '')).toBeNull();
  });
});

describe('toPortalApprovalView', () => {
  it('projects an allow-list: no recipient lists, staff ids, internal evidence or client fingerprints', () => {
    const v = toPortalApprovalView(row() as never, 'approver@example.test', NOW)!;
    const json = JSON.stringify(v);
    for (const leaked of [
      'requester@example.test', 'approver@example.test', 'staff-1', 'staff-2', 'call with CFO', 'internal: they grumbled',
      '198.51.100.1', 'wt-1', 'verbal',
    ]) {
      expect(json).not.toContain(leaked);
    }
    expect(Object.keys(v).sort()).toEqual([
      'ask', 'canDecide', 'decidedAt', 'decisionOrigin', 'expiresAt', 'id', 'message', 'requestedAt', 'revision', 'role',
      'snapshot', 'status', 'ticketId', 'ticketNumber', 'ticketSubject', 'trigger',
    ]);
    expect(v).toMatchObject({
      id: 'r1', ticketId: 't1', ticketNumber: 'T-1042', ticketSubject: 'Server migration', trigger: 'budget',
      status: 'pending', revision: 2, role: 'approver', canDecide: true,
      message: 'We need two more hours to finish the migration.',
      ask: { minutes: 150, amount: '375.00', currencyCode: 'USD', coverageStartsAt: null, coverageEndsAt: null },
      snapshot: { budgetMinutes: 600, consumedMinutes: 585, budgetAmount: '1500.00', consumedAmount: '1462.50' },
    });
  });

  it('a notify-only recipient never canDecide', () => {
    expect(toPortalApprovalView(row() as never, 'requester@example.test', NOW)).toMatchObject({ role: 'notify', canDecide: false });
  });

  it('a non-recipient gets no view at all', () => {
    expect(toPortalApprovalView(row() as never, 'stranger@example.test', NOW)).toBeNull();
  });

  it('an approver cannot decide a request that is decided, or past its expiry but not yet swept', () => {
    expect(toPortalApprovalView(row({ status: 'approved' }) as never, 'approver@example.test', NOW)!.canDecide).toBe(false);
    expect(toPortalApprovalView(row({ expiresAt: new Date('2026-12-01T11:59:59Z') }) as never, 'approver@example.test', NOW)!.canDecide).toBe(false);
  });

  it('exposes only the decision origin of a decided request, not who recorded it', () => {
    const v = toPortalApprovalView(row({ status: 'approved', decisionOrigin: 'on_behalf', decidedAt: NOW }) as never, 'approver@example.test', NOW)!;
    expect(v.decisionOrigin).toBe('on_behalf');
    expect(v.decidedAt).toEqual(NOW);
  });
});

describe('portal ticket number (customer-facing)', () => {
  // Fake db: records the select shape and resolves each column reference to a value, so the
  // test asserts which ticket column feeds the customer-visible number.
  function fakeDb(tickets: typeof import('../../db/schema').tickets) {
    const values = new Map<unknown, unknown>([
      [tickets.ticketNumber, 'KQ04YOHZ-N'],
      [tickets.internalNumber, 'T-2026-0003'],
      [tickets.subject, 'Server migration'],
    ]);
    let shape: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where', 'orderBy']) chain[m] = () => chain;
    chain.limit = async () => [Object.fromEntries(
      Object.entries(shape).map(([k, col]) => [k, k === 'request' ? row() : (values.get(col) ?? null)]),
    )];
    return { select: (s: Record<string, unknown>) => { shape = s; return chain; } };
  }

  it('list and detail show tickets.ticket_number, the number the portal Support pages use', async () => {
    const { tickets } = await import('../../db/schema');
    const { listPortalApprovals, findPortalApproval } = await import('./portal');
    const db = fakeDb(tickets);
    const list = await listPortalApprovals(db as never, { orgId: 'o1', email: 'approver@example.test', pendingOnly: false, now: NOW });
    expect(list[0]!.ticketNumber).toBe('KQ04YOHZ-N');
    const one = await findPortalApproval(db as never, { orgId: 'o1', requestId: 'r1', email: 'approver@example.test', now: NOW });
    expect(one!.ticketNumber).toBe('KQ04YOHZ-N');
  });
});
