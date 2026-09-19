// apps/api/src/services/aiAgents/supervisedKeyGrant.test.ts
/**
 * P2-5 (#4192, Task A2-5) — the promote executor.
 *
 * `../../db` is mocked with the same capture-and-replay builder
 * `graduationService.test.ts` uses, so every predicate that MATTERS is
 * asserted as COMPILED SQL through the real PgDialect (repo's
 * vacuous-Drizzle-assertion trap). `withGraduationLock` and
 * `withAgentRowLocked` are the REAL implementations: the advisory lock
 * statement and the three `FOR UPDATE` reads are the serialization contract
 * this suite exists to pin, and a mocked lock would assert nothing.
 * `evaluateGraduation` IS mocked — its own ladder has full coverage in
 * graduationService.test.ts, and driving it from here would only re-test
 * that module through six queued row sets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { AiAgentGraduationBlockedReason, AiAgentGraduationState } from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG_ID = '00000000-0000-4000-8000-0000000000a2';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000a3';
/** The EFFECTIVE agent id — always the PARTNER baseline row. */
const AGENT_ID = '00000000-0000-4000-8000-0000000000a4';
const ORG_AGENT_ID = '00000000-0000-4000-8000-0000000000a5';
const INTENT_ID = '00000000-0000-4000-8000-0000000000a6';
const RUN_ID = '00000000-0000-4000-8000-0000000000a7';
const ACTOR_ID = '00000000-0000-4000-8000-0000000000a8';
const OP_KEY = 'manage_services:restart';
const SCRIPT_ID = '00000000-0000-4000-8000-0000000000a9';

interface SelectRecord {
  fields: unknown;
  where: unknown;
  locked: boolean;
}

const state = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  selects: [] as SelectRecord[],
  inserts: [] as { values?: Record<string, unknown>; conflict?: unknown; kind?: string }[],
  updates: [] as { set?: Record<string, unknown>; where?: unknown }[],
  executed: [] as unknown[],
  audits: [] as Record<string, unknown>[],
  policyDecideEnabled: true,
}));

function resetState(): void {
  state.selectQueue = [];
  state.selects = [];
  state.inserts = [];
  state.updates = [];
  state.executed = [];
  state.audits = [];
  state.policyDecideEnabled = true;
}

vi.mock('../../db', () => {
  function selectBuilder(fields?: unknown) {
    const record: SelectRecord = { fields, where: undefined, locked: false };
    state.selects.push(record);
    const builder: Record<string, unknown> = {
      from: vi.fn(() => builder),
      where: vi.fn((w: unknown) => {
        record.where = w;
        return builder;
      }),
      limit: vi.fn(() => builder),
      for: vi.fn(() => {
        record.locked = true;
        return builder;
      }),
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
    const record: { values?: Record<string, unknown>; conflict?: unknown; kind?: string } = {};
    state.inserts.push(record);
    const builder: Record<string, unknown> = {
      values: vi.fn((v: Record<string, unknown>) => {
        record.values = v;
        return builder;
      }),
      onConflictDoNothing: vi.fn((clause?: unknown) => {
        record.conflict = clause;
        record.kind = 'do_nothing';
        return builder;
      }),
      onConflictDoUpdate: vi.fn((clause?: unknown) => {
        record.conflict = clause;
        record.kind = 'do_update';
        return builder;
      }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve, reject),
    };
    return builder;
  }

  function updateBuilder() {
    const record: { set?: Record<string, unknown>; where?: unknown } = {};
    state.updates.push(record);
    const builder: Record<string, unknown> = {
      set: vi.fn((v: Record<string, unknown>) => {
        record.set = v;
        return builder;
      }),
      where: vi.fn((w: unknown) => {
        record.where = w;
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
      insert: vi.fn(() => insertBuilder()),
      update: vi.fn(() => updateBuilder()),
      execute: vi.fn((statement: unknown) => {
        state.executed.push(statement);
        return Promise.resolve([]);
      }),
    },
    getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' })),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

// Partial: `agentService` (real, for `withAgentRowLocked`) reaches `aiTools.ts`
// via `actionIntents/policyDecidable`, and that graph reads a dozen other
// exports off this module at import time.
vi.mock('../../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env')>();
  return { ...actual, policyDecideEnabled: vi.fn(() => state.policyDecideEnabled) };
});

vi.mock('../auditService', () => ({
  createAuditLog: vi.fn(async (params: Record<string, unknown>) => {
    state.audits.push(params);
  }),
}));

const evaluateGraduationMock = vi.hoisted(() => vi.fn());

vi.mock('./graduationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./graduationService')>();
  return { ...actual, evaluateGraduation: evaluateGraduationMock };
});

import { authorizeSupervisedKey, SupervisedKeyGrantError } from './supervisedKeyGrant';

const dialect = new PgDialect();

function sqlText(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql.replace(/\s+/g, ' ');
}

function sqlParams(value: unknown): unknown[] {
  return dialect.sqlToQuery(value as SQL).params;
}

/** A `ai_agents` row shaped for `normalizeAgentPolicy`. Deliberately NON-UNIFORM. */
function partnerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    kind: 'triage',
    name: 'Partner Triage',
    enabled: true,
    mode: 'act',
    model: 'claude-sonnet-4-5-20250929',
    toolAllowlist: ['manage_services', 'manage_alerts'],
    protectedResources: { services: ['sshd'], paths: [], registryKeys: [], deviceTags: [] },
    limits: { maxDevicesPerRun: 7, promoteThreshold: 25 },
    triggers: { alertSeverities: ['critical'], anomalyEnabled: true },
    recipients: { userIds: [ACTOR_ID], roleIds: [] },
    actAssets: { scriptIds: [], supervisedActionKeys: [OP_KEY] },
    instructions: 'partner guidance text',
    cooldownSeconds: 1200,
    disabledAt: null,
    ...overrides,
  };
}

