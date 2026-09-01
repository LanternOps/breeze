// apps/api/src/services/aiAgents/ticketTriageFindings.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAgentPolicy, AiAgentPolicySnapshot, TicketTriageProposal } from '@breeze/shared';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const RUN_ID = '00000000-0000-4000-8000-0000000000a2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000a3';
const TICKET_ID = '00000000-0000-4000-8000-0000000000a4';
const USER_ID = '00000000-0000-4000-8000-0000000000a5';

// ---------------------------------------------------------------------------
// db mock — the ONE query `persistTicketTriage` issues itself: the live
// ticket row (device/resolutionNote/fieldProvenance). Same harness shape as
// sweepFindings.test.ts.
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  ambientContext: undefined as { scope: string } | undefined,
  selectScopes: [] as Array<string | undefined>,
}));

function resetDbState(): void {
  state.selectQueue = [];
  state.ambientContext = undefined;
  state.selectScopes = [];
}

vi.mock('../../db', () => {
  function selectBuilder() {
    const builder: Record<string, unknown> = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            state.selectScopes.push(state.ambientContext?.scope);
            if (state.selectQueue.length === 0) throw new Error('no queued select rows');
            return state.selectQueue.shift();
          })
          .then(resolve, reject),
    };
    return builder;
  }

  return {
    db: { select: vi.fn(() => selectBuilder()) },
    getCurrentDbAccessContext: vi.fn(() => state.ambientContext),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      const previous = state.ambientContext;
      state.ambientContext = { scope: 'system' };
      try {
        return await fn();
      } finally {
        state.ambientContext = previous;
      }
    }),
  };
});

const createActionIntent = vi.hoisted(() =>
  vi.fn<(auth: unknown, input: Record<string, unknown>) =>
    Promise<{ id: string; status: string; errorCode?: string | null }>>());
vi.mock('../actionIntents/intentService', () => ({ createActionIntent }));

const resolveEffectiveAgentSystem = vi.hoisted(() =>
  vi.fn<(orgId: string, kind: string) => Promise<AiAgentPolicySnapshot | null>>());
vi.mock('./effectivePolicy', () => ({ resolveEffectiveAgentSystem }));

const readAiKillState = vi.hoisted(() => vi.fn<() => Promise<{ killed: boolean; epoch: number }>>());
vi.mock('../aiKillState', () => ({ readAiKillState }));

import { persistTicketTriage, type TicketTriagePersistRunInput } from './ticketTriageFindings';

const agentAuth = {
  principal: { kind: 'ai_agent' },
  user: { id: USER_ID, email: 'agent@breeze.internal', name: 'Agent', isPlatformAdmin: false },
  orgId: ORG_ID,
  partnerId: null,
  scope: 'organization',
} as never;

function policy(overrides: Partial<AiAgentPolicy> = {}): AiAgentPolicy {
  return {
    enabled: true,
    mode: 'shadow',
    model: 'claude-test-model',
    toolAllowlist: [],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { ...AI_AGENT_LIMIT_DEFAULTS },
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: true },
    recipients: { userIds: [], roleIds: [] },
    actAssets: { scriptIds: [] },
    instructions: null,
    cooldownSeconds: 900,
    ...overrides,
  };
}

function snapshot(effective: AiAgentPolicy): AiAgentPolicySnapshot {
  return {
    schemaVersion: 8,
    agentId: AGENT_ID,
    kind: 'triage',
    effective,
    provenance: {} as AiAgentPolicySnapshot['provenance'],
    resolvedAt: new Date('2026-08-30T00:00:00Z').toISOString(),
  };
}

function runInput(overrides: Partial<TicketTriagePersistRunInput> = {}): TicketTriagePersistRunInput {
  return {
    id: RUN_ID,
    orgId: ORG_ID,
    agentId: AGENT_ID,
    ticketId: TICKET_ID,
    policySnapshot: snapshot(policy()),
    maxActionsPerRun: 5,
    ...overrides,
  };
}

function ticketRow(overrides: Record<string, unknown> = {}) {
  return { deviceId: null, resolutionNote: null, fieldProvenance: {}, ...overrides };
}

function proposal(overrides: Partial<TicketTriageProposal> = {}): TicketTriageProposal {
  return { version: 1, summary: 'Printer offline; likely a driver issue.', ...overrides };
}

