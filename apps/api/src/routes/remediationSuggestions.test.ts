import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
  generateMock: vi.fn(),
  requestResearchMock: vi.fn(),
  sourceDeviceMock: vi.fn(),
  researchStatusMock: vi.fn(),
  lookupMock: vi.fn(),
  emitFeedbackMock: vi.fn(),
  executeScriptOnDevicesMock: vi.fn(),
  dispatchBuiltinMock: vi.fn(),
  recordBuiltinMock: vi.fn(),
  recordOutcomeMock: vi.fn(async () => ({ state: 'pending', stateReason: null, humanVote: null })),
  recordVoteMock: vi.fn(),
  createDoneMock: vi.fn(),
  loadActiveInstructionsMock: vi.fn(),
  loadSummariesMock: vi.fn(async () => new Map()),
  // #7109 — models withAuthDbAccessContext as a context that COMMITS when its
  // callback returns; `depth` says whether a DB call ran inside one.
  dbContextState: { depth: 0, events: [] as string[] },
}));

const withAuthDbAccessContextMock = vi.hoisted(() => vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => {
  dbMocks.dbContextState.depth += 1;
  try {
    return await fn();
  } finally {
    dbMocks.dbContextState.depth -= 1;
    dbMocks.dbContextState.events.push('commit');
  }
}));

let currentPermissions: { allowedSiteIds?: string[]; permissions?: Array<{ resource: string; action: string }> } | undefined;

vi.mock('../db', () => ({
  db: {
    select: dbMocks.selectMock,
    insert: dbMocks.insertMock,
    update: dbMocks.updateMock,
  },
  withDbTransaction: async (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
  },
  mlFeedbackEvents: {
    orgId: 'mlFeedbackEvents.orgId',
    sourceType: 'mlFeedbackEvents.sourceType',
    sourceId: 'mlFeedbackEvents.sourceId',
    eventType: 'mlFeedbackEvents.eventType',
    occurredAt: 'mlFeedbackEvents.occurredAt',
  },
  elevationRequests: {
    id: 'elevationRequests.id',
    orgId: 'elevationRequests.orgId',
    deviceId: 'elevationRequests.deviceId',
    status: 'elevationRequests.status',
    requestedAt: 'elevationRequests.requestedAt',
    approvedAt: 'elevationRequests.approvedAt',
    expiresAt: 'elevationRequests.expiresAt',
  },
  elevationAudit: {
    id: 'elevationAudit.id',
  },
  remediationSuggestions: {
    id: 'remediationSuggestions.id',
    orgId: 'remediationSuggestions.orgId',
    sourceType: 'remediationSuggestions.sourceType',
    sourceId: 'remediationSuggestions.sourceId',
    deviceId: 'remediationSuggestions.deviceId',
    status: 'remediationSuggestions.status',
    createdAt: 'remediationSuggestions.createdAt',
    acceptedAt: 'remediationSuggestions.acceptedAt',
    executedAt: 'remediationSuggestions.executedAt',
    elevationRequestId: 'remediationSuggestions.elevationRequestId',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '11111111-1111-4111-8111-111111111111',
      partnerId: null,
      accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'],
      orgCondition: () => undefined,
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-4111-8111-111111111111',
    });
    c.set('permissions', currentPermissions ?? { permissions: [] });
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  withAuthDbAccessContext: withAuthDbAccessContextMock,
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: dbMocks.writeRouteAuditMock,
}));

vi.mock('../services/remediationSuggestions', () => ({
  generateRemediationSuggestions: dbMocks.generateMock,
}));

vi.mock('../services/fixMemory/research', () => ({
  requestResearch: dbMocks.requestResearchMock,
  researchStatusForSource: dbMocks.researchStatusMock,
  researchSourceDeviceId: dbMocks.sourceDeviceMock,
}));
vi.mock('../services/fixMemory/instructions', () => ({ loadActiveInstructions: dbMocks.loadActiveInstructionsMock }));
vi.mock('../services/fixMemory/lookup', () => ({ lookupFixes: dbMocks.lookupMock }));
vi.mock('../services/fixMemory/signatureLoader', () => ({
  signatureForSource: vi.fn(async () => ({ signature: { broad: false } })),
  sourceRefFor: vi.fn(() => ({ kind: 'alert', alertId: 'a-1' })),
}));
vi.mock('../services/fixMemory/catalog', () => ({ resolveOrgPartnerId: vi.fn(async () => 'p-1') }));

const captureExceptionMock = vi.hoisted(() => vi.fn());
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));

vi.mock('../services/mlFeedbackEmitters', () => ({
  emitRemediationSuggestionFeedback: dbMocks.emitFeedbackMock,
}));

vi.mock('../services/scriptExecution', () => ({
  executeScriptOnDevices: dbMocks.executeScriptOnDevicesMock,
}));

vi.mock('../services/fixMemory/builtinActions', () => ({
  dispatchBuiltinAction: dbMocks.dispatchBuiltinMock,
  clampBuiltinRisk: (_a: string, r: string) => r,
}));
vi.mock('../services/fixMemory/outcomeRecorder', () => ({
  recordBuiltinOutcome: dbMocks.recordBuiltinMock,
  recordExecutionOutcome: dbMocks.recordOutcomeMock,
  recordOutcomeVote: dbMocks.recordVoteMock,
  createManualStepsOutcome: dbMocks.createDoneMock,
  loadOutcomeSummaries: dbMocks.loadSummariesMock,
}));

import { remediationSuggestionRoutes, resolvePatchedRiskTier } from './remediationSuggestions';

describe('resolvePatchedRiskTier (security review #1: execution-approval downgrade guard)', () => {
  it('keeps the stored tier when the client omits riskTier', () => {
    expect(resolvePatchedRiskTier('critical', undefined)).toBe('critical');
    expect(resolvePatchedRiskTier('high', null)).toBe('high');
  });

  it('refuses to LOWER the stored tier (the bypass)', () => {
    // critical→low downgrade would make /execute skip the elevation approval.
    expect(resolvePatchedRiskTier('critical', 'low')).toBe('critical');
    expect(resolvePatchedRiskTier('high', 'medium')).toBe('high');
    expect(resolvePatchedRiskTier('medium', 'low')).toBe('medium');
  });

  it('allows RAISING the tier (more approval is always safe)', () => {
    expect(resolvePatchedRiskTier('low', 'critical')).toBe('critical');
    expect(resolvePatchedRiskTier('medium', 'high')).toBe('high');
  });

  it('keeps equal tiers and treats an unknown stored tier as lowest rank', () => {
    expect(resolvePatchedRiskTier('high', 'high')).toBe('high');
    // unknown stored tier (rank -1) → any valid requested tier is a raise.
    expect(resolvePatchedRiskTier('weird', 'low')).toBe('low');
  });
});

const baseSuggestion = {
  id: '22222222-2222-4222-8222-222222222222',
  orgId: '11111111-1111-4111-8111-111111111111',
  sourceType: 'anomaly',
  sourceId: '33333333-3333-4333-8333-333333333333',
  deviceId: '44444444-4444-4444-8444-444444444444',
  alertId: null,
  anomalyId: '33333333-3333-4333-8333-333333333333',
  correlationGroupId: null,
  rcaId: null,
  targetType: 'script',
  scriptId: '55555555-5555-4555-8555-555555555555',
  scriptTemplateId: null,
  playbookId: null,
  title: 'Disk Cleanup',
  rationale: 'Matched disk cleanup terms.',
  expectedAction: 'Run script through existing execution flow.',
  riskTier: 'medium',
  status: 'suggested',
  confidence: 0.82,
  evidence: {},
  parameters: {},
  targetDeviceIds: ['44444444-4444-4444-8444-444444444444'],
  elevationRequestId: null,
  toolExecutionId: null,
  scriptExecutionId: null,
  playbookExecutionId: null,
  failureMessage: null,
  createdAt: new Date('2026-06-18T12:00:00.000Z'),
  updatedAt: new Date('2026-06-18T12:00:00.000Z'),
  acceptedAt: null,
  rejectedAt: null,
  executedAt: null,
};

