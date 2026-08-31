import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentPolicy, type AiAgentPolicySnapshot } from '@breeze/shared';

// ---------------------------------------------------------------------------
// db mock — connection layer only. The real remediationSuggestions schema
// module is imported for real below (same convention as actRevalidation.test.ts
// for filesystem/playbooks: schema files are side-effect-free column
// descriptors, so mocking them by hand would just be a second, driftable copy
// of the column list).
// ---------------------------------------------------------------------------
const dbMockState = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  updateCalls: [] as Array<{ values: Record<string, unknown>; where: unknown }>,
  updateShouldThrow: false as boolean | Error,
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => dbMockState.selectQueue.shift() ?? []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn((where: unknown) => {
          if (dbMockState.updateShouldThrow) {
            throw dbMockState.updateShouldThrow === true
              ? new Error('update failed')
              : dbMockState.updateShouldThrow;
          }
          dbMockState.updateCalls.push({ values, where });
          return Promise.resolve();
        }),
      })),
    })),
  },
  getCurrentDbAccessContext: vi.fn(() => undefined),
  runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const resolveEffectiveAgentSystem = vi.hoisted(() =>
  vi.fn<(orgId: string, kind: string) => Promise<AiAgentPolicySnapshot | null>>());
vi.mock('./effectivePolicy', () => ({ resolveEffectiveAgentSystem }));

const validateRemediationExecutionApproval = vi.hoisted(() =>
  vi.fn<(existing: unknown, deviceId: string) => Promise<string | null>>());
vi.mock('../../routes/remediationSuggestions', () => ({ validateRemediationExecutionApproval }));

import {
  resolveActableSuggestion,
  stampSuggestionExecutedByAgent,
  type RemediationActRunContext,
} from './remediationActResolver';

const ORG_ID = '00000000-0000-4000-8000-0000000000b1';
const OTHER_ORG_ID = '00000000-0000-4000-8000-0000000000b2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000b3';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000b4';
const OTHER_DEVICE_ID = '00000000-0000-4000-8000-0000000000b5';
const SUGGESTION_ID = '00000000-0000-4000-8000-0000000000b6';
const SCRIPT_ID = '00000000-0000-4000-8000-0000000000b7';
const RUN_ID = '00000000-0000-4000-8000-0000000000b8';
const SCRIPT_EXECUTION_ID = '00000000-0000-4000-8000-0000000000b9';

function runContext(overrides: Partial<RemediationActRunContext> = {}): RemediationActRunContext {
  return {
    id: RUN_ID,
    orgId: ORG_ID,
    agentId: AGENT_ID,
    agentKind: 'triage',
    deviceId: DEVICE_ID,
    ...overrides,
  };
}

function suggestionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SUGGESTION_ID,
    orgId: ORG_ID,
    deviceId: DEVICE_ID,
    targetType: 'script',
    scriptId: SCRIPT_ID,
    status: 'suggested',
    riskTier: 'medium',
    parameters: { foo: 'bar' },
    ...overrides,
  };
}

function policy(overrides: Partial<AiAgentPolicy> = {}): AiAgentPolicy {
  return {
    enabled: true,
    mode: 'act',
    model: null,
    toolAllowlist: ['run_script'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: AI_AGENT_LIMIT_DEFAULTS,
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: true },
    recipients: { userIds: [], roleIds: [] },
    actAssets: { scriptIds: [SCRIPT_ID] },
    instructions: null,
    cooldownSeconds: 900,
    ...overrides,
  };
}

