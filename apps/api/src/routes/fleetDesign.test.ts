import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  selectMock,
  hasPermMock,
  authOkMock,
  mfaOkMock,
  resolveEffectiveAgentMock,
  createAndEnqueueAgentRunMock,
  loadFleetDesignReportMock,
  writeRouteAuditMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  hasPermMock: vi.fn<(resource: string, action: string) => boolean>(() => true),
  authOkMock: vi.fn(() => true),
  mfaOkMock: vi.fn(() => true),
  resolveEffectiveAgentMock: vi.fn(),
  createAndEnqueueAgentRunMock: vi.fn(),
  loadFleetDesignReportMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
}));

// Same shape as routes/aiAgents.test.ts's mock: requireScope/requirePermission
// are made-permissive-but-refusable pass-throughs so these tests exercise
// routing/validation/tenancy, not the middleware's own logic (that has its
// own coverage in middleware/auth.test.ts).
vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    ...actual,
    requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
    requireMfa: () => async (c: { json: (body: unknown, status: number) => Response }, next: () => Promise<void>) => (
      mfaOkMock() ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)
    ),
    requirePermission: (resource: string, action: string) => async (
      c: { json: (body: unknown, status: number) => Response },
      next: () => Promise<void>,
    ) => (hasPermMock(resource, action) ? next() : c.json({ error: 'Permission denied' }, 403)),
  };
});

vi.mock('../services/aiAgents/effectivePolicy', () => ({
  resolveEffectiveAgent: resolveEffectiveAgentMock,
}));

vi.mock('../services/aiAgents/runService', () => ({
  createAndEnqueueAgentRun: createAndEnqueueAgentRunMock,
}));

// FLEET_DESIGN_REPORT_TYPE stays real (a bare string constant, no DB
// dependency of its own) — only the loader is mocked, same convention
// aiAgents.test.ts uses for alertVerdicts.ts's projectAlertVerdict.
vi.mock('../services/aiAgents/fleetDesignReport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiAgents/fleetDesignReport')>();
  return {
    ...actual,
    loadFleetDesignReport: loadFleetDesignReportMock,
  };
});

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: writeRouteAuditMock,
}));

vi.mock('../db', () => ({
  db: { select: selectMock },
}));

// Imported AFTER the mocks above so the route module picks up the mocked
// dependencies (vi.mock calls are hoisted, but the import must still come
// after them textually is not required — kept here for readability).
const { fleetDesignRoutes } = await import('./fleetDesign');

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const SITE_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const AGENT_ID = '55555555-5555-4555-8555-555555555555';
const RUN_ID = '66666666-6666-4666-8666-666666666666';
const REPORT_RUN_ID = '77777777-7777-4777-8777-777777777777';
const REPORT_ID = '88888888-8888-4888-8888-888888888888';

/** Same minimal chainable `db.select(...)` stand-in as routes/aiAgents.test.ts. */
function selectChain<T>(rows: T) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function buildApp(authOverrides: Record<string, unknown> = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      user: { id: USER_ID, email: 'tech@example.com', name: 'Tech' },
      principal: { kind: 'user', id: USER_ID },
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      orgCondition: () => undefined,
      ...authOverrides,
    } as never);
    await next();
  });
  app.route('/ai/fleet-design', fleetDesignRoutes);
  return app;
}

