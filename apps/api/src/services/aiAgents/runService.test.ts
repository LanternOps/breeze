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
  insertValues: [] as Record<string, unknown>[],
  insertRows: [] as unknown[],
  insertError: null as unknown,
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
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          dbMockState.insertValues.push(values);
          dbMockState.contextAtInsert =
            dbMockState.systemContextDepth > 0 ? 'system' : 'none';
          return {
            returning: vi.fn(async () => {
              if (dbMockState.insertError) throw dbMockState.insertError;
              return dbMockState.insertRows;
            }),
          };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          dbMockState.updateSets.push(values);
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

import {
  createAndEnqueueAgentRun,
  evaluateAgentTriggerFilters,
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
  dbMockState.insertValues = [];
  dbMockState.insertRows = [];
  dbMockState.insertError = null;
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

  it('duplicate when the org/dedupe_key unique index rejects the insert', async () => {
    seedAdmissionReads();
    dbMockState.insertError = Object.assign(new Error('duplicate key'), {
      cause: { code: '23505', constraint_name: 'ai_agent_runs_org_dedupe_key_uq' },
    });
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

    expect(dbMockState.updateSets[0]).toMatchObject({
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
    expect(dbMockState.updateSets[0]).toMatchObject({ errorCode: 'enqueue_failed' });
    expect(result).toMatchObject({ created: true });
  });

  it('marks the run failed when publishing the queued event throws', async () => {
    seedAdmissionReads();
    publishEvent.mockRejectedValue(new Error('redis down'));
    dbMockState.updateRows = [{ id: RUN_ID, status: 'failed', errorCode: 'enqueue_failed' }];
    await createAndEnqueueAgentRun(input());
    expect(dbMockState.updateSets[0]).toMatchObject({ errorCode: 'enqueue_failed' });
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
