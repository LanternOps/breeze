/**
 * #4177 (W04) — live-DB proof for the AI time-entry PROPOSAL lane.
 *
 * End-to-end against real Postgres:
 *   1. a technician sends an AI-drafted reply (`sendTicketDraft`) → the
 *      `ticket_outbox` row carries the `aiDraft` claim → the helpdesk
 *      subscriber (fed the row exactly as jobs/ticketOutboxPublisher.ts
 *      publishes it) mints exactly one supervised, human-required,
 *      ticket-scoped `manage_tickets:log_time_entry` intent under the
 *      draft's run;
 *   2. nothing is written to `time_entries` before a human decides;
 *   3. the approval route + `releaseApprovedIntent` create ONE entry owned by
 *      the APPROVER (`decided_by_user_id`), `source = 'ai_suggested'`, with
 *      the org/partner denormalisation intact — the wave's riskiest line
 *      (a wrong owner is a 23503 on `time_entries_user_id_fkey`);
 *   4. the resolve path (`changeTicketStatus` + `aiDraftId`) mints under its
 *      own trigger key, and a category duration default flows through;
 *   5. a forged `source` value is rejected by the widened CHECK.
 *
 * Mirrors moveOrgIntentReleaseActorContext.integration.test.ts's agent-owned
 * fixtures (a real `ai_agents` + `ai_agent_runs` row) and approves through
 * the real approval route so `decided_by_user_id` is stamped by the real
 * decide path, never hand-written.
 */
import './setup';
import { getTestDb } from './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

vi.hoisted(() => {
  process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
});

