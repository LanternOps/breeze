import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Public Quick Support endpoints. The code IS the auth, so the tests that
 * matter are the ones proving a code cannot be reused, cannot outlive its
 * TTL, and that failures are indistinguishable from one another.
 */

const {
  rateLimiter,
  getRedis,
  logSessionAudit,
  getTrustedClientIp,
  evaluateCapability,
  partnerTrustMode,
} = vi.hoisted(() => ({
  rateLimiter: vi.fn(() => Promise.resolve({ allowed: true, currentCount: 1 })),
  getRedis: vi.fn(() => ({}) as unknown),
  logSessionAudit: vi.fn(() => Promise.resolve()),
  getTrustedClientIp: vi.fn(() => '203.0.113.9'),
  evaluateCapability: vi.fn(async (_cap?: string, _ctx?: unknown): Promise<any> => ({ allow: true })),
  partnerTrustMode: vi.fn((): 'off' | 'shadow' | 'enforce' => 'off'),
}));

vi.mock('../services/rate-limit', () => ({ rateLimiter }));
vi.mock('../services/redis', () => ({ getRedis }));
vi.mock('./remote/helpers', () => ({ logSessionAudit }));
vi.mock('../services/partnerTrust', () => ({ evaluateCapability }));
vi.mock('../config/partnerTrustMode', () => ({ partnerTrustMode }));
// clientIp is mocked, but rateLimitIpKey is NOT stubbed to identity — the real
// implementation is re-exported so the key-shape assertions below stay honest.
vi.mock('../services/clientIp', async () => {
  const actual = await vi.importActual<typeof import('../services/clientIp')>('../services/clientIp');
  return { getTrustedClientIp, rateLimitIpKey: actual.rateLimitIpKey };
});

/**
 * The deployment-wide miss budget is exercised for real (not mocked) against a
 * tiny in-memory stand-in for the Redis sorted set it uses. Mocking the budget
 * module would only prove the route calls it; what actually needs proving is
 * that misses from ONE caller degrade the endpoint for EVERY caller, which is
 * the whole point of the control.
 */
function createFakeRedis() {
  const zsets = new Map<string, Array<{ score: number; member: string }>>();
  const entries = (key: string) => {
    let v = zsets.get(key);
    if (!v) { v = []; zsets.set(key, v); }
    return v;
  };
  const multi = () => {
    const ops: Array<() => unknown> = [];
    const chain = {
      zremrangebyscore(key: string, _min: string, max: number) {
        ops.push(() => { zsets.set(key, entries(key).filter((e) => e.score > max)); return 0; });
        return chain;
      },
      zadd(key: string, score: number, member: string) {
        ops.push(() => { entries(key).push({ score, member }); return 1; });
        return chain;
      },
      zcard(key: string) {
        ops.push(() => entries(key).length);
        return chain;
      },
      expire() { ops.push(() => 1); return chain; },
      exec: () => Promise.resolve(ops.map((op) => [null, op()] as [null, unknown])),
    };
    return chain;
  };
  return {
    multi,
    /** Test-only: how much of the GLOBAL backstop has been spent. */
    missCount: () => (zsets.get('support-code:miss-budget') ?? []).length,
    /** Test-only: how much of one /64 sub-budget has been spent (IPv4 folds to itself). */
    sourceMissCount: (folded: string) =>
      (zsets.get(`support-code:miss-budget:src:${folded}`) ?? []).length,
    /** Test-only: pre-load `n` fresh misses under a key without N requests. */
    seedMisses: (key: string, n: number) => {
      const arr = entries(key);
      const now = Date.now();
      for (let i = 0; i < n; i++) arr.push({ score: now, member: `seed-${i}-${Math.random()}` });
    },
  };
}

let fakeRedis: ReturnType<typeof createFakeRedis>;

// Binary resolution is stubbed so the download tests never touch the network.
const { getBinarySource, getGithubAgentUrl, isS3Configured, getPresignedUrl, isS3NotFound } =
  vi.hoisted(() => ({
    getBinarySource: vi.fn((): 'github' | 'local' => 'github'),
    getGithubAgentUrl: vi.fn((os: string, arch: string) => `https://gh.test/breeze-agent-${os}-${arch}.exe`),
    isS3Configured: vi.fn(() => false),
    getPresignedUrl: vi.fn(() => Promise.resolve('https://s3.test/agent.exe')),
    isS3NotFound: vi.fn(() => false),
  }));

vi.mock('../services/binarySource', () => ({ getBinarySource, getGithubAgentUrl }));
vi.mock('../services/s3Storage', () => ({ isS3Configured, getPresignedUrl, isS3NotFound }));

vi.mock('../services/enrollmentKeySecurity', async () => {
  const { createHash } = await import('node:crypto');
  return {
    hashEnrollmentKey: vi.fn((k: string) => `keyhash:${k}`),
    hashEnrollmentSecret: vi.fn((s: string) => createHash('sha256').update(s).digest('hex')),
  };
});

