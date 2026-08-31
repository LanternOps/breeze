import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * P2-4 Task A3 (#4191) — `createActionIntent`'s creation-transaction
 * ticket-autonomy WIRING: given a decision from `evaluateTicketAutonomy`
 * (mocked wholesale here — its own five-gate truth table is unit-tested in
 * isolation, `ticketAutonomy.test.ts`), does creation correctly:
 *   - bake `status: 'approved'` / `decidedVia: 'ticket_autonomy'` /
 *     `decidedAt` / `decidedByUserId: null` / `releaseBy` into the INSERT;
 *   - skip the human fan-out (no approval_requests rows);
 *   - write BOTH the `intent_created` AND `intent_approved` outbox rows;
 *   - on denial, silently degrade to the ordinary human_required path with
 *     an `autonomyDenied` breadcrumb on `result`, fan-out intact.
 *
 * Mock scaffolding is the `intentService.scope.test.ts` shape (device
 * scope), widened with a `tickets` table stub for the scoped-ticket
 * existence check and a wholesale `./ticketAutonomy` mock.
 */

const { schema, dbState, authMock, guardrailMock, aiToolsState, permState, pushState, notifyState, metricsMock, intentApproversState, effectDigestState, envMock, policyDecideMock, ticketAutonomyState } = vi.hoisted(() => {
  const col = (name: string) => ({ name });
  const actionIntentsTbl = {
    id: col('id'),
    orgId: col('org_id'),
    idempotencyKey: col('idempotency_key'),
    status: col('status'),
    expiresAt: col('expires_at'),
    releaseBy: col('release_by'),
    approvalExpiresAt: col('approval_expires_at'),
  };
  const approvalRequestsTbl = { id: col('id'), intentId: col('intent_id'), userId: col('user_id') };
  const intentOutboxTbl = { id: col('id'), intentId: col('intent_id') };
  const aiAgentRunsTbl = {
    id: col('id'),
    agentId: col('agent_id'),
    orgId: col('org_id'),
    deviceId: col('device_id'),
    policySnapshot: col('policy_snapshot'),
  };
  const aiAgentsTbl = { id: col('id'), name: col('name') };
  const devicesTbl = { id: col('id'), orgId: col('org_id'), siteId: col('site_id') };
  const ticketsTbl = { id: col('id'), orgId: col('org_id') };

  return {
    schema: { actionIntentsTbl, approvalRequestsTbl, intentOutboxTbl, aiAgentRunsTbl, aiAgentsTbl, devicesTbl, ticketsTbl },
    dbState: {
      insertActionIntentsResults: [] as Array<unknown[] | ((values: Record<string, unknown>) => unknown[])>,
      insertApprovalRequestsResults: [] as unknown[][],
      selectActionIntentsResults: [] as unknown[][],
      selectApprovalRequestsResults: [] as unknown[][],
      insertedActionIntentValues: [] as Record<string, unknown>[],
      insertedApprovalRequestsValues: [] as unknown[],
      insertedOutboxValues: [] as Record<string, unknown>[],
      selectAgentRunsResults: [] as unknown[][],
      selectAgentsResults: [] as unknown[][],
      selectDevicesResults: [] as unknown[][],
      selectTicketsResults: [] as unknown[][],
    },
    authMock: { dbAccessContextFromAuth: vi.fn((auth: { scope: string; orgId: string | null; accessibleOrgIds: string[] | null; user: { id: string } }) => ({
      scope: auth.scope,
      orgId: auth.orgId,
      accessibleOrgIds: auth.accessibleOrgIds,
      userId: auth.user.id,
    })) },
    guardrailMock: { checkGuardrails: vi.fn(), checkAgentGuardrails: vi.fn() },
    aiToolsState: {
      tools: new Map<string, { definition: { description?: string } }>(),
      resolveWritableToolOrgId: vi.fn(),
    },
    permState: {
      getUserPermissions: vi.fn(),
      userCanDecideApprovals: vi.fn((perms: { canDecide?: boolean } | null) => !!perms?.canDecide),
    },
    pushState: {
      getUserPushTokens: vi.fn(async () => []),
      dispatchApprovalPushToTokens: vi.fn(async () => ({ tokensFound: 0, dispatched: 0, errors: 0 })),
    },
    notifyState: { createNotification: vi.fn(async () => 'notif-1') },
    metricsMock: { recordActionIntentEvent: vi.fn() },
    intentApproversState: {
      resolveIntentApprovers: vi.fn(async () => [] as string[]),
      resolveAgentIntentApprovers: vi.fn(async () => [] as string[]),
      resolveIntentTargetScope: vi.fn(async () => ({ kind: 'indirect' }) as unknown),
    },
    effectDigestState: {
      computeEffectDigestOutcome: vi.fn(async () => ({ kind: 'not_applicable' }) as { kind: string }),
    },
    envMock: { policyDecideEnabled: vi.fn(() => false) },
    policyDecideMock: { attemptPolicyDecision: vi.fn(async () => {}) },
    ticketAutonomyState: {
      evaluateTicketAutonomy: vi.fn(async () => ({ granted: false, reason: 'not_requested' }) as
        { granted: true } | { granted: false; reason: string }),
    },
  };
});

function resultBox(getResult: () => unknown) {
  return {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(getResult()).then(res, rej),
    catch: (rej: (e: unknown) => unknown) => Promise.resolve(getResult()).catch(rej),
    limit: vi.fn(() => resultBox(getResult)),
  };
}

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        if (table === schema.actionIntentsTbl) {
          const insertedValues = values as Record<string, unknown>;
          dbState.insertedActionIntentValues.push(insertedValues);
          return {
            onConflictDoNothing: vi.fn(() => ({
              returning: vi.fn(async () => {
                const queued = dbState.insertActionIntentsResults.shift();
                if (typeof queued === 'function') return queued(insertedValues);
                return queued ?? [];
              }),
            })),
          };
        }
        if (table === schema.approvalRequestsTbl) {
          dbState.insertedApprovalRequestsValues.push(values);
          return { returning: vi.fn(async () => dbState.insertApprovalRequestsResults.shift() ?? []) };
        }
        if (table === schema.intentOutboxTbl) {
          dbState.insertedOutboxValues.push(values as Record<string, unknown>);
          return Promise.resolve(undefined);
        }
        throw new Error('unexpected insert table in mock');
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          if (table === schema.actionIntentsTbl) return resultBox(() => dbState.selectActionIntentsResults.shift() ?? []);
          if (table === schema.approvalRequestsTbl) return resultBox(() => dbState.selectApprovalRequestsResults.shift() ?? []);
          if (table === schema.aiAgentRunsTbl) return resultBox(() => dbState.selectAgentRunsResults.shift() ?? []);
          if (table === schema.aiAgentsTbl) return resultBox(() => dbState.selectAgentsResults.shift() ?? []);
          if (table === schema.devicesTbl) return resultBox(() => dbState.selectDevicesResults.shift() ?? []);
          if (table === schema.ticketsTbl) return resultBox(() => dbState.selectTicketsResults.shift() ?? []);
          throw new Error('unexpected select table in mock');
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
    })),
  },
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => fn()),
}));

