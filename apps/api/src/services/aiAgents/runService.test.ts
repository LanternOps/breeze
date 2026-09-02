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
const TICKET_ID = '00000000-0000-4000-8000-0000000000b4';
const ANOMALY_INCIDENT_ID = '00000000-0000-4000-8000-0000000000c9';
const GROUP_A = '00000000-0000-4000-8000-0000000000b5';
const GROUP_B = '00000000-0000-4000-8000-0000000000b6';
const SCHEDULE_ID = '00000000-0000-4000-8000-0000000000d1';

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

// Wave 6 PR 2 (#3828): the circuit breaker's own classification/threshold/
// notify logic is unit-tested in full in `agentCircuit.test.ts`. Mocked here
// so admission and `transitionRunStatus` tests exercise only the WIRING
// (called with the right args, at the right time, non-fatal on throw) without
// re-fighting this file's already-elaborate table-agnostic insert/update mock
// (which has no `onConflictDoUpdate` support — agentCircuit.ts's upsert needs
// one — and no notion of per-table row shape for a second, unrelated table).
const isCircuitOpen = vi.hoisted(() => vi.fn());
const recordRunTerminal = vi.hoisted(() => vi.fn());
vi.mock('./agentCircuit', () => ({
  isCircuitOpen,
  recordRunTerminal,
  // Small and pure enough to just re-assert here rather than import — the
  // real implementation has its own dedicated coverage in agentCircuit.test.ts.
  isTerminalRunStatus: (status: string) => status !== 'queued' && status !== 'running',
}));

import {
  createAndEnqueueAgentRun,
  evaluateAgentTriggerFilters,
  evaluateAnomalyTriggerFilters,
  evaluateTicketTriggerFilters,
  reapStalledAgentRuns,
  registerAgentRunEnqueuer,
  transitionRunStatus,
  type AgentRunEnqueuer,
  type CreateAgentRunInput,
} from './runService';

type AlertContext = NonNullable<CreateAgentRunInput['alertContext']>;
type TicketFilterContext = NonNullable<CreateAgentRunInput['ticketContext']>;
type AnomalyFilterContext = NonNullable<CreateAgentRunInput['anomalyContext']>;

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
  /**
   * Rows `reapStalledAgentRuns`'s own candidate SELECT returns (wave 6 PR 2,
   * #3828 — it now selects candidates before CAS-ing each one through
   * `transitionRunStatus`, rather than one bulk UPDATE). Defaults to none:
   * most admission tests don't care about reaping, and an empty candidate
   * set means the reap step does no UPDATE at all.
   */
  staleCandidates?: Array<{ id: string; sessionId: string | null }>;
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
    staleCandidates = [],
  } = options;

  dbMockState.rowQueues.ai_agent_runs = [
    staleCandidates,
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
  isCircuitOpen.mockResolvedValue(false);
  recordRunTerminal.mockResolvedValue(undefined);
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

  it.each(cases)('%s', async (_name, trig, context, expected) => {
    expect(await evaluateAgentTriggerFilters(trig, context, DEVICE_ID, ORG_ID)).toBe(expected);
  });

  // Wave 6 PR 4 (#3828 Task 1) — deviceGroupIds is no longer inert. The
  // member/non-member/unrestricted matrix below pins the new async
  // membership-lookup behavior; the org-pin test asserts the query is
  // scoped by BOTH device_id AND org_id (deviceMatchesAnyGroup runs inside
  // a system db context, which bypasses RLS, so the org scoping has to be
  // in the WHERE clause itself).
  describe('deviceGroupIds', () => {
    it('absent deviceGroupIds = unrestricted (no membership query)', async () => {
      expect(await evaluateAgentTriggerFilters(triggers(), ctx, DEVICE_ID, ORG_ID)).toBe(true);
      expect(dbMockState.selects.some((s) => s.table === 'device_group_memberships')).toBe(false);
    });

    it('empty deviceGroupIds = unrestricted (no membership query)', async () => {
      expect(
        await evaluateAgentTriggerFilters(triggers({ deviceGroupIds: [] }), ctx, DEVICE_ID, ORG_ID),
      ).toBe(true);
      expect(dbMockState.selects.some((s) => s.table === 'device_group_memberships')).toBe(false);
    });

    it('device is a member of a listed group', async () => {
      dbMockState.rowQueues.device_group_memberships = [[{ groupId: GROUP_A }]];
      expect(
        await evaluateAgentTriggerFilters(
          triggers({ deviceGroupIds: [GROUP_A, GROUP_B] }), ctx, DEVICE_ID, ORG_ID,
        ),
      ).toBe(true);
    });

    it('device is not a member of any listed group', async () => {
      dbMockState.rowQueues.device_group_memberships = [[{ groupId: GROUP_B }]];
      expect(
        await evaluateAgentTriggerFilters(triggers({ deviceGroupIds: [GROUP_A] }), ctx, DEVICE_ID, ORG_ID),
      ).toBe(false);
    });

    it('device has no group memberships at all', async () => {
      dbMockState.rowQueues.device_group_memberships = [[]];
      expect(
        await evaluateAgentTriggerFilters(triggers({ deviceGroupIds: [GROUP_A] }), ctx, DEVICE_ID, ORG_ID),
      ).toBe(false);
    });

    it('deviceId null fails a non-empty deviceGroupIds filter without querying', async () => {
      expect(
        await evaluateAgentTriggerFilters(triggers({ deviceGroupIds: [GROUP_A] }), ctx, null, ORG_ID),
      ).toBe(false);
      expect(dbMockState.selects.some((s) => s.table === 'device_group_memberships')).toBe(false);
    });

    it('is org-pinned: the membership query filters by device_id AND org_id', async () => {
      dbMockState.rowQueues.device_group_memberships = [[{ groupId: GROUP_A }]];
      await evaluateAgentTriggerFilters(triggers({ deviceGroupIds: [GROUP_A] }), ctx, DEVICE_ID, ORG_ID);

      const call = dbMockState.selects.find((s) => s.table === 'device_group_memberships');
      expect(call).toBeDefined();
      const sql = compiled(call?.where);
      expect(sql).toContain('device_id');
      expect(sql).toContain('org_id');
      expect(sql).toMatch(/\band\b/i);
    });
  });
});

// Wave 6 PR 3 review follow-up (#3828): ticketCategories/ticketPriorities
// were validated and merged by effectivePolicy but never read anywhere, so
// a helpdesk agent fired on EVERY ticket regardless of its configured
// filters. This pins the fix's match/no-match/unrestricted semantics for
// each filter independently and combined.
describe('evaluateTicketTriggerFilters', () => {
  const CATEGORY_ID = '11111111-1111-4111-8111-111111111111';
  const OTHER_CATEGORY_ID = '22222222-2222-4222-8222-222222222222';

  const ctx: TicketFilterContext = {
    category: 'hardware',
    categoryId: CATEGORY_ID,
    priority: 'high',
  };

  const cases: Array<[string, AiAgentTriggers, TicketFilterContext, boolean]> = [
    ['absent ticketCategories = unrestricted', triggers(), ctx, true],
    ['empty ticketCategories = unrestricted', triggers({ ticketCategories: [] }), ctx, true],
    ['matching ticketCategories by name', triggers({ ticketCategories: ['hardware'] }), ctx, true],
    ['non-matching ticketCategories by name', triggers({ ticketCategories: ['software'] }), ctx, false],
    ['ticketCategories set but category null', triggers({ ticketCategories: ['hardware'] }), { ...ctx, category: null }, false],
    ['matching ticketCategories by categoryId (UUID value)', triggers({ ticketCategories: [CATEGORY_ID] }), ctx, true],
    ['matching ticketCategories by categoryId is case-insensitive', triggers({ ticketCategories: [CATEGORY_ID.toUpperCase()] }), ctx, true],
    ['non-matching ticketCategories by categoryId', triggers({ ticketCategories: [OTHER_CATEGORY_ID] }), ctx, false],
    ['ticketCategories set to a UUID but categoryId null', triggers({ ticketCategories: [CATEGORY_ID] }), { ...ctx, categoryId: null }, false],
    ['mixed name+id list matches on either', triggers({ ticketCategories: ['software', CATEGORY_ID] }), ctx, true],
    ['absent ticketPriorities = unrestricted', triggers(), ctx, true],
    ['empty ticketPriorities = unrestricted', triggers({ ticketPriorities: [] }), ctx, true],
    ['matching ticketPriorities', triggers({ ticketPriorities: ['high', 'urgent'] }), ctx, true],
    ['non-matching ticketPriorities', triggers({ ticketPriorities: ['low', 'normal'] }), ctx, false],
    [
      'both filters satisfied together',
      triggers({ ticketCategories: ['hardware'], ticketPriorities: ['high'] }),
      ctx,
      true,
    ],
    [
      'category matches but priority does not — combined AND, not OR',
      triggers({ ticketCategories: ['hardware'], ticketPriorities: ['low'] }),
      ctx,
      false,
    ],
  ];

  it.each(cases)('%s', (_name, trig, context, expected) => {
    expect(evaluateTicketTriggerFilters(trig, context)).toBe(expected);
  });
});

