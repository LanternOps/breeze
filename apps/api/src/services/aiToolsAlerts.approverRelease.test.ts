import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #6907 — the handler half of `manage_alerts:{acknowledge,resolve,suppress}`
 * being user-owned on release (`USER_OWNED_RELEASE_ACTIONS` in
 * `jobs/intentReleaseWorker.ts`).
 *
 * The worker swaps the rebuilt agent auth for the approver's own auth and
 * names that approver in `context.approverRelease`. The handler must (a)
 * write the approver — never anything else — into `alerts.resolved_by` /
 * `alerts.acknowledged_by` and `ml_feedback_events.actor_user_id`, and (b)
 * refuse outright, before any read or write, when the auth it received and
 * the approver it was told about disagree. Mirrors the `log_time_entry` and
 * #6200 fleet guards.
 */

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  dbUpdate: vi.fn(),
  setCalls: [] as Record<string, unknown>[],
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

const APPROVER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const ALERT = {
  id: '33333333-3333-4333-8333-333333333333',
  orgId: 'org-1',
  ruleId: 'rule-1',
  deviceId: null,
  status: 'active',
  title: 'CPU hot',
  triggeredAt: new Date('2026-09-24T15:00:00.000Z'),
};

function handler(): AiTool['handler'] {
  const registry = new Map<string, AiTool>();
  registerAlertTools(registry);
  return registry.get('manage_alerts')!.handler;
}

function approverAuth(userId = APPROVER_ID): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'tech@example.com', name: 'Tess Tech', isPlatformAdmin: false },
    token: {} as never,
    partnerId: 'partner-1',
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: (orgId) => orgId === 'org-1',
  };
}

function mockAlertLookup(row: unknown) {
  mocks.dbSelect.mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue([row]),
      })),
    })),
  });
}

function mockUpdate() {
  mocks.dbUpdate.mockReturnValueOnce({
    set: vi.fn((values: Record<string, unknown>) => {
      mocks.setCalls.push(values);
      return {
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: ALERT.id }]),
        })),
      };
    }),
  });
}

const release = { context: { approverRelease: { approverUserId: APPROVER_ID } } } as const;

describe('manage_alerts approver release (#6907)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setCalls.length = 0;
  });

  it.each([
    { action: 'resolve', column: 'resolvedBy' },
    { action: 'acknowledge', column: 'acknowledgedBy' },
  ])('$action writes the approver into alerts.$column and the feedback actor', async ({ action, column }) => {
    mockAlertLookup(ALERT);
    mockUpdate();

    const result = JSON.parse(await handler()(
      { action, alertId: ALERT.id },
      approverAuth(),
      release.context,
    ));

    expect(result.success).toBe(true);
    expect(mocks.setCalls).toHaveLength(1);
    expect(mocks.setCalls[0]![column]).toBe(APPROVER_ID);
    expect(mocks.emitAlertStateFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: APPROVER_ID }),
    );
  });

  it('suppress writes the approver as the feedback actor', async () => {
    mockAlertLookup(ALERT);
    mockUpdate();

    const result = JSON.parse(await handler()(
      { action: 'suppress', alertId: ALERT.id, suppressDuration: 24 },
      approverAuth(),
      release.context,
    ));

    expect(result.success).toBe(true);
    expect(mocks.emitAlertStateFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: APPROVER_ID }),
    );
  });

  it.each(['resolve', 'acknowledge', 'suppress'])(
    '%s refuses when the auth it runs under is not the named approver — before any read or write',
    async (action) => {
      const result = JSON.parse(await handler()(
        { action, alertId: ALERT.id },
        approverAuth(OTHER_USER_ID),
        release.context,
      ));

      expect(result).toEqual({ error: 'approver_auth_mismatch', action });
      expect(mocks.dbSelect).not.toHaveBeenCalled();
      expect(mocks.dbUpdate).not.toHaveBeenCalled();
      expect(mocks.publishEvent).not.toHaveBeenCalled();
      expect(mocks.emitAlertStateFeedback).not.toHaveBeenCalled();
    },
  );
});
