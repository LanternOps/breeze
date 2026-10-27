import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Tool Catalog W06 (#5221) Task A4 — the `create_alert` built-in (Tier 2). */

const m = vi.hoisted(() => ({
  ctx: [] as string[],
  device: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => m.device() }) }) }) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: async (c: { orgId: string }, fn: () => Promise<unknown>) => {
    m.ctx.push(`org:${c.orgId}`);
    try { return await fn(); } finally { m.ctx.pop(); }
  },
}));
vi.mock('../../alertCreation', () => ({
  createAutomationStyleAlert: (input: unknown) => m.create(m.ctx[m.ctx.length - 1] ?? 'none', input),
}));

import { executeCreateAlert } from './createAlert';
import type { BuiltinContext } from './types';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const DEVICE = 'aaaaaaaa-0000-4000-8000-000000000001';

const ctx = { run: { id: 'run-1', orgId: ORG, flowId: 'flow-1' }, auth: { partnerId: PARTNER }, owner: { orgId: ORG, partnerId: PARTNER } } as unknown as BuiltinContext;

beforeEach(() => {
  m.ctx.length = 0;
  m.device.mockReset().mockResolvedValue([{ id: DEVICE }]);
  m.create.mockReset().mockResolvedValue({ alertId: 'alert-1' });
});

describe('executeCreateAlert', () => {
  it('creates one alert on the device', async () => {
    const out = await executeCreateAlert({ deviceId: DEVICE, severity: 'high', title: 'Disk', message: 'Low' }, ctx);
    expect(out).toEqual({ kind: 'completed', output: { alertId: 'alert-1' }, truncated: false });
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.create.mock.calls[0]![0]).toBe(`org:${ORG}`);
  });

  it('payload carries flowRunId, no automationId', async () => {
    await executeCreateAlert({ deviceId: DEVICE, severity: 'low', message: 'Low' }, ctx);
    expect(m.create.mock.calls[0]![1]).toEqual({
      orgId: ORG, deviceId: DEVICE, severity: 'low', title: 'Flow alert', message: 'Low',
      provenance: { kind: 'flow', flowRunId: 'run-1' },
    });
  });

  it("another org's device is refused before any write", async () => {
    m.device.mockResolvedValue([]);
    const out = await executeCreateAlert({ deviceId: DEVICE, severity: 'low', message: 'x' }, ctx);
    expect(out).toMatchObject({ kind: 'failed', code: 'reference_not_owned', policy: true });
    expect(m.create).not.toHaveBeenCalled();
  });

  it('a non-uuid device id is input_invalid before any read', async () => {
    const out = await executeCreateAlert({ deviceId: 'web-1', severity: 'low', message: 'x' }, ctx);
    expect(out).toMatchObject({ kind: 'failed', code: 'input_invalid', policy: true });
    expect(m.device).not.toHaveBeenCalled();
  });

  it('failure is alert_create_failed', async () => {
    m.create.mockResolvedValue(null);
    expect(await executeCreateAlert({ deviceId: DEVICE, severity: 'low', message: 'x' }, ctx))
      .toMatchObject({ kind: 'failed', code: 'alert_create_failed', policy: false });
    m.create.mockRejectedValue(new Error('db down'));
    expect(await executeCreateAlert({ deviceId: DEVICE, severity: 'low', message: 'x' }, ctx))
      .toMatchObject({ kind: 'failed', code: 'alert_create_failed', policy: false });
  });
});
