import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  type AiAgentPolicy,
  type AiAgentPolicySnapshot,
  type AiAgentTriggers,
} from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000a2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000a3';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000a4';
const ALERT_ID = '00000000-0000-4000-8000-0000000000a5';
const RUN_ID = '00000000-0000-4000-8000-0000000000a6';
const SITE_A = '00000000-0000-4000-8000-0000000000a7';
const SITE_B = '00000000-0000-4000-8000-0000000000a8';
const RULE_A = '00000000-0000-4000-8000-0000000000a9';
const RULE_B = '00000000-0000-4000-8000-0000000000b1';
const OTHER_ORG_ID = '00000000-0000-4000-8000-0000000000b2';
const OTHER_PARTNER_ID = '00000000-0000-4000-8000-0000000000b3';

interface CapturedSelect {
  table: string;
  where?: SQL | undefined;
}

const dbMockState = vi.hoisted(() => ({
  /** FIFO of result arrays, consumed in await order, keyed by table name. */
  rowQueues: {} as Record<string, unknown[][]>,
  selects: [] as CapturedSelect[],
  /** Ordered trace of every db operation, so "before the counters" is provable. */
  calls: [] as string[],
  executed: [] as SQL[],
  insertValues: [] as Record<string, unknown>[],
  insertRows: [] as unknown[],
  insertError: null as unknown,
  insertConflictTargets: [] as unknown[],
  updateSets: [] as Record<string, unknown>[],
  updateWheres: [] as unknown[],
  updateRows: [] as unknown[],
  systemContextDepth: 0,
  ambientContext: undefined as { scope: string } | undefined,
  contextAtInsert: undefined as string | undefined,
  contextAtEnqueue: undefined as string | undefined,
}));

function nextRows(table: string): unknown[] {
  const queue = dbMockState.rowQueues[table];
  if (!queue || queue.length === 0) {
    throw new Error(`No queued rows for table ${table}`);
  }
  return queue.shift() as unknown[];
}

vi.mock('../../db', () => {
  const makeSelect = () => ({
    from: vi.fn((table: unknown) => {
      const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
      const captured: CapturedSelect = { table: tableName };
      dbMockState.selects.push(captured);
      dbMockState.calls.push(`select:${tableName}`);
      const builder: Record<string, unknown> = {
        where: vi.fn((cond: SQL) => {
          captured.where = cond;
          return builder;
        }),
        orderBy: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve()
            .then(() => nextRows(tableName))
            .then(resolve, reject),
      };
      return builder;
    }),
  });

  return {
    db: {
      select: vi.fn(() => makeSelect()),
      // The admission gate takes a transaction-scoped advisory lock through
      // db.execute before it reads any counter.
      execute: vi.fn(async (statement: SQL) => {
        dbMockState.executed.push(statement);
        dbMockState.calls.push('execute');
        return [] as unknown[];
      }),
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          dbMockState.insertValues.push(values);
          dbMockState.calls.push('insert:ai_agent_runs');
          dbMockState.contextAtInsert =
            dbMockState.systemContextDepth > 0 ? 'system' : 'none';
          const returning = vi.fn(async () => {
            if (dbMockState.insertError) throw dbMockState.insertError;
            return dbMockState.insertRows;
          });
          return {
            // The real insert goes through ON CONFLICT DO NOTHING (a caught
            // 23505 would poison the surrounding postgres.js transaction), so
            // the mock has to offer the same builder link.
            onConflictDoNothing: vi.fn((config: unknown) => {
              dbMockState.insertConflictTargets.push(config);
              return { returning };
            }),
            returning,
          };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          dbMockState.updateSets.push(values);
          dbMockState.calls.push(`update:${String(values.status ?? '')}`);
          return {
            where: vi.fn((cond: unknown) => {
              dbMockState.updateWheres.push(cond);
              return { returning: vi.fn(async () => dbMockState.updateRows) };
            }),
          };
        }),
      })),
    },
    getCurrentDbAccessContext: vi.fn(() => dbMockState.ambientContext),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      const previous = dbMockState.ambientContext;
      dbMockState.ambientContext = { scope: 'system' };
      dbMockState.systemContextDepth += 1;
      try {
        return await fn();
      } finally {
        dbMockState.systemContextDepth -= 1;
        dbMockState.ambientContext = previous;
      }
    }),
  };
});

