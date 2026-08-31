import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * P2-4 Task A3 (#4191) — `evaluateTicketAutonomy`'s five-gate truth table.
 * `db` is mocked to a single-row `aiAgentRuns` select; `readAiKillState` and
 * `resolveEffectiveAgentSystem` are mocked wholesale (this suite is about the
 * gate combinator, not either dependency's own logic).
 */

const { dbState, killState, effectivePolicyState } = vi.hoisted(() => ({
  dbState: { runRow: null as Record<string, unknown> | null },
  killState: { killed: false, epoch: 0 },
  effectivePolicyState: {
    resolved: null as null | {
      agentId: string;
      effective: { mode: string; triggers: Record<string, unknown> };
    },
  },
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (dbState.runRow ? [dbState.runRow] : [])),
        })),
      })),
    })),
  },
}));

vi.mock('../../db/schema/aiAgents', () => ({
  aiAgentRuns: {
    id: { name: 'id' },
    agentId: { name: 'agent_id' },
    orgId: { name: 'org_id' },
    triggerKind: { name: 'trigger_kind' },
    policySnapshot: { name: 'policy_snapshot' },
  },
}));

vi.mock('../aiKillState', () => ({
  readAiKillState: vi.fn(async () => killState),
}));

vi.mock('../aiAgents/effectivePolicy', () => ({
  resolveEffectiveAgentSystem: vi.fn(async () => effectivePolicyState.resolved),
}));

import { evaluateTicketAutonomy } from './ticketAutonomy';

const ORG = 'org-1';
const RUN = 'run-1';
const AGENT = 'agent-1';
const TICKET = 'ticket-1';
const DEVICE = 'device-1';

function liveRunRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: RUN,
    agentId: AGENT,
    orgId: ORG,
    triggerKind: 'ticket',
    policySnapshot: {
      kind: 'helpdesk',
      effective: { mode: 'act', triggers: { ticketAutonomousWrites: true } },
    },
    ...overrides,
  };
}

function liveResolved(overrides: Partial<{ agentId: string; mode: string; ticketAutonomousWrites: boolean }> = {}) {
  return {
    agentId: overrides.agentId ?? AGENT,
    effective: {
      mode: overrides.mode ?? 'act',
      triggers: { ticketAutonomousWrites: overrides.ticketAutonomousWrites ?? true },
    },
  };
}

