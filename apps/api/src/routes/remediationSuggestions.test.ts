import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
  generateMock: vi.fn(),
  emitFeedbackMock: vi.fn(),
  executeScriptOnDevicesMock: vi.fn(),
}));

let currentPermissions: { allowedSiteIds?: string[] } | undefined;

vi.mock('../db', () => ({
  db: {
    select: dbMocks.selectMock,
    insert: dbMocks.insertMock,
    update: dbMocks.updateMock,
  },
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
    c.set('permissions', currentPermissions ?? {});
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: dbMocks.writeRouteAuditMock,
}));

vi.mock('../services/remediationSuggestions', () => ({
  generateRemediationSuggestions: dbMocks.generateMock,
}));

vi.mock('../services/mlFeedbackEmitters', () => ({
  emitRemediationSuggestionFeedback: dbMocks.emitFeedbackMock,
}));

vi.mock('../services/scriptExecution', () => ({
  executeScriptOnDevices: dbMocks.executeScriptOnDevicesMock,
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
    }));
    const body = await res.json();
    expect(body.data[0].title).toBe('Disk Cleanup');
    expect(dbMocks.writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ml.remediation_suggestions.generate',
    }));
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

  it('executes accepted script suggestions through the server-side script rail', async () => {
    const accepted = { ...baseSuggestion, status: 'accepted' };
    const scriptExecutionId = '66666666-6666-4666-8666-666666666666';
    mockSuggestionLoad(accepted);
    dbMocks.executeScriptOnDevicesMock.mockResolvedValueOnce({
      ok: true,
      batchId: null,
      scriptId: baseSuggestion.scriptId,
      script: { id: baseSuggestion.scriptId, name: 'Disk Cleanup' },
      devicesTargeted: 1,
      maintenanceSuppressedDeviceIds: [],
      executions: [{
        executionId: scriptExecutionId,
        deviceId: baseSuggestion.deviceId,
        commandId: '77777777-7777-4777-8777-777777777777',
      }],
      status: 'queued',
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
    expect(body.execution.executions[0].executionId).toBe(scriptExecutionId);
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
      batchId: null,
      scriptId: baseSuggestion.scriptId,
      script: { id: baseSuggestion.scriptId, name: 'Disk Cleanup' },
      devicesTargeted: 1,
      maintenanceSuppressedDeviceIds: [],
      executions: [{
        executionId: scriptExecutionId,
        deviceId: baseSuggestion.deviceId,
        commandId: '77777777-7777-4777-8777-777777777777',
      }],
      status: 'queued',
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
});