const resolveEffectiveAgentSystem = vi.hoisted(() => vi.fn());
vi.mock('./effectivePolicy', () => ({ resolveEffectiveAgentSystem }));

const checkBudget = vi.hoisted(() => vi.fn());
vi.mock('../aiCostTracker', () => ({ checkBudget }));

const getLlmBillingSourceForOrg = vi.hoisted(() => vi.fn());
vi.mock('../llm/llmConfigResolver', () => ({ getLlmBillingSourceForOrg }));

const isDeviceInMaintenanceWindow = vi.hoisted(() => vi.fn());
vi.mock('../deploymentEngine', () => ({ isDeviceInMaintenanceWindow }));

const publishEvent = vi.hoisted(() => vi.fn());
vi.mock('../eventBus', () => ({ publishEvent }));

const reconcileHungExecutions = vi.hoisted(() =>
  vi.fn<(sessionId: string) => Promise<number>>());
const closeAgentRunSession = vi.hoisted(() =>
  vi.fn<(sessionId: string, status: 'completed' | 'failed') => Promise<void>>());
vi.mock('./executionLedger', () => ({ reconcileHungExecutions, closeAgentRunSession }));

import {
  createAndEnqueueAgentRun,
  evaluateAgentTriggerFilters,
  reapStalledAgentRuns,
  registerAgentRunEnqueuer,
  transitionRunStatus,
  type AgentRunEnqueuer,
  type CreateAgentRunInput,
} from './runService';

type AlertContext = NonNullable<CreateAgentRunInput['alertContext']>;

const dialect = new PgDialect();
function compiled(cond: SQL | undefined): string {
  if (!cond) return '';
  return dialect.sqlToQuery(cond).sql;
}

function triggers(over: Partial<AiAgentTriggers> = {}): AiAgentTriggers {
  return {
    alertSeverities: ['critical', 'high'],
    respectMaintenanceWindows: false,
    ...over,
  };
}