function snapshot(effective: AiAgentPolicy, agentId = AGENT_ID): AiAgentPolicySnapshot {
  return {
    schemaVersion: 2,
    agentId,
    kind: 'triage',
    effective,
    provenance: {} as AiAgentPolicySnapshot['provenance'],
    resolvedAt: new Date('2026-08-27T00:00:00Z').toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMockState.selectQueue = [];
  dbMockState.updateCalls = [];
  dbMockState.updateShouldThrow = false;
  resolveEffectiveAgentSystem.mockReset().mockResolvedValue(snapshot(policy()));
  validateRemediationExecutionApproval.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveActableSuggestion — match matrix', () => {
  it('not found → deny', async () => {
    dbMockState.selectQueue = [[]];
    const result = await resolveActableSuggestion({ runContext: runContext(), suggestionId: SUGGESTION_ID });
    expect(result).toEqual({ ok: false, disposition: 'deny', reason: expect.stringMatching(/not found/i) });
  });

  it('wrong org → deny', async () => {
    dbMockState.selectQueue = [[suggestionRow({ orgId: OTHER_ORG_ID })]];
    const result = await resolveActableSuggestion({ runContext: runContext(), suggestionId: SUGGESTION_ID });
    expect(result).toEqual({ ok: false, disposition: 'deny', reason: expect.stringMatching(/organization/i) });
  });

  it('wrong device → deny', async () => {
    dbMockState.selectQueue = [[suggestionRow({ deviceId: OTHER_DEVICE_ID })]];
    const result = await resolveActableSuggestion({ runContext: runContext(), suggestionId: SUGGESTION_ID });
    expect(result).toEqual({ ok: false, disposition: 'deny', reason: expect.stringMatching(/device/i) });
  });

  it('a null deviceId (no single-device target) → deny, never falls back to targetDeviceIds', async () => {
    dbMockState.selectQueue = [[suggestionRow({ deviceId: null })]];
    const result = await resolveActableSuggestion({ runContext: runContext(), suggestionId: SUGGESTION_ID });
    expect(result).toEqual({ ok: false, disposition: 'deny', reason: expect.stringMatching(/device/i) });
  });

  it('wrong targetType → deny', async () => {
    dbMockState.selectQueue = [[suggestionRow({ targetType: 'playbook', scriptId: null })]];
    const result = await resolveActableSuggestion({ runContext: runContext(), suggestionId: SUGGESTION_ID });
    expect(result).toEqual({ ok: false, disposition: 'deny', reason: expect.stringMatching(/script/i) });
  });

  it('script targetType with no scriptId → deny', async () => {
    dbMockState.selectQueue = [[suggestionRow({ scriptId: null })]];
    const result = await resolveActableSuggestion({ runContext: runContext(), suggestionId: SUGGESTION_ID });
    expect(result).toEqual({ ok: false, disposition: 'deny', reason: expect.stringMatching(/script/i) });
  });

  it.each(['accepted', 'edited', 'rejected', 'executed', 'failed'])(
    'status "%s" → deny (agent-actable ONLY while suggested)',
    async (status) => {
      dbMockState.selectQueue = [[suggestionRow({ status })]];
      const result = await resolveActableSuggestion({ runContext: runContext(), suggestionId: SUGGESTION_ID });
      expect(result).toEqual({ ok: false, disposition: 'deny', reason: expect.stringContaining(status) });
    },
  );

  it('a required elevation approval that is not yet cleared → deny with the approval error', async () => {
    dbMockState.selectQueue = [[suggestionRow({ riskTier: 'critical' })]];
    validateRemediationExecutionApproval.mockResolvedValue('Elevation request must be approved before execution');

    const result = await resolveActableSuggestion({ runContext: runContext(), suggestionId: SUGGESTION_ID });
    expect(result).toEqual({
      ok: false, disposition: 'deny', reason: 'Elevation request must be approved before execution',
    });
    expect(validateRemediationExecutionApproval).toHaveBeenCalledWith(
      expect.objectContaining({ id: SUGGESTION_ID }), DEVICE_ID,
    );
  });

  it('no live policy resolves (kill switch / no partner baseline) → deny', async () => {
    dbMockState.selectQueue = [[suggestionRow()]];
    resolveEffectiveAgentSystem.mockResolvedValue(null);
    const result = await resolveActableSuggestion({ runContext: runContext(), suggestionId: SUGGESTION_ID });
    expect(result).toEqual({ ok: false, disposition: 'deny', reason: expect.any(String) });
  });

  it("a same-kind replacement agent (identity mismatch) → deny", async () => {
    dbMockState.selectQueue = [[suggestionRow()]];
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot(policy(), 'a-different-agent-id'));
    const result = await resolveActableSuggestion({ runContext: runContext(), suggestionId: SUGGESTION_ID });
    expect(result).toEqual({ ok: false, disposition: 'deny', reason: expect.any(String) });
  });
});

