/**
 * Keeping live gateway grants in step with connection writes: the in-process
 * revocation (only once this process has started the gateway) and the
 * DB-backed connection check registered for cross-replica staleness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: new Map<string, { status: string; configVersion: number } | null>(),
  reads: 0,
  readError: null as Error | null,
  revokeConnection: vi.fn((_id: string) => 2),
  getModelGateway: vi.fn(),
  setGatewayConnectionCheck: vi.fn(),
  captured: [] as unknown[],
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
  db: {
    select: () => ({
      from: () => ({
        where: (cond: { id: string }) => ({
          limit: async () => {
            h.reads += 1;
            if (h.readError) throw h.readError;
            const row = h.rows.get(cond.id);
            return row ? [row] : [];
          },
        }),
      }),
    }),
  },
}));
vi.mock('drizzle-orm', async (orig) => ({
  ...(await orig<typeof import('drizzle-orm')>()),
  // The where() stub above reads the id straight off the condition.
  eq: (_col: unknown, id: string) => ({ id }),
}));
vi.mock('./gateway', () => ({
  getModelGateway: () => h.getModelGateway(),
  setGatewayConnectionCheck: (fn: unknown) => h.setGatewayConnectionCheck(fn),
}));
vi.mock('../sentry', () => ({ captureException: (e: unknown) => { h.captured.push(e); } }));

const mod = await import('./gatewayConnectionState');

beforeEach(() => {
  h.rows.clear();
  h.reads = 0;
  h.readError = null;
  h.captured.length = 0;
  h.revokeConnection.mockReset().mockReturnValue(2);
  h.getModelGateway.mockReset().mockResolvedValue({ revokeConnection: h.revokeConnection });
  h.setGatewayConnectionCheck.mockReset();
  mod.__resetGatewayConnectionStateForTests();
});
afterEach(() => vi.useRealTimers());

describe('gatewayConnectionCheck', () => {
  it('true only for an active connection at the grant\'s config version', async () => {
    h.rows.set('c1', { status: 'active', configVersion: 4 });
    expect(await mod.gatewayConnectionCheck('c1', 4)).toBe(true);
    expect(await mod.gatewayConnectionCheck('c1', 3)).toBe(false);
  });

  it('false for a disconnected or errored connection, and for a missing row', async () => {
    h.rows.set('gone', { status: 'disconnected', configVersion: 4 });
    h.rows.set('err', { status: 'error', configVersion: 4 });
    expect(await mod.gatewayConnectionCheck('gone', 4)).toBe(false);
    expect(await mod.gatewayConnectionCheck('err', 4)).toBe(false);
    expect(await mod.gatewayConnectionCheck('missing', 1)).toBe(false);
  });

  it('caches each connection for ~15 s, then re-reads', async () => {
    vi.useFakeTimers();
    h.rows.set('c1', { status: 'active', configVersion: 4 });
    expect(await mod.gatewayConnectionCheck('c1', 4)).toBe(true);
    expect(await mod.gatewayConnectionCheck('c1', 4)).toBe(true);
    expect(h.reads).toBe(1);
    // Another replica disconnects it: seen once the entry expires.
    h.rows.set('c1', { status: 'disconnected', configVersion: 5 });
    vi.advanceTimersByTime(mod.GATEWAY_CONNECTION_CHECK_TTL_MS - 1);
    expect(await mod.gatewayConnectionCheck('c1', 4)).toBe(true);
    vi.advanceTimersByTime(2);
    expect(await mod.gatewayConnectionCheck('c1', 4)).toBe(false);
    expect(h.reads).toBe(2);
    expect(mod.GATEWAY_CONNECTION_CHECK_TTL_MS).toBe(15_000);
  });

  it('a read failure propagates (the gateway fails closed) and is not cached', async () => {
    h.readError = new Error('db down');
    await expect(mod.gatewayConnectionCheck('c1', 1)).rejects.toThrow('db down');
    h.readError = null;
    h.rows.set('c1', { status: 'active', configVersion: 1 });
    expect(await mod.gatewayConnectionCheck('c1', 1)).toBe(true);
  });

  it('registerGatewayConnectionCheck installs it on the gateway', () => {
    mod.registerGatewayConnectionCheck();
    expect(h.setGatewayConnectionCheck).toHaveBeenCalledWith(mod.gatewayConnectionCheck);
  });
});

describe('revokeGatewayConnectionGrants', () => {
  it('does nothing (and starts no listener) when this process never started the gateway', async () => {
    await mod.revokeGatewayConnectionGrants('c1');
    expect(h.getModelGateway).not.toHaveBeenCalled();
  });

  it('revokes this process\'s grants for the connection once the gateway was started', async () => {
    await mod.acquireModelGateway();
    await mod.revokeGatewayConnectionGrants('c1');
    expect(h.revokeConnection).toHaveBeenCalledWith('c1');
  });

  it('drops the cached check entry so this replica sees its own write at once', async () => {
    h.rows.set('c1', { status: 'active', configVersion: 4 });
    expect(await mod.gatewayConnectionCheck('c1', 4)).toBe(true);
    h.rows.set('c1', { status: 'active', configVersion: 5 });
    await mod.revokeGatewayConnectionGrants('c1');
    expect(await mod.gatewayConnectionCheck('c1', 4)).toBe(false);
  });

  it('best effort: a failure is logged and captured, never thrown', async () => {
    await mod.acquireModelGateway();
    h.revokeConnection.mockImplementation(() => { throw new Error('boom'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(mod.revokeGatewayConnectionGrants('c1')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    expect(h.captured).toHaveLength(1);
  });
});