function orgRow(overrides: Record<string, unknown> = {}) {
  return {
    ...partnerRow(),
    id: ORG_AGENT_ID,
    orgId: ORG_ID,
    partnerId: null,
    name: 'Org Triage',
    instructions: null,
    actAssets: { scriptIds: [], supervisedActionKeys: [] },
    ...overrides,
  };
}

function evaluation(overrides: {
  state?: AiAgentGraduationState;
  blockedReason?: AiAgentGraduationBlockedReason | null;
} = {}) {
  return {
    opKey: OP_KEY,
    state: 'eligible' as AiAgentGraduationState,
    window: { executed: 30, verified: 30, failed: 0, recurred: 0, firstVerifiedAt: '2026-08-01T00:00:00.000Z' },
    blockedReason: null as AiAgentGraduationBlockedReason | null,
    ...overrides,
  };
}

const intentRow = (overrides: Record<string, unknown> = {}) => ({
  id: INTENT_ID,
  orgId: ORG_ID,
  requestingAgentRunId: null,
  ...overrides,
});

/**
 * Queues the reads the executor performs, in order:
 *   1 intent · 2 organization->partner · 3 partner baseline id
 *   [lock] 4 partner FOR UPDATE · 5 org FOR UPDATE
 *   (clone) 6 org FOR UPDATE re-read · 7 withAgentRowLocked FOR UPDATE
 */
function queueGrant(opts: {
  intent?: unknown[];
  org?: unknown[];
  baselineId?: unknown[];
  partnerLocked?: unknown[];
  orgLocked?: unknown[];
  orgAfterClone?: unknown[];
  agentLocked?: unknown[];
} = {}): void {
  state.selectQueue.push(opts.intent ?? [intentRow()]);
  state.selectQueue.push(opts.org ?? [{ partnerId: PARTNER_ID }]);
  state.selectQueue.push(opts.baselineId ?? [{ id: AGENT_ID }]);
  state.selectQueue.push(opts.partnerLocked ?? [partnerRow()]);
  state.selectQueue.push(opts.orgLocked ?? []);
  if (opts.orgAfterClone !== undefined) state.selectQueue.push(opts.orgAfterClone);
  if (opts.agentLocked !== undefined) state.selectQueue.push(opts.agentLocked);
}

