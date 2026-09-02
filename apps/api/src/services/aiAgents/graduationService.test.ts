// apps/api/src/services/aiAgents/graduationService.test.ts
/**
 * P2-5 (#4192, Task A2-2) — the graduation window, the eligibility ladder and
 * the tracking/eligible/promoted/demoted state machine.
 *
 * `../../db` is mocked with the same capture-and-replay builder
 * `fixWatch.test.ts` uses, so every predicate that MATTERS is asserted as
 * COMPILED SQL through the real PgDialect (repo's vacuous-Drizzle-assertion
 * trap): a window whose lower bound silently lost its `GREATEST(..., demoted_at)`
 * would re-admit the very evidence a demotion exists to discard, and no
 * mocked-builder equality check would notice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  AI_AGENT_GRADUATION_MIN_AGE_DAYS,
  AI_AGENT_LIMIT_DEFAULTS,
  type AiAgentGraduationState,
} from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000e1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000e2';
/** The EFFECTIVE agent id — always the PARTNER baseline row (opEvidence.ts). */
const AGENT_ID = '00000000-0000-4000-8000-0000000000e3';
const ORG_AGENT_ID = '00000000-0000-4000-8000-0000000000e4';
const GRADUATION_ID = '00000000-0000-4000-8000-0000000000e5';
const OTHER_ORG_ID = '00000000-0000-4000-8000-0000000000e6';
/** A real POLICY_DECIDABLE_TIER3 member. */
const OP_KEY = 'manage_services:restart';
/** Registered nowhere — check 1 must reject it. */
const UNREGISTERED_OP_KEY = 'file_operations:delete';

const DAY_MS = 24 * 60 * 60 * 1000;

const state = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  selectWheres: [] as unknown[],
  selectJoinOns: [] as unknown[],
  selectFields: [] as unknown[],
  insertValues: [] as Record<string, unknown>[],
  insertConflicts: [] as ({ target?: unknown; set?: unknown } | undefined)[],
  executed: [] as unknown[],
  selectCount: 0,
  insertCount: 0,
  dbContext: { scope: 'system' } as { scope: string } | undefined,
}));

function resetDbState(): void {
  state.selectQueue = [];
  state.selectWheres = [];
  state.selectJoinOns = [];
  state.selectFields = [];
  state.insertValues = [];
  state.insertConflicts = [];
  state.executed = [];
  state.selectCount = 0;
  state.insertCount = 0;
  state.dbContext = { scope: 'system' };
}

vi.mock('../../db', () => {
  function selectBuilder(fields?: unknown) {
    state.selectCount += 1;
    state.selectFields.push(fields);
    const builder: Record<string, unknown> = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn((_table: unknown, on: unknown) => {
        state.selectJoinOns.push(on);
        return builder;
      }),
      where: vi.fn((w: unknown) => {
        state.selectWheres.push(w);
        return builder;
      }),
      groupBy: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
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
      onConflictDoUpdate: vi.fn((clause?: { target?: unknown; set?: unknown }) => {
        state.insertConflicts.push(clause);
        return builder;
      }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve, reject),
    };
    return builder;
  }

  return {
    db: {
      select: vi.fn((fields?: unknown) => selectBuilder(fields)),
      selectDistinct: vi.fn((fields?: unknown) => selectBuilder(fields)),
      insert: vi.fn(() => insertBuilder()),
      execute: vi.fn((statement: unknown) => {
        state.executed.push(statement);
        return Promise.resolve([]);
      }),
    },
    getCurrentDbAccessContext: vi.fn(() => state.dbContext),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

import { withSystemDbAccessContext } from '../../db';
import {
  countEligibleGraduations,
  evaluateEligibility,
  evaluateGraduation,
  listTrackedTuples,
  loadActOpReliability,
  loadGraduationRows,
  refreshGraduationRow,
  withGraduationLock,
} from './graduationService';

const dialect = new PgDialect();

function sqlText(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql;
}

function sqlParams(value: unknown): unknown[] {
  return dialect.sqlToQuery(value as SQL).params;
}

/** A full `ai_agents` row, only the fields `normalizeAgentPolicy` reads. */
function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    kind: 'triage',
    enabled: true,
    mode: 'act',
    model: null,
    toolAllowlist: [],
    protectedResources: {},
    limits: {},
    triggers: {},
    recipients: {},
    actAssets: { scriptIds: [], supervisedActionKeys: [OP_KEY] },
    instructions: null,
    cooldownSeconds: 900,
    disabledAt: null,
    ...overrides,
  };
}