// Wave 6 PR 4 (#3828 Task 3) — anomalyTypes/metricNames/minAnomalyScore
// narrowing, plus the SAME device-bound filters (siteIds/deviceTags/
// deviceGroupIds) evaluateAgentTriggerFilters applies for an alert trigger.
// Anomaly runs are device-bound, unlike ticket runs, so this evaluator is
// async for the same deviceGroupIds membership-lookup reason.
describe('evaluateAnomalyTriggerFilters', () => {
  const ctx: AnomalyFilterContext = {
    anomalyType: 'cpu_spike',
    metricNames: ['cpu_percent', 'load_avg'],
    peakScore: 5,
    siteId: SITE_A,
    deviceTags: ['prod', 'sql'],
  };

  const cases: Array<[string, AiAgentTriggers, AnomalyFilterContext, boolean]> = [
    ['absent anomalyTypes = unrestricted', triggers(), ctx, true],
    ['empty anomalyTypes = unrestricted', triggers({ anomalyTypes: [] }), ctx, true],
    ['matching anomalyTypes', triggers({ anomalyTypes: ['cpu_spike', 'disk_full'] }), ctx, true],
    ['non-matching anomalyTypes', triggers({ anomalyTypes: ['disk_full'] }), ctx, false],
    ['absent metricNames = unrestricted', triggers(), ctx, true],
    ['empty metricNames = unrestricted', triggers({ metricNames: [] }), ctx, true],
    ['intersecting metricNames', triggers({ metricNames: ['cpu_percent', 'other'] }), ctx, true],
    ['disjoint metricNames', triggers({ metricNames: ['other'] }), ctx, false],
    ['absent minAnomalyScore = unrestricted', triggers(), ctx, true],
    ['peakScore at the minAnomalyScore floor passes', triggers({ minAnomalyScore: 5 }), ctx, true],
    ['peakScore above the minAnomalyScore floor passes', triggers({ minAnomalyScore: 4.9 }), ctx, true],
    ['peakScore below the minAnomalyScore floor fails', triggers({ minAnomalyScore: 5.1 }), ctx, false],
    ['empty siteIds = all sites', triggers({ siteIds: [] }), ctx, true],
    ['matching siteIds', triggers({ siteIds: [SITE_A] }), ctx, true],
    ['non-matching siteIds', triggers({ siteIds: [SITE_B] }), ctx, false],
    ['siteIds set but siteId null', triggers({ siteIds: [SITE_A] }), { ...ctx, siteId: null }, false],
    ['empty deviceTags = all devices', triggers({ deviceTags: [] }), ctx, true],
    ['intersecting deviceTags', triggers({ deviceTags: ['sql', 'other'] }), ctx, true],
    ['disjoint deviceTags', triggers({ deviceTags: ['other'] }), ctx, false],
    [
      'all filters satisfied together',
      triggers({ anomalyTypes: ['cpu_spike'], metricNames: ['load_avg'], minAnomalyScore: 1, siteIds: [SITE_A], deviceTags: ['prod'] }),
      ctx,
      true,
    ],
  ];

  it.each(cases)('%s', async (_name, trig, context, expected) => {
    expect(await evaluateAnomalyTriggerFilters(trig, context, DEVICE_ID, ORG_ID)).toBe(expected);
  });

  describe('deviceGroupIds (reused from evaluateAgentTriggerFilters via deviceMatchesAnyGroup)', () => {
    it('absent deviceGroupIds = unrestricted (no membership query)', async () => {
      expect(await evaluateAnomalyTriggerFilters(triggers(), ctx, DEVICE_ID, ORG_ID)).toBe(true);
      expect(dbMockState.selects.some((s) => s.table === 'device_group_memberships')).toBe(false);
    });

    it('device is a member of a listed group', async () => {
      dbMockState.rowQueues.device_group_memberships = [[{ groupId: GROUP_A }]];
      expect(
        await evaluateAnomalyTriggerFilters(triggers({ deviceGroupIds: [GROUP_A, GROUP_B] }), ctx, DEVICE_ID, ORG_ID),
      ).toBe(true);
    });

    it('device is not a member of any listed group', async () => {
      dbMockState.rowQueues.device_group_memberships = [[{ groupId: GROUP_B }]];
      expect(
        await evaluateAnomalyTriggerFilters(triggers({ deviceGroupIds: [GROUP_A] }), ctx, DEVICE_ID, ORG_ID),
      ).toBe(false);
    });

    it('deviceId null fails a non-empty deviceGroupIds filter without querying', async () => {
      expect(
        await evaluateAnomalyTriggerFilters(triggers({ deviceGroupIds: [GROUP_A] }), ctx, null, ORG_ID),
      ).toBe(false);
      expect(dbMockState.selects.some((s) => s.table === 'device_group_memberships')).toBe(false);
    });
  });
});

describe('createAndEnqueueAgentRun skip reasons', () => {
  it('kill_switch_off when the env flag is unset', async () => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');
    const result = await createAndEnqueueAgentRun(input());
    expect(result).toEqual({ created: false, skipped: 'kill_switch_off' });
    expect(resolveEffectiveAgentSystem).not.toHaveBeenCalled();
    expect(isCircuitOpen).not.toHaveBeenCalled();
  });

  it('no_effective_agent when there is no partner baseline', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(null);
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'no_effective_agent',
    });
    expect(isCircuitOpen).not.toHaveBeenCalled();
  });

  it('agent_disabled when the effective policy is disabled', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ enabled: false }));
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'agent_disabled',
    });
    expect(isCircuitOpen).not.toHaveBeenCalled();
  });

  it('mode_off when the effective mode is off', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ mode: 'off' }));
    expect(await createAndEnqueueAgentRun(input())).toEqual({
      created: false,
      skipped: 'mode_off',
    });
    expect(isCircuitOpen).not.toHaveBeenCalled();
  });

  it('circuit_open when the (org, agent) circuit has tripped — checked right after the kill switch/mode gates', async () => {
    isCircuitOpen.mockResolvedValue(true);
    const result = await createAndEnqueueAgentRun(input());
    expect(result).toEqual({ created: false, skipped: 'circuit_open' });
    expect(isCircuitOpen).toHaveBeenCalledWith(ORG_ID, AGENT_ID);
    // Admission never even reaches the trigger-filter/maintenance/cooldown
    // gates once the circuit is open — no DB reads for those happen at all.
    expect(dbMockState.calls).toHaveLength(0);
  });

  it('is admission-only: an open circuit is published as a genuine skip, not merely logged', async () => {
    isCircuitOpen.mockResolvedValue(true);
    await createAndEnqueueAgentRun(input({ triggerKind: 'alert', alertId: ALERT_ID, dedupeKey: `alert:${ALERT_ID}` }));
    expect(publishEvent).toHaveBeenCalledWith(
      'ai.agent.run.skipped',
      ORG_ID,
      expect.objectContaining({ reason: 'circuit_open', agentId: AGENT_ID }),
      'ai-agent-runner',
    );
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
    // consumed by the concurrency count instead — seed without it (but keep
    // the leading reap-candidates slot, which is always read first).
    dbMockState.rowQueues.ai_agent_runs = [
      [],
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
    // Phase 2 wave P2-1: the reclaim SET must carry the retrying caller's
    // profile/correlationGroupId too, not just leave the reclaimed row on
    // whatever it was originally inserted with — profile governs tool
    // exposure (guardrail-relevant), so a stale value here is a real bug, not
    // cosmetic drift.
    expect(dbMockState.updateSets.at(-1)).toMatchObject({ profile: 'full', correlationGroupId: null });
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
    // [0] reap candidates, [1] cooldown, [2] concurrency, [3] per-hour, [4] daily spend
    expect(runSelects).toHaveLength(5);
    for (const select of runSelects) {
      const sql = compiled(select.where);
      expect(sql).toContain('"agent_id"');
      expect(sql).toContain('"org_id"');
    }
    expect(compiled(runSelects[2]?.where)).toContain('"status"');
  });

  it('marks the run failed when the enqueue fails instead of leaving a zombie queued row', async () => {
    seedAdmissionReads();
    enqueueAgentRunJob.mockResolvedValue({ enqueued: false });
    dbMockState.updateRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, errorCode: 'enqueue_failed', outcome: {} }];
    // failRunAfterEnqueueFailure now routes the CAS through transitionRunStatus
    // (wave 6 PR 2, #3828), then does a follow-up SELECT for the full row its
    // own caller needs — this queues that follow-up read.
    dbMockState.rowQueues.ai_agent_runs!.push([{ id: RUN_ID, status: 'failed', errorCode: 'enqueue_failed' }]);

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
    dbMockState.updateRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, errorCode: 'enqueue_failed', outcome: {} }];
    dbMockState.rowQueues.ai_agent_runs!.push([{ id: RUN_ID, status: 'failed', errorCode: 'enqueue_failed' }]);
    const result = await createAndEnqueueAgentRun(input());
    expect(dbMockState.updateSets.at(-1)).toMatchObject({ errorCode: 'enqueue_failed' });
    expect(result).toMatchObject({ created: true });
  });

  it('marks the run failed when publishing the queued event throws', async () => {
    seedAdmissionReads();
    publishEvent.mockRejectedValue(new Error('redis down'));
    dbMockState.updateRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, errorCode: 'enqueue_failed', outcome: {} }];
    dbMockState.rowQueues.ai_agent_runs!.push([{ id: RUN_ID, status: 'failed', errorCode: 'enqueue_failed' }]);
    await createAndEnqueueAgentRun(input());
    expect(dbMockState.updateSets.at(-1)).toMatchObject({ errorCode: 'enqueue_failed' });
    expect(enqueueAgentRunJob).not.toHaveBeenCalled();
  });

  it('routes the enqueue-failure terminalization through recordRunTerminal', async () => {
    seedAdmissionReads();
    enqueueAgentRunJob.mockResolvedValue({ enqueued: false });
    dbMockState.updateRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, errorCode: 'enqueue_failed', outcome: {}, profile: 'full' }];
    dbMockState.rowQueues.ai_agent_runs!.push([{ id: RUN_ID, status: 'failed', errorCode: 'enqueue_failed' }]);

    await createAndEnqueueAgentRun(input());

    expect(recordRunTerminal).toHaveBeenCalledWith(
      { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile: 'full' },
      'failed',
      'enqueue_failed',
      null,
    );
  });
});

