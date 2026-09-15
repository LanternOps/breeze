// apps/api/src/services/aiAgents/sweepFindings.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sweepSubjectIndexKey, type SweepEvidenceSubject } from './sweepEvidence';
import type { SQL } from 'drizzle-orm';
import {
  AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS, remediationTriggerSchema, type SweepFinding, type SweepFindingsOutcome,
} from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const RUN_ID = '00000000-0000-4000-8000-0000000000a2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000a3';
const SCHEDULE_ID = '00000000-0000-4000-8000-0000000000a4';
/** The org's tighten-only override of SCHEDULE_ID (#4442 W04). */
const OVERRIDE_SCHEDULE_ID = '00000000-0000-4000-8000-0000000000a6';
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
  /** #4442 W05 — every raw `db.execute` (the cohort's per-org advisory lock). */
  executed: [] as unknown[],
  /** #4442 W05 — the ambient scope each `db.execute` ran under. */
  executeScopes: [] as Array<string | undefined>,
}));

function resetDbState(): void {
  state.selectQueue = [];
  state.selectWheres = [];
  state.selectCount = 0;
  state.ambientContext = undefined;
  state.selectScopes = [];
  state.executed = [];
  state.executeScopes = [];
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
    db: {
      select: vi.fn(() => selectBuilder()),
      execute: vi.fn(async (q: unknown) => {
        state.executed.push(q);
        state.executeScopes.push(state.ambientContext?.scope);
        return [];
      }),
    },
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

const captureException = vi.hoisted(() => vi.fn());
vi.mock('../sentry', () => ({ captureException }));

// #4442 W05 — the readiness cohort reads the exposure ledger through the ONE
// shared `computeExposureBudget`. Mocked here so this suite stays a pure unit
// test of the wiring; the arithmetic itself is covered by
// `sweepActCohort.test.ts` and, against real Postgres, by
// `sweepActFanout.integration.test.ts`.
const computeExposureBudget = vi.hoisted(() =>
  vi.fn(async () => ({
    distinctDevices: 0,
    exposedDeviceIds: new Set<string>() as ReadonlySet<string>,
    allowance: 50,
    contractDeviceCount: 1000,
    maxFleetPercentPerDay: 5,
    policyDecisionsToday: 0,
    maxPolicyDecisionsPerDay: 200,
    windowHours: 24 as const,
  })));
vi.mock('../actionIntents/exposureBudget', () => ({ computeExposureBudget }));

import {
  persistSweepFindings,
  projectSweep,
  sweepFindingDeviceIds,
  sweepSubjectKey,
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
    // #4442 W05 — cohort caps. Generous by default so the pre-existing gate
    // suite is unaffected; the cohort's own arithmetic is tested in
    // `sweepActCohort.test.ts` and against real Postgres in
    // `sweepActFanout.integration.test.ts`.
    maxFleetPercentPerDay: 100,
    maxPolicyDecisionsPerDay: 200,
    maxUnattendedDevicesPerSweep: 50,
    evidenceDeviceIds: new Set([DEVICE_A, DEVICE_B]) as ReadonlySet<string>,
    // #4442 W04 — the SYSTEM's own subjects for the rows it loaded. The
    // default covers the two service names this suite proposes restarts for,
    // on both evidence devices; a test that proposes anything else must say
    // so explicitly, which is the anti-substitution control working.
    evidenceSubjects: subjectIndex(
      { kind: 'service_down', deviceId: DEVICE_A, key: 'Spooler' },
      { kind: 'service_down', deviceId: DEVICE_A, key: 'W32Time' },
      { kind: 'service_down', deviceId: DEVICE_B, key: 'Spooler' },
      { kind: 'service_down', deviceId: DEVICE_B, key: 'W32Time' },
    ),
    ...overrides,
  };
}

