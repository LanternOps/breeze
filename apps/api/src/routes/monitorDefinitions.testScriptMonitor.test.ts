import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * POST /monitor-definitions/:id/test for a `script` monitor, end to end through
 * the REAL compiler and the REAL condition evaluator (#12325).
 *
 * monitorDefinitions.test.ts mocks both `buildCompiledCondition` and
 * `evaluateConditions`, so it cannot see what the Test button reports for a
 * given `script_executions` row. Only the database is mocked here: the device
 * lookup, the script-monitor handler's newest-run query, and the evaluator's
 * latest-metric context read, in that order.
 */

const { selectMock, getMonitorDefinitionMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  getMonitorDefinitionMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../services/monitors/monitorService', () => {
  class MonitorError extends Error {}
  return {
    MonitorNotFoundError: MonitorError,
    MonitorOwnershipError: MonitorError,
    MonitorValidationError: MonitorError,
    MonitorHasDependentsError: MonitorError,
    listMonitorDefinitions: vi.fn(),
    getMonitorDefinition: getMonitorDefinitionMock,
    createMonitorDefinition: vi.fn(),
    updateMonitorDefinition: vi.fn(),
    deleteMonitorDefinition: vi.fn(),
  };
});

vi.mock('../services/eventLogPolicyProviders', () => ({ loadPolicyApplicationProviders: vi.fn(async () => []) }));
vi.mock('../services/monitors/monitorResolver', () => ({ resolveMonitorsForDevice: vi.fn() }));
vi.mock('../services/monitors/ruleConversionService', () => ({ convertRuleToMonitor: vi.fn() }));
vi.mock('../services/monitors/monitorAttachability', () => ({ isMonitorAttachableToPolicy: vi.fn(async () => true) }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    db: { ...actual.db, select: (...args: unknown[]) => selectMock(...(args as [])) },
    hasDbAccessContext: () => true,
    withDbTransaction: async (fn: () => Promise<unknown>) => fn(),
  };
});

import { monitorDefinitionRoutes } from './monitorDefinitions';

const ORG_ID = '33333333-3333-4333-8333-333333333333';
const MONITOR_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '66666666-6666-4666-8666-666666666666';
const SITE_ID = '88888888-8888-4888-8888-888888888888';
const SCRIPT_ID = '99999999-9999-4999-8999-999999999999';

function selectChain<T>(rows: T) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    groupBy: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function scriptMonitorRow() {
  return {
    id: MONITOR_ID,
    orgId: ORG_ID,
    partnerId: null,
    name: 'Hyper-V checkpoint check',
    description: null,
    kind: 'script',
    enabled: true,
    condition: { scriptId: SCRIPT_ID, intervalMinutes: 5, timeoutSeconds: 300, breachOnNonZeroExit: true },
    severity: 'high',
    cooldownMinutes: 5,
    autoResolve: true,
    autoResolveConditions: null,
    responses: [],
  };
}

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      allowedSiteIds: null,
      orgCondition: () => undefined,
      canAccessOrg: () => true,
    } as never);
    await next();
  });
  app.route('/', monitorDefinitionRoutes);
  return app;
}

async function runTest(executionRows: unknown[]) {
  getMonitorDefinitionMock.mockResolvedValue(scriptMonitorRow());
  selectMock
    .mockReturnValueOnce(selectChain([{ id: DEVICE_ID, siteId: SITE_ID }])) // device lookup
    .mockReturnValueOnce(selectChain(executionRows)) // scriptMonitor handler: newest run
    .mockReturnValue(selectChain([])); // evaluator context: latest metric
  const res = await buildApp().request(`/${MONITOR_ID}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: DEVICE_ID }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { data: { triggered: boolean; dataState: string; conditionsMet: string[] } };
}

describe('POST /monitor-definitions/:id/test — script monitor (#12325)', () => {
  beforeEach(() => {
    selectMock.mockReset();
    getMonitorDefinitionMock.mockReset();
  });

  it('reports the condition met when the script ran and exited 1 (breachOnNonZeroExit)', async () => {
    // The row handleScriptResult writes for an agent result of exit code 1.
    const body = await runTest([{
      status: 'failed',
      exitCode: 1,
      stdout: 'checkpoint found',
      errorMessage: null,
      completedAt: new Date(),
      createdAt: new Date(),
    }]);

    expect(body.data.triggered).toBe(true);
    expect(body.data.dataState).toBe('ok');
    expect(body.data.conditionsMet.join(' ')).toContain('Script exited with code 1');
  });

  it('reports no data, not "condition not met", when the run timed out', async () => {
    const body = await runTest([{
      status: 'timeout',
      exitCode: -1,
      stdout: '',
      errorMessage: 'execution timed out after 300 seconds',
      completedAt: new Date(),
      createdAt: new Date(),
    }]);

    expect(body.data.triggered).toBe(false);
    expect(body.data.dataState).toBe('unknown');
  });

  it('a clean exit-0 run is observed and not met', async () => {
    const body = await runTest([{
      status: 'completed',
      exitCode: 0,
      stdout: '',
      errorMessage: null,
      completedAt: new Date(),
      createdAt: new Date(),
    }]);

    expect(body.data.triggered).toBe(false);
    expect(body.data.dataState).toBe('ok');
  });
});