// Wave 6 PR 3 (#3828) — ticket-shadow admission. Ticket-triggered runs are
// device-less (deviceId always null — v1 has no device axis for tickets) and
// MUST always start in shadow, regardless of the agent's configured
// effective mode: the design authority is explicit that a ticket admission
// never produces an autonomous ticket write, even for an 'act'-mode agent.
describe('createAndEnqueueAgentRun — ticket-triggered admission (#3828 wave-6-3 task 3)', () => {
  function ticketInput(over: Partial<CreateAgentRunInput> = {}): CreateAgentRunInput {
    return input({
      kind: 'helpdesk',
      triggerKind: 'ticket',
      deviceId: null,
      ticketId: TICKET_ID,
      triggerRef: { ticketId: TICKET_ID },
      dedupeKey: `ticket-created:${TICKET_ID}`,
      ...over,
    });
  }

  it('forces modeAtStart to shadow even when the effective policy mode is act', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(
      snapshot({ mode: 'act' }),
    );
    seedAdmissionReads();
    const result = await createAndEnqueueAgentRun(ticketInput());

    expect(result.created).toBe(true);
    const values = dbMockState.insertValues[0] as Record<string, unknown>;
    expect(values).toMatchObject({
      triggerKind: 'ticket',
      deviceId: null,
      ticketId: TICKET_ID,
      modeAtStart: 'shadow',
    });
  });

  it('persists shadow modeAtStart when the effective policy mode is already shadow', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ mode: 'shadow' }));
    seedAdmissionReads();
    await createAndEnqueueAgentRun(ticketInput());

    const values = dbMockState.insertValues[0] as Record<string, unknown>;
    expect(values.modeAtStart).toBe('shadow');
  });

  it('does not consult maintenance windows for a ticket-triggered (device-less) run', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(
      snapshot({ mode: 'act', triggers: triggers({ respectMaintenanceWindows: true }) }),
    );
    seedAdmissionReads();
    await createAndEnqueueAgentRun(ticketInput());
    expect(isDeviceInMaintenanceWindow).not.toHaveBeenCalled();
  });

  it('kill_switch_off still precedes the forced-shadow override', async () => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');
    const result = await createAndEnqueueAgentRun(ticketInput());
    expect(result).toEqual({ created: false, skipped: 'kill_switch_off' });
    expect(resolveEffectiveAgentSystem).not.toHaveBeenCalled();
  });

  it('circuit_open still precedes the forced-shadow override', async () => {
    isCircuitOpen.mockResolvedValue(true);
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ mode: 'act' }));
    const result = await createAndEnqueueAgentRun(ticketInput());
    expect(result).toEqual({ created: false, skipped: 'circuit_open' });
    // The forced-shadow assignment happens before the circuit check, but must
    // never short-circuit it — the insert must never be reached.
    expect(dbMockState.insertValues).toHaveLength(0);
  });

  it('a duplicate ticket-created delivery collapses onto the same dedupe key (no second row)', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ mode: 'act' }));
    seedAdmissionReads();
    dbMockState.insertRows = []; // ON CONFLICT DO NOTHING — the row already exists
    dbMockState.updateRows = []; // not an enqueue_failed reclaim either — genuinely a repeat

    const result = await createAndEnqueueAgentRun(ticketInput());
    expect(result).toEqual({ created: false, skipped: 'duplicate' });
  });

  // Branch-review fix: `runLoop.loadRunContext` loads hostile ticket content
  // into the prompt whenever `run.ticketId` is set (runLoop.ts), gated on
  // ticketId alone — NOT on triggerKind. A caller that set `ticketId` on a
  // non-'ticket' triggerKind (e.g. 'alert') would therefore have hostile
  // ticket content fed into an 'act'-mode run whose forced-shadow override
  // was keyed on triggerKind === 'ticket' only, and so never fired. No
  // legitimate caller sends this combination, so it must be rejected
  // outright rather than silently admitted.
  it('rejects a request that carries ticketId with a non-ticket triggerKind, even for an act-mode agent', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ mode: 'act' }));

    await expect(
      createAndEnqueueAgentRun(
        input({ triggerKind: 'alert', alertId: ALERT_ID, ticketId: TICKET_ID, dedupeKey: `alert:${ALERT_ID}` }),
      ),
    ).rejects.toThrow(/ticketId/i);

    // Must fail before ever consulting policy or writing a row.
    expect(resolveEffectiveAgentSystem).not.toHaveBeenCalled();
    expect(dbMockState.insertValues).toHaveLength(0);
  });

  // Wave 6 PR 3 review follow-up (#3828): ticketCategories/ticketPriorities
  // were validated and merged by effectivePolicy but never evaluated during
  // admission, so a helpdesk agent fired on EVERY ticket regardless of its
  // configured filters. These pin the admission-level wiring;
  // `evaluateTicketTriggerFilters`'s own describe block above covers the
  // match logic exhaustively.
  describe('ticket trigger filters (#3828 review follow-up)', () => {
    it('admits when no ticketContext is supplied at all (no filter to fail)', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(
        snapshot({ triggers: triggers({ ticketCategories: ['hardware'] }) }),
      );
      seedAdmissionReads();
      const result = await createAndEnqueueAgentRun(ticketInput());
      expect(result.created).toBe(true);
    });

    it('admits when the agent has no configured ticket filters (unrestricted)', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(snapshot());
      seedAdmissionReads();
      const result = await createAndEnqueueAgentRun(
        ticketInput({ ticketContext: { category: 'hardware', categoryId: null, priority: 'low' } }),
      );
      expect(result.created).toBe(true);
    });

    it('trigger_filter_mismatch when ticketCategories is configured and the ticket category does not match', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(
        snapshot({ triggers: triggers({ ticketCategories: ['software'] }) }),
      );
      const result = await createAndEnqueueAgentRun(
        ticketInput({ ticketContext: { category: 'hardware', categoryId: null, priority: 'low' } }),
      );
      expect(result).toEqual({ created: false, skipped: 'trigger_filter_mismatch' });
    });

    it('admits when ticketCategories matches the ticket category by name', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(
        snapshot({ triggers: triggers({ ticketCategories: ['hardware'] }) }),
      );
      seedAdmissionReads();
      const result = await createAndEnqueueAgentRun(
        ticketInput({ ticketContext: { category: 'hardware', categoryId: null, priority: 'low' } }),
      );
      expect(result.created).toBe(true);
    });

    it('trigger_filter_mismatch when ticketPriorities is configured and the ticket priority does not match', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(
        snapshot({ triggers: triggers({ ticketPriorities: ['urgent'] }) }),
      );
      const result = await createAndEnqueueAgentRun(
        ticketInput({ ticketContext: { category: null, categoryId: null, priority: 'low' } }),
      );
      expect(result).toEqual({ created: false, skipped: 'trigger_filter_mismatch' });
    });

    it('admits when ticketPriorities matches the ticket priority', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(
        snapshot({ triggers: triggers({ ticketPriorities: ['urgent'] }) }),
      );
      seedAdmissionReads();
      const result = await createAndEnqueueAgentRun(
        ticketInput({ ticketContext: { category: null, categoryId: null, priority: 'urgent' } }),
      );
      expect(result.created).toBe(true);
    });

    it('combined: both filters must match — one mismatch is enough to skip', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(
        snapshot({ triggers: triggers({ ticketCategories: ['hardware'], ticketPriorities: ['urgent'] }) }),
      );
      const result = await createAndEnqueueAgentRun(
        ticketInput({ ticketContext: { category: 'hardware', categoryId: null, priority: 'low' } }),
      );
      expect(result).toEqual({ created: false, skipped: 'trigger_filter_mismatch' });
    });

    it('combined: admits when both filters match', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(
        snapshot({ triggers: triggers({ ticketCategories: ['hardware'], ticketPriorities: ['urgent'] }) }),
      );
      seedAdmissionReads();
      const result = await createAndEnqueueAgentRun(
        ticketInput({ ticketContext: { category: 'hardware', categoryId: null, priority: 'urgent' } }),
      );
      expect(result.created).toBe(true);
    });
  });
});

