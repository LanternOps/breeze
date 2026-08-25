import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  insertedValues: null as Record<string, unknown> | null,
  updatedValues: null as Record<string, unknown> | null,
  whereArgument: undefined as unknown,
  onConflictDoNothing: vi.fn(),
  /** Rows the managed-automation UPDATE reports back — [] means "no managed row". */
  updateReturningRows: [] as unknown[],
  /** Rows the ai_agents lookup returns (self-heal + owner-liveness probe). */
  agentRows: [] as unknown[],
  selectWheres: [] as unknown[],
}));

const schema = vi.hoisted(() => ({
  automations: {
    id: 'automations.id',
    managedByAgentId: 'automations.managedByAgentId',
  },
  aiAgents: {
    id: 'aiAgents.id',
    kind: 'aiAgents.kind',
    name: 'aiAgents.name',
    enabled: 'aiAgents.enabled',
    orgId: 'aiAgents.orgId',
    partnerId: 'aiAgents.partnerId',
    createdBy: 'aiAgents.createdBy',
    disabledAt: 'aiAgents.disabledAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
}));

vi.mock('../../db/schema', () => ({
  automations: schema.automations,
  aiAgents: schema.aiAgents,
}));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        state.insertedValues = values;
        return { onConflictDoNothing: state.onConflictDoNothing };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        state.updatedValues = values;
        return {
          where: vi.fn((condition: unknown) => {
            state.whereArgument = condition;
            return { returning: vi.fn(async () => state.updateReturningRows) };
          }),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          state.selectWheres.push(condition);
          return { limit: vi.fn(async () => state.agentRows) };
        }),
      })),
    })),
  },
}));

import { db } from '../../db';
import {
  containsAiTriageAction,
  ensureManagedTriageAutomation,
  isManagedAutomation,
  managedAutomationOwnerIsLive,
  setManagedAutomationEnabled,
  syncManagedAutomation,
} from './managedAutomation';

const orgAgent = {
  id: 'agent-1',
  kind: 'triage' as const,
  name: 'Triage Bot',
  enabled: true,
  orgId: 'org-1',
  partnerId: null,
  createdBy: 'user-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  state.insertedValues = null;
  state.updatedValues = null;
  state.whereArgument = undefined;
  state.selectWheres = [];
  state.agentRows = [];
  // Default: the managed row exists, so the update path is the whole story.
  state.updateReturningRows = [{ id: 'automation-1' }];
  state.onConflictDoNothing.mockResolvedValue(undefined);
});

