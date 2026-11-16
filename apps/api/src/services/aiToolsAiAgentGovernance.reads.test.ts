import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./aiAgents/agentService', () => ({ listAgents: vi.fn() }));
vi.mock('./aiAgents/supervisedKeyGrant', () => ({ authorizeSupervisedKey: vi.fn(), SupervisedKeyGrantError: class extends Error {} }));
vi.mock('./aiAgentRunSiteScope', () => ({ runSiteScopeCondition: vi.fn() }));
vi.mock('./aiToolsSiteScope', async (importOriginal) => ({ ...(await importOriginal<typeof import('./aiToolsSiteScope')>()), resolveSiteAllowedDeviceIds: vi.fn() }));
vi.mock('./aiAgents/runTrace', () => ({ buildRunTrace: vi.fn() }));
vi.mock('./aiGuardrails', () => ({ checkToolPermission: vi.fn() }));

import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { actionIntents, aiAgentRuns, aiToolExecutions } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { listAgents } from './aiAgents/agentService';
import { buildRunTrace } from './aiAgents/runTrace';
import { runSiteScopeCondition } from './aiAgentRunSiteScope';
import { resolveSiteAllowedDeviceIds } from './aiToolsSiteScope';
import { registerAiAgentGovernanceTools } from './aiToolsAiAgentGovernance';
import { PAGE_RESUME_KEY } from './aiToolPageResume';
import { compactToolResultForChat, MAX_TOOL_RESULT_CHARS } from './aiToolOutput';
import { checkToolPermission } from './aiGuardrails';

const ORG = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const SITE = sql`site_guard`;
const tools = new Map<string, AiTool>();
registerAiAgentGovernanceTools(tools);
const orgCondition = vi.fn(() => eq(aiAgentRuns.orgId, ORG));
const auth = (over = {}) => ({ scope: 'partner', accessibleOrgIds: [ORG],
  canAccessOrg: (id: string) => id === ORG, orgCondition, ...over,
}) as unknown as AuthContext;
const run = async (name: string, input: Record<string, unknown> = {}, over = {}) =>
  JSON.parse(await tools.get(name)!.handler(input, auth(over)));
function query(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain), leftJoin: vi.fn(() => chain),
    where: vi.fn((_condition?: SQL) => chain), orderBy: vi.fn(() => chain), limit: vi.fn(() => chain),
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  };
  return chain;
}
let page: ReturnType<typeof query>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveSiteAllowedDeviceIds).mockResolvedValue(null);
  page = query([]);
  vi.mocked(db.select).mockImplementation(() => page as never);
  vi.mocked(runSiteScopeCondition).mockReset().mockReturnValue(SITE);
  vi.mocked(buildRunTrace).mockReturnValue({ id: RUN, trace: [] } as never);
  vi.mocked(listAgents).mockResolvedValue([]);
  vi.mocked(checkToolPermission).mockReset().mockResolvedValue(null);
});