// P2-4 Task A6 (#4191) — the forced-shadow LIFT. `triggers.ticketAutonomousWrites`
// is the org's own explicit opt-in (see AiAgentTriggers.ticketAutonomousWrites's
// docstring and effectivePolicy.ts's org-row-only merge): a ticket-triggered
// run is admitted as `act` ONLY when both gates are open at once (agent
// `mode: 'act'` AND `triggers.ticketAutonomousWrites: true`). Any other
// combination — including the toggle set on an anomaly-triggered run — still
// forces shadow, per the truth table in the task brief.
describe('createAndEnqueueAgentRun — ticket-autonomy forced-shadow LIFT (P2-4 #4191 task A6)', () => {
  function ticketInput(over: Partial<CreateAgentRunInput> = {}): CreateAgentRunInput {
    return input({
      kind: 'helpdesk',
      triggerKind: 'ticket',
      deviceId: null,
      ticketId: TICKET_ID,
      triggerRef: { ticketId: TICKET_ID },
      dedupeKey: `ticket-created:${TICKET_ID}`,
      ...over,
    });
  }

  it('ticket + act + ticketAutonomousWrites:true -> modeAtStart is act (both gates open)', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(
      snapshot({ mode: 'act', triggers: triggers({ ticketAutonomousWrites: true }) }),
    );
    seedAdmissionReads();
    const result = await createAndEnqueueAgentRun(ticketInput());

    expect(result.created).toBe(true);
    const values = dbMockState.insertValues[0] as Record<string, unknown>;
    expect(values).toMatchObject({ triggerKind: 'ticket', modeAtStart: 'act' });
  });

  it('ticket + act WITHOUT the toggle -> modeAtStart stays shadow (only one gate open)', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(
      snapshot({ mode: 'act', triggers: triggers() }), // no ticketAutonomousWrites key at all
    );
    seedAdmissionReads();
    const result = await createAndEnqueueAgentRun(ticketInput());

    const values = dbMockState.insertValues[0] as Record<string, unknown>;
    expect(values.modeAtStart).toBe('shadow');
  });

  it('ticket + shadow + ticketAutonomousWrites:true -> modeAtStart stays shadow (only one gate open)', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(
      snapshot({ mode: 'shadow', triggers: triggers({ ticketAutonomousWrites: true }) }),
    );
    seedAdmissionReads();
    const result = await createAndEnqueueAgentRun(ticketInput());

    const values = dbMockState.insertValues[0] as Record<string, unknown>;
    expect(values.modeAtStart).toBe('shadow');
  });

  // Regression: the lift is keyed on `triggerKind === 'ticket' || input.ticketId`
  // specifically — an anomaly-triggered run must NEVER be lifted by this
  // toggle, even when both of its own inputs happen to be set. The anomaly
  // force (wave 6 PR 4, #3828) has no lift at all: an unproven detector must
  // never drive act mode, full stop.
  it('anomaly + act + ticketAutonomousWrites:true -> modeAtStart STILL shadow (anomaly force has no lift)', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(
      snapshot({
        mode: 'act',
        triggers: triggers({ anomalyEnabled: true, ticketAutonomousWrites: true }),
      }),
    );
    seedAdmissionReads();
    const result = await createAndEnqueueAgentRun(input({
      kind: 'triage',
      triggerKind: 'anomaly',
      anomalyIncidentId: ANOMALY_INCIDENT_ID,
      triggerRef: { incidentId: ANOMALY_INCIDENT_ID },
      dedupeKey: `anomaly:${ANOMALY_INCIDENT_ID}`,
    }));

    expect(result.created).toBe(true);
    const values = dbMockState.insertValues[0] as Record<string, unknown>;
    expect(values).toMatchObject({ triggerKind: 'anomaly', modeAtStart: 'shadow' });
  });
});

// Wave 6 PR 4 (#3828 Task 3) — anomaly-shadow admission. Anomaly-triggered
// runs ARE device-bound (unlike ticket runs), so device pinning, site scope,
// and maintenance-window checks apply normally; the ONLY forced downgrade is
// modeAtStart, since an unproven detector must never drive act mode.
describe('createAndEnqueueAgentRun — anomaly-triggered admission (#3828 wave-6-4 task 3)', () => {
  function anomalyInput(over: Partial<CreateAgentRunInput> = {}): CreateAgentRunInput {
    return input({
      kind: 'triage',
      triggerKind: 'anomaly',
      anomalyIncidentId: ANOMALY_INCIDENT_ID,
      triggerRef: { incidentId: ANOMALY_INCIDENT_ID },
      dedupeKey: `anomaly:${ANOMALY_INCIDENT_ID}`,
      ...over,
    });
  }

  // Wave-6-4 follow-up (#3828): the opt-in gate (2c) is dedicated coverage
  // in its own describe block below — every OTHER test in this suite is
  // about admission mechanics that assume the gate has already passed, so
  // opt in by default here rather than repeating `anomalyEnabled: true` at
  // every call site.
  function anomalyTriggers(over: Partial<AiAgentTriggers> = {}): AiAgentTriggers {
    return triggers({ anomalyEnabled: true, ...over });
  }

  it('forces modeAtStart to shadow even when the effective policy mode is act', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ mode: 'act', triggers: anomalyTriggers() }));
    seedAdmissionReads();
    const result = await createAndEnqueueAgentRun(anomalyInput());

    expect(result.created).toBe(true);
    const values = dbMockState.insertValues[0] as Record<string, unknown>;
    expect(values).toMatchObject({
      triggerKind: 'anomaly',
      deviceId: DEVICE_ID,
      anomalyIncidentId: ANOMALY_INCIDENT_ID,
      modeAtStart: 'shadow',
    });
  });

  it('persists shadow modeAtStart when the effective policy mode is already shadow', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ mode: 'shadow', triggers: anomalyTriggers() }));
    seedAdmissionReads();
    await createAndEnqueueAgentRun(anomalyInput());

    const values = dbMockState.insertValues[0] as Record<string, unknown>;
    expect(values.modeAtStart).toBe('shadow');
  });

  // Unlike a ticket run (always device-less), an anomaly run IS device-bound
  // — the opposite assertion of the ticket suite's equivalent test.
  it('DOES consult maintenance windows for an anomaly-triggered (device-bound) run', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(
      snapshot({ mode: 'act', triggers: anomalyTriggers({ respectMaintenanceWindows: true }) }),
    );
    seedAdmissionReads();
    await createAndEnqueueAgentRun(anomalyInput());
    expect(isDeviceInMaintenanceWindow).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('skips with maintenance_window when the device is in one and the agent respects them', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(
      snapshot({ mode: 'act', triggers: anomalyTriggers({ respectMaintenanceWindows: true }) }),
    );
    seedAdmissionReads();
    isDeviceInMaintenanceWindow.mockResolvedValue(true);
    const result = await createAndEnqueueAgentRun(anomalyInput());
    expect(result).toEqual({ created: false, skipped: 'maintenance_window' });
  });

  it('kill_switch_off still precedes the forced-shadow override', async () => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');
    const result = await createAndEnqueueAgentRun(anomalyInput());
    expect(result).toEqual({ created: false, skipped: 'kill_switch_off' });
    expect(resolveEffectiveAgentSystem).not.toHaveBeenCalled();
  });

  it('circuit_open still precedes the forced-shadow override', async () => {
    isCircuitOpen.mockResolvedValue(true);
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ mode: 'act' }));
    const result = await createAndEnqueueAgentRun(anomalyInput());
    expect(result).toEqual({ created: false, skipped: 'circuit_open' });
    expect(dbMockState.insertValues).toHaveLength(0);
  });

  it('a duplicate anomaly.incident_opened delivery collapses onto the same dedupe key (no second row)', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ mode: 'act', triggers: anomalyTriggers() }));
    seedAdmissionReads();
    dbMockState.insertRows = []; // ON CONFLICT DO NOTHING — the row already exists
    dbMockState.updateRows = []; // not an enqueue_failed reclaim either — genuinely a repeat

    const result = await createAndEnqueueAgentRun(anomalyInput());
    expect(result).toEqual({ created: false, skipped: 'duplicate' });
  });

  // Same posture as the ticketId guard (runLoop.loadRunContext's anomaly-
  // context branch, Task 4, is gated on run.anomalyIncidentId alone, not
  // triggerKind — see this module's caller-guard comment).
  it('rejects a request that carries anomalyIncidentId with a non-anomaly triggerKind, even for an act-mode agent', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ mode: 'act' }));

    await expect(
      createAndEnqueueAgentRun(
        input({
          triggerKind: 'alert', alertId: ALERT_ID, anomalyIncidentId: ANOMALY_INCIDENT_ID,
          dedupeKey: `alert:${ALERT_ID}`,
        }),
      ),
    ).rejects.toThrow(/anomalyIncidentId/i);

    expect(resolveEffectiveAgentSystem).not.toHaveBeenCalled();
    expect(dbMockState.insertValues).toHaveLength(0);
  });

  describe('anomaly trigger filters (#3828 wave-6-4 task 3)', () => {
    function anomalyCtx(over: Partial<AnomalyFilterContext> = {}): AnomalyFilterContext {
      return {
        anomalyType: 'cpu_spike',
        metricNames: ['cpu_percent'],
        peakScore: 5,
        siteId: null,
        deviceTags: [],
        ...over,
      };
    }

    it('admits when no anomalyContext is supplied at all (no filter to fail)', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(
        snapshot({ triggers: anomalyTriggers({ anomalyTypes: ['disk_full'] }) }),
      );
      seedAdmissionReads();
      const result = await createAndEnqueueAgentRun(anomalyInput());
      expect(result.created).toBe(true);
    });

    it('trigger_filter_mismatch when anomalyTypes is configured and the incident type does not match', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(
        snapshot({ triggers: anomalyTriggers({ anomalyTypes: ['disk_full'] }) }),
      );
      const result = await createAndEnqueueAgentRun(
        anomalyInput({ anomalyContext: anomalyCtx() }),
      );
      expect(result).toEqual({ created: false, skipped: 'trigger_filter_mismatch' });
    });

    it('admits when anomalyTypes matches the incident type', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(
        snapshot({ triggers: anomalyTriggers({ anomalyTypes: ['cpu_spike'] }) }),
      );
      seedAdmissionReads();
      const result = await createAndEnqueueAgentRun(
        anomalyInput({ anomalyContext: anomalyCtx() }),
      );
      expect(result.created).toBe(true);
    });

    it('trigger_filter_mismatch when minAnomalyScore is configured above the incident peakScore', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(
        snapshot({ triggers: anomalyTriggers({ minAnomalyScore: 9 }) }),
      );
      const result = await createAndEnqueueAgentRun(
        anomalyInput({ anomalyContext: anomalyCtx({ peakScore: 5 }) }),
      );
      expect(result).toEqual({ created: false, skipped: 'trigger_filter_mismatch' });
    });

    it('admits when minAnomalyScore is at or below the incident peakScore', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(
        snapshot({ triggers: anomalyTriggers({ minAnomalyScore: 5 }) }),
      );
      seedAdmissionReads();
      const result = await createAndEnqueueAgentRun(
        anomalyInput({ anomalyContext: anomalyCtx({ peakScore: 5 }) }),
      );
      expect(result.created).toBe(true);
    });
  });

  // Wave-6-4 follow-up (#3828) — the conservative per-agent opt-in gate
  // itself (admission step 2c). Distinct from the "anomaly trigger filters"
  // suite above: this gate fires on `triggerKind === 'anomaly'` alone,
  // BEFORE (and regardless of) whether an `anomalyContext` is even supplied
  // — see runService.ts's step-2c comment.
  describe('anomaly trigger opt-in gate (wave-6-4 follow-up, #3828)', () => {
    it('skips trigger_filter_mismatch when anomalyEnabled is absent (conservative default)', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ triggers: triggers() }));
      const result = await createAndEnqueueAgentRun(anomalyInput());
      expect(result).toEqual({ created: false, skipped: 'trigger_filter_mismatch' });
      expect(dbMockState.insertValues).toHaveLength(0);
    });

    it('skips trigger_filter_mismatch when anomalyEnabled is explicitly false', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(
        snapshot({ triggers: triggers({ anomalyEnabled: false }) }),
      );
      const result = await createAndEnqueueAgentRun(anomalyInput());
      expect(result).toEqual({ created: false, skipped: 'trigger_filter_mismatch' });
    });

    it('proceeds past the gate (and into narrowing filters) when anomalyEnabled is true', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ triggers: anomalyTriggers() }));
      seedAdmissionReads();
      const result = await createAndEnqueueAgentRun(anomalyInput());
      expect(result.created).toBe(true);
    });

    it('fires even when no anomalyContext is supplied — NOT conditioned on the narrowing-filter context', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ triggers: triggers() }));
      // No anomalyContext on this input — the narrowing-filter branch (step
      // 3c) would never even call evaluateAnomalyTriggerFilters, so this
      // proves the opt-in gate does not depend on that branch running.
      const result = await createAndEnqueueAgentRun(anomalyInput());
      expect(result).toEqual({ created: false, skipped: 'trigger_filter_mismatch' });
    });

    it('does not gate a non-anomaly trigger kind (alert admission unaffected by anomalyEnabled being unset)', async () => {
      resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ triggers: triggers() }));
      seedAdmissionReads();
      const result = await createAndEnqueueAgentRun(
        input({ triggerKind: 'alert', alertId: ALERT_ID, dedupeKey: `alert:${ALERT_ID}` }),
      );
      expect(result.created).toBe(true);
    });
  });
});

