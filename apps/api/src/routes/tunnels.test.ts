import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { tunnelRoutes } from './tunnels';

// --- UUID constants ---
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORG_ID    = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_ID   = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';
const SESSION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

// --- DB mock ---
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({
  tunnelSessions: {},
  tunnelAllowlists: {},
  devices: {},
  users: {},
}));

// --- Auth middleware ---
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      user: { id: USER_ID, email: 'test@example.com' },
      canAccessOrg: (id: string) => id === ORG_ID,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

// --- Agent WS helpers ---
vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(() => true),
  isAgentConnected: vi.fn(() => true),
}));

// --- Remote access policy ---
vi.mock('../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn(async () => ({ allowed: true })),
}));

// --- WS ticket ---
vi.mock('../services/remoteSessionAuth', () => ({
  createWsTicket: vi.fn(async () => 'ws-ticket-abc'),
}));

import { db } from '../db';
import { sendCommandToAgent } from './agentWs';

// Reusable device fixture (online, agent connected)
const onlineDevice = {
  id: DEVICE_ID,
  orgId: ORG_ID,
  agentId: 'agent-abc',
  status: 'online',
};

// Reusable session fixture (what the DB insert returns)
const sessionRecord = {
  id: SESSION_ID,
  deviceId: DEVICE_ID,
  userId: USER_ID,
  orgId: ORG_ID,
  type: 'vnc',
  status: 'pending',
  targetHost: '127.0.0.1',
  targetPort: 5900,
  sourceIp: '127.0.0.1',
  createdAt: new Date(),
  updatedAt: new Date(),
  endedAt: null,
  errorMessage: null,
};

/**
 * makeSelectChain — resolves `rows` for both:
 *   db.select().from(t).where(cond).limit(n)  → device lookup
 *   db.select().from(t).where(cond)            → allowlist queries (awaited directly)
 */
function makeSelectChain(rows: any[]) {
  const whereResult = Object.assign(Promise.resolve(rows), {
    limit: vi.fn().mockResolvedValue(rows),
    orderBy: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(rows),
    }),
  });
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(whereResult),
    }),
  };
}

function makeInsertChain(rows: any[]) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(rows),
    }),
  };
}

describe('POST /tunnels (VNC)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/tunnels', tunnelRoutes);

    // Default select: device lookup returns onlineDevice, allowlist returns []
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([onlineDevice]) as any)  // device lookup
      .mockReturnValueOnce(makeSelectChain([]) as any);              // source-IP allowlist (no rules = allowed)

    // Insert returns the session record
    vi.mocked(db.insert).mockReturnValue(makeInsertChain([sessionRecord]) as any);
  });

  it('does not include vncPassword in the 201 response body (ARD auth is used at the client)', async () => {
    const res = await app.request('/tunnels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID, type: 'vnc' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).not.toHaveProperty('vncPassword');
  });

  it('does not include vncPassword in the tunnel_open command payload sent to the agent', async () => {
    const res = await app.request('/tunnels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID, type: 'vnc' }),
    });

    expect(res.status).toBe(201);

    // Verify the command dispatched to the agent has no vncPassword
    expect(sendCommandToAgent).toHaveBeenCalledOnce();
    const [, command] = vi.mocked(sendCommandToAgent).mock.calls[0]!;
    expect(command.payload).not.toHaveProperty('vncPassword');
  });

  it('returns session fields in the 201 response body', async () => {
    const res = await app.request('/tunnels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID, type: 'vnc' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty('id', SESSION_ID);
    expect(body).toHaveProperty('type', 'vnc');
    expect(body).toHaveProperty('status', 'pending');
  });
});