function windowRow(overrides: Record<string, unknown> = {}) {
  return {
    executed: 0,
    verified: 0,
    failed: 0,
    recurred: 0,
    firstVerifiedAt: null,
    ...overrides,
  };
}

function graduationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: GRADUATION_ID,
    orgId: ORG_ID,
    agentId: AGENT_ID,
    opKey: OP_KEY,
    state: 'tracking' as AiAgentGraduationState,
    firstVerifiedAt: null,
    promotedAt: null,
    promotedIntentId: null,
    demotedAt: null,
    demoteReason: null,
    demoteRunId: null,
    demoteWatchId: null,
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** The `organizations` lookup that pins the baseline read to the org's partner. */
function orgLookupRows(partnerId: string | null = PARTNER_ID): unknown[] {
  return partnerId === null ? [] : [{ partnerId }];
}

/**
 * Queues the five sequential reads `evaluateGraduation` performs, in order:
 * graduation row, the organization's partner_id, PARTNER baseline agent row,
 * ORG override agent row, window.
 */
function queueEvaluation(opts: {
  graduation?: unknown[];
  orgLookup?: unknown[];
  partner?: unknown[];
  org?: unknown[];
  window?: unknown[];
}): void {
  state.selectQueue.push(opts.graduation ?? []);
  state.selectQueue.push(opts.orgLookup ?? orgLookupRows());
  state.selectQueue.push(opts.partner ?? [agentRow()]);
  state.selectQueue.push(opts.org ?? []);
  state.selectQueue.push(opts.window ?? [windowRow()]);
}

/** `verified` rows old enough and numerous enough for every check to pass. */
function eligibleWindow(now: Date, overrides: Record<string, unknown> = {}) {
  return windowRow({
    executed: AI_AGENT_LIMIT_DEFAULTS.promoteThreshold,
    verified: AI_AGENT_LIMIT_DEFAULTS.promoteThreshold,
    firstVerifiedAt: new Date(now.getTime() - AI_AGENT_GRADUATION_MIN_AGE_DAYS * DAY_MS),
    ...overrides,
  });
}

beforeEach(() => {
  resetDbState();
  vi.clearAllMocks();
});