const selectResults: unknown[][] = [];
const updateResults: unknown[][] = [];
const insertedValues: unknown[] = [];
let updateWhereCalled = 0;
// Every builder handed back by db.select(), in call order — lets a test
// inspect what a specific `.where(...)` call was actually built with instead
// of just trusting a mock that returns a fixed row regardless of the query.
const selectBuilders: Array<Record<string, unknown>> = [];

vi.mock('../db', () => {
  const select = vi.fn(() => {
    const rows = selectResults.shift() ?? [];
    const builder: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'leftJoin', 'innerJoin']) builder[m] = vi.fn(() => builder);
    builder.limit = vi.fn(() => Promise.resolve(rows));
    selectBuilders.push(builder);
    return builder;
  });

  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => {
        updateWhereCalled++;
        return { returning: vi.fn(() => Promise.resolve(updateResults.shift() ?? [])) };
      }),
    })),
  }));

  const insert = vi.fn(() => ({
    values: vi.fn((v: unknown) => {
      insertedValues.push(v);
      return Promise.resolve([]);
    }),
  }));

  return {
    db: { select, update, insert },
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
    runOutsideDbContext: vi.fn(<T>(fn: () => T): T => fn()),
  };
});

vi.mock('../db/schema', () => ({
  supportSessions: {
    id: 'supportSessions.id',
    orgId: 'supportSessions.orgId',
    codeHash: 'supportSessions.codeHash',
    status: 'supportSessions.status',
    codeExpiresAt: 'supportSessions.codeExpiresAt',
  },
  enrollmentKeys: {},
  sites: { id: 'sites.id', orgId: 'sites.orgId' },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  partners: { id: 'partners.id', name: 'partners.name' },
  partnerLoginBranding: {
    partnerId: 'partnerLoginBranding.partnerId',
    logoUrl: 'partnerLoginBranding.logoUrl',
    accentColor: 'partnerLoginBranding.accentColor',
    headline: 'partnerLoginBranding.headline',
  },
}));

import { hashSupportCode } from '../services/quickSupportCode';
import {
  MISS_BUDGET_PER_SOURCE_PER_WINDOW,
  MISS_BUDGET_GLOBAL_PER_WINDOW,
  _resetSupportCodeMissBudgetStateForTests,
} from '../services/supportCodeMissBudget';
import { supportPublicRoutes } from './supportPublic';

// The mint alphabet is digits 2-9 (a code is read aloud over the phone), so
// the digit form is the ordinary case here. LEGACY_CODE covers the
// letters+digits codes minted before the switch, which must still check and
// redeem — validity is decided by the hash lookup, not by the syntax filter.
const CODE = '234567892';
const LEGACY_CODE = 'KTM4H7P2X';
const FUTURE = new Date(Date.now() + 10 * 60_000);
const PAST = new Date(Date.now() - 60_000);

function pendingSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    orgId: 'qs-org',
    createdByUserId: 'creator-1',
    status: 'pending',
    codeExpiresAt: FUTURE,
    hardExpiresAt: new Date(Date.now() + 8 * 3_600_000),
    ...overrides,
  };
}

function redeem(body: Record<string, unknown> = {}) {
  return supportPublicRoutes.request('/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: CODE, hostname: 'DESKTOP-1', osType: 'windows', ...body }),
  });
}

// Drizzle's `eq`/`and` (used for real here — only ../db and ../db/schema are
// mocked) build a real SQL AST even though the mocked schema columns are
// plain strings rather than real Column objects: `sql`${left} = ${right}``
// inserts both raw operands directly into queryChunks (neither side satisfies
// isDriverValueEncoder, so neither gets wrapped in a Param). That makes the
// exact identifiers a `.where(...)` call was built with recoverable by
// walking the tree — see automationWorker.resolveAssignment.test.ts for the
// same pattern.
function collectSqlLeafStrings(node: unknown, seen = new Set<unknown>(), acc: string[] = []): string[] {
  if (typeof node === 'string') {
    acc.push(node);
    return acc;
  }
  if (node === null || typeof node !== 'object' || seen.has(node)) return acc;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectSqlLeafStrings(item, seen, acc);
    return acc;
  }
  const queryChunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(queryChunks)) {
    for (const item of queryChunks) collectSqlLeafStrings(item, seen, acc);
  }
  return acc;
}

/** Stands in for the ~60 MB agent asset — a real body, three bytes long. */
const fetchMock = vi.fn(() => Promise.resolve(
  new Response(new Uint8Array([0x4d, 0x5a, 0x90]), {
    status: 200,
    headers: { 'content-length': '3' },
  }),
));

