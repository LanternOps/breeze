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
// W03: the document tools' service, mocked whole (no DB, no bucket).
const docs = vi.hoisted(() => ({ listDocuments: vi.fn(), updateDocument: vi.fn(), supersedeDocument: vi.fn() }));
vi.mock('./orgDocumentService', () => docs);

import { aiTools } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS, TIER3_ACTIONS } from './aiGuardrails';
import { TOOL_TIERS } from './aiAgentSdkTools';
import { registerDeliverableTools } from './aiToolsDeliverables';
import type { AiTool } from './aiTools';
import { expectDefaultPageFits } from './aiToolOutputBudget.testkit';

const NAMES = ['list_deliverables', 'manage_deliverables', 'manage_key_dates'] as const;
const MANAGE_ACTIONS = ['create', 'update', 'deactivate', 'deliver', 'waive', 'reopen', 'reschedule', 'link_evidence'] as const;
const KEY_DATE_ACTIONS = ['list', 'create', 'update', 'delete'] as const;
const ORG = '11111111-1111-4111-8111-111111111111';
const OCC = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const CONTRACT_A = '77777777-7777-4777-8777-777777777777';
const CONTRACT_B = '88888888-8888-4888-8888-888888888888';
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

// ── list_deliverables paging + link_evidence documentId (#9313) ─────────────

describe('list_deliverables paging (#9313)', () => {
  const summary = (i: number) => ({
    id: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
    orgId: ORG, contractId: i % 2 ? CONTRACT_A : null, name: `Quarterly security review ${i}`,
    description: 'd'.repeat(300), instructions: 'i'.repeat(600), cadence: 'quarterly',
    anchorDueDate: '2026-01-15', effectiveFrom: '2026-01-01', effectiveUntil: null, leadDays: 7, graceDays: 14,
    artifactRequired: true, completionMode: 'on_ticket_resolve', ownerUserId: ORG, portalVisible: true, active: true,
    sortOrder: i, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    contractName: 'Managed Services Agreement', nextDue: '2026-12-15',
    lastDelivered: { at: '2026-09-15T00:00:00.000Z', late: false, note: 'n'.repeat(200) }, openCount: 1, status: 'on_track',
  });
  const all = Array.from({ length: 60 }, (_, i) => summary(i));
  beforeEach(() => { svc.listDeliverables.mockResolvedValue(all); });
  const idsOf = (o: { deliverables: Array<{ id: string }> }) => o.deliverables.map((d) => d.id);

  it('default page fits the chat budget uncompacted and reports hasMore', async () => {
    const raw = await aiTools.get('list_deliverables')!.handler({ orgId: ORG }, auth);
    expectDefaultPageFits('list_deliverables', raw);
    const out = JSON.parse(raw);
    expect(out.hasMore).toBe(true);
    expect(out.nextCursor).toEqual(expect.any(String));
    expect(out.showing).toBe(out.deliverables.length);
    expect(out.deliverables[0]).toEqual(expect.objectContaining({ id: all[0]!.id, name: all[0]!.name, cadence: 'quarterly', contractName: 'Managed Services Agreement', nextDue: '2026-12-15', status: 'on_track', openCount: 1, portalVisible: true, active: true }));
    expect(out.deliverables[0]).toHaveProperty('lastDelivered');
    expect(out.deliverables[0]).not.toHaveProperty('description');
    expect(out.deliverables[0]).not.toHaveProperty('instructions');
  });

  it('following nextCursor returns every row exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const out = await call('list_deliverables', { orgId: ORG, ...(cursor ? { cursor } : {}) });
      seen.push(...idsOf(out));
      if (!out.hasMore) { expect(out.nextCursor).toBeNull(); break; }
      cursor = out.nextCursor;
    }
    expect(seen).toEqual(all.map((d) => d.id));
    expect(new Set(seen).size).toBe(60);
  });

  it('includeDetails adds description and instructions', async () => {
    const out = await call('list_deliverables', { orgId: ORG, includeDetails: true, limit: 2 });
    expect(out.deliverables[0]).toEqual(expect.objectContaining({ description: 'd'.repeat(300), instructions: 'i'.repeat(600) }));
  });

  it('refuses a cursor replayed with a different contractId', async () => {
    const first = await call('list_deliverables', { orgId: ORG, contractId: CONTRACT_A });
    const out = await call('list_deliverables', { orgId: ORG, contractId: CONTRACT_B, cursor: first.nextCursor });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(out).toMatchObject({ code: 'CURSOR_MISMATCH' });
    expect(out).not.toHaveProperty('deliverables');
  });

  it('refuses a cursor replayed across includeInactive, but not across includeDetails', async () => {
    const first = await call('list_deliverables', { orgId: ORG });
    const flipped = await call('list_deliverables', { orgId: ORG, includeInactive: true, cursor: first.nextCursor });
    expect(flipped).toMatchObject({ code: 'CURSOR_MISMATCH' });
    const explicitFalse = await call('list_deliverables', { orgId: ORG, includeInactive: false, cursor: first.nextCursor });
    expect(explicitFalse).toHaveProperty('deliverables');
    const detailed = await call('list_deliverables', { orgId: ORG, includeDetails: true, cursor: first.nextCursor });
    expect(detailed).toHaveProperty('deliverables');
  });

  it('passes contractId / includeInactive filters to the service', async () => {
    await call('list_deliverables', { orgId: ORG, contractId: CONTRACT_A, includeInactive: true });
    expect(svc.listDeliverables).toHaveBeenLastCalledWith(ORG, { contractId: CONTRACT_A, includeInactive: true }, expect.anything());
  });

  it('does not leak lastDelivered.note into rows', async () => {
    const out = await call('list_deliverables', { orgId: ORG, limit: 1 });
    expect(out.deliverables[0].lastDelivered).toEqual({ at: '2026-09-15T00:00:00.000Z', late: false });
  });

  it('exposes limit/offset/cursor/includeDetails on the Zod schema', () => {
    const ok = toolInputSchemas.list_deliverables!.safeParse({ orgId: ORG, limit: 10, offset: 0, cursor: 'x', includeDetails: true });
    expect(ok.success).toBe(true);
  });
});