describe('evaluateTicketAutonomy', () => {
  beforeEach(() => {
    dbState.runRow = liveRunRow();
    killState.killed = false;
    effectivePolicyState.resolved = liveResolved();
  });

  it('grants when all five gates hold', async () => {
    const decision = await evaluateTicketAutonomy({
      requestedAutonomyKind: 'ticket_autonomy',
      principalKind: 'ai_agent',
      agentRunId: RUN,
      orgId: ORG,
      scope: { ticketId: TICKET },
    });
    expect(decision).toEqual({ granted: true });
  });

  it('denies not_requested when autonomy was not asked for', async () => {
    const decision = await evaluateTicketAutonomy({
      requestedAutonomyKind: undefined,
      principalKind: 'ai_agent',
      agentRunId: RUN,
      orgId: ORG,
      scope: { ticketId: TICKET },
    });
    expect(decision).toEqual({ granted: false, reason: 'not_requested' });
  });

  it('denies not_agent_run for a non-agent principal', async () => {
    const decision = await evaluateTicketAutonomy({
      requestedAutonomyKind: 'ticket_autonomy',
      principalKind: 'user_session',
      agentRunId: null,
      orgId: ORG,
      scope: { ticketId: TICKET },
    });
    expect(decision).toEqual({ granted: false, reason: 'not_agent_run' });
  });

  it('denies not_agent_run when the agent principal has no run id', async () => {
    const decision = await evaluateTicketAutonomy({
      requestedAutonomyKind: 'ticket_autonomy',
      principalKind: 'ai_agent',
      agentRunId: null,
      orgId: ORG,
      scope: { ticketId: TICKET },
    });
    expect(decision).toEqual({ granted: false, reason: 'not_agent_run' });
  });

  it('denies scope_not_ticket for a device-scoped intent', async () => {
    const decision = await evaluateTicketAutonomy({
      requestedAutonomyKind: 'ticket_autonomy',
      principalKind: 'ai_agent',
      agentRunId: RUN,
      orgId: ORG,
      scope: { deviceId: DEVICE },
    });
    expect(decision).toEqual({ granted: false, reason: 'scope_not_ticket' });
  });

  it('denies scope_not_ticket for an unscoped intent', async () => {
    const decision = await evaluateTicketAutonomy({
      requestedAutonomyKind: 'ticket_autonomy',
      principalKind: 'ai_agent',
      agentRunId: RUN,
      orgId: ORG,
      scope: undefined,
    });
    expect(decision).toEqual({ granted: false, reason: 'scope_not_ticket' });
  });

  it('denies not_agent_run when the run row is missing', async () => {
    dbState.runRow = null;
    const decision = await evaluateTicketAutonomy({
      requestedAutonomyKind: 'ticket_autonomy',
      principalKind: 'ai_agent',
      agentRunId: RUN,
      orgId: ORG,
      scope: { ticketId: TICKET },
    });
    expect(decision).toEqual({ granted: false, reason: 'not_agent_run' });
  });

  it('denies not_agent_run when the run belongs to another org', async () => {
    dbState.runRow = liveRunRow({ orgId: 'other-org' });
    const decision = await evaluateTicketAutonomy({
      requestedAutonomyKind: 'ticket_autonomy',
      principalKind: 'ai_agent',
      agentRunId: RUN,
      orgId: ORG,
      scope: { ticketId: TICKET },
    });
    expect(decision).toEqual({ granted: false, reason: 'not_agent_run' });
  });

  it('denies run_not_ticket_triggered for a non-ticket-triggered run', async () => {
    dbState.runRow = liveRunRow({ triggerKind: 'sweep' });
    const decision = await evaluateTicketAutonomy({
      requestedAutonomyKind: 'ticket_autonomy',
      principalKind: 'ai_agent',
      agentRunId: RUN,
      orgId: ORG,
      scope: { ticketId: TICKET },
    });
    expect(decision).toEqual({ granted: false, reason: 'run_not_ticket_triggered' });
  });

  it('denies run_snapshot_not_authorized when the run snapshot mode was not act', async () => {
    dbState.runRow = liveRunRow({
      policySnapshot: { kind: 'helpdesk', effective: { mode: 'shadow', triggers: { ticketAutonomousWrites: true } } },
    });
    const decision = await evaluateTicketAutonomy({
      requestedAutonomyKind: 'ticket_autonomy',
      principalKind: 'ai_agent',
      agentRunId: RUN,
      orgId: ORG,
      scope: { ticketId: TICKET },
    });
    expect(decision).toEqual({ granted: false, reason: 'run_snapshot_not_authorized' });
  });

  it('denies run_snapshot_not_authorized when the run snapshot toggle was off', async () => {
    dbState.runRow = liveRunRow({
      policySnapshot: { kind: 'helpdesk', effective: { mode: 'act', triggers: { ticketAutonomousWrites: false } } },
    });
    const decision = await evaluateTicketAutonomy({
      requestedAutonomyKind: 'ticket_autonomy',
      principalKind: 'ai_agent',
      agentRunId: RUN,
      orgId: ORG,
      scope: { ticketId: TICKET },
    });
    expect(decision).toEqual({ granted: false, reason: 'run_snapshot_not_authorized' });
  });

  it('denies live_policy_not_authorized on the flipped-off race (snapshot true, live false)', async () => {
    effectivePolicyState.resolved = liveResolved({ mode: 'shadow' });
    const decision = await evaluateTicketAutonomy({
      requestedAutonomyKind: 'ticket_autonomy',
      principalKind: 'ai_agent',
      agentRunId: RUN,
      orgId: ORG,
      scope: { ticketId: TICKET },
    });
    expect(decision).toEqual({ granted: false, reason: 'live_policy_not_authorized' });
  });

  it('denies live_policy_not_authorized when the live toggle is off even with an act-mode snapshot', async () => {
    effectivePolicyState.resolved = liveResolved({ ticketAutonomousWrites: false });
    const decision = await evaluateTicketAutonomy({
      requestedAutonomyKind: 'ticket_autonomy',
      principalKind: 'ai_agent',
      agentRunId: RUN,
      orgId: ORG,
      scope: { ticketId: TICKET },
    });
    expect(decision).toEqual({ granted: false, reason: 'live_policy_not_authorized' });
  });

  it('denies live_policy_not_authorized when there is no live agent for this org+kind', async () => {
    effectivePolicyState.resolved = null;
    const decision = await evaluateTicketAutonomy({
      requestedAutonomyKind: 'ticket_autonomy',
      principalKind: 'ai_agent',
      agentRunId: RUN,
      orgId: ORG,
      scope: { ticketId: TICKET },
    });
    expect(decision).toEqual({ granted: false, reason: 'live_policy_not_authorized' });
  });

  it('denies live_policy_not_authorized when the live baseline agent identity changed', async () => {
    effectivePolicyState.resolved = liveResolved({ agentId: 'another-agent' });
    const decision = await evaluateTicketAutonomy({
      requestedAutonomyKind: 'ticket_autonomy',
      principalKind: 'ai_agent',
      agentRunId: RUN,
      orgId: ORG,
      scope: { ticketId: TICKET },
    });
    expect(decision).toEqual({ granted: false, reason: 'live_policy_not_authorized' });
  });

  it('denies kill_switch_engaged when the kill switch is live', async () => {
    killState.killed = true;
    const decision = await evaluateTicketAutonomy({
      requestedAutonomyKind: 'ticket_autonomy',
      principalKind: 'ai_agent',
      agentRunId: RUN,
      orgId: ORG,
      scope: { ticketId: TICKET },
    });
    expect(decision).toEqual({ granted: false, reason: 'kill_switch_engaged' });
  });
});
