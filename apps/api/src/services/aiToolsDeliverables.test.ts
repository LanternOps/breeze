import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => {
  class DeliverableServiceError extends Error {
    constructor(message: string, readonly status: number, readonly code: string, readonly details?: unknown) { super(message); }
  }
  return {
    DeliverableServiceError,
    listDeliverables: vi.fn(), createDeliverable: vi.fn(), updateDeliverable: vi.fn(), deactivateDeliverable: vi.fn(),
    listOccurrences: vi.fn(), deliverOccurrence: vi.fn(), waiveOccurrence: vi.fn(), reopenOccurrence: vi.fn(),
    rescheduleOccurrence: vi.fn(), addEvidence: vi.fn(),
    listKeyDates: vi.fn(), createKeyDate: vi.fn(), updateKeyDate: vi.fn(), deleteKeyDate: vi.fn(),
  };
});
vi.mock('./serviceDeliverableService', async (orig) => ({
  ...(await orig<typeof import('./serviceDeliverableService')>()),
  DeliverableServiceError: svc.DeliverableServiceError,
  listDeliverables: svc.listDeliverables, createDeliverable: svc.createDeliverable,
  updateDeliverable: svc.updateDeliverable, deactivateDeliverable: svc.deactivateDeliverable,
  listOccurrences: svc.listOccurrences, deliverOccurrence: svc.deliverOccurrence, waiveOccurrence: svc.waiveOccurrence,
  reopenOccurrence: svc.reopenOccurrence, rescheduleOccurrence: svc.rescheduleOccurrence, addEvidence: svc.addEvidence,
}));
vi.mock('./orgKeyDateService', async (orig) => ({
  ...(await orig<typeof import('./orgKeyDateService')>()),
  listKeyDates: svc.listKeyDates, createKeyDate: svc.createKeyDate, updateKeyDate: svc.updateKeyDate, deleteKeyDate: svc.deleteKeyDate,
}));

import { aiTools } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS, TIER3_ACTIONS } from './aiGuardrails';
import { TOOL_TIERS } from './aiAgentSdkTools';

const NAMES = ['list_deliverables', 'manage_deliverables', 'manage_key_dates'] as const;
const MANAGE_ACTIONS = ['create', 'update', 'deactivate', 'deliver', 'waive', 'reopen', 'reschedule', 'link_evidence'] as const;
const KEY_DATE_ACTIONS = ['list', 'create', 'update', 'delete'] as const;
const ORG = '11111111-1111-4111-8111-111111111111';
const OCC = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const auth = { user: { id: 'u1', email: 'u1@example.com' }, scope: 'partner', partnerId: 'p1', accessibleOrgIds: [ORG] } as never;
const call = async (name: string, input: Record<string, unknown>, as = auth) => JSON.parse(await aiTools.get(name)!.handler(input, as));

describe('deliverable AI tools — registration (#5573 spec §10)', () => {
  it('registers all three at tier 2 with a schema, an SDK tier and permissions (the four-site rule)', () => {
    for (const n of NAMES) {
      expect(aiTools.get(n), `${n} not registered`).toBeDefined();
      expect(aiTools.get(n)!.tier).toBe(2);
      expect(toolInputSchemas[n], `${n} missing zod schema`).toBeDefined();
      expect(TOOL_TIERS[n], `${n} missing SDK tier`).toBe(2);
      expect(TOOL_PERMISSIONS[n], `${n} missing permissions`).toBeDefined();
    }
  });

  it('exposes every manage action, including W05 apply_template', () => {
    expect(toolInputSchemas.manage_deliverables!.safeParse({ action: 'apply_template' }).success).toBe(true);
    const perms = TOOL_PERMISSIONS.manage_deliverables as Record<string, unknown>;
    for (const a of MANAGE_ACTIONS) expect(perms[a], `no permission for ${a}`).toEqual({ resource: 'contracts', action: 'write' });
    // W05: a whole schedule at once, so `manage` rather than `write`.
    expect(perms.apply_template).toEqual({ resource: 'contracts', action: 'manage' });
    const keyDatePerms = TOOL_PERMISSIONS.manage_key_dates as Record<string, unknown>;
    for (const a of KEY_DATE_ACTIONS) expect(keyDatePerms[a], `no permission for ${a}`).toBeDefined();
    expect(TOOL_PERMISSIONS.list_deliverables).toEqual({ resource: 'contracts', action: 'read' });
  });

  it('only apply_template is approval-gated (W05)', () => {
    for (const n of NAMES) {
      const gated = (TIER3_ACTIONS as Record<string, string[] | undefined>)[n] ?? [];
      expect(gated, `unexpected tier-3 actions on ${n}`).toEqual(n === 'manage_deliverables' ? ['apply_template'] : []);
    }
  });
});