describe('withGraduationLock', () => {
  it('serializes on pg_advisory_xact_lock(hashtext(namespace), hashtext(org:agent:opKey))', async () => {
    const result = await withGraduationLock(ORG_ID, AGENT_ID, OP_KEY, async () => 'ran');

    expect(result).toBe('ran');
    expect(state.executed).toHaveLength(1);
    expect(sqlText(state.executed[0]).replace(/\s+/g, ' ')).toContain(
      'pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    );
    expect(sqlParams(state.executed[0])).toEqual([
      'ai_agent_graduation',
      `${ORG_ID}:${AGENT_ID}:${OP_KEY}`,
    ]);
  });

  it('refuses to run outside a DB access context — an xact lock with no transaction is a no-op', async () => {
    state.dbContext = undefined;
    const fn = vi.fn();

    await expect(withGraduationLock(ORG_ID, AGENT_ID, OP_KEY, fn)).rejects.toThrow(/transaction/i);
    expect(fn).not.toHaveBeenCalled();
    expect(state.executed).toHaveLength(0);
  });

  it('takes the lock BEFORE running the body', async () => {
    const order: string[] = [];
    await withGraduationLock(ORG_ID, AGENT_ID, OP_KEY, async () => {
      order.push(`body:${state.executed.length}`);
    });
    expect(order).toEqual(['body:1']);
  });
});

describe('evaluateEligibility — the pure ladder', () => {
  const now = new Date('2026-09-01T12:00:00.000Z');
  const base = {
    opKey: OP_KEY,
    window: {
      executed: AI_AGENT_LIMIT_DEFAULTS.promoteThreshold,
      verified: AI_AGENT_LIMIT_DEFAULTS.promoteThreshold,
      failed: 0,
      recurred: 0,
      firstVerifiedAt: new Date(now.getTime() - AI_AGENT_GRADUATION_MIN_AGE_DAYS * DAY_MS).toISOString(),
    },
    partnerCeilingKeys: [OP_KEY],
    orgGrantedKeys: [] as string[],
    promoteThreshold: AI_AGENT_LIMIT_DEFAULTS.promoteThreshold,
    storedState: 'tracking' as AiAgentGraduationState | null,
    now,
  };

  it('reports eligible when every check holds', () => {
    expect(evaluateEligibility(base)).toEqual({ state: 'eligible', blockedReason: null });
  });

  it('reports not_policy_decidable FIRST, ahead of every later failing check', () => {
    // Both check 1 and check 4 fail; precedence must surface check 1.
    expect(
      evaluateEligibility({
        ...base,
        opKey: UNREGISTERED_OP_KEY,
        partnerCeilingKeys: [],
        window: { ...base.window, verified: 0, failed: 3 },
      }),
    ).toEqual({ state: 'tracking', blockedReason: 'not_policy_decidable' });
  });

  it('reports needs_partner_baseline ahead of has_failures and below_threshold', () => {
    expect(
      evaluateEligibility({
        ...base,
        partnerCeilingKeys: [],
        window: { ...base.window, verified: 0, failed: 1 },
      }),
    ).toEqual({ state: 'tracking', blockedReason: 'needs_partner_baseline' });
  });

  it('reports has_failures ahead of below_threshold, for failed AND for recurred', () => {
    expect(
      evaluateEligibility({ ...base, window: { ...base.window, verified: 0, failed: 1 } }),
    ).toEqual({ state: 'tracking', blockedReason: 'has_failures' });
    expect(
      evaluateEligibility({ ...base, window: { ...base.window, verified: 0, recurred: 1 } }),
    ).toEqual({ state: 'tracking', blockedReason: 'has_failures' });
  });

  it('treats verified === promoteThreshold as eligible and promoteThreshold - 1 as below_threshold', () => {
    const threshold = AI_AGENT_LIMIT_DEFAULTS.promoteThreshold;
    expect(evaluateEligibility({ ...base, window: { ...base.window, verified: threshold } }).blockedReason)
      .toBeNull();
    expect(evaluateEligibility({ ...base, window: { ...base.window, verified: threshold - 1 } }))
      .toEqual({ state: 'tracking', blockedReason: 'below_threshold' });
  });

  it('honours a partner-raised promoteThreshold over the default', () => {
    expect(
      evaluateEligibility({ ...base, promoteThreshold: 50, window: { ...base.window, verified: 49 } }),
    ).toEqual({ state: 'tracking', blockedReason: 'below_threshold' });
    expect(
      evaluateEligibility({ ...base, promoteThreshold: 50, window: { ...base.window, verified: 50 } }).state,
    ).toBe('eligible');
  });

  it('accepts a firstVerifiedAt exactly MIN_AGE_DAYS old and rejects 13d23h', () => {
    const exactly = new Date(now.getTime() - AI_AGENT_GRADUATION_MIN_AGE_DAYS * DAY_MS).toISOString();
    const oneHourShort = new Date(
      now.getTime() - AI_AGENT_GRADUATION_MIN_AGE_DAYS * DAY_MS + 60 * 60 * 1000,
    ).toISOString();

    expect(evaluateEligibility({ ...base, window: { ...base.window, firstVerifiedAt: exactly } }).state)
      .toBe('eligible');
    expect(evaluateEligibility({ ...base, window: { ...base.window, firstVerifiedAt: oneHourShort } }))
      .toEqual({ state: 'tracking', blockedReason: 'too_recent' });
  });

  it('reports promoted — not eligible — when the ORG row already holds the key', () => {
    expect(evaluateEligibility({ ...base, orgGrantedKeys: [OP_KEY] })).toEqual({
      state: 'promoted',
      blockedReason: null,
    });
  });

  it('keeps a GRANTED key promoted even once the window carries a failure — revoking is the demote path alone', () => {
    expect(
      evaluateEligibility({
        ...base,
        orgGrantedKeys: [OP_KEY],
        window: { ...base.window, failed: 1 },
      }),
    ).toEqual({ state: 'promoted', blockedReason: 'has_failures' });
  });

  it('keeps a demoted tuple demoted until a verified row lands after demoted_at', () => {
    const demoted = { ...base, storedState: 'demoted' as AiAgentGraduationState };
    expect(
      evaluateEligibility({ ...demoted, window: { ...base.window, verified: 0, firstVerifiedAt: null } }),
    ).toEqual({ state: 'demoted', blockedReason: 'below_threshold' });
    // The window's lower bound is already demoted_at, so ANY verified row here
    // is a post-demotion one — the tuple restarts as `tracking`.
    expect(
      evaluateEligibility({
        ...demoted,
        window: { ...base.window, verified: 1, firstVerifiedAt: new Date(now).toISOString() },
      }),
    ).toEqual({ state: 'tracking', blockedReason: 'below_threshold' });
  });
});

describe('evaluateGraduation', () => {
  it('bounds the window at GREATEST(now() - interval, demoted_at) and reads only policy_key rows', async () => {
    const demotedAt = new Date('2026-08-20T00:00:00.000Z');
    queueEvaluation({ graduation: [graduationRow({ state: 'demoted', demotedAt })] });

    await evaluateGraduation(ORG_ID, AGENT_ID, OP_KEY);

    const windowWhere = state.selectWheres[4];
    const text = sqlText(windowWhere).replace(/\s+/g, ' ');
    expect(text).toContain(`GREATEST(now() - interval '30 days',`);
    expect(text).toContain('"occurred_at" >');
    expect(text).toContain('"namespace" =');
    const params = sqlParams(windowWhere);
    expect(params).toContain('policy_key');
    expect(params).toContain(ORG_ID);
    expect(params).toContain(AGENT_ID);
    expect(params).toContain(OP_KEY);
    // ISO STRING, not the Date object: postgres.js throws ERR_INVALID_ARG_TYPE
    // ("Received an instance of Date") when an inline `sql` fragment binds a
    // Date against a placeholder the server describes as timestamptz. Verified
    // by executing this statement against a real Postgres.
    expect(params).toContain(demotedAt.toISOString());
    expect(params.some((p) => p instanceof Date)).toBe(false);
  });

  it('still emits the GREATEST bound when the tuple has never been demoted', async () => {
    queueEvaluation({ graduation: [graduationRow()] });

    await evaluateGraduation(ORG_ID, AGENT_ID, OP_KEY);

    const text = sqlText(state.selectWheres[4]).replace(/\s+/g, ' ');
    expect(text).toContain(`GREATEST(now() - interval '30 days',`);
    expect(sqlParams(state.selectWheres[4])).toContain(null);
  });

  it('pins the PARTNER baseline read to org_id IS NULL AND the org\u2019s partner_id, and the ORG read to the org', async () => {
    queueEvaluation({ org: [agentRow({ id: ORG_AGENT_ID, orgId: ORG_ID, partnerId: null })] });

    await evaluateGraduation(ORG_ID, AGENT_ID, OP_KEY);

    // 0 graduation, 1 organizations, 2 partner baseline, 3 org override, 4 window.
    const orgLookupText = sqlText(state.selectWheres[1]).replace(/\s+/g, ' ');
    expect(orgLookupText).toContain('"organizations"."id" =');
    expect(sqlParams(state.selectWheres[1])).toEqual([ORG_ID]);

    const partnerText = sqlText(state.selectWheres[2]).replace(/\s+/g, ' ');
    expect(partnerText).toContain('"org_id" is null');
    expect(partnerText).toContain('"partner_id" =');
    expect(partnerText).toContain('"disabled_at" is null');
    expect(sqlParams(state.selectWheres[2])).toEqual([AGENT_ID, PARTNER_ID]);

    const orgText = sqlText(state.selectWheres[3]).replace(/\s+/g, ' ');
    expect(orgText).toContain('"org_id" =');
    expect(orgText).toContain('"disabled_at" is null');
    expect(sqlParams(state.selectWheres[3])).toContain(ORG_ID);
  });

  it('reports needs_partner_baseline and never reads an org row when there is no partner baseline', async () => {
    state.selectQueue.push([]); // graduation
    state.selectQueue.push(orgLookupRows()); // organizations
    state.selectQueue.push([]); // partner baseline: none
    state.selectQueue.push([windowRow()]); // window

    const result = await evaluateGraduation(ORG_ID, AGENT_ID, OP_KEY);

    expect(result).toEqual({
      opKey: OP_KEY,
      state: 'tracking',
      blockedReason: 'needs_partner_baseline',
      window: { executed: 0, verified: 0, failed: 0, recurred: 0, firstVerifiedAt: null },
    });
    expect(state.selectCount).toBe(4);
  });

  it('uses the MAX-merged effective promoteThreshold, not the org row alone', async () => {
    const now = new Date();
    queueEvaluation({
      partner: [agentRow({ limits: { promoteThreshold: 50 } })],
      org: [agentRow({ id: ORG_AGENT_ID, orgId: ORG_ID, partnerId: null, limits: { promoteThreshold: 5 } })],
      window: [eligibleWindow(now, { executed: 30, verified: 30 })],
    });

    const result = await evaluateGraduation(ORG_ID, AGENT_ID, OP_KEY);

    // 30 clears the org's 5 but not the partner's 50 — max wins.
    expect(result.blockedReason).toBe('below_threshold');
  });

  it('reports promoted when the ORG row already holds the key', async () => {
    const now = new Date();
    queueEvaluation({
      org: [agentRow({
        id: ORG_AGENT_ID,
        orgId: ORG_ID,
        partnerId: null,
        actAssets: { scriptIds: [], supervisedActionKeys: [OP_KEY] },
      })],
      window: [eligibleWindow(now)],
    });

    const result = await evaluateGraduation(ORG_ID, AGENT_ID, OP_KEY);

    expect(result.state).toBe('promoted');
    expect(result.blockedReason).toBeNull();
    expect(result.window.verified).toBe(AI_AGENT_LIMIT_DEFAULTS.promoteThreshold);
  });

  it('is NOT promoted when the org row names a key the partner ceiling no longer holds', async () => {
    // C3: the grant is the EFFECTIVE set, intersect(partner, org) — never the
    // raw org column. A partner that narrows its baseline after a promotion
    // revokes the key, so the tuple must stop reading as `promoted`.
    const now = new Date();
    queueEvaluation({
      partner: [agentRow({ actAssets: { scriptIds: [], supervisedActionKeys: [] } })],
      org: [agentRow({
        id: ORG_AGENT_ID,
        orgId: ORG_ID,
        partnerId: null,
        actAssets: { scriptIds: [], supervisedActionKeys: [OP_KEY] },
      })],
      window: [eligibleWindow(now)],
    });

    const result = await evaluateGraduation(ORG_ID, AGENT_ID, OP_KEY);

    expect(result.state).toBe('tracking');
    expect(result.blockedReason).toBe('needs_partner_baseline');
  });

  it('reports needs_partner_baseline and reads no agent row at all when the organization is gone', async () => {
    state.selectQueue.push([]); // graduation
    state.selectQueue.push(orgLookupRows(null)); // organizations: none
    state.selectQueue.push([windowRow()]); // window

    const result = await evaluateGraduation(ORG_ID, AGENT_ID, OP_KEY);

    expect(result.blockedReason).toBe('needs_partner_baseline');
    expect(state.selectCount).toBe(3);
  });

  it('normalizes the window counters and firstVerifiedAt to the DTO shape', async () => {
    const firstVerifiedAt = new Date('2026-08-01T09:00:00.000Z');
    queueEvaluation({
      window: [windowRow({ executed: 4, verified: 3, failed: 1, recurred: 2, firstVerifiedAt })],
    });

    const result = await evaluateGraduation(ORG_ID, AGENT_ID, OP_KEY);

    expect(result.window).toEqual({
      executed: 4,
      verified: 3,
      failed: 1,
      recurred: 2,
      firstVerifiedAt: firstVerifiedAt.toISOString(),
    });
    expect(result.blockedReason).toBe('has_failures');
  });
});

describe('refreshGraduationRow', () => {
  it('takes the advisory lock before any read and upserts on the (org, agent, op_key) key', async () => {
    queueEvaluation({});

    await refreshGraduationRow(ORG_ID, AGENT_ID, OP_KEY);

    expect(state.executed).toHaveLength(1);
    expect(sqlText(state.executed[0])).toContain('pg_advisory_xact_lock');
    expect(state.insertCount).toBe(1);
    expect(state.insertValues[0]).toMatchObject({
      orgId: ORG_ID,
      agentId: AGENT_ID,
      opKey: OP_KEY,
      state: 'tracking',
      firstVerifiedAt: null,
    });
    expect(state.insertConflicts[0]?.target).toBeDefined();
  });

  it('persists eligible when the ladder clears, and reports the change', async () => {
    const now = new Date();
    queueEvaluation({ window: [eligibleWindow(now)] });

    const result = await refreshGraduationRow(ORG_ID, AGENT_ID, OP_KEY);

    expect(result.state).toBe('eligible');
    expect(result.changed).toBe(true);
    expect(state.insertValues[0]).toMatchObject({ state: 'eligible' });
  });

  it('walks eligible back to tracking when the window slides', async () => {
    queueEvaluation({
      graduation: [graduationRow({ state: 'eligible' })],
      window: [windowRow({ verified: 2 })],
    });

    const result = await refreshGraduationRow(ORG_ID, AGENT_ID, OP_KEY);

    expect(result.state).toBe('tracking');
    expect(result.blockedReason).toBe('below_threshold');
    expect(result.changed).toBe(true);
    expect(state.insertValues[0]).toMatchObject({ state: 'tracking' });
  });

  it('never writes promoted or demoted — those are the promote/demote paths alone', async () => {
    const now = new Date();
    queueEvaluation({
      graduation: [graduationRow({ state: 'promoted', promotedAt: new Date('2026-08-01T00:00:00.000Z') })],
      org: [agentRow({
        id: ORG_AGENT_ID,
        orgId: ORG_ID,
        partnerId: null,
        actAssets: { scriptIds: [], supervisedActionKeys: [OP_KEY] },
      })],
      window: [eligibleWindow(now)],
    });

    const result = await refreshGraduationRow(ORG_ID, AGENT_ID, OP_KEY);

    expect(result.state).toBe('promoted');
    expect(result.changed).toBe(false);
    expect(state.insertValues[0]).toMatchObject({ state: 'promoted' });
  });

  it('seeds a BRAND-NEW row as eligible, never promoted — a promotion needs Task 15 provenance', async () => {
    // No graduation row yet, but the org row already holds the key. Writing
    // `promoted` here would mint a row claiming a promotion with promoted_at
    // and promoted_intent_id NULL.
    const now = new Date();
    queueEvaluation({
      graduation: [],
      org: [agentRow({
        id: ORG_AGENT_ID,
        orgId: ORG_ID,
        partnerId: null,
        actAssets: { scriptIds: [], supervisedActionKeys: [OP_KEY] },
      })],
      window: [eligibleWindow(now)],
    });

    const result = await refreshGraduationRow(ORG_ID, AGENT_ID, OP_KEY);

    expect(result.state).toBe('promoted'); // derived for the caller: the grant exists
    expect(state.insertValues[0]).toMatchObject({ state: 'eligible' });
    expect(state.insertValues[0]).not.toHaveProperty('promotedAt');
    expect(state.insertValues[0]).not.toHaveProperty('promotedIntentId');
    expect((state.insertConflicts[0]?.set as Record<string, unknown>).state).toBe('eligible');
  });

  it('seeds a BRAND-NEW blocked row as tracking when the org row holds the key', async () => {
    queueEvaluation({
      graduation: [],
      org: [agentRow({
        id: ORG_AGENT_ID,
        orgId: ORG_ID,
        partnerId: null,
        actAssets: { scriptIds: [], supervisedActionKeys: [OP_KEY] },
      })],
      window: [windowRow({ verified: 1 })],
    });

    const result = await refreshGraduationRow(ORG_ID, AGENT_ID, OP_KEY);

    expect(result.state).toBe('promoted');
    expect(result.blockedReason).toBe('below_threshold');
    expect(state.insertValues[0]).toMatchObject({ state: 'tracking' });
  });

  it('walks a stored promoted row back to tracking once the partner ceiling drops the key', async () => {
    // Not a demotion (no demoted_at / demote_reason written) — the effective
    // grant simply no longer exists, so the persisted state must stop claiming
    // one. Task 16 remains the only writer of `demoted`.
    const now = new Date();
    queueEvaluation({
      graduation: [graduationRow({ state: 'promoted', promotedAt: new Date('2026-08-01T00:00:00.000Z') })],
      partner: [agentRow({ actAssets: { scriptIds: [], supervisedActionKeys: [] } })],
      org: [agentRow({
        id: ORG_AGENT_ID,
        orgId: ORG_ID,
        partnerId: null,
        actAssets: { scriptIds: [], supervisedActionKeys: [OP_KEY] },
      })],
      window: [eligibleWindow(now)],
    });

    const result = await refreshGraduationRow(ORG_ID, AGENT_ID, OP_KEY);

    expect(result.state).toBe('tracking');
    expect(result.blockedReason).toBe('needs_partner_baseline');
    expect(result.changed).toBe(true);
    expect(state.insertValues[0]).toMatchObject({ state: 'tracking' });
    expect(state.insertValues[0]).not.toHaveProperty('demotedAt');
    expect(state.insertValues[0]).not.toHaveProperty('demoteReason');
  });

  it('ignores evidence at or before demoted_at and resets first_verified_at on the first later verified', async () => {
    const demotedAt = new Date('2026-08-20T00:00:00.000Z');
    const firstAfter = new Date('2026-08-21T10:00:00.000Z');
    queueEvaluation({
      graduation: [graduationRow({
        state: 'demoted',
        demotedAt,
        firstVerifiedAt: new Date('2026-07-01T00:00:00.000Z'),
        demoteReason: 'attempted_failure',
      })],
      window: [windowRow({ executed: 1, verified: 1, firstVerifiedAt: firstAfter })],
    });

    const result = await refreshGraduationRow(ORG_ID, AGENT_ID, OP_KEY);

    // The pre-demotion `failed` row is outside the bound, so the tuple restarts.
    expect(result.state).toBe('tracking');
    expect(result.window).toMatchObject({ verified: 1, failed: 0, firstVerifiedAt: firstAfter.toISOString() });
    expect(state.insertValues[0]).toMatchObject({ state: 'tracking', firstVerifiedAt: firstAfter });
    expect(sqlParams(state.selectWheres[4])).toContain(demotedAt.toISOString());
  });

  it('leaves a demoted row demoted while no post-demotion verified row exists', async () => {
    queueEvaluation({
      graduation: [graduationRow({ state: 'demoted', demotedAt: new Date('2026-08-20T00:00:00.000Z') })],
      window: [windowRow()],
    });

    const result = await refreshGraduationRow(ORG_ID, AGENT_ID, OP_KEY);

    expect(result.state).toBe('demoted');
    expect(result.changed).toBe(false);
    expect(state.insertValues[0]).toMatchObject({ state: 'demoted' });
  });
});

describe('listTrackedTuples', () => {
  it('returns the distinct policy_key tuples with evidence inside the trailing window', async () => {
    state.selectQueue.push([
      { orgId: ORG_ID, agentId: AGENT_ID, opKey: OP_KEY },
      { orgId: ORG_ID, agentId: AGENT_ID, opKey: 'manage_services:stop' },
    ]);

    const tuples = await listTrackedTuples();

    expect(tuples).toEqual([
      { orgId: ORG_ID, agentId: AGENT_ID, opKey: OP_KEY },
      { orgId: ORG_ID, agentId: AGENT_ID, opKey: 'manage_services:stop' },
    ]);
    const text = sqlText(state.selectWheres[0]).replace(/\s+/g, ' ');
    expect(text).toContain(`now() - interval '30 days'`);
    expect(sqlParams(state.selectWheres[0])).toContain('policy_key');
  });
});

describe('loadGraduationRows', () => {
  it('derives state and blockedReason live and carries the persisted demote/promote facts', async () => {
    const now = new Date();
    const promotedAt = new Date('2026-08-10T00:00:00.000Z');
    state.selectQueue.push(orgLookupRows()); // organizations
    state.selectQueue.push([
      agentRow({ actAssets: { scriptIds: [], supervisedActionKeys: [OP_KEY, 'manage_services:stop'] } }),
    ]); // partner baseline
    state.selectQueue.push([]); // no org row
    state.selectQueue.push([
      {
        opKey: OP_KEY,
        state: 'eligible',
        promotedAt,
        demotedAt: null,
        demoteReason: null,
        ...eligibleWindow(now),
      },
      {
        opKey: 'manage_services:stop',
        state: 'demoted',
        promotedAt: null,
        demotedAt: new Date('2026-08-25T00:00:00.000Z'),
        demoteReason: 'recurrence',
        ...windowRow(),
      },
    ]);

    const rows = await loadGraduationRows(ORG_ID, AGENT_ID);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      opKey: OP_KEY,
      namespace: 'policy_key',
      state: 'eligible',
      blockedReason: null,
      promotedAt: promotedAt.toISOString(),
      demotedAt: null,
    });
    expect(rows[1]).toMatchObject({
      opKey: 'manage_services:stop',
      state: 'demoted',
      blockedReason: 'below_threshold',
      demoteReason: 'recurrence',
    });
  });

  it('bounds each row window at GREATEST(now() - interval, that row demoted_at)', async () => {
    state.selectQueue.push(orgLookupRows());
    state.selectQueue.push([agentRow()]);
    state.selectQueue.push([]);
    state.selectQueue.push([]);

    await loadGraduationRows(ORG_ID, AGENT_ID);

    const joinOn = sqlText(state.selectJoinOns[0]).replace(/\s+/g, ' ');
    expect(joinOn).toContain(`GREATEST(now() - interval '30 days', "ai_agent_graduation"."demoted_at")`);
    expect(joinOn).toContain('"namespace" =');
    expect(sqlParams(state.selectJoinOns[0])).toContain('policy_key');

    const where = sqlText(state.selectWheres[3]).replace(/\s+/g, ' ');
    expect(where).toContain('"org_id" =');
    expect(where).toContain('"agent_id" =');
  });
});