// #3828 branch-review blocker 3: this PR is the first time two trigger kinds
// can share an (org_id, dedupe_key) — metricAnomalySubscriber deliberately
// cross-dedupes onto `alert:<linkedAlertId>` when an anomaly's sibling has a
// linked alert. When the incumbent row at that key is
// status='failed' AND error_code='enqueue_failed', the reclaim UPDATE
// re-SETs triggerKind/triggerRef/modeAtStart/policySnapshot — all columns
// ai_agent_runs_immutable_guard() DISTINCT-FROM checks — so an UNGUARDED
// cross-kind reclaim always raises 23000 (integrity_constraint_violation)
// against a genuinely different trigger's row. The fix scopes the reclaim's
// WHERE to `trigger_kind = <this admission's triggerKind>` so a cross-kind
// collision can never match and falls through to `skip('duplicate')` instead
// of attempting (and failing) the mutation.
describe('createAndEnqueueAgentRun — cross-kind enqueue_failed reclaim guard (#3828 branch-review blocker 3)', () => {
  it('an anomaly admission colliding with an alert-kind enqueue_failed row at the same key reports duplicate, not a reclaim', async () => {
    // Wave-6-4 follow-up (#3828): this admission must clear the anomaly
    // opt-in gate to reach the insert/dedupe step this test is actually
    // about — the suite's default snapshot() (beforeEach) does not opt in.
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({ triggers: triggers({ anomalyEnabled: true }) }));
    seedAdmissionReads();
    const dedupeKey = `alert:${ALERT_ID}`;
    // The insert loses the unique race: an alert-triggered row already holds
    // this key (this is exactly the cross-dedupe metricAnomalySubscriber
    // deliberately creates for a promoted anomaly).
    dbMockState.insertRows = [];
    // The CAS is scoped to this admission's own triggerKind ('anomaly'), so
    // it cannot match the incumbent alert-kind row — the reclaim UPDATE
    // affects zero rows.
    dbMockState.updateRows = [];

    const result = await createAndEnqueueAgentRun(
      input({
        triggerKind: 'anomaly',
        anomalyIncidentId: ANOMALY_INCIDENT_ID,
        triggerRef: { incidentId: ANOMALY_INCIDENT_ID },
        dedupeKey,
      }),
    );

    expect(result).toEqual({ created: false, skipped: 'duplicate' });
    expect(enqueueAgentRunJob).not.toHaveBeenCalled();

    // The reclaim WHERE must scope on trigger_kind — without it, this same
    // scenario against a REAL database updates the alert-kind row's
    // trigger_kind to 'anomaly' and immediately trips the immutable guard.
    const where = compiled(dbMockState.updateWheres.at(-1) as SQL);
    expect(where).toContain('"trigger_kind"');
  });

  it('an alert admission colliding with an anomaly-kind enqueue_failed row at the same key reports duplicate, not a reclaim', async () => {
    seedAdmissionReads();
    const dedupeKey = `alert:${ALERT_ID}`;
    // The incumbent row at this key is the anomaly-triggered run whose
    // cross-dedupe collapsed onto the alert's key.
    dbMockState.insertRows = [];
    dbMockState.updateRows = [];

    const result = await createAndEnqueueAgentRun(
      input({
        triggerKind: 'alert',
        alertId: ALERT_ID,
        dedupeKey,
      }),
    );

    expect(result).toEqual({ created: false, skipped: 'duplicate' });
    expect(enqueueAgentRunJob).not.toHaveBeenCalled();

    const where = compiled(dbMockState.updateWheres.at(-1) as SQL);
    expect(where).toContain('"trigger_kind"');
  });

  it('a SAME-kind enqueue_failed reclaim still succeeds (regression: the trigger_kind predicate must not block legitimate same-kind retries)', async () => {
    seedAdmissionReads();
    dbMockState.insertRows = [];
    dbMockState.updateRows = [{ id: RUN_ID, orgId: ORG_ID, status: 'queued', deviceId: DEVICE_ID }];

    const result = await createAndEnqueueAgentRun(
      input({ triggerKind: 'alert', alertId: ALERT_ID, dedupeKey: `alert:${ALERT_ID}` }),
    );

    expect(result).toMatchObject({ created: true });
    expect(enqueueAgentRunJob).toHaveBeenCalledWith(RUN_ID);
    const where = compiled(dbMockState.updateWheres.at(-1) as SQL);
    expect(where).toContain('"trigger_kind"');
  });
});

