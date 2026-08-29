// apps/api/src/services/aiAgents/alertVerdicts.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS, type AlertVerdictOutcome } from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000e1';
const RUN_ID = '00000000-0000-4000-8000-0000000000e2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000e3';
const ALERT_ID = '00000000-0000-4000-8000-0000000000e4';
const OTHER_ALERT_ID = '00000000-0000-4000-8000-0000000000e5';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000e6';
const VERDICT_ROW_ID = '00000000-0000-4000-8000-0000000000e7';
const PRIOR_VERDICT_ID = '00000000-0000-4000-8000-0000000000e8';
const INTENT_ID = '00000000-0000-4000-8000-0000000000e9';
const USER_ID = '00000000-0000-4000-8000-0000000000ea';
const GROUP_ID = '00000000-0000-4000-8000-0000000000eb';

const state = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  selectWheres: [] as unknown[],
  insertReturningQueue: [] as (unknown[] | undefined)[],
  insertValues: [] as Record<string, unknown>[],
  updateSets: [] as Record<string, unknown>[],
  updateWheres: [] as unknown[],
  updateReturningQueue: [] as (unknown[] | undefined)[],
  selectCount: 0,
  insertCount: 0,
  updateCount: 0,
  ambientContext: undefined as { scope: string } | undefined,
}));

function resetDbState(): void {
  state.selectQueue = [];
  state.selectWheres = [];
  state.insertReturningQueue = [];
  state.insertValues = [];
  state.updateSets = [];
  state.updateWheres = [];
  state.updateReturningQueue = [];
  state.selectCount = 0;
  state.insertCount = 0;
  state.updateCount = 0;
  state.ambientContext = undefined;
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

import {
  latestVerdictForGroup, latestVerdictsForAlerts, persistAlertVerdict, projectAlertVerdict,
  recordVerdictFeedback,
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

const runInput = {
  id: RUN_ID,
  orgId: ORG_ID,
  agentId: AGENT_ID,
  alertId: ALERT_ID,
  correlationGroupId: null,
  deviceId: DEVICE_ID,
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
  it('inserts a verdict row, supersedes the previous one for the same alert, and creates no intent without a suggestion', async () => {
    state.insertReturningQueue.push([{ id: VERDICT_ROW_ID }]);

    const result = await persistAlertVerdict(runInput, baseVerdict, agentAuth);

    expect(result).toEqual({ verdictId: VERDICT_ROW_ID, intentId: null });
    expect(createActionIntent).not.toHaveBeenCalled();

    expect(state.insertValues[0]).toMatchObject({
      orgId: ORG_ID,
      runId: RUN_ID,
      alertId: ALERT_ID,
      classification: 'transient_self_healed',
      confidence: '0.90',
      rationale: baseVerdict.rationale,
      suggestedIntentId: null,
    });

    // The supersede update sets superseded_by to the row just written, and
    // its WHERE excludes that same row while requiring the prior row to
    // still be live (superseded_by IS NULL) — not a vacuous where-clause.
    expect(state.updateSets[0]).toEqual({ supersededBy: VERDICT_ROW_ID });
    const where = sqlText(state.updateWheres[0]);
    expect(where).toContain('superseded_by');
    expect(where.toLowerCase()).toContain('is null');
    expect(where).toContain('<>');
  });

  it('creates a Tier-2 supervised manage_alerts intent for a suggestion and links it', async () => {
    createActionIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_approval' });
    state.selectQueue.push([{ deviceId: DEVICE_ID }]); // alerts.deviceId lookup
    state.insertReturningQueue.push([{ id: VERDICT_ROW_ID }]);

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
    expect(state.insertValues[0]).toMatchObject({ suggestedIntentId: INTENT_ID });
  });

  it('records intentError on the outcome (not a throw) when intent creation fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createActionIntent.mockRejectedValue(new Error('no_eligible_approvers'));
    state.selectQueue.push([{ deviceId: DEVICE_ID }]);
    state.insertReturningQueue.push([{ id: VERDICT_ROW_ID }]);

    const verdict: AlertVerdictOutcome = {
      ...baseVerdict,
      classification: 'actionable',
      suggestedAction: { tool: 'manage_alerts', action: 'resolve', alertId: ALERT_ID },
    };

    const result = await persistAlertVerdict(runInput, verdict, agentAuth);

    expect(result.intentId).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(state.insertValues[0]).toMatchObject({ suggestedIntentId: null });
  });

  it('refuses a suggestion whose alertId is not the run alert / not a member of the run group', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    state.insertReturningQueue.push([{ id: VERDICT_ROW_ID }]);

    const verdict: AlertVerdictOutcome = {
      ...baseVerdict,
      classification: 'actionable',
      suggestedAction: { tool: 'manage_alerts', action: 'suppress', alertId: OTHER_ALERT_ID, suppressDuration: 24 },
    };

    // run has no correlationGroupId, so a mismatched alertId is refused
    // without ever touching alertCorrelationMembers.
    const result = await persistAlertVerdict(runInput, verdict, agentAuth);

    expect(result.intentId).toBeNull();
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('supersedes by correlation group, not alert id, when the run targets a group', async () => {
    state.insertReturningQueue.push([{ id: VERDICT_ROW_ID }]);
    const groupRun = { ...runInput, alertId: null, correlationGroupId: GROUP_ID };

    const result = await persistAlertVerdict(groupRun, baseVerdict, agentAuth);

    expect(result.verdictId).toBe(VERDICT_ROW_ID);
    expect(state.insertValues[0]).toMatchObject({ alertId: null, correlationGroupId: GROUP_ID });
    const where = sqlText(state.updateWheres[0]);
    expect(where).toContain('correlation_group_id');
  });
});

describe('projectAlertVerdict', () => {
  it('returns null for an undefined verdict', () => {
    expect(projectAlertVerdict(undefined)).toBeNull();
  });

  it('never emits args/evidence beyond ids', () => {
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
      suggestedAction: { tool: 'manage_alerts', action: 'suppress' },
    });
    for (const k of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) expect(JSON.stringify(dto)).not.toContain(`"${k}"`);
    // alertId / suppressDuration are on the raw suggestedAction but must not
    // survive the projection either.
    expect(JSON.stringify(dto)).not.toContain('suppressDuration');
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
  it('maps rows by alertId, scoped to live (non-superseded) verdicts', async () => {
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
  it('updates feedback by id, relying on the caller\'s RLS context, and returns true when a row moved', async () => {
    state.updateReturningQueue.push([{ id: VERDICT_ROW_ID }]);

    const ok = await recordVerdictFeedback(agentAuth, VERDICT_ROW_ID, 'up');

    expect(ok).toBe(true);
    expect(state.updateSets[0]).toMatchObject({ feedback: 'up', feedbackBy: USER_ID });
    const where = sqlText(state.updateWheres[0]);
    expect(where).toContain('id');
    expect(where).not.toContain('org_id');
  });

  it('returns false when no row matched (not found or RLS-denied)', async () => {
    state.updateReturningQueue.push([]);
    const ok = await recordVerdictFeedback(agentAuth, VERDICT_ROW_ID, 'down');
    expect(ok).toBe(false);
  });
});
