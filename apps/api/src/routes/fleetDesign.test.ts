import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PERMISSIONS } from '../services/permissions';
// Resolves through the vi.mock('../services/fleetDesign/preview', ...) factory
// below, which spreads `...actual` — so this is the REAL class, same identity
// the route module's own `err instanceof FleetDesignApplyError` checks against.
import { FleetDesignApplyError } from '../services/fleetDesign/preview';

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

// #6214: designer setup/enable. Mocked whole (the real module imports
// agentService and its dependency tree); the error class is defined IN the
// factory so the route's `instanceof` and this file's `new` share identity.
const { describeDesignerSetupMock, enableDesignerMock } = vi.hoisted(() => ({
  describeDesignerSetupMock: vi.fn(),
  enableDesignerMock: vi.fn(),
}));
vi.mock('../services/fleetDesign/designerSetup', () => ({
  describeDesignerSetup: describeDesignerSetupMock,
  enableDesigner: enableDesignerMock,
  DesignerEnableError: class DesignerEnableError extends Error {
    constructor(readonly code: string, readonly detail: Record<string, unknown> = {}) {
      super(code);
      this.name = 'DesignerEnableError';
    }
  },
}));

vi.mock('../db', () => ({
  db: { select: selectMock },
}));

// W03 (#5653): apply preview, apply, rollback, ledger. A second vi.hoisted
// block (rather than folding into the one above) so this section can be
// read and lifted independently of the W01 runs/list/detail mocks.
const {
  previewFleetDesignApplyMock,
  applyFleetDesignMock,
  rollbackFleetDesignMock,
  loadLedgerMock,
} = vi.hoisted(() => ({
  previewFleetDesignApplyMock: vi.fn(),
  applyFleetDesignMock: vi.fn(),
  rollbackFleetDesignMock: vi.fn(),
  loadLedgerMock: vi.fn(),
}));

const { fileFleetDesignDocumentMock } = vi.hoisted(() => ({ fileFleetDesignDocumentMock: vi.fn() }));
vi.mock('../services/fleetDesign/documents', () => ({
  fileFleetDesignDocument: fileFleetDesignDocumentMock,
}));

// Keep the real FleetDesignApplyError class (and every other export) so the
// route's `err instanceof FleetDesignApplyError` check — and this file's own
// `instanceof` assertions — see the same identity the real module would.
vi.mock('../services/fleetDesign/preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/fleetDesign/preview')>();
  return { ...actual, previewFleetDesignApply: previewFleetDesignApplyMock };
});

vi.mock('../services/fleetDesign/apply', () => ({
  applyFleetDesign: applyFleetDesignMock,
}));

vi.mock('../services/fleetDesign/rollback', () => ({
  rollbackFleetDesign: rollbackFleetDesignMock,
}));

// toLedgerItem stays real — it's a pure projection, exercised by the
// GET /:id/applied test below.
vi.mock('../services/fleetDesign/ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/fleetDesign/ledger')>();
  return { ...actual, loadLedger: loadLedgerMock };
});

// Imported AFTER the mocks above so the route module picks up the mocked
// dependencies (vi.mock calls are hoisted, but the import must still come
// after them textually is not required — kept here for readability).
const { fleetDesignRoutes } = await import('./fleetDesign');
const { DesignerEnableError } = await import('../services/fleetDesign/designerSetup');

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

// Every other suite in this file mounts `fleetDesignRoutes` behind a
// test-only middleware that pre-sets `c.set('auth', ...)` (see `buildApp`
// below) — that masks whether the router itself ever applies
// `authMiddleware`, because `authMiddleware` no-ops when `auth` is already
// on the context (middleware/auth.ts:522-526). This suite mounts the router
// bare, the way `index.ts` actually does (`api.route('/ai/fleet-design',
// fleetDesignRoutes)`, no upstream auth), so it exercises the router's own
// gate — same shape as `routes/aiAgents.test.ts`'s "is behind authMiddleware".
describe('router auth gate', () => {
  it('is behind authMiddleware', async () => {
    const app = new Hono();
    app.route('/ai/fleet-design', fleetDesignRoutes);

    const res = await app.request('/ai/fleet-design/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID }),
    });

    expect(res.status).toBe(401);
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });
});