function createSelectChain(result: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'innerJoin', 'groupBy', 'orderBy', 'limit']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return chain;
}

function mockSelectOnce(result: unknown) {
  dbMocks.selectMock.mockReturnValueOnce(createSelectChain(result));
}

function mockSuggestionLoad(suggestion: Record<string, unknown>) {
  dbMocks.selectMock.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([suggestion]),
      }),
    }),
  });
}

function mockElevationLoad(elevation: Record<string, unknown> | undefined) {
  dbMocks.selectMock.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(elevation ? [elevation] : []),
      }),
    }),
  });
}

function mockDeviceLoad(device: Record<string, unknown> | undefined = {
  id: baseSuggestion.deviceId,
  orgId: baseSuggestion.orgId,
  siteId: '99999999-9999-4999-8999-999999999999',
}) {
  dbMocks.selectMock.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(device ? [device] : []),
      }),
    }),
  });
}

function mockInsertReturning(row: Record<string, unknown> | undefined) {
  const returning = vi.fn().mockResolvedValue(row ? [row] : []);
  const values = vi.fn().mockReturnValue({ returning });
  dbMocks.insertMock.mockReturnValueOnce({ values });
  return { values, returning };
}

function mockInsertValuesOnly() {
  const values = vi.fn().mockResolvedValue(undefined);
  dbMocks.insertMock.mockReturnValueOnce({ values });
  return { values };
}

