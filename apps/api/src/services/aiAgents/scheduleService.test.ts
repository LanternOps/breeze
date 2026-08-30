import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AiSweepKind } from '@breeze/shared';
import type { AuthContext } from '../../middleware/auth';
import { AgentAccessDeniedError } from './access';
import { PartnerWideWriteDeniedError } from '../partnerWideAccess';

// One shared mutable fixture store. Rows are dispatched by DRIZZLE TABLE NAME
// (same idiom as effectivePolicy.test.ts) so the suite exercises the REAL
// drizzle-orm builders and the REAL schema — a where-clause typo is a runtime
// error here, not a silently-passing assertion.
const dbState = vi.hoisted(() => ({
  organizationRows: [] as unknown[],
  agentRows: [] as unknown[][],
  scheduleRows: [] as unknown[][],
  inserted: null as Record<string, unknown> | null,
  insertReturning: null as Record<string, unknown> | null,
  updatedValues: null as Record<string, unknown> | null,
  updateWhere: undefined as unknown,
  // EVERY issued UPDATE, in order. `updatedValues`/`updateWhere` above keep
  // naming the FIRST one (every pre-existing assertion is written against the
  // row's own patch), so the override-propagation UPDATE that follows it is
  // read from here instead of silently overwriting them.
  updates: [] as Array<{ values: Record<string, unknown>; where: unknown }>,
  updateReturning: null as Record<string, unknown> | null,
  deleteCount: 0,
  ambientScope: undefined as string | undefined,
  systemActive: false,
  deleteWhere: undefined as unknown,
  deleteReturning: [] as unknown[],
  // Every completed read, in order: which table, whether it ran inside the
  // partner-axis system escape, which row-lock mode it asked for, and — the
  // point of Important 1 — the WHERE condition it was actually issued with, so
  // a dropped tenancy pin fails a test instead of passing silently.
  reads: [] as Array<{ table: string; system: boolean; lock: string | null; where: unknown }>,
}));

function makeQuery(table: string, rows: () => unknown[]) {
  let lock: string | null = null;
  let where: unknown;
  const query = {
    where: (condition: unknown) => {
      where = condition;
      return query;
    },
    limit: () => query,
    orderBy: () => query,
    for: (mode: string) => {
      lock = mode;
      return query;
    },
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => {
      let resolved: unknown[];
      try {
        resolved = rows();
      } catch (err) {
        return Promise.reject(err).then(resolve, reject);
      }
      dbState.reads.push({ table, system: dbState.systemActive, lock, where });
      return Promise.resolve(resolved).then(resolve, reject);
    },
  };
  return query;
}

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const name = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
        if (name === 'organizations') return makeQuery(name, () => dbState.organizationRows);
        if (name === 'ai_agents') return makeQuery(name, () => dbState.agentRows.shift() ?? []);
        if (name === 'ai_agent_schedules') return makeQuery(name, () => dbState.scheduleRows.shift() ?? []);
        throw new Error(`Unexpected table: ${name}`);
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        dbState.inserted = values;
        return { returning: vi.fn(async () => (dbState.insertReturning ? [dbState.insertReturning] : [])) };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        if (dbState.updatedValues === null) dbState.updatedValues = values;
        return {
          where: vi.fn((condition: unknown) => {
            if (dbState.updateWhere === undefined) dbState.updateWhere = condition;
            dbState.updates.push({ values, where: condition });
            const terminal = {
              returning: vi.fn(async () => (dbState.updateReturning ? [dbState.updateReturning] : [])),
              // Thenable too: the override-propagation UPDATE is awaited
              // directly, with no RETURNING.
              then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
                Promise.resolve([]).then(resolve, reject),
            };
            return terminal;
          }),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn((condition: unknown) => {
        dbState.deleteWhere = condition;
        dbState.deleteCount += 1;
        return { returning: vi.fn(async () => dbState.deleteReturning) };
      }),
    })),
  },
  // Named on purpose — partnerAxisRead.ts imports all three by name and fails
  // loudly if the factory omits one (see its comment / #2822).
  getCurrentDbAccessContext: vi.fn(() => (dbState.ambientScope ? { scope: dbState.ambientScope } : undefined)),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const previous = dbState.ambientScope;
    dbState.ambientScope = 'system';
    dbState.systemActive = true;
    try {
      return await fn();
    } finally {
      dbState.systemActive = false;
      dbState.ambientScope = previous;
    }
  }),
}));

import {
  ScheduleValidationError,
  createSchedule,
  deleteSchedule,
  effectiveSchedule,
  listSchedules,
  resolveEffectiveSchedulesForPartner,
  updateSchedule,
} from './scheduleService';

const PARTNER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_PARTNER_ID = '00000000-0000-4000-8000-000000000002';
const ORG_ID = '00000000-0000-4000-8000-000000000003';
const OTHER_ORG_ID = '00000000-0000-4000-8000-000000000004';
const AGENT_ID = '00000000-0000-4000-8000-000000000005';
const OTHER_AGENT_ID = '00000000-0000-4000-8000-000000000006';
const BASELINE_ID = '00000000-0000-4000-8000-000000000007';
const OVERRIDE_ID = '00000000-0000-4000-8000-000000000008';
const USER_ID = '00000000-0000-4000-8000-000000000009';

const CRON = '0 6 * * *';
/** Monday 07:00 — literal minute/hour, `*` day-of-month and month, one
 *  day-of-week. The only shape `isWeeklyLiteralCron` accepts. */
const NARRATIVE_CRON = '0 7 * * 1';
const RUN_ID = '00000000-0000-4000-8000-00000000000a';
const AI_AGENT_PRINCIPAL = { kind: 'ai_agent', agentId: AGENT_ID, runId: RUN_ID } as const;

function partnerAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: USER_ID, email: 't@example.com', name: 'Tech', isPlatformAdmin: false },
    token: null,
    partnerId: PARTNER_ID,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: [ORG_ID],
    partnerOrgAccess: 'all',
    orgCondition: (column: PgColumn) => eq(column, ORG_ID),
    canAccessOrg: (id: string) => id === ORG_ID,
    ...overrides,
  } as unknown as AuthContext;
}

function orgAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return partnerAuth({
    scope: 'organization',
    orgId: ORG_ID,
    partnerOrgAccess: undefined,
    ...overrides,
  });
}

function systemAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return partnerAuth({
    scope: 'system',
    partnerId: null,
    orgId: null,
    accessibleOrgIds: null,
    partnerOrgAccess: undefined,
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    ...overrides,
  });
}

const dialect = new PgDialect();
function compiled(condition: unknown): string {
  return dialect.sqlToQuery(condition as SQL).sql;
}

/**
 * The nth completed read of `table`, compiled to real SQL + bound params.
 * Asserting the COMPILED predicate is what makes a tenancy pin testable: the
 * mocked db cannot enforce a WHERE, so a dropped `partner_id` filter is
 * invisible to any assertion made on returned rows alone.
 */
function compiledRead(table: string, index = 0): { sql: string; params: unknown[] } {
  const read = dbState.reads.filter((r) => r.table === table)[index];
  if (!read) throw new Error(`No read #${index} of ${table}; got ${JSON.stringify(dbState.reads.map((r) => r.table))}`);
  const query = dialect.sqlToQuery(read.where as SQL);
  return { sql: query.sql, params: query.params };
}

function baselineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BASELINE_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    agentId: AGENT_ID,
    baselineScheduleId: null,
    kind: 'sweep' as const,
    cron: CRON,
    timezone: 'Europe/Berlin',
    sweepKinds: ['disk_pressure', 'stale_agents', 'failed_backups'] as AiSweepKind[],
    enabled: true,
    lastEnqueuedAt: null,
    lastOccurrenceKey: null,
    lastRunSummary: { occurrenceKey: 'k', orgsTotal: 3, runsAdmitted: 2, runsSkipped: 1, skipReasons: {}, enqueuedAt: 'x' },
    createdBy: USER_ID,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

function overrideRow(overrides: Record<string, unknown> = {}) {
  return {
    ...baselineRow(),
    id: OVERRIDE_ID,
    orgId: ORG_ID,
    partnerId: null,
    baselineScheduleId: BASELINE_ID,
    sweepKinds: ['disk_pressure'] as AiSweepKind[],
    lastRunSummary: null,
    ...overrides,
  };
}

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    kind: 'triage',
    disabledAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.organizationRows = [{ id: ORG_ID, partnerId: PARTNER_ID }];
  dbState.agentRows = [];
  dbState.scheduleRows = [];
  dbState.inserted = null;
  dbState.insertReturning = null;
  dbState.updatedValues = null;
  dbState.updateWhere = undefined;
  dbState.updateReturning = null;
  dbState.updates = [];
  dbState.deleteCount = 0;
  dbState.deleteWhere = undefined;
  dbState.deleteReturning = [{ id: BASELINE_ID }];
  dbState.ambientScope = undefined;
  dbState.systemActive = false;
  dbState.reads = [];
});

describe('effectiveSchedule', () => {
  const kinds = (...k: string[]) => k as AiSweepKind[];

  it.each([
    {
      name: 'no override passes the baseline through',
      baseline: { enabled: true, sweepKinds: kinds('disk_pressure', 'stale_agents') },
      override: null,
      expected: { enabled: true, sweepKinds: kinds('disk_pressure', 'stale_agents') },
    },
    {
      name: 'a disabled baseline cannot be re-enabled by the override',
      baseline: { enabled: false, sweepKinds: kinds('disk_pressure') },
      override: { enabled: true, sweepKinds: kinds('disk_pressure') },
      expected: { enabled: false, sweepKinds: kinds('disk_pressure') },
    },
    {
      name: 'a disabled override disables an enabled baseline',
      baseline: { enabled: true, sweepKinds: kinds('disk_pressure') },
      override: { enabled: false, sweepKinds: kinds('disk_pressure') },
      expected: { enabled: false, sweepKinds: kinds('disk_pressure') },
    },
    {
      name: 'kinds are intersected, never unioned',
      baseline: { enabled: true, sweepKinds: kinds('disk_pressure', 'stale_agents') },
      // 'service_down' is NOT in the baseline: a stale override may name it,
      // and it must never widen what the org actually sweeps.
      override: { enabled: true, sweepKinds: kinds('stale_agents', 'service_down') },
      expected: { enabled: true, sweepKinds: kinds('stale_agents') },
    },
    {
      name: 'an empty override kind list sweeps nothing',
      baseline: { enabled: true, sweepKinds: kinds('disk_pressure', 'stale_agents') },
      override: { enabled: true, sweepKinds: [] as AiSweepKind[] },
      expected: { enabled: true, sweepKinds: [] as AiSweepKind[] },
    },
  ])('$name', ({ baseline, override, expected }) => {
    expect(effectiveSchedule(baseline, override)).toEqual(expected);
  });

  it('does not alias the baseline array into its result', () => {
    const baseline = { enabled: true, sweepKinds: kinds('disk_pressure') };
    const result = effectiveSchedule(baseline, null);
    result.sweepKinds.push('service_down' as AiSweepKind);
    expect(baseline.sweepKinds).toEqual(kinds('disk_pressure'));
  });
});