function policy(over: Partial<AiAgentPolicy> = {}): AiAgentPolicy {
  return {
    enabled: true,
    mode: 'shadow',
    model: null,
    toolAllowlist: ['get_device_details'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { ...AI_AGENT_LIMIT_DEFAULTS },
    triggers: triggers(),
    recipients: { userIds: [], roleIds: [] },
    actAssets: { scriptIds: [] },
    instructions: null,
    cooldownSeconds: 900,
    ...over,
  };
}

function snapshot(over: Partial<AiAgentPolicy> = {}): AiAgentPolicySnapshot {
  return {
    schemaVersion: 1,
    agentId: AGENT_ID,
    kind: 'triage',
    effective: policy(over),
    provenance: {} as AiAgentPolicySnapshot['provenance'],
    resolvedAt: new Date().toISOString(),
  };
}

function input(over: Partial<CreateAgentRunInput> = {}): CreateAgentRunInput {
  return {
    orgId: ORG_ID,
    kind: 'triage',
    triggerKind: 'manual',
    deviceId: DEVICE_ID,
    dedupeKey: 'manual:test',
    ...over,
  };
}

/** Seeds the happy-path DB reads in the exact order admission performs them. */
function seedAdmissionReads(options: {
  cooldownHit?: boolean;
  concurrent?: number;
  perHour?: number;
  dailyCents?: number | null;
  agentOrgId?: string | null;
  agentPartnerId?: string | null;
  orgPartnerId?: string | null;
  agentMissing?: boolean;
  /** The (device, org) ownership probe: false means the device is not in the org. */
  deviceInOrg?: boolean;
} = {}): void {
  const {
    cooldownHit = false,
    concurrent = 0,
    perHour = 0,
    dailyCents = 0,
    agentOrgId = null,
    agentPartnerId = PARTNER_ID,
    orgPartnerId = PARTNER_ID,
    agentMissing = false,
    deviceInOrg = true,
  } = options;

  dbMockState.rowQueues.ai_agent_runs = [
    cooldownHit ? [{ id: RUN_ID }] : [],
    [{ value: concurrent }],
    [{ value: perHour }],
    [{ totalCostCents: dailyCents }],
  ];
  dbMockState.rowQueues.organizations = [
    orgPartnerId === null ? [] : [{ id: ORG_ID, partnerId: orgPartnerId }],
  ];
  dbMockState.rowQueues.ai_agents = [
    agentMissing
      ? []
      : [{ id: AGENT_ID, orgId: agentOrgId, partnerId: agentPartnerId, name: 'Triage', kind: 'triage' }],
  ];
  dbMockState.rowQueues.devices = [deviceInOrg ? [{ id: DEVICE_ID }] : []];
  dbMockState.insertRows = [
    { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, status: 'queued', deviceId: DEVICE_ID },
  ];
}

let enqueueAgentRunJob: ReturnType<typeof vi.fn<AgentRunEnqueuer>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  dbMockState.rowQueues = {};
  dbMockState.selects = [];
  dbMockState.calls = [];
  dbMockState.executed = [];
  dbMockState.insertValues = [];
  dbMockState.insertRows = [];
  dbMockState.insertError = null;
  dbMockState.insertConflictTargets = [];
  dbMockState.updateSets = [];
  dbMockState.updateWheres = [];
  dbMockState.updateRows = [];
  dbMockState.systemContextDepth = 0;
  dbMockState.ambientContext = undefined;
  dbMockState.contextAtInsert = undefined;
  dbMockState.contextAtEnqueue = undefined;
  resolveEffectiveAgentSystem.mockResolvedValue(snapshot());
  checkBudget.mockResolvedValue(null);
  getLlmBillingSourceForOrg.mockResolvedValue('platform');
  isDeviceInMaintenanceWindow.mockResolvedValue(false);
  publishEvent.mockResolvedValue('event-id');
  enqueueAgentRunJob = vi.fn<AgentRunEnqueuer>(async () => {
    dbMockState.contextAtEnqueue = dbMockState.systemContextDepth > 0 ? 'system' : 'none';
    return { enqueued: true, jobId: `ai-agent-run-${RUN_ID}` };
  });
  registerAgentRunEnqueuer(enqueueAgentRunJob);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  registerAgentRunEnqueuer(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('evaluateAgentTriggerFilters', () => {
  const ctx: AlertContext = {
    severity: 'critical',
    ruleId: RULE_A,
    siteId: SITE_A,
    deviceTags: ['prod', 'sql'],
  };

  const cases: Array<[string, AiAgentTriggers, AlertContext, boolean]> = [
    ['severity in list', triggers(), ctx, true],
    ['severity not in list', triggers({ alertSeverities: ['low'] }), ctx, false],
    ['empty severity list matches nothing', triggers({ alertSeverities: [] }), ctx, false],
    ['absent alertRuleIds = all rules', triggers(), ctx, true],
    ['empty alertRuleIds = all rules', triggers({ alertRuleIds: [] }), ctx, true],
    ['matching alertRuleIds', triggers({ alertRuleIds: [RULE_B, RULE_A] }), ctx, true],
    ['non-matching alertRuleIds', triggers({ alertRuleIds: [RULE_B] }), ctx, false],
    ['alertRuleIds set but ruleId null', triggers({ alertRuleIds: [RULE_A] }), { ...ctx, ruleId: null }, false],
    ['empty siteIds = all sites', triggers({ siteIds: [] }), ctx, true],
    ['matching siteIds', triggers({ siteIds: [SITE_A] }), ctx, true],
    ['non-matching siteIds', triggers({ siteIds: [SITE_B] }), ctx, false],
    ['siteIds set but siteId null', triggers({ siteIds: [SITE_A] }), { ...ctx, siteId: null }, false],
    ['empty deviceTags = all devices', triggers({ deviceTags: [] }), ctx, true],
    ['intersecting deviceTags', triggers({ deviceTags: ['sql', 'other'] }), ctx, true],
    ['disjoint deviceTags', triggers({ deviceTags: ['other'] }), ctx, false],
    ['deviceTags set but device untagged', triggers({ deviceTags: ['sql'] }), { ...ctx, deviceTags: [] }, false],
    [
      'all filters satisfied together',
      triggers({ alertRuleIds: [RULE_A], siteIds: [SITE_A], deviceTags: ['prod'] }),
      ctx,
      true,
    ],
  ];

  it.each(cases)('%s', (_name, trig, context, expected) => {
    expect(evaluateAgentTriggerFilters(trig, context)).toBe(expected);
  });

  it('ignores deviceGroupIds (deferred to wave 6)', () => {
    expect(
      evaluateAgentTriggerFilters(triggers({ deviceGroupIds: ['group-that-does-not-match'] }), ctx),
    ).toBe(true);
  });
});

describe('createAndEnqueueAgentRun skip reasons', () => {
  it('kill_switch_off when the env flag is unset', async () => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');
    const result = await createAndEnqueueAgentRun(input());
    expect(result).toEqual({ created: false, skipped: 'kill_switch_off' });
    expect(resolveEffectiveAgentSystem).not.toHaveBeenCalled();
  });

  it('no_effective_agent when there is no partner baseline', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(null);
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'no_effective_agent',
    });
  });

  it('agent_disabled when the effective policy is disabled', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ enabled: false }));
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'agent_disabled',
    });
  });

  it('mode_off when the effective mode is off', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ mode: 'off' }));
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'mode_off',
    });
  });

  it('trigger_filter_mismatch when the alert context fails the filters', async () => {
    const result = await createAndEnqueueAgentRun(
      input({
        triggerKind: 'alert',
        alertId: ALERT_ID,
        dedupeKey: `alert:${ALERT_ID}`,
        alertContext: { severity: 'low', ruleId: RULE_A, siteId: SITE_A, deviceTags: [] },
      }),
    );
    expect(result).toEqual({ created: false, skipped: 'trigger_filter_mismatch' });
  });

  it('does not apply trigger filters to a manual run', async () => {
    seedAdmissionReads();
    const result = await createAndEnqueueAgentRun(input());
    expect(result).toMatchObject({ created: true });
  });

  it('maintenance_window when the device is inside one', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(
      snapshot({ triggers: triggers({ respectMaintenanceWindows: true }) }),
    );
    isDeviceInMaintenanceWindow.mockResolvedValue(true);
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'maintenance_window',
    });
    expect(isDeviceInMaintenanceWindow).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('does not consult maintenance windows when the run has no device', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(
      snapshot({ triggers: triggers({ respectMaintenanceWindows: true }) }),
    );
    seedAdmissionReads();
    await createAndEnqueueAgentRun(input({ deviceId: null }));
    expect(isDeviceInMaintenanceWindow).not.toHaveBeenCalled();
  });

  it('cooldown when a recent run exists for the same agent/org/device', async () => {
    seedAdmissionReads({ cooldownHit: true });
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'cooldown',
    });
  });

  it('skips the cooldown read entirely when cooldownSeconds is 0', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ cooldownSeconds: 0 }));
    seedAdmissionReads();
    // The cooldown probe is not issued, so the queued cooldown result must be
    // consumed by the concurrency count instead — seed without it.
    dbMockState.rowQueues.ai_agent_runs = [
      [{ value: 0 }],
      [{ value: 0 }],
      [{ totalCostCents: 0 }],
    ];
    const result = await createAndEnqueueAgentRun(input());
    expect(result).toMatchObject({ created: true });
  });

  it('max_concurrent_runs when queued+running reach the cap', async () => {
    seedAdmissionReads({ concurrent: 1 });
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'max_concurrent_runs',
    });
  });

  it('max_runs_per_hour when the hourly cap is reached', async () => {
    seedAdmissionReads({ perHour: AI_AGENT_LIMIT_DEFAULTS.maxRunsPerHour });
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'max_runs_per_hour',
    });
  });

  it('org_budget_exceeded when checkBudget refuses', async () => {
    seedAdmissionReads();
    checkBudget.mockResolvedValue('Daily AI budget exceeded ($10.00)');
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'org_budget_exceeded',
    });
    expect(checkBudget).toHaveBeenCalledWith(ORG_ID, 'platform');
  });

  it('passes the partner BYOK billing source through to checkBudget', async () => {
    seedAdmissionReads();
    getLlmBillingSourceForOrg.mockResolvedValue('partner_key');
    await createAndEnqueueAgentRun(input());
    expect(checkBudget).toHaveBeenCalledWith(ORG_ID, 'partner_key');
  });

  it('agent_daily_budget_exceeded when this agent spent its daily cap in this org', async () => {
    seedAdmissionReads({ dailyCents: AI_AGENT_LIMIT_DEFAULTS.maxBudgetCentsPerDay });
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'agent_daily_budget_exceeded',
    });
  });

  it('treats a null daily cost sum as zero spend', async () => {
    seedAdmissionReads({ dailyCents: null });
    expect(await createAndEnqueueAgentRun(input())).toMatchObject({ created: true });
  });

  it('ownership_mismatch when a partner agent targets another partner org', async () => {
    seedAdmissionReads({ agentPartnerId: OTHER_PARTNER_ID });
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'ownership_mismatch',
    });
    expect(dbMockState.insertValues).toHaveLength(0);
  });

  it('ownership_mismatch when an org agent targets another org', async () => {
    seedAdmissionReads({ agentOrgId: OTHER_ORG_ID, agentPartnerId: null });
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'ownership_mismatch',
    });
  });

  it('admits an org-owned agent running against its own org', async () => {
    seedAdmissionReads({ agentOrgId: ORG_ID, agentPartnerId: null });
    expect(await createAndEnqueueAgentRun(input())).toMatchObject({ created: true });
  });

  it('ownership_mismatch when the agent row has vanished', async () => {
    seedAdmissionReads({ agentMissing: true });
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'ownership_mismatch',
    });
  });

  it('ownership_mismatch when the organization row has vanished', async () => {
    seedAdmissionReads({ orgPartnerId: null });
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'ownership_mismatch',
    });
  });

  it('duplicate when the org/dedupe_key ON CONFLICT DO NOTHING swallows the insert', async () => {
    seedAdmissionReads();
    // DO NOTHING never raises: an empty `returning()` IS the duplicate. A
    // caught 23505 could not work here — postgres.js latches a failed
    // statement onto the transaction and rethrows it after the callback
    // returns, so the skip would never reach the caller (proven live in
    // agentRunAdmission.integration.test.ts).
    dbMockState.insertRows = [];
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'duplicate',
    });
    expect(dbMockState.insertConflictTargets).toHaveLength(1);
    expect(enqueueAgentRunJob).not.toHaveBeenCalled();
  });

  it('reclaims a dedupe row left `failed`/`enqueue_failed` by an earlier attempt', async () => {
    seedAdmissionReads();
    // The insert loses the (org_id, dedupe_key) race against a row this same
    // gate inserted and then failed because the enqueue never landed. Without
    // the reclaim, that row blocks its own retry forever: every redelivery of
    // the alert answers `duplicate` and the alert is never triaged.
    dbMockState.insertRows = [];
    dbMockState.updateRows = [{ id: RUN_ID, orgId: ORG_ID, status: 'queued', deviceId: DEVICE_ID }];

    const result = await createAndEnqueueAgentRun(input());

    expect(result).toMatchObject({ created: true });
    expect((result as { created: true; run: { id: string } }).run.id).toBe(RUN_ID);
    // Compare-and-set on the terminal state, scoped to this org's key — never a
    // blind overwrite of whatever holds the dedupe key.
    // .at(-1): the stalled-run reaper (step 4c) issues the first UPDATE.
    const where = compiled(dbMockState.updateWheres.at(-1) as SQL);
    expect(where).toContain('"org_id"');
    expect(where).toContain('"dedupe_key"');
    expect(where).toContain('"status"');
    expect(where).toContain('"error_code"');
    expect(dbMockState.updateSets.at(-1)).toMatchObject({ status: 'queued', errorCode: null });
    expect(dbMockState.updateSets.at(-1)?.finishedAt).toBeNull();
    expect(enqueueAgentRunJob).toHaveBeenCalledWith(RUN_ID);
  });

  it('still reports duplicate when the dedupe row is not an enqueue_failed one', async () => {
    seedAdmissionReads();
    dbMockState.insertRows = [];
    // The CAS matched nothing: the holder is queued/running/completed, i.e. a
    // genuine duplicate trigger.
    dbMockState.updateRows = [];

    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'duplicate',
    });
    expect(enqueueAgentRunJob).not.toHaveBeenCalled();
  });

  it('rethrows a non-unique insert failure rather than reporting a skip', async () => {
    seedAdmissionReads();
    dbMockState.insertError = Object.assign(new Error('boom'), { cause: { code: '23503' } });
    await expect(createAndEnqueueAgentRun(input())).rejects.toThrow('boom');
  });

  it('logs every skip so a dropped trigger is observable', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(null);
    await createAndEnqueueAgentRun(input());
    expect(console.info).toHaveBeenCalledWith(
      '[aiAgentRunService] run skipped',
      expect.objectContaining({ reason: 'no_effective_agent', orgId: ORG_ID }),
    );
  });

  it('publishes ai.agent.run.skipped only once an agent was actually resolved', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(null);
    await createAndEnqueueAgentRun(input());
    expect(publishEvent).not.toHaveBeenCalled();

    resolveEffectiveAgentSystem.mockResolvedValue(snapshot());
    seedAdmissionReads({ cooldownHit: true });
    await createAndEnqueueAgentRun(input());
    expect(publishEvent).toHaveBeenCalledWith(
      'ai.agent.run.skipped',
      ORG_ID,
      expect.objectContaining({ reason: 'cooldown', agentId: AGENT_ID }),
      'ai-agent-runner',
    );
  });
});