describe('remediation suggestion routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    currentPermissions = undefined;
    dbMocks.dbContextState.depth = 0;
    dbMocks.dbContextState.events = [];
    app = new Hono();
    app.route('/remediation-suggestions', remediationSuggestionRoutes);
  });

  it('generates source suggestions through the feature-gated service', async () => {
    dbMocks.generateMock.mockResolvedValueOnce({
      orgId: baseSuggestion.orgId,
      sourceType: 'anomaly',
      sourceId: baseSuggestion.sourceId,
      skipped: false,
      suggestions: [baseSuggestion],
    });

    const res = await app.request('/remediation-suggestions/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ sourceType: 'anomaly', sourceId: baseSuggestion.sourceId, limit: 3 }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.generateMock).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'anomaly',
      sourceId: baseSuggestion.sourceId,
      actorUserId: 'user-1',
    }), { runInDbContext: expect.any(Function) });
    const body = await res.json();
    expect(body.data[0].title).toBe('Disk Cleanup');
    expect(dbMocks.writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ml.remediation_suggestions.generate',
    }));
  });

  it('Generate returns each suggestion hydrated with its fix outcome, like the list (I4)', async () => {
    dbMocks.generateMock.mockResolvedValueOnce({
      orgId: baseSuggestion.orgId, sourceType: 'anomaly', sourceId: baseSuggestion.sourceId, skipped: false,
      suggestions: [baseSuggestion],
    });
    const outcome = { state: 'holding', stateReason: 'condition_cleared', humanVote: null };
    dbMocks.loadSummariesMock.mockResolvedValueOnce(new Map([[baseSuggestion.id, outcome]]) as never);

    const res = await app.request('/remediation-suggestions/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ sourceType: 'anomaly', sourceId: baseSuggestion.sourceId, limit: 3 }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.loadSummariesMock).toHaveBeenCalledWith([baseSuggestion.id]);
    const body = await res.json();
    expect(body.data[0].outcome).toEqual(outcome);
  });

  it('updates suggestion status and emits feedback', async () => {
    mockSuggestionLoad(baseSuggestion);
    dbMocks.updateMock.mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...baseSuggestion, status: 'accepted', acceptedBy: 'user-1', acceptedAt: new Date('2026-06-18T12:05:00.000Z') }]),
        }),
      }),
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'accepted' }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.emitFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: baseSuggestion.orgId,
      suggestionId: baseSuggestion.id,
      eventType: 'suggestion.accepted',
      dedupeKey: 'status:accepted',
      outcome: 'accepted',
      actorUserId: 'user-1',
    }));
    const body = await res.json();
    expect(body.data.status).toBe('accepted');
  });

  it('carries builtinAction in the feedback metadata when a built-in suggestion is accepted', async () => {
    const builtin = { ...baseSuggestion, targetType: 'builtin_action', builtinAction: 'restart_service', scriptId: null };
    mockSuggestionLoad(builtin);
    dbMocks.updateMock.mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...builtin, status: 'accepted', acceptedBy: 'user-1', acceptedAt: new Date('2026-06-18T12:05:00.000Z') }]),
        }),
      }),
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'accepted' }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.emitFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'suggestion.accepted',
      metadata: expect.objectContaining({ targetType: 'builtin_action', builtinAction: 'restart_service' }),
    }));
  });

  it('creates and links a pending elevation request for accepted high-risk script suggestions', async () => {
    const accepted = {
      ...baseSuggestion,
      status: 'accepted',
      riskTier: 'high',
    };
    const elevationRequestId = '88888888-8888-4888-8888-888888888888';
    mockSuggestionLoad(accepted);
    mockDeviceLoad();
    const elevationInsert = mockInsertReturning({
      id: elevationRequestId,
      status: 'pending',
      expiresAt: null,
    });
    const auditInsert = mockInsertValuesOnly();
    dbMocks.updateMock.mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            ...accepted,
            elevationRequestId,
            updatedAt: new Date('2026-06-18T12:05:00.000Z'),
          }]),
        }),
      }),
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/elevation-request`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(201);
    expect(elevationInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      orgId: baseSuggestion.orgId,
      siteId: '99999999-9999-4999-8999-999999999999',
      deviceId: baseSuggestion.deviceId,
      flowType: 'tech_jit_admin',
      subjectUserId: 'user-1',
      subjectUsername: 'test@example.com',
      status: 'pending',
      riskTier: 3,
      metadata: expect.objectContaining({
        triggerSource: 'remediation_suggestion',
        remediationSuggestionId: baseSuggestion.id,
        scriptId: baseSuggestion.scriptId,
      }),
    }));
    expect(auditInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      orgId: baseSuggestion.orgId,
      elevationRequestId,
      eventType: 'requested',
      actor: 'technician',
      actorUserId: 'user-1',
    }));
    expect(dbMocks.writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ml.remediation_suggestion.request_elevation',
      resourceId: baseSuggestion.id,
    }));
    const body = await res.json();
    expect(body.data.elevationRequestId).toBe(elevationRequestId);
    expect(body.elevationRequest).toEqual({
      id: elevationRequestId,
      status: 'pending',
      expiresAt: null,
    });
  });

  it('returns an existing pending linked elevation request idempotently', async () => {
    const elevationRequestId = '88888888-8888-4888-8888-888888888888';
    const accepted = {
      ...baseSuggestion,
      status: 'accepted',
      riskTier: 'critical',
      elevationRequestId,
    };
    mockSuggestionLoad(accepted);
    mockDeviceLoad();
    mockElevationLoad({
      id: elevationRequestId,
      orgId: baseSuggestion.orgId,
      deviceId: baseSuggestion.deviceId,
      status: 'pending',
      expiresAt: null,
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/elevation-request`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(dbMocks.insertMock).not.toHaveBeenCalled();
    expect(dbMocks.updateMock).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.data.elevationRequestId).toBe(elevationRequestId);
    expect(body.elevationRequest).toEqual({
      id: elevationRequestId,
      status: 'pending',
      expiresAt: null,
    });
  });

  it('rejects elevation requests for medium-risk suggestions', async () => {
    mockSuggestionLoad({ ...baseSuggestion, status: 'accepted', riskTier: 'medium' });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/elevation-request`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Only high-risk remediation suggestions require elevation approval',
    });
    expect(dbMocks.insertMock).not.toHaveBeenCalled();
  });

  it('rejects elevation requests before acceptance', async () => {
    mockSuggestionLoad({ ...baseSuggestion, riskTier: 'high' });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/elevation-request`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Suggestion must be accepted or edited before requesting approval',
    });
    expect(dbMocks.insertMock).not.toHaveBeenCalled();
  });

  it('rejects elevation requests for multi-device script suggestions', async () => {
    mockSuggestionLoad({
      ...baseSuggestion,
      status: 'accepted',
      riskTier: 'high',
      targetDeviceIds: [
        '44444444-4444-4444-8444-444444444444',
        '77777777-7777-4777-8777-777777777777',
      ],
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/elevation-request`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Remediation approval requires exactly one target device',
    });
    expect(dbMocks.insertMock).not.toHaveBeenCalled();
  });

  it('rejects elevation requests when the target device is outside site scope', async () => {
    currentPermissions = { allowedSiteIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] };
    mockSuggestionLoad({ ...baseSuggestion, status: 'accepted', riskTier: 'high' });
    mockDeviceLoad({
      id: baseSuggestion.deviceId,
      orgId: baseSuggestion.orgId,
      siteId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/elevation-request`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Target device not found or access denied' });
    expect(dbMocks.insertMock).not.toHaveBeenCalled();
  });

  it('rejects existing linked elevation requests for another target device', async () => {
    const elevationRequestId = '88888888-8888-4888-8888-888888888888';
    mockSuggestionLoad({
      ...baseSuggestion,
      status: 'accepted',
      riskTier: 'high',
      elevationRequestId,
    });
    mockDeviceLoad();
    mockElevationLoad({
      id: elevationRequestId,
      orgId: baseSuggestion.orgId,
      deviceId: '77777777-7777-4777-8777-777777777777',
      status: 'pending',
      expiresAt: null,
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/elevation-request`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Elevation request must target the suggested device' });
    expect(dbMocks.insertMock).not.toHaveBeenCalled();
  });

  it('rejects script execution status updates through the generic patch route', async () => {
    mockSuggestionLoad({ ...baseSuggestion, status: 'accepted' });
    const scriptExecutionId = '66666666-6666-4666-8666-666666666666';

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'executed', scriptExecutionId }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Execution statuses must be set through the dedicated remediation execution rail');
    expect(dbMocks.updateMock).not.toHaveBeenCalled();
    expect(dbMocks.emitFeedbackMock).not.toHaveBeenCalled();
    expect(dbMocks.executeScriptOnDevicesMock).not.toHaveBeenCalled();
  });

  it('rejects tool execution status updates through the generic patch route', async () => {
    const toolExecutionId = '77777777-7777-4777-8777-777777777777';
    mockSuggestionLoad({
      ...baseSuggestion,
      status: 'accepted',
      targetType: 'tool',
      scriptId: null,
      toolExecutionId,
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        status: 'executed',
        toolExecutionId,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Execution statuses must be set through the dedicated remediation execution rail');
    expect(dbMocks.updateMock).not.toHaveBeenCalled();
    expect(dbMocks.emitFeedbackMock).not.toHaveBeenCalled();
  });

  it('rejects playbook failure status updates through the generic patch route', async () => {
    const playbookExecutionId = '88888888-8888-4888-8888-888888888888';
    mockSuggestionLoad({
      ...baseSuggestion,
      status: 'accepted',
      targetType: 'playbook',
      scriptId: null,
      playbookId: '99999999-9999-4999-8999-999999999999',
      playbookExecutionId,
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'failed', playbookExecutionId, failureMessage: 'Playbook failed' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Execution statuses must be set through the dedicated remediation execution rail');
    expect(dbMocks.updateMock).not.toHaveBeenCalled();
    expect(dbMocks.emitFeedbackMock).not.toHaveBeenCalled();
  });

  describe('built-in execute (W2 Task 15)', () => {
    const builtinRow = {
      ...baseSuggestion, targetType: 'builtin_action', builtinAction: 'restart_service', scriptId: null,
      status: 'accepted', riskTier: 'medium', parameters: { serviceName: 'Spooler' },
    };
    const run = () => app.request(`/remediation-suggestions/${builtinRow.id}/execute`, { method: 'POST', headers: { Authorization: 'Bearer token' } });
    const withDevicesExecute = () => { currentPermissions = { permissions: [{ resource: 'devices', action: 'execute' }] }; };
    const deviceRow = { id: builtinRow.deviceId, orgId: builtinRow.orgId, siteId: '99999999-9999-4999-8999-999999999999', osType: 'windows', agentVersion: '1.0.0', status: 'online' };
    const phase3Row = { ...builtinRow, status: 'executed', executedBy: 'user-1', executedAt: new Date('2026-06-18T12:10:00.000Z') };
    // A5: the gate's conditional claim (accepted/edited -> executed) and phase 3's idempotent update.
    const updateCalls: Array<{ depth: number; set: Record<string, unknown> }> = [];
    const mockUpdateReturning = (rows: unknown[]) => {
      dbMocks.updateMock.mockImplementationOnce(() => ({
        set: vi.fn((set: Record<string, unknown>) => {
          updateCalls.push({ depth: dbMocks.dbContextState.depth, set });
          return { where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }) };
        }),
      }));
    };
    const mockClaim = (claimed = true) => mockUpdateReturning(claimed ? [phase3Row] : []);
    const mockPhase3 = (depths?: Record<string, number>) => {
      dbMocks.updateMock.mockImplementationOnce(() => {
        if (depths) depths.update = dbMocks.dbContextState.depth;
        return { set: vi.fn((set: Record<string, unknown>) => {
          updateCalls.push({ depth: dbMocks.dbContextState.depth, set });
          return { where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([phase3Row]) }) };
        }) };
      });
    };
    beforeEach(() => { updateCalls.length = 0; });

    it('needs devices:execute on top of scripts:execute', async () => {
      mockSuggestionLoad(builtinRow);
      currentPermissions = { permissions: [{ resource: 'scripts', action: 'execute' }] };
      const res = await run();
      expect(res.status).toBe(403);
      expect(dbMocks.dispatchBuiltinMock).not.toHaveBeenCalled();
    });

    it('claims the row in the gate context, dispatches outside any db context, then records the attempt inside one', async () => {
      withDevicesExecute();
      const depths: Record<string, number> = {};
      mockSuggestionLoad(builtinRow);
      mockDeviceLoad(deviceRow);
      mockClaim();
      dbMocks.dispatchBuiltinMock.mockImplementationOnce(async () => {
        depths.dispatch = dbMocks.dbContextState.depth;
        return { ok: true, commandId: 'cmd-1', cleanupRunId: null };
      });
      mockPhase3(depths);
      dbMocks.recordBuiltinMock.mockImplementationOnce(async () => {
        depths.record = dbMocks.dbContextState.depth;
        return { state: 'pending', stateReason: null, humanVote: null };
      });
      const res = await run();
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data).toMatchObject({ status: 'executed', builtinAction: 'restart_service', outcome: { state: 'pending' } });
      expect(body.execution).toEqual({ commandId: 'cmd-1', cleanupRunId: null });
      expect(dbMocks.dispatchBuiltinMock).toHaveBeenCalledWith({
        action: 'restart_service', parameters: { serviceName: 'Spooler' }, device: expect.objectContaining({ id: builtinRow.deviceId, osType: 'windows' }), userId: 'user-1',
      });
      expect(dbMocks.recordBuiltinMock).toHaveBeenCalledWith({
        suggestion: expect.objectContaining({ id: builtinRow.id }), deviceId: builtinRow.deviceId, commandId: 'cmd-1', cleanupRunId: null,
      });
      expect(dbMocks.emitFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'executed:command:cmd-1' }));
      // The claim commits in the gate context BEFORE dispatch; nothing is held across dispatch; link + record share phase 3's.
      expect(updateCalls[0]).toMatchObject({ depth: 1, set: expect.objectContaining({ status: 'executed', executedBy: 'user-1' }) });
      expect(dbMocks.dbContextState.events[0]).toBe('commit');
      expect(depths.dispatch).toBe(0);
      expect(depths.update).toBeGreaterThan(0);
      expect(depths.record).toBeGreaterThan(0);
    });

    it('A5: a claim that matches no row (a concurrent /execute won) is a 409 and nothing is dispatched', async () => {
      withDevicesExecute();
      mockSuggestionLoad(builtinRow);
      mockDeviceLoad(deviceRow);
      mockClaim(false);
      const res = await run();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'already_dispatching' });
      expect(dbMocks.dispatchBuiltinMock).not.toHaveBeenCalled();
    });

    it('surfaces a dispatch refusal with its status and code, releases the claim, and records nothing', async () => {
      withDevicesExecute();
      mockSuggestionLoad(builtinRow);
      mockDeviceLoad(deviceRow);
      mockClaim();
      dbMocks.dispatchBuiltinMock.mockResolvedValueOnce({ ok: false, status: 409, error: 'process_ambiguous' });
      mockUpdateReturning([builtinRow]);
      const res = await run();
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'process_ambiguous' });
      expect(updateCalls).toHaveLength(2);
      expect(updateCalls[1]).toMatchObject({ depth: 1, set: expect.objectContaining({ status: 'accepted', executedBy: null, executedAt: null }) });
      expect(dbMocks.recordBuiltinMock).not.toHaveBeenCalled();
      expect(dbMocks.emitFeedbackMock).not.toHaveBeenCalled();
    });

    it('A5: dispatch ok but phase 3 throws -> 202 dispatched/not recorded with the commandId, captured, claim kept', async () => {
      withDevicesExecute();
      mockSuggestionLoad(builtinRow);
      mockDeviceLoad(deviceRow);
      mockClaim();
      dbMocks.dispatchBuiltinMock.mockResolvedValueOnce({ ok: true, commandId: 'cmd-7', cleanupRunId: null });
      mockPhase3();
      dbMocks.emitFeedbackMock.mockRejectedValueOnce(new Error('feedback down'));
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = await run();
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ dispatched: true, recorded: false, commandId: 'cmd-7' });
      expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ suggestionId: builtinRow.id, commandId: 'cmd-7' }));
      // No release: only the claim + the failed phase-3 update ran.
      expect(updateCalls.map((c) => c.set.status)).toEqual(['executed', undefined]);
      err.mockRestore();
    });

    it('a high-risk built-in (reboot) still requires an approved elevation', async () => {
      withDevicesExecute();
      mockSuggestionLoad({ ...builtinRow, builtinAction: 'reboot', parameters: {}, riskTier: 'high', elevationRequestId: null });
      const res = await run();
      expect(res.status).toBe(403);
      expect(dbMocks.dispatchBuiltinMock).not.toHaveBeenCalled();
    });

    it('a device the caller cannot reach is a 404 and nothing is dispatched', async () => {
      withDevicesExecute();
      mockSuggestionLoad(builtinRow);
      mockSelectOnce([]);
      const res = await run();
      expect(res.status).toBe(404);
      expect(dbMocks.dispatchBuiltinMock).not.toHaveBeenCalled();
    });

    it('A5: an already-executed (or claimed) built-in is a 409 before dispatch, so a retry never re-sends', async () => {
      withDevicesExecute();
      mockSuggestionLoad({ ...builtinRow, status: 'executed' });
      const res = await run();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'already_executed' });
      expect(dbMocks.dispatchBuiltinMock).not.toHaveBeenCalled();
      expect(dbMocks.updateMock).not.toHaveBeenCalled();
    });

    it('refuses a built-in elevation request without devices:execute', async () => {
      currentPermissions = { permissions: [{ resource: 'scripts', action: 'execute' }] };
      mockSuggestionLoad({ ...builtinRow, builtinAction: 'reboot', riskTier: 'high', elevationRequestId: null, parameters: {} });
      const res = await app.request(`/remediation-suggestions/${builtinRow.id}/elevation-request`, { method: 'POST', headers: { Authorization: 'Bearer token' } });
      expect(res.status).toBe(403);
      expect(dbMocks.insertMock).not.toHaveBeenCalled();
    });

    it('accepts a built-in row for an elevation request', async () => {
      withDevicesExecute();
      mockSuggestionLoad({ ...builtinRow, builtinAction: 'reboot', riskTier: 'high', elevationRequestId: null, parameters: {} });
      mockDeviceLoad();
      const { values: insertValues } = mockInsertReturning({ id: 'el-1', status: 'pending', expiresAt: null });
      mockInsertValuesOnly();
      dbMocks.updateMock.mockReturnValueOnce({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ ...builtinRow, riskTier: 'high', elevationRequestId: 'el-1', updatedAt: new Date(), createdAt: new Date() }]) }) }) });
      const res = await app.request(`/remediation-suggestions/${builtinRow.id}/elevation-request`, { method: 'POST', headers: { Authorization: 'Bearer token' } });
      expect(res.status).toBe(201);
      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
        reason: expect.stringContaining('requires approval before it runs'),
        metadata: expect.objectContaining({ builtinAction: 'reboot' }),
      }));
    });
  });

  it('executes accepted script suggestions through the server-side script rail', async () => {
    const accepted = { ...baseSuggestion, status: 'accepted' };
    const scriptExecutionId = '66666666-6666-4666-8666-666666666666';
    const depths: Record<string, number> = {};
    mockSuggestionLoad(accepted);
    dbMocks.executeScriptOnDevicesMock.mockResolvedValueOnce({
      ok: true,
      admission: {
        requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'queued',
        targets: [{
          requestedDeviceId: baseSuggestion.deviceId,
          admission: 'admitted',
          executionId: scriptExecutionId,
          commandId: '77777777-7777-4777-8777-777777777777',
        }],
      },
      script: { id: baseSuggestion.scriptId, name: 'Disk Cleanup' },
      ignoredParameters: [],
      triggerType: 'manual',
      runAs: 'system',
      auditOrgId: baseSuggestion.orgId,
    });
    dbMocks.updateMock.mockImplementationOnce(() => {
      depths.update = dbMocks.dbContextState.depth;
      return {
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              ...accepted,
              status: 'executed',
              scriptExecutionId,
              executedBy: 'user-1',
              executedAt: new Date('2026-06-18T12:10:00.000Z'),
            }]),
          }),
        }),
      };
    });
    dbMocks.recordOutcomeMock.mockImplementationOnce(async () => {
      depths.recordOutcome = dbMocks.dbContextState.depth;
      return { state: 'pending', stateReason: null, humanVote: null };
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(201);
    expect(dbMocks.executeScriptOnDevicesMock).toHaveBeenCalledWith(expect.objectContaining({
      scriptId: baseSuggestion.scriptId,
      deviceIds: [baseSuggestion.deviceId],
      parameters: baseSuggestion.parameters,
      triggerType: 'manual',
    }));
    expect(dbMocks.emitFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'suggestion.executed',
      dedupeKey: `executed:script:${scriptExecutionId}`,
      outcome: 'executed',
      metadata: expect.objectContaining({
        route: 'remediation_suggestions.execute',
        scriptExecutionId,
      }),
    }));
    const body = await res.json();
    expect(body.data.status).toBe('executed');
    expect(body.data.scriptExecutionId).toBe(scriptExecutionId);
    expect(body.execution.targets[0].executionId).toBe(scriptExecutionId);
    expect(dbMocks.recordOutcomeMock).toHaveBeenCalledWith({
      suggestion: expect.objectContaining({ id: baseSuggestion.id, orgId: baseSuggestion.orgId }),
      deviceId: baseSuggestion.deviceId,
      scriptExecutionId,
    });
    // The panel swaps its row for this response, so the outcome must be on it.
    expect(body.data.outcome).toEqual({ state: 'pending', stateReason: null, humanVote: null });
    // Must ride the SAME context/transaction that produced the link (phase 3),
    // not a separate context opened after it closed — that's the atomicity
    // this fix restores (see Task 18 review, IMPORTANT 1).
    expect(depths.recordOutcome).toBeGreaterThan(0);
    expect(depths.recordOutcome).toBe(depths.update);
  });

  // #7109 — the route is registered in selfManagedDbContextRoutes.ts, so no
  // request transaction wraps it. The execution rows must commit before the
  // command is sent, and the suggestion's own reads and writes run in short
  // contexts of their own — never one held across the service (#6671).
  describe('commit-before-send (#7109)', () => {
    const scriptExecutionId = '66666666-6666-4666-8666-666666666666';
    const admitted = () => ({
      ok: true,
      admission: {
        requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'queued',
        targets: [{
          requestedDeviceId: baseSuggestion.deviceId,
          admission: 'admitted',
          executionId: scriptExecutionId,
          commandId: '77777777-7777-4777-8777-777777777777',
        }],
      },
      script: { id: baseSuggestion.scriptId, name: 'Disk Cleanup' },
      ignoredParameters: [],
      triggerType: 'manual',
      runAs: 'system',
      auditOrgId: baseSuggestion.orgId,
    });
    const depths: Record<string, number> = {};
    const mockExecutedUpdate = (accepted: Record<string, unknown>) => {
      dbMocks.updateMock.mockImplementationOnce(() => {
        depths.update = dbMocks.dbContextState.depth;
        return {
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ ...accepted, status: 'executed', scriptExecutionId }]),
            }),
          }),
        };
      });
    };

    beforeEach(() => {
      for (const key of Object.keys(depths)) delete depths[key];
    });

    it('sends only after the context that created the execution rows committed', async () => {
      const accepted = { ...baseSuggestion, status: 'accepted' };
      mockSuggestionLoad(accepted);
      // Stands in for executeScriptOnDevices' contract (#7103, pinned in
      // scriptExecution.commitBeforeSend.test.ts): rows are created through
      // the runner when one is given, else inline; the send follows.
      dbMocks.executeScriptOnDevicesMock.mockImplementationOnce(async (input: { runInDbContext?: <T>(fn: () => Promise<T>) => Promise<T> }) => {
        const createRows = async () => {
          dbMocks.dbContextState.events.push(dbMocks.dbContextState.depth > 0 ? 'rows:in-context' : 'rows:contextless');
        };
        if (input.runInDbContext) await input.runInDbContext(createRows);
        else await createRows();
        dbMocks.dbContextState.events.push('send');
        return admitted();
      });
      mockExecutedUpdate(accepted);

      const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(201);
      const { events } = dbMocks.dbContextState;
      const rows = events.indexOf('rows:in-context');
      const send = events.indexOf('send');
      expect(rows).toBeGreaterThanOrEqual(0);
      expect(send).toBeGreaterThan(rows);
      expect(events.slice(rows + 1, send)).toContain('commit');
    });

    it('passes a runner that opens the caller\'s own DB access context', async () => {
      const accepted = { ...baseSuggestion, status: 'accepted' };
      mockSuggestionLoad(accepted);
      dbMocks.executeScriptOnDevicesMock.mockResolvedValueOnce(admitted());
      mockExecutedUpdate(accepted);

      await app.request(`/remediation-suggestions/${baseSuggestion.id}/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      const input = dbMocks.executeScriptOnDevicesMock.mock.calls[0]![0];
      expect(typeof input.runInDbContext).toBe('function');
      withAuthDbAccessContextMock.mockClear();
      const inner = vi.fn(async () => 'ran');
      await expect(input.runInDbContext(inner)).resolves.toBe('ran');
      expect(withAuthDbAccessContextMock).toHaveBeenCalledWith(input.auth, inner);
    });

    it('loads and updates the suggestion in contexts, never holding one across the service', async () => {
      const accepted = { ...baseSuggestion, status: 'accepted' };
      dbMocks.selectMock.mockImplementationOnce(() => {
        depths.load = dbMocks.dbContextState.depth;
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([accepted]) }),
          }),
        };
      });
      dbMocks.executeScriptOnDevicesMock.mockImplementationOnce(async () => {
        depths.service = dbMocks.dbContextState.depth;
        return admitted();
      });
      mockExecutedUpdate(accepted);
      dbMocks.emitFeedbackMock.mockImplementationOnce(async () => {
        depths.feedback = dbMocks.dbContextState.depth;
      });

      const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(201);
      expect(depths).toEqual({ load: 1, service: 0, update: 1, feedback: 1 });
    });

    // The execution is already committed and sent when the link fails, so the
    // route must say so with a 500 and write neither feedback nor a success
    // audit for a link that never happened.
    it('returns 500 without feedback or audit when the link update matches no row', async () => {
      const accepted = { ...baseSuggestion, status: 'accepted' };
      mockSuggestionLoad(accepted);
      dbMocks.executeScriptOnDevicesMock.mockResolvedValueOnce(admitted());
      dbMocks.updateMock.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to update suggestion' });
      expect(dbMocks.executeScriptOnDevicesMock).toHaveBeenCalledTimes(1);
      expect(dbMocks.emitFeedbackMock).not.toHaveBeenCalled();
      expect(dbMocks.writeRouteAuditMock).not.toHaveBeenCalled();
    });
  });

  it('returns 422 for rejected admission without mutating or auditing the suggestion', async () => {
    const accepted = { ...baseSuggestion, status: 'accepted' };
    mockSuggestionLoad(accepted);
    dbMocks.executeScriptOnDevicesMock.mockResolvedValueOnce({
      ok: true,
      admission: {
        requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'rejected',
        targets: [{
          requestedDeviceId: baseSuggestion.deviceId,
          admission: 'denied',
          reasonCode: 'site_access_denied',
        }],
      },
      script: { id: baseSuggestion.scriptId, name: 'Disk Cleanup' },
      ignoredParameters: [],
      triggerType: 'manual',
      runAs: 'system',
      auditOrgId: baseSuggestion.orgId,
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ admission: 'denied', reasonCode: 'site_access_denied' });
    expect(dbMocks.updateMock).not.toHaveBeenCalled();
    expect(dbMocks.emitFeedbackMock).not.toHaveBeenCalled();
    expect(dbMocks.writeRouteAuditMock).not.toHaveBeenCalled();
    expect(dbMocks.recordOutcomeMock).not.toHaveBeenCalled();
  });

  it('blocks high-risk server-side execution without an approved elevation request', async () => {
    mockSuggestionLoad({
      ...baseSuggestion,
      status: 'accepted',
      riskTier: 'high',
      elevationRequestId: null,
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'High-risk remediation execution requires an approved elevation request',
    });
    expect(dbMocks.executeScriptOnDevicesMock).not.toHaveBeenCalled();
    expect(dbMocks.updateMock).not.toHaveBeenCalled();
  });

  it('blocks high-risk server-side execution when the linked elevation is not visible in the same org', async () => {
    mockSuggestionLoad({
      ...baseSuggestion,
      status: 'accepted',
      riskTier: 'critical',
      elevationRequestId: '88888888-8888-4888-8888-888888888888',
    });
    mockElevationLoad(undefined);

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Elevation request not found or access denied' });
    expect(dbMocks.executeScriptOnDevicesMock).not.toHaveBeenCalled();
  });

  it('executes high-risk script suggestions only with an approved same-device elevation request', async () => {
    const elevationRequestId = '88888888-8888-4888-8888-888888888888';
    const accepted = {
      ...baseSuggestion,
      status: 'accepted',
      riskTier: 'high',
      elevationRequestId,
    };
    const scriptExecutionId = '66666666-6666-4666-8666-666666666666';

    mockSuggestionLoad(accepted);
    mockElevationLoad({
      id: elevationRequestId,
      orgId: baseSuggestion.orgId,
      deviceId: baseSuggestion.deviceId,
      status: 'approved',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    });
    dbMocks.executeScriptOnDevicesMock.mockResolvedValueOnce({
      ok: true,
      admission: {
        requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        status: 'queued',
        targets: [{
          requestedDeviceId: baseSuggestion.deviceId,
          admission: 'admitted',
          executionId: scriptExecutionId,
          commandId: '77777777-7777-4777-8777-777777777777',
        }],
      },
      script: { id: baseSuggestion.scriptId, name: 'Disk Cleanup' },
      ignoredParameters: [],
      triggerType: 'manual',
      runAs: 'system',
      auditOrgId: baseSuggestion.orgId,
    });
    dbMocks.updateMock.mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            ...accepted,
            status: 'executed',
            scriptExecutionId,
            executedBy: 'user-1',
            executedAt: new Date('2026-06-18T12:10:00.000Z'),
          }]),
        }),
      }),
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(201);
    expect(dbMocks.executeScriptOnDevicesMock).toHaveBeenCalledWith(expect.objectContaining({
      scriptId: baseSuggestion.scriptId,
      deviceIds: [baseSuggestion.deviceId],
    }));
    expect(dbMocks.emitFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'suggestion.executed',
      metadata: expect.objectContaining({
        route: 'remediation_suggestions.execute',
        elevationRequestId,
        riskTier: 'high',
        scriptExecutionId,
      }),
    }));
  });

  it('rejects server-side execution before acceptance', async () => {
    mockSuggestionLoad(baseSuggestion);

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Suggestion must be accepted or edited before it can be executed');
    expect(dbMocks.executeScriptOnDevicesMock).not.toHaveBeenCalled();
  });

  it('returns remediation status rates and lifecycle feedback counts', async () => {
    mockSelectOnce([
      { status: 'suggested', count: 4 },
      { status: 'accepted', count: 3 },
      { status: 'rejected', count: 2 },
      { status: 'executed', count: 1 },
      { status: 'failed', count: 1 },
    ]);
    mockSelectOnce([
      { eventType: 'suggestion.accepted', count: 3 },
      { eventType: 'suggestion.rejected', count: 2 },
      { eventType: 'suggestion.executed', count: 1 },
      { eventType: 'suggestion.failed', count: 1 },
    ]);
    mockSelectOnce([
      {
        acceptedAt: new Date('2026-06-18T12:05:00.000Z'),
        executedAt: new Date('2026-06-18T12:20:00.000Z'),
        elevationRequestedAt: new Date('2026-06-18T12:00:00.000Z'),
        elevationApprovedAt: new Date('2026-06-18T12:10:00.000Z'),
      },
      {
        acceptedAt: new Date('2026-06-18T12:30:00.000Z'),
        executedAt: new Date('2026-06-18T13:10:00.000Z'),
        elevationRequestedAt: new Date('2026-06-18T12:00:00.000Z'),
        elevationApprovedAt: new Date('2026-06-18T12:45:00.000Z'),
      },
    ]);

    const res = await app.request('/remediation-suggestions/evaluation?days=30', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(11);
    expect(body.status).toMatchObject({
      suggested: 4,
      accepted: 3,
      rejected: 2,
      executed: 1,
      failed: 1,
    });
    expect(body.rates).toEqual({
      acceptRate: 3 / 11,
      rejectRate: 2 / 11,
      executeRate: 1 / 11,
      failureRate: 1 / 11,
    });
    expect(body.feedback).toEqual({
      total: 7,
      accepted: 3,
      edited: 0,
      rejected: 2,
      executed: 1,
      failed: 1,
    });
    expect(body.latency).toEqual({
      approval: {
        sampleSize: 2,
        averageMinutes: 27.5,
        p95Minutes: 45,
      },
      execution: {
        sampleSize: 2,
        averageMinutes: 27.5,
        p95Minutes: 40,
      },
    });
    expect(body.window.days).toBe(30);
  });

  it('returns 403 for an inaccessible org filter', async () => {
    const res = await app.request('/remediation-suggestions/evaluation?orgId=99999999-9999-4999-8999-999999999999', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(dbMocks.selectMock).not.toHaveBeenCalled();
  });

  it('returns zero rates when no suggestions match', async () => {
    mockSelectOnce([]);
    mockSelectOnce([]);
    mockSelectOnce([]);

    const res = await app.request('/remediation-suggestions/evaluation?days=7', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(0);
    expect(body.rates).toEqual({ acceptRate: 0, rejectRate: 0, executeRate: 0, failureRate: 0 });
    expect(body.feedback.total).toBe(0);
    expect(body.latency.approval).toEqual({ sampleSize: 0, averageMinutes: null, p95Minutes: null });
    expect(body.latency.execution).toEqual({ sampleSize: 0, averageMinutes: null, p95Minutes: null });
  });

  it('returns 403 when a site-restricted caller drills into an out-of-scope deviceId', async () => {
    currentPermissions = { allowedSiteIds: ['22222222-2222-4222-8222-222222222222'] };
    mockSelectOnce([{ id: baseSuggestion.deviceId, siteId: '33333333-3333-4333-8333-333333333333' }]);

    const res = await app.request(`/remediation-suggestions/evaluation?deviceId=${baseSuggestion.deviceId}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Device not found or access denied');
  });

  it('narrows remediation evaluation to in-scope devices for a site-restricted caller', async () => {
    currentPermissions = { allowedSiteIds: ['22222222-2222-4222-8222-222222222222'] };
    mockSelectOnce([{ id: baseSuggestion.deviceId, siteId: '22222222-2222-4222-8222-222222222222' }]);
    mockSelectOnce([{ status: 'accepted', count: 1 }]);
    mockSelectOnce([{ eventType: 'suggestion.accepted', count: 1 }]);
    mockSelectOnce([]);

    const res = await app.request('/remediation-suggestions/evaluation?days=90', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.status.accepted).toBe(1);
    expect(body.rates.acceptRate).toBe(1);
    expect(body.feedback.accepted).toBe(1);
  });

  const json = (body: unknown) => ({ method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('records a 👎 on an executed suggestion and audits it', async () => {
    mockSuggestionLoad({ ...baseSuggestion, status: 'executed', scriptExecutionId: '66666666-6666-4666-8666-666666666666' });
    dbMocks.recordVoteMock.mockResolvedValueOnce({ state: 'verified', stateReason: 'held_with_fresh_telemetry', humanVote: 'down' });
    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/vote`, json({ vote: 'down' }));
    expect(res.status).toBe(200);
    expect(dbMocks.recordVoteMock).toHaveBeenCalledWith({ suggestionId: baseSuggestion.id, orgId: baseSuggestion.orgId, vote: 'down', userId: 'user-1' });
    expect((await res.json()).data.outcome.humanVote).toBe('down');
    expect(dbMocks.writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'ml.remediation_suggestion.vote' }));
  });

  it('409 when no attempt was recorded for the suggestion', async () => {
    mockSuggestionLoad({ ...baseSuggestion, status: 'accepted' });
    dbMocks.recordVoteMock.mockResolvedValueOnce(null);
    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/vote`, json({ vote: 'up' }));
    expect(res.status).toBe(409);
  });

  it('400 on an invalid vote and 404 on an invisible suggestion', async () => {
    expect((await app.request(`/remediation-suggestions/${baseSuggestion.id}/vote`, json({ vote: 'meh' }))).status).toBe(400);
    mockSelectOnce([]);
    expect((await app.request(`/remediation-suggestions/${baseSuggestion.id}/vote`, json({ vote: 'up' }))).status).toBe(404);
    expect(dbMocks.recordVoteMock).not.toHaveBeenCalled();
  });

  it('403 for a site-restricted user outside the device site', async () => {
    currentPermissions = { allowedSiteIds: ['88888888-8888-4888-8888-888888888888'] };
    mockSuggestionLoad({ ...baseSuggestion, status: 'executed' });
    mockDeviceLoad();
    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/vote`, json({ vote: 'up' }));
    expect(res.status).toBe(403);
    expect(dbMocks.recordVoteMock).not.toHaveBeenCalled();
  });

  it('Done records manual steps once and rejects non-manual targets', async () => {
    const manual = { ...baseSuggestion, targetType: 'manual_steps', scriptId: null, status: 'accepted' };
    mockSuggestionLoad(manual);
    dbMocks.createDoneMock.mockResolvedValueOnce({ state: 'awaiting_recovery', stateReason: 'manual_steps_done', humanVote: null });
    expect((await app.request(`/remediation-suggestions/${baseSuggestion.id}/done`, json({}))).status).toBe(201);

    mockSuggestionLoad(manual);
    dbMocks.createDoneMock.mockResolvedValueOnce(null);
    expect((await app.request(`/remediation-suggestions/${baseSuggestion.id}/done`, json({}))).status).toBe(409);

    mockSuggestionLoad({ ...baseSuggestion, status: 'accepted' });
    expect((await app.request(`/remediation-suggestions/${baseSuggestion.id}/done`, json({}))).status).toBe(400);
  });

  const RID = '66666666-6666-4666-8666-666666666666';
  const manualAccepted = () => mockSuggestionLoad({ ...baseSuggestion, targetType: 'manual_steps', scriptId: null, status: 'accepted' });

  it('Done with an invisible or retired reviewed row is a 404, not a silent unreviewed Done', async () => {
    manualAccepted();
    dbMocks.loadActiveInstructionsMock.mockResolvedValueOnce(null);
    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/done`, json({ instructionsId: RID }));
    expect(res.status).toBe(404);
    expect(dbMocks.createDoneMock).not.toHaveBeenCalled();
  });

  it('Done with reviewed steps passes the id through', async () => {
    manualAccepted();
    dbMocks.loadActiveInstructionsMock.mockResolvedValueOnce({ id: RID, osType: null });
    const returning = vi.fn().mockResolvedValue([{ id: baseSuggestion.id }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    dbMocks.updateMock.mockReturnValueOnce({ set });
    dbMocks.createDoneMock.mockResolvedValueOnce({ state: 'awaiting_recovery', stateReason: 'manual_steps_done', humanVote: null });
    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/done`, json({ instructionsId: RID }));
    expect(res.status).toBe(201);
    expect(dbMocks.createDoneMock).toHaveBeenCalledWith(expect.objectContaining({ instructionsId: RID }));
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ instructionsId: RID }));
  });

  it('F5: a 23505 on the instructions link is a 409 (no uncaught 500) and never a half-written Done', async () => {
    manualAccepted();
    dbMocks.loadActiveInstructionsMock.mockResolvedValueOnce({ id: RID, osType: null });
    dbMocks.createDoneMock.mockResolvedValueOnce({ state: 'awaiting_recovery', stateReason: 'manual_steps_done', humanVote: null });
    const returning = vi.fn().mockRejectedValue(Object.assign(new Error('duplicate key value violates unique constraint "source_instructions_uq"'), { code: '23505' }));
    dbMocks.updateMock.mockReturnValueOnce({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) }) });
    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/done`, json({ instructionsId: RID }));
    expect(res.status).toBe(409);
    expect(dbMocks.writeRouteAuditMock).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'ml.remediation_suggestion.done' }));
  });

  it('A4: a link UPDATE that matches no row (another reviewed row already linked) is a 409 and the outcome rolls back', async () => {
    manualAccepted();
    dbMocks.loadActiveInstructionsMock.mockResolvedValueOnce({ id: RID, osType: null });
    dbMocks.createDoneMock.mockResolvedValueOnce({ state: 'awaiting_recovery', stateReason: 'manual_steps_done', humanVote: null });
    const returning = vi.fn().mockResolvedValue([]);
    dbMocks.updateMock.mockReturnValueOnce({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) }) });
    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/done`, json({ instructionsId: RID }));
    expect(res.status).toBe(409);
    expect(dbMocks.writeRouteAuditMock).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'ml.remediation_suggestion.done' }));
  });

  it('A4: Done rides the ambient request transaction (a savepoint), never a second caller context', async () => {
    manualAccepted();
    dbMocks.createDoneMock.mockResolvedValueOnce({ state: 'awaiting_recovery', stateReason: 'manual_steps_done', humanVote: null });
    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/done`, json({}));
    expect(res.status).toBe(201);
    expect(withAuthDbAccessContextMock).not.toHaveBeenCalled();
  });

  it('Done with no body is an unreviewed Done (no instructions lookup)', async () => {
    manualAccepted();
    dbMocks.createDoneMock.mockResolvedValueOnce({ state: 'awaiting_recovery', stateReason: 'manual_steps_done', humanVote: null });
    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/done`, { method: 'POST', headers: { Authorization: 'Bearer token' } });
    expect(res.status).toBe(201);
    expect(dbMocks.loadActiveInstructionsMock).not.toHaveBeenCalled();
    expect(dbMocks.createDoneMock).toHaveBeenCalledWith(expect.objectContaining({ instructionsId: null }));
  });

  it('Done rejects a non-uuid instructionsId at validation', async () => {
    expect((await app.request(`/remediation-suggestions/${baseSuggestion.id}/done`, json({ instructionsId: 'nope' }))).status).toBe(400);
  });

  it('lists suggestions with origin and their outcome', async () => {
    mockSelectOnce([{ ...baseSuggestion, origin: 'memory' }]);
    dbMocks.loadSummariesMock.mockResolvedValueOnce(new Map([[baseSuggestion.id, { state: 'holding', stateReason: 'condition_cleared', humanVote: null }]]));
    const res = await app.request('/remediation-suggestions?sourceType=alert&sourceId=a-1', { headers: { Authorization: 'Bearer token' } });
    const body = await res.json();
    expect(body.data[0]).toMatchObject({ origin: 'memory', outcome: { state: 'holding' } });
  });
});

