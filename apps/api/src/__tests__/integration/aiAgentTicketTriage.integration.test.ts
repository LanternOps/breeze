/**
 * Live-Postgres proof for the Phase 2 wave P2-4 (#4191) ticket-triage
 * end-to-end pipeline (Task A10):
 *
 *  1. Admission: `ticketHelpdeskSubscriber.ts`'s `handleTicketCreatedEvent`
 *     admits exactly one `profile: 'triage'` run per ticket, even under a
 *     duplicate event delivery (`ticket-created:<ticketId>` dedupe key) —
 *     the same "real rows, real dedupe CAS" argument
 *     `aiAgentSweepFanout.integration.test.ts`'s header makes for its own
 *     schedule tick, just for the ticket-trigger admission path instead.
 *  2. Proposal -> intents: `persistTicketTriage` (ticketTriageFindings.ts),
 *     driven against a REAL agent/org/ticket, proves the creation-time
 *     `ticket_autonomy` grant is a property of live rows —
 *     `createActionIntent`'s internal `evaluateTicketAutonomy` gate re-reads
 *     the run's own `policy_snapshot` AND does a LIVE
 *     `resolveEffectiveAgentSystem` re-check; no mocked-`../../db` unit
 *     suite can exercise either read.
 *  3. Release: `releaseApprovedIntent` (intentReleaseWorker.ts) executes an
 *     approved `manage_tickets` intent through the SAME `executeTool`
 *     dispatch a live chat session uses — proving the CAS field update +
 *     `field_provenance` stamp (`applyAiFieldUpdates`), the AI note's
 *     `origin_principal_kind='ai_agent'` + `agent_run_id` + one-note-per-run
 *     idempotency (`addAiTriageNote`), and the `draft` executor's
 *     `ticket_drafts` write are all real DB effects, not mocked returns.
 *  4. The two fail-closed edges the brief calls out: a human `field_provenance`
 *     stamp blocks the AI's own field write (never overwritten), and a
 *     ticket closed between intent creation and release fails the release
 *     with `agent_scope_lost` (`actorContext.ts`'s ticket-scope re-check) —
 *     the intent completes `failed`, not silently dropped.
 *
 * Lives under `src/__tests__/integration/` so both vitest configs' wholesale
 * globs pick it up (anywhere else runs in ZERO CI jobs — see
 * intentFanout.integration.test.ts's header for the full rationale).
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { AiAgentPolicySnapshot, TicketTriageProposal } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
  aiAgentRuns,
  aiAgents,
  ticketComments,
  ticketDrafts,
  tickets,
} from '../../db/schema';
import { assignUserToOrganization, createOrganization, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import { resolveEffectiveAgentSystem } from '../../services/aiAgents/effectivePolicy';
import { handleTicketCreatedEvent } from '../../services/aiAgents/ticketHelpdeskSubscriber';
import { registerAgentRunEnqueuer, type AgentRunEnqueuer } from '../../services/aiAgents/runService';
import { persistTicketTriage } from '../../services/aiAgents/ticketTriageFindings';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import type { BreezeEvent } from '../../services/eventBus';

// publishEvent writes to a Redis stream — spy on it so admission/release
// don't depend on a stream consumer existing (same precedent as
// aiAgentSweepFanout.integration.test.ts / agentRunAdmission.integration.test.ts).
const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

vi.hoisted(() => {
  process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
});

/** Wide caps on purpose — every skip/deny this suite asserts must be the
 *  one thing the test is about, never an incidental rate/budget trip. */
