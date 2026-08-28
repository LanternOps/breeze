import { describe, expect, it } from 'vitest';
import { AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS } from '@breeze/shared';
import { buildRunTrace, type RunTraceRunInput } from './runTrace';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const INTENT_ID = '55555555-5555-4555-8555-555555555555';

function baseRun(overrides: Partial<RunTraceRunInput> = {}): RunTraceRunInput {
  return {
    id: RUN_ID,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    deviceId: DEVICE_ID,
    alertId: null,
    triggerKind: 'manual',
    modeAtStart: 'shadow',
    status: 'completed',
    summary: 'Restarted the print spooler.',
    outcome: {},
    turnCount: 3,
    costCents: 12,
    errorCode: null,
    queuedAt: new Date('2026-08-28T10:00:00.000Z'),
    startedAt: new Date('2026-08-28T10:00:01.000Z'),
    finishedAt: new Date('2026-08-28T10:00:30.000Z'),
    ...overrides,
  };
}

const AGENT = { name: 'Triage Agent', kind: 'triage' as const };
const DEVICE = { hostname: 'WKS-042' };

describe('buildRunTrace — safe projection (#3828)', () => {
  it('maps a full wave-4/5 outcome into executed, then proposed, then denied trace entries', () => {
    const detail = buildRunTrace(
      baseRun({
        outcome: {
          findings: [],
          executedActions: [
            {
              tool: 'manage_services',
              action: 'restart',
              executionId: 'exec-1',
              result: 'ok',
              durationMs: 340,
              execution: 'succeeded',
              verification: 'passed',
              verifyDetail: 'service running',
              actOpKey: 'manage_services.restart',
              actTargetName: 'Spooler',
            },
          ],
          proposedActions: [
            {
              tool: 'run_script',
              action: 'invoke',
              args: { scriptId: 'abc', secretParam: 'super-secret-value' },
              intentId: INTENT_ID,
              downgradeReason: 'missing identity field',
            },
          ],
          deniedActions: [{ tool: 'delete_registry_key', reason: 'protected resource' }],
          toolExecutionCount: 2,
          runVerdict: 'partial',
          budgetExceeded: false,
          wallClockExceeded: false,
          maxTurnsExceeded: false,
        },
      }),
      AGENT,
      DEVICE,
      [],
      [],
    );

    expect(detail.schemaVersion).toBe(1);
    expect(detail.runVerdict).toBe('partial');
    expect(detail.agentName).toBe('Triage Agent');
    expect(detail.deviceHostname).toBe('WKS-042');
    expect(detail.trace).toEqual([
      {
        kind: 'executed',
        tool: 'manage_services',
        action: 'restart',
        result: 'ok',
        durationMs: 340,
        execution: 'succeeded',
        verification: 'passed',
        verifyDetail: 'service running',
        actOpKey: 'manage_services.restart',
        actTargetName: 'Spooler',
      },
      {
        kind: 'proposed',
        tool: 'run_script',
        action: 'invoke',
        intentId: INTENT_ID,
        intentError: undefined,
        downgradeReason: 'missing identity field',
      },
      { kind: 'denied', tool: 'delete_registry_key', reason: 'protected resource' },
    ]);
  });

  it('never carries the proposed action\'s raw args onto the trace, even when present on the source outcome', () => {
    const detail = buildRunTrace(
      baseRun({
        outcome: {
          proposedActions: [
            {
              tool: 'run_script',
              args: { toolInput: 'ignored-key-name-collision', secret: 'zzz-leak-marker-zzz' },
            },
          ],
        },
      }),
      AGENT,
      null,
      [],
      [],
    );

    const json = JSON.stringify(detail);
    for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
      expect(json).not.toContain(`"${forbidden}"`);
    }
    // The nested secret value itself must not have leaked through either.
    expect(json).not.toContain('zzz-leak-marker-zzz');
  });

  it('projects fix-held watches without ever carrying the structured target (#3828)', () => {
    const detail = buildRunTrace(baseRun(), AGENT, DEVICE, [], [], [
      {
        id: 'watch-1',
        runId: RUN_ID,
        watchKind: 'postcondition',
        status: 'regressed',
        opKey: 'manage_services.restart',
        targetFingerprint: 'service:spooler',
        baselineAt: new Date('2026-08-28T12:00:00.000Z'),
        dueAt: new Date('2026-08-28T12:15:00.000Z'),
        checkedAt: new Date('2026-08-28T12:16:00.000Z'),
        attempts: 1,
        detail: 'Spooler: service status is "stopped"',
      },
    ]);

    expect(detail.fixWatches).toEqual([
      {
        schemaVersion: 1,
        id: 'watch-1',
        runId: RUN_ID,
        watchKind: 'postcondition',
        status: 'regressed',
        opKey: 'manage_services.restart',
        targetName: 'service:spooler',
        baselineAt: '2026-08-28T12:00:00.000Z',
        dueAt: '2026-08-28T12:15:00.000Z',
        checkedAt: '2026-08-28T12:16:00.000Z',
        attempts: 1,
        detail: 'Spooler: service status is "stopped"',
      },
    ]);
    // The DTO has no `target` field at all — the leak is impossible by
    // construction, and the route never even selects the column.
    expect(JSON.stringify(detail)).not.toContain('"target"');
  });

  it('reports an empty fixWatches array for a run that predates the feature', () => {
    // Load-bearing: the UI must read "nothing to say", never "the fix failed".
    expect(buildRunTrace(baseRun(), AGENT, DEVICE, [], []).fixWatches).toEqual([]);
  });

  it('tolerates a wave-3-era outcome with no runVerdict/execution/verification fields at all', () => {
    const detail = buildRunTrace(
      baseRun({
        outcome: {
          findings: [],
          executedActions: [
            { tool: 'get_processes', executionId: 'exec-9', result: 'ok', durationMs: 50 },
          ],
          proposedActions: [],
          deniedActions: [],
          toolExecutionCount: 1,
          // no runVerdict, no budgetExceeded/wallClockExceeded/maxTurnsExceeded
        },
      }),
      AGENT,
      null,
      [],
      [],
    );

    expect(detail.runVerdict).toBeNull();
    expect(detail.budgetExceeded).toBe(false);
    expect(detail.wallClockExceeded).toBe(false);
    expect(detail.maxTurnsExceeded).toBe(false);
    expect(detail.trace).toEqual([
      {
        kind: 'executed',
        tool: 'get_processes',
        action: undefined,
        result: 'ok',
        durationMs: 50,
        execution: undefined,
        verification: undefined,
        verifyDetail: undefined,
        actOpKey: undefined,
        actTargetName: undefined,
      },
    ]);
  });

  it('tolerates a completely empty/malformed outcome object without throwing', () => {
    const detail = buildRunTrace(baseRun({ outcome: {} }), AGENT, null, [], []);
    expect(detail.trace).toEqual([]);
    expect(detail.runVerdict).toBeNull();
  });

  it('defends against a corrupted non-array outcome field by treating it as empty', () => {
    const detail = buildRunTrace(
      baseRun({ outcome: { executedActions: 'not-an-array', proposedActions: null } }),
      AGENT,
      null,
      [],
      [],
    );
    expect(detail.trace).toEqual([]);
  });

  it('maps ledger rows to the safe projection only (toolName/status/durations/error)', () => {
    const detail = buildRunTrace(
      baseRun(),
      AGENT,
      DEVICE,
      [
        {
          toolName: 'run_script',
          status: 'completed',
          durationMs: 210,
          createdAt: new Date('2026-08-28T10:00:05.000Z'),
          completedAt: new Date('2026-08-28T10:00:06.000Z'),
          errorMessage: null,
        },
      ],
      [],
    );
    expect(detail.ledger).toEqual([
      {
        toolName: 'run_script',
        status: 'completed',
        durationMs: 210,
        createdAt: '2026-08-28T10:00:05.000Z',
        completedAt: '2026-08-28T10:00:06.000Z',
        errorMessage: null,
      },
    ]);
  });

  it('maps intent rows to id/status/actionName/approvalScope/decidedVia only', () => {
    const detail = buildRunTrace(
      baseRun(),
      AGENT,
      DEVICE,
      [],
      [
        {
          id: INTENT_ID,
          status: 'pending_approval',
          actionName: 'manage_services.restart',
          approvalScope: 'four_eyes',
          decidedVia: null,
        },
      ],
    );
    expect(detail.intents).toEqual([
      {
        id: INTENT_ID,
        status: 'pending_approval',
        actionName: 'manage_services.restart',
        approvalScope: 'four_eyes',
        decidedVia: null,
      },
    ]);
  });

  it('is null for deviceHostname when the run has no device', () => {
    const detail = buildRunTrace(baseRun({ deviceId: null }), AGENT, null, [], []);
    expect(detail.deviceId).toBeNull();
    expect(detail.deviceHostname).toBeNull();
  });

  // Review fix (#3828): the route left-joins ai_agents (not innerJoin) because
  // a partner-wide agent's row (#2135) is RLS-invisible to an org-scoped
  // caller even though the run it produced stays visible. `agent: null` is
  // how that shows up here — the run must still produce a full DTO, with
  // agentName/agentKind null rather than the run vanishing (404).
  it('is null for agentName/agentKind when the agent is null (RLS-hidden partner-wide agent)', () => {
    const detail = buildRunTrace(baseRun(), null, DEVICE, [], []);
    expect(detail.agentName).toBeNull();
    expect(detail.agentKind).toBeNull();
    expect(detail.id).toBe(RUN_ID);
  });
});