describe('ensureManagedTriageAutomation', () => {
  it('seeds the canonical org-owned triage automation without a drifting filter', async () => {
    await ensureManagedTriageAutomation(orgAgent);

    expect(state.insertedValues).toEqual({
      orgId: 'org-1',
      partnerId: null,
      name: 'Triage Bot — alert triage',
      description: 'System-managed: wakes the AI triage agent on alerts. Edit the agent, not this automation.',
      enabled: true,
      trigger: { type: 'event', eventType: 'alert.triggered' },
      actions: [{ type: 'ai_triage' }],
      onFailure: 'stop',
      createdBy: 'user-1',
      managedByAgentId: 'agent-1',
    });
  });

  it('makes duplicate seeding a no-op at the unique managed-agent key', async () => {
    await ensureManagedTriageAutomation(orgAgent);

    expect(state.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it.each(['patch', 'helpdesk'] as const)('issues no insert for a %s agent', async (kind) => {
    await ensureManagedTriageAutomation({ ...orgAgent, kind });

    expect(db.insert).not.toHaveBeenCalled();
  });

  it('mirrors the agent\u2019s own enabled flag instead of hardcoding live wiring', async () => {
    // createAiAgentSchema defaults `enabled` to false, so the ordinary
    // create-then-configure-then-enable flow must NOT leave an enabled
    // automation in front of an off agent: every alert would drive the full
    // automation machinery just to be refused by the admission gate, and no
    // route lets the user fix the row.
    await ensureManagedTriageAutomation({ ...orgAgent, enabled: false });

    expect(state.insertedValues).toMatchObject({ enabled: false });
  });

  it('mirrors the owner axis exactly for a partner-wide triage agent', async () => {
    await ensureManagedTriageAutomation({
      ...orgAgent,
      orgId: null,
      partnerId: 'partner-1',
    });

    expect(state.insertedValues).toMatchObject({
      orgId: null,
      partnerId: 'partner-1',
      managedByAgentId: 'agent-1',
    });
  });
});

describe('managed automation synchronization', () => {
  it('disables the managed row by its owning agent id', async () => {
    await setManagedAutomationEnabled('agent-1', false);

    expect(state.updatedValues).toMatchObject({ enabled: false });
    expect(state.updatedValues?.updatedAt).toBeInstanceOf(Date);
    expect(state.whereArgument).toEqual({
      eq: ['automations.managedByAgentId', 'agent-1'],
    });
  });

  it('derives the managed automation name without adding an enabled update', async () => {
    await syncManagedAutomation('agent-1', { name: 'Renamed' });

    expect(state.updatedValues?.name).toBe('Renamed — alert triage');
    expect(state.updatedValues).not.toHaveProperty('enabled');
  });

  it('issues no update for an empty patch', async () => {
    await syncManagedAutomation('agent-1', {});

    expect(db.update).not.toHaveBeenCalled();
  });

  it('re-creates a missing managed row instead of updating zero rows silently', async () => {
    // A triage agent that predates wave 3d has no managed automation, so the
    // UPDATE matches nothing. Returning silently would leave it producing zero
    // alert-driven runs forever, with no remedy the user can reach.
    state.updateReturningRows = [];
    state.agentRows = [{
      id: 'agent-1',
      kind: 'triage',
      name: 'Triage Bot',
      enabled: false,
      orgId: 'org-1',
      partnerId: null,
      createdBy: 'user-1',
      disabledAt: null,
    }];

    await syncManagedAutomation('agent-1', { enabled: true });

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(state.insertedValues).toMatchObject({
      orgId: 'org-1',
      partnerId: null,
      name: 'Triage Bot \u2014 alert triage',
      enabled: true,
      managedByAgentId: 'agent-1',
    });
  });

  it('self-heals with the renamed name when the patch carries one', async () => {
    state.updateReturningRows = [];
    state.agentRows = [{
      id: 'agent-1',
      kind: 'triage',
      name: 'Old Name',
      enabled: true,
      orgId: null,
      partnerId: 'partner-1',
      createdBy: 'user-1',
      disabledAt: null,
    }];

    await syncManagedAutomation('agent-1', { name: 'Renamed' });

    expect(state.insertedValues).toMatchObject({
      name: 'Renamed \u2014 alert triage',
      orgId: null,
      partnerId: 'partner-1',
      enabled: true,
    });
  });

  it('never wires a soft-disabled agent while self-healing', async () => {
    state.updateReturningRows = [];
    state.agentRows = [{
      id: 'agent-1',
      kind: 'triage',
      name: 'Triage Bot',
      enabled: false,
      orgId: 'org-1',
      partnerId: null,
      createdBy: 'user-1',
      disabledAt: new Date(),
    }];

    await setManagedAutomationEnabled('agent-1', false);

    expect(db.insert).not.toHaveBeenCalled();
  });

  it('does not self-heal an agent that no longer resolves', async () => {
    state.updateReturningRows = [];
    state.agentRows = [];

    await syncManagedAutomation('agent-1', { enabled: true });

    expect(db.insert).not.toHaveBeenCalled();
  });

  it('skips the ai_agents lookup entirely when the managed row was updated', async () => {
    await syncManagedAutomation('agent-1', { enabled: true });

    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe('managedAutomationOwnerIsLive', () => {
  it('reports a live agent, keeping its wiring undeletable', async () => {
    state.agentRows = [{ disabledAt: null }];

    expect(await managedAutomationOwnerIsLive('agent-1')).toBe(true);
    expect(state.selectWheres).toEqual([{ eq: ['aiAgents.id', 'agent-1'] }]);
  });

  it('reports a soft-disabled agent as dead so the leftover row can be deleted', async () => {
    state.agentRows = [{ disabledAt: new Date() }];

    expect(await managedAutomationOwnerIsLive('agent-1')).toBe(false);
  });

  it('fails closed when the agent row cannot be read', async () => {
    state.agentRows = [];

    expect(await managedAutomationOwnerIsLive('agent-1')).toBe(true);
  });
});

describe('managed automation guards', () => {
  it('fails toward unmanaged when a partial row omits managedByAgentId', () => {
    expect(isManagedAutomation({ managedByAgentId: 'x' })).toBe(true);
    expect(isManagedAutomation({ managedByAgentId: null })).toBe(false);
    expect(isManagedAutomation({})).toBe(false);
  });

  it.each([
    { actions: [{ type: 'ai_triage' }], expected: true },
    { actions: [{ type: 'run_script' }, { type: 'ai_triage' }], expected: true },
    { actions: [{ type: 'run_script' }], expected: false },
    { actions: undefined, expected: false },
    { actions: null, expected: false },
    { actions: 'ai_triage', expected: false },
    { actions: [null], expected: false },
    { actions: [1], expected: false },
  ])('detects ai_triage only in object-array actions: $actions', ({ actions, expected }) => {
    expect(() => containsAiTriageAction(actions)).not.toThrow();
    expect(containsAiTriageAction(actions)).toBe(expected);
  });
});