describe('GET /ai/fleet-design/designer (#6214)', () => {
  it('returns the setup status for an accessible org', async () => {
    describeDesignerSetupMock.mockResolvedValue({ status: 'missing', agentId: null, canEnable: true });
    const app = buildApp();
    const res = await app.request(`/ai/fleet-design/designer?orgId=${ORG_ID}`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { status: 'missing', agentId: null, canEnable: true } });
    expect(describeDesignerSetupMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID }), ORG_ID);
  });

  it('404s a cross-tenant or malformed orgId without touching the service', async () => {
    const app = buildApp();
    expect((await app.request(`/ai/fleet-design/designer?orgId=${OTHER_ORG_ID}`)).status).toBe(404);
    expect((await app.request('/ai/fleet-design/designer?orgId=nope')).status).toBe(404);
    expect((await app.request('/ai/fleet-design/designer')).status).toBe(400);
    expect(describeDesignerSetupMock).not.toHaveBeenCalled();
  });

  it('is a read: ai_agents:read suffices, ai_agents:write is not consulted', async () => {
    describeDesignerSetupMock.mockResolvedValue({ status: 'ready', agentId: AGENT_ID, canEnable: false });
    hasPermMock.mockImplementation((_resource, action) => action === 'read');
    const app = buildApp();
    expect((await app.request(`/ai/fleet-design/designer?orgId=${ORG_ID}`)).status).toBe(200);
  });
});

describe('POST /ai/fleet-design/designer/enable (#6214)', () => {
  function postEnable(app: Hono, body: unknown) {
    return app.request('/ai/fleet-design/designer/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('enables, audits, and returns the fresh status', async () => {
    enableDesignerMock.mockResolvedValue({ status: 'ready', agentId: AGENT_ID, canEnable: false });
    const app = buildApp();
    const res = await postEnable(app, { orgId: ORG_ID });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { status: 'ready', agentId: AGENT_ID, canEnable: false } });
    expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
    expect(writeRouteAuditMock.mock.calls[0]![1]).toMatchObject({
      orgId: ORG_ID,
      action: 'ai_fleet_design.designer.enable',
      resourceType: 'ai_agent',
      resourceId: AGENT_ID,
      result: 'success',
    });
  });

  it('requires ai_agents:write and MFA, 404s a cross-tenant org, 400s extra keys', async () => {
    hasPermMock.mockImplementation((_resource, action) => action === 'read');
    expect((await postEnable(buildApp(), { orgId: ORG_ID })).status).toBe(403);
    hasPermMock.mockReturnValue(true);

    mfaOkMock.mockReturnValue(false);
    expect((await postEnable(buildApp(), { orgId: ORG_ID })).status).toBe(403);
    mfaOkMock.mockReturnValue(true);

    expect((await postEnable(buildApp(), { orgId: OTHER_ORG_ID })).status).toBe(404);
    expect((await postEnable(buildApp(), { orgId: ORG_ID, siteId: SITE_ID })).status).toBe(400);
    expect(enableDesignerMock).not.toHaveBeenCalled();
  });

  it.each([
    ['partner_scope_required', 403],
    ['partner_admin_required', 403],
    ['kill_switch_off', 409],
    ['agent_kind_exists', 409],
    ['act_prerequisites_not_met', 422],
    ['invalid_recipients', 422],
  ] as const)('maps DesignerEnableError %s to %i with the code and detail, and audits the failure', async (code, status) => {
    enableDesignerMock.mockRejectedValue(new DesignerEnableError(code, { missing: ['recipient'] }));
    const res = await postEnable(buildApp(), { orgId: ORG_ID });

    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toEqual({ error: code, missing: ['recipient'] });
    expect(writeRouteAuditMock.mock.calls[0]![1]).toMatchObject({
      action: 'ai_fleet_design.designer.enable',
      result: 'failure',
      details: { error: code },
    });
  });
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
    // `success: false` is what runAction's failure detector reads (apiError.ts)
    // — a declined admission must never toast as a queued run.
    await expect(res.json()).resolves.toEqual({ success: false, skipped: 'mode_off' });
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

