import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

/**
 * Security contract for POST /agents/:id/uninstall-authorize — the gate that
 * makes a LOCAL uninstall impossible without RMM authorization.
 *
 * `GET /agents/uninstall.sh` used to be unauthenticated and did the teardown
 * itself, so any local admin could strip a managed machine out of management.
 * The script is now a thin wrapper that calls `nu-agent uninstall --token`,
 * and the agent refuses to remove anything unless THIS route answers `allow`.
 * Everything below pins that: the token is single-use, short-TTL and bound to
 * exactly one device.
 *
 * The DB stand-in below does not just hand back rows. It renders the real
 * Drizzle condition the route built (PgDialect → SQL + params) and applies the
 * predicates that SQL actually contains. Drop `consumed_at IS NULL`,
 * `expires_at > NOW()` or the `device_id` binding from the route and the
 * corresponding test here fails, exactly as it would against Postgres.
 */
type TokenRow = {
  id: string;
  token: string;
  deviceId: string;
  consumedAt: Date | null;
  expiresAt: Date;
};

const store = vi.hoisted(() => ({
  rows: [] as TokenRow[],
  lastSql: '',
  lastParams: [] as unknown[],
}));

vi.mock('../../db', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const dialect = new PgDialect();

  const burn = (condition: unknown, patch: Record<string, unknown>) => {
    const query = dialect.sqlToQuery(condition as never);
    store.lastSql = query.sql;
    store.lastParams = query.params as unknown[];
    const params = query.params as unknown[];

    const checksConsumed = /"consumed_at"\s+is\s+null/i.test(query.sql);
    const checksExpiry = /"expires_at"\s*>\s*NOW\(\)/i.test(query.sql);
    const checksDevice = /"device_id"\s*=/i.test(query.sql);
    const now = Date.now();

    const matched = store.rows.filter((row) => {
      if (!params.includes(row.token)) return false;
      if (checksDevice && !params.includes(row.deviceId)) return false;
      if (checksConsumed && row.consumedAt !== null) return false;
      if (checksExpiry && row.expiresAt.getTime() <= now) return false;
      return true;
    });

    // The real statement is a single atomic UPDATE ... RETURNING, so the burn
    // happens as part of the match. Mirror that here.
    for (const row of matched) Object.assign(row, patch);
    return matched.map((row) => ({ id: row.id }));
  };

  return {
    db: {
      update: vi.fn(() => ({
        set: vi.fn((patch: Record<string, unknown>) => ({
          where: vi.fn((condition: unknown) => ({
            returning: vi.fn(async () => burn(condition, patch)),
          })),
        })),
      })),
    },
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, accessibleOrgIds: null },
  };
});

import { uninstallAuthorizeRoutes } from './uninstallAuthorize';
import { hashEnrollmentKeyCandidates } from '../../services/enrollmentKeySecurity';

const SELF_DEVICE = '11111111-1111-4111-8111-111111111111';
const OTHER_DEVICE = '22222222-2222-4222-8222-222222222222';
const TOKEN = `nuu_${'a1b2c3d4'.repeat(8)}`;

function seed(overrides: Partial<TokenRow> = {}): void {
  store.rows = hashEnrollmentKeyCandidates(TOKEN).map((hash, i) => ({
    id: `token-${i}`,
    token: hash,
    deviceId: SELF_DEVICE,
    consumedAt: null,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    ...overrides,
  }));
}

/** Mounts the route with the agent context an authenticated device token yields. */
function makeApp(deviceId: string | null = SELF_DEVICE): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (deviceId) {
      c.set('agent', { deviceId, agentId: 'agent-1', orgId: 'org-1', role: 'agent' } as never);
    }
    return next();
  });
  app.route('/agents', uninstallAuthorizeRoutes);
  return app;
}