function policyFields(ticketAutonomousWrites: boolean) {
  return {
    enabled: true,
    mode: 'act' as const,
    model: null,
    toolAllowlist: ['manage_tickets'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: {},
    triggers: { ticketAutonomousWrites },
    recipients: { userIds: [], roleIds: [] },
    instructions: null,
    cooldownSeconds: 0,
  };
}

interface TriageScenario {
  partner: { id: string };
  org: { id: string };
  creator: { id: string };
  /** The PARTNER baseline row's id — resolveEffectiveAgentInner always
   *  returns the baseline row's id as `agentId`, even though the org
   *  override row is what actually supplies `ticketAutonomousWrites`
   *  (see effectivePolicy.ts: that field is read from the org's OWN
   *  override ONLY, never inherited from the partner baseline). */
  agentId: string;
}

/**
 * Seeds a partner-wide `helpdesk` baseline (mode act, no autonomy — ignored
 * anyway, effectivePolicy.ts never reads `ticketAutonomousWrites` off the
 * partner layer) plus an ORG OVERRIDE row that is the only thing able to
 * flip `ticketAutonomousWrites` on. This is the "act + toggle via org
 * override" shape the brief names.
 */
async function seedTriageScenario(orgAutonomy: boolean): Promise<TriageScenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const creator = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `triage-creator-${randomUUID()}@ticket-triage.test`,
  });

  const [baseline] = await withSystemDbAccessContext(() =>
    db.insert(aiAgents).values({
      partnerId: partner.id,
      orgId: null,
      kind: 'helpdesk',
      name: 'Helpdesk Baseline',
      ...policyFields(false),
      createdBy: creator.id,
    }).returning(),
  );
  await withSystemDbAccessContext(() =>
    db.insert(aiAgents).values({
      partnerId: null,
      orgId: org.id,
      kind: 'helpdesk',
      name: 'Helpdesk Org Override',
      ...policyFields(orgAutonomy),
      createdBy: creator.id,
    }).returning(),
  );

  // An eligible human approver for the "human path" (autonomy off) scenario:
  // resolveAgentIntentApprovers (intentApprovers.ts) requires an ACTIVE org
  // member who holds the tool's full RBAC mapping — `manage_tickets`'s
  // `comment`/`update_fields` both map to `tickets:write` (aiGuardrails.ts).
  // `link_device`/`draft` deliberately map to `tickets:update`, which NO
  // seeded role ever grants (aiGuardrails.ts's own comment: those two are
  // agent-only executors, reachable only via the ticket_autonomy release
  // path) — so no grant here can ever make a draft/link_device intent land
  // pending_approval; that is real, documented, by-design behavior.
  const approverRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(approverRole.id, [{ resource: 'tickets', action: 'write' }]);
  const approver = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `triage-approver-${randomUUID()}@ticket-triage.test`,
  });
  await assignUserToOrganization(approver.id, org.id, approverRole.id);

  return { partner, org, creator: { id: creator.id }, agentId: baseline!.id };
}

async function seedTicket(
  scenario: TriageScenario,
  overrides: Partial<typeof tickets.$inferInsert> = {},
): Promise<typeof tickets.$inferSelect> {
  const adminDb = getTestDb() as any;
  const unique = randomUUID().slice(0, 8);
  const [ticket] = await adminDb.insert(tickets).values({
    orgId: scenario.org.id,
    partnerId: scenario.partner.id,
    ticketNumber: `TRIAGE-${unique}`,
    subject: 'Printer offline for accounting team',
    source: 'manual',
    priority: 'normal',
    ...overrides,
  }).returning();
  return ticket;
}

/** Live re-resolve — the SAME function admission/finalize use — so the
 *  seeded run's `policySnapshot` is byte-identical to what real admission
 *  would have produced (never hand-typed, so it can never silently drift
 *  from the real merge/normalize logic under test). */
async function seedTicketTriageRun(
  scenario: TriageScenario,
  ticketId: string,
): Promise<{ id: string; orgId: string; agentId: string; ticketId: string; policySnapshot: AiAgentPolicySnapshot }> {
  const resolved = await withSystemDbAccessContext(() => resolveEffectiveAgentSystem(scenario.org.id, 'helpdesk'));
  if (!resolved) throw new Error('test setup: helpdesk agent did not resolve');

  const [run] = await withSystemDbAccessContext(() =>
    db.insert(aiAgentRuns).values({
      agentId: resolved.agentId,
      orgId: scenario.org.id,
      ticketId,
      triggerKind: 'ticket',
      dedupeKey: `triage-release-${randomUUID()}`,
      modeAtStart: resolved.effective.mode === 'act' && resolved.effective.triggers.ticketAutonomousWrites === true
        ? 'act'
        : 'shadow',
      policySnapshot: resolved as never,
      profile: 'triage',
    }).returning(),
  );

  return { id: run!.id, orgId: scenario.org.id, agentId: resolved.agentId, ticketId, policySnapshot: resolved };
}