// ---------------------------------------------------------------------------
// W03 (#5653): apply preview, apply, rollback, ledger
// ---------------------------------------------------------------------------
describe('Fleet Design apply/rollback routes (W03, #5653)', () => {
  const JSON_HEADERS = { 'content-type': 'application/json' };
  const EMPTY_APPROVAL = {
    functions: [], monitoring: [], retired: [], automation: [], legacy: [], roleCorrections: [], displacementsAccepted: [],
  };

  /**
   * Same shape as `buildApp` above, plus an optional `permissions` context
   * var — `routes/fleetDesign.ts`'s `siteRestricted(c)` reads
   * `c.get('permissions')`, which the W01 `buildApp` never sets (no route it
   * covers reads it).
   */
  function buildW03App(authOverrides: Record<string, unknown> = {}, permissions?: Record<string, unknown>) {
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
      if (permissions !== undefined) c.set('permissions', permissions as never);
      await next();
    });
    app.route('/ai/fleet-design', fleetDesignRoutes);
    return app;
  }

  function postJson(app: Hono, path: string, body: unknown = EMPTY_APPROVAL) {
    return app.request(`/ai/fleet-design${path}`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    previewFleetDesignApplyMock.mockReset();
    applyFleetDesignMock.mockReset();
    rollbackFleetDesignMock.mockReset();
    loadLedgerMock.mockReset();
  });

  describe('POST /:reportRunId/apply/preview', () => {
    it('forwards the validated body to previewFleetDesignApply(auth, reportRunId, body) and returns 200 with its result', async () => {
      const previewResult = {
        functions: [{ functionKey: 'file_server', label: 'File server', groupId: null, groupName: 'Fleet Design: File server', deviceCount: 1, devicesAdded: [], devicesRemoved: [], keptManual: 0, missingDevices: [] }],
        policies: [], retired: [], roleCorrections: [], alreadyApplied: [], blockers: [],
      };
      previewFleetDesignApplyMock.mockResolvedValue(previewResult);
      const approval = { ...EMPTY_APPROVAL, functions: ['file_server'] };
      const app = buildW03App();

      const res = await postJson(app, `/${REPORT_RUN_ID}/apply/preview`, approval);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual(previewResult);
      expect(previewFleetDesignApplyMock).toHaveBeenCalledTimes(1);
      const [authArg, reportRunIdArg, approvalArg] = previewFleetDesignApplyMock.mock.calls[0]!;
      expect(authArg).toMatchObject({ orgId: ORG_ID });
      expect(reportRunIdArg).toBe(REPORT_RUN_ID);
      expect(approvalArg).toEqual(approval);
    });

    it('404s for a malformed reportRunId without calling the service', async () => {
      const app = buildW03App();
      const res = await postJson(app, '/not-a-uuid/apply/preview');
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: 'not_found' });
      expect(previewFleetDesignApplyMock).not.toHaveBeenCalled();
    });

    it('400s on an unrecognized approval key (.strict()) without calling the service', async () => {
      const app = buildW03App();
      const res = await postJson(app, `/${REPORT_RUN_ID}/apply/preview`, { ...EMPTY_APPROVAL, bogus: true });
      expect(res.status).toBe(400);
      expect(previewFleetDesignApplyMock).not.toHaveBeenCalled();
    });

    it('403s with site_restricted before calling the service when the caller carries allowedSiteIds', async () => {
      const app = buildW03App({}, { allowedSiteIds: [SITE_ID] });
      const res = await postJson(app, `/${REPORT_RUN_ID}/apply/preview`);
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: 'site_restricted' });
      expect(previewFleetDesignApplyMock).not.toHaveBeenCalled();
    });

    it('maps FleetDesignApplyError("not_found") to 404', async () => {
      previewFleetDesignApplyMock.mockRejectedValue(new FleetDesignApplyError('not_found'));
      const app = buildW03App();
      const res = await postJson(app, `/${REPORT_RUN_ID}/apply/preview`);
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: 'not_found' });
    });

    it('requires devices:write', async () => {
      hasPermMock.mockReturnValue(false);
      const app = buildW03App();
      const res = await postJson(app, `/${REPORT_RUN_ID}/apply/preview`);
      expect(res.status).toBe(403);
      expect(hasPermMock).toHaveBeenCalledWith(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);
      expect(previewFleetDesignApplyMock).not.toHaveBeenCalled();
    });

    it('requires MFA', async () => {
      mfaOkMock.mockReturnValue(false);
      const app = buildW03App();
      const res = await postJson(app, `/${REPORT_RUN_ID}/apply/preview`);
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ code: 'MFA_REQUIRED' });
      expect(previewFleetDesignApplyMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /:reportRunId/apply', () => {
    it('requires devices:write and MFA the same way preview does', async () => {
      hasPermMock.mockReturnValue(false);
      const app = buildW03App();
      const res = await postJson(app, `/${REPORT_RUN_ID}/apply`);
      expect(res.status).toBe(403);
      expect(hasPermMock).toHaveBeenCalledWith(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);
      expect(applyFleetDesignMock).not.toHaveBeenCalled();

      hasPermMock.mockReturnValue(true);
      mfaOkMock.mockReturnValue(false);
      const res2 = await postJson(app, `/${REPORT_RUN_ID}/apply`);
      expect(res2.status).toBe(403);
      await expect(res2.json()).resolves.toMatchObject({ code: 'MFA_REQUIRED' });
      expect(applyFleetDesignMock).not.toHaveBeenCalled();
    });

    it('403s with site_restricted before calling the service', async () => {
      const app = buildW03App({}, { allowedSiteIds: [SITE_ID] });
      const res = await postJson(app, `/${REPORT_RUN_ID}/apply`);
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: 'site_restricted' });
      expect(applyFleetDesignMock).not.toHaveBeenCalled();
    });

    it('404s for a malformed reportRunId without calling the service', async () => {
      const app = buildW03App();
      const res = await postJson(app, '/not-a-uuid/apply');
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: 'not_found' });
      expect(applyFleetDesignMock).not.toHaveBeenCalled();
    });

    it('400s on an unrecognized approval key without calling the service', async () => {
      const app = buildW03App();
      const res = await postJson(app, `/${REPORT_RUN_ID}/apply`, { ...EMPTY_APPROVAL, extra: 1 });
      expect(res.status).toBe(400);
      expect(applyFleetDesignMock).not.toHaveBeenCalled();
    });

    it('maps FleetDesignApplyError("blocked") to 409 with the blockers/unaccepted payload', async () => {
      const payload = {
        blockers: [{ itemRef: 'functions:file_server', reason: 'not_in_design' }],
        unaccepted: [{ policyId: '99999999-9999-4999-8999-999999999999', policyName: 'Existing Monitoring', featureType: 'monitoring', deviceCount: 3 }],
      };
      applyFleetDesignMock.mockRejectedValue(new FleetDesignApplyError('blocked', payload));
      const app = buildW03App();
      const res = await postJson(app, `/${REPORT_RUN_ID}/apply`);
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: 'blocked', ...payload });
    });

    it('audits fleet_design.apply with the outcome on success', async () => {
      const result = { applied: ['functions:file_server'], skipped: [], partial: null, rollbackAvailable: true };
      applyFleetDesignMock.mockResolvedValue(result);
      const app = buildW03App();
      const res = await postJson(app, `/${REPORT_RUN_ID}/apply`);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual(result);
      expect(writeRouteAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'fleet_design.apply', resourceType: 'report_run', resourceId: REPORT_RUN_ID, result: 'success' }),
      );
    });

    it('audits fleet_design.apply as a failure and re-throws mapped 409 when blocked', async () => {
      applyFleetDesignMock.mockRejectedValue(new FleetDesignApplyError('blocked', { blockers: [], unaccepted: [] }));
      const app = buildW03App();
      const res = await postJson(app, `/${REPORT_RUN_ID}/apply`);
      expect(res.status).toBe(409);
      expect(writeRouteAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'fleet_design.apply', result: 'failure', details: expect.objectContaining({ blocked: true }) }),
      );
    });
  });

  describe('POST /:reportRunId/rollback', () => {
    it('returns the service result', async () => {
      const rollbackResult = { rolledBack: ['functions:file_server'], refused: [] };
      rollbackFleetDesignMock.mockResolvedValue(rollbackResult);
      const app = buildW03App();
      const res = await app.request(`/ai/fleet-design/${REPORT_RUN_ID}/rollback`, { method: 'POST' });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual(rollbackResult);
      expect(rollbackFleetDesignMock).toHaveBeenCalledTimes(1);
      expect(rollbackFleetDesignMock.mock.calls[0]![1]).toBe(REPORT_RUN_ID);
    });

    it('requires devices:write and MFA', async () => {
      hasPermMock.mockReturnValue(false);
      const app = buildW03App();
      const res = await app.request(`/ai/fleet-design/${REPORT_RUN_ID}/rollback`, { method: 'POST' });
      expect(res.status).toBe(403);
      expect(hasPermMock).toHaveBeenCalledWith(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);
      expect(rollbackFleetDesignMock).not.toHaveBeenCalled();
    });

    it('403s with site_restricted before calling the service', async () => {
      const app = buildW03App({}, { allowedSiteIds: [SITE_ID] });
      const res = await app.request(`/ai/fleet-design/${REPORT_RUN_ID}/rollback`, { method: 'POST' });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: 'site_restricted' });
      expect(rollbackFleetDesignMock).not.toHaveBeenCalled();
    });

    it('404s for a malformed reportRunId without calling the service', async () => {
      const app = buildW03App();
      const res = await app.request('/ai/fleet-design/not-a-uuid/rollback', { method: 'POST' });
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: 'not_found' });
      expect(rollbackFleetDesignMock).not.toHaveBeenCalled();
    });

    it('maps FleetDesignApplyError("not_found") to 404', async () => {
      rollbackFleetDesignMock.mockRejectedValue(new FleetDesignApplyError('not_found'));
      const app = buildW03App();
      const res = await app.request(`/ai/fleet-design/${REPORT_RUN_ID}/rollback`, { method: 'POST' });
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: 'not_found' });
    });

    it('audits fleet_design.rollback', async () => {
      const rollbackResult = { rolledBack: ['functions:file_server'], refused: [] };
      rollbackFleetDesignMock.mockResolvedValue(rollbackResult);
      const app = buildW03App();
      const res = await app.request(`/ai/fleet-design/${REPORT_RUN_ID}/rollback`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(writeRouteAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'fleet_design.rollback', resourceType: 'report_run', resourceId: REPORT_RUN_ID, result: 'success' }),
      );
    });
  });

  describe('scripts:write gate (W04, #5654)', () => {
    const SCRIPT_APPROVAL = { ...EMPTY_APPROVAL, automation: ['automation:file_server:script:0'] };
    const withScriptsWrite = { permissions: [{ resource: 'devices', action: 'write' }, { resource: 'scripts', action: 'write' }] };
    const devicesOnly = { permissions: [{ resource: 'devices', action: 'write' }] };

    it.each(['apply/preview', 'apply'])('%s: 403 scripts_write_required when automation refs are approved and the caller lacks scripts:write', async (path) => {
      const app = buildW03App({}, devicesOnly);
      const res = await postJson(app, `/${REPORT_RUN_ID}/${path}`, SCRIPT_APPROVAL);
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: 'scripts_write_required' });
      expect(previewFleetDesignApplyMock).not.toHaveBeenCalled();
      expect(applyFleetDesignMock).not.toHaveBeenCalled();
    });

    it('apply proceeds with scripts:write', async () => {
      applyFleetDesignMock.mockResolvedValue({ applied: ['automation:file_server:script:0'], skipped: [], partial: null, rollbackAvailable: true });
      const app = buildW03App({}, withScriptsWrite);
      const res = await postJson(app, `/${REPORT_RUN_ID}/apply`, SCRIPT_APPROVAL);
      expect(res.status).toBe(200);
      expect(applyFleetDesignMock).toHaveBeenCalledTimes(1);
    });

    it('an approval without automation refs needs no scripts:write', async () => {
      previewFleetDesignApplyMock.mockResolvedValue({ functions: [], policies: [], retired: [], scripts: [], roleCorrections: [], alreadyApplied: [], blockers: [] });
      const app = buildW03App({}, devicesOnly);
      const res = await postJson(app, `/${REPORT_RUN_ID}/apply/preview`, EMPTY_APPROVAL);
      expect(res.status).toBe(200);
    });

    it('rollback tells the service whether the caller may untag scripts', async () => {
      rollbackFleetDesignMock.mockResolvedValue({ rolledBack: [], refused: [] });
      await buildW03App({}, devicesOnly).request(`/ai/fleet-design/${REPORT_RUN_ID}/rollback`, { method: 'POST' });
      await buildW03App({}, withScriptsWrite).request(`/ai/fleet-design/${REPORT_RUN_ID}/rollback`, { method: 'POST' });
      expect(rollbackFleetDesignMock.mock.calls[0]![3]).toEqual({ canWriteScripts: false });
      expect(rollbackFleetDesignMock.mock.calls[1]![3]).toEqual({ canWriteScripts: true });
    });
  });

  describe('GET /:reportRunId/applied', () => {
    it('returns { items } via toLedgerItem for an accessible report run', async () => {
      loadFleetDesignReportMock.mockResolvedValue({
        reportRunId: REPORT_RUN_ID,
        reportId: REPORT_ID,
        orgId: ORG_ID,
        summary: fleetDesignSummary(),
        generatedAt: '2026-09-12T00:00:00.000Z',
      });
      const ledgerRow = {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        orgId: ORG_ID,
        reportRunId: REPORT_RUN_ID,
        itemRef: 'functions:file_server',
        itemKind: 'function',
        status: 'applied',
        step: 1,
        createdRefs: { groupId: 'gggggggg-gggg-4ggg-8ggg-gggggggggggg' },
        beforeImage: null,
        error: null,
        appliedByUserId: USER_ID,
        appliedAt: new Date('2026-09-12T00:00:00.000Z'),
        rolledBackByUserId: null,
        rolledBackAt: null,
      };
      loadLedgerMock.mockResolvedValue([ledgerRow]);
      const app = buildW03App();

      const res = await app.request(`/ai/fleet-design/${REPORT_RUN_ID}/applied`);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        items: [{
          id: ledgerRow.id,
          itemRef: 'functions:file_server',
          itemKind: 'function',
          status: 'applied',
          step: 1,
          createdRefs: ledgerRow.createdRefs,
          error: null,
          appliedAt: '2026-09-12T00:00:00.000Z',
          rolledBackAt: null,
        }],
      });
      expect(loadLedgerMock).toHaveBeenCalledWith(REPORT_RUN_ID, ORG_ID);
    });

    it("404s for another org's report run", async () => {
      loadFleetDesignReportMock.mockResolvedValue(null);
      const app = buildW03App();
      const res = await app.request(`/ai/fleet-design/${REPORT_RUN_ID}/applied`);
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: 'not_found' });
      expect(loadLedgerMock).not.toHaveBeenCalled();
    });

    it('404s for a malformed reportRunId', async () => {
      const app = buildW03App();
      const res = await app.request('/ai/fleet-design/not-a-uuid/applied');
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: 'not_found' });
    });
  });
});