describe('createSchedule — partner baseline', () => {
  const input = {
    ownerScope: 'partner' as const,
    // `createPartnerScheduleSchema.kind` defaults to 'sweep', so the service's
    // input type has it REQUIRED after parsing — every pre-P2-3 body still
    // arrives here carrying it.
    kind: 'sweep' as const,
    agentId: AGENT_ID,
    cron: CRON,
    timezone: 'Europe/Berlin',
    sweepKinds: ['disk_pressure'] as AiSweepKind[],
    enabled: true,
  };

  it('inserts a partner-owned baseline for a partner-wide triage agent', async () => {
    dbState.agentRows = [[agentRow()]];
    dbState.insertReturning = baselineRow();

    const row = await createSchedule(partnerAuth(), input);

    expect(row.id).toBe(BASELINE_ID);
    expect(dbState.inserted).toMatchObject({
      orgId: null,
      partnerId: PARTNER_ID,
      agentId: AGENT_ID,
      baselineScheduleId: null,
      cron: CRON,
      timezone: 'Europe/Berlin',
      sweepKinds: ['disk_pressure'],
      enabled: true,
      createdBy: USER_ID,
    });
  });

  it('rejects an org-owned agent with agent_not_partner_wide', async () => {
    dbState.agentRows = [[agentRow({ orgId: ORG_ID, partnerId: null })]];

    await expect(createSchedule(partnerAuth(), input)).rejects.toMatchObject({
      code: 'agent_not_partner_wide',
    });
    expect(dbState.inserted).toBeNull();
  });

  it("rejects another partner's agent with agent_not_partner_wide", async () => {
    dbState.agentRows = [[agentRow({ partnerId: OTHER_PARTNER_ID })]];

    await expect(createSchedule(partnerAuth(), input)).rejects.toMatchObject({
      code: 'agent_not_partner_wide',
    });
  });

  it('rejects a soft-deleted agent with agent_not_partner_wide', async () => {
    dbState.agentRows = [[agentRow({ disabledAt: new Date() })]];

    await expect(createSchedule(partnerAuth(), input)).rejects.toMatchObject({
      code: 'agent_not_partner_wide',
    });
  });

  it("rejects a non-triage agent with agent_kind_not_triage", async () => {
    dbState.agentRows = [[agentRow({ kind: 'patch' })]];

    await expect(createSchedule(partnerAuth(), input)).rejects.toMatchObject({
      code: 'agent_kind_not_triage',
    });
    expect(dbState.inserted).toBeNull();
  });

  it('rejects a 6-field cron with invalid_cron — the sweeper evaluator is 5-field only', async () => {
    dbState.agentRows = [[agentRow()]];

    await expect(
      createSchedule(partnerAuth(), { ...input, cron: '0 0 6 * * *' }),
    ).rejects.toMatchObject({ code: 'invalid_cron' });
    expect(dbState.inserted).toBeNull();
  });

  it('rejects an unknown timezone with invalid_timezone', async () => {
    dbState.agentRows = [[agentRow()]];

    await expect(
      createSchedule(partnerAuth(), { ...input, timezone: 'Mars/Olympus_Mons' }),
    ).rejects.toMatchObject({ code: 'invalid_timezone' });
    expect(dbState.inserted).toBeNull();
  });

  it('canonicalizes the timezone before storing it', async () => {
    dbState.agentRows = [[agentRow()]];
    dbState.insertReturning = baselineRow();

    await createSchedule(partnerAuth(), { ...input, timezone: 'utc' });

    expect(dbState.inserted).toMatchObject({ timezone: 'UTC' });
  });

  it('denies a partner admin without full org access (PartnerWideWriteDeniedError)', async () => {
    await expect(
      createSchedule(partnerAuth({ partnerOrgAccess: 'selected' }), input),
    ).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(dbState.inserted).toBeNull();
  });

  it('denies an ai_agent principal (AgentAccessDeniedError)', async () => {
    await expect(
      createSchedule(partnerAuth({ principal: AI_AGENT_PRINCIPAL }), input),
    ).rejects.toBeInstanceOf(AgentAccessDeniedError);
    expect(dbState.inserted).toBeNull();
  });

  // -------------------------------------------------------------------------
  // P2-3 — `kind` (sweep | narrative)
  // -------------------------------------------------------------------------

  it('persists the sweep kind for a pre-P2-3 shaped create', async () => {
    dbState.agentRows = [[agentRow()]];
    dbState.insertReturning = baselineRow();

    await createSchedule(partnerAuth(), input);

    // NOT merely "the column defaults to sweep in Postgres": an omitted
    // `kind` on the INSERT would make the DB default the only thing deciding
    // it, and a future default change would silently re-point every schedule.
    expect(dbState.inserted).toMatchObject({ kind: 'sweep' });
  });

  const narrativeInput = { ...input, kind: 'narrative' as const, cron: NARRATIVE_CRON, sweepKinds: [] as AiSweepKind[] };

  it('inserts a narrative baseline with no sweep kinds on a weekly cron', async () => {
    dbState.agentRows = [[agentRow()]];
    dbState.insertReturning = baselineRow({ kind: 'narrative', sweepKinds: [], cron: NARRATIVE_CRON });

    await createSchedule(partnerAuth(), narrativeInput);

    expect(dbState.inserted).toMatchObject({
      kind: 'narrative',
      sweepKinds: [],
      cron: NARRATIVE_CRON,
      partnerId: PARTNER_ID,
      orgId: null,
    });
  });

  it('rejects a narrative baseline that carries sweep kinds (kinds_not_empty)', async () => {
    dbState.agentRows = [[agentRow()]];

    await expect(
      createSchedule(partnerAuth(), { ...narrativeInput, sweepKinds: ['disk_pressure'] as AiSweepKind[] }),
    ).rejects.toMatchObject({ code: 'kinds_not_empty' });
    expect(dbState.inserted).toBeNull();
  });

  // The zod schema enforces this too; the service is reachable from non-HTTP
  // callers, so it has to hold here or the schema is the only guard. Each of
  // these clears the HOURLY floor and is still not weekly.
  it.each(['0 6 * * *', '0 7 * * 1,3', '0 7 1 * *', '0,30 7 * * 1'])(
    'rejects a narrative baseline on the non-weekly cron %s (invalid_cron_for_kind)',
    async (cron) => {
      dbState.agentRows = [[agentRow()]];

      await expect(
        createSchedule(partnerAuth(), { ...narrativeInput, cron }),
      ).rejects.toMatchObject({ code: 'invalid_cron_for_kind' });
      expect(dbState.inserted).toBeNull();
    },
  );

  it('still applies the hourly cadence floor to a SWEEP baseline', async () => {
    dbState.agentRows = [[agentRow()]];

    await expect(
      createSchedule(partnerAuth(), { ...input, cron: '*/15 * * * *' }),
    ).rejects.toMatchObject({ code: 'invalid_cron' });
  });

  it('rejects a SWEEP baseline that sweeps nothing (kinds_empty)', async () => {
    dbState.agentRows = [[agentRow()]];

    await expect(
      createSchedule(partnerAuth(), { ...input, sweepKinds: [] as AiSweepKind[] }),
    ).rejects.toMatchObject({ code: 'kinds_empty' });
    expect(dbState.inserted).toBeNull();
  });
});

