import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = vi.hoisted(() => ({
  selectMock: vi.fn(),
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
    expiresAt: 'elevationRequests.expiresAt',
  },
  remediationSuggestions: {
    id: 'remediationSuggestions.id',
    orgId: 'remediationSuggestions.orgId',
    sourceType: 'remediationSuggestions.sourceType',
    sourceId: 'remediationSuggestions.sourceId',
    deviceId: 'remediationSuggestions.deviceId',
    status: 'remediationSuggestions.status',
    createdAt: 'remediationSuggestions.createdAt',
  },
  scriptExecutions: {
    id: 'scriptExecutions.id',
    orgId: 'scriptExecutions.orgId',
    scriptId: 'scriptExecutions.scriptId',
    deviceId: 'scriptExecutions.deviceId',
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

import { remediationSuggestionRoutes } from './remediationSuggestions';

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

function mockScriptExecutionLoad(execution: Record<string, unknown> | undefined) {
  dbMocks.selectMock.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(execution ? [execution] : []),
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
      outcome: 'accepted',
      actorUserId: 'user-1',
    }));
    const body = await res.json();
    expect(body.data.status).toBe('accepted');
  });

  it('rejects execution status without a linked execution rail', async () => {
    mockSuggestionLoad({ ...baseSuggestion, status: 'accepted' });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'executed' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Executed or failed suggestions must link to a tool, script, or playbook execution');
    expect(dbMocks.updateMock).not.toHaveBeenCalled();
    expect(dbMocks.emitFeedbackMock).not.toHaveBeenCalled();
  });

  it('rejects direct execution from suggested status', async () => {
    mockSuggestionLoad(baseSuggestion);

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        status: 'executed',
        scriptExecutionId: '66666666-6666-4666-8666-666666666666',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Suggestion must be accepted or edited before it can be marked executed or failed');
    expect(dbMocks.updateMock).not.toHaveBeenCalled();
    expect(dbMocks.emitFeedbackMock).not.toHaveBeenCalled();
  });

  it('requires failure details when marking a linked execution failed', async () => {
    mockSuggestionLoad({
      ...baseSuggestion,
      status: 'accepted',
      scriptExecutionId: '66666666-6666-4666-8666-666666666666',
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'failed' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Failed suggestions must include a failureMessage');
    expect(dbMocks.updateMock).not.toHaveBeenCalled();
    expect(dbMocks.emitFeedbackMock).not.toHaveBeenCalled();
  });

  it('marks accepted suggestions executed when a script execution is linked', async () => {
    const scriptExecutionId = '66666666-6666-4666-8666-666666666666';
    mockSuggestionLoad({ ...baseSuggestion, status: 'accepted' });
    mockScriptExecutionLoad({
      orgId: baseSuggestion.orgId,
      scriptId: baseSuggestion.scriptId,
      deviceId: baseSuggestion.deviceId,
    });
    dbMocks.updateMock.mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            ...baseSuggestion,
            status: 'executed',
            scriptExecutionId,
            executedBy: 'user-1',
            executedAt: new Date('2026-06-18T12:10:00.000Z'),
          }]),
        }),
      }),
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'executed', scriptExecutionId }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.emitFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: baseSuggestion.orgId,
      suggestionId: baseSuggestion.id,
      eventType: 'suggestion.executed',
      outcome: 'executed',
      actorUserId: 'user-1',
      metadata: expect.objectContaining({ scriptExecutionId }),
    }));
    const body = await res.json();
    expect(body.data.status).toBe('executed');
    expect(body.data.scriptExecutionId).toBe(scriptExecutionId);
  });

  it('rejects linked script executions from another organization', async () => {
    const scriptExecutionId = '66666666-6666-4666-8666-666666666666';
    mockSuggestionLoad({ ...baseSuggestion, status: 'accepted' });
    mockScriptExecutionLoad({
      orgId: '77777777-7777-4777-8777-777777777777',
      scriptId: baseSuggestion.scriptId,
      deviceId: baseSuggestion.deviceId,
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'executed', scriptExecutionId }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Linked script execution must belong to the same organization');
    expect(dbMocks.updateMock).not.toHaveBeenCalled();
  });

  it('rejects linked script executions for another script', async () => {
    const scriptExecutionId = '66666666-6666-4666-8666-666666666666';
    mockSuggestionLoad({ ...baseSuggestion, status: 'accepted' });
    mockScriptExecutionLoad({
      orgId: baseSuggestion.orgId,
      scriptId: '77777777-7777-4777-8777-777777777777',
      deviceId: baseSuggestion.deviceId,
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'executed', scriptExecutionId }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Linked script execution must run the suggested script');
    expect(dbMocks.updateMock).not.toHaveBeenCalled();
  });

  it('rejects linked script executions for another target device', async () => {
    const scriptExecutionId = '66666666-6666-4666-8666-666666666666';
    mockSuggestionLoad({ ...baseSuggestion, status: 'accepted' });
    mockScriptExecutionLoad({
      orgId: baseSuggestion.orgId,
      scriptId: baseSuggestion.scriptId,
      deviceId: '77777777-7777-4777-8777-777777777777',
    });

    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'executed', scriptExecutionId }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Linked script execution must target the suggested device');
    expect(dbMocks.updateMock).not.toHaveBeenCalled();
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

    const res = await app.request('/remediation-suggestions/evaluation?days=7', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(0);
    expect(body.rates).toEqual({ acceptRate: 0, rejectRate: 0, executeRate: 0, failureRate: 0 });
    expect(body.feedback.total).toBe(0);
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