// publishEvent writes to a Redis stream — spy on it so the send/resolve
// paths don't depend on a stream consumer existing (same precedent as
// aiAgentTicketTriage.integration.test.ts).
const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { aiAgents, aiAgentRuns } from '../../db/schema/aiAgents';
import { billingProfiles, ticketCategories, ticketDrafts, ticketOutbox, tickets, timeEntries } from '../../db/schema';
import type { BreezeEvent } from '../../services/eventBus';
import { handleTicketCommentedEvent, handleTicketStatusChangedEvent } from '../../services/aiAgents/ticketHelpdeskSubscriber';
import { registerAgentRunEnqueuer, type AgentRunEnqueuer } from '../../services/aiAgents/runService';
import { PERMISSIONS } from '../../services/permissions';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { approvalRoutes } from '../../routes/approvals';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import { changeTicketStatus, sendTicketDraft } from '../../services/ticketService';
import { AI_TIME_ENTRY_DEFAULT_MINUTES } from '../../services/aiTimeEntryProposal';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Scenario {
  partnerId: string;
  orgId: string;
  billingProfileId: string;
  agentId: string;
  runId: string;
  ticketId: string;
  tech: { id: string; email: string };
  approver: { id: string; email: string };
  approverRoleId: string;
  orgContext: DbAccessContext;
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedScenario(opts: { categoryMinutes?: number | null } = {}): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });

  // The approver is an MSP technician: a PARTNER-axis member (time_entries is
  // a partner-axis table and its route is partner/system-only) who can (a)
  // decide approvals and (b) holds the tool's own RBAC mapping —
  // `log_time_entry` → `time_entries:write` — which is both what makes them an
  // eligible approver at mint time (intentApprovers.ts) and what the release
  // worker re-checks before executing as them (#4177).
  const approverRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(approverRole.id, [
    PERMISSIONS.APPROVALS_DECIDE,
    PERMISSIONS.TIME_ENTRIES_WRITE,
    PERMISSIONS.TICKETS_WRITE,
  ]);
  const approver = await createUser({ partnerId: partner.id, email: `approver-${randomUUID()}@ai-time-entry.test` });
  await assignUserToPartner(approver.id, partner.id, approverRole.id, 'all');

  // The technician who sends the draft is deliberately NOT the approver, so
  // the ownership assertion below cannot pass by coincidence. An org-axis
  // member is enough to send a draft.
  const techRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(techRole.id, [PERMISSIONS.TICKETS_WRITE]);
  const tech = await createUser({ partnerId: partner.id, orgId: org.id, email: `tech-${randomUUID()}@ai-time-entry.test` });
  await assignUserToOrganization(tech.id, org.id, techRole.id);

  const adminDb = getTestDb() as any;
  // No org assignment or work-type rules: uncategorised tickets resolve the
  // partner default's billable base (spec §3.6 declared difference 1), including
  // the AI proposal and its eventual human-approved time entry.
  const [billingProfile] = await adminDb.insert(billingProfiles).values({
    partnerId: partner.id, name: 'AI proposal rates', currencyCode: 'USD',
    isDefault: true, baseCoverage: 'billable', baseHourlyRate: null,
    baseMinimumMinutes: null,
  }).returning();
  let categoryId: string | null = null;
  if (opts.categoryMinutes !== undefined) {
    const [category] = await adminDb.insert(ticketCategories).values({
      partnerId: partner.id,
      name: `AI time ${uid()}`,
      defaultTimeEntryMinutes: opts.categoryMinutes,
    }).returning();
    categoryId = category.id;
  }

  const unique = uid();
  const [ticket] = await adminDb.insert(tickets).values({
    orgId: org.id,
    partnerId: partner.id,
    ticketNumber: `AITE-${unique}`,
    subject: `AI time-entry proposal ${unique}`,
    source: 'manual',
    priority: 'normal',
    categoryId,
  }).returning();

  const [agent] = await adminDb.insert(aiAgents).values({
    partnerId: partner.id,
    orgId: null,
    kind: 'helpdesk',
    name: 'Helpdesk Agent',
    enabled: true,
    mode: 'shadow',
    toolAllowlist: ['manage_tickets'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: {},
    triggers: {},
    recipients: { userIds: [], roleIds: [] },
    createdBy: approver.id,
  }).returning();

  const policySnapshot = {
    effective: {
      enabled: true,
      mode: 'shadow',
      toolAllowlist: ['manage_tickets'],
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      limits: {},
      triggers: {},
    },
  };
  const [run] = await adminDb.insert(aiAgentRuns).values({
    agentId: agent.id,
    orgId: org.id,
    deviceId: null,
    ticketId: ticket.id,
    triggerKind: 'ticket',
    dedupeKey: `ai-time-entry-${randomUUID()}`,
    modeAtStart: 'shadow',
    policySnapshot: policySnapshot as never,
    profile: 'triage',
  }).returning();

  const orgContext: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    userId: tech.id,
    currentPartnerId: partner.id,
  };

  return {
    partnerId: partner.id,
    orgId: org.id,
    billingProfileId: billingProfile.id,
    agentId: agent.id,
    runId: run.id,
    ticketId: ticket.id,
    tech: { id: tech.id, email: tech.email },
    approver: { id: approver.id, email: approver.email },
    approverRoleId: approverRole.id,
    orgContext,
  };
}

async function seedDraft(s: Scenario, kind: 'reply' | 'resolution_note', runId: string | null = s.runId): Promise<string> {
  const adminDb = getTestDb() as any;
  const [draft] = await adminDb.insert(ticketDrafts).values({
    ticketId: s.ticketId,
    orgId: s.orgId,
    kind,
    content: kind === 'reply' ? 'Hi — we found the cause and are rolling out a fix.' : 'Replaced the spooler driver; printing restored.',
    runId,
  }).returning();
  return draft.id;
}

/**
 * Drive the outbox hop the way jobs/ticketOutboxPublisher.ts does (it runs on
 * a 5s timer, so the suite performs its exact publish step by hand): read the
 * newest outbox row of `eventType` for the ticket and hand the subscriber the
 * BreezeEvent the publisher would build — `{ ticketId, ...row.payload }`.
 */