describe('createSchedule — org override', () => {
  const input = {
    ownerScope: 'organization' as const,
    orgId: ORG_ID,
    baselineScheduleId: BASELINE_ID,
    enabled: true,
    sweepKinds: ['disk_pressure'] as AiSweepKind[],
  };

  it('inserts a tightening override that inherits the baseline cadence and agent', async () => {
    dbState.scheduleRows = [[baselineRow()]];
    dbState.insertReturning = overrideRow();

    const row = await createSchedule(orgAuth(), input);

    expect(row.id).toBe(OVERRIDE_ID);
    expect(dbState.inserted).toMatchObject({
      orgId: ORG_ID,
      partnerId: null,
      baselineScheduleId: BASELINE_ID,
      // Inherited, never client-supplied: an override always runs on its
      // baseline's cadence and against its baseline's agent.
      agentId: AGENT_ID,
      cron: CRON,
      timezone: 'Europe/Berlin',
      sweepKinds: ['disk_pressure'],
      enabled: true,
    });
  });

  it('locks the baseline row FOR SHARE while validating the subset', async () => {
    dbState.scheduleRows = [[baselineRow()]];
    dbState.insertReturning = overrideRow();

    await createSchedule(orgAuth(), input);

    const baselineRead = dbState.reads.find((r) => r.table === 'ai_agent_schedules');
    expect(baselineRead).toBeDefined();
    expect(baselineRead?.lock).toBe('share');
    // An org-scoped caller never passes breeze_has_partner_access, so the
    // partner baseline is invisible without the partner-axis escape (#2822).
    expect(baselineRead?.system).toBe(true);
  });

  it("rejects a baseline outside the org's own partner with baseline_wrong_partner", async () => {
    // The lookup is pinned to (this partner OR this org), so another partner's
    // baseline simply does not resolve — no cross-tenant existence oracle.
    dbState.scheduleRows = [[]];

    await expect(createSchedule(orgAuth(), input)).rejects.toMatchObject({
      code: 'baseline_wrong_partner',
    });
    expect(dbState.inserted).toBeNull();
  });

  it('rejects an override used as a baseline with baseline_is_override', async () => {
    dbState.scheduleRows = [[overrideRow({ id: BASELINE_ID })]];

    await expect(createSchedule(orgAuth(), input)).rejects.toMatchObject({
      code: 'baseline_is_override',
    });
    expect(dbState.inserted).toBeNull();
  });

  it('rejects an ownerless baseline row with baseline_not_partner_row', async () => {
    // Defence in depth: ai_agent_schedules_one_owner_chk forbids this shape,
    // so it can only arrive from a forged/backfilled row.
    dbState.scheduleRows = [[baselineRow({ partnerId: null })]];

    await expect(createSchedule(orgAuth(), input)).rejects.toMatchObject({
      code: 'baseline_not_partner_row',
    });
  });

  it('rejects sweepKinds that are not a subset of the baseline with kinds_not_subset', async () => {
    dbState.scheduleRows = [[baselineRow()]];

    await expect(
      createSchedule(orgAuth(), { ...input, sweepKinds: ['disk_pressure', 'service_down'] as AiSweepKind[] }),
    ).rejects.toMatchObject({ code: 'kinds_not_subset' });
    expect(dbState.inserted).toBeNull();
  });

  it('accepts an empty sweepKinds list (disable every kind for this org)', async () => {
    dbState.scheduleRows = [[baselineRow()]];
    dbState.insertReturning = overrideRow({ sweepKinds: [] });

    await createSchedule(orgAuth(), { ...input, sweepKinds: [] });

    expect(dbState.inserted).toMatchObject({ sweepKinds: [] });
  });

  it('denies an org the service cannot access', async () => {
    await expect(
      createSchedule(orgAuth({ canAccessOrg: () => false }), input),
    ).rejects.toBeInstanceOf(AgentAccessDeniedError);
    expect(dbState.inserted).toBeNull();
  });

  it('denies an ai_agent principal', async () => {
    await expect(
      createSchedule(orgAuth({ principal: AI_AGENT_PRINCIPAL }), input),
    ).rejects.toBeInstanceOf(AgentAccessDeniedError);
  });

  // -------------------------------------------------------------------------
  // P2-3 — the override COPIES the baseline's kind
  // -------------------------------------------------------------------------

  it("copies a sweep baseline's kind onto the override row", async () => {
    dbState.scheduleRows = [[baselineRow()]];
    dbState.insertReturning = overrideRow();

    await createSchedule(orgAuth(), input);

    expect(dbState.inserted).toMatchObject({ kind: 'sweep' });
  });

  it("copies a narrative baseline's kind onto the override row", async () => {
    // `ai_agent_schedules_baseline_kind_fk` is a COMPOSITE self-FK on
    // (baseline_schedule_id, kind) — an override that omitted this, or wrote
    // the column's 'sweep' default, is a 23503 at insert time, not a silent
    // mismatch. Client input never reaches this field.
    dbState.scheduleRows = [[baselineRow({ kind: 'narrative', sweepKinds: [], cron: NARRATIVE_CRON })]];
    dbState.insertReturning = overrideRow({ kind: 'narrative', sweepKinds: [] });

    await createSchedule(orgAuth(), { ...input, sweepKinds: [] });

    expect(dbState.inserted).toMatchObject({
      kind: 'narrative',
      sweepKinds: [],
      cron: NARRATIVE_CRON,
      baselineScheduleId: BASELINE_ID,
    });
  });

  it('refuses an override that adds sweep kinds to a narrative baseline', async () => {
    // A narrative baseline sweeps `[]`, so ANY kind is a widening — the
    // subset rule already covers it, and the DB CHECK backs it up.
    dbState.scheduleRows = [[baselineRow({ kind: 'narrative', sweepKinds: [] })]];

    await expect(
      createSchedule(orgAuth(), { ...input, sweepKinds: ['disk_pressure'] as AiSweepKind[] }),
    ).rejects.toMatchObject({ code: 'kinds_not_subset' });
    expect(dbState.inserted).toBeNull();
  });
});

