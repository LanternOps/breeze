import { beforeEach, describe, expect, it, vi } from 'vitest';

const summary = vi.hoisted(() => ({ getTicketApprovalSummary: vi.fn() }));
vi.mock('./ticketApproval/summary', () => summary);

const timeSvc = vi.hoisted(() => ({
  listTimeEntries: vi.fn(), getRunningTimer: vi.fn(), getTimesheet: vi.fn(),
  createTimeEntry: vi.fn(), startTimer: vi.fn(), stopTimer: vi.fn(),
  TimeEntryServiceError: class TimeEntryServiceError extends Error {
    constructor(message: string, public status = 400, public code?: string, public details?: Record<string, unknown>) {
      super(message);
    }
  },
}));
vi.mock('./timeEntryService', () => timeSvc);

import { db } from '../db';
import { aiTools } from './aiToolNames';
import './aiTools';

const partnerAuth = (over: Record<string, unknown> = {}) => ({
  scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1'],
  canAccessOrg: (id: string) => id === 'o1',
  orgCondition: () => undefined,
  partnerOrgAccess: null,
  user: { id: 'u1', isPlatformAdmin: false, email: 'u@example.test', name: 'U' }, ...over,
}) as never;

function stubTicketLookup(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = async () => rows;
  vi.spyOn(db, 'select').mockReturnValue(chain as never);
}

beforeEach(() => {
  vi.restoreAllMocks();
  summary.getTicketApprovalSummary.mockReset();
  for (const k of ['startTimer', 'stopTimer', 'createTimeEntry'] as const) timeSvc[k].mockReset();
});

describe('get_ticket_approval_status (read-only, #8196 W05)', () => {
  const tool = () => aiTools.get('get_ticket_approval_status')!;

  it('is a Tier-1 tickets-domain read with a UUID-only, write-free schema', () => {
    expect(tool()).toBeDefined();
    expect(tool().tier).toBe(1);
    expect(tool().domain).toBe('tickets');
    const props = Object.keys((tool().definition.input_schema as { properties: object }).properties);
    expect(props).toEqual(['ticketId']);
  });

  it('refuses organization-scope callers like the other ticket time tools', async () => {
    const out = JSON.parse(await tool().handler({ ticketId: 't1' }, partnerAuth({ scope: 'organization' })));
    expect(out.code).toBe('PARTNER_SCOPE_REQUIRED');
    expect(summary.getTicketApprovalSummary).not.toHaveBeenCalled();
  });

  it('returns not found for a ticket outside the caller scope', async () => {
    stubTicketLookup([]);
    const out = JSON.parse(await tool().handler({ ticketId: 't1' }, partnerAuth()));
    expect(out.error).toMatch(/not found/i);
    expect(summary.getTicketApprovalSummary).not.toHaveBeenCalled();
  });

  it('returns the W03 summary read model for a visible ticket', async () => {
    stubTicketLookup([{ id: 't1', orgId: 'o1', partnerId: 'p1', deviceId: null }]);
    summary.getTicketApprovalSummary.mockResolvedValue({ policy: { enabled: true }, requests: [] });
    const out = JSON.parse(await tool().handler({ ticketId: 't1' }, partnerAuth()));
    expect(summary.getTicketApprovalSummary).toHaveBeenCalledWith(expect.anything(), { ticketId: 't1', partnerId: 'p1', orgId: 'o1' });
    expect(out.approval).toEqual({ policy: { enabled: true }, requests: [] });
  });

  it('requires a ticketId', async () => {
    const out = JSON.parse(await tool().handler({}, partnerAuth()));
    expect(out.error).toMatch(/ticketId/);
  });
});

describe('manage_tickets time results explain customer-approval holds (#8196 W05)', () => {
  const manage = () => aiTools.get('manage_tickets')!;

  it('points the model at awaiting_approval and the status tool via the isBillable param', () => {
    const props = (manage().definition.input_schema as { properties: Record<string, { description?: string }> }).properties;
    const d = props.isBillable?.description ?? '';
    expect(d).toMatch(/awaiting_approval/);
    expect(d).toMatch(/get_ticket_approval_status/);
  });

  it.each([
    ['start_timer', 'startTimer', {}],
    ['stop_timer', 'stopTimer', {}],
    ['log_time_entry', 'createTimeEntry', { startedAt: '2026-10-01T10:00:00Z', endedAt: '2026-10-01T11:00:00Z' }],
  ] as const)('%s says "Recorded; held pending customer approval (request …)" when approvalHold is set', async (action, fn, extra) => {
    timeSvc[fn].mockResolvedValue({ id: 'e1', currencyCode: null, approvalHold: { requestId: 'req-1', trigger: 'budget' } });
    const out = JSON.parse(await manage().handler({ action, ...extra }, partnerAuth()));
    expect(out.approvalHold).toEqual({ requestId: 'req-1', trigger: 'budget' });
    expect(out.note).toBe('Recorded; held pending customer approval (request req-1). It is not billed until the customer approves or staff record consent.');
  });

  it('adds no note when nothing is held', async () => {
    timeSvc.startTimer.mockResolvedValue({ id: 'e1', currencyCode: null, approvalHold: null });
    const out = JSON.parse(await manage().handler({ action: 'start_timer' }, partnerAuth()));
    expect(out.note).toBeUndefined();
    expect(out.approvalHold).toBeUndefined();
  });

  it('maps APPROVAL_REQUIRED to a tool error with a code and the next step', async () => {
    timeSvc.startTimer.mockRejectedValue(new timeSvc.TimeEntryServiceError('refused', 409, 'APPROVAL_REQUIRED', { trigger: 'after_hours', pendingRequestId: null }));
    const out = JSON.parse(await manage().handler({ action: 'start_timer' }, partnerAuth()));
    expect(out.code).toBe('APPROVAL_REQUIRED');
    expect(out.details).toEqual({ trigger: 'after_hours', pendingRequestId: null });
    expect(out.error).toMatch(/non-billable/i);
    expect(out.error).toMatch(/human/i);
  });

  it('keeps other service errors as plain messages', async () => {
    timeSvc.startTimer.mockRejectedValue(new timeSvc.TimeEntryServiceError('nope', 409, 'ENTRY_CHANGED'));
    const out = JSON.parse(await manage().handler({ action: 'start_timer' }, partnerAuth()));
    expect(out).toEqual({ error: 'nope' });
  });
});