vi.mock('../../db/schema/actionIntents', () => ({
  actionIntents: schema.actionIntentsTbl,
  intentOutbox: schema.intentOutboxTbl,
}));
vi.mock('../../db/schema/approvals', () => ({ approvalRequests: schema.approvalRequestsTbl }));
vi.mock('./intentApprovers', () => ({
  resolveIntentApprovers: intentApproversState.resolveIntentApprovers,
  resolveAgentIntentApprovers: intentApproversState.resolveAgentIntentApprovers,
  resolveIntentTargetScope: intentApproversState.resolveIntentTargetScope,
}));
vi.mock('../../middleware/auth', () => ({ dbAccessContextFromAuth: authMock.dbAccessContextFromAuth }));
vi.mock('../aiTools', () => ({
  aiTools: aiToolsState.tools,
  resolveWritableToolOrgId: aiToolsState.resolveWritableToolOrgId,
}));
vi.mock('../aiGuardrails', () => ({
  checkGuardrails: guardrailMock.checkGuardrails,
  checkAgentGuardrails: guardrailMock.checkAgentGuardrails,
}));
vi.mock('../../db/schema/aiAgents', () => ({
  aiAgents: schema.aiAgentsTbl,
  aiAgentRuns: schema.aiAgentRunsTbl,
}));
vi.mock('../../db/schema/devices', () => ({ devices: schema.devicesTbl }));
vi.mock('../../db/schema/portal', () => ({ tickets: schema.ticketsTbl }));
vi.mock('../permissions', () => ({
  getUserPermissions: permState.getUserPermissions,
  userCanDecideApprovals: permState.userCanDecideApprovals,
}));
vi.mock('../expoPush', () => ({
  getUserPushTokens: pushState.getUserPushTokens,
  dispatchApprovalPushToTokens: pushState.dispatchApprovalPushToTokens,
}));
vi.mock('../userNotifications', () => ({ createNotification: notifyState.createNotification }));
vi.mock('./metrics', () => ({ recordActionIntentEvent: metricsMock.recordActionIntentEvent }));
vi.mock('./effectDigest', () => ({ computeEffectDigestOutcome: effectDigestState.computeEffectDigestOutcome }));
vi.mock('../../config/env', () => ({ policyDecideEnabled: envMock.policyDecideEnabled }));
vi.mock('./policyDecide', () => ({ attemptPolicyDecision: policyDecideMock.attemptPolicyDecision }));
vi.mock('./ticketAutonomy', () => ({ evaluateTicketAutonomy: ticketAutonomyState.evaluateTicketAutonomy }));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  inArray: vi.fn((...args: unknown[]) => ({ op: 'inArray', args })),
  sql: vi.fn(() => ({ op: 'sql' })),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { createActionIntent, type CreateActionIntentInput } from './intentService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTER_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '55555555-5555-4555-8555-555555555555';