const grant = () => authorizeSupervisedKey({
  orgId: ORG_ID,
  kind: 'triage',
  opKey: OP_KEY,
  intentId: INTENT_ID,
  actorUserId: ACTOR_ID,
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(SupervisedKeyGrantError);
  await promise.catch((err: SupervisedKeyGrantError) => expect(err.code).toBe(code));
}

/** Nothing was granted: no agent INSERT, no actAssets UPDATE, no graduation row. */
function expectNoWrite(): void {
  expect(state.inserts).toHaveLength(0);
  expect(state.updates).toHaveLength(0);
}

beforeEach(() => {
  resetState();
  vi.clearAllMocks();
  evaluateGraduationMock.mockResolvedValue(evaluation());
});

describe('authorizeSupervisedKey — fail-closed gates', () => {
  it('refuses when BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED was flipped off during the approval', async () => {
    state.policyDecideEnabled = false;

    await expectCode(grant(), 'policy_decide_disabled');
    expect(state.selects).toHaveLength(0);
    expectNoWrite();
  });

  it('refuses an intent that names a different org than the one being granted', async () => {
    queueGrant({ intent: [intentRow({ orgId: OTHER_ORG_ID })] });

    await expectCode(grant(), 'org_mismatch');
    expectNoWrite();
  });

  it('refuses when the authorizing intent cannot be found', async () => {
    queueGrant({ intent: [] });

    await expectCode(grant(), 'no_authorizing_intent');
    expectNoWrite();
  });

  it('refuses an agent-originated intent (requesting_agent_run_id set)', async () => {
    queueGrant({ intent: [intentRow({ requestingAgentRunId: RUN_ID })] });

    await expectCode(grant(), 'non_human_origin');
    expectNoWrite();
  });

  it('refuses when there is no partner baseline agent of this kind', async () => {
    queueGrant({ baselineId: [] });

    await expectCode(grant(), 'agent_not_found');
    expectNoWrite();
  });

  it('re-evaluates at RELEASE time: a key that lost eligibility is refused', async () => {
    queueGrant();
    evaluateGraduationMock.mockResolvedValue(
      evaluation({ state: 'tracking', blockedReason: 'has_failures' }),
    );

    await expectCode(grant(), 'not_eligible');
    expectNoWrite();
  });

  it('refuses when the partner ceiling no longer names the key', async () => {
    queueGrant();
    evaluateGraduationMock.mockResolvedValue(
      evaluation({ state: 'tracking', blockedReason: 'needs_partner_baseline' }),
    );

    await expectCode(grant(), 'needs_partner_baseline');
    expectNoWrite();
  });

  it('refuses when the key is already granted (never rewrites the original provenance)', async () => {
    queueGrant();
    evaluateGraduationMock.mockResolvedValue(evaluation({ state: 'promoted' }));

    await expectCode(grant(), 'already_granted');
    expectNoWrite();
  });

  it('refuses when the org row already carries the key even if the ladder says eligible', async () => {
    queueGrant({
      orgLocked: [orgRow({ actAssets: { scriptIds: [], supervisedActionKeys: [OP_KEY] } })],
      agentLocked: [orgRow({ actAssets: { scriptIds: [], supervisedActionKeys: [OP_KEY] } })],
    });

    await expectCode(grant(), 'already_granted');
    // The clone branch never ran, and the key was not appended twice.
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });
});

describe('authorizeSupervisedKey — serialization', () => {
  it('takes the per-tuple advisory xact lock before reading the agent rows', async () => {
    queueGrant({
      orgLocked: [orgRow()],
      agentLocked: [orgRow()],
    });

    await grant();

    expect(state.executed).toHaveLength(1);
    expect(sqlText(state.executed[0])).toContain('pg_advisory_xact_lock');
    expect(sqlParams(state.executed[0])).toEqual([
      'ai_agent_graduation',
      `${ORG_ID}:${AGENT_ID}:${OP_KEY}`,
    ]);
  });

  it('locks the PARTNER baseline row first and the ORG row second', async () => {
    queueGrant({
      orgLocked: [orgRow()],
      agentLocked: [orgRow()],
    });

    await grant();

    const locked = state.selects.filter((s) => s.locked);
    // partner baseline, org row, then withAgentRowLocked's own re-lock.
    expect(locked).toHaveLength(3);
    expect(sqlText(locked[0]!.where)).toContain('"partner_id"');
    expect(sqlParams(locked[0]!.where)).toContain(PARTNER_ID);
    expect(sqlText(locked[1]!.where)).toContain('"org_id"');
    expect(sqlParams(locked[1]!.where)).toContain(ORG_ID);
  });

  it('pins every read to the org axis explicitly (system context: RLS passes unconditionally)', async () => {
    queueGrant({ orgLocked: [orgRow()], agentLocked: [orgRow()] });

    await grant();

    // The org->partner lookup, the org row lock and the graduation write all
    // name org_id; the partner baseline is pinned through the org's partner.
    expect(sqlParams(state.selects[1]!.where)).toContain(ORG_ID);
    expect(sqlParams(state.selects[2]!.where)).toContain(PARTNER_ID);
  });
});

describe('authorizeSupervisedKey — clone from the EFFECTIVE policy', () => {
  it('inserts an org row carrying the effective policy when none exists, then appends the key', async () => {
    queueGrant({
      orgLocked: [],
      orgAfterClone: [orgRow()],
      agentLocked: [orgRow()],
    });

    const result = await grant();

    const clone = state.inserts[0]!;
    expect(clone.kind).toBe('do_nothing');
    expect(clone.values).toMatchObject({
      orgId: ORG_ID,
      partnerId: null,
      kind: 'triage',
      // A row built from schema defaults would be mode 'off', enabled false and
      // an EMPTY allowlist — i.e. it would silently disable the org's agent.
      enabled: true,
      mode: 'act',
      model: 'claude-sonnet-4-5-20250929',
      toolAllowlist: ['manage_services', 'manage_alerts'],
      cooldownSeconds: 1200,
      createdBy: ACTOR_ID,
    });
    expect((clone.values as Record<string, unknown>).limits).toMatchObject({
      maxDevicesPerRun: 7,
      promoteThreshold: 25,
    });
    expect((clone.values as Record<string, unknown>).protectedResources).toMatchObject({
      services: ['sshd'],
    });
    expect((clone.values as Record<string, unknown>).recipients).toMatchObject({
      userIds: [ACTOR_ID],
    });
    // The clone is a NEUTRAL override: partner instructions still flow through
    // the merge, so copying the rendered block would double-wrap it.
    expect((clone.values as Record<string, unknown>).instructions).toBeNull();
    // C3: a fresh org row grants NOTHING until the append below.
    expect((clone.values as Record<string, unknown>).actAssets).toMatchObject({
      supervisedActionKeys: [],
    });

    expect(result.orgAgentId).toBe(ORG_AGENT_ID);
    expect(result.agentId).toBe(AGENT_ID);
    expect(result.keys).toEqual([OP_KEY]);
  });

  it('appends only — no clone — when the org row already exists', async () => {
    queueGrant({
      orgLocked: [orgRow({ actAssets: { scriptIds: [SCRIPT_ID], supervisedActionKeys: ['manage_alerts:suppress'] } })],
      agentLocked: [orgRow({ actAssets: { scriptIds: [SCRIPT_ID], supervisedActionKeys: ['manage_alerts:suppress'] } })],
    });

    const result = await grant();

    // Only the graduation upsert — no ai_agents INSERT at all.
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]!.kind).toBe('do_update');
    expect(result.keys).toEqual(['manage_alerts:suppress', OP_KEY]);
    expect(state.updates).toHaveLength(1);
    expect((state.updates[0]!.set as Record<string, unknown>).actAssets).toMatchObject({
      scriptIds: [SCRIPT_ID],
      supervisedActionKeys: ['manage_alerts:suppress', OP_KEY],
    });
  });
});