function agentAuthFor(scenario: TriageScenario, run: { id: string; orgId: string }) {
  return buildAgentAuthContext(
    { id: scenario.agentId, orgId: null, partnerId: scenario.partner.id, name: 'Helpdesk Baseline', kind: 'helpdesk' },
    { id: run.id, orgId: run.orgId, deviceId: null },
    { id: scenario.org.id, partnerId: scenario.partner.id },
  );
}

function fixtureProposal(overrides: Partial<TicketTriageProposal> = {}): TicketTriageProposal {
  return {
    version: 1,
    summary: 'Printer spooler crashed twice this week; likely driver issue.',
    fields: { priority: { value: 'high', confidence: 0.95 } },
    draftReply: 'Hi — we found the cause and are rolling out a fix.',
    notes: ['Spooler.exe crashed at 09:14 and 14:02'],
    ...overrides,
  };
}

async function loadTicket(id: string) {
  const adminDb = getTestDb() as any;
  const [row] = await adminDb.select().from(tickets).where(eq(tickets.id, id));
  return row as typeof tickets.$inferSelect;
}

async function loadIntent(id: string) {
  const adminDb = getTestDb() as any;
  const [row] = await adminDb.select().from(actionIntents).where(eq(actionIntents.id, id));
  return row as typeof actionIntents.$inferSelect;
}

// Without a registered enqueuer, every admitted run is immediately marked
// failed/enqueue_failed by design (runService.ts's own header) — which would
// invalidate every assertion about admitted runs below. Real entrypoints
// (index.ts, the BullMQ worker bootstrap) call registerAgentRunEnqueuer with
// the real BullMQ producer; this test stands in for that wiring.
beforeEach(() => {
  const enqueuer: AgentRunEnqueuer = async (runId) => ({ enqueued: true, jobId: `agent-run-${runId}` });
  registerAgentRunEnqueuer(enqueuer);
});

afterEach(() => {
  registerAgentRunEnqueuer(null);
  vi.clearAllMocks();
});

describe('ticket-triage admission — outbox event -> subscriber -> dedupe (Task A10, #4191)', () => {
  it('admits exactly one profile:triage run per ticket, even under a duplicate event delivery', async () => {
    const scenario = await seedTriageScenario(true);
    const ticket = await seedTicket(scenario);

    const event: BreezeEvent = {
      id: randomUUID(),
      type: 'ticket.created',
      orgId: scenario.org.id,
      source: 'ticket-triage-integration-test',
      priority: 'normal',
      payload: { ticketId: ticket.id },
      metadata: { timestamp: new Date().toISOString() },
    };

    await handleTicketCreatedEvent(event);
    // Redelivery — the exact scenario the dedupe key exists for.
    await handleTicketCreatedEvent(event);

    const dedupeKey = `ticket-created:${ticket.id}`;
    const adminDb = getTestDb() as any;
    const runs = await adminDb
      .select()
      .from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.ticketId, ticket.id), eq(aiAgentRuns.dedupeKey, dedupeKey)));

    expect(runs).toHaveLength(1);
    expect(runs[0].profile).toBe('triage');
    expect(runs[0].triggerKind).toBe('ticket');
    // act + org-override ticketAutonomousWrites=true — the forced-shadow LIFT.
    expect(runs[0].modeAtStart).toBe('act');
  });

  it('is forced shadow when the org override does not carry ticketAutonomousWrites', async () => {
    const scenario = await seedTriageScenario(false);
    const ticket = await seedTicket(scenario);

    await handleTicketCreatedEvent({
      id: randomUUID(),
      type: 'ticket.created',
      orgId: scenario.org.id,
      source: 'ticket-triage-integration-test',
      priority: 'normal',
      payload: { ticketId: ticket.id },
      metadata: { timestamp: new Date().toISOString() },
    });

    const adminDb = getTestDb() as any;
    const [run] = await adminDb
      .select()
      .from(aiAgentRuns)
      .where(eq(aiAgentRuns.dedupeKey, `ticket-created:${ticket.id}`));

    expect(run).toBeDefined();
    expect(run.modeAtStart).toBe('shadow');
  });
});