describe('manage_deliverables link_evidence documentId (#9313)', () => {
  const DOC = '66666666-6666-4666-8666-666666666666';
  it('links a library document as evidence', async () => {
    svc.addEvidence.mockResolvedValue({ id: OCC });
    await call('manage_deliverables', { action: 'link_evidence', orgId: ORG, occurrenceId: OCC, documentId: DOC });
    expect(svc.addEvidence).toHaveBeenCalledWith(ORG, OCC, { kind: 'document', documentId: DOC }, expect.anything());
  });
  it('refuses both ids together', async () => {
    svc.addEvidence.mockClear();
    const out = await call('manage_deliverables', { action: 'link_evidence', orgId: ORG, occurrenceId: OCC, documentId: DOC, reportRunId: RUN });
    expect(out).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(svc.addEvidence).not.toHaveBeenCalled();
  });
  it('refuses neither id', async () => {
    svc.addEvidence.mockClear();
    const out = await call('manage_deliverables', { action: 'link_evidence', orgId: ORG, occurrenceId: OCC });
    expect(out).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(svc.addEvidence).not.toHaveBeenCalled();
  });
  it('rejects a non-UUID documentId without calling the service', async () => {
    svc.addEvidence.mockClear();
    const out = await call('manage_deliverables', { action: 'link_evidence', orgId: ORG, occurrenceId: OCC, documentId: 'nope' });
    expect(out).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(svc.addEvidence).not.toHaveBeenCalled();
    expect(toolInputSchemas.manage_deliverables!.safeParse({ action: 'link_evidence', documentId: 'nope' }).success).toBe(false);
  });
  it('treats an empty reportRunId as absent when documentId is given', async () => {
    svc.addEvidence.mockResolvedValue({ id: OCC });
    await call('manage_deliverables', { action: 'link_evidence', orgId: ORG, occurrenceId: OCC, documentId: DOC, reportRunId: '' });
    expect(svc.addEvidence).toHaveBeenLastCalledWith(ORG, OCC, { kind: 'document', documentId: DOC }, expect.anything());
  });
  it('accepts documentId on the Zod schema', () => {
    expect(toolInputSchemas.manage_deliverables!.safeParse({ action: 'link_evidence', orgId: ORG, occurrenceId: OCC, documentId: DOC }).success).toBe(true);
  });
});

// ── Org document tools (#5573 W03) ───────────────────────────────────────────

