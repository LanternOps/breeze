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
  updateReturning: null as Record<string, unknown> | null,
  deleteCount: 0,
  ambientScope: undefined as string | undefined,
  systemActive: false,
  // Every completed read, in order: which table, whether it ran inside the
  // partner-axis system escape, and which row-lock mode it asked for.
  reads: [] as Array<{ table: string; system: boolean; lock: string | null }>,
}));

function makeQuery(table: string, rows: () => unknown[]) {
  let lock: string | null = null;
  const query = {
    where: () => query,
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
      dbState.reads.push({ table, system: dbState.systemActive, lock });
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
        dbState.updatedValues = values;
        return {
          where: vi.fn((condition: unknown) => {
            dbState.updateWhere = condition;
            return {
              returning: vi.fn(async () => (dbState.updateReturning ? [dbState.updateReturning] : [])),
            };
          }),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => {
        dbState.deleteCount += 1;
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

function baselineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BASELINE_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    agentId: AGENT_ID,
    baselineScheduleId: null,
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
  dbState.deleteCount = 0;
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
});

describe('deleteSchedule', () => {
  it('deletes a partner baseline (the DB cascades its overrides)', async () => {
    dbState.scheduleRows = [[baselineRow()]];

    await deleteSchedule(partnerAuth(), BASELINE_ID);

    expect(dbState.deleteCount).toBe(1);
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