describe('resolveActableSuggestion — actAssets gate (Task 6/7, #3826)', () => {
  it('a script NOT in actAssets.scriptIds → propose, never a deny', async () => {
    dbMockState.selectQueue = [[suggestionRow()]];
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot(policy({ actAssets: { scriptIds: [] } })));

    const result = await resolveActableSuggestion({ runContext: runContext(), suggestionId: SUGGESTION_ID });
    expect(result).toEqual({
      ok: false, disposition: 'propose', reason: expect.stringMatching(/actAssets/i),
    });
  });

  it('a DIFFERENT authorized script does not authorize this suggestion', async () => {
    dbMockState.selectQueue = [[suggestionRow()]];
    resolveEffectiveAgentSystem.mockResolvedValue(
      snapshot(policy({ actAssets: { scriptIds: ['00000000-0000-4000-8000-0000000000ff'] } })),
    );
    const result = await resolveActableSuggestion({ runContext: runContext(), suggestionId: SUGGESTION_ID });
    expect(result.ok).toBe(false);
    expect((result as { disposition: string }).disposition).toBe('propose');
  });
});

describe('resolveActableSuggestion — happy path', () => {
  it('resolves to the run_script op with normalized deviceIds/parameters', async () => {
    dbMockState.selectQueue = [[suggestionRow({ parameters: { retries: 3 } })]];

    const result = await resolveActableSuggestion({ runContext: runContext(), suggestionId: SUGGESTION_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.resolved.op.key).toBe('run_script');
    expect(result.resolved.toolName).toBe('run_script');
    expect(result.resolved.input).toEqual({
      scriptId: SCRIPT_ID,
      deviceIds: [DEVICE_ID],
      parameters: { retries: 3 },
    });
    expect(result.resolved.suggestionId).toBe(SUGGESTION_ID);
    expect(result.resolved.scriptId).toBe(SCRIPT_ID);
  });

  it('normalizes non-object/array parameters to {}', async () => {
    dbMockState.selectQueue = [[suggestionRow({ parameters: null })]];
    const result = await resolveActableSuggestion({ runContext: runContext(), suggestionId: SUGGESTION_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.resolved.input.parameters).toEqual({});
  });
});

describe('stampSuggestionExecutedByAgent — Part A attribution precedent', () => {
  it('sets executed/scriptExecutionId, keeps executedBy NULL, and merges $actor into existing parameters', async () => {
    dbMockState.selectQueue = [[{ parameters: { retries: 3 } }]];

    await stampSuggestionExecutedByAgent({
      suggestionId: SUGGESTION_ID, scriptExecutionId: SCRIPT_EXECUTION_ID, agentId: AGENT_ID, runId: RUN_ID,
    });

    expect(dbMockState.updateCalls).toHaveLength(1);
    const { values } = dbMockState.updateCalls[0]!;
    expect(values).toMatchObject({
      status: 'executed',
      scriptExecutionId: SCRIPT_EXECUTION_ID,
      executedBy: null,
    });
    expect(values.executedAt).toBeInstanceOf(Date);
    expect(values.parameters).toEqual({
      retries: 3,
      $actor: { actorType: 'ai_agent', actorId: AGENT_ID, runId: RUN_ID },
    });
  });

  it('never throws when the update fails — best-effort, logged', async () => {
    dbMockState.selectQueue = [[{ parameters: {} }]];
    dbMockState.updateShouldThrow = new Error('db unavailable');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(stampSuggestionExecutedByAgent({
      suggestionId: SUGGESTION_ID, scriptExecutionId: SCRIPT_EXECUTION_ID, agentId: AGENT_ID, runId: RUN_ID,
    })).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
  });
});