describe('createAndEnqueueAgentRun admission success', () => {
  it('inserts a queued run, publishes ai.agent.run.queued and enqueues the job', async () => {
    seedAdmissionReads();
    const result = await createAndEnqueueAgentRun(
      input({
        triggerKind: 'alert',
        alertId: ALERT_ID,
        triggerEventId: 'evt-1',
        triggerRef: { alertRuleId: RULE_A },
        dedupeKey: `alert:${ALERT_ID}`,
        alertContext: { severity: 'critical', ruleId: RULE_A, siteId: SITE_A, deviceTags: [] },
      }),
    );

    expect(result).toEqual({ created: true, run: dbMockState.insertRows[0] });
    const values = dbMockState.insertValues[0] as Record<string, unknown>;
    expect(values).toMatchObject({
      agentId: AGENT_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      alertId: ALERT_ID,
      triggerKind: 'alert',
      triggerEventId: 'evt-1',
      triggerRef: { alertRuleId: RULE_A },
      dedupeKey: `alert:${ALERT_ID}`,
      modeAtStart: 'shadow',
      status: 'queued',
    });
    expect(values.policySnapshot).toMatchObject({ agentId: AGENT_ID, schemaVersion: 1 });
    expect(typeof values.correlationId).toBe('string');

    expect(publishEvent).toHaveBeenCalledWith(
      'ai.agent.run.queued',
      ORG_ID,
      expect.objectContaining({ runId: RUN_ID, agentId: AGENT_ID, triggerKind: 'alert' }),
      'ai-agent-runner',
    );
    expect(enqueueAgentRunJob).toHaveBeenCalledWith(RUN_ID);
  });

  it('performs the insert under a system DB context', async () => {
    seedAdmissionReads();
    await createAndEnqueueAgentRun(input());
    expect(dbMockState.contextAtInsert).toBe('system');
  });

  it('enqueues OUTSIDE the DB context so no pooled connection is held across Redis', async () => {
    seedAdmissionReads();
    await createAndEnqueueAgentRun(input());
    expect(dbMockState.contextAtInsert).toBe('system');
    expect(dbMockState.contextAtEnqueue).toBe('none');
  });

  it('scopes the concurrency count to both the agent and the org', async () => {
    seedAdmissionReads();
    await createAndEnqueueAgentRun(input());
    const runSelects = dbMockState.selects.filter((s) => s.table === 'ai_agent_runs');
    // [0] cooldown, [1] concurrency, [2] per-hour, [3] daily spend
    expect(runSelects).toHaveLength(4);
    for (const select of runSelects) {
      const sql = compiled(select.where);
      expect(sql).toContain('"agent_id"');
      expect(sql).toContain('"org_id"');
    }
    expect(compiled(runSelects[1]?.where)).toContain('"status"');
  });

  it('marks the run failed when the enqueue fails instead of leaving a zombie queued row', async () => {
    seedAdmissionReads();
    enqueueAgentRunJob.mockResolvedValue({ enqueued: false });
    dbMockState.updateRows = [{ id: RUN_ID, status: 'failed', errorCode: 'enqueue_failed' }];

    const result = await createAndEnqueueAgentRun(input());

    expect(dbMockState.updateSets.at(-1)).toMatchObject({
      status: 'failed',
      errorCode: 'enqueue_failed',
    });
    expect(result).toMatchObject({ created: true });
    expect((result as { created: true; run: { status: string } }).run.status).toBe('failed');
  });

  it('marks the run failed when no enqueuer has been registered at all', async () => {
    registerAgentRunEnqueuer(null);
    seedAdmissionReads();
    dbMockState.updateRows = [{ id: RUN_ID, status: 'failed', errorCode: 'enqueue_failed' }];
    const result = await createAndEnqueueAgentRun(input());
    expect(dbMockState.updateSets.at(-1)).toMatchObject({ errorCode: 'enqueue_failed' });
    expect(result).toMatchObject({ created: true });
  });

  it('marks the run failed when publishing the queued event throws', async () => {
    seedAdmissionReads();
    publishEvent.mockRejectedValue(new Error('redis down'));
    dbMockState.updateRows = [{ id: RUN_ID, status: 'failed', errorCode: 'enqueue_failed' }];
    await createAndEnqueueAgentRun(input());
    expect(dbMockState.updateSets.at(-1)).toMatchObject({ errorCode: 'enqueue_failed' });
    expect(enqueueAgentRunJob).not.toHaveBeenCalled();
  });
});