describe('transitionRunStatus', () => {
  it('returns true and applies the patch when the CAS matches', async () => {
    dbMockState.updateRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, errorCode: null, outcome: {} }];
    const moved = await transitionRunStatus(RUN_ID, 'queued', 'running', { turnCount: 3 });
    expect(moved).toBe(true);
    expect(dbMockState.updateSets[0]).toMatchObject({ status: 'running', turnCount: 3 });
    // 'running' is non-terminal — no circuit bookkeeping at all.
    expect(recordRunTerminal).not.toHaveBeenCalled();
  });

  it('returns false when the from-status does not match (lost the race)', async () => {
    dbMockState.updateRows = [];
    expect(await transitionRunStatus(RUN_ID, 'queued', 'running')).toBe(false);
    expect(recordRunTerminal).not.toHaveBeenCalled();
  });

  it('accepts a list of acceptable from-statuses', async () => {
    dbMockState.updateRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, errorCode: 'run_failed', outcome: {} }];
    expect(await transitionRunStatus(RUN_ID, ['queued', 'running'], 'failed')).toBe(true);
    const sql = dialect.sqlToQuery(dbMockState.updateWheres[0] as SQL).sql;
    expect(sql).toContain('"status"');
  });

  // Wave 6 PR 2 (#3828): this IS the terminalization chokepoint —
  // recordRunTerminal-wiring coverage lives here; the classification/threshold
  // logic itself is agentCircuit.test.ts's job.
  describe('circuit bookkeeping wiring', () => {
    it('calls recordRunTerminal with the row identity + to + errorCode when the transition is terminal', async () => {
      dbMockState.updateRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, errorCode: 'sdk_error', outcome: {}, profile: 'full' }];
      await transitionRunStatus(RUN_ID, 'running', 'failed', { errorCode: 'sdk_error' });
      expect(recordRunTerminal).toHaveBeenCalledWith(
        { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile: 'full' },
        'failed',
        'sdk_error',
        null,
      );
    });

    it('extracts needs_attention from outcome.runVerdict for a completed transition', async () => {
      dbMockState.updateRows = [{
        id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, errorCode: null,
        outcome: { runVerdict: 'needs_attention' }, profile: 'full',
      }];
      await transitionRunStatus(RUN_ID, 'running', 'completed', {});
      expect(recordRunTerminal).toHaveBeenCalledWith(
        { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile: 'full' },
        'completed',
        null,
        'needs_attention',
      );
    });

    it('passes null runVerdict for any other outcome.runVerdict value', async () => {
      dbMockState.updateRows = [{
        id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, errorCode: null,
        outcome: { runVerdict: 'remediated' }, profile: 'full',
      }];
      await transitionRunStatus(RUN_ID, 'running', 'completed', {});
      expect(recordRunTerminal).toHaveBeenCalledWith(
        { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile: 'full' },
        'completed',
        null,
        null,
      );
    });

    it('does not call recordRunTerminal when the CAS is lost', async () => {
      dbMockState.updateRows = [];
      await transitionRunStatus(RUN_ID, 'running', 'failed', { errorCode: 'sdk_error' });
      expect(recordRunTerminal).not.toHaveBeenCalled();
    });

    it('a recordRunTerminal throw is swallowed — the transition itself still reports success', async () => {
      dbMockState.updateRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, errorCode: 'sdk_error', outcome: {} }];
      recordRunTerminal.mockRejectedValueOnce(new Error('circuit accounting boom'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const moved = await transitionRunStatus(RUN_ID, 'running', 'failed', { errorCode: 'sdk_error' });

      expect(moved).toBe(true);
    });
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
    // Wave 6 PR 2 (#3828): reapStalledAgentRuns now SELECTs candidates, then
    // CAS-es each one through `transitionRunStatus` — no more one bulk UPDATE.
    seedAdmissionReads({ staleCandidates: [{ id: RUN_ID, sessionId: null }] });
    dbMockState.updateRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, errorCode: 'stalled', outcome: {}, profile: 'full' }];

    await createAndEnqueueAgentRun(input());

    // A SIGKILLed replica leaves a `running` row that BullMQ's redelivery
    // cannot clear (the queued->running CAS fails, the job completes), so with
    // maxConcurrentRuns=1 the org is refused forever until this sweep exists.
    const reap = dbMockState.updateSets[0]!;
    expect(reap).toMatchObject({ status: 'failed', errorCode: 'stalled' });
    expect(reap.finishedAt).toBeInstanceOf(Date);

    // The stale-cutoff clause is on the candidate SELECT...
    const candidateSelect = dbMockState.selects.find((s) => s.table === 'ai_agent_runs' && s.where);
    const where = compiled(candidateSelect?.where);
    expect(where).toContain('"agent_id"');
    expect(where).toContain('"org_id"');
    expect(where).toContain('"status"');
    // Age is measured from started_at, falling back to queued_at for a run
    // whose job never reached a worker at all.
    expect(where).toContain('"started_at"');
    expect(where).toContain('"queued_at"');
    expect(where).toContain('is null');

    // ...AND it is passed back in as the per-row CAS's guard, so the update
    // is not id+status alone. Without this, a worker that legitimately
    // claimed the candidate (queued->running) between the SELECT above and
    // this CAS would still match id+status and get wrongly failed as
    // 'stalled' — the guard re-checks the SAME cutoff atomically with the
    // write, restoring the atomicity the old single bulk UPDATE had.
    const updateWhere = compiled(dbMockState.updateWheres[0] as SQL);
    expect(updateWhere).toContain('"started_at"');
    expect(updateWhere).toContain('"queued_at"');

    // ...and the candidate select happens before the cooldown/concurrency
    // reads (it is itself the FIRST select:ai_agent_runs).
    expect(dbMockState.calls.indexOf('select:ai_agent_runs'))
      .toBeLessThan(dbMockState.calls.indexOf('update:failed'));
    expect(dbMockState.calls.indexOf('update:failed'))
      .toBeLessThan(dbMockState.calls.lastIndexOf('select:ai_agent_runs'));

    // Terminalization routes through the one chokepoint even for a reap.
    expect(recordRunTerminal).toHaveBeenCalledWith(
      { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile: 'full' },
      'failed',
      'stalled',
      null,
    );
  });

  it('reapStalledAgentRuns returns no ids and does no UPDATE when there are no stale candidates', async () => {
    dbMockState.rowQueues.ai_agent_runs = [[]];
    await expect(reapStalledAgentRuns({ agentId: AGENT_ID, orgId: ORG_ID })).resolves.toEqual([]);
    expect(dbMockState.updateSets).toHaveLength(0);
  });

  it('reapStalledAgentRuns returns the ids it failed', async () => {
    dbMockState.rowQueues.ai_agent_runs = [[{ id: RUN_ID, sessionId: null }]];
    dbMockState.updateRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, errorCode: 'stalled', outcome: {} }];
    await expect(reapStalledAgentRuns({ agentId: AGENT_ID, orgId: ORG_ID })).resolves.toEqual([RUN_ID]);
  });

  it('reapStalledAgentRuns skips a candidate that lost the CAS (already moved on)', async () => {
    // The row genuinely finished (or was cancelled) between the candidate
    // select and the per-row transition — the CAS's id+status guard alone
    // already excludes this case; the mock's blanket empty `updateRows`
    // stands in for "the row is no longer in ['queued','running']".
    dbMockState.rowQueues.ai_agent_runs = [[{ id: RUN_ID, sessionId: 'session-1' }]];
    dbMockState.updateRows = [];
    await expect(reapStalledAgentRuns({ agentId: AGENT_ID, orgId: ORG_ID })).resolves.toEqual([]);
    expect(reconcileHungExecutions).not.toHaveBeenCalled();
    expect(closeAgentRunSession).not.toHaveBeenCalled();
  });

  it('reapStalledAgentRuns does NOT fail a candidate a worker legitimately started between the SELECT and the CAS', async () => {
    // TOCTOU regression (review fix, #3828): the loop is sequential and
    // workers never take the reaper's advisory lock, so a candidate can
    // legitimately transition queued->running (startedAt=now, no longer
    // stale) between the candidate SELECT and this row's CAS. An id+status
    // guard alone would still match ('running' is a valid `from` status) and
    // wrongly fail a run a worker is actively executing. The `stale` guard
    // passed into `transitionRunStatus` re-checks the cutoff atomically with
    // the write, so `dbMockState.updateRows = []` here stands in for "the row
    // no longer satisfies the guard" — the mock's update builder does not
    // itself evaluate the WHERE clause, so the compiled-SQL assertion above
    // is what actually proves the guard is wired; this asserts the CALLER
    // handles a guard-losing CAS the same as any other lost CAS.
    dbMockState.rowQueues.ai_agent_runs = [[{ id: RUN_ID, sessionId: null }]];
    dbMockState.updateRows = [];

    const result = await reapStalledAgentRuns({ agentId: AGENT_ID, orgId: ORG_ID });

    expect(result).toEqual([]);
    const updateWhere = compiled(dbMockState.updateWheres[0] as SQL);
    // The guard clause is present on the CAS regardless of whether it wins —
    // this is what makes the outcome above atomic rather than TOCTOU.
    expect(updateWhere).toContain('"started_at"');
    expect(updateWhere).toContain('"queued_at"');
    expect(reconcileHungExecutions).not.toHaveBeenCalled();
    expect(closeAgentRunSession).not.toHaveBeenCalled();
  });

  it('reapStalledAgentRuns repairs the execution ledger for a reaped run that has a session', async () => {
    // A SIGKILLed worker predates the ledger entirely: nothing in the
    // in-process runLoop.ts cleanup ever ran for this run, so the reap itself
    // has to reconcile the hung ai_tool_executions rows and close ai_sessions.
    dbMockState.rowQueues.ai_agent_runs = [[{ id: RUN_ID, sessionId: 'session-1' }]];
    dbMockState.updateRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, errorCode: 'stalled', outcome: {} }];
    reconcileHungExecutions.mockResolvedValue(2);
    closeAgentRunSession.mockResolvedValue(undefined);

    await expect(reapStalledAgentRuns({ agentId: AGENT_ID, orgId: ORG_ID })).resolves.toEqual([RUN_ID]);

    expect(reconcileHungExecutions).toHaveBeenCalledWith('session-1');
    expect(closeAgentRunSession).toHaveBeenCalledWith('session-1', 'failed');
  });

  it('reapStalledAgentRuns skips ledger cleanup for a reaped run with no session', async () => {
    dbMockState.rowQueues.ai_agent_runs = [[{ id: RUN_ID, sessionId: null }]];
    dbMockState.updateRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, errorCode: 'stalled', outcome: {} }];

    await expect(reapStalledAgentRuns({ agentId: AGENT_ID, orgId: ORG_ID })).resolves.toEqual([RUN_ID]);

    expect(reconcileHungExecutions).not.toHaveBeenCalled();
    expect(closeAgentRunSession).not.toHaveBeenCalled();
  });

  it('reapStalledAgentRuns tolerates a ledger cleanup failure — the reap result is unaffected', async () => {
    dbMockState.rowQueues.ai_agent_runs = [[{ id: RUN_ID, sessionId: 'session-1' }]];
    dbMockState.updateRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, errorCode: 'stalled', outcome: {} }];
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