/** Build a `kind|deviceId|key` subject index the way `indexEvidenceSubjects` does. */
function subjectIndex(
  ...subjects: Array<{ kind: SweepEvidenceSubject['kind']; deviceId: string; key: string; observedAt?: string | null }>
): ReadonlyMap<string, SweepEvidenceSubject> {
  const map = new Map<string, SweepEvidenceSubject>();
  for (const s of subjects) {
    map.set(sweepSubjectIndexKey(s.kind, s.deviceId, s.key), {
      kind: s.kind, deviceId: s.deviceId, key: s.key, observedAt: s.observedAt ?? '2026-09-15T10:00:00.000Z',
    });
  }
  return map;
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
      trigger: { kind: 'sweep_finding', refId: RUN_ID, key: 'sweep:service_down:Spooler' },
      idempotencyKey: `sweep:${RUN_ID}:0`,
      scope: { deviceId: DEVICE_A },
      // #4442 W04 — the act descriptor rides along on every sweep-minted
      // intent; with the sub-flag off it can only ever say "not armed".
      sweepAct: {
        scheduleActMode: false,
        subject: { kind: 'service_down', key: 'Spooler', observedAt: '2026-09-15T10:00:00.000Z' },
        argumentsMatchSubject: true,
      },
    });
    expect(result.intentIds).toEqual([INTENT_A]);
    expect(result.proposals).toEqual<SweepProposalRecord[]>([{
      findingIndex: 0,
      tool: 'manage_services',
      action: 'restart',
      deviceId: DEVICE_A,
      disposition: 'intent_created',
      intentId: INTENT_A,
      // #4442 W04 — the SYSTEM's matched evidence subject, recorded on every
      // proposal that clears gate 1b.
      subject: { kind: 'service_down', key: 'Spooler', observedAt: '2026-09-15T10:00:00.000Z' },
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
      runInput({
        evidenceSubjects: subjectIndex({ kind: 'unpatched_critical', deviceId: DEVICE_A, key: dvId }),
      }),
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
      trigger: { kind: 'sweep_finding', refId: RUN_ID, key: `sweep:unpatched_critical:${dvId}` },
    }));
    expect(result.proposals[0]).toMatchObject({ tool: 'remediate_vulnerability', action: null });
    // #4442 W04 — the act descriptor is computed from the REAL arguments at
    // this call site, not hand-set: `remediate_vulnerability` is not the one
    // op key act mode covers in v1, so the intent it mints can never be
    // policy-decided even though gate 1b matched its subject. Asserting the
    // FALSE direction here is what proves the call site is wired at all —
    // every other case in this suite matches, so a hardcoded `true` would
    // otherwise survive.
    expect(createActionIntent.mock.calls[0]![1]).toMatchObject({
      sweepAct: expect.objectContaining({ argumentsMatchSubject: false }),
    });
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
      subject: { kind: 'service_down', key: 'Spooler', observedAt: '2026-09-15T10:00:00.000Z' },
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

  // Review fix (PR #5780, HIGH) — `createActionIntent` validates `trigger`
  // with `remediationTriggerSchema.parse(...)` (intentService.ts). A
  // `ZodError` there means THIS file built a malformed trigger — a code
  // defect, not a business-outcome denial — and must be loud in Sentry with
  // a distinct reason, never collapsed into the ordinary `intent_error`
  // bucket used for genuine denials like `org_resolution_failed`.
  it('reports a ZodError from createActionIntent as intent_invalid_provenance and captures it in Sentry', async () => {
    state.selectQueue.push([{ id: DEVICE_A }]);
    const zodError = remediationTriggerSchema.safeParse({ kind: 'sweep_finding', key: '' }).error;
    createActionIntent.mockRejectedValue(zodError);

    const result = await persistSweepFindings(
      runInput(),
      outcomeWith(restartFinding(DEVICE_A)),
      agentAuth,
    );

    expect(result.proposals[0]).toMatchObject({ disposition: 'error', reason: 'intent_invalid_provenance' });
    expect(result.intentIds).toEqual([]);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(zodError, undefined, expect.objectContaining({
      runId: RUN_ID, findingIndex: '0',
    }));
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

// #4442 W04 Task 4 — gate 1b, the ANTI-SUBSTITUTION control. Device identity
// alone is not enough: a `service_down` observation is about (device, service
// NAME), and a proposal naming a different service on that same device cites
// evidence that does not exist.
describe('persistSweepFindings — the trusted subject (gate 1b)', () => {
  it('attaches the SYSTEM subject to the record when the proposal matches an evidence row', async () => {
    state.selectQueue.push([{ id: DEVICE_A }]);
    createActionIntent.mockResolvedValue({ id: INTENT_A, status: 'pending_approval' });

    const result = await persistSweepFindings(
      runInput({
        evidenceSubjects: subjectIndex({
          kind: 'service_down', deviceId: DEVICE_A, key: 'Spooler', observedAt: '2026-09-15T09:30:00.000Z',
        }),
      }),
      outcomeWith(restartFinding(DEVICE_A)),
      agentAuth,
    );

    expect(result.proposals[0]).toMatchObject({
      disposition: 'intent_created',
      subject: { kind: 'service_down', key: 'Spooler', observedAt: '2026-09-15T09:30:00.000Z' },
    });
  });

  it('refuses a proposal whose serviceName does not match ANY evidence subject for that device', async () => {
    const result = await persistSweepFindings(
      runInput({
        evidenceSubjects: subjectIndex({ kind: 'service_down', deviceId: DEVICE_A, key: 'Spooler' }),
      }),
      outcomeWith(restartFinding(DEVICE_A, 'W32Time')),
      agentAuth,
    );

    expect(createActionIntent).not.toHaveBeenCalled();
    expect(result.proposals).toEqual([expect.objectContaining({
      findingIndex: 0,
      disposition: 'refused',
      reason: 'subject_not_in_evidence',
    })]);
    expect(result.proposals[0]).not.toHaveProperty('subject');
  });

  it('refuses a proposal on the right service but the WRONG device — the subject is (device, key)', async () => {
    const result = await persistSweepFindings(
      runInput({
        evidenceSubjects: subjectIndex({ kind: 'service_down', deviceId: DEVICE_B, key: 'Spooler' }),
      }),
      outcomeWith(restartFinding(DEVICE_A)),
      agentAuth,
    );

    expect(result.proposals[0]).toMatchObject({ disposition: 'refused', reason: 'subject_not_in_evidence' });
  });

  it('refuses rather than silently marking act-ineligible when no subject can be matched at all', async () => {
    const result = await persistSweepFindings(
      runInput({ evidenceSubjects: subjectIndex() }),
      outcomeWith(restartFinding(DEVICE_A)),
      agentAuth,
    );

    expect(result.proposals[0]).toMatchObject({ disposition: 'refused', reason: 'subject_not_in_evidence' });
    expect(createActionIntent).not.toHaveBeenCalled();
  });

  it('the device-evidence gate still fires FIRST — a device outside the evidence set is device_not_in_evidence', async () => {
    const result = await persistSweepFindings(
      runInput({ evidenceSubjects: subjectIndex() }),
      outcomeWith(restartFinding(DEVICE_OUTSIDE_EVIDENCE)),
      agentAuth,
    );

    expect(result.proposals[0]).toMatchObject({ reason: 'device_not_in_evidence' });
  });

  it('a finding that proposes nothing needs no subject and is not recorded at all', async () => {
    const { proposedAction: _drop, ...findingOnly } = restartFinding(DEVICE_A);

    const result = await persistSweepFindings(
      runInput({ evidenceSubjects: subjectIndex() }),
      outcomeWith(findingOnly as SweepFindingsOutcome['findings'][number]),
      agentAuth,
    );

    expect(result.proposals).toEqual([]);
    expect(createActionIntent).not.toHaveBeenCalled();
  });
});

// #4442 W04 Task 5 — what `persistSweepFindings` hands the CREATION gate.
// The act descriptor is assembled from SYSTEM state only: the effective
// (partner baseline ∧ org override) schedule act mode, the trusted subject
// gate 1b matched, and whether the intent's own arguments name that subject.
describe('persistSweepFindings — the sweep act descriptor', () => {
  const ORIGINAL_FLAG = process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED;

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED;
    else process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = ORIGINAL_FLAG;
  });

  it('reads no schedule and passes no descriptor when the sub-flag is off (byte-identical to today)', async () => {
    process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'false';
    state.selectQueue.push([{ id: DEVICE_A }]);
    createActionIntent.mockResolvedValue({ id: INTENT_A, status: 'pending_approval' });

    await persistSweepFindings(runInput(), outcomeWith(restartFinding(DEVICE_A)), agentAuth);

    // ONE select only — the device existence read. A schedule lookup behind
    // the flag would be a behaviour change even with the same verdict.
    expect(state.selectCount).toBe(1);
    // The descriptor is still handed over (it is inert data), but it can only
    // ever say "not armed" — and `resolvePolicyDecisionState` checks the flag
    // before it reads any of it.
    expect(createActionIntent).toHaveBeenCalledWith(agentAuth, expect.objectContaining({
      sweepAct: expect.objectContaining({ scheduleActMode: false }),
    }));
  });

  it('passes the effective act mode and the SYSTEM subject when the partner baseline is armed', async () => {
    process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'true';
    // baseline, then this org's override, then the device existence read.
    state.selectQueue.push([{ id: SCHEDULE_ID, actMode: true }]);
    state.selectQueue.push([]);
    state.selectQueue.push([{ id: DEVICE_A }]);
    createActionIntent.mockResolvedValue({ id: INTENT_A, status: 'pending_approval' });

    await persistSweepFindings(runInput(), outcomeWith(restartFinding(DEVICE_A)), agentAuth);

    expect(createActionIntent).toHaveBeenCalledWith(agentAuth, expect.objectContaining({
      sweepAct: {
        scheduleActMode: true,
        subject: { kind: 'service_down', key: 'Spooler', observedAt: '2026-09-15T10:00:00.000Z' },
        argumentsMatchSubject: true,
      },
    }));
  });

  it('an ORG override that disarms wins over an armed partner baseline', async () => {
    process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'true';
    state.selectQueue.push([{ id: SCHEDULE_ID, actMode: true }]);
    state.selectQueue.push([{ id: OVERRIDE_SCHEDULE_ID, actMode: false }]);
    state.selectQueue.push([{ id: DEVICE_A }]);
    createActionIntent.mockResolvedValue({ id: INTENT_A, status: 'pending_approval' });

    await persistSweepFindings(runInput(), outcomeWith(restartFinding(DEVICE_A)), agentAuth);

    expect(createActionIntent).toHaveBeenCalledWith(agentAuth, expect.objectContaining({
      sweepAct: expect.objectContaining({ scheduleActMode: false }),
    }));
  });

  it('a run with no schedule id at all resolves act mode FALSE without querying', async () => {
    process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'true';
    state.selectQueue.push([{ id: DEVICE_A }]);
    createActionIntent.mockResolvedValue({ id: INTENT_A, status: 'pending_approval' });

    await persistSweepFindings(
      runInput({ scheduleId: null }),
      outcomeWith(restartFinding(DEVICE_A)),
      agentAuth,
    );

    expect(state.selectCount).toBe(1);
    expect(createActionIntent).toHaveBeenCalledWith(agentAuth, expect.objectContaining({
      sweepAct: expect.objectContaining({ scheduleActMode: false }),
    }));
  });

  it('a schedule row that has vanished resolves act mode FALSE — fail closed', async () => {
    process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'true';
    // No baseline row: the override is never even read (nothing to tighten),
    // so the next queued result is the device existence read.
    state.selectQueue.push([]);
    state.selectQueue.push([{ id: DEVICE_A }]);
    createActionIntent.mockResolvedValue({ id: INTENT_A, status: 'pending_approval' });

    await persistSweepFindings(runInput(), outcomeWith(restartFinding(DEVICE_A)), agentAuth);

    expect(createActionIntent).toHaveBeenCalledWith(agentAuth, expect.objectContaining({
      sweepAct: expect.objectContaining({ scheduleActMode: false }),
    }));
  });
});