describe('AI-agent reads', () => {
  it.each(['list_ai_agent_runs', 'get_ai_agent_run'])('%s constrains out-of-site and out-of-device runs before returning rows', async (name) => {
    const device = '33333333-3333-4333-8333-333333333333';
    const caller = { allowedSiteIds: ['site-a'], allowedDeviceIds: [device] };
    const { runSiteScopeCondition: realSiteScope } = await vi.importActual<typeof import('./aiAgentRunSiteScope')>('./aiAgentRunSiteScope');
    vi.mocked(runSiteScopeCondition).mockImplementation(realSiteScope);
    const siteCondition = realSiteScope(auth(caller));
    const result = await run(name, name === 'get_ai_agent_run' ? { runId: RUN } : {}, caller);
    // The database returns no rows for an out-of-site device. Pin BOTH SQL
    // predicates: removing either must fail even though this fixture is empty.
    expect(page.where).toHaveBeenCalledWith(name === 'get_ai_agent_run'
      ? and(eq(aiAgentRuns.id, RUN), eq(aiAgentRuns.orgId, ORG), siteCondition, inArray(aiAgentRuns.deviceId, [device]))
      : and(eq(aiAgentRuns.orgId, ORG), siteCondition, inArray(aiAgentRuns.deviceId, [device])));
    const compiled = new PgDialect().sqlToQuery(page.where.mock.calls[0]![0]!);
    expect(compiled.sql).toContain('"run_scope_device"."id" = "ai_agent_runs"."device_id"');
    expect(compiled.sql).toContain('"run_scope_device"."org_id" = "ai_agent_runs"."org_id"');
    expect(compiled.sql).toContain('"run_scope_device"."site_id" IN');
    expect(compiled.sql).not.toMatch(/is null/i);
    expect(compiled.params).toContain('site-a');
    expect(compiled.params).toContain(device);
    expect(runSiteScopeCondition).toHaveBeenCalledWith(expect.objectContaining(caller));
    expect(result).toEqual(name === 'get_ai_agent_run' ? { error: 'Run not found' } : { runs: [], showing: 0 });
  });
  it('excludes an out-of-site intent even when its parent run is accessible', async () => {
    const device = '33333333-3333-4333-8333-333333333333';
    const row = { id: RUN, orgId: ORG, deviceId: device, sessionId: null, agentName: null, agentKind: null, deviceHostname: null };
    const intents = query([]);
    const { resolveSiteAllowedDeviceIds: realResolve } = await vi.importActual<typeof import('./aiToolsSiteScope')>('./aiToolsSiteScope');
    vi.mocked(resolveSiteAllowedDeviceIds).mockImplementation(realResolve);
    const deviceRows = query([{ id: device, siteId: 'site-a' }, { id: RUN, siteId: 'site-b' }]);
    vi.mocked(db.select).mockImplementationOnce(() => query([row]) as never).mockImplementationOnce(() => deviceRows as never).mockImplementationOnce(() => intents as never);
    await run('get_ai_agent_run', { runId: RUN }, { allowedSiteIds: ['site-a'], canAccessSite: (id: string) => id === 'site-a' });
    expect(resolveSiteAllowedDeviceIds).toHaveBeenCalledWith(ORG, expect.objectContaining({ allowedSiteIds: ['site-a'] }));
    expect(intents.where).toHaveBeenCalledWith(and(eq(actionIntents.requestingAgentRunId, RUN), eq(actionIntents.orgId, ORG), eq(aiAgentRuns.orgId, ORG), inArray(actionIntents.scopeDeviceId, [device])));
    expect(buildRunTrace).toHaveBeenCalledWith(row, null, null, [], []);
  });
  it('returns each executed step result, and hands the trace builder no raw result (#11966)', async () => {
    const row = { id: RUN, orgId: ORG, deviceId: null, sessionId: null, agentName: null, agentKind: null, deviceHostname: null };
    const intentId = '44444444-4444-4444-8444-444444444444';
    const intentRow = {
      id: intentId, status: 'completed', actionName: 'manage_services', approvalScope: 'four_eyes', decidedVia: 'human',
      result: { status: 'completed', stdout: 'Service Spooler restarted' }, errorCode: null,
      arguments: { action: 'restart', serviceName: 'Spooler' },
      executedAt: new Date('2026-11-16T10:00:00.000Z'), createdAt: new Date('2026-11-16T09:59:00.000Z'),
    };
    const intents = query([intentRow]);
    vi.mocked(db.select).mockImplementationOnce(() => query([row]) as never).mockImplementationOnce(() => intents as never);
    const out = await run('get_ai_agent_run', { runId: RUN });
    expect(out.trace).toEqual({ id: RUN, trace: [] });
    expect(out.stepResults).toEqual([expect.objectContaining({
      intentId, actionName: 'manage_services', status: 'completed', resultSummary: expect.stringContaining('Service Spooler restarted'),
    })]);
    expect(intents.orderBy).toHaveBeenCalledWith(asc(actionIntents.createdAt));
    expect(checkToolPermission).toHaveBeenCalledWith('manage_services', intentRow.arguments, expect.objectContaining({ orgCondition }));
    expect(buildRunTrace).toHaveBeenCalledWith(row, null, null, [], [
      { id: intentId, status: 'completed', actionName: 'manage_services', approvalScope: 'four_eyes', decidedVia: 'human' },
    ]);
  });
  describe('step results within the tool-result budget (#11966)', () => {
    const steps = Array.from({ length: 6 }, (_, i) => ({
      id: `44444444-4444-4444-8444-44444444444${i}`, status: 'completed', actionName: 'manage_services',
      approvalScope: 'four_eyes', decidedVia: 'human', errorCode: null, arguments: { action: 'restart', serviceName: `svc${i}` },
      result: { status: 'completed', stdout: `step-marker-${i} ${'y'.repeat(3_000)}` },
      executedAt: new Date(Date.UTC(2026, 10, 16, 10, i)), createdAt: new Date(Date.UTC(2026, 10, 16, 9, i)),
    }));
    // `rows` sizes the trace: 2 fits beside the default step budget, 6 and 8
    // fit only on their own, 12 overflows even the tightest tier (measured
    // against compactToolResultForChat's tiers when this was written).
    const traceOf = (rows: number, extra = '') => ({
      id: RUN, summary: `run-summary ${'s'.repeat(1_980)}`, ...(extra ? { extra } : {}),
      trace: Array.from({ length: rows }, (_, i) => ({ toolName: `tool_${i}`, a: 'a'.repeat(280), b: 'b'.repeat(280) })),
    });
    const compactedRun = async (rows: number, extra = '') => {
      const row = { id: RUN, orgId: ORG, deviceId: null, sessionId: null, agentName: null, agentKind: null, deviceHostname: null };
      vi.mocked(buildRunTrace).mockReturnValue(traceOf(rows, extra) as never);
      vi.mocked(db.select).mockImplementationOnce(() => query([row]) as never).mockImplementationOnce(() => query(steps) as never);
      return compactToolResultForChat('get_ai_agent_run', await tools.get('get_ai_agent_run')!.handler({ runId: RUN }, auth()));
    };

    it('shows every step beside a small trace', async () => {
      const out = JSON.parse(await compactedRun(2));
      expect(out.summarized).toBeUndefined();
      expect(out.stepResults.map((r: { resultSummary: string }) => r.resultSummary))
        .toEqual(steps.map((_, i) => expect.stringContaining(`step-marker-${i}`)));
      expect(out.trace.summary).toMatch(/^run-summary s{1980}$/);
    });

    it.each([6, 8])('never turns a %i-row trace that fit on its own into a digest', async (rows) => {
      expect(JSON.parse(compactToolResultForChat('get_ai_agent_run', JSON.stringify({ trace: traceOf(rows) }))).summarized).toBeUndefined();
      const compacted = await compactedRun(rows);
      expect(compacted.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
      const out = JSON.parse(compacted);
      expect(out.summarized).toBeUndefined();
      expect(out.trace.summary).toMatch(/^run-summary s{1980}$/);
      expect(out.stepResults.length).toBeGreaterThan(0);
      expect(out.stepResults[0].resultSummary).toContain('step-marker-0');
      expect(out.stepResultsOmitted).toEqual({ count: 6 - out.stepResults.length, reason: expect.stringContaining('left room') });
    });

    it("withholds a step result the caller may not obtain through the step's own tool", async () => {
      vi.mocked(checkToolPermission).mockImplementation(async (_tool, input) =>
        (input as { serviceName?: string }).serviceName === 'svc1' ? 'Insufficient permissions: requires devices.execute' : null);
      const out = JSON.parse(await compactedRun(2));
      expect(checkToolPermission).toHaveBeenCalledTimes(6);
      expect(out.stepResults[1]).toEqual({
        intentId: steps[1]!.id, actionName: 'manage_services', status: 'completed', resultSummary: null, resultWithheld: 'not_permitted',
      });
      expect(JSON.stringify(out)).not.toContain('step-marker-1');
      expect(out.stepResults[0].resultSummary).toContain('step-marker-0');
    });

    it('withholds, and does not fail the read, when the permission check throws', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(checkToolPermission).mockRejectedValue(new Error('permission store unavailable'));
      const out = JSON.parse(await compactedRun(2));
      expect(out.stepResults).toHaveLength(6);
      expect(out.stepResults.every((r: { resultWithheld?: string; resultSummary: unknown }) =>
        r.resultWithheld === 'permission_check_failed' && r.resultSummary === null)).toBe(true);
      expect(JSON.stringify(out)).not.toContain('step-marker');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('gives the steps no room, rather than negative room, when the trace alone nearly fills the budget', async () => {
      // 9 rows plus a 250-char field fit only the tightest tier, with less
      // than the 400-char envelope to spare: the unclamped budget is negative.
      const extra = 'e'.repeat(250);
      const alone = compactToolResultForChat('get_ai_agent_run', JSON.stringify({ trace: traceOf(9, extra) }));
      expect(JSON.parse(alone).summarized).toBeUndefined();
      expect(MAX_TOOL_RESULT_CHARS - alone.length).toBeLessThan(400);
      const out = JSON.parse(await compactedRun(9, extra));
      expect(out.summarized).toBeUndefined();
      expect(out.stepResults).toEqual([]);
      expect(out.stepResultsOmitted).toEqual({ count: 6, reason: expect.stringContaining('left room for 0') });
    });

    it('leads the digest preview with the step results when the trace overflows on its own', async () => {
      const out = JSON.parse(await compactedRun(12));
      expect(out.summarized).toBe(true);
      expect(out.preview.startsWith('{"stepResults":[{"intentId":')).toBe(true);
      expect(out.preview).toContain('step-marker-0');
    });
  });
  it('short-circuits an empty exact-device ceiling without a site ceiling', async () => {
    expect(await run('list_ai_agent_runs', {}, { allowedDeviceIds: [] })).toEqual({ runs: [], showing: 0 });
    expect(await run('get_ai_agent_run', { runId: RUN }, { allowedDeviceIds: [] })).toEqual({ error: 'Run not found' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each(['list_ai_agents', 'list_ai_agent_runs', 'get_ai_agent_run'])('registers %s as an AI Tier-1 read', (name) => {
    expect(tools.get(name)).toMatchObject({ tier: 1, domain: 'ai', deviceArgs: [] });
  });
  it('delegates agent visibility and returns only named scalar fields', async () => {
    const safe = { id: RUN, name: 'Triage', kind: 'triage', enabled: true, orgId: ORG, partnerId: null, createdAt: '2026-09-17' };
    vi.mocked(listAgents).mockResolvedValue([{ ...safe, policySnapshot: { secret: 'hidden' }, triggers: {}, instructions: 'private' }] as never);
    const caller = auth();
    expect(JSON.parse(await tools.get('list_ai_agents')!.handler({ includeDisabled: true }, caller))).toEqual({
      agents: [safe], showing: 1, limit: 25, offset: 0, hasMore: false, nextCursor: null,
      // #10385: compaction-only resume material; stripped before the model sees the result.
      [PAGE_RESUME_KEY]: expect.objectContaining({ key: 'agents', mode: 'offset' }),
    });
    expect(listAgents).toHaveBeenCalledWith(caller, { includeDisabled: true, limit: 26, offset: 0 });
  });
  it('defaults includeDisabled to false', async () => {
    expect(await run('list_ai_agents')).toEqual({
      agents: [], showing: 0, limit: 25, offset: 0, hasMore: false, nextCursor: null,
    });
    expect(listAgents).toHaveBeenCalledWith(expect.anything(), { includeDisabled: false, limit: 26, offset: 0 });
  });
  it('denies an inaccessible explicit organization before querying', async () => {
    expect((await run('list_ai_agent_runs', { orgId: RUN })).error).toMatch(/organization/i);
    expect(db.select).not.toHaveBeenCalled();
  });
  it('combines org and site predicates with filters, orders newest started first and clamps', async () => {
    await run('list_ai_agent_runs', { orgId: ORG, agentId: RUN, status: 'running', limit: 999 });
    expect(orgCondition).toHaveBeenCalledWith(aiAgentRuns.orgId);
    expect(runSiteScopeCondition).toHaveBeenCalledWith(expect.objectContaining({ scope: 'partner' }));
    expect(page.where).toHaveBeenCalledWith(and(eq(aiAgentRuns.orgId, ORG), SITE, undefined, eq(aiAgentRuns.agentId, RUN), eq(aiAgentRuns.status, 'running'), eq(aiAgentRuns.orgId, ORG), undefined));
    expect(page.orderBy).toHaveBeenCalledWith(desc(aiAgentRuns.startedAt));
    expect(page.limit).toHaveBeenCalledWith(50);
    const projection = vi.mocked(db.select).mock.calls[0]![0]!;
    expect(Object.keys(projection).sort()).toEqual(['id', 'agentId', 'orgId', 'status', 'profile', 'startedAt', 'finishedAt', 'resolvedModel', 'costCents', 'runVerdict'].sort());
    expect(projection.runVerdict).toEqual(sql`${aiAgentRuns.outcome}->>'runVerdict'`);
  });
  it('returns runs and defaults limit to 25', async () => {
    page = query([{ id: RUN, runVerdict: 'no_action' }]);
    expect(await run('list_ai_agent_runs')).toEqual({ runs: [{ id: RUN, runVerdict: 'no_action' }], showing: 1 });
    expect(page.limit).toHaveBeenCalledWith(25);
  });
  it('short-circuits an empty site ceiling', async () => {
    expect(await run('list_ai_agent_runs', {}, { allowedSiteIds: [] })).toEqual({ runs: [], showing: 0 });
    expect(await run('get_ai_agent_run', { runId: RUN }, { allowedSiteIds: [] })).toEqual({ error: 'Run not found' });
    expect(db.select).not.toHaveBeenCalled();
  });
  it.each([null, undefined, []].map(accessibleOrgIds => [accessibleOrgIds]))('fails closed for an empty partner org ceiling %j', async (accessibleOrgIds) => {
    expect(await run('list_ai_agent_runs', {}, { accessibleOrgIds })).toEqual({ runs: [], showing: 0 });
    expect(await run('get_ai_agent_run', { runId: RUN }, { accessibleOrgIds })).toEqual({ error: 'Run not found' });
    expect(db.select).not.toHaveBeenCalled();
  });
  it('allows system reads without an org allowlist', async () => {
    await run('list_ai_agent_runs', {}, { scope: 'system', accessibleOrgIds: null, orgCondition: () => undefined });
    expect(page.where).toHaveBeenCalledWith(and(undefined, SITE, undefined));
  });
  it.each([{}, { runId: 'bad' }])('conceals invalid ids %j', async (input) => {
    expect(await run('get_ai_agent_run', input)).toEqual({ error: 'Run not found' });
    expect(db.select).not.toHaveBeenCalled();
  });
  it.each(['inaccessible org', 'site-denied', 'absent'])('conceals a %s run excluded by SQL', async () => {
    expect(await run('get_ai_agent_run', { runId: RUN })).toEqual({ error: 'Run not found' });
    expect(page.where).toHaveBeenCalledWith(and(eq(aiAgentRuns.id, RUN), eq(aiAgentRuns.orgId, ORG), SITE, undefined));
    expect(buildRunTrace).not.toHaveBeenCalled();
  });
  it('loads safe ledger and intent rows with the route predicates', async () => {
    const row = { id: RUN, orgId: ORG, sessionId: RUN, agentName: 'Triage', agentKind: 'triage', deviceHostname: 'Device' };
    const ledgerRow = { toolName: 'query_devices', status: 'completed', durationMs: 1, createdAt: new Date(), completedAt: null, errorMessage: null };
    const intentRow = { id: RUN, status: 'approved', actionName: 'restart', approvalScope: 'supervised', decidedVia: 'human' };
    const ledger = query([ledgerRow]);
    const intents = query([intentRow]);
    vi.mocked(db.select).mockImplementationOnce(() => query([row]) as never)
      .mockImplementationOnce(() => ledger as never).mockImplementationOnce(() => intents as never);
    await run('get_ai_agent_run', { runId: RUN });
    expect(ledger.where).toHaveBeenCalledWith(eq(aiToolExecutions.sessionId, RUN));
    expect(ledger.orderBy).toHaveBeenCalledWith(asc(aiToolExecutions.createdAt));
    expect(intents.where).toHaveBeenCalledWith(and(eq(actionIntents.requestingAgentRunId, RUN), eq(actionIntents.orgId, ORG), eq(aiAgentRuns.orgId, ORG), undefined));
    expect(Object.keys(vi.mocked(db.select).mock.calls[1]![0]!).sort()).toEqual(['toolName', 'status', 'durationMs', 'createdAt', 'completedAt', 'errorMessage'].sort());
    // #11966: result/errorCode/executedAt/createdAt feed the step summaries only.
    expect(Object.keys(vi.mocked(db.select).mock.calls[2]![0]!).sort()).toEqual(['id', 'status', 'actionName', 'approvalScope', 'decidedVia', 'result', 'errorCode', 'arguments', 'executedAt', 'createdAt'].sort());
    expect(buildRunTrace).toHaveBeenCalledWith(row, { name: 'Triage', kind: 'triage' }, { hostname: 'Device' }, [ledgerRow], [intentRow]);
  });
  it('returns only the safe trace, never the raw run outcome', async () => {
    const row = { id: RUN, orgId: ORG, outcome: { private: 'secret' }, sessionId: null, agentName: null, agentKind: null, deviceHostname: null };
    page = query([row]);
    vi.mocked(db.select).mockImplementationOnce(() => page as never).mockImplementation(() => query([]) as never);
    expect(await run('get_ai_agent_run', { runId: RUN })).toEqual({ trace: { id: RUN, trace: [] }, stepResults: [] });
    expect(buildRunTrace).toHaveBeenCalledWith(row, null, null, [], []);
    const projection = vi.mocked(db.select).mock.calls[0]![0]!;
    expect(Object.keys(projection).sort()).toEqual(['id', 'agentId', 'orgId', 'deviceId', 'alertId', 'anomalyIncidentId', 'sessionId', 'triggerKind', 'modeAtStart', 'status', 'summary', 'scheduleId', 'triggerRef', 'reportRunId', 'computeCents', 'outcome', 'intentIds', 'turnCount', 'costCents', 'errorCode', 'queuedAt', 'startedAt', 'finishedAt', 'agentName', 'agentKind', 'deviceHostname'].sort());
  });
});