async function publishLatestOutbox(s: Scenario, eventType: 'ticket.commented' | 'ticket.status_changed'): Promise<Record<string, unknown>> {
  const rows = await withSystemDbAccessContext(() =>
    db.select().from(ticketOutbox).where(eq(ticketOutbox.ticketId, s.ticketId)),
  );
  const row = rows.filter((r) => r.eventType === eventType).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  expect(row).toBeTruthy();
  const payload = { ticketId: row!.ticketId, ...((row!.payload as Record<string, unknown>) ?? {}) };
  const event: BreezeEvent = {
    id: randomUUID(),
    type: eventType,
    orgId: row!.orgId,
    source: 'ticket-outbox-publisher',
    priority: 'normal',
    payload,
    metadata: { timestamp: new Date().toISOString() },
  };
  if (eventType === 'ticket.commented') await handleTicketCommentedEvent(event);
  else await handleTicketStatusChangedEvent(event);
  return payload;
}

async function intentsForTicket(ticketId: string) {
  return withSystemDbAccessContext(() =>
    db.select().from(actionIntents).where(eq(actionIntents.scopeTicketId, ticketId)),
  );
}

async function entriesForTicket(ticketId: string) {
  return withSystemDbAccessContext(() =>
    db.select().from(timeEntries).where(eq(timeEntries.ticketId, ticketId)),
  );
}