describe('updateSchedule', () => {
  it('stamps updated_at on every update (there is no DB trigger)', async () => {
    dbState.scheduleRows = [[baselineRow()]];
    dbState.updateReturning = baselineRow({ enabled: false });

    await updateSchedule(partnerAuth(), BASELINE_ID, { enabled: false });

    expect(dbState.updatedValues).toMatchObject({ enabled: false });
    expect(dbState.updatedValues?.updatedAt).toBeInstanceOf(Date);
  });

  it('refuses an org token patching a partner baseline (PartnerWideWriteDeniedError)', async () => {
    dbState.scheduleRows = [[baselineRow()]];

    await expect(
      updateSchedule(orgAuth(), BASELINE_ID, { enabled: false }),
    ).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(dbState.updatedValues).toBeNull();
  });

  it('rejects a partner cron that is not 5-field', async () => {
    dbState.scheduleRows = [[baselineRow()]];

    await expect(
      updateSchedule(partnerAuth(), BASELINE_ID, { cron: '0 0 6 * * *' }),
    ).rejects.toMatchObject({ code: 'invalid_cron' });
  });

  it('re-checks the subset against the baseline when an override narrows its kinds', async () => {
    dbState.scheduleRows = [[overrideRow()], [baselineRow()]];

    await expect(
      updateSchedule(orgAuth(), OVERRIDE_ID, { sweepKinds: ['service_down'] as AiSweepKind[] }),
    ).rejects.toMatchObject({ code: 'kinds_not_subset' });
    expect(dbState.updatedValues).toBeNull();
  });

  it('rejects an override whose stored agent no longer matches its baseline', async () => {
    dbState.scheduleRows = [[overrideRow({ agentId: OTHER_AGENT_ID })], [baselineRow()]];

    await expect(
      updateSchedule(orgAuth(), OVERRIDE_ID, { sweepKinds: ['disk_pressure'] as AiSweepKind[] }),
    ).rejects.toMatchObject({ code: 'baseline_agent_mismatch' });
  });

  it('rejects a cron on an org override — the cadence belongs to the baseline', async () => {
    dbState.scheduleRows = [[overrideRow()]];

    await expect(
      updateSchedule(orgAuth(), OVERRIDE_ID, { cron: '0 7 * * *' }),
    ).rejects.toBeInstanceOf(ScheduleValidationError);
    expect(dbState.updatedValues).toBeNull();
  });

  it('applies an override enable/disable without touching the baseline', async () => {
    dbState.scheduleRows = [[overrideRow()]];
    dbState.updateReturning = overrideRow({ enabled: false });

    const row = await updateSchedule(orgAuth(), OVERRIDE_ID, { enabled: false });

    expect(row.enabled).toBe(false);
    expect(dbState.updatedValues).toMatchObject({ enabled: false });
  });

  it('denies an ai_agent principal', async () => {
    dbState.scheduleRows = [[overrideRow()]];

    await expect(
      updateSchedule(orgAuth({ principal: AI_AGENT_PRINCIPAL }), OVERRIDE_ID, { enabled: false }),
    ).rejects.toBeInstanceOf(AgentAccessDeniedError);
  });

  it('bounds the UPDATE by the access predicate, not by the primary key alone', async () => {
    dbState.scheduleRows = [[overrideRow()]];
    dbState.updateReturning = overrideRow({ enabled: false });

    await updateSchedule(orgAuth(), OVERRIDE_ID, { enabled: false });

    const sql = compiled(dbState.updateWhere);
    expect(sql).toContain('"org_id"');
    expect(sql).toContain('"partner_id"');
  });

  it('leaves a system caller unrestricted on both axes', async () => {
    dbState.scheduleRows = [[overrideRow()]];
    dbState.updateReturning = overrideRow({ enabled: false });

    await updateSchedule(systemAuth(), OVERRIDE_ID, { enabled: false });

    // A system caller's orgCondition is undefined: narrowing it to the partner
    // axis would make every org override unreachable to a platform caller.
    const sql = compiled(dbState.updateWhere);
    expect(sql).not.toContain('"partner_id"');
    expect(sql).toContain('"id"');
  });

  it('denies an unknown id', async () => {
    dbState.scheduleRows = [[]];

    await expect(
      updateSchedule(partnerAuth(), BASELINE_ID, { enabled: false }),
    ).rejects.toBeInstanceOf(AgentAccessDeniedError);
  });

  // -------------------------------------------------------------------------
  // Final-review fixes (#4189)
  // -------------------------------------------------------------------------

  // Item 3a — the service validates independently of the zod schema (it is
  // reachable from non-HTTP callers), so the cadence floor has to hold HERE
  // too or the shared schema is the only thing enforcing it.
  it('rejects a sub-hourly partner cron (cadence floor)', async () => {
    for (const cron of ['*/15 * * * *', '* * * * *', '0-5 6 * * *']) {
      dbState.scheduleRows = [[baselineRow()]];
      await expect(
        updateSchedule(partnerAuth(), BASELINE_ID, { cron }),
      ).rejects.toMatchObject({ code: 'invalid_cron' });
    }
  });

  // Item 6 — the update schema is SHARED by both owner shapes, and an org
  // override's `[]` legitimately means "disable every kind for this org". A
  // partner baseline that sweeps nothing is just a disabled schedule wearing
  // an enabled flag, and `kinds_not_subset` would be the wrong story to tell
  // the client, so this gets its own code.
  it('refuses an empty sweepKinds list on a PARTNER baseline (kinds_empty)', async () => {
    dbState.scheduleRows = [[baselineRow()]];

    await expect(
      updateSchedule(partnerAuth(), BASELINE_ID, { sweepKinds: [] }),
    ).rejects.toMatchObject({ code: 'kinds_empty' });
    expect(dbState.updatedValues).toBeNull();
  });

  it('still accepts an empty sweepKinds list on an ORG override (opt out of every kind)', async () => {
    dbState.scheduleRows = [[overrideRow()], [baselineRow()]];
    dbState.updateReturning = overrideRow({ sweepKinds: [] });

    const row = await updateSchedule(orgAuth(), OVERRIDE_ID, { sweepKinds: [] });

    expect(row.sweepKinds).toEqual([]);
    expect(dbState.updatedValues).toMatchObject({ sweepKinds: [] });
  });

  // Item 9 (live-check B1) — an override row's cron/timezone are a COPY of its
  // baseline's (createSchedule inherits them, and the table is NOT NULL on
  // both). Re-cronning the baseline without propagating leaves every override
  // row advertising the OLD cadence to `listSchedules`, which is what the org
  // sees on its own schedule page.
  it('propagates a changed cron to the baseline\'s override rows in the same transaction', async () => {
    dbState.scheduleRows = [[baselineRow()]];
    dbState.updateReturning = baselineRow({ cron: '30 7 * * *' });

    await updateSchedule(partnerAuth(), BASELINE_ID, { cron: '30 7 * * *' });

    expect(dbState.updates).toHaveLength(2);
    const propagation = dbState.updates[1]!;
    expect(propagation.values).toMatchObject({ cron: '30 7 * * *' });
    expect(propagation.values.updatedAt).toBeInstanceOf(Date);
    const where = dialect.sqlToQuery(propagation.where as SQL);
    expect(where.sql).toContain('"baseline_schedule_id"');
    expect(where.params).toEqual(expect.arrayContaining([BASELINE_ID]));
  });

  it('propagates the timezone that was PERSISTED on the baseline, not the raw input', async () => {
    dbState.scheduleRows = [[baselineRow()]];
    // The RETURNING row is the source of truth for what the baseline now
    // stores; the propagation copies that, so the two rows can never end up
    // describing the same zone with two different strings.
    dbState.updateReturning = baselineRow({ timezone: 'America/New_York' });

    await updateSchedule(partnerAuth(), BASELINE_ID, { timezone: 'America/New_York' });

    expect(dbState.updates).toHaveLength(2);
    expect(dbState.updatedValues).toMatchObject({ timezone: 'America/New_York' });
    expect(dbState.updates[1]!.values).toMatchObject({ timezone: 'America/New_York' });
  });

  it('issues NO propagation UPDATE when neither cron nor timezone changed', async () => {
    dbState.scheduleRows = [[baselineRow()]];
    dbState.updateReturning = baselineRow({ enabled: false });

    await updateSchedule(partnerAuth(), BASELINE_ID, { enabled: false });

    expect(dbState.updates).toHaveLength(1);
  });

  it('issues NO propagation UPDATE for an ORG override (it has no dependants)', async () => {
    dbState.scheduleRows = [[overrideRow()]];
    dbState.updateReturning = overrideRow({ enabled: false });

    await updateSchedule(orgAuth(), OVERRIDE_ID, { enabled: false });

    expect(dbState.updates).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // P2-3 — a PATCH cannot walk a narrative baseline out of its own rules
  // -------------------------------------------------------------------------

  function narrativeBaseline(over: Record<string, unknown> = {}) {
    return baselineRow({ kind: 'narrative', sweepKinds: [], cron: NARRATIVE_CRON, ...over });
  }

  it('rejects a non-weekly cron on a NARRATIVE baseline (invalid_cron_for_kind)', async () => {
    // `kind` is immutable (the update schema never admits it), so the stored
    // row is what decides which cadence rule applies — a daily cron here
    // would turn a "weekly report" into seven overlapping ones.
    dbState.scheduleRows = [[narrativeBaseline()]];

    await expect(
      updateSchedule(partnerAuth(), BASELINE_ID, { cron: '0 6 * * *' }),
    ).rejects.toMatchObject({ code: 'invalid_cron_for_kind' });
    expect(dbState.updatedValues).toBeNull();
  });

  it('accepts a weekly cron on a narrative baseline', async () => {
    dbState.scheduleRows = [[narrativeBaseline()]];
    dbState.updateReturning = narrativeBaseline({ cron: '30 8 * * 5' });

    const row = await updateSchedule(partnerAuth(), BASELINE_ID, { cron: '30 8 * * 5' });

    expect(row.cron).toBe('30 8 * * 5');
    expect(dbState.updatedValues).toMatchObject({ cron: '30 8 * * 5' });
  });

  it('refuses a non-empty sweepKinds list on a narrative baseline (kinds_not_empty)', async () => {
    dbState.scheduleRows = [[narrativeBaseline()]];

    await expect(
      updateSchedule(partnerAuth(), BASELINE_ID, { sweepKinds: ['disk_pressure'] as AiSweepKind[] }),
    ).rejects.toMatchObject({ code: 'kinds_not_empty' });
    expect(dbState.updatedValues).toBeNull();
  });

  it('does NOT raise kinds_empty for an empty list on a narrative baseline', async () => {
    // `kinds_empty` is a SWEEP-only rule ("a baseline that sweeps nothing is
    // just a disabled schedule"). A narrative baseline sweeps nothing BY
    // DEFINITION, so the same `[]` is the only value it may ever hold.
    dbState.scheduleRows = [[narrativeBaseline()]];
    dbState.updateReturning = narrativeBaseline();

    const row = await updateSchedule(partnerAuth(), BASELINE_ID, { sweepKinds: [] });

    expect(row.sweepKinds).toEqual([]);
    expect(dbState.updatedValues).toMatchObject({ sweepKinds: [] });
  });
});

describe('deleteSchedule', () => {
  it('deletes a partner baseline (the DB cascades its overrides)', async () => {
    dbState.scheduleRows = [[baselineRow()]];

    await deleteSchedule(partnerAuth(), BASELINE_ID);

    expect(dbState.deleteCount).toBe(1);
  });

  it('fails closed when the DELETE removes no row', async () => {
    // loadScheduleForWrite may read through the SYSTEM escape while the DELETE
    // runs under the caller's own RLS, so "visible" does not imply "deletable".
    // Without RETURNING the route would answer 204 and audit success for a
    // delete that removed nothing.
    dbState.scheduleRows = [[baselineRow()]];
    dbState.deleteReturning = [];

    await expect(deleteSchedule(partnerAuth(), BASELINE_ID)).rejects.toBeInstanceOf(AgentAccessDeniedError);
  });

  it('bounds the DELETE by the access predicate, not by the primary key alone', async () => {
    dbState.scheduleRows = [[baselineRow()]];

    await deleteSchedule(partnerAuth(), BASELINE_ID);

    const sql = compiled(dbState.deleteWhere);
    expect(sql).toContain('"org_id"');
    expect(sql).toContain('"partner_id"');
  });

  it('refuses an org token deleting a partner baseline', async () => {
    dbState.scheduleRows = [[baselineRow()]];

    await expect(deleteSchedule(orgAuth(), BASELINE_ID)).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(dbState.deleteCount).toBe(0);
  });
});

describe('listSchedules', () => {
  it('gives a partner caller its baselines with the run summary intact', async () => {
    dbState.scheduleRows = [[baselineRow()]];

    const rows = await listSchedules(partnerAuth(), {});

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(BASELINE_ID);
    expect(rows[0]?.ownerScope).toBe('partner');
    expect(rows[0]?.lastRunSummary).not.toBeNull();
    expect(rows[0]?.override).toBeNull();
    expect(rows[0]?.effective).toEqual({
      enabled: true,
      sweepKinds: ['disk_pressure', 'stale_agents', 'failed_backups'],
    });
  });

  it("merges one org's override when a partner caller asks for that org", async () => {
    dbState.scheduleRows = [[baselineRow()], [overrideRow()]];

    const rows = await listSchedules(partnerAuth(), { orgId: ORG_ID });

    expect(rows[0]?.override).toEqual({ id: OVERRIDE_ID, enabled: true, sweepKinds: ['disk_pressure'] });
    expect(rows[0]?.effective).toEqual({ enabled: true, sweepKinds: ['disk_pressure'] });
  });

  it('denies a partner caller asking for an org it cannot access', async () => {
    await expect(
      listSchedules(partnerAuth(), { orgId: OTHER_ORG_ID }),
    ).rejects.toBeInstanceOf(AgentAccessDeniedError);
  });

  it("strips the partner run summary from an org caller's view", async () => {
    dbState.agentRows = [[agentRow()]];
    dbState.scheduleRows = [[baselineRow()], [overrideRow()]];

    const rows = await listSchedules(orgAuth(), {});

    expect(rows).toHaveLength(1);
    // last_run_summary aggregates EVERY org under the partner; it must never
    // reach one of them.
    expect(rows[0]?.lastRunSummary).toBeNull();
    expect(rows[0]?.override).toEqual({ id: OVERRIDE_ID, enabled: true, sweepKinds: ['disk_pressure'] });
    expect(rows[0]?.effective).toEqual({ enabled: true, sweepKinds: ['disk_pressure'] });
  });

  it('reads the partner baselines for an org caller through the partner-axis escape', async () => {
    dbState.agentRows = [[agentRow()]];
    dbState.scheduleRows = [[baselineRow()], [overrideRow()]];

    await listSchedules(orgAuth(), {});

    const baselineRead = dbState.reads.find((r) => r.table === 'ai_agent_schedules');
    expect(baselineRead?.system).toBe(true);
    // The org's own override rows are read under the org's OWN RLS context.
    const overrideRead = dbState.reads.filter((r) => r.table === 'ai_agent_schedules')[1];
    expect(overrideRead?.system).toBe(false);
  });

  it('returns nothing to an org whose partner has no partner-wide triage agent', async () => {
    dbState.agentRows = [[]];
    dbState.scheduleRows = [];

    expect(await listSchedules(orgAuth(), {})).toEqual([]);
  });

  // The DTO is what the web schedule page branches on to decide whether to
  // render a sweep-kind selector at all; without `kind` a narrative schedule
  // is indistinguishable from a sweep one that happens to sweep nothing.
  it.each(['sweep', 'narrative'] as const)('emits kind=%s on the schedule DTO', async (kind) => {
    dbState.scheduleRows = [[baselineRow({ kind, sweepKinds: kind === 'narrative' ? [] : ['disk_pressure'] })]];

    const rows = await listSchedules(partnerAuth(), {});

    expect(rows[0]?.kind).toBe(kind);
  });
});

/**
 * Important 1 (review round 1): the mocked db cannot enforce a WHERE, so every
 * assertion made only on RETURNED ROWS passes whether or not the tenancy pin is
 * present. These compile the predicate the service actually issued and assert
 * both the columns and the BOUND VALUES — deleting any pin below fails here and
 * nowhere else.
 */
describe('tenancy pins (compiled SQL)', () => {
  const orgCreateInput = {
    ownerScope: 'organization' as const,
    orgId: ORG_ID,
    baselineScheduleId: BASELINE_ID,
    enabled: true,
    sweepKinds: ['disk_pressure'] as AiSweepKind[],
  };

  it("pins the baseline lookup to the org's OWN partner or the org itself", async () => {
    dbState.scheduleRows = [[baselineRow()]];
    dbState.insertReturning = overrideRow();

    await createSchedule(orgAuth(), orgCreateInput);

    const { sql, params } = compiledRead('ai_agent_schedules');
    expect(sql).toContain('"partner_id"');
    expect(sql).toContain('"org_id"');
    // Without the pin this read would be `id = $1` alone — an arbitrary
    // client-supplied id reaching a NO-RLS system escape, i.e. a cross-tenant
    // read AND an existence oracle.
    expect(params).toEqual([BASELINE_ID, PARTNER_ID, ORG_ID]);
  });

  it("pins an org caller's baseline read to its partner's partner-wide, live triage agents", async () => {
    dbState.agentRows = [[agentRow()]];
    dbState.scheduleRows = [[baselineRow()], [overrideRow()]];

    await listSchedules(orgAuth(), {});

    const agents = compiledRead('ai_agents');
    expect(agents.sql).toContain('"org_id" is null');
    expect(agents.sql).toContain('"partner_id"');
    expect(agents.sql).toContain('"kind"');
    expect(agents.sql).toContain('"disabled_at" is null');
    expect(agents.params).toEqual([PARTNER_ID, 'triage']);

    // Inside the escape the app predicate is the ONLY filter, so it must carry
    // the partner AND the agent allowlist, not just `org_id IS NULL`.
    const baselines = compiledRead('ai_agent_schedules', 0);
    expect(baselines.sql).toContain('"org_id" is null');
    expect(baselines.sql).toContain('"partner_id"');
    expect(baselines.sql).toContain('"agent_id" in');
    expect(baselines.params).toEqual([PARTNER_ID, AGENT_ID]);
  });

  it('pins the override read to the requesting org and its own baselines', async () => {
    dbState.agentRows = [[agentRow()]];
    dbState.scheduleRows = [[baselineRow()], [overrideRow()]];

    await listSchedules(orgAuth(), {});

    const overrides = compiledRead('ai_agent_schedules', 1);
    expect(overrides.sql).toContain('"org_id"');
    expect(overrides.sql).toContain('"baseline_schedule_id" in');
    expect(overrides.params).toEqual([ORG_ID, BASELINE_ID]);
  });

  it("pins a partner caller's baseline read to its own partner", async () => {
    dbState.scheduleRows = [[baselineRow()]];

    await listSchedules(partnerAuth(), {});

    const { sql, params } = compiledRead('ai_agent_schedules');
    expect(sql).toContain('"org_id" is null');
    expect(sql).toContain('"partner_id"');
    expect(params).toEqual([PARTNER_ID]);
  });

  it('pins the sweeper resolver — which runs with NO RLS backstop', async () => {
    dbState.scheduleRows = [[baselineRow()], [overrideRow()]];

    await resolveEffectiveSchedulesForPartner(PARTNER_ID);

    // This whole resolver runs in a SYSTEM context for Task 9's fan-out: RLS
    // passes unconditionally, so these two predicates are the ONLY thing
    // keeping one partner's schedules out of another partner's sweep.
    const baselines = compiledRead('ai_agent_schedules', 0);
    expect(baselines.sql).toContain('"org_id" is null');
    expect(baselines.sql).toContain('"partner_id"');
    expect(baselines.params).toEqual([PARTNER_ID]);

    const overrides = compiledRead('ai_agent_schedules', 1);
    expect(overrides.sql).toContain('"baseline_schedule_id" in');
    expect(overrides.params).toEqual([BASELINE_ID]);
  });

  it('pins the write-path row load to both of the caller\'s axes', async () => {
    dbState.scheduleRows = [[baselineRow()]];
    dbState.updateReturning = baselineRow({ enabled: false });

    await updateSchedule(partnerAuth(), BASELINE_ID, { enabled: false });

    const { sql, params } = compiledRead('ai_agent_schedules');
    expect(sql).toContain('"org_id"');
    expect(sql).toContain('"partner_id"');
    expect(params).toEqual([BASELINE_ID, ORG_ID, PARTNER_ID]);
  });

  it('does not take the partner-axis escape for a partner-scoped caller', async () => {
    dbState.scheduleRows = [[baselineRow()]];
    dbState.updateReturning = baselineRow({ enabled: false });

    await updateSchedule(partnerAuth(), BASELINE_ID, { enabled: false });

    // A partner token already passes breeze_has_partner_access for its own
    // partner; escaping would hold a second pooled connection for nothing.
    expect(compiledRead('ai_agent_schedules')).toBeDefined();
    expect(dbState.reads[0]?.system).toBe(false);
  });

  it('does take the escape for an org-scoped caller, which cannot see partner rows', async () => {
    dbState.scheduleRows = [[baselineRow()]];

    await expect(updateSchedule(orgAuth(), BASELINE_ID, { enabled: false })).rejects.toBeInstanceOf(
      PartnerWideWriteDeniedError,
    );

    expect(dbState.reads[0]?.system).toBe(true);
  });
});

describe('resolveEffectiveSchedulesForPartner', () => {
  it('returns each baseline with its overrides keyed by org, in a system context', async () => {
    dbState.scheduleRows = [[baselineRow()], [overrideRow()]];

    const result = await resolveEffectiveSchedulesForPartner(PARTNER_ID);

    expect(result).toHaveLength(1);
    expect(result[0]?.baseline.id).toBe(BASELINE_ID);
    expect(result[0]?.overridesByOrg.get(ORG_ID)).toEqual({
      id: OVERRIDE_ID,
      enabled: true,
      sweepKinds: ['disk_pressure'],
    });
    expect(dbState.reads.every((r) => r.system)).toBe(true);
  });

  it("carries the baseline's kind through to the sweeper", async () => {
    // The sweeper branches on this to choose the run profile; a resolver that
    // dropped it would silently fan a narrative schedule out as a sweep.
    dbState.scheduleRows = [[baselineRow({ kind: 'narrative', sweepKinds: [] })], []];

    const result = await resolveEffectiveSchedulesForPartner(PARTNER_ID);

    expect(result[0]?.baseline.kind).toBe('narrative');
  });

  it('skips the override query when the partner has no baselines', async () => {
    dbState.scheduleRows = [[]];

    expect(await resolveEffectiveSchedulesForPartner(PARTNER_ID)).toEqual([]);
    expect(dbState.reads).toHaveLength(1);
  });

  it('does not re-enter a system context it is already inside', async () => {
    dbState.ambientScope = 'system';
    dbState.scheduleRows = [[]];

    await resolveEffectiveSchedulesForPartner(PARTNER_ID);

    const { withSystemDbAccessContext } = await import('../../db');
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });
});
