import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  insertedValues: null as Record<string, unknown> | null,
  updatedValues: null as Record<string, unknown> | null,
  whereArgument: undefined as unknown,
  onConflictDoNothing: vi.fn(),
}));

const schema = vi.hoisted(() => ({
  automations: {
    managedByAgentId: 'automations.managedByAgentId',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
}));

vi.mock('../../db/schema', () => ({ automations: schema.automations }));

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
            return Promise.resolve();
          }),
        };
      }),
    })),
  },
}));

import { db } from '../../db';
import {
  containsAiTriageAction,
  ensureManagedTriageAutomation,
  isManagedAutomation,
  setManagedAutomationEnabled,
  syncManagedAutomation,
} from './managedAutomation';

const orgAgent = {
  id: 'agent-1',
  kind: 'triage' as const,
  name: 'Triage Bot',
  orgId: 'org-1',
  partnerId: null,
  createdBy: 'user-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  state.insertedValues = null;
  state.updatedValues = null;
  state.whereArgument = undefined;
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
