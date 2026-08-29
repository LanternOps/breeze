// apps/api/src/services/aiAgents/sweepFindings.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS, type SweepFindingsOutcome } from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const RUN_ID = '00000000-0000-4000-8000-0000000000a2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000a3';
const SCHEDULE_ID = '00000000-0000-4000-8000-0000000000a4';
const USER_ID = '00000000-0000-4000-8000-0000000000a5';
/** In the run's evidence set AND in the org. */
const DEVICE_A = '00000000-0000-4000-8000-0000000000b1';
/** Also in the evidence set and the org — used for the cap test. */
const DEVICE_B = '00000000-0000-4000-8000-0000000000b2';
/** A real device in the org the run never collected evidence for. */
const DEVICE_OUTSIDE_EVIDENCE = '00000000-0000-4000-8000-0000000000b3';
const INTENT_A = '00000000-0000-4000-8000-0000000000c1';
const INTENT_B = '00000000-0000-4000-8000-0000000000c2';

// ---------------------------------------------------------------------------
// db mock — same harness shape as alertVerdicts.test.ts. `persistSweepFindings`
// issues at most ONE select (the batched org/ephemeral device read), so the
// queue depth itself is an assertion: an unexpected extra read throws.
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  selectWheres: [] as unknown[],
  selectCount: 0,
  ambientContext: undefined as { scope: string } | undefined,
  /** Every ambient scope a select ran under — pins the read to a system context. */
  selectScopes: [] as Array<string | undefined>,
}));

function resetDbState(): void {
  state.selectQueue = [];
  state.selectWheres = [];
  state.selectCount = 0;
  state.ambientContext = undefined;
  state.selectScopes = [];
}

