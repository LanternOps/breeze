// apps/api/src/services/aiAgents/supervisedKeyDemote.test.ts
/**
 * P2-5 (#4192, Task A2-6) — the DEMOTE executor and its notification.
 *
 * Same capture-and-replay `../../db` mock `supervisedKeyGrant.test.ts` uses,
 * so every predicate that MATTERS is asserted as COMPILED SQL through the
 * real PgDialect (repo's vacuous-Drizzle-assertion trap). `withGraduationLock`
 * is the REAL implementation — the advisory-lock statement and the org row's
 * `FOR UPDATE` ARE the serialization contract this suite exists to pin, and a
 * mocked lock would assert nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const ORG_ID = '00000000-0000-4000-8000-0000000000b1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000b2';
/** The EFFECTIVE agent id — always the PARTNER baseline row. */
const AGENT_ID = '00000000-0000-4000-8000-0000000000b3';
const ORG_AGENT_ID = '00000000-0000-4000-8000-0000000000b4';
const RUN_ID = '00000000-0000-4000-8000-0000000000b5';
const WATCH_ID = '00000000-0000-4000-8000-0000000000b6';
const INTENT_ID = '00000000-0000-4000-8000-0000000000b7';
const USER_ID = '00000000-0000-4000-8000-0000000000b8';
/** Named on the PARTNER baseline row's `recipients`. */
const PARTNER_USER_ID = '00000000-0000-4000-8000-0000000000b9';
/** Named ONLY on the ORG override's `recipients` — the half the baseline column drops. */
const ORG_USER_ID = '00000000-0000-4000-8000-0000000000ba';
const SCRIPT_ID = '00000000-0000-4000-8000-0000000000bf';
const OP_KEY = 'manage_services:restart';
const OTHER_KEY = 'manage_alerts:acknowledge';

interface SelectRecord {
  fields: unknown;
  where: unknown;
  locked: boolean;
}

const state = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  selects: [] as SelectRecord[],
  inserts: [] as { values?: unknown; conflict?: unknown; kind?: string }[],
  updates: [] as { set?: Record<string, unknown>; where?: unknown }[],
  executed: [] as unknown[],
  audits: [] as Record<string, unknown>[],
}));

