import { beforeEach, describe, expect, it, vi } from 'vitest';

// The device read is the only DB touch: capture the context it ran under and
// the WHERE it used, and answer with a programmable row set.
const { state } = vi.hoisted(() => ({
  state: {
    rows: [] as unknown[],
    contexts: [] as unknown[],
    whereArgs: [] as unknown[],
    selects: 0,
  },
}));

vi.mock('../../db', () => ({
  db: {
    select: () => {
      state.selects += 1;
      return {
        from: () => ({
          where: (cond: unknown) => {
            state.whereArgs.push(cond);
            return { limit: async () => state.rows };
          },
        }),
      };
    },
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: async (ctx: unknown, fn: () => Promise<unknown>) => {
    state.contexts.push(ctx);
    return fn();
  },
}));

import type { BreezeEvent } from '../eventBus';
import { buildTriggerScope } from './triggerScope';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '44444444-4444-4444-8444-444444444444';
const SITE = '55555555-5555-4555-8555-555555555555';

function event(payload: Record<string, unknown>): BreezeEvent {
  return {
    id: 'evt-1',
    type: 'alert.triggered',
    orgId: ORG,
    source: 'test',
    priority: 'normal',
    payload,
    metadata: { timestamp: '2026-10-25T10:00:00.000Z' },
  } as BreezeEvent;
}

beforeEach(() => {
  state.rows = [];
  state.contexts = [];
  state.whereArgs = [];
  state.selects = 0;
});

describe('buildTriggerScope', () => {
  it('enriches the device only for a device in the run org, in one org-scoped read', async () => {
    state.rows = [{ id: DEVICE, hostname: 'kit-01', siteId: SITE }];
    const scope = await buildTriggerScope({ kind: 'event', orgId: ORG, event: event({ deviceId: DEVICE, severity: 'high' }) });

    expect(scope).toMatchObject({
      kind: 'event',
      orgId: ORG,
      firedAt: '2026-10-25T10:00:00.000Z',
      event: { id: 'evt-1', type: 'alert.triggered' },
      payload: { deviceId: DEVICE, severity: 'high' },
      device: { id: DEVICE, hostname: 'kit-01', siteId: SITE },
    });
    expect(state.selects).toBe(1);
    // The flow principal's DB shape: org-scoped to the RUN org, never a user.
    expect(state.contexts).toEqual([
      expect.objectContaining({ scope: 'organization', orgId: ORG, accessibleOrgIds: [ORG], userId: null }),
    ]);
  });

  it('a foreign deviceId (not visible in the run org) leaves device absent', async () => {
    state.rows = [];
    const scope = await buildTriggerScope({ kind: 'event', orgId: ORG, event: event({ deviceId: DEVICE }) });
    expect(scope.device).toBeUndefined();
    expect(scope.payload).toEqual({ deviceId: DEVICE });
  });

  it('a row for another id never enriches (defence against a mis-keyed read)', async () => {
    state.rows = [{ id: '99999999-9999-4999-8999-999999999999', hostname: 'other', siteId: SITE }];
    const scope = await buildTriggerScope({ kind: 'event', orgId: ORG, event: event({ deviceId: DEVICE }) });
    expect(scope.device).toBeUndefined();
  });

  it('a non-uuid deviceId never queries', async () => {
    const scope = await buildTriggerScope({ kind: 'event', orgId: ORG, event: event({ deviceId: "x' OR 1=1" }) });
    expect(state.selects).toBe(0);
    expect(scope.device).toBeUndefined();
  });

  it('secrets in the payload are redacted before they become flow scope', async () => {
    const scope = await buildTriggerScope({
      kind: 'event',
      orgId: ORG,
      event: event({ password: 'hunter2', nested: { apiKey: 'sk_live_abc123', note: 'ok' } }),
    });
    const json = JSON.stringify(scope.payload);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('sk_live_abc123');
    expect((scope.payload as { nested: { note: string } }).nested.note).toBe('ok');
  });

  it('a manual trigger has no event, no payload and no device', async () => {
    const scope = await buildTriggerScope({ kind: 'manual', orgId: ORG });
    expect(scope.kind).toBe('manual');
    expect(scope.orgId).toBe(ORG);
    expect(scope.event).toBeUndefined();
    expect(scope.payload).toBeUndefined();
    expect(scope.device).toBeUndefined();
    expect(Number.isNaN(Date.parse(scope.firedAt))).toBe(false);
    expect(state.selects).toBe(0);
  });
});
