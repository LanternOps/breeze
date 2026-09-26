import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * #7128 — `executeTool` for a tool that declares `selfManagedDbContext`.
 *
 * The SDK wrapper opens no transaction around such a tool, so `executeTool`
 * may be entered with no DB context at all. Its own DB phase (the `deviceArgs`
 * gate) must then run in a SHORT context built from the caller's auth — not on
 * the bare pool, where forced RLS would deny the device lookup — and that
 * context must be closed again before the handler runs, since the handler is
 * the part that waits.
 */

const dbState = vi.hoisted(() => ({ held: undefined as unknown, events: [] as string[] }));
const AUTH_CTX = vi.hoisted(() => ({ scope: 'organization', label: 'from-auth' }));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  hasDbAccessContext: () => dbState.held !== undefined,
  withDbAccessContext: vi.fn(async (ctx: unknown, fn: () => Promise<unknown>) => {
    if (dbState.held) return fn();
    dbState.held = ctx;
    dbState.events.push('open');
    try {
      return await fn();
    } finally {
      dbState.held = undefined;
      dbState.events.push('close');
    }
  }),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

vi.mock('../middleware/auth', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  dbAccessContextFromAuth: vi.fn(() => AUTH_CTX),
}));

vi.mock('./aiToolSchemas', async (orig) => ({
  ...(await orig<typeof import('./aiToolSchemas')>()),
  validateToolInput: () => ({ success: true }),
}));

import { db, withDbAccessContext } from '../db';
import { dbAccessContextFromAuth } from '../middleware/auth';
import { aiTools, executeTool } from './aiTools';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const PROBE = '__self_managed_probe__';
const DEVICE = '33333333-3333-3333-3333-333333333333';

const auth = {
  user: { id: 'user-1', email: 'u@example.com', name: 'U' },
  token: {} as any,
  partnerId: null,
  orgId: 'org-123',
  scope: 'organization',
  accessibleOrgIds: ['org-123'],
  orgCondition: () => undefined,
  canAccessOrg: () => true,
} as unknown as AuthContext;

const handler = vi.fn(async () => {
  dbState.events.push(dbState.held ? 'handler:held' : 'handler:none');
  return JSON.stringify({ ok: true });
});

function register(selfManaged: boolean): void {
  aiTools.set(PROBE, {
    tier: 1,
    domain: 'devices',
    searchHint: 'probe tool for the self-managed context test',
    deviceArgs: ['deviceId'],
    ...(selfManaged ? { selfManagedDbContext: true as const } : {}),
    definition: { name: PROBE, description: 'probe', input_schema: { type: 'object', properties: {} } },
    handler,
  } as AiTool);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.held = undefined;
  dbState.events.length = 0;
  vi.mocked(db.select).mockImplementation(() => {
    dbState.events.push(dbState.held ? 'gate:held' : 'gate:none');
    return {
      from: () => ({ where: () => ({ limit: async () => [{ id: DEVICE, siteId: 's', status: 'online' }] }) }),
    } as any;
  });
});

afterEach(() => {
  aiTools.delete(PROBE);
});

describe('executeTool — selfManagedDbContext (#7128)', () => {
  it('runs the device gate in a short context built from auth, then the handler with none held', async () => {
    register(true);

    const out = await executeTool(PROBE, { deviceId: DEVICE }, auth);

    expect(JSON.parse(out).ok).toBe(true);
    // The trailing open/close is result capture's own short context: a large
    // result writes an artifact row, which must not land on the bare pool.
    expect(dbState.events).toEqual(['open', 'gate:held', 'close', 'handler:none', 'open', 'close']);
    expect(dbAccessContextFromAuth).toHaveBeenCalledWith(auth);
    expect(vi.mocked(withDbAccessContext).mock.calls[0]![0]).toBe(AUTH_CTX);
  });

  it('joins a context the caller already holds instead of opening one (MCP request path)', async () => {
    register(true);
    dbState.held = { scope: 'organization', label: 'request' };

    await executeTool(PROBE, { deviceId: DEVICE }, auth);

    expect(dbState.events).toEqual(['gate:held', 'handler:held']);
    expect(withDbAccessContext).not.toHaveBeenCalled();
  });

  it('leaves a tool without the flag exactly as it was: no context opened by the dispatcher', async () => {
    register(false);

    await executeTool(PROBE, { deviceId: DEVICE }, auth);

    expect(dbState.events).toEqual(['gate:none', 'handler:none']);
    expect(withDbAccessContext).not.toHaveBeenCalled();
  });
});