describe('authorizeSupervisedKey — promotion record', () => {
  it('audits the grant with identifiers only and stamps the graduation row promoted', async () => {
    queueGrant({ orgLocked: [orgRow()], agentLocked: [orgRow()] });

    await grant();

    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      orgId: ORG_ID,
      actorType: 'user',
      actorId: ACTOR_ID,
      action: 'ai.agent.supervised_key.authorized',
      resourceType: 'ai_agent',
      resourceId: ORG_AGENT_ID,
      result: 'success',
    });
    expect(state.audits[0]!.details).toEqual({
      agentId: AGENT_ID,
      orgAgentId: ORG_AGENT_ID,
      kind: 'triage',
      opKey: OP_KEY,
      intentId: INTENT_ID,
      clonedFromEffective: false,
    });

    const upsert = state.inserts[0]!;
    expect(upsert.kind).toBe('do_update');
    expect(upsert.values).toMatchObject({
      orgId: ORG_ID,
      agentId: AGENT_ID,
      opKey: OP_KEY,
      state: 'promoted',
      promotedIntentId: INTENT_ID,
    });
    expect((upsert.values as Record<string, unknown>).promotedAt).toBeInstanceOf(Date);
    const set = (upsert.conflict as { set: Record<string, unknown> }).set;
    expect(set).toMatchObject({ state: 'promoted', promotedIntentId: INTENT_ID });
  });
});