describe('ticket-triage release pipeline — persistTicketTriage -> intents -> release (Task A10, #4191)', () => {
  it('creation-time ticket_autonomy: CAS-applies the field, stamps provenance, writes the AI note once, and activates the reply draft', async () => {
    const scenario = await seedTriageScenario(true);
    const ticket = await seedTicket(scenario);
    const run = await seedTicketTriageRun(scenario, ticket.id);
    const auth = agentAuthFor(scenario, run);

    const persisted = await persistTicketTriage(
      { id: run.id, orgId: run.orgId, agentId: run.agentId, ticketId: run.ticketId, policySnapshot: run.policySnapshot, maxActionsPerRun: 5 },
      fixtureProposal(),
      auth,
    );

    expect(persisted.autonomous).toBe(true);
    // note, fields, draft-reply — draft-resolution and link are skipped (no
    // resolutionNote/device proposed).
    expect(persisted.intentIds).toHaveLength(3);
    // Ground truth: every created intent actually landed `approved` (granted
    // ticket_autonomy), not just requested.
    expect(persisted.approvedIntentIds).toHaveLength(3);

    for (const intentId of persisted.approvedIntentIds) {
      await releaseApprovedIntent(intentId);
    }

    const afterTicket = await loadTicket(ticket.id);
    expect(afterTicket.priority).toBe('high');
    expect(afterTicket.fieldProvenance).toMatchObject({ priority: 'ai_agent' });

    const adminDb = getTestDb() as any;
    const noteRows = await adminDb
      .select()
      .from(ticketComments)
      .where(and(eq(ticketComments.ticketId, ticket.id), eq(ticketComments.originPrincipalKind, 'ai_agent')));
    expect(noteRows).toHaveLength(1);
    expect(noteRows[0].agentRunId).toBe(run.id);
    expect(noteRows[0].isPublic).toBe(false);

    const draftRows = await adminDb
      .select()
      .from(ticketDrafts)
      .where(and(eq(ticketDrafts.ticketId, ticket.id), eq(ticketDrafts.kind, 'reply')));
    expect(draftRows).toHaveLength(1);
    expect(draftRows[0].state).toBe('active');
    expect(draftRows[0].runId).toBe(run.id);

    for (const intentId of persisted.approvedIntentIds) {
      const intent = await loadIntent(intentId);
      expect(intent.status).toBe('completed');
      expect(intent.decidedVia).toBe('ticket_autonomy');
    }
  });

  it('is idempotent on a redelivered note release — never a second AI note for the same run', async () => {
    const scenario = await seedTriageScenario(true);
    const ticket = await seedTicket(scenario);
    const run = await seedTicketTriageRun(scenario, ticket.id);
    const auth = agentAuthFor(scenario, run);

    const persisted = await persistTicketTriage(
      { id: run.id, orgId: run.orgId, agentId: run.agentId, ticketId: run.ticketId, policySnapshot: run.policySnapshot, maxActionsPerRun: 5 },
      fixtureProposal({ fields: undefined, draftReply: undefined }),
      auth,
    );
    expect(persisted.intentIds).toHaveLength(1); // note only

    const noteIntentId = persisted.intentIds[0]!;
    await releaseApprovedIntent(noteIntentId);

    // Simulate a redelivered release job for the SAME (already-completed)
    // intent — releaseApprovedIntent must not blow up, and must not write a
    // second note (ticket_comments_one_ai_note_per_run_uq / addAiTriageNote's
    // own idempotency).
    await releaseApprovedIntent(noteIntentId);

    const adminDb = getTestDb() as any;
    const noteRows = await adminDb
      .select()
      .from(ticketComments)
      .where(and(eq(ticketComments.ticketId, ticket.id), eq(ticketComments.originPrincipalKind, 'ai_agent')));
    expect(noteRows).toHaveLength(1);
  });

  it('human path (autonomy toggled off on the org override): intents land pending_approval, not approved', async () => {
    const scenario = await seedTriageScenario(false);
    const ticket = await seedTicket(scenario);
    const run = await seedTicketTriageRun(scenario, ticket.id);
    const auth = agentAuthFor(scenario, run);

    // draftReply omitted here: the draft-reply slot maps to `tickets:update`
    // (aiGuardrails.ts), which no seeded RBAC role ever grants — it is an
    // agent-only executor that would be cancelled (no_eligible_approvers)
    // regardless of the org's autonomy setting. This test's approver role
    // only grants `tickets:write` (note/fields), so it asserts what the
    // human-review path actually delivers: the two human-decidable slots.
    const persisted = await persistTicketTriage(
      { id: run.id, orgId: run.orgId, agentId: run.agentId, ticketId: run.ticketId, policySnapshot: run.policySnapshot, maxActionsPerRun: 5 },
      fixtureProposal({ draftReply: undefined }),
      auth,
    );

    expect(persisted.autonomous).toBe(false);
    expect(persisted.intentIds).toHaveLength(2); // note, fields
    expect(persisted.approvedIntentIds).toHaveLength(0);

    for (const intentId of persisted.intentIds) {
      const intent = await loadIntent(intentId);
      expect(intent.status).toBe('pending_approval');
      expect(intent.decidedVia).toBeNull();
    }

    // Nothing executed — the ticket's own field must be untouched.
    const afterTicket = await loadTicket(ticket.id);
    expect(afterTicket.priority).toBe('normal');
  });

  it('a human field_provenance stamp blocks the AI write — release completes but the field is unchanged', async () => {
    const scenario = await seedTriageScenario(true);
    const ticket = await seedTicket(scenario, { fieldProvenance: { priority: 'user' } });
    const run = await seedTicketTriageRun(scenario, ticket.id);
    const auth = agentAuthFor(scenario, run);

    const persisted = await persistTicketTriage(
      { id: run.id, orgId: run.orgId, agentId: run.agentId, ticketId: run.ticketId, policySnapshot: run.policySnapshot, maxActionsPerRun: 5 },
      fixtureProposal({ draftReply: undefined }),
      auth,
    );

    // filterEligibleFields (ticketTriageFindings.ts) pre-filters human-set
    // fields OUT before an intent is even minted for the `fields` slot —
    // only `note` should exist.
    expect(persisted.intentIds).toHaveLength(1);

    for (const intentId of persisted.approvedIntentIds) {
      await releaseApprovedIntent(intentId);
    }

    const afterTicket = await loadTicket(ticket.id);
    expect(afterTicket.priority).toBe('normal');
    expect(afterTicket.fieldProvenance).toMatchObject({ priority: 'user' });
  });

  it('a ticket closed after intent creation fails release with agent_scope_lost — the intent completes failed, not silently dropped', async () => {
    const scenario = await seedTriageScenario(true);
    const ticket = await seedTicket(scenario);
    const run = await seedTicketTriageRun(scenario, ticket.id);
    const auth = agentAuthFor(scenario, run);

    const persisted = await persistTicketTriage(
      { id: run.id, orgId: run.orgId, agentId: run.agentId, ticketId: run.ticketId, policySnapshot: run.policySnapshot, maxActionsPerRun: 5 },
      fixtureProposal({ fields: undefined, draftReply: undefined }),
      auth,
    );
    expect(persisted.approvedIntentIds).toHaveLength(1);
    const noteIntentId = persisted.approvedIntentIds[0]!;

    const adminDb = getTestDb() as any;
    await adminDb.update(tickets).set({ status: 'closed' }).where(eq(tickets.id, ticket.id));

    await releaseApprovedIntent(noteIntentId);

    const intent = await loadIntent(noteIntentId);
    expect(intent.status).toBe('failed');
    expect(intent.errorCode).toBe('agent_scope_lost');

    // The note must never have been written — release failed BEFORE execution.
    const noteRows = await adminDb
      .select()
      .from(ticketComments)
      .where(and(eq(ticketComments.ticketId, ticket.id), eq(ticketComments.originPrincipalKind, 'ai_agent')));
    expect(noteRows).toHaveLength(0);
  });
});