describe('org document AI tools (#5573 W03)', () => {
  const DOC = '44444444-4444-4444-8444-444444444444';
  const DOC2 = '55555555-5555-4555-8555-555555555555';
  const ACTOR = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: [ORG] };
  const tool = (name: string): AiTool => {
    const m = new Map<string, AiTool>();
    registerDeliverableTools(m);
    const t = m.get(name);
    if (!t) throw new Error(`${name} not registered`);
    return t;
  };
  const run = async (name: string, input: Record<string, unknown>, as = auth) => JSON.parse(await tool(name).handler(input, as));

  beforeEach(() => { vi.clearAllMocks(); });

  it('registers both document tools at tier 2 at every site, alongside the three deliverable tools', () => {
    for (const n of ['list_org_documents', 'manage_org_documents'] as const) {
      expect(aiTools.get(n), `${n} not registered`).toBeDefined();
      expect(aiTools.get(n)!.tier).toBe(2);
      expect(toolInputSchemas[n], `${n} missing zod schema`).toBeDefined();
      expect(TOOL_TIERS[n], `${n} missing SDK tier`).toBe(2);
      expect(TOOL_PERMISSIONS[n], `${n} missing permissions`).toBeDefined();
    }
    for (const n of NAMES) expect(aiTools.get(n), `${n} dropped by the W03 merge`).toBeDefined();
    expect(TOOL_PERMISSIONS.list_org_documents).toEqual({ resource: 'documents', action: 'read' });
  });

  it('list_org_documents returns heads only by default and reports the count', async () => {
    docs.listDocuments.mockResolvedValueOnce([{ id: DOC, title: 'Runbook' }]);
    expect(await run('list_org_documents', { orgId: ORG })).toEqual({ documents: [{ id: DOC, title: 'Runbook' }], showing: 1 });
    expect(docs.listDocuments).toHaveBeenCalledWith(ORG, { category: undefined, includeSuperseded: false }, ACTOR);
  });

  it('is NOT limited to partner scope — the documents routes serve org-scope roles', async () => {
    docs.listDocuments.mockResolvedValueOnce([]);
    const orgAuth = { user: { id: 'u2' }, scope: 'organization', partnerId: 'p1', accessibleOrgIds: [ORG] } as never;
    expect(await run('list_org_documents', { orgId: ORG }, orgAuth)).toEqual({ documents: [], showing: 0 });
  });

  it('list_org_documents promises metadata only, never bytes', () => {
    const d = tool('list_org_documents').definition.description ?? '';
    expect(d).toMatch(/metadata only/i);
    expect(d).toMatch(/never the file bytes/i);
  });

  it('manage_org_documents has NO byte-upload action', () => {
    const t = tool('manage_org_documents');
    const actions = (t.definition.input_schema.properties as Record<string, { enum?: string[] }>).action!.enum;
    expect(actions).toEqual(['update_metadata', 'set_portal_visibility', 'supersede']);
    expect(JSON.stringify(t.definition)).not.toMatch(/base64|upload|contentBase/i);
  });

  it('rejects a missing documentId before coercing it to the string "undefined"', async () => {
    const out = await run('manage_org_documents', { action: 'set_portal_visibility', orgId: ORG, portalVisible: true });
    expect(out).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(out.error).toContain('documentId');
    expect(docs.updateDocument).not.toHaveBeenCalled();
  });

  it('set_portal_visibility patches ONLY portalVisible, and refuses a string "false"', async () => {
    docs.updateDocument.mockResolvedValueOnce({ id: DOC, portalVisible: true });
    await run('manage_org_documents', { action: 'set_portal_visibility', orgId: ORG, documentId: DOC, portalVisible: true });
    expect(docs.updateDocument).toHaveBeenCalledWith(ORG, DOC, { portalVisible: true }, ACTOR);
    docs.updateDocument.mockClear();
    const out = await run('manage_org_documents', { action: 'set_portal_visibility', orgId: ORG, documentId: DOC, portalVisible: 'false' });
    expect(out).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(docs.updateDocument).not.toHaveBeenCalled();
  });

  it('update_metadata validates the patch (unknown key rejected) and forwards a valid one', async () => {
    const bad = await run('manage_org_documents', { action: 'update_metadata', orgId: ORG, documentId: DOC, patch: { storageKey: 'x' } });
    expect(bad).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(docs.updateDocument).not.toHaveBeenCalled();
    docs.updateDocument.mockResolvedValueOnce({ id: DOC, title: 'New' });
    const ok = await run('manage_org_documents', { action: 'update_metadata', orgId: ORG, documentId: DOC, patch: { title: 'New', category: 'runbook' } });
    expect(ok).toEqual({ id: DOC, title: 'New' });
    expect(docs.updateDocument).toHaveBeenCalledWith(ORG, DOC, { title: 'New', category: 'runbook' }, ACTOR);
  });

  it('supersede links two documents', async () => {
    docs.supersedeDocument.mockResolvedValueOnce({ id: DOC2, supersedesDocumentId: DOC });
    await run('manage_org_documents', { action: 'supersede', orgId: ORG, documentId: DOC2, supersedesDocumentId: DOC });
    expect(docs.supersedeDocument).toHaveBeenCalledWith(ORG, DOC2, DOC, ACTOR);
  });

  it('a document of another org answers a 404 JSON error, never a throw', async () => {
    docs.updateDocument.mockRejectedValueOnce(new svc.DeliverableServiceError('Not found', 404, 'NOT_FOUND'));
    expect(await run('manage_org_documents', { action: 'set_portal_visibility', orgId: ORG, documentId: DOC, portalVisible: false }))
      .toEqual({ error: 'Not found', code: 'NOT_FOUND' });
  });

  it('an unknown action is a structured error', async () => {
    expect(await run('manage_org_documents', { action: 'upload', orgId: ORG })).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
