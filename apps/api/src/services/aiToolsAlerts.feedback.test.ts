import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  dbUpdate: vi.fn(),
  emitAlertStateFeedback: vi.fn().mockResolvedValue(undefined),
  publishEvent: vi.fn().mockResolvedValue('event-1'),
}));

vi.mock('../db', () => ({
  db: {
    select: mocks.dbSelect,
    update: mocks.dbUpdate,
  },
}));

vi.mock('./eventBus', () => ({
  publishEvent: mocks.publishEvent,
}));

vi.mock('./mlFeedbackEmitters', () => ({
  emitAlertStateFeedback: mocks.emitAlertStateFeedback,
}));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerAlertTools } from './aiToolsAlerts';

const ALERT = {
  id: 'alert-1',
  orgId: 'org-1',
  ruleId: 'rule-1',
  deviceId: 'device-1',
  status: 'active',
  title: 'CPU hot',
};

function handlerFor(name: string): AiTool['handler'] {
  const registry = new Map<string, AiTool>();
  registerAlertTools(registry);
  return registry.get(name)!.handler;
}

function makeAuth(): AuthContext {
  return {
    user: { id: '11111111-1111-4111-8111-111111111111', email: 'user@example.com', name: 'User', isPlatformAdmin: false },
    token: {} as never,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: (orgId) => orgId === 'org-1',
  };
}

function mockAlertLookup(row: unknown | null) {
  mocks.dbSelect.mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      })),
    })),
  });
}

function mockUpdate() {
  mocks.dbUpdate.mockReturnValueOnce({
    set: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  });
}

describe('manage_alerts feedback emission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('acknowledge emits alert state feedback with actor and previous status', async () => {
    mockAlertLookup(ALERT);
    mockUpdate();

    const result = JSON.parse(await handlerFor('manage_alerts')(
      { action: 'acknowledge', alertId: ALERT.id },
      makeAuth()
    ));

    expect(result.success).toBe(true);
    expect(mocks.emitAlertStateFeedback).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ALERT.orgId,
      alertId: ALERT.id,
      eventType: 'alert.acknowledged',
      outcome: 'acknowledged',
      actorUserId: '11111111-1111-4111-8111-111111111111',
      metadata: {
        source: 'ai_tools.manage_alerts',
        previousStatus: 'active',
      },
    }));
  });

  it('resolve emits alert state feedback with note metadata', async () => {
    mockAlertLookup({ ...ALERT, status: 'acknowledged' });
    mockUpdate();

    const result = JSON.parse(await handlerFor('manage_alerts')(
      { action: 'resolve', alertId: ALERT.id, resolutionNote: 'fixed' },
      makeAuth()
    ));

    expect(result.success).toBe(true);
    expect(mocks.emitAlertStateFeedback).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ALERT.orgId,
      alertId: ALERT.id,
      eventType: 'alert.resolved',
      outcome: 'resolved',
      actorUserId: '11111111-1111-4111-8111-111111111111',
      metadata: {
        source: 'ai_tools.manage_alerts',
        previousStatus: 'acknowledged',
        hasResolutionNote: true,
      },
    }));
  });

  it('suppress emits alert state feedback with stable suppression dedupe key', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T10:00:00.000Z'));
    try {
      mockAlertLookup(ALERT);
      mockUpdate();

      const result = JSON.parse(await handlerFor('manage_alerts')(
        { action: 'suppress', alertId: ALERT.id, suppressDuration: 2 },
        makeAuth()
      ));

      expect(result.success).toBe(true);
      expect(mocks.emitAlertStateFeedback).toHaveBeenCalledWith(expect.objectContaining({
        orgId: ALERT.orgId,
        alertId: ALERT.id,
        eventType: 'alert.suppressed',
        dedupeKey: 'suppress:2026-06-18T12:00:00.000Z',
        outcome: 'suppressed',
        actorUserId: '11111111-1111-4111-8111-111111111111',
        metadata: {
          source: 'ai_tools.manage_alerts',
          previousStatus: 'active',
          suppressedUntil: '2026-06-18T12:00:00.000Z',
          durationHours: 2,
        },
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppress with suppressDuration:0 suppresses forever (no deadline)', async () => {
    mockAlertLookup(ALERT);
    mockUpdate();

    const result = JSON.parse(await handlerFor('manage_alerts')(
      { action: 'suppress', alertId: ALERT.id, suppressDuration: 0 },
      makeAuth()
    ));

    expect(result.success).toBe(true);
    expect(result.suppressedUntil).toBeNull();
    expect(result.durationHours).toBeNull();
    // Forever == no deadline: the dedupe key and metadata carry no timestamp.
    expect(mocks.emitAlertStateFeedback).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'alert.suppressed',
      dedupeKey: 'suppress:forever',
      outcome: 'suppressed',
      metadata: expect.objectContaining({
        source: 'ai_tools.manage_alerts',
        suppressedUntil: null,
        durationHours: null,
      }),
    }));
  });

  it('does not emit feedback when the alert is missing', async () => {
    mockAlertLookup(null);

    const result = JSON.parse(await handlerFor('manage_alerts')(
      { action: 'acknowledge', alertId: ALERT.id },
      makeAuth()
    ));

    expect(result.error).toContain('not found');
    expect(mocks.dbUpdate).not.toHaveBeenCalled();
    expect(mocks.emitAlertStateFeedback).not.toHaveBeenCalled();
  });
});