const AGENT_ID = '66666666-6666-4666-8666-666666666666';
const RUN_ID = '77777777-7777-4777-8777-777777777777';
const TICKET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function makeAgentAuth() {
  return {
    principal: { kind: 'ai_agent', agentId: AGENT_ID, runId: RUN_ID },
    user: { id: AGENT_ID, email: `agent+${AGENT_ID}@breeze.internal`, name: 'Triage agent' },
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    scope: 'organization' as const,
    accessibleOrgIds: [ORG_ID],
  } as unknown as Parameters<typeof createActionIntent>[0];
}

function makeTicketTriageRunRow(overrides?: Record<string, unknown>) {
  return {
    id: RUN_ID,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    deviceId: null,
    policySnapshot: {
      schemaVersion: 8,
      agentId: AGENT_ID,
      kind: 'helpdesk',
      effective: {
        enabled: true,
        mode: 'act',
        toolAllowlist: ['manage_tickets'],
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
        triggers: { alertSeverities: [], respectMaintenanceWindows: true, ticketAutonomousWrites: true },
      },
      provenance: {},
      resolvedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

function queueTicketTriageContext(opts?: { run?: Record<string, unknown>; ticket?: unknown[] }) {
  const run = makeTicketTriageRunRow(opts?.run);
  dbState.selectAgentRunsResults.push([run]);
  dbState.selectAgentsResults.push([{ id: AGENT_ID, name: 'Triage agent' }]);
  dbState.selectTicketsResults.push(opts?.ticket ?? [{ id: TICKET_ID, orgId: ORG_ID }]);
  // One fanned-out approval row per intent, for the human_required paths.
  dbState.insertApprovalRequestsResults.push([{ id: 'approval-1' }]);
}

function echoInsertedIntent(overrides?: Record<string, unknown>) {
  return (values: Record<string, unknown>) => [
    {
      id: 'intent-echo',
      partnerId: PARTNER_ID,
      requestedByUserId: null,
      status: 'pending_approval',
      createdAt: new Date(),
      result: null,
      errorCode: null,
      ...values,
      ...overrides,
    },
  ];
}

function triageInput(overrides?: Partial<CreateActionIntentInput>): CreateActionIntentInput {
  return {
    toolName: 'manage_tickets',
    input: { action: 'draft', ticketId: TICKET_ID, kind: 'draftReply', body: 'Have you tried rebooting?' },
    source: 'ai_agent',
    orgId: ORG_ID,
    scope: { ticketId: TICKET_ID },
    autonomy: { kind: 'ticket_autonomy' },
    ...overrides,
  };
}

function resetDbState() {
  for (const key of Object.keys(dbState) as Array<keyof typeof dbState>) {
    (dbState[key] as unknown[]).length = 0;
  }
}

beforeEach(() => {
  resetDbState();
  vi.clearAllMocks();
  aiToolsState.tools.clear();
  aiToolsState.resolveWritableToolOrgId.mockReturnValue({ orgId: ORG_ID });
  guardrailMock.checkGuardrails.mockReturnValue({
    tier: 3,
    allowed: true,
    requiresApproval: true,
    approvalScope: 'supervised',
    description: 'Draft an AI reply',
  });
  guardrailMock.checkAgentGuardrails.mockReturnValue({
    tier: 3,
    allowed: true,
    requiresApproval: true,
    disposition: 'propose',
    description: 'Draft an AI reply',
  });
  intentApproversState.resolveIntentApprovers.mockResolvedValue([]);
  intentApproversState.resolveAgentIntentApprovers.mockResolvedValue([REQUESTER_ID]);
  intentApproversState.resolveIntentTargetScope.mockResolvedValue({ kind: 'indirect' });
  permState.getUserPermissions.mockResolvedValue(null);
  pushState.getUserPushTokens.mockResolvedValue([]);
  pushState.dispatchApprovalPushToTokens.mockResolvedValue({ tokensFound: 0, dispatched: 0, errors: 0 });
  notifyState.createNotification.mockResolvedValue('notif-1');
  effectDigestState.computeEffectDigestOutcome.mockResolvedValue({ kind: 'not_applicable' });
  envMock.policyDecideEnabled.mockReturnValue(false);
  policyDecideMock.attemptPolicyDecision.mockResolvedValue(undefined);
  ticketAutonomyState.evaluateTicketAutonomy.mockResolvedValue({ granted: false, reason: 'not_requested' });
});

describe('createActionIntent — creation-transaction ticket autonomy (P2-4 Task A3, #4191)', () => {
  it('granted: inserts approved/ticket_autonomy, skips fan-out, writes BOTH outbox events', async () => {
    queueTicketTriageContext();
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    ticketAutonomyState.evaluateTicketAutonomy.mockResolvedValue({ granted: true });

    const snapshot = await createActionIntent(makeAgentAuth(), triageInput());

    const inserted = dbState.insertedActionIntentValues[0];
    expect(inserted?.status).toBe('approved');
    expect(inserted?.decidedVia).toBe('ticket_autonomy');
    expect(inserted?.decidedAt).toBeInstanceOf(Date);
    expect(inserted?.decidedByUserId).toBeNull();
    expect(inserted?.releaseBy).toBeInstanceOf(Date);
    expect(inserted?.scopeKind).toBe('ticket');
    expect(inserted?.scopeTicketId).toBe(TICKET_ID);
    // No breadcrumb on a GRANT — result stays null.
    expect(inserted?.result).toBeNull();

    // No human ever reviewed this: zero approval_requests rows.
    expect(dbState.insertedApprovalRequestsValues).toHaveLength(0);
    expect(snapshot.approvalRequestIds).toEqual([]);

    // BOTH outbox events: the unconditional intent_created, AND the
    // approve-path intent_approved that actually triggers release.
    const eventTypes = dbState.insertedOutboxValues.map((v) => v.eventType);
    expect(eventTypes).toEqual(['intent_created', 'intent_approved']);
  });

  it('toggle false (run snapshot denies): pending_approval, human fan-out runs, autonomyDenied breadcrumb stamped', async () => {
    queueTicketTriageContext();
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    ticketAutonomyState.evaluateTicketAutonomy.mockResolvedValue({
      granted: false,
      reason: 'run_snapshot_not_authorized',
    });

    const snapshot = await createActionIntent(makeAgentAuth(), triageInput());

    const inserted = dbState.insertedActionIntentValues[0];
    // status/decidedVia/releaseBy are NOT set on the insert — left at their
    // column defaults (status defaults to 'pending_approval' in the DB;
    // this mock doesn't apply defaults, so the key is simply absent).
    expect(inserted?.status).toBeUndefined();
    expect(inserted?.decidedVia).toBeUndefined();
    expect(inserted?.result).toEqual({ autonomyDenied: 'run_snapshot_not_authorized' });

    // The ordinary human fan-out ran.
    expect(dbState.insertedApprovalRequestsValues.length).toBeGreaterThan(0);
    expect(snapshot.approvalRequestIds.length).toBeGreaterThan(0);

    // Only the ordinary intent_created outbox row — no intent_approved.
    const eventTypes = dbState.insertedOutboxValues.map((v) => v.eventType);
    expect(eventTypes).toEqual(['intent_created']);
  });

  // Review fix (#4191): a gate-evaluation exception (e.g.
  // resolveEffectiveAgentSystem throwing) must degrade to the SAME
  // human_required path as an ordinary denial, never abort intent creation
  // entirely — evaluateTicketAutonomy itself now catches this (its own
  // ticketAutonomy.test.ts proves the catch); this proves the wiring here
  // treats 'gate_evaluation_failed' exactly like any other denial reason.
  it('gate-evaluation exception denial: intent still created pending_approval, breadcrumb carries gate_evaluation_failed', async () => {
    queueTicketTriageContext();
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    ticketAutonomyState.evaluateTicketAutonomy.mockResolvedValue({
      granted: false,
      reason: 'gate_evaluation_failed',
    });

    const snapshot = await createActionIntent(makeAgentAuth(), triageInput());

    expect(snapshot.status).toBe('pending_approval');
    const inserted = dbState.insertedActionIntentValues[0];
    expect(inserted?.status).toBeUndefined();
    expect(inserted?.decidedVia).toBeUndefined();
    expect(inserted?.result).toEqual({ autonomyDenied: 'gate_evaluation_failed' });
    expect(dbState.insertedApprovalRequestsValues.length).toBeGreaterThan(0);
  });

  it('live-policy-flipped-off race (snapshot true, live false): pending_approval, breadcrumb reflects the live-policy reason', async () => {
    queueTicketTriageContext();
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    ticketAutonomyState.evaluateTicketAutonomy.mockResolvedValue({
      granted: false,
      reason: 'live_policy_not_authorized',
    });

    const snapshot = await createActionIntent(makeAgentAuth(), triageInput());

    expect(snapshot.status).toBe('pending_approval');
    const inserted = dbState.insertedActionIntentValues[0];
    expect(inserted?.result).toEqual({ autonomyDenied: 'live_policy_not_authorized' });
    expect(dbState.insertedApprovalRequestsValues.length).toBeGreaterThan(0);
  });

  it('autonomy not requested at all: no breadcrumb, ordinary human_required path, unaffected by evaluateTicketAutonomy', async () => {
    queueTicketTriageContext();
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    // Defensive: even if the collaborator were somehow called and returned a
    // denial reason, no breadcrumb should be stamped when autonomy was never
    // requested — createActionIntent's own gate on `input.autonomy?.kind`
    // must be what decides this, not merely relaying evaluateTicketAutonomy's
    // reason through unconditionally.
    ticketAutonomyState.evaluateTicketAutonomy.mockResolvedValue({ granted: false, reason: 'not_requested' });

    const snapshot = await createActionIntent(
      makeAgentAuth(),
      triageInput({ autonomy: undefined }),
    );

    expect(snapshot.status).toBe('pending_approval');
    const inserted = dbState.insertedActionIntentValues[0];
    expect(inserted?.result).toBeNull();
  });
});
