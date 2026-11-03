import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { dbMock, sets, predicates, returned, publishEvent, emitAlertStateFeedback } = vi.hoisted(() => {
  const sets: Record<string, unknown>[] = [];
  const predicates: unknown[] = [];
  const returned: unknown[][] = [];
  return {
    sets, predicates, returned,
    dbMock: { update: vi.fn(() => ({ set: (value: Record<string, unknown>) => {
      sets.push(value);
      return { where: (predicate: unknown) => {
        predicates.push(predicate);
        return { returning: async () => returned.shift() ?? [] };
      } };
    } })) },
    publishEvent: vi.fn(async (..._args: unknown[]) => 'event'),
    emitAlertStateFeedback: vi.fn(async (..._args: unknown[]) => {}),
  };
});
vi.mock('../db', () => ({ db: dbMock }));
vi.mock('./eventBus', () => ({ publishEvent }));
vi.mock('./mlFeedbackEmitters', () => ({ emitAlertStateFeedback }));
vi.mock('./alertCooldown', () => ({ setCooldown: vi.fn(), isCooldownActive: vi.fn(), recordStateTransition: vi.fn(), isFlapping: vi.fn() }));
vi.mock('./alertCorrelationQueue', () => ({ enqueueAlertCorrelation: vi.fn() }));

import { acknowledgeAlert } from './alertActions';

const alert = {
  id: '00000000-0000-4000-8000-000000000001',
  orgId: '00000000-0000-4000-8000-000000000002',
  deviceId: '00000000-0000-4000-8000-000000000003',
  ruleId: null,
  status: 'acknowledged',
};
const userId = '00000000-0000-4000-8000-000000000004';
const principalId = '00000000-0000-4000-8000-000000000005';

beforeEach(() => {
  sets.length = predicates.length = returned.length = 0;
  vi.clearAllMocks();
});

describe('acknowledgeAlert', () => {
  it('preserves the user event payload and feedback exactly', async () => {
    returned.push([alert]);
    await expect(acknowledgeAlert(alert.id, { kind: 'user', userId })).resolves.toEqual({ changed: true, alert });
    expect(sets[0]).toEqual({ status: 'acknowledged', acknowledgedAt: expect.any(Date), acknowledgedBy: userId, acknowledgedByPrincipalId: null });
    expect(publishEvent).toHaveBeenCalledExactlyOnceWith('alert.acknowledged', alert.orgId, {
      alertId: alert.id, ruleId: null, deviceId: alert.deviceId, acknowledgedBy: userId,
    }, 'alerts-route', { userId });
    expect(emitAlertStateFeedback).toHaveBeenCalledExactlyOnceWith({
      orgId: alert.orgId, alertId: alert.id, eventType: 'alert.acknowledged', outcome: 'acknowledged',
      actorUserId: userId, occurredAt: sets[0]!.acknowledgedAt,
      metadata: { source: 'alerts.route', previousStatus: 'active' },
    });
    const query = new PgDialect().sqlToQuery(predicates[0] as SQL);
    expect(query.sql).toContain('"alerts"."id" =');
    expect(query.sql).toContain('"alerts"."status" in');
    expect(query.params).toEqual([alert.id, 'active']);
  });

  it('records the principal itself and emits no human quality feedback', async () => {
    returned.push([alert]);
    await acknowledgeAlert(alert.id, { kind: 'partner_service_principal', principalId });
    expect(sets[0]).toMatchObject({ acknowledgedBy: null, acknowledgedByPrincipalId: principalId });
    expect(publishEvent).toHaveBeenCalledExactlyOnceWith('alert.acknowledged', alert.orgId, {
      alertId: alert.id, ruleId: null, deviceId: alert.deviceId, acknowledgedBy: null, acknowledgedByPrincipalId: principalId,
    }, 'partner-api');
    expect(emitAlertStateFeedback).not.toHaveBeenCalled();
  });

  it('returns an unchanged result without fan-out when the CAS loses', async () => {
    returned.push([]);
    await expect(acknowledgeAlert(alert.id, { kind: 'partner_service_principal', principalId }))
      .resolves.toEqual({ changed: false, alert: null });
    expect(publishEvent).not.toHaveBeenCalled();
    expect(emitAlertStateFeedback).not.toHaveBeenCalled();
  });

  it('retains a successful acknowledgement when publication fails', async () => {
    returned.push([alert]);
    publishEvent.mockRejectedValueOnce(new Error('bus unavailable'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(acknowledgeAlert(alert.id, { kind: 'user', userId })).resolves.toMatchObject({ changed: true });
    expect(errorLog).toHaveBeenCalled();
    expect(emitAlertStateFeedback).toHaveBeenCalledTimes(1);
    errorLog.mockRestore();
  });
});