describe('POST /ai/fleet-design/:reportRunId/document (W05, #5655)', () => {
  /** What `authMiddleware` puts on the context once `requirePermission` has
   *  resolved the caller's org-scoped grants (middleware/auth.ts). */
  const grants = (...resources: string[]) => ({ permissions: resources.map((resource) => ({ resource, action: 'write' })) });

  function buildApp(authOverrides: Record<string, unknown> = {}, permissions: unknown = grants('documents', 'contracts')) {
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
      c.set('permissions', permissions as never);
      await next();
    });
    app.route('/ai/fleet-design', fleetDesignRoutes);
    return app;
  }

  beforeEach(() => {
    fileFleetDesignDocumentMock.mockReset();
    loadFleetDesignReportMock.mockReset();
    hasPermMock.mockReturnValue(true);
    mfaOkMock.mockReturnValue(true);
  });

  it("resolves the run's org through loadFleetDesignReport and files it with the caller's actor", async () => {
    loadFleetDesignReportMock.mockResolvedValue({ reportRunId: REPORT_RUN_ID, reportId: REPORT_ID, orgId: ORG_ID, summary: {}, generatedAt: null });
    fileFleetDesignDocumentMock.mockResolvedValue({ documentId: 'doc-1', alreadyFiled: false, evidence: null });
    const res = await buildApp().request(`/ai/fleet-design/${REPORT_RUN_ID}/document`, { method: 'POST' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ documentId: 'doc-1', alreadyFiled: false, evidence: null });
    expect(fileFleetDesignDocumentMock).toHaveBeenCalledTimes(1);
    expect(fileFleetDesignDocumentMock.mock.calls[0]![0]).toMatchObject({
      orgId: ORG_ID, reportRunId: REPORT_RUN_ID, actor: { userId: USER_ID, accessibleOrgIds: [ORG_ID] },
    });
  });

  it('links deliverable evidence only when the caller also carries contracts:write', async () => {
    loadFleetDesignReportMock.mockResolvedValue({ reportRunId: REPORT_RUN_ID, reportId: REPORT_ID, orgId: ORG_ID, summary: {}, generatedAt: null });
    fileFleetDesignDocumentMock.mockResolvedValue({ documentId: 'doc-1', alreadyFiled: false, evidence: null });

    // documents:write only — filing is allowed, the deliverable side door is not.
    const denied = await buildApp({}, grants('documents')).request(`/ai/fleet-design/${REPORT_RUN_ID}/document`, { method: 'POST' });
    expect(denied.status).toBe(200);
    expect(fileFleetDesignDocumentMock.mock.calls[0]![0]).toMatchObject({ linkDeliverableEvidence: false });

    // Both permissions — the linkage is attempted.
    fileFleetDesignDocumentMock.mockClear();
    const allowed = await buildApp().request(`/ai/fleet-design/${REPORT_RUN_ID}/document`, { method: 'POST' });
    expect(allowed.status).toBe(200);
    expect(fileFleetDesignDocumentMock.mock.calls[0]![0]).toMatchObject({ linkDeliverableEvidence: true });
  });

  it('maps a DeliverableServiceError to its own status instead of an opaque 500', async () => {
    loadFleetDesignReportMock.mockResolvedValue({ reportRunId: REPORT_RUN_ID, reportId: REPORT_ID, orgId: ORG_ID, summary: {}, generatedAt: null });
    fileFleetDesignDocumentMock.mockRejectedValue(
      Object.assign(new Error('Not found'), { status: 404, code: 'not_found' }),
    );
    const res = await buildApp().request(`/ai/fleet-design/${REPORT_RUN_ID}/document`, { method: 'POST' });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'not_found' });
  });

  it("404s for another org's report run without filing anything", async () => {
    loadFleetDesignReportMock.mockResolvedValue(null);
    const res = await buildApp().request(`/ai/fleet-design/${REPORT_RUN_ID}/document`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(fileFleetDesignDocumentMock).not.toHaveBeenCalled();
  });

  it('404s for a malformed reportRunId', async () => {
    const res = await buildApp().request('/ai/fleet-design/not-a-uuid/document', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(fileFleetDesignDocumentMock).not.toHaveBeenCalled();
  });

  it('requires documents:write', async () => {
    hasPermMock.mockReturnValue(false);
    const res = await buildApp().request(`/ai/fleet-design/${REPORT_RUN_ID}/document`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(hasPermMock).toHaveBeenCalledWith(PERMISSIONS.DOCUMENTS_WRITE.resource, PERMISSIONS.DOCUMENTS_WRITE.action);
    expect(fileFleetDesignDocumentMock).not.toHaveBeenCalled();
  });
});