vi.mock('../../db', () => {
  function selectBuilder() {
    state.selectCount += 1;
    const builder: Record<string, unknown> = {
      from: vi.fn(() => builder),
      where: vi.fn((w: unknown) => {
        state.selectWheres.push(w);
        return builder;
      }),
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

import {
  persistSweepFindings,
  projectSweep,
  sweepFindingDeviceIds,
  type SweepProposalRecord,
} from './sweepFindings';

const dialect = new PgDialect();
function sqlText(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql;
}
/** The BOUND PARAMETERS of a compiled predicate. Asserting on these — rather
 *  than on the `org_id` column name appearing in the SQL text — is what makes
 *  the tenancy assertion non-vacuous: a predicate that mentions `org_id` but
 *  binds some OTHER org's id would pass a text check and fail this one. */
function sqlParams(value: unknown): unknown[] {
  return dialect.sqlToQuery(value as SQL).params;
}

const agentAuth = {
  principal: { kind: 'ai_agent' },
  user: { id: USER_ID, email: 'agent@breeze.internal', name: 'Agent', isPlatformAdmin: false },
  orgId: ORG_ID,
  partnerId: null,
  scope: 'organization',
} as never;

function runInput(overrides: Partial<Parameters<typeof persistSweepFindings>[0]> = {}) {
  return {
    id: RUN_ID,
    orgId: ORG_ID,
    agentId: AGENT_ID,
    deviceId: null as null,
    scheduleId: SCHEDULE_ID,
    // The AGENT's effective allowlist (not the sweep read-only floor) — a
    // proposal is only converted when the partner actually granted the
    // mutating tool.
    toolAllowlist: ['manage_services', 'remediate_vulnerability'],
    maxActionsPerRun: 3,
    evidenceDeviceIds: new Set([DEVICE_A, DEVICE_B]) as ReadonlySet<string>,
    ...overrides,
  };
}

function restartFinding(deviceId: string, serviceName = 'Spooler') {
  return {
    kind: 'service_down' as const,
    severity: 'critical' as const,
    deviceId,
    title: `${serviceName} is stopped`,
    detail: `${serviceName} has been stopped for 3 days.`,
    evidence: { state: 'stopped' },
    proposedAction: {
      tool: 'manage_services' as const,
      action: 'restart' as const,
      deviceId,
      serviceName,
    },
  };
}

function outcomeWith(...findings: SweepFindingsOutcome['findings']): SweepFindingsOutcome {
  return { summary: 'Sweep found issues.', findings };
}

/** A restart finding whose `deviceId` is OMITTED entirely (not `null` — the
 *  schema's `.nullable().optional()` allows either, and the model omits the
 *  field far more often than it sends an explicit `null`). Only
 *  `proposedAction.deviceId` names the device; gate 1 must treat the
 *  proposal's device as authoritative in this shape (#4189 bug fix). */
function restartFindingNoFindingDeviceId(deviceId: string, serviceName = 'Spooler') {
  const { deviceId: _omit, ...rest } = restartFinding(deviceId, serviceName);
  return rest;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDbState();
  createActionIntent.mockReset();
});

describe('persistSweepFindings', () => {
  // (a)
  it('creates one device-scoped supervised intent for a restart proposal on an evidence device', async () => {
    state.selectQueue.push([{ id: DEVICE_A }]);
    createActionIntent.mockResolvedValue({ id: INTENT_A, status: 'pending_approval' });

    const result = await persistSweepFindings(
      runInput(),
      outcomeWith(restartFinding(DEVICE_A)),
      agentAuth,
    );

    expect(createActionIntent).toHaveBeenCalledTimes(1);
    expect(createActionIntent).toHaveBeenCalledWith(agentAuth, {
      toolName: 'manage_services',
      input: { action: 'restart', deviceId: DEVICE_A, serviceName: 'Spooler' },
      source: 'ai_agent',
      orgId: ORG_ID,
      reason: 'Spooler is stopped',
      idempotencyKey: `sweep:${RUN_ID}:0`,
      scope: { deviceId: DEVICE_A },
    });
    expect(result.intentIds).toEqual([INTENT_A]);
    expect(result.proposals).toEqual<SweepProposalRecord[]>([{
      findingIndex: 0,
      tool: 'manage_services',
      action: 'restart',
      deviceId: DEVICE_A,
      disposition: 'intent_created',
      intentId: INTENT_A,
    }]);

    // The device existence gate is ONE batched, org-pinned, non-ephemeral
    // read run in a system context — never a per-finding query.
    expect(state.selectCount).toBe(1);
    expect(state.selectScopes).toEqual(['system']);
    const where = sqlText(state.selectWheres[0]);
    expect(where).toContain('org_id');
    expect(where).toContain('is_ephemeral');
    expect(where).toContain('in (');
    // The RUN's org id and the non-ephemeral flag are the values actually
    // BOUND — the column names alone would pass even if some other org's id
    // (or no id) were substituted.
    const params = sqlParams(state.selectWheres[0]);
    expect(params).toContain(ORG_ID);
    expect(params).toContain(false);
    expect(params).toContain(DEVICE_A);
  });

  it('builds remediate_vulnerability args from the finding and scopes the intent to its device', async () => {
    state.selectQueue.push([{ id: DEVICE_A }]);
    createActionIntent.mockResolvedValue({ id: INTENT_A, status: 'pending_approval' });
    const dvId = '00000000-0000-4000-8000-0000000000d1';

    const result = await persistSweepFindings(
      runInput(),
      outcomeWith({
        kind: 'unpatched_critical',
        severity: 'critical',
        deviceId: DEVICE_A,
        title: '3 critical CVEs unpatched',
        detail: 'Three critical findings have an approved patch available.',
        evidence: { criticalCount: 3 },
        proposedAction: {
          tool: 'remediate_vulnerability',
          deviceId: DEVICE_A,
          deviceVulnerabilityIds: [dvId],
        },
      }),
      agentAuth,
    );

    expect(createActionIntent).toHaveBeenCalledWith(agentAuth, expect.objectContaining({
      toolName: 'remediate_vulnerability',
      input: { deviceId: DEVICE_A, deviceVulnerabilityIds: [dvId] },
      scope: { deviceId: DEVICE_A },
      idempotencyKey: `sweep:${RUN_ID}:0`,
    }));
    expect(result.proposals[0]).toMatchObject({ tool: 'remediate_vulnerability', action: null });
  });

  // (b)
  it('refuses a proposal whose device is not in the run evidence set, even when the device is in the org', async () => {
    // No select rows queued: the evidence gate must short-circuit BEFORE the
    // device read, so an unexpected query would throw "no queued select rows".
    const result = await persistSweepFindings(
      runInput(),
      outcomeWith(restartFinding(DEVICE_OUTSIDE_EVIDENCE)),
      agentAuth,
    );

    expect(createActionIntent).not.toHaveBeenCalled();
    expect(state.selectCount).toBe(0);
    expect(result.intentIds).toEqual([]);
    expect(result.proposals).toEqual<SweepProposalRecord[]>([{
      findingIndex: 0,
      tool: 'manage_services',
      action: 'restart',
      deviceId: DEVICE_OUTSIDE_EVIDENCE,
      disposition: 'refused',
      reason: 'device_not_in_evidence',
    }]);
  });

  it('refuses when the finding device and the proposal device disagree', async () => {
    const finding = { ...restartFinding(DEVICE_A), deviceId: DEVICE_B };

    const result = await persistSweepFindings(runInput(), outcomeWith(finding), agentAuth);

    expect(createActionIntent).not.toHaveBeenCalled();
    expect(state.selectCount).toBe(0);
    expect(result.proposals[0]).toMatchObject({
      disposition: 'refused', reason: 'device_not_in_evidence',
    });
  });

  // #4189 bug fix: the proposal's deviceId is authoritative when the finding
  // omits its own. Observed live — two valid restart proposals produced zero
  // intents on a run because the model omitted `finding.deviceId` while
  // `proposedAction.deviceId` correctly named an evidence device.
  it('creates an intent from the proposal device when the finding omits deviceId', async () => {
    state.selectQueue.push([{ id: DEVICE_A }]);
    createActionIntent.mockResolvedValue({ id: INTENT_A, status: 'pending_approval' });

    const result = await persistSweepFindings(
      runInput(),
      outcomeWith(restartFindingNoFindingDeviceId(DEVICE_A)),
      agentAuth,
    );

    expect(createActionIntent).toHaveBeenCalledTimes(1);
    expect(createActionIntent).toHaveBeenCalledWith(agentAuth, expect.objectContaining({
      scope: { deviceId: DEVICE_A },
    }));
    expect(result.intentIds).toEqual([INTENT_A]);
    expect(result.proposals[0]).toMatchObject({
      deviceId: DEVICE_A, disposition: 'intent_created', intentId: INTENT_A,
    });
  });

  it('refuses when the finding omits deviceId and the proposal device is not in evidence', async () => {
    const result = await persistSweepFindings(
      runInput(),
      outcomeWith(restartFindingNoFindingDeviceId(DEVICE_OUTSIDE_EVIDENCE)),
      agentAuth,
    );

    expect(createActionIntent).not.toHaveBeenCalled();
    expect(state.selectCount).toBe(0);
    expect(result.proposals[0]).toMatchObject({
      deviceId: DEVICE_OUTSIDE_EVIDENCE, disposition: 'refused', reason: 'device_not_in_evidence',
    });
  });

  it('refuses when the evidence device no longer resolves inside the run org', async () => {
    // Device passed the evidence gate but the org-pinned read finds nothing
    // (deleted, moved org, or ephemeral since the evidence was collected).
    state.selectQueue.push([]);

    const result = await persistSweepFindings(
      runInput(),
      outcomeWith(restartFinding(DEVICE_A)),
      agentAuth,
    );

    expect(createActionIntent).not.toHaveBeenCalled();
    expect(result.proposals[0]).toMatchObject({
      disposition: 'refused', reason: 'device_not_in_org',
    });
  });

  // (c)
  it('refuses a proposal whose tool is not in the AGENT effective allowlist', async () => {
    state.selectQueue.push([{ id: DEVICE_A }]);

    const result = await persistSweepFindings(
      runInput({ toolAllowlist: ['get_device_details'] }),
      outcomeWith(restartFinding(DEVICE_A)),
      agentAuth,
    );

    expect(createActionIntent).not.toHaveBeenCalled();
    expect(result.proposals[0]).toMatchObject({
      disposition: 'refused', reason: 'not_allowlisted',
    });
  });

  it('accepts the specific manage_services:restart allowlist entry', async () => {
    state.selectQueue.push([{ id: DEVICE_A }]);
    createActionIntent.mockResolvedValue({ id: INTENT_A, status: 'pending_approval' });

    const result = await persistSweepFindings(
      runInput({ toolAllowlist: ['manage_services:restart'] }),
      outcomeWith(restartFinding(DEVICE_A)),
      agentAuth,
    );

    expect(createActionIntent).toHaveBeenCalledTimes(1);
    expect(result.proposals[0]!.disposition).toBe('intent_created');
  });

  // (d)
  it('caps conversions at the AGENT maxActionsPerRun and reports the rest as cap_reached', async () => {
    state.selectQueue.push([{ id: DEVICE_A }, { id: DEVICE_B }]);
    createActionIntent.mockResolvedValue({ id: INTENT_A, status: 'pending_approval' });

    const result = await persistSweepFindings(
      runInput({ maxActionsPerRun: 1 }),
      outcomeWith(restartFinding(DEVICE_A), restartFinding(DEVICE_B, 'W32Time')),
      agentAuth,
    );

    expect(createActionIntent).toHaveBeenCalledTimes(1);
    expect(result.intentIds).toEqual([INTENT_A]);
    expect(result.proposals[0]).toMatchObject({ findingIndex: 0, disposition: 'intent_created' });
    expect(result.proposals[1]).toMatchObject({
      findingIndex: 1, disposition: 'cap_reached', reason: 'max_actions_per_run',
    });
  });

  // (e)
  it('never links a cancelled intent snapshot — a no-approver cancellation is reported, not linked', async () => {
    state.selectQueue.push([{ id: DEVICE_A }]);
    createActionIntent.mockResolvedValue({
      id: INTENT_B, status: 'cancelled', errorCode: 'no_eligible_approvers',
    });

    const result = await persistSweepFindings(
      runInput(),
      outcomeWith(restartFinding(DEVICE_A)),
      agentAuth,
    );

    expect(result.intentIds).toEqual([]);
    expect(result.proposals[0]).toEqual<SweepProposalRecord>({
      findingIndex: 0,
      tool: 'manage_services',
      action: 'restart',
      deviceId: DEVICE_A,
      disposition: 'error',
      reason: 'no_eligible_approvers',
    });
    // The cancelled intent id must never reach the record either.
    expect(JSON.stringify(result.proposals)).not.toContain(INTENT_B);
  });

  it('reports a thrown createActionIntent as intent_error without failing the whole persistence', async () => {
    state.selectQueue.push([{ id: DEVICE_A }, { id: DEVICE_B }]);
    createActionIntent
      .mockRejectedValueOnce(new Error('agent_policy_denied: nope'))
      .mockResolvedValueOnce({ id: INTENT_A, status: 'pending_approval' });

    const result = await persistSweepFindings(
      runInput(),
      outcomeWith(restartFinding(DEVICE_A), restartFinding(DEVICE_B, 'W32Time')),
      agentAuth,
    );

    expect(result.proposals[0]).toMatchObject({ disposition: 'error', reason: 'intent_error' });
    expect(result.proposals[1]).toMatchObject({ disposition: 'intent_created', intentId: INTENT_A });
    expect(result.intentIds).toEqual([INTENT_A]);
    // The raw Error.message must never survive onto a persisted record.
    expect(JSON.stringify(result.proposals)).not.toContain('agent_policy_denied');
  });

  it('records nothing and reads nothing for findings that propose no action', async () => {
    const result = await persistSweepFindings(
      runInput(),
      outcomeWith({
        kind: 'disk_pressure',
        severity: 'high',
        deviceId: DEVICE_A,
        title: 'C: is 96% full',
        detail: 'C: on WS-ACCT-04 is at 96.4%.',
        evidence: { usedPercent: 96.4 },
      }),
      agentAuth,
    );

    expect(result).toEqual({ proposals: [], intentIds: [] });
    expect(state.selectCount).toBe(0);
    expect(createActionIntent).not.toHaveBeenCalled();
  });
});

describe('sweepFindingDeviceIds', () => {
  it('returns the distinct, non-null finding device ids off a raw outcome jsonb', () => {
    expect(sweepFindingDeviceIds({
      sweepFindings: outcomeWith(
        restartFinding(DEVICE_A),
        restartFinding(DEVICE_A, 'W32Time'),
        { ...restartFinding(DEVICE_B), deviceId: null, proposedAction: undefined },
      ),
    })).toEqual([DEVICE_A]);
  });

  it('tolerates a maximally-corrupt outcome jsonb', () => {
    expect(sweepFindingDeviceIds({})).toEqual([]);
    expect(sweepFindingDeviceIds({ sweepFindings: { findings: 'nope' } })).toEqual([]);
  });

  // #4189 bug fix: a finding that omitted `deviceId` still names a device via
  // its `sweepProposals` record — the route's hostname read must resolve it
  // too, or the finding renders "—" even though `projectSweep` now falls back
  // to the proposal's device.
  it('also includes proposal device ids for findings that omitted deviceId', () => {
    expect(sweepFindingDeviceIds({
      sweepFindings: outcomeWith(restartFindingNoFindingDeviceId(DEVICE_A)),
      sweepProposals: [{
        findingIndex: 0,
        tool: 'manage_services',
        action: 'restart',
        deviceId: DEVICE_A,
        disposition: 'intent_created',
        intentId: INTENT_A,
      }] as SweepProposalRecord[],
    })).toEqual([DEVICE_A]);
  });
});

describe('projectSweep', () => {
  const traceRun = {
    scheduleId: SCHEDULE_ID,
    triggerRef: {
      scheduleId: SCHEDULE_ID,
      occurrenceKey: '2026-08-29T06:00:00Z',
      sweepKinds: ['service_down', 'disk_pressure', 'not_a_real_kind'],
    } as Record<string, unknown>,
  };

  const projectedOutcome = {
    sweepFindings: outcomeWith(
      restartFinding(DEVICE_A),
      {
        kind: 'disk_pressure' as const,
        severity: 'high' as const,
        deviceId: null,
        title: 'Fleet disk pressure',
        detail: 'Three machines are over 90%.',
        evidence: { affected: 3 },
      },
    ),
    sweepProposals: [{
      findingIndex: 0,
      tool: 'manage_services',
      action: 'restart',
      deviceId: DEVICE_A,
      disposition: 'intent_created',
      intentId: INTENT_A,
    }] as SweepProposalRecord[],
    sweepEvidenceTruncated: true,
  };

  it('returns null when the outcome carries no sweep findings', () => {
    expect(projectSweep(traceRun, {}, new Map())).toBeNull();
  });

  // (f)
  it('projects display-safe findings with hostnames and never the raw proposal args', () => {
    const dto = projectSweep(
      traceRun,
      projectedOutcome,
      new Map([[DEVICE_A, 'WS-ACCT-04']]),
    );

    expect(dto).toEqual({
      scheduleId: SCHEDULE_ID,
      occurrenceKey: '2026-08-29T06:00:00Z',
      // Unknown kinds are dropped, catalog-checked exactly as the run loop
      // narrows `triggerRef.sweepKinds`.
      kinds: ['service_down', 'disk_pressure'],
      summary: 'Sweep found issues.',
      evidenceTruncated: true,
      findings: [
        {
          kind: 'service_down',
          severity: 'critical',
          deviceId: DEVICE_A,
          deviceHostname: 'WS-ACCT-04',
          title: 'Spooler is stopped',
          detail: 'Spooler has been stopped for 3 days.',
          evidence: { state: 'stopped' },
          proposal: {
            tool: 'manage_services',
            action: 'restart',
            disposition: 'intent_created',
            reason: null,
            intentId: INTENT_A,
          },
        },
        {
          kind: 'disk_pressure',
          severity: 'high',
          deviceId: null,
          deviceHostname: null,
          title: 'Fleet disk pressure',
          detail: 'Three machines are over 90%.',
          evidence: { affected: 3 },
          proposal: null,
        },
      ],
    });

    const serialized = JSON.stringify(dto);
    for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
    // The finding's raw `proposedAction` (and the service name it names) is
    // never carried onto the wire — only the disposition of the attempt.
    expect(serialized).not.toContain('proposedAction');
    expect(serialized).not.toContain('serviceName');
  });

  it('carries a refusal reason and a null intentId for a proposal that was never created', () => {
    const dto = projectSweep(
      traceRun,
      {
        ...projectedOutcome,
        sweepProposals: [{
          findingIndex: 0,
          tool: 'manage_services',
          action: 'restart',
          deviceId: DEVICE_A,
          disposition: 'refused',
          reason: 'not_allowlisted',
        }],
      },
      new Map(),
    );

    expect(dto!.findings[0]!.proposal).toEqual({
      tool: 'manage_services',
      action: 'restart',
      disposition: 'refused',
      reason: 'not_allowlisted',
      intentId: null,
    });
    expect(dto!.findings[0]!.deviceHostname).toBeNull();
  });

  // Final-review fix (#4189, item 7). `evidence` is a model-authored
  // string->scalar map, so the model can NAME a key `toolOutput` and smuggle
  // its own tool transcript past every leak tripwire in the suite — those
  // assert on `JSON.stringify(dto)` not containing `"toolOutput"`, which is
  // exactly the string a legitimate-looking evidence key produces. Dropped at
  // projection, case-insensitively.
  it('drops evidence keys that shadow a leak-tripwire key (case-insensitively)', () => {
    const finding = restartFinding(DEVICE_A);
    const dto = projectSweep(
      traceRun,
      {
        sweepFindings: outcomeWith({
          ...finding,
          evidence: {
            state: 'stopped',
            toolOutput: 'raw transcript',
            ARGS: 'smuggled',
            arguments: 'also smuggled',
            toolinput: 'lowercase variant',
          },
        }) as SweepFindingsOutcome,
      },
      new Map(),
    );

    expect(dto!.findings[0]!.evidence).toEqual({ state: 'stopped' });
    const serialized = JSON.stringify(dto);
    for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
  });

  // #4189 bug fix: a finding whose `deviceId` was omitted but which carries a
  // proposal must still project a `deviceId`/`deviceHostname` — never "—" —
  // by falling back to the proposal record's device.
  it('falls back to the proposal device when the finding omits deviceId', () => {
    const dto = projectSweep(
      traceRun,
      {
        sweepFindings: outcomeWith(restartFindingNoFindingDeviceId(DEVICE_A)),
        sweepProposals: [{
          findingIndex: 0,
          tool: 'manage_services',
          action: 'restart',
          deviceId: DEVICE_A,
          disposition: 'intent_created',
          intentId: INTENT_A,
        }] as SweepProposalRecord[],
      },
      new Map([[DEVICE_A, 'WS-ACCT-04']]),
    );

    expect(dto!.findings[0]!.deviceId).toBe(DEVICE_A);
    expect(dto!.findings[0]!.deviceHostname).toBe('WS-ACCT-04');
  });

  it('tolerates a run with no schedule and a missing triggerRef', () => {
    const dto = projectSweep(
      { scheduleId: null, triggerRef: {} },
      { sweepFindings: outcomeWith(restartFinding(DEVICE_A)) },
      new Map(),
    );

    expect(dto).toMatchObject({
      scheduleId: null, occurrenceKey: null, kinds: [], evidenceTruncated: false,
    });
    expect(dto!.findings[0]!.proposal).toBeNull();
  });
});