describe('createAndEnqueueAgentRun verdict-profile admission (P2-1)', () => {
  /**
   * Verdict-profile runs skip the cooldown probe entirely (step 5 wraps in
   * `profile === 'full'`), so the seeded ai_agent_runs queue drops
   * seedAdmissionReads' cooldown slot: [reap, concurrency, per-hour, daily
   * spend]. If admission still probed cooldown for a verdict run, the
   * concurrency-count row seeded here (a non-empty array) would be misread as
   * a cooldown "recent run" hit and wrongly skip('cooldown').
   */
  function seedVerdictAdmissionReads(options: {
    concurrent?: number;
    perHour?: number;
    dailyCents?: number | null;
  } = {}): void {
    const { concurrent = 0, perHour = 0, dailyCents = 0 } = options;
    seedAdmissionReads({ concurrent, perHour, dailyCents });
    dbMockState.rowQueues.ai_agent_runs = [
      [], // 4c reap candidates
      [{ value: concurrent }], // 6b concurrency
      [{ value: perHour }], // 6b per-hour
      [{ totalCostCents: dailyCents }], // 7 daily spend
    ];
  }

  it('max_concurrent_verdict_runs when queued+running verdict runs reach the verdict-only cap', async () => {
    seedVerdictAdmissionReads({ concurrent: AI_AGENT_LIMIT_DEFAULTS.maxConcurrentVerdictRuns });
    const result = await createAndEnqueueAgentRun(
      input({ profile: 'verdict', dedupeKey: 'alert-verdict:a1' }),
    );
    expect(result).toEqual({ created: false, skipped: 'max_concurrent_verdict_runs' });
  });

  it('never counts a verdict run against maxConcurrentRuns — the verdict cap is scoped and counted independently', async () => {
    // maxConcurrentRuns (default 1) would already refuse a FULL run; the
    // verdict-only count is 0, so a verdict run is still admitted, and the
    // concurrency SELECT itself is scoped by profile (not merely a
    // coincidentally low seeded value).
    seedVerdictAdmissionReads({ concurrent: 0 });
    const result = await createAndEnqueueAgentRun(
      input({ profile: 'verdict', dedupeKey: 'alert-verdict:a2' }),
    );
    expect(result).toMatchObject({ created: true });
    const runSelects = dbMockState.selects.filter((s) => s.table === 'ai_agent_runs');
    // [0] reap, [1] concurrency, [2] per-hour — no cooldown probe for verdict.
    expect(compiled(runSelects[1]?.where)).toContain('"profile"');
  });

  it('admits a verdict run whose concurrency count sits strictly between the full cap (1) and the verdict cap (4)', async () => {
    // A regression that hard-coded maxConcurrentForProfile to
    // effective.limits.maxConcurrentRuns for BOTH profiles would refuse this
    // (2 >= 1), even though the skip-REASON ternary is untouched by that bug
    // and would still report 'max_concurrent_verdict_runs' correctly — the
    // other 8 tests only pin the reason, not the magnitude. Reading the real
    // verdict cap (4) is what admits it.
    seedVerdictAdmissionReads({ concurrent: 2 });
    const result = await createAndEnqueueAgentRun(
      input({ profile: 'verdict', dedupeKey: 'alert-verdict:a6' }),
    );
    expect(result).toMatchObject({ created: true });
  });

  it('rate-limits verdict-profile runs on maxVerdictRunsPerHour with skip verdict_rate', async () => {
    seedVerdictAdmissionReads({ perHour: AI_AGENT_LIMIT_DEFAULTS.maxVerdictRunsPerHour });
    const result = await createAndEnqueueAgentRun(
      input({ profile: 'verdict', dedupeKey: 'alert-verdict:a3' }),
    );
    expect(result).toEqual({ created: false, skipped: 'verdict_rate' });
  });

  it('admits a verdict run whose hourly count sits strictly between the full cap (20) and the verdict cap (200)', async () => {
    // Same discrimination gap as the concurrency test above, for the
    // per-hour cap: a hard-coded maxRunsPerHour for both profiles would
    // refuse this (50 >= 20) even though the skip-reason ternary alone would
    // still report 'verdict_rate'.
    seedVerdictAdmissionReads({ perHour: 50 });
    const result = await createAndEnqueueAgentRun(
      input({ profile: 'verdict', dedupeKey: 'alert-verdict:a7' }),
    );
    expect(result).toMatchObject({ created: true });
  });

  it('skips the cooldown step entirely for a verdict run, even with cooldownSeconds > 0', async () => {
    // Default snapshot() carries cooldownSeconds: 900 — proves the guard is
    // keyed on profile, not on cooldownSeconds being zero.
    seedVerdictAdmissionReads({ concurrent: 0, perHour: 0, dailyCents: 0 });
    const result = await createAndEnqueueAgentRun(
      input({ profile: 'verdict', dedupeKey: 'alert-verdict:a4' }),
    );
    expect(result).toMatchObject({ created: true });
  });

  it('a full run is not blocked by concurrent verdict runs — the full cap is scoped by profile too', async () => {
    // The real concurrency/per-hour counts would exclude verdict rows via the
    // profile-scoped WHERE; seeded as 0 to represent that. The SQL assertions
    // prove the scoping is actually applied, not merely a coincidental value.
    seedAdmissionReads({ concurrent: 0 });
    const result = await createAndEnqueueAgentRun(input());
    expect(result).toMatchObject({ created: true });
    const runSelects = dbMockState.selects.filter((s) => s.table === 'ai_agent_runs');
    // [0] reap, [1] cooldown, [2] concurrency, [3] per-hour, [4] daily spend
    expect(compiled(runSelects[2]?.where)).toContain('"profile"');
    expect(compiled(runSelects[3]?.where)).toContain('"profile"');
  });

  it('writes profile and correlation_group_id on the run row for a verdict run', async () => {
    seedVerdictAdmissionReads();
    await createAndEnqueueAgentRun(
      input({
        profile: 'verdict',
        dedupeKey: 'group-verdict:g1',
        correlationGroupId: 'correlation-group-1',
      }),
    );
    const values = dbMockState.insertValues[0] as Record<string, unknown>;
    expect(values).toMatchObject({ profile: 'verdict', correlationGroupId: 'correlation-group-1' });
  });

  it('defaults profile to full and correlation_group_id to null when omitted', async () => {
    seedAdmissionReads();
    await createAndEnqueueAgentRun(input());
    const values = dbMockState.insertValues[0] as Record<string, unknown>;
    expect(values).toMatchObject({ profile: 'full', correlationGroupId: null });
  });

  it('does not publish max_concurrent_verdict_runs or verdict_rate — logged only, volume guards not policy events', async () => {
    seedVerdictAdmissionReads({ concurrent: AI_AGENT_LIMIT_DEFAULTS.maxConcurrentVerdictRuns });
    await createAndEnqueueAgentRun(
      input({ profile: 'verdict', dedupeKey: 'alert-verdict:a5' }),
    );
    expect(publishEvent).not.toHaveBeenCalled();
  });
});

describe('createAndEnqueueAgentRun sweep-profile admission (P2-2)', () => {
  /**
   * Sweep-profile runs skip the cooldown probe entirely (step 5 wraps in
   * `profile === 'full'`), same as verdict — see
   * `seedVerdictAdmissionReads`' docstring above for why this seeds only
   * [reap, concurrency, per-hour, daily spend] rather than reusing
   * `seedAdmissionReads`' 5-slot cooldown-inclusive queue.
   */
  function seedSweepAdmissionReads(options: {
    concurrent?: number;
    perHour?: number;
    dailyCents?: number | null;
  } = {}): void {
    const { concurrent = 0, perHour = 0, dailyCents = 0 } = options;
    seedAdmissionReads({ concurrent, perHour, dailyCents, deviceInOrg: true });
    dbMockState.rowQueues.ai_agent_runs = [
      [], // 4c reap candidates
      [{ value: concurrent }], // 6b concurrency
      [{ value: perHour }], // 6b per-hour
      [{ totalCostCents: dailyCents }], // 7 daily spend
    ];
  }

  it('max_concurrent_sweep_runs when queued+running sweep runs reach the sweep-only cap', async () => {
    seedSweepAdmissionReads({ concurrent: AI_AGENT_LIMIT_DEFAULTS.maxConcurrentSweepRuns });
    const result = await createAndEnqueueAgentRun(
      input({ profile: 'sweep', deviceId: null, dedupeKey: 'sweep:s1' }),
    );
    expect(result).toEqual({ created: false, skipped: 'max_concurrent_sweep_runs' });
  });

  it('a sweep run is not blocked by 5 queued full runs — the sweep cap is scoped and counted independently', async () => {
    // The real concurrency count is profile-scoped and excludes full rows
    // entirely, so 5 queued full runs (which would already saturate the
    // default maxConcurrentRuns: 1) have zero effect on the sweep count.
    seedSweepAdmissionReads({ concurrent: 0 });
    const result = await createAndEnqueueAgentRun(
      input({ profile: 'sweep', deviceId: null, dedupeKey: 'sweep:s2' }),
    );
    expect(result).toMatchObject({ created: true });
    const runSelects = dbMockState.selects.filter((s) => s.table === 'ai_agent_runs');
    // [0] reap, [1] concurrency, [2] per-hour — no cooldown probe for sweep.
    expect(compiled(runSelects[1]?.where)).toContain('"profile"');
  });

  it('rate-limits sweep-profile runs on maxSweepRunsPerHour with skip sweep_rate', async () => {
    seedSweepAdmissionReads({ perHour: AI_AGENT_LIMIT_DEFAULTS.maxSweepRunsPerHour });
    const result = await createAndEnqueueAgentRun(
      input({ profile: 'sweep', deviceId: null, dedupeKey: 'sweep:s3' }),
    );
    expect(result).toEqual({ created: false, skipped: 'sweep_rate' });
  });

  it('skips the cooldown step entirely for a sweep run queued 1s after another device-less run, even with cooldownSeconds > 0', async () => {
    // Default snapshot() carries cooldownSeconds: 900. If step 5's
    // `profile === 'full'` guard ever regressed to also cover 'sweep', this
    // would probe a cooldown SELECT this queue never seeded — the mock's
    // `nextRows` throws "No queued rows for table ai_agent_runs" and the
    // test fails, rather than silently misreading an unrelated row.
    seedSweepAdmissionReads({ concurrent: 0, perHour: 0, dailyCents: 0 });
    const result = await createAndEnqueueAgentRun(
      input({ profile: 'sweep', deviceId: null, dedupeKey: 'sweep:s4' }),
    );
    expect(result).toMatchObject({ created: true });
  });

  it('a full run is not blocked by concurrent sweep runs — the full cap is scoped by profile too', async () => {
    seedAdmissionReads({ concurrent: 0 });
    const result = await createAndEnqueueAgentRun(input());
    expect(result).toMatchObject({ created: true });
    const runSelects = dbMockState.selects.filter((s) => s.table === 'ai_agent_runs');
    // [0] reap, [1] cooldown, [2] concurrency, [3] per-hour, [4] daily spend
    expect(compiled(runSelects[2]?.where)).toContain('"profile"');
    expect(compiled(runSelects[3]?.where)).toContain('"profile"');
  });

  it('writes scheduleId on the run row when the trigger is a schedule', async () => {
    seedSweepAdmissionReads();
    await createAndEnqueueAgentRun(
      input({ profile: 'sweep', deviceId: null, dedupeKey: 'sweep:s5', scheduleId: SCHEDULE_ID }),
    );
    const values = dbMockState.insertValues[0] as Record<string, unknown>;
    expect(values).toMatchObject({ profile: 'sweep', scheduleId: SCHEDULE_ID });
  });

  it('defaults scheduleId to null when omitted', async () => {
    seedAdmissionReads();
    await createAndEnqueueAgentRun(input());
    const values = dbMockState.insertValues[0] as Record<string, unknown>;
    expect(values).toMatchObject({ scheduleId: null });
  });

  it('does not publish max_concurrent_sweep_runs or sweep_rate — logged only, volume guards not policy events', async () => {
    seedSweepAdmissionReads({ concurrent: AI_AGENT_LIMIT_DEFAULTS.maxConcurrentSweepRuns });
    await createAndEnqueueAgentRun(
      input({ profile: 'sweep', deviceId: null, dedupeKey: 'sweep:s6' }),
    );
    expect(publishEvent).not.toHaveBeenCalled();
  });
});