describe('loadActOpReliability', () => {
  it('aggregates the act_op namespace per op key over the trailing window', async () => {
    state.selectQueue.push([
      { opKey: 'restart_service', executed: 5, verified: 4, failed: 1, recurred: 0 },
    ]);

    const rows = await loadActOpReliability(ORG_ID, AGENT_ID);

    expect(rows).toEqual([{ opKey: 'restart_service', executed: 5, verified: 4, failed: 1, recurred: 0 }]);
    const text = sqlText(state.selectWheres[0]).replace(/\s+/g, ' ');
    expect(text).toContain(`now() - interval '30 days'`);
    const params = sqlParams(state.selectWheres[0]);
    expect(params).toContain('act_op');
    expect(params).toContain(ORG_ID);
    expect(params).toContain(AGENT_ID);
  });
});

describe('countEligibleGraduations', () => {
  const orgCondition = (col: PgColumn): SQL | undefined => inArray(col, [ORG_ID, OTHER_ORG_ID]);

  it('counts only state = eligible, predicated on the caller org set', async () => {
    state.selectQueue.push([{ count: 3 }]);

    const total = await countEligibleGraduations(orgCondition);

    expect(total).toBe(3);
    const where = sqlText(state.selectWheres[0]);
    expect(where).toContain('"state" = ');
    expect(sqlParams(state.selectWheres[0])).toContain('eligible');
    // The org predicate is present and targets ai_agent_graduation.org_id,
    // not some other table's — compiled SQL, never mock-call identity.
    expect(where).toContain('"ai_agent_graduation"."org_id" in ');
    expect(sqlParams(state.selectWheres[0])).toEqual(
      expect.arrayContaining([ORG_ID, OTHER_ORG_ID, 'eligible']),
    );
    // Never the other three states.
    for (const s of ['tracking', 'promoted', 'demoted']) {
      expect(sqlParams(state.selectWheres[0])).not.toContain(s);
    }
  });

  it('adds an explicit org equality when orgId is given, even for a system caller whose orgCondition is undefined', async () => {
    state.selectQueue.push([{ count: 1 }]);

    await countEligibleGraduations(() => undefined, ORG_ID);

    const where = sqlText(state.selectWheres[0]);
    expect(where).toContain('"ai_agent_graduation"."org_id" = ');
    expect(sqlParams(state.selectWheres[0])).toEqual(expect.arrayContaining([ORG_ID, 'eligible']));
  });

  it('returns 0 for an empty result set', async () => {
    state.selectQueue.push([]);
    await expect(countEligibleGraduations(orgCondition)).resolves.toBe(0);
  });

  it('does NOT elevate to a system context — the caller RLS context is the gate', async () => {
    // Every other function in this module joins-or-opens a system context;
    // this one must not, or an org caller's RLS scoping is discarded.
    state.dbContext = { scope: 'organization' };
    state.selectQueue.push([{ count: 2 }]);

    await countEligibleGraduations(orgCondition);

    expect(vi.mocked(withSystemDbAccessContext)).not.toHaveBeenCalled();
  });
});