async function approveViaRoute(s: Scenario, intentId: string): Promise<void> {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ id: approvalRequests.id }).from(approvalRequests).where(eq(approvalRequests.intentId, intentId)),
  );
  expect(row).toBeTruthy();
  const payload: Omit<TokenPayload, 'type'> = {
    sub: s.approver.id,
    email: s.approver.email,
    roleId: s.approverRoleId,
    orgId: s.orgId,
    partnerId: s.partnerId,
    scope: 'partner',
    mfa: false,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  const token = await createAccessToken(payload);
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  const res = await app.request(`/approvals/${row!.id}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
}

/** postgres-js wraps the server error as `cause` on Drizzle's query error. */
async function dbErrorCause(fn: () => Promise<unknown>): Promise<{ code?: string; message?: string; constraint_name?: string } | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as { cause?: { code?: string; message?: string; constraint_name?: string } } | undefined)?.cause;
  }
}

// The same subscriber also runs W02's triage admission on these events;
// without a registered enqueuer every admitted run is marked failed by
// design (runService.ts). Same stand-in as aiAgentTicketTriage.integration.test.ts.
beforeEach(() => {
  const enqueuer: AgentRunEnqueuer = async (runId) => ({ enqueued: true, jobId: `agent-run-${runId}` });
  registerAgentRunEnqueuer(enqueuer);
});

afterEach(() => {
  registerAgentRunEnqueuer(null);
  vi.clearAllMocks();
});

describe('AI time-entry proposal lane (#4177, W04) — real Postgres', () => {
  runDb('sending an AI draft mints exactly one supervised, human-required, ticket-scoped intent and writes no time entry', async () => {
    const s = await seedScenario();
    const draftId = await seedDraft(s, 'reply');

    await withDbAccessContext(s.orgContext, () =>
      sendTicketDraft(s.ticketId, draftId, undefined, { userId: s.tech.id, name: 'Tess Tech' }),
    );
    // Nothing is minted by the send itself — the outbox hop is the mint.
    expect(await intentsForTicket(s.ticketId)).toHaveLength(0);

    const payload = await publishLatestOutbox(s, 'ticket.commented');
    expect(payload.aiDraft).toEqual({ draftId, runId: s.runId, trigger: 'draft_sent' });
    // Redelivery of the same outbox event must not double-mint.
    await publishLatestOutbox(s, 'ticket.commented');

    const intents = await intentsForTicket(s.ticketId);
    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    expect(intent).toMatchObject({
      actionName: 'manage_tickets',
      source: 'ai_agent',
      status: 'pending_approval',
      approvalScope: 'supervised',
      policyDecisionState: 'human_required',
      requestingAgentRunId: s.runId,
      requestedByUserId: null,
      originPrincipalKind: 'ai_agent',
      scopeKind: 'ticket',
      idempotencyKey: `ai-time-entry:${s.runId}:draft_sent`,
      decidedByUserId: null,
    });
    expect(intent.arguments).toMatchObject({
      action: 'log_time_entry',
      ticketId: s.ticketId,
      durationMinutes: AI_TIME_ENTRY_DEFAULT_MINUTES,
      isBillable: true,
      proposedForUserId: s.tech.id,
    });

    // The proposal never auto-executes.
    expect(await entriesForTicket(s.ticketId)).toHaveLength(0);
  });

  runDb('releasing the approved proposal creates one ai_suggested entry owned by the APPROVER, not the sender or the agent', async () => {
    const s = await seedScenario();
    const draftId = await seedDraft(s, 'reply');
    await withDbAccessContext(s.orgContext, () =>
      sendTicketDraft(s.ticketId, draftId, undefined, { userId: s.tech.id, name: 'Tess Tech' }),
    );
    await publishLatestOutbox(s, 'ticket.commented');
    const [intent] = await intentsForTicket(s.ticketId);
    expect(intent).toBeTruthy();

    await approveViaRoute(s, intent!.id);
    const [approved] = await intentsForTicket(s.ticketId);
    expect(approved).toMatchObject({ status: 'approved', decidedByUserId: s.approver.id });

    await releaseApprovedIntent(intent!.id);

    const [released] = await intentsForTicket(s.ticketId);
    expect(released).toMatchObject({ status: 'completed', errorCode: null });

    const entries = await entriesForTicket(s.ticketId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      userId: s.approver.id,
      source: 'ai_suggested',
      durationMinutes: AI_TIME_ENTRY_DEFAULT_MINUTES,
      isBillable: true,
      coverage: 'billable',
      billingProfileId: s.billingProfileId,
      workTypeId: null,
      hourlyRate: null,
      billingOverridden: false,
      partnerId: s.partnerId,
      orgId: s.orgId,
    });
    expect(entries[0]!.userId).not.toBe(s.tech.id);
    expect(entries[0]!.userId).not.toBe(s.agentId);
  });

  runDb('resolving with an AI resolution note mints under its own trigger key and honours the category duration default', async () => {
    const s = await seedScenario({ categoryMinutes: 25 });
    const draftId = await seedDraft(s, 'resolution_note');

    await withDbAccessContext(s.orgContext, () =>
      changeTicketStatus(s.ticketId, { status: 'resolved' }, { aiDraftId: draftId }, { userId: s.tech.id, name: 'Tess Tech' }),
    );
    const payload = await publishLatestOutbox(s, 'ticket.status_changed');
    expect(payload.aiDraft).toEqual({ draftId, runId: s.runId, trigger: 'resolved_with_ai_note' });

    const intents = await intentsForTicket(s.ticketId);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      status: 'pending_approval',
      approvalScope: 'supervised',
      policyDecisionState: 'human_required',
      idempotencyKey: `ai-time-entry:${s.runId}:resolved_with_ai_note`,
    });
    // Category default (25) beats the module constant; billable comes from
    // the resolver through the partner default billing profile.
    expect(intents[0]!.arguments).toMatchObject({ action: 'log_time_entry', durationMinutes: 25, isBillable: true });
    expect(await entriesForTicket(s.ticketId)).toHaveLength(0);
  });

  runDb('an org-axis approver cannot own the entry — release fails closed instead of forging partner scope', async () => {
    const s = await seedScenario();
    // A customer-side (org-axis) member who can decide approvals but is not
    // an MSP technician. They CAN approve; the release must still refuse to
    // write a partner-axis time entry under them.
    const orgRole = await createRole({ scope: 'organization', orgId: s.orgId });
    await grantRolePermissions(orgRole.id, [PERMISSIONS.APPROVALS_DECIDE, PERMISSIONS.TIME_ENTRIES_WRITE, PERMISSIONS.TICKETS_WRITE]);
    const orgApprover = await createUser({ partnerId: s.partnerId, orgId: s.orgId, email: `org-approver-${randomUUID()}@ai-time-entry.test` });
    await assignUserToOrganization(orgApprover.id, s.orgId, orgRole.id);

    const draftId = await seedDraft(s, 'reply');
    await withDbAccessContext(s.orgContext, () =>
      sendTicketDraft(s.ticketId, draftId, undefined, { userId: s.tech.id, name: 'Tess Tech' }),
    );
    await publishLatestOutbox(s, 'ticket.commented');
    const [intent] = await intentsForTicket(s.ticketId);
    expect(intent).toBeTruthy();

    // Stamp the decision the way the decide path does, for THIS approver
    // (the fan-out row went to the partner tech, so the route cannot be used
    // here — the intent + its bound approval row are approved by hand).
    await withSystemDbAccessContext(async () => {
      await db.update(approvalRequests)
        .set({ status: 'approved', decidedAt: new Date() })
        .where(eq(approvalRequests.intentId, intent!.id));
      await db.update(actionIntents)
        .set({ status: 'approved', decidedAt: new Date(), decidedByUserId: orgApprover.id, decidedVia: 'session_tap', releaseBy: new Date(Date.now() + 60_000) })
        .where(eq(actionIntents.id, intent!.id));
    });

    await releaseApprovedIntent(intent!.id);

    const [released] = await intentsForTicket(s.ticketId);
    expect(released).toMatchObject({ status: 'failed', errorCode: 'actor_invalid' });
    expect(await entriesForTicket(s.ticketId)).toHaveLength(0);
  });

  runDb('a draft with no run proposes nothing, and the send still succeeds', async () => {
    const s = await seedScenario();
    const draftId = await seedDraft(s, 'reply', null);

    const result = await withDbAccessContext(s.orgContext, () =>
      sendTicketDraft(s.ticketId, draftId, undefined, { userId: s.tech.id, name: 'Tess Tech' }),
    );
    expect(result.comment.id).toBeTruthy();
    const payload = await publishLatestOutbox(s, 'ticket.commented');
    expect(payload).not.toHaveProperty('aiDraft');
    expect(await intentsForTicket(s.ticketId)).toHaveLength(0);
  });

  runDb('a forged source value is rejected by the widened CHECK', async () => {
    const s = await seedScenario();
    const adminDb = getTestDb() as any;
    const now = new Date();
    const cause = await dbErrorCause(() =>
      adminDb.insert(timeEntries).values({
        partnerId: s.partnerId,
        orgId: s.orgId,
        ticketId: s.ticketId,
        userId: s.tech.id,
        startedAt: new Date(now.getTime() - 15 * 60_000),
        endedAt: now,
        durationMinutes: 15,
        currencyCode: 'USD',
        source: 'bogus',
      }),
    );
    expect(cause?.code).toBe('23514');
    expect(cause?.constraint_name).toBe('time_entries_source_chk');

    // …while the new value is admitted.
    const [ok] = await adminDb.insert(timeEntries).values({
      partnerId: s.partnerId,
      orgId: s.orgId,
      ticketId: s.ticketId,
      userId: s.tech.id,
      startedAt: new Date(now.getTime() - 15 * 60_000),
      endedAt: now,
      durationMinutes: 15,
      currencyCode: 'USD',
      source: 'ai_suggested',
    }).returning({ id: timeEntries.id, source: timeEntries.source });
    expect(ok.source).toBe('ai_suggested');
  });

  runDb('ticket_categories.default_time_entry_minutes rejects zero and > 1440', async () => {
    const s = await seedScenario();
    const adminDb = getTestDb() as any;
    for (const bad of [0, 1441]) {
      const cause = await dbErrorCause(() =>
        adminDb.insert(ticketCategories).values({ partnerId: s.partnerId, name: `bad ${uid()}`, defaultTimeEntryMinutes: bad }),
      );
      expect(cause?.code).toBe('23514');
      expect(cause?.constraint_name).toBe('ticket_categories_default_time_entry_minutes_chk');
    }
  });
});