beforeEach(() => {
  selectResults.length = 0;
  updateResults.length = 0;
  insertedValues.length = 0;
  selectBuilders.length = 0;
  updateWhereCalled = 0;
  vi.clearAllMocks();
  _resetSupportCodeMissBudgetStateForTests();
  fakeRedis = createFakeRedis();
  getRedis.mockReturnValue(fakeRedis as unknown);
  rateLimiter.mockResolvedValue({ allowed: true, currentCount: 1 });
  getTrustedClientIp.mockReturnValue('203.0.113.9');
  getBinarySource.mockReturnValue('github');
  partnerTrustMode.mockReturnValue('off');
  evaluateCapability.mockResolvedValue({ allow: true });
  getGithubAgentUrl.mockImplementation((os: string, arch: string) => `https://gh.test/breeze-agent-${os}-${arch}.exe`);
  isS3Configured.mockReturnValue(false);
  fetchMock.mockResolvedValue(new Response(new Uint8Array([0x4d, 0x5a, 0x90]), {
    status: 200,
    headers: { 'content-length': '3' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  process.env.PUBLIC_API_URL = 'https://us.2breeze.app';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.API_URL;
});

describe('GET /check/:code', () => {
  /** A live session joined to its partner and that partner's login branding. */
  function brandedRow(overrides: Record<string, unknown> = {}) {
    return {
      status: 'pending',
      codeExpiresAt: FUTURE,
      partnerName: 'Northwind IT',
      logoUrl: 'https://cdn.example.com/northwind.png',
      accentColor: '#1B4F9C',
      headline: 'Support you can call',
      ...overrides,
    };
  }

  it('reports a pending unexpired code as valid', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    const body = await (await supportPublicRoutes.request(`/check/${CODE}`)).json();
    expect(body).toEqual({ valid: true, branding: null });
  });

  it('returns the partner branding for a valid code', async () => {
    selectResults.push([brandedRow()]);
    const body = await (await supportPublicRoutes.request(`/check/${CODE}`)).json();
    expect(body).toEqual({
      valid: true,
      branding: {
        partnerName: 'Northwind IT',
        logoUrl: 'https://cdn.example.com/northwind.png',
        accentColor: '#1B4F9C',
        headline: 'Support you can call',
      },
    });
  });

  it('falls back to the partner name when no branding row exists', async () => {
    selectResults.push([brandedRow({ logoUrl: null, accentColor: null, headline: null })]);
    const body = await (await supportPublicRoutes.request(`/check/${CODE}`)).json();
    expect(body).toEqual({
      valid: true,
      branding: { partnerName: 'Northwind IT', logoUrl: null, accentColor: null, headline: null },
    });
  });

  it('drops an accent color that is not a plain 6-digit hex', async () => {
    // The value lands in an inline style on a public page — anything that is
    // not exactly #RRGGBB is dropped rather than echoed.
    selectResults.push([brandedRow({ accentColor: 'red; background:url(javascript:1)' })]);
    const body = await (await supportPublicRoutes.request(`/check/${CODE}`)).json();
    expect(body.branding.accentColor).toBeNull();
    expect(body.branding.partnerName).toBe('Northwind IT');
  });

  it('never returns tenant identifiers alongside the branding', async () => {
    selectResults.push([brandedRow()]);
    const body = await (await supportPublicRoutes.request(`/check/${CODE}`)).json();
    expect(Object.keys(body.branding).sort())
      .toEqual(['accentColor', 'headline', 'logoUrl', 'partnerName']);
    expect(JSON.stringify(body)).not.toMatch(/partnerId|orgId|sessionId/);
  });

  it('reveals nothing for an invalid code even when branding exists', async () => {
    selectResults.push([brandedRow({ status: 'claimed' })]);
    const body = await (await supportPublicRoutes.request(`/check/${CODE}`)).json();
    expect(body).toEqual({ valid: false });
    expect(JSON.stringify(body)).not.toContain('Northwind');
  });

  it('reports an expired code as invalid', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: PAST }]);
    expect(await (await supportPublicRoutes.request(`/check/${CODE}`)).json()).toEqual({ valid: false });
  });

  it('reports an already-claimed code as invalid', async () => {
    selectResults.push([{ status: 'claimed', codeExpiresAt: FUTURE }]);
    expect(await (await supportPublicRoutes.request(`/check/${CODE}`)).json()).toEqual({ valid: false });
  });

  it('reports an unknown code as invalid', async () => {
    selectResults.push([]);
    expect(await (await supportPublicRoutes.request(`/check/${CODE}`)).json()).toEqual({ valid: false });
  });

  it('rejects a malformed code without touching the database', async () => {
    const body = await (await supportPublicRoutes.request('/check/not-a-code')).json();
    expect(body).toEqual({ valid: false });
    expect(selectResults).toHaveLength(0); // nothing was consumed
  });

  it('accepts the human-formatted code', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    expect(await (await supportPublicRoutes.request('/check/234-567-892')).json())
      .toEqual({ valid: true, branding: null });
  });

  it('still accepts a legacy letters+digits code minted before the alphabet switch', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    expect(await (await supportPublicRoutes.request(`/check/${LEGACY_CODE}`)).json())
      .toEqual({ valid: true, branding: null });
  });

  it('truncates an over-long partner name and headline rather than dropping branding', async () => {
    selectResults.push([brandedRow({
      partnerName: 'N'.repeat(500),
      headline: 'H'.repeat(500),
    })]);
    const body = await (await supportPublicRoutes.request(`/check/${CODE}`)).json();
    expect(body.valid).toBe(true);
    expect(body.branding.partnerName).toBe('N'.repeat(120));
    expect(body.branding.headline).toBe('H'.repeat(200));
  });

  it('drops a logo URL that is not https', async () => {
    // The value lands in an <img src> on an unauthenticated page. http: is a
    // plaintext beacon and mixed content; javascript:/data: are worse.
    for (const logoUrl of ['http://cdn.example.com/l.png', 'javascript:alert(1)', 'data:image/png;base64,AAA', 'not a url']) {
      selectResults.push([brandedRow({ logoUrl })]);
      const body = await (await supportPublicRoutes.request(`/check/${CODE}`)).json();
      expect(body.branding.logoUrl, logoUrl).toBeNull();
      expect(body.branding.partnerName).toBe('Northwind IT');
    }
  });

  it('keeps an https logo URL', async () => {
    selectResults.push([brandedRow({ logoUrl: 'https://cdn.example.com/northwind.png' })]);
    const body = await (await supportPublicRoutes.request(`/check/${CODE}`)).json();
    expect(body.branding.logoUrl).toBe('https://cdn.example.com/northwind.png');
  });

  it('omits the branding block when the partner name is blank', async () => {
    selectResults.push([brandedRow({ partnerName: '   ' })]);
    const body = await (await supportPublicRoutes.request(`/check/${CODE}`)).json();
    expect(body).toEqual({ valid: true, branding: null });
  });

  it('sets no-store, private on valid, invalid, malformed and 429 responses', async () => {
    // The code is in the path and the answer flips from valid to invalid within
    // 15 minutes — nothing about /check is cacheable, including the 429 (a
    // cached one would be wrong for the next visitor behind the same NAT).
    selectResults.push([brandedRow()]);
    const valid = await supportPublicRoutes.request(`/check/${CODE}`);
    expect(valid.headers.get('Cache-Control')).toBe('no-store, private');

    selectResults.push([]);
    const invalid = await supportPublicRoutes.request(`/check/${CODE}`);
    expect(invalid.headers.get('Cache-Control')).toBe('no-store, private');

    const malformed = await supportPublicRoutes.request('/check/not-a-code');
    expect(malformed.headers.get('Cache-Control')).toBe('no-store, private');

    rateLimiter.mockResolvedValue({ allowed: false, currentCount: 99 });
    const limited = await supportPublicRoutes.request(`/check/${CODE}`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('429s when rate limited', async () => {
    rateLimiter.mockResolvedValue({ allowed: false, currentCount: 99 });
    const res = await supportPublicRoutes.request(`/check/${CODE}`);
    expect(res.status).toBe(429);
  });

  /**
   * `rateLimitIpKey` is unit-tested exhaustively in clientIp.test.ts, but
   * nothing proves the ROUTE actually wraps the client IP with it before
   * building the limiter key — a revert of `rateLimitIpKey(ip)` back to raw
   * `ip` (e.g. during a refactor) would pass every existing supportPublic
   * test unnoticed, since getTrustedClientIp is mocked to a fixed IPv4 value
   * everywhere else here. rateLimitIpKey itself is NOT mocked (see the
   * '../services/clientIp' mock above), so driving the mocked
   * getTrustedClientIp with real IPv6 addresses exercises the true
   * fold-to-/64 pipeline end to end.
   */
  it('folds an IPv6 client IP to its /64 network before keying the rate limiter', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    getTrustedClientIp.mockReturnValue('2001:db8:1:2:3:4:5:6');
    await supportPublicRoutes.request(`/check/${CODE}`);
    expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), 'support-check:2001:db8:1:2::', 30, 60);

    // A different host within the SAME /64 lands on the SAME bucket.
    rateLimiter.mockClear();
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    getTrustedClientIp.mockReturnValue('2001:db8:1:2:ffff:ffff:ffff:ffff');
    await supportPublicRoutes.request(`/check/${CODE}`);
    expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), 'support-check:2001:db8:1:2::', 30, 60);

    // A DIFFERENT /64 is a distinct bucket.
    rateLimiter.mockClear();
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    getTrustedClientIp.mockReturnValue('2001:db8:1:3::1');
    await supportPublicRoutes.request(`/check/${CODE}`);
    expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), 'support-check:2001:db8:1:3::', 30, 60);
  });
});

