import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Registry } from 'prom-client';

const mockWriteAuditEvent = vi.fn();
const mockRequestLikeFromSnapshot = vi.fn((..._args: unknown[]) => ({ req: { header: () => undefined } }));
vi.mock('../auditEvents', () => ({
  writeAuditEvent: (...args: unknown[]) => mockWriteAuditEvent(...args),
  requestLikeFromSnapshot: (...args: unknown[]) => mockRequestLikeFromSnapshot(...args),
}));

import {
  recordActionIntentEvent,
  recordActionIntentMetric,
  registerActionIntentPrometheusCounter,
  setActionIntentMetricsRecorder,
} from './metrics';

describe('registerActionIntentPrometheusCounter', () => {
  beforeEach(() => {
    setActionIntentMetricsRecorder(null);
  });

  it('registers a counter labeled source/action/outcome under breeze_action_intents_total', async () => {
    const registry = new Registry();
    registerActionIntentPrometheusCounter(registry);

    recordActionIntentMetric('chat', 'run_script', 'created');
    recordActionIntentMetric('mcp_api', 'execute_command', 'approved');

    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'breeze_action_intents_total');
    expect(counter).toBeDefined();
    expect(counter?.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: { source: 'chat', action: 'run_script', outcome: 'created' },
          value: 1,
        }),
        expect.objectContaining({
          labels: { source: 'mcp_api', action: 'execute_command', outcome: 'approved' },
          value: 1,
        }),
      ]),
    );
  });

  it('reuses an already-registered counter instead of throwing on double registration', () => {
    const registry = new Registry();
    const first = registerActionIntentPrometheusCounter(registry);
    const second = registerActionIntentPrometheusCounter(registry);
    expect(second).toBe(first);
  });
});

describe('recordActionIntentMetric', () => {
  beforeEach(() => {
    setActionIntentMetricsRecorder(null);
  });

  it('is a no-op until a recorder is registered', () => {
    expect(() => recordActionIntentMetric('chat', 'run_script', 'created')).not.toThrow();
  });
});

describe('recordActionIntentEvent', () => {
  beforeEach(() => {
    mockWriteAuditEvent.mockClear();
    mockRequestLikeFromSnapshot.mockClear();
    setActionIntentMetricsRecorder(null);
  });

  it('writes an action_intent.<outcome> audit event with result=success for a non-failure outcome', () => {
    recordActionIntentEvent({
      orgId: 'org-1',
      intentId: 'intent-1',
      actionName: 'run_script',
      argumentDigest: 'a'.repeat(64),
      source: 'chat',
      outcome: 'created',
      actorId: 'user-1',
      details: { approverCount: 2 },
    });

    expect(mockRequestLikeFromSnapshot).toHaveBeenCalledWith({});
    expect(mockWriteAuditEvent).toHaveBeenCalledTimes(1);
    const [, event] = mockWriteAuditEvent.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(event.action).toBe('action_intent.created');
    expect(event.orgId).toBe('org-1');
    expect(event.resourceType).toBe('action_intent');
    expect(event.resourceId).toBe('intent-1');
    expect(event.result).toBe('success');
    expect(event.actorType).toBe('user');
    expect(event.actorId).toBe('user-1');
    expect(event.details).toEqual({
      actionName: 'run_script',
      argumentDigest: 'a'.repeat(64),
      source: 'chat',
      approverCount: 2,
    });
  });

  it.each(['rejected', 'expired', 'cancelled'] as const)(
    'marks outcome=%s as result=failure',
    (outcome) => {
      recordActionIntentEvent({
        orgId: 'org-1',
        intentId: 'intent-1',
        actionName: 'run_script',
        argumentDigest: 'a'.repeat(64),
        source: 'mcp_api',
        outcome,
      });
      const [, event] = mockWriteAuditEvent.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(event.result).toBe('failure');
    },
  );

  it('marks outcome=approved/executed/self_approved_sole_operator as result=success', () => {
    for (const outcome of ['approved', 'executed', 'self_approved_sole_operator'] as const) {
      mockWriteAuditEvent.mockClear();
      recordActionIntentEvent({
        orgId: 'org-1',
        intentId: 'intent-1',
        actionName: 'run_script',
        argumentDigest: 'a'.repeat(64),
        source: 'chat',
        outcome,
      });
      const [, event] = mockWriteAuditEvent.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(event.result).toBe('success');
    }
  });

  it('omits actorId and sets actorType=system when no actor is given', () => {
    recordActionIntentEvent({
      orgId: 'org-1',
      intentId: 'intent-1',
      actionName: 'run_script',
      argumentDigest: 'a'.repeat(64),
      source: 'chat',
      outcome: 'expired',
    });
    const [, event] = mockWriteAuditEvent.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(event.actorType).toBe('system');
    expect(event).not.toHaveProperty('actorId');
  });

  it('also increments the registered Prometheus counter', async () => {
    const registry = new Registry();
    registerActionIntentPrometheusCounter(registry);
    recordActionIntentEvent({
      orgId: 'org-1',
      intentId: 'intent-1',
      actionName: 'run_script',
      argumentDigest: 'a'.repeat(64),
      source: 'chat',
      outcome: 'created',
    });
    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'breeze_action_intents_total');
    expect(counter?.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: { source: 'chat', action: 'run_script', outcome: 'created' },
          value: 1,
        }),
      ]),
    );
  });
});
