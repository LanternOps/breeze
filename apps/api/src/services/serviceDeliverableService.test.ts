import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Param, SQL } from 'drizzle-orm';

// Controllable Drizzle chain mock (same pattern as contractService.test.ts):
// every builder method returns the same chain; an awaited query consumes the
// next queued result in call order. Tests queue the rows each db call resolves
// to and assert on the payloads handed to the builder (`.set()` / `.values()`),
// so a vacuous implementation cannot pass on return shape alone.
type QueuedQuery = { rows: unknown[] } | { error: unknown };
const results: QueuedQuery[] = [];
function queueResult(rows: unknown[]) { results.push({ rows }); }
function queueError(error: unknown) { results.push({ error }); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'innerJoin', 'leftJoin', 'onConflictDoNothing'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.transaction = vi.fn(async (run: (tx: unknown) => unknown) => run(chain));
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      const result = results.shift() ?? { rows: [] };
      return 'error' in result ? reject(result.error) : resolve(result.rows);
    };
    return chain;
  };
  return {
    db: makeChain(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

const { createTicketMock } = vi.hoisted(() => ({ createTicketMock: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./ticketService', () => ({ createTicket: createTicketMock }));

import { db } from '../db';
import {
  addEvidence, createDeliverable, deactivateDeliverable, deliverOccurrence, getDeliverable, listOccurrences,
  materializeOccurrences, openOccurrence, markOccurrenceMissed, applyTicketStatusChange, markDueOccurrencesMissedForDeliverable,
  openDueOccurrencesForDeliverable, periodLabel, applyContractCancelledToDeliverables,
  removeEvidence, reopenOccurrence, rescheduleOccurrence, summarizeStatus, updateDeliverable, waiveOccurrence,
  DeliverableServiceError, getOccurrenceOr404,
} from './serviceDeliverableService';

type MockCalls = { mock: { calls: unknown[][]; invocationCallOrder: number[] } };
type ChainName = 'select' | 'insert' | 'update' | 'delete' | 'set' | 'values' | 'limit' | 'transaction' | 'where';
const chain = db as unknown as Record<ChainName, MockCalls>;
const lastSet = () => chain.set.mock.calls.at(-1)?.[0] as Record<string, unknown>;
const lastValues = () => chain.values.mock.calls.at(-1)?.[0] as Record<string, unknown>;
// Bound parameter VALUES of the `.where(...)` that follows the most recent
// `.set(...)` — i.e. the UPDATE's own WHERE, not the reload SELECT's. Asserting
// on Params (not on column/enum metadata, which a deep `toContain` matches
// vacuously) proves the status guard is actually bound into the UPDATE.
function boundParams(node: unknown, out: unknown[] = []): unknown[] {
  if (node instanceof Param) out.push(node.value);
  else if (node instanceof SQL) for (const c of node.queryChunks) boundParams(c, out);
  else if (Array.isArray(node)) for (const c of node) boundParams(c, out);
  return out;
}
function updateWhereParams(): unknown[] {
  const setOrder = chain.set.mock.invocationCallOrder.at(-1);
  if (setOrder === undefined) throw new Error('no .set() call recorded');
  const i = chain.where.mock.invocationCallOrder.findIndex((o) => o > setOrder);
  if (i === -1) throw new Error('no .where() call after the last .set()');
  return boundParams(chain.where.mock.calls[i]?.[0]);
}
const summaryRow = (over: Record<string, unknown> = {}, contractName: string | null = null) => ({
  deliverable: { id: 'd1', orgId: 'org1', ...base, effectiveFrom: '2020-01-01', active: true, effectiveUntil: null, contractId: null, ...over },
  contractName,
});

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const base = {
  name: 'Sign-in log review', cadence: 'monthly' as const, anchorDueDate: '2026-10-31', effectiveFrom: '2026-10-01',
  leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve' as const, portalVisible: true, sortOrder: 0,
};
const occ = (over: Record<string, unknown> = {}) => ({
  id: 'o1', orgId: 'org1', deliverableId: 'd1', nameSnapshot: 'Sign-in log review', periodStart: '2026-10-01', periodEnd: '2026-10-31',
  dueAt: '2026-10-31', originalDueAt: '2026-10-31', status: 'open', ticketId: null, deliveredAt: null, deliveredByUserId: null,
  deliveredVia: null, deliveryNote: null, waivedAt: null, waivedByUserId: null, waivedReason: null,
  createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'),
  artifactRequired: true, completionMode: 'on_ticket_resolve', graceDays: 14, leadDays: 7,
  ...over,
});

describe('serviceDeliverableService', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  describe('org access', () => {
    it('404s a foreign org without touching the db', async () => {
      await expect(createDeliverable('org2', base, actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(chain.select.mock.calls).toHaveLength(0);
      expect(chain.insert.mock.calls).toHaveLength(0);
    });

    it('404s a foreign org on every occurrence mutation', async () => {
      const foreign = { ...actor, accessibleOrgIds: ['org9'] };
      await expect(deliverOccurrence('org1', 'o1', {}, foreign)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      await expect(waiveOccurrence('org1', 'o1', { reason: 'x' }, foreign)).rejects.toMatchObject({ status: 404 });
      await expect(reopenOccurrence('org1', 'o1', foreign)).rejects.toMatchObject({ status: 404 });
      await expect(rescheduleOccurrence('org1', 'o1', { dueAt: '2026-11-30' }, foreign)).rejects.toMatchObject({ status: 404 });
      await expect(addEvidence('org1', 'o1', { kind: 'report_run', reportRunId: RUN_ID }, foreign)).rejects.toMatchObject({ status: 404 });
      await expect(removeEvidence('org1', 'o1', 'e1', foreign)).rejects.toMatchObject({ status: 404 });
      await expect(getDeliverable('org1', 'd1', foreign)).rejects.toMatchObject({ status: 404 });
      await expect(deactivateDeliverable('org1', 'd1', foreign)).rejects.toMatchObject({ status: 404 });
      expect(chain.select.mock.calls).toHaveLength(0);
      expect(chain.update.mock.calls).toHaveLength(0);
    });

    it('a null accessibleOrgIds actor (system) passes the org gate', async () => {
      queueResult([]); // deliverable lookup
      await expect(getDeliverable('org1', 'd1', { ...actor, accessibleOrgIds: null })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(chain.select.mock.calls).toHaveLength(1);
    });
  });

  describe('createDeliverable', () => {
    it('rejects a contract from another org', async () => {
      queueResult([]); // contract lookup returns nothing
      await expect(createDeliverable('org1', { ...base, contractId: CONTRACT_ID }, actor))
        .rejects.toMatchObject({ status: 400, code: 'CONTRACT_NOT_IN_ORG' });
      expect(chain.insert.mock.calls).toHaveLength(0);
    });

    it('rejects an owner outside the org partner (OWNER_NOT_ALLOWED)', async () => {
      queueResult([{ partnerId: 'p1' }]); // org
      queueResult([]); // user in partner
      await expect(createDeliverable('org1', { ...base, ownerUserId: '33333333-3333-4333-8333-333333333333' }, actor))
        .rejects.toMatchObject({ status: 400, code: 'OWNER_NOT_ALLOWED' });
    });

    it('rejects a ticket category of another partner (CATEGORY_NOT_ALLOWED)', async () => {
      queueResult([{ partnerId: 'p1' }]); // org
      queueResult([]); // category in partner
      await expect(createDeliverable('org1', { ...base, ticketCategoryId: '44444444-4444-4444-8444-444444444444' }, actor))
        .rejects.toMatchObject({ status: 400, code: 'CATEGORY_NOT_ALLOWED' });
    });

    it('404s an auto-evidence report outside the org', async () => {
      queueResult([]); // report lookup
      await expect(createDeliverable('org1', { ...base, autoEvidenceReportId: '55555555-5555-4555-8555-555555555555' }, actor))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });

    it('409s a duplicate (org, contract, name) from the pre-check without inserting', async () => {
      queueResult([{ one: 1 }]); // name pre-check finds a row
      await expect(createDeliverable('org1', base, actor)).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_NAME' });
      expect(chain.insert.mock.calls).toHaveLength(0);
    });

    it('inserts with orgId + createdBy stamped (in a savepoint) and returns the SUMMARY shape', async () => {
      queueResult([]); // name pre-check
      queueResult([{ id: 'd1', orgId: 'org1', ...base }]); // insert returning
      queueResult([summaryRow({ contractId: CONTRACT_ID }, 'Best plan')]); // reload: deliverable + contract name
      queueResult([{ id: 'o1', deliverableId: 'd1', status: 'open', dueAt: '2999-01-01', deliveredAt: null, deliveryNote: null }]); // reload: occurrences
      const out = await createDeliverable('org1', base, actor);
      expect(chain.transaction.mock.calls).toHaveLength(1);
      expect(lastValues()).toMatchObject({ orgId: 'org1', name: base.name, createdBy: 'u1', cadence: 'monthly' });
      expect(out).toMatchObject({ id: 'd1', name: base.name, contractName: 'Best plan', nextDue: '2999-01-01', openCount: 1, status: 'on_track', lastDelivered: null });
    });

    it('500s RELOAD_FAILED if the row cannot be re-read after insert', async () => {
      queueResult([]); // name pre-check
      queueResult([{ id: 'd1', orgId: 'org1', ...base }]);
      queueResult([]); // reload finds nothing
      await expect(createDeliverable('org1', base, actor)).rejects.toMatchObject({ status: 500, code: 'RELOAD_FAILED' });
    });

    it('maps unique violation 23505 → 409 DUPLICATE_NAME (concurrent-writer backstop)', async () => {
      queueResult([]); // name pre-check
      queueError({ code: '23505', constraint_name: 'service_deliverables_org_contract_name_uq' });
      await expect(createDeliverable('org1', base, actor)).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_NAME' });
    });

    it('maps a Drizzle-wrapped 23505 (code on .cause) → 409 DUPLICATE_NAME', async () => {
      queueResult([]); // name pre-check
      queueError(Object.assign(new Error('wrapped'), { cause: { code: '23505', constraint_name: 'service_deliverables_org_contract_name_uq' } }));
      await expect(createDeliverable('org1', base, actor)).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_NAME' });
    });

    it('lets unrelated db errors propagate untouched', async () => {
      queueResult([]); // name pre-check
      queueError({ code: '23503' });
      await expect(createDeliverable('org1', base, actor)).rejects.not.toBeInstanceOf(DeliverableServiceError);
    });
  });

  describe('updateDeliverable', () => {
    it('404s a deliverable outside the org', async () => {
      queueResult([]);
      await expect(updateDeliverable('org1', 'd1', { name: 'x' }, actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(chain.update.mock.calls).toHaveLength(0);
    });

    it('validates a new contract and stamps updatedAt', async () => {
      queueResult([{ id: 'd1', orgId: 'org1', name: base.name, contractId: null }]); // existing
      queueResult([{ id: CONTRACT_ID }]); // contract in org
      queueResult([]); // name pre-check under the new contract
      queueResult([{ id: 'd1' }]); // update returning (in a savepoint)
      queueResult([summaryRow({ contractId: CONTRACT_ID }, 'Managed Services')]); // reload
      queueResult([{ id: 'o1', deliverableId: 'd1', status: 'missed', dueAt: '2020-01-01', deliveredAt: null, deliveryNote: null }]);
      const out = await updateDeliverable('org1', 'd1', { contractId: CONTRACT_ID }, actor);
      expect(chain.transaction.mock.calls).toHaveLength(1);
      expect(lastSet()).toMatchObject({ contractId: CONTRACT_ID });
      expect(lastSet().updatedAt).toBeInstanceOf(Date);
      expect(out).toMatchObject({ contractId: CONTRACT_ID, contractName: 'Managed Services', status: 'missed', nextDue: '2020-01-01', openCount: 1 });
    });

    it('a PATCH that deactivates still resolves the summary (includeInactive) and reports inactive', async () => {
      queueResult([{ id: 'd1', orgId: 'org1', name: base.name, contractId: null }]); // existing
      queueResult([{ id: 'd1' }]); // update returning
      queueResult([summaryRow({ active: false })]); // reload with includeInactive
      queueResult([]);
      const out = await updateDeliverable('org1', 'd1', { active: false }, actor);
      expect(out).toMatchObject({ active: false, status: 'inactive', contractName: null });
    });

    it('404s when the update matches no row', async () => {
      queueResult([{ id: 'd1', orgId: 'org1', name: base.name, contractId: null }]);
      queueResult([]); // update returning nothing
      await expect(updateDeliverable('org1', 'd1', { description: 'x' }, actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });

    it('409s a renamed deliverable colliding with a sibling from the pre-check', async () => {
      queueResult([{ id: 'd1', orgId: 'org1', name: 'old', contractId: null }]);
      queueResult([{ one: 1 }]); // pre-check hit
      await expect(updateDeliverable('org1', 'd1', { name: 'dup' }, actor)).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_NAME' });
      expect(chain.update.mock.calls).toHaveLength(0);
    });

    it('maps 23505 on update → 409 DUPLICATE_NAME (concurrent-writer backstop)', async () => {
      queueResult([{ id: 'd1', orgId: 'org1', name: 'old', contractId: null }]);
      queueResult([]); // pre-check clear
      queueError({ code: '23505' });
      await expect(updateDeliverable('org1', 'd1', { name: 'dup' }, actor)).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_NAME' });
    });
  });

  describe('deactivateDeliverable', () => {
    it('sets active=false and 404s when nothing matched', async () => {
      queueResult([{ id: 'd1' }]);
      await deactivateDeliverable('org1', 'd1', actor);
      expect(lastSet()).toMatchObject({ active: false });
      queueResult([]);
      await expect(deactivateDeliverable('org1', 'd1', actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });
  });

  describe('document evidence (W03)', () => {
    const DOC_ID = '33333333-3333-4333-8333-333333333333';

    it('links a live document of the same org, pinned to that exact version', async () => {
      queueResult([occ({ status: 'open' })]); // load
      queueResult([{ id: DOC_ID }]); // document lookup (org + not deleted)
      queueResult([]); // insert
      queueResult([occ({ status: 'open' })]); // reload
      queueResult([{ id: 'e1', kind: 'document', documentId: DOC_ID, reportId: null, reportRunId: null, createdAt: new Date('2026-10-20T00:00:00Z') }]);
      const view = await addEvidence('org1', 'o1', { kind: 'document', documentId: DOC_ID }, actor);
      expect(lastValues()).toMatchObject({ orgId: 'org1', occurrenceId: 'o1', kind: 'document', documentId: DOC_ID, reportId: null, reportRunId: null, createdByUserId: 'u1' });
      expect(view.evidence[0]).toMatchObject({ kind: 'document', documentId: DOC_ID });
    });

    it('a document of another org (or a deleted one) is 404, not 403, and nothing is inserted', async () => {
      queueResult([occ({ status: 'open' })]);
      queueResult([]); // lookup filtered by org_id + deleted_at IS NULL finds nothing
      await expect(addEvidence('org1', 'o1', { kind: 'document', documentId: DOC_ID }, actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(chain.insert.mock.calls).toHaveLength(0);
      const params = chain.where.mock.calls.flatMap((c) => boundParams(c[0]));
      expect(params).toEqual(expect.arrayContaining([DOC_ID, 'org1']));
    });

    it('delivering with a document evidence ref satisfies artifactRequired', async () => {
      queueResult([occ({ status: 'open', artifactRequired: true })]); // load
      queueResult([{ id: DOC_ID }]); // document lookup
      queueResult([]); // insert
      queueResult([{ n: 1 }]); // evidence count
      queueResult([{ id: 'o1' }]); // update returning
      queueResult([occ({ status: 'delivered', deliveredAt: new Date('2026-10-20T00:00:00Z'), deliveredVia: 'explicit' })]);
      queueResult([{ id: 'e1', kind: 'document', documentId: DOC_ID, reportId: null, reportRunId: null, createdAt: new Date('2026-10-20T00:00:00Z') }]);
      const view = await deliverOccurrence('org1', 'o1', { evidence: [{ kind: 'document', documentId: DOC_ID }] }, actor);
      expect(view.status).toBe('delivered');
      expect(lastSet()).toMatchObject({ status: 'delivered', deliveredVia: 'explicit' });
    });
  });

  describe('getOccurrenceOr404 (W03)', () => {
    it('answers 404 — never 403 — for an occurrence of another org, without a query', async () => {
      await expect(getOccurrenceOr404('org1', 'o1', { ...actor, accessibleOrgIds: ['org9'] })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(chain.select.mock.calls).toHaveLength(0);
    });
    it('404s a missing occurrence', async () => {
      queueResult([]);
      await expect(getOccurrenceOr404('org1', 'o1', actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });
    it('returns the occurrence view with its evidence', async () => {
      queueResult([occ({ status: 'open' })]);
      queueResult([]);
      const view = await getOccurrenceOr404('org1', 'o1', actor);
      expect(view).toMatchObject({ id: 'o1', deliverableId: 'd1', evidence: [] });
      expect(view).not.toHaveProperty('artifactRequired');
    });
  });

  describe('deliverOccurrence', () => {
    it('deliver without required evidence → 400 EVIDENCE_REQUIRED', async () => {
      queueResult([occ({ status: 'open', artifactRequired: true })]); // occurrence+deliverable join
      queueResult([]); // evidence count
      await expect(deliverOccurrence('org1', 'o1', {}, actor)).rejects.toMatchObject({ status: 400, code: 'EVIDENCE_REQUIRED' });
      expect(chain.update.mock.calls).toHaveLength(0);
    });

    it('deliver from a terminal status → 409 INVALID_OCCURRENCE_TRANSITION', async () => {
      queueResult([occ({ status: 'waived', artifactRequired: true })]);
      queueResult([{ n: 3 }]);
      await expect(deliverOccurrence('org1', 'o1', {}, actor)).rejects.toMatchObject({ status: 409, code: 'INVALID_OCCURRENCE_TRANSITION' });
    });

    it('404s an occurrence outside the org', async () => {
      queueResult([]);
      await expect(deliverOccurrence('org1', 'o1', {}, actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });

    it('inserts evidence first, then stamps the explicit delivery inside a transaction', async () => {
      queueResult([occ({ status: 'open', artifactRequired: true })]); // load
      queueResult([{ id: RUN_ID, reportId: 'r1' }]); // run lookup (joined on reports.orgId)
      queueResult([]); // evidence insert
      queueResult([{ n: 1 }]); // evidence count
      queueResult([{ id: 'o1' }]); // update returning
      queueResult([occ({ status: 'delivered', deliveredAt: new Date('2026-10-20T00:00:00Z'), deliveredVia: 'explicit' })]); // reload
      queueResult([{ id: 'e1', kind: 'report_run', documentId: null, reportId: 'r1', reportRunId: RUN_ID, createdAt: new Date('2026-10-20T00:00:00Z') }]); // evidence list
      const view = await deliverOccurrence('org1', 'o1', { note: 'done', evidence: [{ kind: 'report_run', reportRunId: RUN_ID }] }, actor);
      expect(chain.transaction.mock.calls).toHaveLength(1);
      expect(lastValues()).toMatchObject({ orgId: 'org1', occurrenceId: 'o1', kind: 'report_run', reportId: 'r1', reportRunId: RUN_ID, createdByUserId: 'u1' });
      const set = lastSet();
      expect(set).toMatchObject({ status: 'delivered', deliveredByUserId: 'u1', deliveredVia: 'explicit', deliveryNote: 'done' });
      expect(set.deliveredAt).toBeInstanceOf(Date);
      expect(set.updatedAt).toBeInstanceOf(Date);
      expect(updateWhereParams()).toEqual(expect.arrayContaining(['o1', 'org1', 'open']));
      expect(view.status).toBe('delivered');
      expect(view.late).toBe(false);
      expect(view.evidence).toEqual([{ id: 'e1', kind: 'report_run', documentId: null, reportId: 'r1', reportRunId: RUN_ID, createdAt: '2026-10-20T00:00:00.000Z' }]);
      expect(view).not.toHaveProperty('artifactRequired');
    });

    it('delivers without evidence when the artifact is optional', async () => {
      queueResult([occ({ status: 'missed', artifactRequired: false })]);
      queueResult([]); // count → 0
      queueResult([{ id: 'o1' }]); // update returning
      queueResult([occ({ status: 'delivered', artifactRequired: false })]);
      queueResult([]);
      const view = await deliverOccurrence('org1', 'o1', {}, actor);
      expect(lastSet()).toMatchObject({ status: 'delivered', deliveryNote: null });
      expect(updateWhereParams()).toContain('missed');
      expect(view.evidence).toEqual([]);
    });

    it('409s when a concurrent transition made the guarded UPDATE match zero rows', async () => {
      queueResult([occ({ status: 'open', artifactRequired: false })]);
      queueResult([]); // count
      queueResult([]); // update matched nothing (status moved under us)
      await expect(deliverOccurrence('org1', 'o1', {}, actor)).rejects.toMatchObject({ status: 409, code: 'INVALID_OCCURRENCE_TRANSITION' });
      expect(chain.update.mock.calls).toHaveLength(1);
    });
  });

  describe('waiveOccurrence', () => {
    it('requires a non-blank reason', async () => {
      await expect(waiveOccurrence('org1', 'o1', { reason: '   ' }, actor)).rejects.toMatchObject({ status: 400, code: 'REASON_REQUIRED' });
      expect(chain.select.mock.calls).toHaveLength(0);
    });

    it('stamps waivedAt / waivedByUserId / waivedReason', async () => {
      queueResult([occ({ status: 'open' })]);
      queueResult([{ id: 'o1' }]); // update returning
      queueResult([occ({ status: 'waived', waivedReason: 'client declined' })]);
      queueResult([]);
      const view = await waiveOccurrence('org1', 'o1', { reason: 'client declined' }, actor);
      expect(chain.transaction.mock.calls).toHaveLength(1);
      const set = lastSet();
      expect(set).toMatchObject({ status: 'waived', waivedByUserId: 'u1', waivedReason: 'client declined' });
      expect(set.waivedAt).toBeInstanceOf(Date);
      expect(set.updatedAt).toBeInstanceOf(Date);
      expect(updateWhereParams()).toEqual(expect.arrayContaining(['o1', 'org1', 'open']));
      expect(view.status).toBe('waived');
    });

    it('409s when the guarded UPDATE matches zero rows (status moved concurrently)', async () => {
      queueResult([occ({ status: 'missed' })]);
      queueResult([]); // update returning nothing
      await expect(waiveOccurrence('org1', 'o1', { reason: 'x' }, actor)).rejects.toMatchObject({ status: 409, code: 'INVALID_OCCURRENCE_TRANSITION' });
      expect(updateWhereParams()).toContain('missed');
    });

    it('cannot waive a delivered occurrence → 409', async () => {
      queueResult([occ({ status: 'delivered' })]);
      await expect(waiveOccurrence('org1', 'o1', { reason: 'x' }, actor)).rejects.toMatchObject({ status: 409, code: 'INVALID_OCCURRENCE_TRANSITION' });
      expect(chain.update.mock.calls).toHaveLength(0);
    });
  });

  describe('reopenOccurrence', () => {
    it('clears every delivery and waiver field and returns to open', async () => {
      queueResult([occ({ status: 'delivered', deliveredAt: new Date(), deliveredByUserId: 'u1', deliveredVia: 'explicit', deliveryNote: 'n' })]);
      queueResult([{ id: 'o1' }]); // update returning
      queueResult([occ({ status: 'open' })]);
      queueResult([]);
      await reopenOccurrence('org1', 'o1', actor);
      expect(chain.transaction.mock.calls).toHaveLength(1);
      expect(lastSet()).toMatchObject({
        status: 'open', deliveredAt: null, deliveredByUserId: null, deliveredVia: null, deliveryNote: null,
        waivedAt: null, waivedByUserId: null, waivedReason: null,
      });
      expect(lastSet().updatedAt).toBeInstanceOf(Date);
      expect(updateWhereParams()).toEqual(expect.arrayContaining(['o1', 'org1', 'delivered']));
    });

    it('409s when the guarded UPDATE matches zero rows (status moved concurrently)', async () => {
      queueResult([occ({ status: 'waived' })]);
      queueResult([]); // update returning nothing
      await expect(reopenOccurrence('org1', 'o1', actor)).rejects.toMatchObject({ status: 409, code: 'INVALID_OCCURRENCE_TRANSITION' });
      expect(updateWhereParams()).toContain('waived');
    });

    it('cannot reopen an open occurrence → 409', async () => {
      queueResult([occ({ status: 'open' })]);
      await expect(reopenOccurrence('org1', 'o1', actor)).rejects.toMatchObject({ status: 409, code: 'INVALID_OCCURRENCE_TRANSITION' });
    });
  });

  describe('rescheduleOccurrence', () => {
    it('on a waived occurrence → 409', async () => {
      queueResult([occ({ status: 'waived' })]);
      await expect(rescheduleOccurrence('org1', 'o1', { dueAt: '2026-11-30' }, actor)).rejects.toMatchObject({ status: 409, code: 'INVALID_OCCURRENCE_TRANSITION' });
      expect(chain.update.mock.calls).toHaveLength(0);
    });

    it('moves dueAt, keeps originalDueAt, and keeps an open occurrence open', async () => {
      queueResult([occ({ status: 'open' })]);
      queueResult([{ id: 'o1' }]); // update returning
      queueResult([occ({ status: 'open', dueAt: '2026-11-30' })]);
      queueResult([]);
      const view = await rescheduleOccurrence('org1', 'o1', { dueAt: '2026-11-30' }, actor);
      expect(chain.transaction.mock.calls).toHaveLength(1);
      expect(lastSet()).toMatchObject({ dueAt: '2026-11-30', status: 'open' });
      expect(lastSet()).not.toHaveProperty('originalDueAt');
      expect(updateWhereParams()).toEqual(expect.arrayContaining(['o1', 'org1', 'open']));
      expect(view.originalDueAt).toBe('2026-10-31');
    });

    it('409s when the guarded UPDATE matches zero rows (status moved concurrently)', async () => {
      queueResult([occ({ status: 'scheduled' })]);
      queueResult([]); // update returning nothing
      await expect(rescheduleOccurrence('org1', 'o1', { dueAt: '2026-11-30' }, actor)).rejects.toMatchObject({ status: 409, code: 'INVALID_OCCURRENCE_TRANSITION' });
      expect(updateWhereParams()).toContain('scheduled');
    });

    it('a missed occurrence moved inside grace becomes open', async () => {
      const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      queueResult([occ({ status: 'missed', graceDays: 14 })]);
      queueResult([{ id: 'o1' }]);
      queueResult([occ({ status: 'open', dueAt: future })]);
      queueResult([]);
      await rescheduleOccurrence('org1', 'o1', { dueAt: future }, actor);
      expect(lastSet()).toMatchObject({ dueAt: future, status: 'open' });
      expect(updateWhereParams()).toContain('missed'); // guard is the status LOADED, not the one being written
    });

    it('a missed occurrence moved to a date still past grace stays missed', async () => {
      queueResult([occ({ status: 'missed', graceDays: 14 })]);
      queueResult([{ id: 'o1' }]);
      queueResult([occ({ status: 'missed', dueAt: '2020-01-01' })]);
      queueResult([]);
      await rescheduleOccurrence('org1', 'o1', { dueAt: '2020-01-01' }, actor);
      expect(lastSet()).toMatchObject({ dueAt: '2020-01-01', status: 'missed' });
    });
  });

  describe('addEvidence', () => {
    it('with a run of another org\'s report → 404 NOT_FOUND', async () => {
      queueResult([occ({ status: 'open' })]);
      queueResult([]); // run lookup joined on reports.orgId finds nothing
      await expect(addEvidence('org1', 'o1', { kind: 'report_run', reportRunId: RUN_ID }, actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(chain.insert.mock.calls).toHaveLength(0);
    });

    it('on awaiting_evidence completes the ticket-driven delivery', async () => {
      queueResult([occ({ status: 'awaiting_evidence' })]);
      queueResult([{ id: RUN_ID, reportId: 'r1' }]);
      queueResult([]); // insert
      queueResult([{ id: 'o1' }]); // update returning
      queueResult([occ({ status: 'delivered', deliveredVia: 'ticket' })]);
      queueResult([{ id: 'e1', kind: 'report_run', documentId: null, reportId: 'r1', reportRunId: RUN_ID, createdAt: new Date() }]);
      const view = await addEvidence('org1', 'o1', { kind: 'report_run', reportRunId: RUN_ID }, actor);
      expect(lastValues()).toMatchObject({ reportId: 'r1', reportRunId: RUN_ID, kind: 'report_run' });
      const set = lastSet();
      expect(set).toMatchObject({ status: 'delivered', deliveredVia: 'ticket', deliveredByUserId: 'u1' });
      expect(set.deliveredAt).toBeInstanceOf(Date);
      expect(updateWhereParams()).toEqual(expect.arrayContaining(['o1', 'org1', 'awaiting_evidence']));
      expect(view.evidence).toHaveLength(1);
    });

    it('409s when the awaiting_evidence → delivered UPDATE matches zero rows', async () => {
      queueResult([occ({ status: 'awaiting_evidence' })]);
      queueResult([{ id: RUN_ID, reportId: 'r1' }]);
      queueResult([]); // insert
      queueResult([]); // update returning nothing
      await expect(addEvidence('org1', 'o1', { kind: 'report_run', reportRunId: RUN_ID }, actor)).rejects.toMatchObject({ status: 409, code: 'INVALID_OCCURRENCE_TRANSITION' });
    });

    it('an evidence kind the service does not know → 500 UNSUPPORTED_EVIDENCE_KIND, nothing inserted', async () => {
      queueResult([occ({ status: 'open' })]);
      // W03 made 'document' a real kind; the exhaustive guard is still pinned
      // with a kind that exists in neither the enum nor the union.
      await expect(addEvidence('org1', 'o1', { kind: 'ticket', ticketId: 'x' } as never, actor))
        .rejects.toMatchObject({ status: 500, code: 'UNSUPPORTED_EVIDENCE_KIND' });
      expect(chain.insert.mock.calls).toHaveLength(0);
    });

    it('on an open occurrence records evidence without changing status', async () => {
      queueResult([occ({ status: 'open' })]);
      queueResult([{ id: RUN_ID, reportId: 'r1' }]);
      queueResult([]); // insert
      queueResult([occ({ status: 'open' })]);
      queueResult([]);
      const view = await addEvidence('org1', 'o1', { kind: 'report_run', reportRunId: RUN_ID }, actor);
      expect(chain.update.mock.calls).toHaveLength(0);
      expect(view.status).toBe('open');
    });
  });

  describe('removeEvidence', () => {
    it('leaving a delivered + artifactRequired occurrence with zero evidence → 409 EVIDENCE_REQUIRED', async () => {
      queueResult([occ({ status: 'delivered', artifactRequired: true })]);
      queueResult([{ id: 'e1' }]); // the only evidence row
      await expect(removeEvidence('org1', 'o1', 'e1', actor)).rejects.toMatchObject({ status: 409, code: 'EVIDENCE_REQUIRED' });
      expect(chain.delete.mock.calls).toHaveLength(0);
    });

    it('404s an evidence id that is not on the occurrence', async () => {
      queueResult([occ({ status: 'open' })]);
      queueResult([{ id: 'e2' }]);
      await expect(removeEvidence('org1', 'o1', 'e1', actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });

    it('deletes when other evidence remains', async () => {
      queueResult([occ({ status: 'delivered', artifactRequired: true })]);
      queueResult([{ id: 'e1' }, { id: 'e2' }]);
      queueResult([]); // delete
      queueResult([occ({ status: 'delivered' })]);
      queueResult([{ id: 'e2', kind: 'report_run', documentId: null, reportId: 'r1', reportRunId: RUN_ID, createdAt: new Date() }]);
      const view = await removeEvidence('org1', 'o1', 'e1', actor);
      expect(chain.delete.mock.calls).toHaveLength(1);
      expect(view.evidence.map((e) => e.id)).toEqual(['e2']);
    });
  });

  describe('listOccurrences / OccurrenceView.late', () => {
    it('404s a deliverable outside the org', async () => {
      queueResult([]);
      await expect(listOccurrences('org1', 'd1', { limit: 5 }, actor)).rejects.toMatchObject({ status: 404 });
    });

    it('marks overdue open and late-delivered occurrences late, groups evidence per occurrence', async () => {
      queueResult([{ id: 'd1' }]);
      queueResult([
        occ({ id: 'o1', status: 'open', dueAt: '2020-01-01' }),
        occ({ id: 'o2', status: 'delivered', dueAt: '2020-01-01', deliveredAt: new Date('2020-01-05T00:00:00Z') }),
        occ({ id: 'o3', status: 'delivered', dueAt: '2020-01-10', deliveredAt: new Date('2020-01-05T00:00:00Z') }),
        occ({ id: 'o4', status: 'waived', dueAt: '2020-01-01' }),
        occ({ id: 'o5', status: 'scheduled', dueAt: '2999-01-01' }),
      ]);
      queueResult([{ id: 'e1', occurrenceId: 'o2', kind: 'report_run', documentId: null, reportId: 'r1', reportRunId: RUN_ID, createdAt: new Date() }]);
      const views = await listOccurrences('org1', 'd1', { limit: 5 }, actor);
      expect(chain.limit.mock.calls.at(-1)).toEqual([5]);
      expect(views.map((v) => [v.id, v.late])).toEqual([['o1', true], ['o2', true], ['o3', false], ['o4', false], ['o5', false]]);
      expect(views[1]?.evidence).toHaveLength(1);
      expect(views[0]?.evidence).toEqual([]);
    });
  });

  describe('getDeliverable summary', () => {
    it('derives contractName, nextDue, lastDelivered and openCount', async () => {
      queueResult([{
        deliverable: { id: 'd1', orgId: 'org1', ...base, active: true, effectiveUntil: null, contractId: CONTRACT_ID },
        contractName: 'Managed Services',
      }]);
      queueResult([
        { id: 'o1', deliverableId: 'd1', status: 'open', dueAt: '2026-11-30', deliveredAt: null, deliveryNote: null },
        { id: 'o2', deliverableId: 'd1', status: 'scheduled', dueAt: '2026-12-31', deliveredAt: null, deliveryNote: null },
        { id: 'o3', deliverableId: 'd1', status: 'delivered', dueAt: '2026-09-30', deliveredAt: new Date('2026-10-02T00:00:00Z'), deliveryNote: 'late one' },
        { id: 'o4', deliverableId: 'd1', status: 'delivered', dueAt: '2026-08-31', deliveredAt: new Date('2026-08-30T00:00:00Z'), deliveryNote: null },
      ]);
      const s = await getDeliverable('org1', 'd1', actor);
      expect(s.contractName).toBe('Managed Services');
      expect(s.nextDue).toBe('2026-11-30');
      expect(s.lastDelivered).toEqual({ at: '2026-10-02T00:00:00.000Z', late: true, note: 'late one' });
      expect(s.openCount).toBe(1);
      expect(s.name).toBe(base.name);
    });

    it('a deliverable with no occurrences has null nextDue/lastDelivered and skips the occurrence query', async () => {
      queueResult([{ deliverable: { id: 'd1', orgId: 'org1', ...base, active: true, effectiveUntil: null, contractId: null }, contractName: null }]);
      queueResult([]);
      const s = await getDeliverable('org1', 'd1', actor);
      expect(s).toMatchObject({ contractName: null, nextDue: null, lastDelivered: null, openCount: 0 });
    });
  });

  describe('summarizeStatus', () => {
    const d = { active: true, effectiveFrom: '2026-01-01', effectiveUntil: null, leadDays: 7 };
    const today = '2026-10-15';

    it('inactive when !active or today outside the effective range', () => {
      expect(summarizeStatus({ ...d, active: false }, [{ status: 'missed', dueAt: '2026-10-01' }], today)).toBe('inactive');
      expect(summarizeStatus({ ...d, effectiveFrom: '2026-11-01' }, [], today)).toBe('inactive');
      expect(summarizeStatus({ ...d, effectiveUntil: '2026-10-14' }, [], today)).toBe('inactive');
      expect(summarizeStatus({ ...d, effectiveUntil: '2026-10-15' }, [], today)).toBe('on_track');
    });
    it('missed beats late', () => {
      expect(summarizeStatus(d, [{ status: 'missed', dueAt: '2026-09-01' }, { status: 'open', dueAt: '2026-10-01' }], today)).toBe('missed');
    });
    it('late when an open or awaiting_evidence occurrence is past due', () => {
      expect(summarizeStatus(d, [{ status: 'open', dueAt: '2026-10-14' }], today)).toBe('late');
      expect(summarizeStatus(d, [{ status: 'awaiting_evidence', dueAt: '2026-10-14' }], today)).toBe('late');
      expect(summarizeStatus(d, [{ status: 'delivered', dueAt: '2026-10-01' }], today)).toBe('on_track');
    });
    it('due_soon when an open occurrence is inside the lead window', () => {
      expect(summarizeStatus(d, [{ status: 'open', dueAt: '2026-10-22' }], today)).toBe('due_soon');
      expect(summarizeStatus(d, [{ status: 'open', dueAt: '2026-10-23' }], today)).toBe('on_track');
    });
    it('on_track otherwise (scheduled far out, delivered, waived)', () => {
      expect(summarizeStatus(d, [{ status: 'scheduled', dueAt: '2026-12-31' }, { status: 'waived', dueAt: '2026-09-01' }], today)).toBe('on_track');
    });
  });

  describe('applyTicketStatusChange (spec §6)', () => {
    const occRow = (over: Record<string, unknown> = {}) => ({ id: 'o1', status: 'open',
      deliveredVia: null, artifactRequired: true, completionMode: 'on_ticket_resolve', ...over });

    it('resolve with evidence delivers via ticket and copies the resolution note and actor', async () => {
      queueResult([occRow()]); queueResult([{ id: 'e1' }]); queueResult([{ id: 'o1' }]);
      await applyTicketStatusChange({ ticketId: 't1', orgId: 'org1', to: 'resolved', actorUserId: 'u7', resolutionNote: 'done' });
      expect(lastSet()).toMatchObject({ status: 'delivered', deliveredVia: 'ticket', deliveredByUserId: 'u7', deliveryNote: 'done' });
      expect(lastSet().deliveredAt).toBeInstanceOf(Date);
      // CAS on the status the decision was made from.
      expect(updateWhereParams()).toEqual(expect.arrayContaining(['o1', 'open']));
    });

    it('resolve without an artifact requirement delivers even with no evidence', async () => {
      queueResult([occRow({ artifactRequired: false })]); queueResult([]); queueResult([{ id: 'o1' }]);
      await applyTicketStatusChange({ ticketId: 't1', orgId: 'org1', to: 'closed', actorUserId: 'u7', resolutionNote: null });
      expect(lastSet()).toMatchObject({ status: 'delivered', deliveredVia: 'ticket' });
    });

    it('resolve with artifact required and no evidence goes to awaiting_evidence, keeping the note but stamping no delivery', async () => {
      queueResult([occRow()]); queueResult([]); queueResult([{ id: 'o1' }]);
      await applyTicketStatusChange({ ticketId: 't1', orgId: 'org1', to: 'closed', actorUserId: 'u7', resolutionNote: 'Reviewed' });
      const patch = lastSet();
      expect(patch).toMatchObject({ status: 'awaiting_evidence', deliveryNote: 'Reviewed' });
      expect(patch.deliveredAt).toBeUndefined();
      expect(patch.deliveredByUserId).toBeUndefined();
      expect(patch.deliveredVia).toBeUndefined();
    });

    it('a late resolution of a missed occurrence still records the delivery', async () => {
      queueResult([occRow({ status: 'missed' })]); queueResult([{ id: 'e1' }]); queueResult([{ id: 'o1' }]);
      await applyTicketStatusChange({ ticketId: 't1', orgId: 'org1', to: 'resolved', actorUserId: 'u7', resolutionNote: 'late' });
      expect(lastSet()).toMatchObject({ status: 'delivered' });
      expect(updateWhereParams()).toEqual(expect.arrayContaining(['o1', 'missed']));
    });

    it('explicit completion mode changes nothing', async () => {
      queueResult([occRow({ completionMode: 'explicit' })]); queueResult([]);
      await applyTicketStatusChange({ ticketId: 't1', orgId: 'org1', to: 'resolved', actorUserId: 'u7', resolutionNote: 'x' });
      expect(chain.update.mock.calls).toHaveLength(0);
    });

    it('a reopen undoes a ticket-driven delivery and clears the delivery fields', async () => {
      queueResult([occRow({ status: 'delivered', deliveredVia: 'ticket' })]); queueResult([{ id: 'o1' }]);
      await applyTicketStatusChange({ ticketId: 't1', orgId: 'org1', to: 'open', actorUserId: 'u7', resolutionNote: null });
      expect(lastSet()).toMatchObject({ status: 'open', deliveredAt: null, deliveredByUserId: null, deliveredVia: null, deliveryNote: null });
    });

    it('a reopen NEVER undoes an explicit delivery', async () => {
      queueResult([occRow({ status: 'delivered', deliveredVia: 'explicit' })]);
      await applyTicketStatusChange({ ticketId: 't1', orgId: 'org1', to: 'open', actorUserId: 'u7', resolutionNote: null });
      expect(chain.update.mock.calls).toHaveLength(0);
    });

    it('is idempotent — a redelivery of an already-delivered occurrence is a no-op', async () => {
      queueResult([occRow({ status: 'delivered', deliveredVia: 'ticket' })]); queueResult([{ id: 'e1' }]);
      await applyTicketStatusChange({ ticketId: 't1', orgId: 'org1', to: 'resolved', actorUserId: 'u7', resolutionNote: 'done' });
      expect(chain.update.mock.calls).toHaveLength(0);
    });

    it('ignores a ticket no occurrence is linked to, and statuses that are neither resolved nor reopened', async () => {
      queueResult([]);
      await applyTicketStatusChange({ ticketId: 't1', orgId: 'org1', to: 'resolved', actorUserId: 'u7', resolutionNote: null });
      queueResult([occRow()]);
      await applyTicketStatusChange({ ticketId: 't1', orgId: 'org1', to: 'some_custom', actorUserId: 'u7', resolutionNote: null });
      expect(chain.update.mock.calls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // W02 — sweep (system callers)
  // -------------------------------------------------------------------------

  const DEF = { id: 'd1', orgId: 'org1', name: 'Sign-in log review', cadence: 'monthly',
    effectiveFrom: '2026-10-01', effectiveUntil: null, leadDays: 7, graceDays: 14 };
  const SD = { ...DEF, cadence: 'monthly' as const, anchorDueDate: '2026-10-31', autoEvidenceReportId: null };
  const lastValuesArray = () => chain.values.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>;

  describe('materializeOccurrences (spec §5.3 step 1)', () => {
    it('inserts one row per planned due date with the name snapshot', async () => {
      queueResult([{ ...DEF, anchorDueDate: '2026-10-31' }]);
      queueResult([]);                         // existing due dates: none
      queueResult([{ id: 'o1' }]);             // insert ... returning
      expect(await materializeOccurrences('d1', '2026-10-25')).toHaveLength(1);
      const values = lastValuesArray();
      expect(values).toHaveLength(1);
      expect(values[0]).toMatchObject({
        orgId: 'org1', deliverableId: 'd1', nameSnapshot: 'Sign-in log review',
        periodStart: '2026-10-01', periodEnd: '2026-10-31',
        dueAt: '2026-10-31', originalDueAt: '2026-10-31', status: 'scheduled',
      });
    });

    it('inserts catch-up occurrences past grace directly as missed, capped at 12', async () => {
      queueResult([{ ...DEF, anchorDueDate: '2025-01-31', effectiveFrom: '2025-01-01' }]);
      queueResult([]);
      queueResult([{ id: 'o1' }]);
      await materializeOccurrences('d1', '2026-10-25');
      const values = lastValuesArray();
      expect(values).toHaveLength(12);
      expect(values[0]).toMatchObject({ dueAt: '2025-01-31', status: 'missed' });
      expect(values.every((v) => v.status === 'missed')).toBe(true);   // cap reached long before today
    });

    it('marks only the rows past grace as missed in a short catch-up', async () => {
      queueResult([{ ...DEF, anchorDueDate: '2026-08-31', effectiveFrom: '2026-08-01' }]);
      queueResult([]);
      queueResult([{ id: 'o1' }]);
      await materializeOccurrences('d1', '2026-10-25');
      expect(lastValuesArray().map((v) => [v.dueAt, v.status])).toEqual([
        ['2026-08-31', 'missed'], ['2026-09-30', 'missed'], ['2026-10-31', 'scheduled'],
      ]);
    });

    it('is a no-op when every due date is already materialized (keyed on the ORIGINAL due date)', async () => {
      queueResult([{ ...DEF, anchorDueDate: '2026-10-31' }]);
      // A rescheduled occurrence: its due_at moved, original_due_at still names the slot.
      queueResult([{ originalDueAt: '2026-10-31' }]);
      expect(await materializeOccurrences('d1', '2026-10-25')).toEqual([]);
      expect(chain.insert.mock.calls).toHaveLength(0);
    });

    it('throws NOT_FOUND for a deliverable that no longer exists', async () => {
      queueResult([]);
      await expect(materializeOccurrences('gone', '2026-10-25')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });
  });

  describe('markDueOccurrencesMissedForDeliverable (spec §5.3 step 4)', () => {
    it('moves open / awaiting_evidence rows past grace to missed and never touches the ticket', async () => {
      queueResult([{ id: 'o1' }, { id: 'o2' }]);
      expect(await markDueOccurrencesMissedForDeliverable(SD, '2026-10-25')).toBe(2);
      const patch = lastSet();
      expect(patch).toMatchObject({ status: 'missed' });
      expect(patch).not.toHaveProperty('ticketId');
      // cutoff = today - graceDays: due_at < 2026-10-11 ⇔ due_at + 14 < 2026-10-25
      const params = updateWhereParams();
      expect(params).toEqual(expect.arrayContaining(['d1', 'open', 'awaiting_evidence', '2026-10-11']));
      expect(params).not.toContain('scheduled');
    });
  });

  describe('applyContractCancelledToDeliverables (spec §5.4)', () => {
    it('closes the effective window of every open-ended deliverable on the contract', async () => {
      queueResult([{ id: 'c1', status: 'cancelled' }]); queueResult([{ id: 'd1' }, { id: 'd2' }]);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(await applyContractCancelledToDeliverables('c1', '2026-09-10')).toBe(2);
      } finally { log.mockRestore(); }
      expect(lastSet()).toMatchObject({ effectiveUntil: '2026-09-10' });
      expect(updateWhereParams()).toContain('c1');
    });

    it('does nothing when the contract is no longer cancelled (a replayed or reversed event)', async () => {
      queueResult([{ id: 'c1', status: 'active' }]);
      expect(await applyContractCancelledToDeliverables('c1', '2026-09-10')).toBe(0);
      expect(chain.update.mock.calls).toHaveLength(0);
    });

    it('does nothing for a paused or expired contract (neither ends the service)', async () => {
      queueResult([{ id: 'c1', status: 'paused' }]);
      expect(await applyContractCancelledToDeliverables('c1', '2026-09-10')).toBe(0);
      queueResult([{ id: 'c1', status: 'expired' }]);
      expect(await applyContractCancelledToDeliverables('c1', '2026-09-10')).toBe(0);
      expect(chain.update.mock.calls).toHaveLength(0);
    });

    it('does nothing for a contract that no longer exists', async () => {
      queueResult([]);
      expect(await applyContractCancelledToDeliverables('gone', '2026-09-10')).toBe(0);
    });

    it('never overwrites an effective_until the MSP already set', async () => {
      queueResult([{ id: 'c1', status: 'cancelled' }]); queueResult([]);   // IS NULL predicate matched nothing
      expect(await applyContractCancelledToDeliverables('c1', '2026-09-10')).toBe(0);
      const { PgDialect } = await import('drizzle-orm/pg-core');
      const setOrder = chain.set.mock.invocationCallOrder.at(-1)!;
      const i = chain.where.mock.invocationCallOrder.findIndex((o) => o > setOrder);
      expect(new PgDialect().sqlToQuery(chain.where.mock.calls[i]![0] as SQL).sql).toContain('"effective_until" is null');
    });
  });

  describe('periodLabel', () => {
    it('labels each cadence from the period end', () => {
      expect(periodLabel('monthly', '2026-10-31')).toBe('Oct 2026');
      expect(periodLabel('one_time', '2026-02-15')).toBe('Feb 2026');
      expect(periodLabel('quarterly', '2026-12-31')).toBe('Q4 2026');
      expect(periodLabel('quarterly', '2026-03-31')).toBe('Q1 2026');
      expect(periodLabel('semiannual', '2026-06-30')).toBe('H1 2026');
      expect(periodLabel('semiannual', '2026-12-31')).toBe('H2 2026');
      expect(periodLabel('annual', '2027-03-01')).toBe('2027');
    });
  });

  describe('openOccurrence (single-row form)', () => {
    it('opens a scheduled row and links the ticket', async () => {
      queueResult([]);
      await openOccurrence('o1', 't1');
      expect(lastSet()).toMatchObject({ status: 'open', ticketId: 't1' });
      expect(updateWhereParams()).toEqual(expect.arrayContaining(['o1', 'scheduled']));
    });
    it('opens without touching ticket_id when no ticket was created', async () => {
      queueResult([]);
      await openOccurrence('o1', null);
      expect(lastSet()).not.toHaveProperty('ticketId');
    });
  });

  describe('openDueOccurrencesForDeliverable (spec §5.3 step 2)', () => {
    const OCC = { id: 'o1', nameSnapshot: 'Sign-in log review', periodStart: '2026-10-01', periodEnd: '2026-10-31', dueAt: '2026-10-31' };
    /** candidates, claim, config */
    const seedOpen = (claim: unknown[], cfg: Record<string, unknown>) => {
      queueResult([OCC]); queueResult(claim); queueResult([cfg]);
    };
    const NO_CFG = { ownerUserId: null, ticketCategoryId: null, description: null };

    it('creates an SLA-free deliverable ticket and links it to the claimed occurrence', async () => {
      seedOpen([{ id: 'o1' }], { ownerUserId: 'u1', ticketCategoryId: 'c1', description: 'Review sign-in logs' });
      createTicketMock.mockResolvedValue({ id: 't1' });
      expect(await openDueOccurrencesForDeliverable(SD, '2026-10-25', new Set())).toBe(1);
      expect(createTicketMock).toHaveBeenCalledWith(expect.objectContaining({
        orgId: 'org1', source: 'api', workKind: 'deliverable',
        subject: 'Sign-in log review — Oct 2026', description: 'Review sign-in logs',
        dueDate: new Date('2026-10-31T00:00:00.000Z'), assigneeId: 'u1', categoryId: 'c1',
      }), expect.objectContaining({ userId: expect.any(String) }));
      // The claim UPDATE is CAS'd on 'scheduled' ...
      const claimSet = chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(claimSet).toMatchObject({ status: 'open' });
      expect(claimSet).not.toHaveProperty('ticketId');
      // ... and the link UPDATE writes the ticket.
      expect(lastSet()).toMatchObject({ ticketId: 't1' });
    });

    it('leaves the occurrence open with a null ticket when Service Management is off, warning once per org', async () => {
      const warned = new Set<string>();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        seedOpen([{ id: 'o1' }], NO_CFG);
        createTicketMock.mockRejectedValue(Object.assign(new Error('off'), { code: 'service_management_off' }));
        expect(await openDueOccurrencesForDeliverable(SD, '2026-10-25', warned)).toBe(1);  // the occurrence IS open
        expect(chain.set.mock.calls).toHaveLength(1);                                     // claim only, no link
        expect(warn).toHaveBeenCalledTimes(1);
        seedOpen([{ id: 'o1' }], NO_CFG);
        await openDueOccurrencesForDeliverable(SD, '2026-10-25', warned);
        expect(warn).toHaveBeenCalledTimes(1);                                            // once per org per run
      } finally { warn.mockRestore(); }
    });

    it('counts no open for any other ticket failure — that occurrence\'s claim rolls back and retries tomorrow', async () => {
      seedOpen([{ id: 'o1' }], NO_CFG);
      createTicketMock.mockRejectedValue(new Error('connection reset'));
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await openDueOccurrencesForDeliverable(SD, '2026-10-25', new Set())).toBe(0);
        expect(err).toHaveBeenCalledWith(expect.stringContaining('opening an occurrence failed'),
          'orgId=org1', 'deliverableId=d1', 'occurrenceId=o1', 'connection reset');
      } finally { err.mockRestore(); }
    });

    it('one failing occurrence never costs the deliverable its other occurrences', async () => {
      queueResult([OCC, { ...OCC, id: 'o2' }]);
      queueResult([{ id: 'o1' }]); queueResult([NO_CFG]);          // o1: claim + config
      createTicketMock.mockRejectedValueOnce(new Error('connection reset'));
      queueResult([{ id: 'o2' }]); queueResult([NO_CFG]);          // o2: claim + config
      createTicketMock.mockResolvedValueOnce({ id: 't2' });
      queueResult([]);                                            // o2: link
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await openDueOccurrencesForDeliverable(SD, '2026-10-25', new Set())).toBe(1);
      } finally { err.mockRestore(); }
      expect(lastSet()).toMatchObject({ ticketId: 't2' });
    });

    it('drops an owner and a category the ticket service refuses instead of stalling forever', async () => {
      seedOpen([{ id: 'o1' }], { ownerUserId: 'u-gone', ticketCategoryId: 'c-gone', description: null });
      createTicketMock
        .mockRejectedValueOnce(Object.assign(new Error('wrong partner'), { code: 'ASSIGNEE_WRONG_PARTNER' }))
        .mockRejectedValueOnce(Object.assign(new Error('no category'), { code: 'CATEGORY_NOT_FOUND' }))
        .mockResolvedValueOnce({ id: 't1' });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(await openDueOccurrencesForDeliverable(SD, '2026-10-25', new Set())).toBe(1);
        expect(createTicketMock).toHaveBeenCalledTimes(3);
        const input = createTicketMock.mock.calls[2]![0] as Record<string, unknown>;
        expect(input.assigneeId).toBeUndefined();
        expect(input.categoryId).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(2);
        expect(lastSet()).toMatchObject({ ticketId: 't1' });
      } finally { warn.mockRestore(); }
    });

    it('does not loop when the refusal names a reference that is already absent', async () => {
      seedOpen([{ id: 'o1' }], NO_CFG);
      createTicketMock.mockRejectedValue(Object.assign(new Error('wrong partner'), { code: 'ASSIGNEE_WRONG_PARTNER' }));
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await openDueOccurrencesForDeliverable(SD, '2026-10-25', new Set())).toBe(0);
      } finally { err.mockRestore(); }
      expect(createTicketMock).toHaveBeenCalledTimes(1);      // rethrown, not retried forever
    });

    it('stops retrying once each refused reference has been dropped once', async () => {
      seedOpen([{ id: 'o1' }], { ownerUserId: 'u1', ticketCategoryId: 'c1', description: null });
      createTicketMock.mockRejectedValue(Object.assign(new Error('wrong partner'), { code: 'ASSIGNEE_WRONG_PARTNER' }));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await openDueOccurrencesForDeliverable(SD, '2026-10-25', new Set())).toBe(0);
      } finally { warn.mockRestore(); err.mockRestore(); }
      // attempt 1 with the assignee, attempt 2 without it, then the same code
      // names nothing left to drop and the error propagates.
      expect(createTicketMock).toHaveBeenCalledTimes(2);
    });

    it('retries once without an assignee createTicket still refuses (e.g. deactivated user)', async () => {
      seedOpen([{ id: 'o1' }], { ownerUserId: 'u-off', ticketCategoryId: 'c1', description: null });
      createTicketMock
        .mockRejectedValueOnce(Object.assign(new Error('not eligible'), { code: 'ASSIGNEE_NOT_ELIGIBLE' }))
        .mockResolvedValueOnce({ id: 't2' });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(await openDueOccurrencesForDeliverable(SD, '2026-10-25', new Set())).toBe(1);
        expect(createTicketMock).toHaveBeenCalledTimes(2);
        const retry = createTicketMock.mock.calls[1]![0] as Record<string, unknown>;
        expect(retry.assigneeId).toBeUndefined();
        expect(retry.categoryId).toBe('c1');
        expect(lastSet()).toMatchObject({ ticketId: 't2' });
      } finally { warn.mockRestore(); }
    });

    it('skips an occurrence another sweep already claimed', async () => {
      queueResult([OCC]); queueResult([]);             // claim returned 0 rows
      expect(await openDueOccurrencesForDeliverable(SD, '2026-10-25', new Set())).toBe(0);
      expect(createTicketMock).not.toHaveBeenCalled();
    });

    it('never opens an occurrence outside its lead window', async () => {
      queueResult([{ ...OCC, dueAt: '2026-12-31' }]);
      expect(await openDueOccurrencesForDeliverable(SD, '2026-10-25', new Set())).toBe(0);
      expect(chain.update.mock.calls).toHaveLength(0);
    });
  });

  describe('markOccurrenceMissed (single-row form)', () => {
    it('only moves an open or awaiting_evidence row', async () => {
      queueResult([]);
      await markOccurrenceMissed('o1');
      expect(lastSet()).toMatchObject({ status: 'missed' });
      expect(updateWhereParams()).toEqual(expect.arrayContaining(['o1', 'open', 'awaiting_evidence']));
    });
  });
});