describe('createAndEnqueueAgentRun narrative-profile admission (P2-3)', () => {
  /**
   * Narrative-profile runs skip the cooldown probe entirely (step 5 wraps in
   * `profile === 'full'`), same as verdict and sweep — so this seeds only
   * [reap, concurrency, per-hour, daily spend], NOT `seedAdmissionReads`'
   * 5-slot cooldown-inclusive queue. See `seedVerdictAdmissionReads`'
   * docstring for the full rationale.
   */
  function seedNarrativeAdmissionReads(options: {
    concurrent?: number;
    perHour?: number;
    dailyCents?: number | null;
  } = {}): void {
    const { concurrent = 0, perHour = 0, dailyCents = 0 } = options;
    seedAdmissionReads({ concurrent, perHour, dailyCents, deviceInOrg: true });
    dbMockState.rowQueues.ai_agent_runs = [
      [], // 4c reap candidates
      [{ value: concurrent }], // 6b concurrency
      [{ value: perHour }], // 6b per-hour
      [{ totalCostCents: dailyCents }], // 7 daily spend
    ];
  }

  it('max_concurrent_narrative_runs when queued+running narrative runs reach the narrative-only cap', async () => {
    seedNarrativeAdmissionReads({ concurrent: AI_AGENT_LIMIT_DEFAULTS.maxConcurrentNarrativeRuns });
    const result = await createAndEnqueueAgentRun(
      input({ profile: 'narrative', deviceId: null, dedupeKey: 'narrative:n1' }),
    );
    expect(result).toEqual({ created: false, skipped: 'max_concurrent_narrative_runs' });
  });

  it('rate-limits narrative-profile runs on maxNarrativeRunsPerHour with skip narrative_rate', async () => {
    seedNarrativeAdmissionReads({ perHour: AI_AGENT_LIMIT_DEFAULTS.maxNarrativeRunsPerHour });
    const result = await createAndEnqueueAgentRun(
      input({ profile: 'narrative', deviceId: null, dedupeKey: 'narrative:n2' }),
    );
    expect(result).toEqual({ created: false, skipped: 'narrative_rate' });
  });

  it('a narrative run is not blocked by saturated full/verdict/sweep counts — its counters are its own', async () => {
    // The real concurrency/rate counts are profile-scoped, so rows of any
    // OTHER profile are excluded from both SELECTs entirely. The seeded
    // counts below are therefore the narrative-only counts, and 0 admits.
    seedNarrativeAdmissionReads({ concurrent: 0, perHour: 0 });
    const result = await createAndEnqueueAgentRun(
      input({ profile: 'narrative', deviceId: null, dedupeKey: 'narrative:n3' }),
    );
    expect(result).toMatchObject({ created: true });
    const runSelects = dbMockState.selects.filter((s) => s.table === 'ai_agent_runs');
    // [0] reap, [1] concurrency, [2] per-hour — no cooldown probe for narrative.
    expect(compiled(runSelects[1]?.where)).toContain('"profile"');
    expect(compiled(runSelects[2]?.where)).toContain('"profile"');
  });

  it('narrative and sweep caps are distinct values, so one cannot starve the other', () => {
    // A regression guard on the caps themselves rather than the SELECTs: if
    // profileCaps' narrative arm were ever copy-pasted to read the sweep
    // fields, the two would silently share one budget.
    expect(AI_AGENT_LIMIT_DEFAULTS.maxConcurrentNarrativeRuns)
      .not.toBe(AI_AGENT_LIMIT_DEFAULTS.maxConcurrentSweepRuns);
    expect(AI_AGENT_LIMIT_DEFAULTS.maxNarrativeRunsPerHour)
      .not.toBe(AI_AGENT_LIMIT_DEFAULTS.maxSweepRunsPerHour);
  });

  it('reads the caps off the SNAPSHOT, not a hard-coded default', async () => {
    // The concurrent/per-hour counts seeded here both EXCEED the v7 defaults
    // (1 and 5), so this only admits if profileCaps actually read the
    // policy's own raised caps.
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({
      limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxConcurrentNarrativeRuns: 3, maxNarrativeRunsPerHour: 20 },
    }));
    seedNarrativeAdmissionReads({ concurrent: 2, perHour: 9 });
    const result = await createAndEnqueueAgentRun(
      input({ profile: 'narrative', deviceId: null, dedupeKey: 'narrative:n4' }),
    );
    expect(result).toMatchObject({ created: true });
  });

  it('falls back to the v7 defaults on a pre-v7 snapshot with no narrative caps at all', async () => {
    // A policy snapshot resolved before the v7 limits bump carries neither
    // field. Without the `?? AI_AGENT_LIMIT_DEFAULTS...` tolerant read the
    // comparison would be `>= undefined` (always false) and the cap would
    // silently not exist.
    const { maxConcurrentNarrativeRuns: _c, maxNarrativeRunsPerHour: _h, ...preV7 } =
      AI_AGENT_LIMIT_DEFAULTS;
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot({
      limits: preV7 as typeof AI_AGENT_LIMIT_DEFAULTS,
    }));
    seedNarrativeAdmissionReads({ concurrent: AI_AGENT_LIMIT_DEFAULTS.maxConcurrentNarrativeRuns });
    const result = await createAndEnqueueAgentRun(
      input({ profile: 'narrative', deviceId: null, dedupeKey: 'narrative:n8' }),
    );
    expect(result).toEqual({ created: false, skipped: 'max_concurrent_narrative_runs' });
  });

  it('skips the cooldown step entirely for a narrative run, even with cooldownSeconds > 0', async () => {
    // Default snapshot() carries cooldownSeconds: 900. If step 5's
    // `profile === 'full'` guard ever regressed to also cover 'narrative',
    // this would probe a cooldown SELECT this queue never seeded — the
    // mock's `nextRows` throws "No queued rows for table ai_agent_runs".
    seedNarrativeAdmissionReads({ concurrent: 0, perHour: 0, dailyCents: 0 });
    const result = await createAndEnqueueAgentRun(
      input({ profile: 'narrative', deviceId: null, dedupeKey: 'narrative:n5' }),
    );
    expect(result).toMatchObject({ created: true });
  });

  it('writes profile=narrative and the scheduleId on the run row', async () => {
    seedNarrativeAdmissionReads();
    await createAndEnqueueAgentRun(
      input({ profile: 'narrative', deviceId: null, dedupeKey: 'narrative:n6', scheduleId: SCHEDULE_ID }),
    );
    const values = dbMockState.insertValues[0] as Record<string, unknown>;
    expect(values).toMatchObject({ profile: 'narrative', scheduleId: SCHEDULE_ID });
  });

  it('does not publish max_concurrent_narrative_runs or narrative_rate — logged only, volume guards not policy events', async () => {
    seedNarrativeAdmissionReads({ concurrent: AI_AGENT_LIMIT_DEFAULTS.maxConcurrentNarrativeRuns });
    await createAndEnqueueAgentRun(
      input({ profile: 'narrative', deviceId: null, dedupeKey: 'narrative:n7' }),
    );
    expect(publishEvent).not.toHaveBeenCalled();
  });
});