/**
 * The two-tier miss budget: a per-source /64 sub-budget (an attacking network
 * can only degrade itself) plus a much higher deployment-wide backstop (trips
 * only under broadly distributed guessing). The cross-caller property — that a
 * single source can no longer 429 Quick Support for every partner — is the
 * whole reason this control exists.
 */
describe('two-tier miss budget', () => {
  /** Burn `n` well-formed misses through /check from the currently mocked IP. */
  async function burnMisses(n: number) {
    for (let i = 0; i < n; i++) {
      selectResults.push([]);
      await supportPublicRoutes.request(`/check/${CODE}`);
    }
  }

  it('counts a well-formed miss on check, download and redeem alike', async () => {
    selectResults.push([]);
    await supportPublicRoutes.request(`/check/${CODE}`);
    expect(fakeRedis.missCount()).toBe(1);

    selectResults.push([]);
    await supportPublicRoutes.request(`/download/windows?code=${CODE}`);
    expect(fakeRedis.missCount()).toBe(2);

    selectResults.push([]);
    await redeem();
    expect(fakeRedis.missCount()).toBe(3);

    // The default caller is 203.0.113.9 (an IPv4, which folds to itself), so
    // every one of those misses also landed on its /64 sub-budget.
    expect(fakeRedis.sourceMissCount('203.0.113.9')).toBe(3);
  });

  it('does not charge a successful lookup', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    expect((await supportPublicRoutes.request(`/check/${CODE}`)).status).toBe(200);

    const session = pendingSession();
    selectResults.push([session]);
    updateResults.push([{ ...session, status: 'claimed' }]);
    selectResults.push([{ id: 'site-1' }]);
    expect((await redeem()).status).toBe(200);

    expect(fakeRedis.missCount()).toBe(0);
    expect(fakeRedis.sourceMissCount('203.0.113.9')).toBe(0);
  });

  it('does not charge malformed input', async () => {
    // Not a guess against the code space — it can never match a stored hash.
    await supportPublicRoutes.request('/check/not-a-code');
    await supportPublicRoutes.request('/download/windows?code=nope');
    // 9 chars so it clears the zod length check, but 0/1 are outside the code
    // alphabet so normalizeSupportCode still rejects it.
    await redeem({ code: '111111111' });
    expect(fakeRedis.missCount()).toBe(0);
    expect(fakeRedis.sourceMissCount('203.0.113.9')).toBe(0);
  });

  it('does not charge a lost claim race — that code was real', async () => {
    const session = pendingSession();
    selectResults.push([session]);
    updateResults.push([]); // the racer already flipped it
    expect((await redeem()).status).toBe(404);
    expect(fakeRedis.missCount()).toBe(0);
    expect(fakeRedis.sourceMissCount('203.0.113.9')).toBe(0);
  });

  it('429s only the exhausted /64, and leaves a DIFFERENT source fully working', async () => {
    // The lever being removed: one source spends its own sub-budget…
    getTrustedClientIp.mockReturnValue('198.51.100.1');
    await burnMisses(MISS_BUDGET_PER_SOURCE_PER_WINDOW);
    expect(fakeRedis.sourceMissCount('198.51.100.1')).toBe(MISS_BUDGET_PER_SOURCE_PER_WINDOW);

    // …so IT is now 429'd across all three endpoints…
    expect((await supportPublicRoutes.request(`/check/${CODE}`)).status).toBe(429);
    expect((await supportPublicRoutes.request(`/download/windows?code=${CODE}`)).status).toBe(429);
    expect((await redeem()).status).toBe(429);

    // …but a completely unrelated source is untouched (the global backstop is
    // nowhere near its far-higher limit).
    getTrustedClientIp.mockReturnValue('203.0.113.77');
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    const other = await supportPublicRoutes.request(`/check/${CODE}`);
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ valid: true, branding: null });
  });

  it('shares one sub-budget across a /64 but keeps different /64s independent', async () => {
    getTrustedClientIp.mockReturnValue('2001:db8:1:2::1');
    await burnMisses(MISS_BUDGET_PER_SOURCE_PER_WINDOW - 1);

    // A second host in the SAME /64 spends the last unit of the shared budget.
    getTrustedClientIp.mockReturnValue('2001:db8:1:2:ffff:ffff:ffff:ffff');
    selectResults.push([]);
    await supportPublicRoutes.request(`/check/${CODE}`);

    // Both hosts in that /64 are now denied — they draw on one bucket.
    expect((await supportPublicRoutes.request(`/check/${CODE}`)).status).toBe(429);
    getTrustedClientIp.mockReturnValue('2001:db8:1:2::1');
    expect((await supportPublicRoutes.request(`/check/${CODE}`)).status).toBe(429);

    // A host in a DIFFERENT /64 has its own independent bucket.
    getTrustedClientIp.mockReturnValue('2001:db8:1:3::1');
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    expect((await supportPublicRoutes.request(`/check/${CODE}`)).status).toBe(200);
  });

  it('trips the global backstop once enough DISTINCT /64s each contribute misses', async () => {
    // Each /64 is capped at its sub-budget, so reaching the backstop takes many
    // networks — the distributed case the backstop exists for.
    const sourcesNeeded = Math.ceil(MISS_BUDGET_GLOBAL_PER_WINDOW / MISS_BUDGET_PER_SOURCE_PER_WINDOW);
    for (let s = 0; s <= sourcesNeeded; s++) {
      getTrustedClientIp.mockReturnValue(`198.18.${s}.1`);
      await burnMisses(MISS_BUDGET_PER_SOURCE_PER_WINDOW);
    }
    expect(fakeRedis.missCount()).toBeGreaterThanOrEqual(MISS_BUDGET_GLOBAL_PER_WINDOW);

    // A brand-new /64 that has spent nothing of its own sub-budget is now
    // denied by the backstop — this is the accepted broad-attack degradation.
    getTrustedClientIp.mockReturnValue('203.0.113.200');
    expect((await supportPublicRoutes.request(`/check/${CODE}`)).status).toBe(429);
  });

  it('returns a byte-identical 429 whichever limit tripped (per-IP, sub-budget, or backstop)', async () => {
    // A guesser must not be able to tell which control they hit.
    getTrustedClientIp.mockReturnValue('203.0.113.9');
    rateLimiter.mockResolvedValue({ allowed: false, currentCount: 99 });
    const perIp = await supportPublicRoutes.request(`/check/${CODE}`);

    rateLimiter.mockResolvedValue({ allowed: true, currentCount: 1 });
    fakeRedis.seedMisses('support-code:miss-budget:src:203.0.113.9', MISS_BUDGET_PER_SOURCE_PER_WINDOW);
    const sourceTier = await supportPublicRoutes.request(`/check/${CODE}`);

    getTrustedClientIp.mockReturnValue('203.0.113.250');
    fakeRedis.seedMisses('support-code:miss-budget', MISS_BUDGET_GLOBAL_PER_WINDOW);
    const globalTier = await supportPublicRoutes.request(`/check/${CODE}`);

    expect(perIp.status).toBe(429);
    expect(sourceTier.status).toBe(429);
    expect(globalTier.status).toBe(429);
    const bodies = await Promise.all([perIp.json(), sourceTier.json(), globalTier.json()]);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    for (const r of [perIp, sourceTier, globalTier]) {
      expect(r.headers.get('Cache-Control')).toBe('no-store, private');
    }
    // None of the three denials reached the database.
    expect(selectResults).toHaveLength(0);
  });

  it('lets a caller holding a real code through right up to its sub-budget exhaustion', async () => {
    await burnMisses(MISS_BUDGET_PER_SOURCE_PER_WINDOW - 1);
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    const res = await supportPublicRoutes.request(`/check/${CODE}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true, branding: null });
  });
});

describe('POST /redeem', () => {
  it('hides an installer-distribution trust denial behind 404 before claiming the code', async () => {
    partnerTrustMode.mockReturnValue('enforce');
    evaluateCapability.mockResolvedValueOnce({
      allow: false,
      code: 'TRUST_PROBATION',
      capability: 'installer_distribute',
      reason: 'probation_default_deny',
    });
    const session = pendingSession();
    selectResults.push([session]);
    selectResults.push([{ partnerId: 'partner-1' }]);

    const res = await redeem();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'invalid or expired code' });
    expect(evaluateCapability).toHaveBeenCalledWith('installer_distribute', {
      partnerId: 'partner-1',
      orgId: 'qs-org',
      detail: { route: 'code-redemption' },
    });
    expect(updateWhereCalled).toBe(0);
    expect(insertedValues).toHaveLength(0);
    expect(logSessionAudit).not.toHaveBeenCalled();
  });

  it('claims the session and mints a single-use key with its own secret', async () => {
    partnerTrustMode.mockReturnValue('enforce');
    const session = pendingSession();
    selectResults.push([session]); // code lookup
    selectResults.push([{ partnerId: 'partner-1' }]); // trust lookup
    updateResults.push([{ ...session, status: 'claimed' }]); // atomic claim wins
    selectResults.push([{ id: 'site-1' }]); // site lookup

    const res = await redeem();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.enrollmentKey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.enrollmentSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.serverUrl).toBe('https://us.2breeze.app');
    expect(body.sessionId).toBe(session.id);
    expect(evaluateCapability).toHaveBeenCalledWith('installer_distribute', {
      partnerId: 'partner-1',
      orgId: 'qs-org',
      detail: { route: 'code-redemption' },
    });

    const key = insertedValues[0] as Record<string, unknown>;
    expect(key.maxUsage).toBe(1);
    expect(key.supportSessionId).toBe(session.id);
    expect(key.orgId).toBe('qs-org');
    expect(key.installerPlatform).toBe('windows');
    // The raw key/secret are never stored.
    expect(key.key).toBe(`keyhash:${body.enrollmentKey}`);
    expect(key.key).not.toBe(body.enrollmentKey);
    expect(key.keySecretHash).not.toBe(body.enrollmentSecret);
  });

  it('never hands out the global AGENT_ENROLLMENT_SECRET', async () => {
    // Precondition: mode 'off' (the module-level default from the outer
    // beforeEach), so the trust gate short-circuits before ever resolving a
    // partner id.
    expect(partnerTrustMode()).toBe('off');

    process.env.AGENT_ENROLLMENT_SECRET = 'super-secret-global-value';
    const session = pendingSession();
    selectResults.push([session]);
    updateResults.push([{ ...session, status: 'claimed' }]);
    selectResults.push([{ id: 'site-1' }]);

    const body = await (await redeem()).json();
    expect(JSON.stringify(body)).not.toContain('super-secret-global-value');
    // Under mode 'off' the trust gate must short-circuit entirely: no
    // capability evaluation, and no extra select for the org's partner id —
    // only the session lookup and the site lookup above.
    expect(evaluateCapability).not.toHaveBeenCalled();
    expect(selectBuilders).toHaveLength(2);
    delete process.env.AGENT_ENROLLMENT_SECRET;
  });

  it('guards the claim on status=pending so a concurrent redeem loses', async () => {
    const session = pendingSession();
    selectResults.push([session]);
    updateResults.push([]); // the racer already flipped it — 0 rows updated

    const res = await redeem();
    expect(res.status).toBe(404);
    expect(updateWhereCalled).toBe(1);
    expect(insertedValues).toHaveLength(0); // no key minted
  });

  it('404s an already-claimed code', async () => {
    selectResults.push([pendingSession({ status: 'claimed' })]);
    const res = await redeem();
    expect(res.status).toBe(404);
    expect(updateWhereCalled).toBe(0);
  });

  it('404s an expired code without touching the session', async () => {
    selectResults.push([pendingSession({ codeExpiresAt: PAST })]);
    const res = await redeem();
    expect(res.status).toBe(404);
    expect(updateWhereCalled).toBe(0);
    expect(insertedValues).toHaveLength(0);
  });

  it('404s a session already past its hard cap', async () => {
    selectResults.push([pendingSession({ hardExpiresAt: PAST })]);
    expect((await redeem()).status).toBe(404);
    expect(updateWhereCalled).toBe(0);
  });

  it('404s an unknown code', async () => {
    selectResults.push([]);
    expect((await redeem()).status).toBe(404);
  });

  it('returns the same error shape for unknown, expired and claimed codes', async () => {
    const bodies: unknown[] = [];
    selectResults.push([]);
    bodies.push(await (await redeem()).json());
    selectResults.push([pendingSession({ codeExpiresAt: PAST })]);
    bodies.push(await (await redeem()).json());
    selectResults.push([pendingSession({ status: 'claimed' })]);
    bodies.push(await (await redeem()).json());
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it('records the claiming IP and audits the anonymous actor', async () => {
    const session = pendingSession();
    selectResults.push([session]);
    updateResults.push([{ ...session, status: 'claimed' }]);
    selectResults.push([{ id: 'site-1' }]);

    await redeem();
    expect(logSessionAudit).toHaveBeenCalledWith(
      'support_session_claimed',
      'creator-1',
      'qs-org',
      expect.objectContaining({ actor: 'end_user', sessionId: session.id }),
      '203.0.113.9',
    );
  });

  it('429s when rate limited before any DB work', async () => {
    rateLimiter.mockResolvedValue({ allowed: false, currentCount: 99 });
    expect((await redeem()).status).toBe(429);
    expect(selectResults).toHaveLength(0);
  });

  it('rejects a payload with an unknown osType', async () => {
    const res = await redeem({ osType: 'freebsd' });
    expect(res.status).toBe(400);
  });

  it('hashes the code before lookup — the plaintext is never queried', async () => {
    selectResults.push([]);
    await redeem();

    // Walk the ACTUAL where() predicate the route built, rather than merely
    // checking hashSupportCode's return shape — a regression that queried by
    // the plaintext code would still pass a shape-only assertion.
    const codeLookupWhere = selectBuilders[0]?.where as ReturnType<typeof vi.fn> | undefined;
    expect(codeLookupWhere).toHaveBeenCalledTimes(1);
    const leaves = collectSqlLeafStrings(codeLookupWhere!.mock.calls[0]![0]);
    expect(leaves).toContain(hashSupportCode(CODE));
    expect(leaves).not.toContain(CODE);
  });
});

describe('GET /download/:platform', () => {
  function download(platform = 'windows', query = `?code=${CODE}`) {
    return supportPublicRoutes.request(`/download/${platform}${query}`);
  }

  it('hides an installer-distribution trust denial behind 404 before serving a binary', async () => {
    partnerTrustMode.mockReturnValue('enforce');
    evaluateCapability.mockResolvedValueOnce({
      allow: false,
      code: 'TRUST_PROBATION',
      capability: 'installer_distribute',
      reason: 'probation_default_deny',
    });
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE, orgId: 'qs-org' }]);
    selectResults.push([{ partnerId: 'partner-1' }]);

    const res = await download();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'invalid or expired code' });
    expect(evaluateCapability).toHaveBeenCalledWith('installer_distribute', {
      partnerId: 'partner-1',
      orgId: 'qs-org',
      detail: { route: 'public-download' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves the agent binary named after the code and API host', async () => {
    partnerTrustMode.mockReturnValue('enforce');
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE, orgId: 'qs-org' }]);
    selectResults.push([{ partnerId: 'partner-1' }]);

    const res = await download();
    expect(res.status).toBe(200);
    expect(evaluateCapability).toHaveBeenCalledWith('installer_distribute', {
      partnerId: 'partner-1',
      orgId: 'qs-org',
      detail: { route: 'public-download' },
    });
    // Exact wire format — the Go client parses this filename (Task 12).
    expect(res.headers.get('Content-Disposition'))
      .toBe('attachment; filename="breeze-support-234567892-us.2breeze.app.exe"');
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    // The code is in the filename, so the response must never be cached.
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x4d, 0x5a, 0x90]));
  });

  it('proxies the release asset rather than redirecting to it', async () => {
    // Precondition: mode 'off' (the module-level default from the outer
    // beforeEach), so the trust gate short-circuits before ever resolving a
    // partner id.
    expect(partnerTrustMode()).toBe('off');

    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    const res = await download();
    // A 302 would hand the browser GitHub's filename and lose the code.
    expect(res.status).toBe(200);
    expect(getGithubAgentUrl).toHaveBeenCalledWith('windows', 'amd64');
    expect(fetchMock).toHaveBeenCalledWith('https://gh.test/breeze-agent-windows-amd64.exe');
    // Under mode 'off' the trust gate must short-circuit entirely: no
    // capability evaluation, and no second select for the org's partner id —
    // only the one lookup-by-code select above.
    expect(evaluateCapability).not.toHaveBeenCalled();
    expect(selectBuilders).toHaveLength(1);
  });

  it('normalizes the human-formatted code into the filename', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    const res = await download('windows', '?code=234-567-892');
    expect(res.headers.get('Content-Disposition'))
      .toBe('attachment; filename="breeze-support-234567892-us.2breeze.app.exe"');
  });

  it('encodes a nonstandard port as host_PORT, never host:PORT', async () => {
    // `:` is illegal in a Windows filename and gets silently rewritten by the
    // browser at save time, which is how #2341 shipped un-enrollable installers.
    process.env.PUBLIC_API_URL = 'https://breeze.example.com:8443';
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    const res = await download();
    expect(res.headers.get('Content-Disposition'))
      .toBe('attachment; filename="breeze-support-234567892-breeze.example.com_8443.exe"');
  });

  it('404s an unknown code', async () => {
    selectResults.push([]);
    const res = await download();
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s an already-claimed code', async () => {
    selectResults.push([{ status: 'claimed', codeExpiresAt: FUTURE }]);
    expect((await download()).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s an expired code', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: PAST }]);
    expect((await download()).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s a malformed or missing code without touching the database', async () => {
    expect((await download('windows', '?code=not-a-code')).status).toBe(404);
    expect((await download('windows', '')).status).toBe(404);
    expect(selectResults).toHaveLength(0); // nothing was consumed
  });

  it('400s macOS with the coming-soon message and no DB work', async () => {
    const res = await download('macos');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'macOS support client coming soon' });
    expect(selectResults).toHaveLength(0);
  });

  it('400s an unknown platform', async () => {
    const res = await download('linux');
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('429s when rate limited before any DB or upstream work', async () => {
    rateLimiter.mockResolvedValue({ allowed: false, currentCount: 99 });
    expect((await download()).status).toBe(429);
    expect(selectResults).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shares the /check rate-limit bucket', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    await download();
    expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), 'support-check:203.0.113.9', 30, 60);
  });

  it('503s rather than serving a partial download when the upstream fails', async () => {
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    const res = await download();
    expect(res.status).toBe(503);
  });

  it('503s when PUBLIC_API_URL cannot produce a filename host', async () => {
    // A filename with no host yields a client that can never phone home.
    process.env.PUBLIC_API_URL = '';
    process.env.API_URL = '';
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);
    const res = await download();
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('proxies the S3 object in local mode instead of redirecting', async () => {
    getBinarySource.mockReturnValue('local');
    isS3Configured.mockReturnValue(true);
    selectResults.push([{ status: 'pending', codeExpiresAt: FUTURE }]);

    const res = await download();
    expect(res.status).toBe(200);
    expect(getPresignedUrl).toHaveBeenCalledWith('agent/breeze-agent-windows-amd64.exe');
    expect(fetchMock).toHaveBeenCalledWith('https://s3.test/agent.exe');
    expect(res.headers.get('Content-Disposition'))
      .toBe('attachment; filename="breeze-support-234567892-us.2breeze.app.exe"');
  });
});