function resetState(): void {
  state.selectQueue = [];
  state.selects = [];
  state.inserts = [];
  state.updates = [];
  state.executed = [];
  state.audits = [];
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
    const record: { values?: unknown; conflict?: unknown; kind?: string } = {};
    state.inserts.push(record);
    const builder: Record<string, unknown> = {
      values: vi.fn((v: unknown) => {
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

vi.mock('../auditService', () => ({
  createAuditLogAsync: vi.fn(async (params: Record<string, unknown>) => {
    state.audits.push(params);
  }),
}));

const resolveRecipientUserIdsMock = vi.hoisted(() => vi.fn());
vi.mock('./recipients', () => ({
  resolveRecipientUserIds: (...args: unknown[]) => resolveRecipientUserIdsMock(...args),
}));

const createNotificationMock = vi.hoisted(() => vi.fn());
vi.mock('../userNotifications', () => ({
  createNotification: (...args: unknown[]) => createNotificationMock(...args),
}));

import { db } from '../../db';
import { aiAgents } from '../../db/schema/aiAgents';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import {
  demoteSupervisedKey,
  notifyDemotion,
  type DemoteDatabase,
} from './supervisedKeyDemote';

const dialect = new PgDialect();

function sqlText(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql.replace(/\s+/g, ' ');
}

function sqlParams(value: unknown): unknown[] {
  return dialect.sqlToQuery(value as SQL).params;
}

/** An `ai_agents` ORG row shaped for `normalizeAgentPolicy`. Deliberately NON-UNIFORM. */
function orgRow(supervisedActionKeys: string[], overrides: Record<string, unknown> = {}) {
  return {
    id: ORG_AGENT_ID,
    orgId: ORG_ID,
    partnerId: null,
    kind: 'triage',
    name: 'Org Triage',
    enabled: true,
    mode: 'act',
    model: 'claude-sonnet-4-5-20250929',
    toolAllowlist: ['manage_services', 'manage_alerts'],
    protectedResources: { services: ['sshd'], paths: [], registryKeys: [], deviceTags: [] },
    limits: { maxDevicesPerRun: 7, promoteThreshold: 25 },
    triggers: { alertSeverities: ['critical'], anomalyEnabled: true },
    recipients: { userIds: [USER_ID], roleIds: [] },
    actAssets: { scriptIds: [SCRIPT_ID], supervisedActionKeys },
    instructions: null,
    cooldownSeconds: 1200,
    disabledAt: null,
    ...overrides,
  };
}

/**
 * Queues the reads the demote executor performs, in order:
 *   1 organization -> partner_id · 2 partner baseline -> kind
 *   [advisory lock] 3 ORG row FOR UPDATE
 */
function queueDemote(opts: {
  org?: unknown[];
  baseline?: unknown[];
  orgLocked?: unknown[];
} = {}): void {
  state.selectQueue.push(opts.org ?? [{ partnerId: PARTNER_ID }]);
  state.selectQueue.push(opts.baseline ?? [{ kind: 'triage' }]);
  state.selectQueue.push(opts.orgLocked ?? [orgRow([OP_KEY, OTHER_KEY])]);
}

const demote = (
  overrides: Partial<Parameters<typeof demoteSupervisedKey>[0]> = {},
  database?: DemoteDatabase,
) => demoteSupervisedKey({
  orgId: ORG_ID,
  agentId: AGENT_ID,
  opKey: OP_KEY,
  reason: 'attempted_failure',
  runId: RUN_ID,
  watchId: null,
  intentId: INTENT_ID,
  ...overrides,
}, database);

/** Nothing was revoked: no actAssets UPDATE, no graduation row, no audit. */
function expectNoWrite(): void {
  expect(state.updates).toHaveLength(0);
  expect(state.inserts).toHaveLength(0);
  expect(state.audits).toHaveLength(0);
}

beforeEach(() => {
  resetState();
  vi.clearAllMocks();
  resolveRecipientUserIdsMock.mockResolvedValue([USER_ID]);
});

describe('demoteSupervisedKey — revoking a granted key', () => {
  it('removes exactly the failing key from the ORG row and stamps the graduation row demoted', async () => {
    queueDemote();
    const before = Date.now();

    const result = await demote();

    expect(result).toEqual({ revoked: true, orgAgentId: ORG_AGENT_ID });

    // The ONE actAssets write, on the ORG row, keeping every other key and
    // every other actAssets field.
    expect(state.updates).toHaveLength(1);
    const update = state.updates[0]!;
    expect(update.set!.actAssets).toEqual({
      scriptIds: [SCRIPT_ID],
      supervisedActionKeys: [OTHER_KEY],
    });
    expect(sqlParams(update.where)).toEqual([ORG_AGENT_ID]);

    // The graduation row records WHICH evidence disqualified the key.
    expect(state.inserts).toHaveLength(1);
    const graduation = state.inserts[0]!;
    expect(graduation.kind).toBe('do_update');
    expect(graduation.values).toMatchObject({
      orgId: ORG_ID,
      agentId: AGENT_ID,
      opKey: OP_KEY,
      state: 'demoted',
      demoteReason: 'attempted_failure',
      demoteRunId: RUN_ID,
      demoteWatchId: null,
      firstVerifiedAt: null,
    });
    const demotedAt = (graduation.values as { demotedAt: Date }).demotedAt;
    expect(demotedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect((graduation.conflict as { set: Record<string, unknown> }).set).toMatchObject({
      state: 'demoted',
      demoteReason: 'attempted_failure',
      demoteRunId: RUN_ID,
      demoteWatchId: null,
      firstVerifiedAt: null,
    });
  });

  it('writes an identifiers-only audit row — no rationale, no model-authored text', async () => {
    queueDemote({ orgLocked: [orgRow([OP_KEY])] });

    await demote({ reason: 'recurrence', runId: RUN_ID, watchId: WATCH_ID, intentId: null });

    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      orgId: ORG_ID,
      actorType: 'system',
      actorId: ANONYMOUS_ACTOR_ID,
      action: 'ai.agent.supervised_key.revoked',
      resourceType: 'ai_agent',
      resourceId: ORG_AGENT_ID,
      result: 'success',
      details: {
        agentId: AGENT_ID,
        orgAgentId: ORG_AGENT_ID,
        opKey: OP_KEY,
        reason: 'recurrence',
        runId: RUN_ID,
        watchId: WATCH_ID,
        intentId: null,
      },
    });
    // Identifiers only — every leaf is a uuid, an op key, or a reason enum.
    const details = (state.audits[0] as { details: Record<string, unknown> }).details;
    expect(Object.keys(details).sort()).toEqual(
      ['agentId', 'intentId', 'opKey', 'orgAgentId', 'reason', 'runId', 'watchId'],
    );
  });

  it('touches ONLY act_assets and updated_at — never enabled, mode, or last_updated_by', async () => {
    queueDemote();

    await demote();

    expect(Object.keys(state.updates[0]!.set!).sort()).toEqual(['actAssets', 'updatedAt']);
    // Anchored to the real columns, so a renamed schema field cannot make the
    // assertion above pass vacuously.
    expect(aiAgents.actAssets.name).toBe('act_assets');
    expect(aiAgents.updatedAt.name).toBe('updated_at');
  });

  it('never writes the PARTNER row: the only update targets the org row id', async () => {
    queueDemote();

    await demote();

    expect(state.updates).toHaveLength(1);
    expect(sqlParams(state.updates[0]!.where)).toEqual([ORG_AGENT_ID]);
    expect(sqlParams(state.updates[0]!.where)).not.toContain(AGENT_ID);
  });
});

describe('demoteSupervisedKey — nothing to revoke', () => {
  it('a key held only by the partner ceiling revokes nothing and writes no graduation row', async () => {
    queueDemote({ orgLocked: [orgRow([OTHER_KEY])] });

    const result = await demote();

    expect(result).toEqual({ revoked: false, orgAgentId: ORG_AGENT_ID });
    expectNoWrite();
  });

  it('an org with no agent override row at all revokes nothing', async () => {
    queueDemote({ orgLocked: [] });

    const result = await demote();

    expect(result).toEqual({ revoked: false, orgAgentId: null });
    expectNoWrite();
  });

  it('an unresolvable organization stops before the advisory lock', async () => {
    queueDemote({ org: [] });

    const result = await demote();

    expect(result).toEqual({ revoked: false, orgAgentId: null });
    expect(state.executed).toHaveLength(0);
    expectNoWrite();
  });

  it('a baseline that does not belong to this org\'s partner stops before the advisory lock', async () => {
    queueDemote({ baseline: [] });

    const result = await demote();

    expect(result).toEqual({ revoked: false, orgAgentId: null });
    expect(state.executed).toHaveLength(0);
    expectNoWrite();
  });
});

describe('demoteSupervisedKey — serialization and tenancy', () => {
  it('takes the per-tuple advisory lock BEFORE reading the org row', async () => {
    queueDemote();

    await demote();

    expect(state.executed).toHaveLength(1);
    expect(sqlText(state.executed[0])).toContain('pg_advisory_xact_lock(hashtext($1), hashtext($2))');
    expect(sqlParams(state.executed[0])).toEqual([
      'ai_agent_graduation',
      `${ORG_ID}:${AGENT_ID}:${OP_KEY}`,
    ]);
    // Three selects: organization, baseline, then the LOCKED org row.
    expect(state.selects).toHaveLength(3);
    expect(state.selects[2]!.locked).toBe(true);
  });

  it('reads the org row FOR UPDATE, pinned by org_id + kind + not-disabled', async () => {
    queueDemote();

    await demote();

    const where = sqlText(state.selects[2]!.where);
    expect(where).toContain('"org_id" = $1');
    expect(where).toContain('"kind" = $2');
    expect(where).toContain('"disabled_at" is null');
    expect(sqlParams(state.selects[2]!.where)).toEqual([ORG_ID, 'triage']);
  });

  it('pins the partner baseline through the organization\'s own partner, never a caller-named one', async () => {
    queueDemote();

    await demote();

    expect(sqlParams(state.selects[0]!.where)).toEqual([ORG_ID]);
    const baselineWhere = sqlText(state.selects[1]!.where);
    expect(baselineWhere).toContain('"partner_id" = $2');
    expect(baselineWhere).toContain('"org_id" is null');
    expect(sqlParams(state.selects[1]!.where)).toEqual([AGENT_ID, PARTNER_ID]);
  });

  it('routes EVERY statement through the injected executor — the savepoint contract', async () => {
    queueDemote();
    const calls: string[] = [];
    const proxied = {
      select: (fields?: unknown) => {
        calls.push('select');
        return db.select(fields as never);
      },
      insert: (table: never) => {
        calls.push('insert');
        return db.insert(table);
      },
      update: (table: never) => {
        calls.push('update');
        return db.update(table);
      },
      execute: (statement: never) => {
        calls.push('execute');
        return db.execute(statement);
      },
    } as unknown as DemoteDatabase;

    await demote({}, proxied);

    // A statement issued through the AMBIENT `db` instead would be missing
    // from this list — which is exactly the bug that would abort the outer
    // terminal transaction instead of just the demote's savepoint.
    expect(calls).toEqual(['select', 'select', 'execute', 'select', 'update', 'insert']);
  });
});

describe('notifyDemotion', () => {
  const notify = (overrides: Partial<Parameters<typeof notifyDemotion>[0]> = {}) => notifyDemotion({
    orgId: ORG_ID,
    agentId: AGENT_ID,
    orgAgentId: ORG_AGENT_ID,
    opKey: OP_KEY,
    reason: 'attempted_failure',
    runId: RUN_ID,
    watchId: null,
    ...overrides,
  });

  /** The PARTNER baseline row `agentId` names — read in full so the run-less
   *  fallback can merge its policy with the org override's. */
  function baselineRow(overrides: Record<string, unknown> = {}) {
    return {
      ...orgRow([OP_KEY]),
      id: AGENT_ID,
      orgId: null,
      partnerId: PARTNER_ID,
      name: 'Disk Cleaner',
      recipients: { userIds: [PARTNER_USER_ID], roleIds: [] },
      ...overrides,
    };
  }

  function queueNotify(opts: { agent?: unknown[]; run?: unknown[] } = {}): void {
    state.selectQueue.push(opts.agent ?? [baselineRow()]);
    state.selectQueue.push(
      opts.run ?? [{ policySnapshot: { effective: { recipients: { userIds: [USER_ID] } } } }],
    );
  }

  it('notifies the run snapshot\'s recipients at high priority, naming the agent and the op key only', async () => {
    queueNotify();

    await notify();

    expect(resolveRecipientUserIdsMock).toHaveBeenCalledWith(
      { orgId: null, partnerId: PARTNER_ID, recipients: { userIds: [USER_ID] } },
      ORG_ID,
    );
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    const sent = createNotificationMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      userId: USER_ID,
      orgId: ORG_ID,
      type: 'ai',
      priority: 'high',
      link: `/ai-agents/runs/${RUN_ID}`,
      dedupeKey: `graduation-demote-${ORG_AGENT_ID}-${OP_KEY}-${RUN_ID}`,
      metadata: {
        agentId: AGENT_ID,
        orgAgentId: ORG_AGENT_ID,
        opKey: OP_KEY,
        reason: 'attempted_failure',
        runId: RUN_ID,
        watchId: null,
      },
    });
    expect(sent.title).toContain('Disk Cleaner');
    expect(sent.message).toContain('Disk Cleaner');
    expect(sent.message).toContain(OP_KEY);
  });

  it('words the recurrence reason differently from the attempted-failure one', async () => {
    queueNotify();

    await notify({ reason: 'recurrence', watchId: WATCH_ID });

    const sent = createNotificationMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.dedupeKey).toBe(`graduation-demote-${ORG_AGENT_ID}-${OP_KEY}-${RUN_ID}`);
    expect(sent.metadata).toMatchObject({ reason: 'recurrence', watchId: WATCH_ID });
    expect(sent.message).toContain('recurred');
    expect(sent.message).not.toContain('attempt failed');
  });

  it('sends nothing when the agent row is gone', async () => {
    queueNotify({ agent: [] });

    await notify();

    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  // #4582 — a revoke that notifies nobody is a silent loss of unattended
  // authority. The run snapshot stays the PREFERRED recipient source; when it
  // cannot be read the effective policy is the fallback, never a stand-down.
  describe('#4582 — a demotion with no readable run still notifies', () => {
    /** The reads of the run-less path: baseline agent row, then the ORG override. */
    function queueFallback(opts: { agent?: unknown[]; org?: unknown[] } = {}): void {
      state.selectQueue.push(opts.agent ?? [baselineRow()]);
      state.selectQueue.push(opts.org ?? [orgRow([OP_KEY], {
        recipients: { userIds: [ORG_USER_ID], roleIds: [] },
      })]);
    }

    it('notifies the EFFECTIVE recipients — partner baseline UNION org override — when there is no run id', async () => {
      queueFallback();

      await notify({ runId: null, watchId: WATCH_ID, reason: 'recurrence' });

      // Not the baseline row's own `recipients` column: that silently drops
      // everyone the organization added through its override.
      expect(resolveRecipientUserIdsMock).toHaveBeenCalledWith(
        {
          orgId: null,
          partnerId: PARTNER_ID,
          recipients: { userIds: [PARTNER_USER_ID, ORG_USER_ID], roleIds: [] },
        },
        ORG_ID,
      );
      expect(createNotificationMock).toHaveBeenCalledTimes(1);
      const sent = createNotificationMock.mock.calls[0]![0] as Record<string, unknown>;
      expect(sent).toMatchObject({
        userId: USER_ID,
        orgId: ORG_ID,
        priority: 'high',
        // The episode is the WATCH when there is no run — the dedupe key the
        // P2-5 plan specified (`<runId ?? watchId>`).
        dedupeKey: `graduation-demote-${ORG_AGENT_ID}-${OP_KEY}-${WATCH_ID}`,
        metadata: { runId: null, watchId: WATCH_ID, reason: 'recurrence' },
      });
      // No run to link to, so the link points at the page whose state changed.
      expect(sent.link).toBe('/settings/ai-agents');
      expect(sent.message).toContain(OP_KEY);
    });

    it('falls back to the effective recipients when the run row is gone, still keyed by the run', async () => {
      state.selectQueue.push([baselineRow()]);
      state.selectQueue.push([]); // the run no longer exists
      state.selectQueue.push([orgRow([OP_KEY], {
        recipients: { userIds: [ORG_USER_ID], roleIds: [] },
      })]);

      await notify({ watchId: WATCH_ID });

      expect(createNotificationMock).toHaveBeenCalledTimes(1);
      const sent = createNotificationMock.mock.calls[0]![0] as Record<string, unknown>;
      // The episode identity is the run id whether or not its row is readable.
      expect(sent.dedupeKey).toBe(`graduation-demote-${ORG_AGENT_ID}-${OP_KEY}-${RUN_ID}`);
      // The run page would 404, so the link degrades with the recipient source.
      expect(sent.link).toBe('/settings/ai-agents');
    });

    it('still notifies with NO dedupe key when neither a run nor a watch identifies the episode', async () => {
      queueFallback();

      await notify({ runId: null, watchId: null });

      expect(createNotificationMock).toHaveBeenCalledTimes(1);
      const sent = createNotificationMock.mock.calls[0]![0] as Record<string, unknown>;
      // A literal placeholder would collapse every FUTURE demotion of this
      // tuple into the first one; with no episode there are no siblings to
      // collapse, so the notice carries no dedupe key at all.
      expect(sent.dedupeKey).toBeNull();
    });

    it('sends nothing when the effective policy names no recipient at all', async () => {
      state.selectQueue.push([baselineRow({ recipients: { userIds: [], roleIds: [] } })]);
      state.selectQueue.push([orgRow([OP_KEY], { recipients: { userIds: [], roleIds: [] } })]);
      resolveRecipientUserIdsMock.mockResolvedValueOnce([]);

      await notify({ runId: null, watchId: WATCH_ID });

      // The fallback RAN — this is an empty recipient set, not the old
      // stand-down that skipped resolution altogether.
      expect(resolveRecipientUserIdsMock).toHaveBeenCalledWith(
        expect.objectContaining({ recipients: { userIds: [], roleIds: [] } }),
        ORG_ID,
      );
      expect(createNotificationMock).not.toHaveBeenCalled();
    });

    it('notifies from the partner baseline alone when the org override row is gone', async () => {
      state.selectQueue.push([baselineRow()]);
      state.selectQueue.push([]); // no org override row

      await notify({ runId: null, watchId: WATCH_ID });

      expect(resolveRecipientUserIdsMock).toHaveBeenCalledWith(
        expect.objectContaining({ recipients: { userIds: [PARTNER_USER_ID], roleIds: [] } }),
        ORG_ID,
      );
      expect(createNotificationMock).toHaveBeenCalledTimes(1);
    });
  });
});
