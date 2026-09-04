// apps/api/src/services/aiAgents/alertVerdicts.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  AI_AGENT_ALERT_VERDICT_OP_KEY, AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS, type AlertVerdictOutcome,
} from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000e1';
const RUN_ID = '00000000-0000-4000-8000-0000000000e2';
const ALERT_ID = '00000000-0000-4000-8000-0000000000e4';
const OTHER_ALERT_ID = '00000000-0000-4000-8000-0000000000e5';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000e6';
const PRIOR_VERDICT_ID = '00000000-0000-4000-8000-0000000000e8';
const INTENT_ID = '00000000-0000-4000-8000-0000000000e9';
const USER_ID = '00000000-0000-4000-8000-0000000000ea';
const GROUP_ID = '00000000-0000-4000-8000-0000000000eb';
const OTHER_USER_ID = '00000000-0000-4000-8000-0000000000ec';
const AGENT_ID = '00000000-0000-4000-8000-0000000000ed';
const RULE_ID = '00000000-0000-4000-8000-0000000000ee';
const ROOT_ALERT_ID = '00000000-0000-4000-8000-0000000000ef';

const state = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  selectWheres: [] as unknown[],
  // Task 7 (#4192) — `recordVerdictFeedback`'s locking SELECT. Recorded the
  // same way `narrativeReport.test.ts` does: one boolean per `select()`
  // call, pushed when its `.for(...)` builder method fires (or not).
  selectForUpdate: [] as boolean[],
  insertReturningQueue: [] as (unknown[] | undefined)[],
  insertValues: [] as Record<string, unknown>[],
  // Task 7 — the `ON CONFLICT ("source_id") ... DO UPDATE` clause
  // `upsertVerdictFeedbackEvidenceQuery` passes to `.onConflictDoUpdate(...)`.
  insertConflicts: [] as (Record<string, unknown> | undefined)[],
  updateSets: [] as Record<string, unknown>[],
  updateWheres: [] as unknown[],
  updateReturningQueue: [] as (unknown[] | undefined)[],
  selectCount: 0,
  insertCount: 0,
  updateCount: 0,
  ambientContext: undefined as { scope: string } | undefined,
  // Carry-in C 23505 test knob: when set, the NEXT bare (non-`.returning()`)
  // insert's implicit `.then()` rejects with this error instead of
  // resolving — simulates the live-verdict partial unique's concurrent-
  // supersede race.
  insertThrow: undefined as unknown,
}));

function resetDbState(): void {
  state.selectQueue = [];
  state.selectWheres = [];
  state.selectForUpdate = [];
  state.insertReturningQueue = [];
  state.insertValues = [];
  state.insertConflicts = [];
  state.updateSets = [];
  state.updateWheres = [];
  state.updateReturningQueue = [];
  state.selectCount = 0;
  state.insertCount = 0;
  state.updateCount = 0;
  state.ambientContext = undefined;
  state.insertThrow = undefined;
}