describe('sweepSubjectKey', () => {
  it('reads disk_pressure from evidence.mountPoint', () => {
    const finding: SweepFinding = {
      kind: 'disk_pressure',
      severity: 'high',
      deviceId: DEVICE_A,
      title: 'C: is 96% full',
      detail: 'C: on WS-ACCT-04 is at 96.4%.',
      evidence: { usedPercent: 96.4, mountPoint: 'C:' },
    };

    expect(sweepSubjectKey(finding)).toBe('C:');
  });

  it('sorts and joins unpatched_critical deviceVulnerabilityIds from the proposal', () => {
    const finding: SweepFinding = {
      kind: 'unpatched_critical',
      severity: 'critical',
      deviceId: DEVICE_A,
      title: '2 critical CVEs unpatched',
      detail: 'Two critical findings have an approved patch available.',
      evidence: { criticalCount: 2 },
      proposedAction: {
        tool: 'remediate_vulnerability',
        deviceId: DEVICE_A,
        deviceVulnerabilityIds: ['dv-b', 'dv-a'],
      },
    };

    expect(sweepSubjectKey(finding)).toBe('dv-a,dv-b');
  });

  it('falls back to evidence.name for a service_down finding without a manage_services proposal', () => {
    const finding: SweepFinding = {
      kind: 'service_down',
      severity: 'critical',
      deviceId: DEVICE_A,
      title: 'Spooler is stopped',
      detail: 'Spooler has been stopped for 3 days.',
      evidence: { state: 'stopped', name: 'Spooler' },
    };

    expect(sweepSubjectKey(finding)).toBe('Spooler');
  });

  it('returns null for a kind the switch does not recognize', () => {
    const finding: SweepFinding = {
      kind: 'pending_reboots',
      severity: 'medium',
      deviceId: DEVICE_A,
      title: 'Reboot pending',
      detail: 'A reboot has been pending for 5 days.',
      evidence: {},
    };

    expect(sweepSubjectKey(finding)).toBeNull();
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
      // No cohort verdict on the fixture's SweepProposalRecord, so there is
      // nothing truthful to roll up.
      actSummary: null,
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
            // `intentOutcomes` defaults to an empty map in this call, so the
            // live outcome is unknown; the fixture's proposal record carries
            // no cohort verdict either.
            outcome: null,
            cohort: null,
            stoppedBy: null,
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
      outcome: null,
      cohort: null,
      stoppedBy: null,
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

// #4442 W05 — the readiness cohort's WIRING inside `persistSweepFindings`.
// The walk's arithmetic itself lives in `sweepActCohort.test.ts` (pure) and is
// proved against real Postgres in `sweepActFanout.integration.test.ts`; what
// is asserted here is that the occurrence reads the ledger once, under the
// per-org advisory lock, and that a non-member is minted as an ORDINARY card
// rather than dropped.
describe('persistSweepFindings — the readiness cohort (#4442 W05)', () => {
  const ORIGINAL_FLAG = process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED;

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED;
    else process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = ORIGINAL_FLAG;
  });

  /** Baseline armed, no org override, then the device existence read. */
  function queueArmedSchedule(deviceRows: Array<{ id: string }>): void {
    state.selectQueue.push([{ id: SCHEDULE_ID, actMode: true }]);
    state.selectQueue.push([]);
    state.selectQueue.push(deviceRows);
  }

  it('takes the SAME per-org advisory lock the authorize path takes, under a system context', async () => {
    process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'true';
    queueArmedSchedule([{ id: DEVICE_A }]);
    createActionIntent.mockResolvedValue({ id: INTENT_A, status: 'pending_approval' });

    await persistSweepFindings(runInput(), outcomeWith(restartFinding(DEVICE_A)), agentAuth);

    expect(state.executed).toHaveLength(1);
    const query = new PgDialect().sqlToQuery(state.executed[0] as SQL);
    expect(query.sql).toContain('pg_advisory_xact_lock');
    expect(query.sql).toContain('hashtextextended');
    expect(query.params).toEqual([`ai-exposure:${ORG_ID}`]);
    expect(state.executeScopes).toEqual(['system']);
  });

  it('reads the exposure ledger ONCE per occurrence, not once per proposal', async () => {
    process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'true';
    queueArmedSchedule([{ id: DEVICE_A }, { id: DEVICE_B }]);
    createActionIntent.mockResolvedValue({ id: INTENT_A, status: 'pending_approval' });

    await persistSweepFindings(
      runInput(),
      outcomeWith(restartFinding(DEVICE_A), restartFinding(DEVICE_B)),
      agentAuth,
    );

    expect(computeExposureBudget).toHaveBeenCalledTimes(1);
    expect(computeExposureBudget).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      agentId: AGENT_ID,
    }));
    // No `deviceId`: the walk projects the union itself rather than asking
    // the ledger to project one hypothetical device.
    const budgetArgs = (computeExposureBudget.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
    expect(budgetArgs).not.toHaveProperty('deviceId');
  });

  it('a DISARMED occurrence computes no cohort at all — no ledger read, no lock, no cohort fields', async () => {
    process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'true';
    state.selectQueue.push([{ id: SCHEDULE_ID, actMode: false }]);
    state.selectQueue.push([]);
    state.selectQueue.push([{ id: DEVICE_A }]);
    createActionIntent.mockResolvedValue({ id: INTENT_A, status: 'pending_approval' });

    const result = await persistSweepFindings(
      runInput(), outcomeWith(restartFinding(DEVICE_A)), agentAuth,
    );

    expect(computeExposureBudget).not.toHaveBeenCalled();
    expect(state.executed).toEqual([]);
    expect(result.proposals[0]!.cohort).toBeUndefined();
    expect(result.proposals[0]!.stoppedBy).toBeUndefined();
  });

  it('mints the cohort prefix act-eligible and the REST as ordinary cards — nothing is dropped', async () => {
    process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'true';
    queueArmedSchedule([{ id: DEVICE_A }, { id: DEVICE_B }]);
    // One device's worth of allowance: the second device falls outside.
    computeExposureBudget.mockResolvedValueOnce({
      distinctDevices: 0,
      exposedDeviceIds: new Set<string>() as ReadonlySet<string>,
      allowance: 1,
      contractDeviceCount: 20,
      maxFleetPercentPerDay: 5,
      policyDecisionsToday: 0,
      maxPolicyDecisionsPerDay: 200,
      windowHours: 24 as const,
    });
    createActionIntent
      .mockResolvedValueOnce({ id: INTENT_A, status: 'pending_approval' })
      .mockResolvedValueOnce({ id: INTENT_B, status: 'pending_approval' });

    const result = await persistSweepFindings(
      runInput(),
      outcomeWith(restartFinding(DEVICE_A), restartFinding(DEVICE_B)),
      agentAuth,
    );

    // BOTH proposals still became pending intents — the cohort bounds
    // act-eligibility, never existence.
    expect(result.proposals.map((p) => p.disposition)).toEqual(['intent_created', 'intent_created']);
    expect(result.intentIds).toEqual([INTENT_A, INTENT_B]);

    const byDevice = new Map(
      createActionIntent.mock.calls.map(([, input]) => [
        (input.scope as { deviceId: string }).deviceId, input,
      ]),
    );
    // DEVICE_A sorts first under the documented order, so it is the member.
    expect(byDevice.get(DEVICE_A)!.sweepAct).toEqual(expect.objectContaining({ scheduleActMode: true }));
    expect(byDevice.get(DEVICE_B)!.sweepAct).toBeUndefined();

    const recordFor = (deviceId: string) => result.proposals.find((p) => p.deviceId === deviceId)!;
    expect(recordFor(DEVICE_A).cohort).toBe(true);
    expect(recordFor(DEVICE_B).cohort).toBe(false);
    expect(recordFor(DEVICE_B).stoppedBy).toBe('fleet_cap');
  });

  it('does NOT label a proposal refused for an UNRELATED reason with a capacity cap', async () => {
    // Review fix: `stoppedBy` is the CAPACITY explanation. A proposal whose
    // tool is not allowlisted was never cohort-eligible — it is waiting on a
    // human for a reason that has nothing to do with the caps, and stamping
    // it with `fleet_cap` would be a plainly wrong explanation on the run
    // detail.
    process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'true';
    queueArmedSchedule([{ id: DEVICE_A }, { id: DEVICE_B }]);
    computeExposureBudget.mockResolvedValueOnce({
      distinctDevices: 0,
      exposedDeviceIds: new Set<string>() as ReadonlySet<string>,
      allowance: 1,
      contractDeviceCount: 20,
      maxFleetPercentPerDay: 5,
      policyDecisionsToday: 0,
      maxPolicyDecisionsPerDay: 200,
      windowHours: 24 as const,
    });
    createActionIntent.mockResolvedValue({ id: INTENT_A, status: 'pending_approval' });

    const result = await persistSweepFindings(
      // DEVICE_B's proposal names a tool the agent may not use at all.
      runInput({ toolAllowlist: ['remediate_vulnerability'] }),
      outcomeWith(restartFinding(DEVICE_A), restartFinding(DEVICE_B)),
      agentAuth,
    );

    for (const record of result.proposals) {
      expect(record.reason).toBe('not_allowlisted');
      expect(record.cohort).toBe(false);
      // Never cohort-eligible -> no capacity explanation.
      expect(record.stoppedBy).toBeNull();
    }
  });
});