describe('deliverable AI tools — handlers', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns a JSON error string for an unknown action instead of throwing', async () => {
    expect(await call('manage_deliverables', { action: 'nope' })).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await call('manage_key_dates', { action: 'nope', orgId: ORG })).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses an organization-scoped session, as the HTTP routes requireScope(partner, system) do', async () => {
    const orgAuth = { user: { id: 'u2' }, scope: 'organization', partnerId: 'p1', accessibleOrgIds: [ORG] } as never;
    for (const [name, input] of [
      ['list_deliverables', { orgId: ORG }],
      ['manage_deliverables', { action: 'deliver', orgId: ORG, occurrenceId: OCC }],
      ['manage_key_dates', { action: 'list', orgId: ORG }],
    ] as const) {
      expect(await call(name, input, orgAuth)).toMatchObject({ code: 'PARTNER_SCOPE_REQUIRED' });
    }
    expect(svc.listDeliverables).not.toHaveBeenCalled();
    expect(svc.deliverOccurrence).not.toHaveBeenCalled();
    expect(svc.listKeyDates).not.toHaveBeenCalled();
  });

  it('names the missing params before touching the service', async () => {
    const out = await call('manage_deliverables', { action: 'waive', orgId: ORG, occurrenceId: OCC });
    expect(out).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(out.error).toContain('reason');
    expect(svc.waiveOccurrence).not.toHaveBeenCalled();
  });

  it('validates a create payload with the SAME schema the HTTP route uses — a bad cadence never reaches the service', async () => {
    const out = await call('manage_deliverables', { action: 'create', orgId: ORG, input: { name: 'X', cadence: 'weekly' } });
    expect(out).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(out.error).toContain('input.');
    expect(svc.createDeliverable).not.toHaveBeenCalled();
  });

  it('validates a key-date create payload the same way', async () => {
    const out = await call('manage_key_dates', { action: 'create', orgId: ORG, input: { label: 'Renewal' } });
    expect(out).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(svc.createKeyDate).not.toHaveBeenCalled();
  });

  it('passes the session actor through, so the service enforces org access', async () => {
    svc.deliverOccurrence.mockResolvedValue({ id: OCC, status: 'delivered' });
    expect(await call('manage_deliverables', { action: 'deliver', orgId: ORG, occurrenceId: OCC, note: 'done' }))
      .toMatchObject({ status: 'delivered' });
    expect(svc.deliverOccurrence).toHaveBeenCalledWith(ORG, OCC, { note: 'done' },
      { userId: 'u1', partnerId: 'p1', accessibleOrgIds: [ORG] });
  });

  it('dispatches every manage_deliverables action to its own service function', async () => {
    const DEL = '44444444-4444-4444-8444-444444444444';
    svc.updateDeliverable.mockResolvedValue({ id: DEL });
    svc.deactivateDeliverable.mockResolvedValue(undefined);
    svc.reopenOccurrence.mockResolvedValue({ id: OCC });
    svc.rescheduleOccurrence.mockResolvedValue({ id: OCC });
    svc.waiveOccurrence.mockResolvedValue({ id: OCC });

    await call('manage_deliverables', { action: 'update', orgId: ORG, deliverableId: DEL, patch: { name: 'Renamed' } });
    expect(svc.updateDeliverable).toHaveBeenCalledWith(ORG, DEL, { name: 'Renamed' }, expect.anything());

    expect(await call('manage_deliverables', { action: 'deactivate', orgId: ORG, deliverableId: DEL })).toEqual({ ok: true });
    expect(svc.deactivateDeliverable).toHaveBeenCalledWith(ORG, DEL, expect.anything());

    await call('manage_deliverables', { action: 'reopen', orgId: ORG, occurrenceId: OCC });
    expect(svc.reopenOccurrence).toHaveBeenCalledWith(ORG, OCC, expect.anything());

    await call('manage_deliverables', { action: 'reschedule', orgId: ORG, occurrenceId: OCC, dueAt: '2026-11-30' });
    expect(svc.rescheduleOccurrence).toHaveBeenCalledWith(ORG, OCC, { dueAt: '2026-11-30' }, expect.anything());

    await call('manage_deliverables', { action: 'waive', orgId: ORG, occurrenceId: OCC, reason: 'Client cancelled' });
    expect(svc.waiveOccurrence).toHaveBeenCalledWith(ORG, OCC, { reason: 'Client cancelled' }, expect.anything());
  });

  it('dispatches every manage_key_dates write action to its own service function', async () => {
    const KD = '55555555-5555-4555-8555-555555555555';
    svc.createKeyDate.mockResolvedValue({ id: KD });
    svc.updateKeyDate.mockResolvedValue({ id: KD });
    svc.deleteKeyDate.mockResolvedValue(undefined);

    await call('manage_key_dates', { action: 'create', orgId: ORG, input: { label: 'Renewal', date: '2027-03-01' } });
    expect(svc.createKeyDate).toHaveBeenCalledWith(ORG, expect.objectContaining({ label: 'Renewal', date: '2027-03-01' }), expect.anything());

    await call('manage_key_dates', { action: 'update', orgId: ORG, keyDateId: KD, patch: { remindDaysBefore: 30 } });
    expect(svc.updateKeyDate).toHaveBeenCalledWith(ORG, KD, { remindDaysBefore: 30 }, expect.anything());

    expect(await call('manage_key_dates', { action: 'delete', orgId: ORG, keyDateId: KD })).toEqual({ ok: true });
    expect(svc.deleteKeyDate).toHaveBeenCalledWith(ORG, KD, expect.anything());
  });

  it('rejects a reschedule date that is not YYYY-MM-DD before the service sees it', async () => {
    const out = await call('manage_deliverables', { action: 'reschedule', orgId: ORG, occurrenceId: OCC, dueAt: '30/11/2026' });
    expect(out).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(svc.rescheduleOccurrence).not.toHaveBeenCalled();
  });

  it('links an existing report run as evidence', async () => {
    svc.addEvidence.mockResolvedValue({ id: OCC });
    await call('manage_deliverables', { action: 'link_evidence', orgId: ORG, occurrenceId: OCC, reportRunId: RUN });
    expect(svc.addEvidence).toHaveBeenCalledWith(ORG, OCC, { kind: 'report_run', reportRunId: RUN }, expect.anything());
  });

  it('converts a service error (a foreign org is a 404) into JSON', async () => {
    svc.listDeliverables.mockRejectedValue(new svc.DeliverableServiceError('Not found', 404, 'NOT_FOUND'));
    expect(await call('list_deliverables', { orgId: ORG })).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
  });

  it('lists key dates with contract end dates folded in', async () => {
    svc.listKeyDates.mockResolvedValue([{ id: 'k1' }]);
    expect(await call('manage_key_dates', { action: 'list', orgId: ORG })).toEqual({ keyDates: [{ id: 'k1' }] });
    expect(svc.listKeyDates).toHaveBeenCalledWith(ORG, expect.anything(), { includeContractEnds: true });
  });

  it('rethrows an unexpected error rather than masking it as a tool result', async () => {
    svc.listDeliverables.mockRejectedValue(new Error('db down'));
    await expect(aiTools.get('list_deliverables')!.handler({ orgId: ORG }, auth)).rejects.toThrow('db down');
  });
});