vi.mock('../../db', () => {
  function selectBuilder() {
    state.selectCount += 1;
    let forUpdate = false;
    const builder: Record<string, unknown> = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn((w: unknown) => {
        state.selectWheres.push(w);
        return builder;
      }),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      for: vi.fn((mode: string) => {
        forUpdate = mode === 'update';
        return builder;
      }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            state.selectForUpdate.push(forUpdate);
            if (state.selectQueue.length === 0) throw new Error('no queued select rows');
            return state.selectQueue.shift();
          })
          .then(resolve, reject),
    };
    return builder;
  }

  function insertBuilder() {
    state.insertCount += 1;
    const builder: Record<string, unknown> = {
      values: vi.fn((v: Record<string, unknown>) => {
        state.insertValues.push(v);
        return builder;
      }),
      returning: vi.fn(() => ({
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(state.insertReturningQueue.shift() ?? []).then(resolve, reject),
      })),
      // `upsertVerdictFeedbackEvidenceQuery` (Task 7, opEvidence.ts) — the
      // single `verdict_feedback` evidence row is upserted, never a plain
      // insert. Returns `builder` itself (unexecuted) so the bare `await`
      // in `upsertVerdictFeedbackEvidence` resolves through the SAME `then`
      // as every other bare insert below.
      onConflictDoUpdate: vi.fn((clause: Record<string, unknown>) => {
        state.insertConflicts.push(clause);
        return builder;
      }),
      // Bare (non-`.returning()`) insert — `persistAlertVerdict`'s write
      // ordering awaits `.values(...)` directly. Rejects with the queued
      // `insertThrow` error when set (see its own docstring on `state`).
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        const err = state.insertThrow;
        if (err) {
          state.insertThrow = undefined;
          return Promise.reject(err).then(resolve, reject);
        }
        return Promise.resolve([]).then(resolve, reject);
      },
    };
    return builder;
  }

  function updateBuilder() {
    state.updateCount += 1;
    const builder: Record<string, unknown> = {
      set: vi.fn((v: Record<string, unknown>) => {
        state.updateSets.push(v);
        return builder;
      }),
      where: vi.fn((w: unknown) => {
        state.updateWheres.push(w);
        return builder;
      }),
      returning: vi.fn(() => ({
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(state.updateReturningQueue.shift() ?? []).then(resolve, reject),
      })),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve([]).then(resolve, reject),
    };
    return builder;
  }

  return {
    db: {
      select: vi.fn(() => selectBuilder()),
      insert: vi.fn(() => insertBuilder()),
      update: vi.fn(() => updateBuilder()),
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

// Carry-in C (live-verdict partial unique) — `persistAlertVerdict` now
// generates the new verdict row's id CLIENT-SIDE (`randomUUID()`) so it can
// supersede the prior live row BEFORE inserting (see the source file's
// "Write ordering, part 2" docstring). Mocked deterministic so
// `VERDICT_ROW_ID` below still names the id `persistAlertVerdict` actually
// writes.
const { MOCK_VERDICT_ID } = vi.hoisted(() => ({ MOCK_VERDICT_ID: '00000000-0000-4000-8000-0000000000e7' }));
vi.mock('node:crypto', () => ({ randomUUID: vi.fn(() => MOCK_VERDICT_ID) }));
// `vi.hoisted` bindings execute before ordinary top-of-file statements
// (including the plain `const` ids below), so referencing MOCK_VERDICT_ID
// here is safe despite this line appearing textually before its own
// declaration.
const VERDICT_ROW_ID = MOCK_VERDICT_ID;

import {
  latestVerdictForGroup, latestVerdictsForAlerts, persistAlertVerdict, projectAlertAiVerdictSummary,
  projectAlertVerdict, recordVerdictFeedback,
} from './alertVerdicts';

const dialect = new PgDialect();
function sqlText(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql;
}

const agentAuth = {
  principal: { kind: 'ai_agent' },
  user: { id: USER_ID, email: 'agent@breeze.internal', name: 'Agent', isPlatformAdmin: false },
  orgId: ORG_ID,
  partnerId: null,
  scope: 'organization',
} as never;

// Note: `agentId` was dropped from `persistAlertVerdict`'s `run` param
// (review round 1 minor fix — it was never used in the function body).
// `toolAllowlist: ['manage_alerts']` (review round 2, IMPORTANT 1) — the
// bare tool name admits both `suppress` and `resolve`, matching most tests'
// intent here: exercising the OTHER refusal gates, not this one. Tests that
// specifically exercise the allowlist gate override it.
const runInput = {
  id: RUN_ID,
  orgId: ORG_ID,
  alertId: ALERT_ID,
  correlationGroupId: null,
  deviceId: DEVICE_ID,
  toolAllowlist: ['manage_alerts'],
};

const baseVerdict: AlertVerdictOutcome = {
  classification: 'transient_self_healed',
  confidence: 0.9,
  rationale: 'Disk usage returned to normal on its own; no action needed.',
};

beforeEach(() => {
  vi.clearAllMocks();
  resetDbState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('persistAlertVerdict', () => {
  it('supersedes the previous live row for the same alert BEFORE inserting the new one (client-generated id), and creates no intent without a suggestion', async () => {
    const result = await persistAlertVerdict(runInput, baseVerdict, agentAuth);

    expect(result).toEqual({
      verdictId: VERDICT_ROW_ID, intentId: null, suggestionDisposition: 'not_created', suggestionReason: undefined,
    });
    expect(createActionIntent).not.toHaveBeenCalled();

    // Carry-in C write ordering: the supersede UPDATE runs FIRST (call order
    // 0), pointing the prior live row at the id the INSERT (call order 1)
    // has not written yet.
    expect(state.updateCount).toBe(1);
    expect(state.insertCount).toBe(1);
    expect(state.insertValues[0]).toMatchObject({
      id: VERDICT_ROW_ID,
      orgId: ORG_ID,
      runId: RUN_ID,
      alertId: ALERT_ID,
      classification: 'transient_self_healed',
      confidence: '0.90',
      rationale: baseVerdict.rationale,
      suggestedIntentId: null,
    });

    // The supersede update sets superseded_by to the id the new row will
    // carry, and its WHERE pins org_id + requires the prior row to still be
    // live (superseded_by IS NULL) — not a vacuous where-clause. There is no
    // longer an id-exclusion clause: the new row doesn't exist yet when this
    // UPDATE runs, so nothing to exclude.
    expect(state.updateSets[0]).toEqual({ supersededBy: VERDICT_ROW_ID });
    const where = sqlText(state.updateWheres[0]);
    expect(where).toContain('org_id');
    expect(where).toContain('superseded_by');
    expect(where.toLowerCase()).toContain('is null');
  });

  // Also covers "bare `manage_alerts` in allowlist → created" (review round
  // 2, IMPORTANT 1a): `runInput.toolAllowlist` is the bare tool name.
  it('creates a Tier-2 supervised manage_alerts intent for a pending-approval suggestion, links it via a separate UPDATE after the verdict row is written, and uses the run\'s own deviceId without an extra query', async () => {
    createActionIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_approval' });
    // No `state.selectQueue` entries pushed: `suggestion.alertId ===
    // run.alertId` short-circuits BOTH the correlation-membership check and
    // the alerts.deviceId lookup (review round 1 minor fix) — an
    // unexpected select would throw "no queued select rows" and fail this
    // test, so the absence of a queued row IS the assertion.

    const verdict: AlertVerdictOutcome = {
      ...baseVerdict,
      classification: 'actionable',
      suggestedAction: { tool: 'manage_alerts', action: 'suppress', alertId: ALERT_ID, suppressDuration: 24 },
    };

    const result = await persistAlertVerdict(runInput, verdict, agentAuth);

    expect(createActionIntent).toHaveBeenCalledWith(agentAuth, {
      toolName: 'manage_alerts',
      input: {
        action: 'suppress', alertId: ALERT_ID, deviceId: DEVICE_ID, suppressDuration: 24,
        resolutionNote: verdict.rationale,
      },
      source: 'ai_agent',
      orgId: ORG_ID,
      reason: verdict.rationale,
      idempotencyKey: `verdict:${RUN_ID}`,
    });
    expect(result.intentId).toBe(INTENT_ID);
    expect(result.suggestionDisposition).toBe('intent_created');
    expect(result.suggestionReason).toBeUndefined();
    // Minor 4: the initial INSERT always writes `suggestedIntentId: null` —
    // it runs BEFORE createActionIntent is even attempted. The id is linked
    // back with a SECOND, separate UPDATE (updateSets[0] is the supersede
    // update; [1] is this link).
    expect(state.insertValues[0]).toMatchObject({ suggestedIntentId: null });
    expect(state.updateSets[1]).toEqual({ suggestedIntentId: INTENT_ID });
    expect(sqlText(state.updateWheres[1])).toContain('id');
  });

  // Review round 2 (IMPORTANT 1a): the specific `manage_alerts:<action>`
  // entry admits it too, not just the bare tool name.
  it('creates the intent when the allowlist carries the specific manage_alerts:suppress entry', async () => {
    createActionIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_approval' });

    const scopedRun = { ...runInput, toolAllowlist: ['manage_alerts:suppress'] };
    const verdict: AlertVerdictOutcome = {
      ...baseVerdict,
      classification: 'actionable',
      suggestedAction: { tool: 'manage_alerts', action: 'suppress', alertId: ALERT_ID, suppressDuration: 24 },
    };

    const result = await persistAlertVerdict(scopedRun, verdict, agentAuth);

    expect(createActionIntent).toHaveBeenCalledTimes(1);
    expect(result.intentId).toBe(INTENT_ID);
    expect(result.suggestionDisposition).toBe('intent_created');
  });

  // Review round 2 (IMPORTANT 1a): the creation-time authority gate — a
  // suggestion is refused before ever reaching `createActionIntent` when the
  // run's effective allowlist admits neither `manage_alerts` nor
  // `manage_alerts:<action>`, mirroring what the release-time re-check
  // (`agentReleaseAuthority.ts`) would deny anyway.
  it('refuses a suggestion when manage_alerts is not in the run\'s effective allowlist (not_allowlisted)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const unallowlistedRun = { ...runInput, toolAllowlist: ['query_devices'] };
    const verdict: AlertVerdictOutcome = {
      ...baseVerdict,
      classification: 'actionable',
      suggestedAction: { tool: 'manage_alerts', action: 'suppress', alertId: ALERT_ID, suppressDuration: 24 },
    };

    const result = await persistAlertVerdict(unallowlistedRun, verdict, agentAuth);

    expect(result.intentId).toBeNull();
    expect(result.suggestionDisposition).toBe('not_created');
    expect(result.suggestionReason).toBe('not_allowlisted');
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(state.insertValues[0]).toMatchObject({ suggestedIntentId: null });
    // No link update either — there was never an intent id to link.
    expect(state.updateSets).toHaveLength(1);
  });

  // Review round 2 (IMPORTANT 1b): the device-binding gate — a suggestion
  // targeting an alert on a DIFFERENT device than the run's own is refused,
  // even though it passed the group-membership check (`suggestionTargetsRun`)
  // and the allowlist gate. Uses the group path so the alerts.deviceId
  // lookup actually runs (the single-alert shortcut trivially matches).
  it('refuses a suggestion whose target alert is on a different device than the run (target_mismatch)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const OTHER_DEVICE_ID = '00000000-0000-4000-8000-0000000000ec';
    // First select: alertCorrelationMembers membership check (a member).
    // Second select: alerts.deviceId lookup — a DIFFERENT device.
    state.selectQueue.push([{ id: 'member-1' }]);
    state.selectQueue.push([{ deviceId: OTHER_DEVICE_ID }]);

    const groupRun = { ...runInput, alertId: null, correlationGroupId: GROUP_ID };
    const verdict: AlertVerdictOutcome = {
      ...baseVerdict,
      classification: 'duplicate_of_group',
      suggestedAction: { tool: 'manage_alerts', action: 'suppress', alertId: OTHER_ALERT_ID, suppressDuration: 24 },
    };

    const result = await persistAlertVerdict(groupRun, verdict, agentAuth);

    expect(result.intentId).toBeNull();
    expect(result.suggestionDisposition).toBe('not_created');
    expect(result.suggestionReason).toBe('target_mismatch');
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  // Review round 2 (IMPORTANT 1b): a device-less run can never satisfy the
  // device-binding gate, even when the suggestion targets the run's own
  // alert (the common single-alert-run shortcut path) — matching
  // `checkAgentGuardrails`'s own device-less-mutation deny at release time.
  it('refuses a suggestion when the run has no deviceId at all (target_mismatch)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const deviceLessRun = { ...runInput, deviceId: null };
    const verdict: AlertVerdictOutcome = {
      ...baseVerdict,
      classification: 'actionable',
      suggestedAction: { tool: 'manage_alerts', action: 'resolve', alertId: ALERT_ID },
    };

    const result = await persistAlertVerdict(deviceLessRun, verdict, agentAuth);

    expect(result.intentId).toBeNull();
    expect(result.suggestionDisposition).toBe('not_created');
    expect(result.suggestionReason).toBe('target_mismatch');
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  // CRITICAL fix (review round 1): createActionIntent does NOT throw on
  // no_eligible_approvers — it commits the intent then immediately cancels
  // it, returning that snapshot. Linking a cancelled intent's id would
  // advertise a dead intent and break the "intent_ids are pending-only"
  // invariant. Mocked with a resolved cancelled snapshot, NOT a rejection.
  it('does not link a cancelled (no_eligible_approvers) intent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createActionIntent.mockResolvedValue({ id: INTENT_ID, status: 'cancelled', errorCode: 'no_eligible_approvers' });

    const verdict: AlertVerdictOutcome = {
      ...baseVerdict,
      classification: 'actionable',
      suggestedAction: { tool: 'manage_alerts', action: 'resolve', alertId: ALERT_ID },
    };

    const result = await persistAlertVerdict(runInput, verdict, agentAuth);

    expect(result.intentId).toBeNull();
    expect(result.suggestionDisposition).toBe('not_created');
    expect(result.suggestionReason).toBe('no_eligible_approvers');
    expect(warnSpy).toHaveBeenCalled();
    expect(state.insertValues[0]).toMatchObject({ suggestedIntentId: null });
  });

  it('treats a genuine createActionIntent throw as intent_error (not a propagated exception)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createActionIntent.mockRejectedValue(new Error('org_resolution_failed'));

    const verdict: AlertVerdictOutcome = {
      ...baseVerdict,
      classification: 'actionable',
      suggestedAction: { tool: 'manage_alerts', action: 'resolve', alertId: ALERT_ID },
    };

    const result = await persistAlertVerdict(runInput, verdict, agentAuth);

    expect(result.intentId).toBeNull();
    expect(result.suggestionDisposition).toBe('not_created');
    expect(result.suggestionReason).toBe('intent_error');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('refuses a suggestion whose alertId is not the run alert / not a member of the run group (target_mismatch)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const verdict: AlertVerdictOutcome = {
      ...baseVerdict,
      classification: 'actionable',
      suggestedAction: { tool: 'manage_alerts', action: 'suppress', alertId: OTHER_ALERT_ID, suppressDuration: 24 },
    };

    // run has no correlationGroupId, so a mismatched alertId is refused
    // without ever touching alertCorrelationMembers.
    const result = await persistAlertVerdict(runInput, verdict, agentAuth);

    expect(result.intentId).toBeNull();
    expect(result.suggestionDisposition).toBe('not_created');
    expect(result.suggestionReason).toBe('target_mismatch');
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('refuses a low-confidence suggestion without creating an intent (low_confidence)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const verdict: AlertVerdictOutcome = {
      ...baseVerdict,
      confidence: 0.6,
      classification: 'actionable',
      suggestedAction: { tool: 'manage_alerts', action: 'suppress', alertId: ALERT_ID, suppressDuration: 24 },
    };

    const result = await persistAlertVerdict(runInput, verdict, agentAuth);

    expect(result.suggestionDisposition).toBe('not_created');
    expect(result.suggestionReason).toBe('low_confidence');
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('refuses (alert_not_found) a group-member suggestion targeting an alert no longer in the org', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // First select: suggestionTargetsRun's alertCorrelationMembers lookup —
    // the suggestion IS a member of the group. Second select: the
    // org-scoped alerts.deviceId lookup — comes back empty (deleted since).
    state.selectQueue.push([{ id: 'member-1' }]);
    state.selectQueue.push([]);

    const groupRun = { ...runInput, alertId: null, correlationGroupId: GROUP_ID };
    const verdict: AlertVerdictOutcome = {
      ...baseVerdict,
      classification: 'duplicate_of_group',
      suggestedAction: { tool: 'manage_alerts', action: 'suppress', alertId: OTHER_ALERT_ID, suppressDuration: 24 },
    };

    const result = await persistAlertVerdict(groupRun, verdict, agentAuth);

    expect(result.suggestionDisposition).toBe('not_created');
    expect(result.suggestionReason).toBe('alert_not_found');
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('supersedes by correlation group, not alert id, when the run targets a group', async () => {
    const groupRun = { ...runInput, alertId: null, correlationGroupId: GROUP_ID };

    const result = await persistAlertVerdict(groupRun, baseVerdict, agentAuth);

    expect(result.verdictId).toBe(VERDICT_ROW_ID);
    expect(state.insertValues[0]).toMatchObject({ alertId: null, correlationGroupId: GROUP_ID });
    const where = sqlText(state.updateWheres[0]);
    expect(where).toContain('correlation_group_id');
  });

  // Carry-in C — the live-verdict partial unique's concurrent-supersede
  // race. A second writer's INSERT commits between THIS transaction's
  // supersede UPDATE and its own INSERT, so this transaction's INSERT
  // 23505s against the winner's now-live row.
  it('treats a 23505 on the target\'s live-verdict unique as "superseded concurrently" — re-reads the winner, skips intent creation entirely', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const WINNER_VERDICT_ID = '00000000-0000-4000-8000-0000000000ed';
    state.insertThrow = {
      code: '23505',
      constraint_name: 'ai_alert_verdicts_live_alert_uq',
      message: 'duplicate key value violates unique constraint "ai_alert_verdicts_live_alert_uq"',
    };
    // The re-read after the 23505, looking up the now-live winner row.
    state.selectQueue.push([{ id: WINNER_VERDICT_ID }]);

    const verdict: AlertVerdictOutcome = {
      ...baseVerdict,
      classification: 'actionable',
      // A suggestion is present, and would otherwise be eligible (high
      // confidence, run's own alert, allowlisted, own device) — proving the
      // race is checked BEFORE any of that gating even matters, since
      // createActionIntent must never be reached on this path.
      suggestedAction: { tool: 'manage_alerts', action: 'resolve', alertId: ALERT_ID },
    };

    const result = await persistAlertVerdict(runInput, verdict, agentAuth);

    expect(result).toEqual({
      verdictId: WINNER_VERDICT_ID,
      intentId: null,
      suggestionDisposition: 'not_created',
      suggestionReason: 'superseded_concurrently',
    });
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    // The supersede UPDATE still ran (and, per the write ordering, ran
    // before the INSERT that then failed) — only the INSERT itself lost the
    // race.
    expect(state.updateCount).toBe(1);
  });

  // MINOR 3 (fix round 1) — the re-read after a 23505 must never fall back
  // to fabricating an id (`newId`, which never landed). A missing winner
  // row here means the "23505 on this constraint implies a live row exists"
  // invariant broke; an honest throw beats handing the caller a verdictId
  // that dereferences nothing.
  it('throws (does not fabricate a verdictId) when the post-23505 re-read finds no live row', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    state.insertThrow = {
      code: '23505',
      constraint_name: 'ai_alert_verdicts_live_alert_uq',
      message: 'duplicate key value violates unique constraint "ai_alert_verdicts_live_alert_uq"',
    };
    // The re-read after the 23505 finds NOTHING — the invariant broke.
    state.selectQueue.push([]);

    await expect(persistAlertVerdict(runInput, baseVerdict, agentAuth)).rejects.toThrow(
      'ai_alert_verdicts: unique violation but no live row found',
    );
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('does not mistake an UNRELATED 23505 for the concurrent-supersede race — propagates it', async () => {
    state.insertThrow = {
      code: '23505',
      constraint_name: 'some_other_table_unique_idx',
      message: 'duplicate key value violates unique constraint "some_other_table_unique_idx"',
    };

    await expect(persistAlertVerdict(runInput, baseVerdict, agentAuth)).rejects.toMatchObject({ code: '23505' });
  });
});

describe('projectAlertVerdict', () => {
  it('returns null for an undefined verdict', () => {
    expect(projectAlertVerdict(undefined)).toBeNull();
  });

  it('defaults suggestedAction.disposition to not_created / reason to null when no intentInfo is given', () => {
    const dto = projectAlertVerdict({
      classification: 'recurring_pattern',
      confidence: 0.8,
      rationale: 'r',
      pattern: { kind: 'daily', evidenceAlertIds: ['a'] },
      suggestedAction: { tool: 'manage_alerts', action: 'suppress', alertId: 'a', suppressDuration: 24 },
    });
    expect(dto).toEqual({
      classification: 'recurring_pattern',
      confidence: 0.8,
      rationale: 'r',
      patternKind: 'daily',
      evidenceAlertIds: ['a'],
      suggestedAction: { tool: 'manage_alerts', action: 'suppress', disposition: 'not_created', reason: null },
    });
    for (const k of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) expect(JSON.stringify(dto)).not.toContain(`"${k}"`);
    // alertId / suppressDuration are on the raw suggestedAction but must not
    // survive the projection either.
    expect(JSON.stringify(dto)).not.toContain('suppressDuration');
  });

  it('projects the given intentInfo disposition/reason', () => {
    const dto = projectAlertVerdict(
      {
        classification: 'actionable',
        confidence: 0.9,
        rationale: 'r',
        suggestedAction: { tool: 'manage_alerts', action: 'resolve', alertId: 'a' },
      },
      { disposition: 'intent_created' },
    );
    expect(dto?.suggestedAction).toEqual({
      tool: 'manage_alerts', action: 'resolve', disposition: 'intent_created', reason: null,
    });

    const dtoRefused = projectAlertVerdict(
      {
        classification: 'actionable',
        confidence: 0.9,
        rationale: 'r',
        suggestedAction: { tool: 'manage_alerts', action: 'resolve', alertId: 'a' },
      },
      { disposition: 'not_created', reason: 'no_eligible_approvers' },
    );
    expect(dtoRefused?.suggestedAction).toEqual({
      tool: 'manage_alerts', action: 'resolve', disposition: 'not_created', reason: 'no_eligible_approvers',
    });
  });

  it('projects null patternKind/evidenceAlertIds/suggestedAction when absent', () => {
    const dto = projectAlertVerdict({ classification: 'needs_human', confidence: 0.5, rationale: 'unclear' });
    expect(dto).toEqual({
      classification: 'needs_human',
      confidence: 0.5,
      rationale: 'unclear',
      patternKind: null,
      evidenceAlertIds: [],
      suggestedAction: null,
    });
  });
});

describe('latestVerdictsForAlerts', () => {
  it('maps rows by alertId, scoped to live (non-superseded) verdicts, ordered newest first', async () => {
    state.selectQueue.push([
      { id: VERDICT_ROW_ID, alertId: ALERT_ID, orgId: ORG_ID },
      { id: PRIOR_VERDICT_ID, alertId: OTHER_ALERT_ID, orgId: ORG_ID },
    ]);

    const map = await latestVerdictsForAlerts(ORG_ID, [ALERT_ID, OTHER_ALERT_ID]);

    expect(map.get(ALERT_ID)).toMatchObject({ id: VERDICT_ROW_ID });
    expect(map.get(OTHER_ALERT_ID)).toMatchObject({ id: PRIOR_VERDICT_ID });
    const where = sqlText(state.selectWheres[0]);
    expect(where.toLowerCase()).toContain('is null');
  });

  it('returns an empty map without querying when given no alert ids', async () => {
    const map = await latestVerdictsForAlerts(ORG_ID, []);
    expect(map.size).toBe(0);
    expect(state.selectCount).toBe(0);
  });

  // Task 14 — a partner/system `GET /alerts` list can span multiple orgs on
  // one page; `orgId` widens to an array via `inArray` rather than the route
  // issuing one query per org (see the source docstring for why that's the
  // smaller change).
  it('accepts an array of orgIds and compiles an inArray condition, not per-org eq', async () => {
    const OTHER_ORG_ID = '00000000-0000-4000-8000-0000000000ec';
    state.selectQueue.push([{ id: VERDICT_ROW_ID, alertId: ALERT_ID, orgId: OTHER_ORG_ID }]);

    const map = await latestVerdictsForAlerts([ORG_ID, OTHER_ORG_ID], [ALERT_ID]);

    expect(map.get(ALERT_ID)).toMatchObject({ id: VERDICT_ROW_ID });
    const { sql: compiled, params } = dialect.sqlToQuery(state.selectWheres[0] as SQL);
    expect(compiled.toLowerCase()).toContain('in');
    expect(params).toEqual(expect.arrayContaining([ORG_ID, OTHER_ORG_ID]));
  });

  // I3 fix (P2-1 wave B task 16d) — `persistAlertVerdict` writes a GROUP
  // verdict with `alert_id IS NULL` / `correlation_group_id` set. Ruling: a
  // group verdict applies to every member alert that doesn't already carry
  // its own alert-level verdict.
  describe('group-level verdicts apply to member alerts (I3 fix)', () => {
    it('an alert-level verdict WINS: no group-level query is issued when every id is already covered', async () => {
      state.selectQueue.push([
        { id: VERDICT_ROW_ID, alertId: ALERT_ID, orgId: ORG_ID },
        { id: PRIOR_VERDICT_ID, alertId: OTHER_ALERT_ID, orgId: ORG_ID },
      ]);

      const map = await latestVerdictsForAlerts(ORG_ID, [ALERT_ID, OTHER_ALERT_ID]);

      expect(map.get(ALERT_ID)).toMatchObject({ id: VERDICT_ROW_ID });
      expect(map.get(OTHER_ALERT_ID)).toMatchObject({ id: PRIOR_VERDICT_ID });
      expect(state.selectCount).toBe(1); // one query, not two — group-level never queried
    });

    it('applies the latest live GROUP-level verdict to a member alert with no alert-level verdict of its own', async () => {
      state.selectQueue.push([]); // alert-level query: nothing for ALERT_ID
      const groupVerdictRow = { id: PRIOR_VERDICT_ID, alertId: null, correlationGroupId: GROUP_ID, orgId: ORG_ID };
      state.selectQueue.push([{ alertId: ALERT_ID, verdict: groupVerdictRow }]);

      const map = await latestVerdictsForAlerts(ORG_ID, [ALERT_ID]);

      expect(map.get(ALERT_ID)).toEqual(groupVerdictRow);
      expect(state.selectCount).toBe(2); // one or two queries, never N
    });

    it('does not let a group-level verdict for one alert overwrite an alert-level verdict already found for another', async () => {
      state.selectQueue.push([{ id: VERDICT_ROW_ID, alertId: ALERT_ID, orgId: ORG_ID }]); // alert-level: only ALERT_ID
      const groupVerdictRow = { id: PRIOR_VERDICT_ID, alertId: null, correlationGroupId: GROUP_ID, orgId: ORG_ID };
      state.selectQueue.push([{ alertId: OTHER_ALERT_ID, verdict: groupVerdictRow }]); // group-level: only for the still-unmapped id

      const map = await latestVerdictsForAlerts(ORG_ID, [ALERT_ID, OTHER_ALERT_ID]);

      expect(map.get(ALERT_ID)).toMatchObject({ id: VERDICT_ROW_ID });
      expect(map.get(OTHER_ALERT_ID)).toEqual(groupVerdictRow);
    });

    // Task 16e fix: the group-level query previously pinned org scoping only
    // on `alert_correlation_members` (`memberOrgCondition`), never on the
    // joined `ai_alert_verdicts` row itself — unlike the alert-level query
    // above, which pins `orgCondition` directly on `aiAlertVerdicts`. A
    // string-substring assertion on 'org_id' alone would pass even with that
    // gap (the member-side condition already renders that column name), so
    // this compiles the WHERE clause and asserts the org id is an actual
    // bound PARAMETER, not just present in the SQL text.
    it('the group-level query is scoped to live (non-superseded) rows and is org-scoped', async () => {
      state.selectQueue.push([]); // alert-level: nothing
      state.selectQueue.push([]); // group-level: nothing

      await latestVerdictsForAlerts(ORG_ID, [ALERT_ID]);

      expect(state.selectCount).toBe(2);
      const groupWhereClause = state.selectWheres[1] as SQL;
      const groupWhereText = sqlText(groupWhereClause);
      expect(groupWhereText.toLowerCase()).toContain('is null');
      expect(groupWhereText.toLowerCase()).toContain('org_id');
      const { params } = dialect.sqlToQuery(groupWhereClause);
      expect(params).toContain(ORG_ID);
    });

    it('the group-level query also org-scopes on an array of orgIds, via inArray on both the member and verdict rows', async () => {
      const OTHER_ORG_ID = '00000000-0000-4000-8000-0000000000ec';
      state.selectQueue.push([]); // alert-level: nothing
      state.selectQueue.push([]); // group-level: nothing

      await latestVerdictsForAlerts([ORG_ID, OTHER_ORG_ID], [ALERT_ID]);

      const groupWhereClause = state.selectWheres[1] as SQL;
      const { params } = dialect.sqlToQuery(groupWhereClause);
      expect(params).toEqual(expect.arrayContaining([ORG_ID, OTHER_ORG_ID]));
    });
  });
});

describe('projectAlertAiVerdictSummary', () => {
  it('projects a live row: numeric confidence, null-safe patternKind/feedback, ISO createdAt', () => {
    const createdAt = new Date('2026-09-22T10:00:00.000Z');
    const dto = projectAlertAiVerdictSummary({
      id: VERDICT_ROW_ID,
      orgId: ORG_ID,
      runId: RUN_ID,
      alertId: ALERT_ID,
      correlationGroupId: null,
      classification: 'actionable',
      confidence: '0.87',
      rationale: 'Disk usage climbing steadily with no recovery.',
      pattern: { kind: 'daily', evidenceAlertIds: [ALERT_ID] },
      suggestedIntentId: INTENT_ID,
      feedback: 'up',
      feedbackBy: USER_ID,
      feedbackAt: createdAt,
      supersededBy: null,
      createdAt,
    } as unknown as Parameters<typeof projectAlertAiVerdictSummary>[0]);

    expect(dto).toEqual({
      id: VERDICT_ROW_ID,
      classification: 'actionable',
      confidence: 0.87,
      rationale: 'Disk usage climbing steadily with no recovery.',
      patternKind: 'daily',
      feedback: 'up',
      feedbackBy: USER_ID,
      suggestedIntentId: INTENT_ID,
      createdAt: '2026-09-22T10:00:00.000Z',
    });
    expect(typeof dto.confidence).toBe('number');
  });

  it('projects null patternKind/feedback/suggestedIntentId when absent', () => {
    const createdAt = new Date('2026-09-22T10:00:00.000Z');
    const dto = projectAlertAiVerdictSummary({
      id: VERDICT_ROW_ID,
      orgId: ORG_ID,
      runId: RUN_ID,
      alertId: ALERT_ID,
      correlationGroupId: null,
      classification: 'needs_human',
      confidence: '0.55',
      rationale: 'Ambiguous — needs a human look.',
      pattern: null,
      suggestedIntentId: null,
      feedback: null,
      feedbackBy: null,
      feedbackAt: null,
      supersededBy: null,
      createdAt,
    } as unknown as Parameters<typeof projectAlertAiVerdictSummary>[0]);

    expect(dto.patternKind).toBeNull();
    expect(dto.feedback).toBeNull();
    expect(dto.feedbackBy).toBeNull();
    expect(dto.suggestedIntentId).toBeNull();
  });
});

describe('latestVerdictForGroup', () => {
  it('returns the live verdict row for the group, or null', async () => {
    state.selectQueue.push([{ id: VERDICT_ROW_ID, correlationGroupId: GROUP_ID, orgId: ORG_ID }]);
    const row = await latestVerdictForGroup(ORG_ID, GROUP_ID);
    expect(row).toMatchObject({ id: VERDICT_ROW_ID });
  });

  it('returns null when no live verdict exists for the group', async () => {
    state.selectQueue.push([]);
    const row = await latestVerdictForGroup(ORG_ID, GROUP_ID);
    expect(row).toBeNull();
  });
});

describe('recordVerdictFeedback', () => {
  // Task 7 (#4192). The old atomic-CAS-UPDATE approach (`WHERE id = ... AND
  // (feedback_by IS NULL OR feedback_by = <this user>)`) is replaced by a
  // `SELECT ... FOR UPDATE` lock + plain UPDATE (Deviation 12): the lock
  // makes the same-row race impossible between the read and the write, so
  // the conflict check moves INSIDE the lock instead of living in the WHERE
  // clause — strictly stronger than the CAS, which still needed a
  // non-atomic follow-up SELECT to tell 'not_found' from 'conflict'.
  const verdictRow = (overrides: Record<string, unknown> = {}) => ({
    id: VERDICT_ROW_ID,
    orgId: ORG_ID,
    runId: RUN_ID,
    alertId: ALERT_ID,
    correlationGroupId: null,
    feedback: null,
    feedbackBy: null,
    createdAt: new Date('2026-08-15T00:00:00.000Z'),
    ...overrides,
  });

  it('an up-vote writes the update and one feedback_up evidence row keyed to the verdict\'s own createdAt', async () => {
    state.selectQueue.push([verdictRow()]);
    state.selectQueue.push([{ agentId: AGENT_ID }]);
    state.selectQueue.push([{ ruleId: RULE_ID }]);

    const result = await recordVerdictFeedback(agentAuth, VERDICT_ROW_ID, 'up');

    expect(result).toEqual({ status: 'ok', orgId: ORG_ID });
    // The locking SELECT actually used FOR UPDATE.
    expect(state.selectForUpdate[0]).toBe(true);
    expect(state.updateCount).toBe(1);
    expect(state.updateSets[0]).toMatchObject({ feedback: 'up', feedbackBy: USER_ID });
    expect(state.insertCount).toBe(1);
    expect(state.insertValues[0]).toMatchObject({
      orgId: ORG_ID,
      agentId: AGENT_ID,
      namespace: 'alert_verdict',
      opKey: AI_AGENT_ALERT_VERDICT_OP_KEY,
      ruleId: RULE_ID,
      sourceKind: 'verdict_feedback',
      sourceId: VERDICT_ROW_ID,
      metric: 'feedback_up',
      runId: RUN_ID,
      // The FIXED bucket — the verdict's own creation, not the vote's.
      occurredAt: new Date('2026-08-15T00:00:00.000Z'),
    });
  });

  it('the same user re-voting down UPDATEs the single feedback row\'s metric in place via ON CONFLICT DO UPDATE', async () => {
    // Same user (USER_ID) already voted — feedback_by is already theirs.
    state.selectQueue.push([verdictRow({ feedback: 'up', feedbackBy: USER_ID })]);
    state.selectQueue.push([{ agentId: AGENT_ID }]);
    state.selectQueue.push([{ ruleId: RULE_ID }]);

    const result = await recordVerdictFeedback(agentAuth, VERDICT_ROW_ID, 'down');

    expect(result).toEqual({ status: 'ok', orgId: ORG_ID });
    // Exactly one evidence write attempt, upserted (not a second insert) —
    // the ON CONFLICT ("source_id") ... DO UPDATE clause itself (the
    // mechanism that keeps this to exactly one row under a real unique
    // index) is asserted against the real dialect in
    // opEvidence.test.ts ('upsertVerdictFeedbackEvidenceQuery — compiled
    // SQL'), not re-derived from this file's opaque mocked clause object.
    expect(state.insertCount).toBe(1);
    expect(state.insertConflicts[0]).toMatchObject({ set: { metric: 'feedback_down' } });
    expect(state.insertValues[0]).toMatchObject({ sourceId: VERDICT_ROW_ID, metric: 'feedback_down' });
  });

  it('a different user gets conflict and writes nothing', async () => {
    state.selectQueue.push([verdictRow({ feedback: 'up', feedbackBy: OTHER_USER_ID })]);

    const result = await recordVerdictFeedback(agentAuth, VERDICT_ROW_ID, 'down');

    expect(result).toEqual({ status: 'conflict', orgId: ORG_ID });
    expect(state.selectCount).toBe(1);
    expect(state.updateCount).toBe(0);
    expect(state.insertCount).toBe(0);
  });

  it('a missing verdict gets not_found and writes nothing', async () => {
    state.selectQueue.push([]);

    const result = await recordVerdictFeedback(agentAuth, VERDICT_ROW_ID, 'up');

    expect(result).toEqual({ status: 'not_found' });
    expect(state.updateCount).toBe(0);
    expect(state.insertCount).toBe(0);
  });

  it('a group verdict resolves rule_id through the group\'s root_alert_id', async () => {
    state.selectQueue.push([verdictRow({ alertId: null, correlationGroupId: GROUP_ID })]);
    state.selectQueue.push([{ agentId: AGENT_ID }]);
    state.selectQueue.push([{ rootAlertId: ROOT_ALERT_ID }]);
    state.selectQueue.push([{ ruleId: RULE_ID }]);

    await recordVerdictFeedback(agentAuth, VERDICT_ROW_ID, 'up');

    expect(state.insertValues[0]).toMatchObject({ ruleId: RULE_ID });
  });

  it('a group with a null root_alert_id yields ruleId: null and skips the extra alert lookup', async () => {
    state.selectQueue.push([verdictRow({ alertId: null, correlationGroupId: GROUP_ID })]);
    state.selectQueue.push([{ agentId: AGENT_ID }]);
    state.selectQueue.push([{ rootAlertId: null }]);

    await recordVerdictFeedback(agentAuth, VERDICT_ROW_ID, 'up');

    expect(state.insertValues[0]).toMatchObject({ ruleId: null });
    // verdict lock + run + group — no fourth SELECT for an alert that isn't there.
    expect(state.selectCount).toBe(3);
  });
});