/** The autonomous-run snapshot: `mode: 'act'` + `ticketAutonomousWrites: true`. */
function autonomousPolicy(): AiAgentPolicy {
  return policy({ mode: 'act', triggers: { ...policy().triggers, ticketAutonomousWrites: true } });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDbState();
  createActionIntent.mockResolvedValue({ id: 'intent-x', status: 'pending_approval' });
  resolveEffectiveAgentSystem.mockResolvedValue(null);
  readAiKillState.mockResolvedValue({ killed: false, epoch: 0 });
});

describe('persistTicketTriage', () => {
  it('confidence floor filters a field out and the fields slot is skipped', async () => {
    state.selectQueue.push([ticketRow()]);

    const result = await persistTicketTriage(
      runInput(),
      proposal({ fields: { priority: { value: 'high', confidence: 0.5 } } }),
      agentAuth,
    );

    expect(result.skipped).toContainEqual({ item: 'fields', reason: 'below_confidence_floor' });
    const fieldsCalls = createActionIntent.mock.calls.filter(
      ([, input]) => (input as { input: { action: string } }).input.action === 'update_fields',
    );
    expect(fieldsCalls).toHaveLength(0);
  });

  it('pre-filters a field whose live field_provenance is already user-set', async () => {
    state.selectQueue.push([ticketRow({ fieldProvenance: { categoryId: 'user' } })]);

    const result = await persistTicketTriage(
      runInput(),
      proposal({ fields: { categoryId: { value: 'cat-1', confidence: 0.95 } } }),
      agentAuth,
    );

    expect(result.skipped).toContainEqual({ item: 'fields', reason: 'human_set' });
    const fieldsCalls = createActionIntent.mock.calls.filter(
      ([, input]) => (input as { input: { action: string } }).input.action === 'update_fields',
    );
    expect(fieldsCalls).toHaveLength(0);
  });

  it('always attempts exactly one comment carrying the summary', async () => {
    state.selectQueue.push([ticketRow()]);
    createActionIntent.mockResolvedValue({ id: 'intent-note', status: 'pending_approval' });

    const result = await persistTicketTriage(runInput(), proposal(), agentAuth);

    const noteCalls = createActionIntent.mock.calls.filter(
      ([, input]) => (input as { input: { action: string } }).input.action === 'comment',
    );
    expect(noteCalls).toHaveLength(1);
    expect((noteCalls[0]![1] as { input: { content: string } }).input.content)
      .toContain('Printer offline; likely a driver issue.');
    expect(result.intentIds).toContain('intent-note');
  });

  it('skips the resolution-note draft when the ticket already has one', async () => {
    state.selectQueue.push([ticketRow({ resolutionNote: 'Replaced the driver.' })]);

    const result = await persistTicketTriage(
      runInput(),
      proposal({ draftResolutionNote: 'Reinstalled the printer driver and confirmed it prints.' }),
      agentAuth,
    );

    expect(result.skipped).toContainEqual({ item: 'draft-resolution', reason: 'resolution_note_exists' });
    const draftCalls = createActionIntent.mock.calls.filter(
      ([, input]) => (input as { input: { kind?: string } }).input.kind === 'resolution_note',
    );
    expect(draftCalls).toHaveLength(0);
  });

  it('honors the action cap in deterministic slot order — note first (spec §4.4 deliverable)', async () => {
    let counter = 0;
    createActionIntent.mockImplementation(async () => ({ id: `intent-${++counter}`, status: 'pending_approval' }));
    state.selectQueue.push([ticketRow()]);

    const result = await persistTicketTriage(
      runInput({ maxActionsPerRun: 2 }),
      proposal({
        fields: { priority: { value: 'high', confidence: 0.9 } },
        device: { hostname: 'WS-01' },
        draftReply: 'We are looking into this now.',
        draftResolutionNote: 'Reinstalled the printer driver.',
      }),
      agentAuth,
    );

    // note, then fields — the first two slots in the deterministic order —
    // get intents; link/draft-reply/draft-resolution are capped out. The
    // note (the triage deliverable, spec §4.4) is NEVER starved by the cap.
    const calls = createActionIntent.mock.calls.map(([, input]) => (input as { idempotencyKey: string }).idempotencyKey);
    expect(calls).toEqual([`triage:${RUN_ID}:note`, `triage:${RUN_ID}:fields`]);
    expect(result.intentIds).toHaveLength(2);
    expect(result.skipped).toEqual([
      { item: 'link', reason: 'max_actions_per_run' },
      { item: 'draft-reply', reason: 'max_actions_per_run' },
      { item: 'draft-resolution', reason: 'max_actions_per_run' },
    ]);
  });

  it('autonomy=false: every intent is created without an autonomy request and lands pending_approval', async () => {
    state.selectQueue.push([ticketRow()]);
    createActionIntent.mockResolvedValue({ id: 'intent-p', status: 'pending_approval' });

    const result = await persistTicketTriage(
      runInput({ policySnapshot: snapshot(policy({ mode: 'shadow' })) }),
      proposal(),
      agentAuth,
    );

    expect(result.autonomous).toBe(false);
    expect(resolveEffectiveAgentSystem).not.toHaveBeenCalled();
    for (const [, input] of createActionIntent.mock.calls) {
      expect((input as { autonomy?: unknown }).autonomy).toBeUndefined();
    }
    expect(result.intentIds.length).toBeGreaterThan(0);
    // Ground truth, not the advisory flag: nothing landed `approved`, so
    // nothing is reported as decided.
    expect(result.approvedIntentIds).toEqual([]);
  });

  it('autonomy=true: every intent requests ticket_autonomy and lands approved', async () => {
    state.selectQueue.push([ticketRow()]);
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot(autonomousPolicy()));
    createActionIntent.mockResolvedValue({ id: 'intent-a', status: 'approved' });

    const result = await persistTicketTriage(
      runInput({ policySnapshot: snapshot(autonomousPolicy()) }),
      proposal(),
      agentAuth,
    );

    expect(result.autonomous).toBe(true);
    expect(createActionIntent.mock.calls.length).toBeGreaterThan(0);
    for (const [, input] of createActionIntent.mock.calls) {
      expect((input as { autonomy?: { kind: string } }).autonomy).toEqual({ kind: 'ticket_autonomy' });
    }
    expect(result.intentIds.length).toBe(createActionIntent.mock.calls.length);
    // Ground truth here agrees with the advisory flag (every call actually
    // resolved `approved`) — the mixed-status test below is what proves
    // they are NOT the same signal.
    expect(result.approvedIntentIds).toEqual(result.intentIds);
  });

  it('ground truth: a mid-loop status flip is reflected per-intent, never uniformly by the advisory flag', async () => {
    // Autonomy was REQUESTED for both calls (the advisory flag is a
    // call-level decision made once, up front) — but the live gate inside
    // `createActionIntent` grants only the first and denies the second
    // (e.g. a kill-switch trip between the two sequential calls). This is
    // exactly the review-flagged race `approvedIntentIds` exists to survive:
    // a naive "autonomous ⇒ every created id is decided" read would wrongly
    // mark BOTH ids as decided.
    state.selectQueue.push([ticketRow()]);
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot(autonomousPolicy()));
    let call = 0;
    createActionIntent.mockImplementation(async () => {
      call += 1;
      return call === 1
        ? { id: 'intent-approved', status: 'approved' }
        : { id: 'intent-pending', status: 'pending_approval' };
    });

    const result = await persistTicketTriage(
      runInput({ policySnapshot: snapshot(autonomousPolicy()) }),
      proposal({ draftReply: 'We are looking into this now.' }),
      agentAuth,
    );

    expect(result.autonomous).toBe(true);
    // note -> approved (call 1), fields -> N/A (no fields proposed), so the
    // second createActionIntent call is draft-reply -> pending (call 2).
    expect(result.intentIds).toEqual(['intent-approved', 'intent-pending']);
    expect(result.approvedIntentIds).toEqual(['intent-approved']);
  });

  it('autonomy check that throws denies advisory autonomy rather than propagating', async () => {
    state.selectQueue.push([ticketRow()]);
    resolveEffectiveAgentSystem.mockRejectedValue(new Error('org not found'));
    createActionIntent.mockResolvedValue({ id: 'intent-p', status: 'pending_approval' });

    const result = await persistTicketTriage(
      runInput({ policySnapshot: snapshot(autonomousPolicy()) }),
      proposal(),
      agentAuth,
    );

    expect(result.autonomous).toBe(false);
  });

  it('a ticket that no longer resolves in the run org skips every slot', async () => {
    state.selectQueue.push([]);

    const result = await persistTicketTriage(
      runInput(),
      proposal({ device: { hostname: 'WS-01' }, draftReply: 'hi', draftResolutionNote: 'done' }),
      agentAuth,
    );

    expect(result.intentIds).toEqual([]);
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(result.skipped.every((s) => s.reason === 'ticket_not_found')).toBe(true);
    expect(result.skipped).toHaveLength(5);
  });
});
