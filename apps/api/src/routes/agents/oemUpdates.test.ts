import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({
  device: [{ id: '22222222-2222-4222-8222-222222222222' }] as Array<{ id: string }>,
  role: 'agent',
  apply: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => m.device }) }) }) },
}));
vi.mock('../../services/oemUpdates/results', () => ({ applyOemUpdateVerification: m.apply }));

import { oemUpdatesRoutes } from './oemUpdates';

const AGENT_ID = 'agent-1';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const good = {
  commandId: '11111111-1111-4111-8111-111111111111',
  bitlockerAfter: 'on',
  biosVersionAfter: '1.21.0',
};

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('agent' as never, { role: m.role } as never);
  return next();
});
app.route('/agents', oemUpdatesRoutes);

function put(body: unknown) {
  return app.request(`/agents/${AGENT_ID}/oem-updates/verification`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  m.device = [{ id: DEVICE_ID }];
  m.role = 'agent';
  m.apply.mockReset();
  m.apply.mockResolvedValue(true);
});

describe('PUT /agents/:id/oem-updates/verification', () => {
  it('applies the report to the authenticated device', async () => {
    const res = await put(good);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ applied: true });
    expect(m.apply).toHaveBeenCalledWith({ deviceId: DEVICE_ID, verification: good });
  });

  it('a report for a run that is not current answers applied: false, so the agent stops retrying', async () => {
    m.apply.mockResolvedValue(false);
    const res = await put(good);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ applied: false });
  });

  it('404 for an unknown device', async () => {
    m.device = [];
    expect((await put(good)).status).toBe(404);
    expect(m.apply).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown key', { ...good, extra: 1 }],
    ['a bad state', { ...good, bitlockerAfter: 'maybe' }],
    ['a bad command id', { ...good, commandId: 'nope' }],
    ['a control character', { ...good, biosVersionAfter: 'a\nb' }],
  ])('refuses %s', async (_name, body) => {
    expect((await put(body)).status).toBe(400);
    expect(m.apply).not.toHaveBeenCalled();
  });

  it('refuses a watchdog token', async () => {
    m.role = 'watchdog';
    expect((await put(good)).status).toBe(403);
    expect(m.apply).not.toHaveBeenCalled();
  });
});