describe('research / memory / draft-brief routes', () => {
  let app: Hono;
  const ORG = '11111111-1111-4111-8111-111111111111';
  const ALERT = '66666666-6666-4666-8666-666666666666';
  const auth = { headers: { Authorization: 'Bearer token' } };
  const post = (body: unknown) => ({ method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  beforeEach(() => {
    vi.resetAllMocks();
    // resetAllMocks wipes the context model; these routes now run their phases through it.
    dbMocks.dbContextState.depth = 0;
    dbMocks.dbContextState.events = [];
    withAuthDbAccessContextMock.mockImplementation(async (_auth: unknown, fn: () => Promise<unknown>) => {
      dbMocks.dbContextState.depth += 1;
      try { return await fn(); } finally { dbMocks.dbContextState.depth -= 1; dbMocks.dbContextState.events.push('commit'); }
    });
    dbMocks.loadSummariesMock.mockResolvedValue(new Map());
    currentPermissions = undefined;
    app = new Hono();
    app.route('/remediation-suggestions', remediationSuggestionRoutes);
  });

  it('POST /research starts deep research and 202s', async () => {
    dbMocks.requestResearchMock.mockResolvedValueOnce({ status: 'started', runId: 'run-9', depth: 'deep' });
    const res = await app.request('/remediation-suggestions/research', post({ sourceType: 'alert', sourceId: ALERT, depth: 'deep' }));
    expect(res.status).toBe(202);
    expect((await res.json()).data).toEqual({ status: 'started', runId: 'run-9', depth: 'deep' });
    expect(dbMocks.requestResearchMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, sourceType: 'alert', sourceId: ALERT, depth: 'deep', trigger: 'manual', actorUserId: 'user-1' }));
  });

  it('POST /research answers 200 when research is already running', async () => {
    dbMocks.requestResearchMock.mockResolvedValueOnce({ status: 'already_running', runId: 'run-9', depth: 'quick' });
    const res = await app.request('/remediation-suggestions/research', post({ sourceType: 'alert', sourceId: ALERT, depth: 'quick' }));
    expect(res.status).toBe(200);
  });

  it.each([
    ['credits_exhausted', 402], ['daily_budget', 402], ['monthly_budget', 402],
    ['plan_gate', 403], ['ai_disabled', 403], ['flag_off', 403], ['permission', 403],
    ['source_not_found', 404],
    ['max_concurrent_research_runs', 409], ['auto_cap', 409], ['model_unavailable', 409], ['research_unavailable', 503], ['research_baseline_not_system_provisioned', 409],
  ])('POST /research maps denial %s to %i with the code verbatim in the body', async (code, status) => {
    dbMocks.requestResearchMock.mockResolvedValueOnce({ status: 'denied', code, message: 'm' });
    const res = await app.request('/remediation-suggestions/research', post({ sourceType: 'alert', sourceId: ALERT, depth: 'quick' }));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: 'm', code });
  });

  it('POST /research refuses an org the caller cannot access before starting anything', async () => {
    const res = await app.request('/remediation-suggestions/research', post({ sourceType: 'alert', sourceId: ALERT, depth: 'quick', orgId: '99999999-9999-4999-8999-999999999999' }));
    expect(res.status).toBe(403);
    expect(dbMocks.requestResearchMock).not.toHaveBeenCalled();
  });

  it('GET /research returns the latest run state for the source', async () => {
    dbMocks.researchStatusMock.mockResolvedValueOnce({ runId: 'run-9', depth: 'quick', status: 'running', errorCode: null, noSafeFix: false, finishedAt: null });
    const res = await app.request(`/remediation-suggestions/research?sourceType=alert&sourceId=${ALERT}`, auth);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ status: 'running' });
    expect(dbMocks.researchStatusMock).toHaveBeenCalledWith({ orgId: ORG, sourceType: 'alert', sourceId: ALERT });
  });

  it('GET /memory returns proven and similar fixes without touching research', async () => {
    dbMocks.lookupMock.mockResolvedValueOnce({ signature: {}, proven: [{ id: 'f1' }], similar: [{ id: 'f2' }] });
    const res = await app.request(`/remediation-suggestions/memory?sourceType=alert&sourceId=${ALERT}`, auth);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ proven: [{ id: 'f1' }], similar: [{ id: 'f2' }] });
    expect(dbMocks.lookupMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, partnerId: 'p-1', limit: 5 }));
    expect(dbMocks.requestResearchMock).not.toHaveBeenCalled();
    expect(dbMocks.researchStatusMock).not.toHaveBeenCalled();
  });

  it('GET /draft-brief only serves script_draft rows', async () => {
    mockSuggestionLoad({ ...baseSuggestion, targetType: 'script_draft', parameters: { brief: 'Clear queue', language: 'powershell' } });
    const ok = await app.request(`/remediation-suggestions/${baseSuggestion.id}/draft-brief`, auth);
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toEqual({ brief: 'Clear queue', language: 'powershell', title: baseSuggestion.title });
    mockSuggestionLoad(baseSuggestion);
    expect((await app.request(`/remediation-suggestions/${baseSuggestion.id}/draft-brief`, auth)).status).toBe(400);
  });

  it('GET /draft-brief 404s a non-uuid id without querying', async () => {
    expect((await app.request('/remediation-suggestions/not-a-uuid/draft-brief', auth)).status).toBe(404);
    expect(dbMocks.selectMock).not.toHaveBeenCalled();
  });

  describe('site-limited user (source device outside allowed sites)', () => {
    beforeEach(() => {
      currentPermissions = { permissions: [{ resource: 'ai_sessions', action: 'use' }], allowedSiteIds: ['site-allowed'] };
      dbMocks.sourceDeviceMock.mockResolvedValue({ deviceId: 'dev-1' });
      dbMocks.selectMock.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [{ siteId: 'site-other' }] }) }) });
    });

    it('POST /research 404s and starts nothing', async () => {
      const res = await app.request('/remediation-suggestions/research', post({ sourceType: 'alert', sourceId: ALERT, depth: 'quick' }));
      expect(res.status).toBe(404);
      expect(dbMocks.requestResearchMock).not.toHaveBeenCalled();
    });

    it('GET /research reveals no run state', async () => {
      const res = await app.request(`/remediation-suggestions/research?sourceType=alert&sourceId=${ALERT}`, auth);
      expect((await res.json()).data).toBeNull();
      expect(dbMocks.researchStatusMock).not.toHaveBeenCalled();
    });

    it('GET /memory returns nothing', async () => {
      const res = await app.request(`/remediation-suggestions/memory?sourceType=alert&sourceId=${ALERT}`, auth);
      expect((await res.json()).data).toEqual({ proven: [], similar: [] });
      expect(dbMocks.lookupMock).not.toHaveBeenCalled();
    });

    it('Generate 404s without generating or researching', async () => {
      const res = await app.request('/remediation-suggestions/generate', post({ sourceType: 'alert', sourceId: ALERT }));
      expect(res.status).toBe(404);
      expect(dbMocks.generateMock).not.toHaveBeenCalled();
    });

    it('F4: fails CLOSED (404, nothing started) when the source or its device cannot be resolved', async () => {
      for (const unresolved of [null, { deviceId: null }]) {
        dbMocks.requestResearchMock.mockClear();
        dbMocks.sourceDeviceMock.mockResolvedValue(unresolved);
        const res = await app.request('/remediation-suggestions/research', post({ sourceType: 'alert', sourceId: ALERT, depth: 'quick' }));
        expect(res.status).toBe(404);
        expect(dbMocks.requestResearchMock).not.toHaveBeenCalled();
      }
    });

    it('an in-site source still proceeds', async () => {
      dbMocks.selectMock.mockReset();
      dbMocks.selectMock.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [{ siteId: 'site-allowed' }] }) }) });
      dbMocks.requestResearchMock.mockResolvedValueOnce({ status: 'started', runId: 'r', depth: 'quick' });
      const res = await app.request('/remediation-suggestions/research', post({ sourceType: 'alert', sourceId: ALERT, depth: 'quick' }));
      expect(res.status).toBe(202);
    });
  });

  it('GET /draft-brief 404s an unknown suggestion', async () => {
    dbMocks.selectMock.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [] }) }) });
    expect((await app.request(`/remediation-suggestions/${baseSuggestion.id}/draft-brief`, auth)).status).toBe(404);
  });

  describe('A2: research-starting POSTs are self-managed (no context held across requestResearch)', () => {
    it('POST /research gates in a short context, then calls requestResearch with none held and an RLS runReads', async () => {
      currentPermissions = { permissions: [{ resource: 'ai_sessions', action: 'use' }], allowedSiteIds: ['site-allowed'] };
      const depths: Record<string, number> = {};
      dbMocks.sourceDeviceMock.mockImplementationOnce(async () => { depths.gate = dbMocks.dbContextState.depth; return { deviceId: 'dev-1' }; });
      dbMocks.selectMock.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [{ siteId: 'site-allowed' }] }) }) });
      dbMocks.requestResearchMock.mockImplementationOnce(async (input: { runReads: (fn: () => Promise<number>) => Promise<number> }) => {
        depths.research = dbMocks.dbContextState.depth;
        depths.reads = await input.runReads(async () => dbMocks.dbContextState.depth);
        return { status: 'started', runId: 'r', depth: 'quick' };
      });
      const res = await app.request('/remediation-suggestions/research', post({ sourceType: 'alert', sourceId: ALERT, depth: 'quick' }));
      expect(res.status).toBe(202);
      expect(depths).toEqual({ gate: 1, research: 0, reads: 1 });
    });

    it('Generate runs the service with no context held and hands it the caller-scoped runner', async () => {
      const depths: Record<string, number> = {};
      dbMocks.generateMock.mockImplementationOnce(async (_input: unknown, opts: { runInDbContext: (fn: () => Promise<number>) => Promise<number> }) => {
        depths.service = dbMocks.dbContextState.depth;
        depths.runner = await opts.runInDbContext(async () => dbMocks.dbContextState.depth);
        return { orgId: ORG, sourceType: 'anomaly', sourceId: baseSuggestion.sourceId, skipped: false, suggestions: [baseSuggestion], research: null };
      });
      dbMocks.loadSummariesMock.mockImplementationOnce(async () => { depths.outcomes = dbMocks.dbContextState.depth; return new Map(); });
      const res = await app.request('/remediation-suggestions/generate', post({ sourceType: 'anomaly', sourceId: baseSuggestion.sourceId }));
      expect(res.status).toBe(201);
      expect(depths).toEqual({ service: 0, runner: 1, outcomes: 1 });
    });
  });

  describe('Generate research gating', () => {
    const gen = () => app.request('/remediation-suggestions/generate', post({ sourceType: 'anomaly', sourceId: baseSuggestion.sourceId }));
    const result = { orgId: ORG, sourceType: 'anomaly', sourceId: baseSuggestion.sourceId, skipped: false, suggestions: [], research: { status: 'started', runId: 'r', depth: 'quick' } };

    it('passes allowResearch=true only with ai_sessions:use and returns the research outcome', async () => {
      currentPermissions = { permissions: [{ resource: 'ai_sessions', action: 'use' }] };
      dbMocks.generateMock.mockResolvedValueOnce(result);
      const res = await gen();
      expect(dbMocks.generateMock).toHaveBeenCalledWith(expect.objectContaining({ allowResearch: true }), expect.anything());
      expect((await res.json()).research).toEqual(result.research);
    });

    it('passes allowResearch=false without that permission', async () => {
      dbMocks.generateMock.mockResolvedValueOnce(result);
      await gen();
      expect(dbMocks.generateMock).toHaveBeenCalledWith(expect.objectContaining({ allowResearch: false }), expect.anything());
    });
  });
});