function postRuns(app: Hono, body: unknown) {
  return app.request('/ai/fleet-design/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function fleetDesignSummary(overrides: Record<string, unknown> = {}) {
  return {
    fleetDesign: {
      schemaVersion: 1,
      generatedAt: '2026-09-12T00:00:00.000Z',
      runId: RUN_ID,
      evidenceTruncated: false,
      outcome: {
        markdown: '## What was found\n',
        sections: {
          functions: [{ functionKey: 'file_server', deviceIds: ['d1'], confidence: 0.9, evidence: [], itemRef: 'functions:file_server' }],
          monitoring: [{
            functionKey: 'file_server',
            watches: [{ watchType: 'service', name: 'LanmanServer', alertOnStop: true, autoRestart: true, rationale: 'x', itemRef: 'monitoring:file_server:watch:0' }],
            alertRules: [],
          }],
        },
      },
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hasPermMock.mockReturnValue(true);
  authOkMock.mockReturnValue(true);
  mfaOkMock.mockReturnValue(true);
  resolveEffectiveAgentMock.mockResolvedValue({ agentId: AGENT_ID, kind: 'designer', effective: { enabled: true, mode: 'act' } });
  createAndEnqueueAgentRunMock.mockResolvedValue({ created: true, run: { id: RUN_ID, status: 'queued' } });
});

describe('POST /ai/fleet-design/runs', () => {
  it('admits a design run for the org through createAndEnqueueAgentRun', async () => {
    const app = buildApp();
    const res = await postRuns(app, { orgId: ORG_ID });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ runId: RUN_ID });

    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledTimes(1);
    const call = createAndEnqueueAgentRunMock.mock.calls[0]![0];
    expect(call).toMatchObject({
      orgId: ORG_ID,
      kind: 'designer',
      profile: 'design',
      triggerKind: 'manual',
      deviceId: null,
      triggerRef: { requestedByUserId: USER_ID, agentId: AGENT_ID, siteId: null },
    });
    expect(call.dedupeKey).toMatch(/^design-manual-/);

    expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
    expect(writeRouteAuditMock.mock.calls[0]![1]).toMatchObject({
      orgId: ORG_ID,
      action: 'ai_fleet_design.run.manual_trigger',
      result: 'success',
    });
  });

  it('404s when the org has no effective designer agent', async () => {
    resolveEffectiveAgentMock.mockResolvedValue(null);
    const app = buildApp();
    const res = await postRuns(app, { orgId: ORG_ID });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'no_designer_agent' });
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('400s on extra keys (.strict) and a non-object body', async () => {
    const app = buildApp();

    const extraKeyRes = await postRuns(app, { orgId: ORG_ID, deviceId: 'not-allowed' });
    expect(extraKeyRes.status).toBe(400);

    const nonObjectRes = await postRuns(app, ['not', 'an', 'object']);
    expect(nonObjectRes.status).toBe(400);

    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it("404s for an org outside the caller's access", async () => {
    const app = buildApp({ canAccessOrg: () => false });
    const res = await postRuns(app, { orgId: OTHER_ORG_ID });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'not_found' });
    expect(resolveEffectiveAgentMock).not.toHaveBeenCalled();
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('404s when siteId does not belong to orgId', async () => {
    selectMock.mockReturnValueOnce(selectChain([])); // sites lookup: no row
    const app = buildApp();
    const res = await postRuns(app, { orgId: ORG_ID, siteId: SITE_ID });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'not_found' });
    expect(resolveEffectiveAgentMock).not.toHaveBeenCalled();
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('reports a declined admission as a 200 skip, not an error', async () => {
    createAndEnqueueAgentRunMock.mockResolvedValue({ created: false, skipped: 'mode_off' });
    const app = buildApp();
    const res = await postRuns(app, { orgId: ORG_ID });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ skipped: 'mode_off' });
    expect(writeRouteAuditMock.mock.calls[0]![1]).toMatchObject({ result: 'failure' });
  });
});

describe('GET /ai/fleet-design', () => {
  it('lists ai_fleet_design report runs for the org newest first', async () => {
    const rows = [
      { reportRunId: REPORT_RUN_ID, reportId: REPORT_ID, orgId: ORG_ID, summary: { summary: fleetDesignSummary() } },
    ];
    selectMock.mockReturnValueOnce(selectChain(rows));
    const app = buildApp();

    const res = await app.request(`/ai/fleet-design?orgId=${ORG_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([{
      reportRunId: REPORT_RUN_ID,
      reportId: REPORT_ID,
      orgId: ORG_ID,
      generatedAt: '2026-09-12T00:00:00.000Z',
      runId: RUN_ID,
      functionCount: 1,
      watchCount: 1,
      ruleCount: 0,
      evidenceTruncated: false,
    }]);
  });

  it('returns an empty list for ?orgId= outside the caller\'s access', async () => {
    const app = buildApp();
    const res = await app.request(`/ai/fleet-design?orgId=${OTHER_ORG_ID}`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [] });
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('GET /ai/fleet-design/:reportRunId', () => {
  it("404s for another org's report run", async () => {
    loadFleetDesignReportMock.mockResolvedValue(null);
    const app = buildApp();

    const res = await app.request(`/ai/fleet-design/${REPORT_RUN_ID}`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'not_found' });
  });

  it('returns the summary, markdown and download path for an accessible report run', async () => {
    loadFleetDesignReportMock.mockResolvedValue({
      reportRunId: REPORT_RUN_ID,
      reportId: REPORT_ID,
      orgId: ORG_ID,
      summary: fleetDesignSummary(),
      generatedAt: '2026-09-12T00:00:00.000Z',
    });
    const app = buildApp();

    const res = await app.request(`/ai/fleet-design/${REPORT_RUN_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reportRunId).toBe(REPORT_RUN_ID);
    expect(body.markdown).toBe('## What was found\n');
    expect(body.downloadPath).toBe(`/api/reports/runs/${REPORT_RUN_ID}/download`);
  });
});