function authorize(app: Hono, body: unknown, id = SELF_DEVICE) {
  return app.request(`/agents/${id}/uninstall-authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /agents/:id/uninstall-authorize — local uninstall gate', () => {
  beforeEach(() => {
    store.rows = [];
    store.lastSql = '';
    store.lastParams = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows and BURNS a live, device-bound token', async () => {
    seed();
    const res = await authorize(makeApp(), { token: TOKEN });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ allowed: true, deviceId: SELF_DEVICE });
    expect(store.rows.every((r) => r.consumedAt instanceof Date)).toBe(true);
  });

  it('is SINGLE-USE — the second presentation of the same token is denied', async () => {
    seed();
    const app = makeApp();

    const first = await authorize(app, { token: TOKEN });
    const second = await authorize(app, { token: TOKEN });

    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ allowed: false });
    expect(store.lastSql).toMatch(/"consumed_at"\s+is\s+null/i);
  });

  it('denies an ALREADY-CONSUMED token', async () => {
    seed({ consumedAt: new Date(Date.now() - 1000) });
    const res = await authorize(makeApp(), { token: TOKEN });

    expect(res.status).toBe(403);
    expect(store.lastSql).toMatch(/"consumed_at"\s+is\s+null/i);
  });

  it('denies an EXPIRED token', async () => {
    seed({ expiresAt: new Date(Date.now() - 60_000) });
    const res = await authorize(makeApp(), { token: TOKEN });

    expect(res.status).toBe(403);
    expect(store.lastSql).toMatch(/"expires_at"\s*>\s*NOW\(\)/i);
    // Nothing was burned — an expired token must not silently consume.
    expect(store.rows.every((r) => r.consumedAt === null)).toBe(true);
  });

  it('denies a token minted for a DIFFERENT device', async () => {
    seed({ deviceId: OTHER_DEVICE });
    const res = await authorize(makeApp(SELF_DEVICE), { token: TOKEN });

    expect(res.status).toBe(403);
    expect(store.lastSql).toMatch(/"device_id"\s*=/i);
    expect(store.rows.every((r) => r.consumedAt === null)).toBe(true);
  });

  it('scopes on the TOKEN-RESOLVED device, not the :id path segment', async () => {
    // A device authenticated as SELF cannot burn OTHER's token by putting
    // OTHER's id in the URL — the path segment is not authority anywhere in
    // this package.
    seed({ deviceId: OTHER_DEVICE });
    const res = await authorize(makeApp(SELF_DEVICE), { token: TOKEN }, OTHER_DEVICE);

    expect(res.status).toBe(403);
    expect(store.lastParams).toContain(SELF_DEVICE);
    expect(store.lastParams).not.toContain(OTHER_DEVICE);
  });

  it('denies an unknown token', async () => {
    store.rows = [];
    const res = await authorize(makeApp(), { token: TOKEN });
    expect(res.status).toBe(403);
  });

  it('gives unknown / expired / consumed / wrong-device the SAME 403 body (no oracle)', async () => {
    const bodies: string[] = [];
    const app = makeApp();

    store.rows = [];
    bodies.push(await (await authorize(app, { token: TOKEN })).text());
    seed({ expiresAt: new Date(Date.now() - 1000) });
    bodies.push(await (await authorize(app, { token: TOKEN })).text());
    seed({ consumedAt: new Date() });
    bodies.push(await (await authorize(app, { token: TOKEN })).text());
    seed({ deviceId: OTHER_DEVICE });
    bodies.push(await (await authorize(app, { token: TOKEN })).text());

    expect(new Set(bodies).size).toBe(1);
  });

  it('matches on the PEPPERED HASH, never the plaintext token', async () => {
    seed();
    await authorize(makeApp(), { token: TOKEN });

    expect(store.lastParams).not.toContain(TOKEN);
    for (const hash of hashEnrollmentKeyCandidates(TOKEN)) {
      expect(store.lastParams).toContain(hash);
    }
  });

  it('401s without an agent context (no device token)', async () => {
    seed();
    const res = await authorize(makeApp(null), { token: TOKEN });

    expect(res.status).toBe(401);
    expect(store.rows.every((r) => r.consumedAt === null)).toBe(true);
  });

  it.each([
    ['missing token', {}],
    ['empty token', { token: '' }],
    ['too short', { token: 'short' }],
    ['non-string', { token: 12345 }],
    ['extra field', { token: `nuu_${'ab'.repeat(32)}`, deviceId: OTHER_DEVICE }],
  ])('rejects a malformed body (%s) before any DB write', async (_name, body) => {
    seed();
    const res = await authorize(makeApp(), body);

    expect(res.status).toBe(400);
    expect(store.lastSql).toBe('');
    expect(store.rows.every((r) => r.consumedAt === null)).toBe(true);
  });
});
