import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123' },
      scope: 'organization',
      orgId: 'org-123',
      canAccessOrg: (orgId: string) => orgId === 'org-123',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    c.set('permissions', { permissions: [{ resource: 'scripts', action: 'read' }] });
    return next();
  }),
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgCheck: vi.fn(),
  canAccessDeviceSite: vi.fn(() => true),
}));

import { db } from '../../db';
import { getDeviceWithOrgCheck } from './helpers';
import { scriptsRoutes } from './scripts';

const DEVICE_ID = 'device-1';

/**
 * Captures the projection object literal passed to `db.select({...})` so
 * tests can assert on WHICH columns the route asks for — not just on the
 * canned rows the mock hands back. A mock that ignores the select argument
 * and always returns the same rows can't discriminate "the route added
 * hasAiOrigin" from "the test rigged the response"; asserting the projection
 * shape closes that hole (and is the only way to prove the raw
 * aiSessionId/aiAgentRunId columns are never REQUESTED, since a real Postgres
 * select() literally cannot return a column it didn't ask for).
 */
function mockSelectCapture(rows: unknown[]) {
  const captured: { projection?: Record<string, unknown> } = {};
  vi.mocked(db.select).mockImplementation((projection: unknown) => {
    captured.projection = projection as Record<string, unknown>;
    return {
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(rows),
            }),
          }),
        }),
      }),
    } as never;
  });
  return captured;
}

describe('GET /devices/:id/scripts — AI initiator projection (#5022 W02)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({
      id: DEVICE_ID,
      orgId: 'org-123',
      siteId: null,
    } as never);
    app = new Hono();
    app.route('/devices', scriptsRoutes);
  });

  it('projects the AI initiator kind and an origin-presence flag', async () => {
    const captured = mockSelectCapture([
      { id: 'e1', aiInitiatorKind: 'ai_assistant', hasAiOrigin: true },
    ]);

    const res = await app.request(`/devices/${DEVICE_ID}/scripts`, {
      headers: { Authorization: 'Bearer token' },
    });
    const body = await res.json();

    expect(captured.projection).toHaveProperty('aiInitiatorKind');
    expect(captured.projection).toHaveProperty('hasAiOrigin');
    expect(body.data[0]).toMatchObject({ aiInitiatorKind: 'ai_assistant', hasAiOrigin: true });
  });

  it('never REQUESTS the raw session or run id columns in the list projection', async () => {
    // A real Postgres select() cannot return a column it didn't ask for, so
    // the load-bearing assertion is on the projection literal itself — not on
    // a mocked row, which would only prove the test rigged the output.
    const captured = mockSelectCapture([{ id: 'e1', aiInitiatorKind: 'ai_agent', hasAiOrigin: true }]);

    const body = await (
      await app.request(`/devices/${DEVICE_ID}/scripts`, { headers: { Authorization: 'Bearer token' } })
    ).json();

    expect(captured.projection).not.toHaveProperty('aiSessionId');
    expect(captured.projection).not.toHaveProperty('aiAgentRunId');
    expect(JSON.stringify(body)).not.toContain('sess-');
    expect(JSON.stringify(body)).not.toContain('run-');
  });

  it('reports an unmarked row as null, never as a human attribution', async () => {
    mockSelectCapture([{ id: 'e1', aiInitiatorKind: null, hasAiOrigin: false }]);

    const body = await (
      await app.request(`/devices/${DEVICE_ID}/scripts`, { headers: { Authorization: 'Bearer token' } })
    ).json();

    expect(body.data[0].aiInitiatorKind).toBeNull();
    expect(body.data[0].hasAiOrigin).toBe(false);
  });
});
