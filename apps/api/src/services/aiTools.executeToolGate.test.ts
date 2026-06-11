import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Integration: `executeTool` (the universal dispatch chokepoint for the chat,
 * MCP, and SDK paths) runs the declarative device gate BEFORE the handler, so a
 * tool declaring `deviceArgs` cannot reach a device outside the caller's scope
 * even if its handler does no checking of its own.
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

// Keep every real schema export; only force input validation to pass so the
// probe tool (which has no registered Zod schema) reaches the gate.
vi.mock('./aiToolSchemas', async (orig) => ({
  ...(await orig<typeof import('./aiToolSchemas')>()),
  validateToolInput: () => ({ success: true }),
}));

import { db } from '../db';
import { aiTools, executeTool } from './aiTools';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const PROBE = '__device_gate_probe__';
const FOREIGN_DEVICE = '99999999-9999-9999-9999-999999999999';
const OWN_DEVICE = '33333333-3333-3333-3333-333333333333';

function deviceLookup(rows: any[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  } as any;
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'u@example.com', name: 'U' },
    token: {} as any,
    partnerId: null,
    orgId: 'org-123',
    scope: 'organization',
    accessibleOrgIds: ['org-123'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as any;
}

// A tool that ALWAYS succeeds and does NO checking of its own — so the only
// thing that can deny a foreign device is the central gate.
const handler = vi.fn(async () => JSON.stringify({ success: true, ranHandler: true }));

beforeEach(() => {
  vi.clearAllMocks();
  aiTools.set(PROBE, {
    tier: 1,
    deviceArgs: ['deviceId'],
    definition: { name: PROBE, description: 'probe', input_schema: { type: 'object', properties: {} } },
    handler,
  } as AiTool);
});

afterEach(() => {
  aiTools.delete(PROBE);
});

describe('executeTool runs the declarative device gate before the handler', () => {
  it('denies a foreign device and never invokes the handler', async () => {
    vi.mocked(db.select).mockImplementation(() => deviceLookup([]) as any); // gate lookup excluded
    const out = await executeTool(PROBE, { deviceId: FOREIGN_DEVICE }, makeAuth());
    expect(JSON.parse(out).error).toMatch(/not found or access denied/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it('invokes the handler when the declared device is accessible', async () => {
    vi.mocked(db.select).mockImplementation(
      () => deviceLookup([{ id: OWN_DEVICE, hostname: 'h', siteId: 's', status: 'online' }]) as any,
    );
    const out = await executeTool(PROBE, { deviceId: OWN_DEVICE }, makeAuth());
    expect(JSON.parse(out).ranHandler).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // Regression (finding A): the helper device-scope gate must ONLY engage when
  // auth.helperDeviceId is set. A normal (non-helper) caller's input must reach
  // the handler untouched — no forced/injected device field.
  it('passes input through untouched for a normal (non-helper) caller', async () => {
    vi.mocked(db.select).mockImplementation(
      () => deviceLookup([{ id: OWN_DEVICE, hostname: 'h', siteId: 's', status: 'online' }]) as any,
    );
    const input = { deviceId: OWN_DEVICE, foo: 'bar' };
    await executeTool(PROBE, input, makeAuth()); // makeAuth() has no helperDeviceId
    expect(handler).toHaveBeenCalledWith(input, expect.anything());
  });
});
