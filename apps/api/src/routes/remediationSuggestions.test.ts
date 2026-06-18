import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
  generateMock: vi.fn(),
  emitFeedbackMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: dbMocks.selectMock,
    update: dbMocks.updateMock,
  },
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    siteId: 'devices.siteId',
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
    c.set('permissions', {});
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
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

describe('remediation suggestion routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
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
    dbMocks.selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([baseSuggestion]),
        }),
      }),
    });
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
});