describe('transitionRunStatus', () => {
  it('returns true and applies the patch when the CAS matches', async () => {
    dbMockState.updateRows = [{ id: RUN_ID }];
    const moved = await transitionRunStatus(RUN_ID, 'queued', 'running', { turnCount: 3 });
    expect(moved).toBe(true);
    expect(dbMockState.updateSets[0]).toMatchObject({ status: 'running', turnCount: 3 });
  });

  it('returns false when the from-status does not match (lost the race)', async () => {
    dbMockState.updateRows = [];
    expect(await transitionRunStatus(RUN_ID, 'queued', 'running')).toBe(false);
  });

  it('accepts a list of acceptable from-statuses', async () => {
    dbMockState.updateRows = [{ id: RUN_ID }];
    expect(await transitionRunStatus(RUN_ID, ['queued', 'running'], 'failed')).toBe(true);
    const sql = dialect.sqlToQuery(dbMockState.updateWheres[0] as SQL).sql;
    expect(sql).toContain('"status"');
  });
});

describe('createAndEnqueueAgentRun review findings (wave 3c)', () => {
  it('serialises the whole check-then-insert on an (agent, org) advisory lock', async () => {
    seedAdmissionReads();
    await createAndEnqueueAgentRun(input());

    // Exactly one lock, taken BEFORE any counter read and before the insert:
    // the caps are plain SELECTs, so without this every concurrent request
    // reads zero committed runs and inserts anyway.
    expect(dbMockState.executed).toHaveLength(1);
    const lock = dialect.sqlToQuery(dbMockState.executed[0]!);
    expect(lock.sql).toContain('pg_advisory_xact_lock');
    // Transaction-scoped, never the session variant: it must release on commit
    // or rollback of the context's transaction, with no unlock call to leak.
    expect(lock.sql).not.toContain('pg_advisory_lock(');
    // Keyed on the same pair every counter is scoped to — travelling as a bound
    // param, so two orgs never queue behind each other.
    expect(lock.params).toContain(`${AGENT_ID}:${ORG_ID}`);

    const lockIndex = dbMockState.calls.indexOf('execute');
    const firstRunRead = dbMockState.calls.indexOf('select:ai_agent_runs');
    const insertIndex = dbMockState.calls.indexOf('insert:ai_agent_runs');
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeLessThan(firstRunRead);
    expect(lockIndex).toBeLessThan(insertIndex);
  });

  it('reaps runs stranded in queued/running before counting them against the caps', async () => {
    seedAdmissionReads();
    await createAndEnqueueAgentRun(input());

    // A SIGKILLed replica leaves a `running` row that BullMQ's redelivery
    // cannot clear (the queued->running CAS fails, the job completes), so with
    // maxConcurrentRuns=1 the org is refused forever until this sweep exists.
    const reap = dbMockState.updateSets[0]!;
    expect(reap).toMatchObject({ status: 'failed', errorCode: 'stalled' });
    expect(reap.finishedAt).toBeInstanceOf(Date);

    const where = dialect.sqlToQuery(dbMockState.updateWheres[0] as SQL).sql;
    expect(where).toContain('"agent_id"');
    expect(where).toContain('"org_id"');
    expect(where).toContain('"status"');
    // Age is measured from started_at, falling back to queued_at for a run
    // whose job never reached a worker at all.
    expect(where).toContain('"started_at"');
    expect(where).toContain('"queued_at"');
    expect(where).toContain('is null');

    // ...and it happens before the concurrency count reads those statuses.
    expect(dbMockState.calls.indexOf('update:failed'))
      .toBeLessThan(dbMockState.calls.indexOf('select:ai_agent_runs'));
  });

  it('reapStalledAgentRuns returns the ids it failed', async () => {
    dbMockState.updateRows = [{ id: RUN_ID }];
    await expect(reapStalledAgentRuns({ agentId: AGENT_ID, orgId: ORG_ID })).resolves.toEqual([RUN_ID]);
  });

  it('reapStalledAgentRuns repairs the execution ledger for a reaped run that has a session', async () => {
    // A SIGKILLed worker predates the ledger entirely: nothing in the
    // in-process runLoop.ts cleanup ever ran for this run, so the reap itself
    // has to reconcile the hung ai_tool_executions rows and close ai_sessions.
    dbMockState.updateRows = [{ id: RUN_ID, sessionId: 'session-1' }];
    reconcileHungExecutions.mockResolvedValue(2);
    closeAgentRunSession.mockResolvedValue(undefined);

    await expect(reapStalledAgentRuns({ agentId: AGENT_ID, orgId: ORG_ID })).resolves.toEqual([RUN_ID]);

    expect(reconcileHungExecutions).toHaveBeenCalledWith('session-1');
    expect(closeAgentRunSession).toHaveBeenCalledWith('session-1', 'failed');
  });

  it('reapStalledAgentRuns skips ledger cleanup for a reaped run with no session', async () => {
    dbMockState.updateRows = [{ id: RUN_ID, sessionId: null }];

    await expect(reapStalledAgentRuns({ agentId: AGENT_ID, orgId: ORG_ID })).resolves.toEqual([RUN_ID]);

    expect(reconcileHungExecutions).not.toHaveBeenCalled();
    expect(closeAgentRunSession).not.toHaveBeenCalled();
  });

  it('reapStalledAgentRuns tolerates a ledger cleanup failure — the reap result is unaffected', async () => {
    dbMockState.updateRows = [{ id: RUN_ID, sessionId: 'session-1' }];
    reconcileHungExecutions.mockRejectedValueOnce(new Error('db unavailable'));
    closeAgentRunSession.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(reapStalledAgentRuns({ agentId: AGENT_ID, orgId: ORG_ID })).resolves.toEqual([RUN_ID]);

    // Even though reconcile failed, close is still attempted (best-effort, not
    // short-circuited).
    expect(closeAgentRunSession).toHaveBeenCalledWith('session-1', 'failed');
  });

  it('device_not_in_org when the device does not belong to the run org', async () => {
    seedAdmissionReads({ deviceInOrg: false });

    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'device_not_in_org',
    });
    // Nothing is written: the worker reads the device under a system context
    // (RLS bypass), so a foreign device would leak into this org's prompt.
    expect(dbMockState.insertValues).toHaveLength(0);
  });

  it('checks the device against the org inside the same transaction as the insert', async () => {
    seedAdmissionReads();
    await createAndEnqueueAgentRun(input());

    const deviceSelect = dbMockState.selects.find((sel) => sel.table === 'devices');
    expect(deviceSelect).toBeDefined();
    const sql = compiled(deviceSelect!.where);
    expect(sql).toContain('"id"');
    expect(sql).toContain('"org_id"');
    expect(dbMockState.calls.indexOf('select:devices'))
      .toBeLessThan(dbMockState.calls.indexOf('insert:ai_agent_runs'));
  });

  it('does not probe the device when the run has none', async () => {
    seedAdmissionReads();
    await createAndEnqueueAgentRun(input({ deviceId: null }));
    expect(dbMockState.selects.some((sel) => sel.table === 'devices')).toBe(false);
  });
});
