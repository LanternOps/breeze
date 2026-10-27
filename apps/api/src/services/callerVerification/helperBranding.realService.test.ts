import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { png } from '../../__tests__/helpers/syntheticLogos';

/**
 * The caller-verify logo reference on GET /helper/config (#10190 W04, decision
 * 1) against the REAL services/promptIdentity and services/promptIdentityLogo.
 * Only the edges are faked, exactly as in
 * routes/agents/promptIdentityLogo.realService.test.ts:
 *
 * - a DB whose reads answer by the id in the WHERE clause, holding two
 *   partners, each with one org;
 * - Redis as an in-memory map (the per-device identity cache and the logo
 *   cache, which the heartbeat shares);
 * - safeFetch, so an https logo never dials out.
 *
 * The contract under test: the sha the helper config names is the sha the
 * heartbeat's promptIdentity block carries for the same device (so the agent
 * has synced those very bytes to Assist), and no device ever gets another
 * partner's sha.
 */
const A_BYTES = png(32, 32);
const B_BYTES = png(48, 48);
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const dataUrl = (b: Uint8Array) => `data:image/png;base64,${Buffer.from(b).toString('base64')}`;

const h = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, Record<string, unknown>>>,
  redis: new Map<string, string>(),
  safeFetch: vi.fn(),
}));

vi.mock('../../db', async () => {
  const { getTableName } = await import('drizzle-orm');
  const { renderSql } = await import('../../__tests__/helpers/tableKeyedDb');
  const select = (fields: Record<string, unknown>) => {
    let table = '';
    let id: unknown;
    const chain: Record<string, unknown> = {};
    chain.from = (t: Parameters<typeof getTableName>[0]) => { table = getTableName(t); return chain; };
    chain.where = (w: unknown) => { id = renderSql(w).params[0]; return chain; };
    chain.limit = () => chain;
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve().then(() => {
        const row = h.rows[table]?.[String(id)];
        if (!row) return [];
        return [Object.fromEntries(Object.keys(fields).map((k) => [k, row[k] ?? null]))];
      }).then(resolve, reject);
    return chain;
  };
  return {
    db: { select },
    runOutsideDbContext: async (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  };
});
vi.mock('../../db/partnerAxisRead', () => ({ readWithPartnerAxisVisibility: async (fn: () => unknown) => fn() }));
vi.mock('../redis', () => ({
  getRedis: () => ({
    get: async (k: string) => h.redis.get(k) ?? null,
    set: async (k: string, v: string) => { h.redis.set(k, v); return 'OK'; },
  }),
}));
vi.mock('../urlSafety', () => ({ safeFetch: (...args: unknown[]) => h.safeFetch(...args) }));

import { callerHelperLogo } from './helperBranding';
import { buildHeartbeatPromptIdentity } from '../promptIdentity';
import { __resetPromptLogoMemoForTests, __setPromptLogoDeadlineForTests } from '../promptIdentityLogo';

const DEVICE_A = { deviceId: 'device-a', orgId: 'org-a', partnerId: 'partner-a' };
const DEVICE_B = { deviceId: 'device-b', orgId: 'org-b', partnerId: 'partner-b' };

function setPartnerLogo(partnerId: string, logoUrl: string | null) {
  h.rows.partners![partnerId] = { ...h.rows.partners![partnerId], settings: logoUrl ? { branding: { logoUrl } } : {} };
}

beforeEach(() => {
  h.redis.clear();
  h.safeFetch.mockReset();
  __resetPromptLogoMemoForTests();
  __setPromptLogoDeadlineForTests(null);
  h.rows = {
    organizations: { 'org-a': { partnerId: 'partner-a' }, 'org-b': { partnerId: 'partner-b' } },
    partners: {
      'partner-a': { name: 'Example IT A', settings: { branding: { logoUrl: dataUrl(A_BYTES) } } },
      'partner-b': { name: 'Example IT B', settings: { branding: { logoUrl: dataUrl(B_BYTES) } } },
    },
    portal_branding: {},
  };
});
afterEach(() => vi.restoreAllMocks());

describe('callerHelperLogo (real services)', () => {
  it('an uploaded (data:) logo gets a sha: exactly the one the heartbeat block carries for the same device', async () => {
    const logo = await callerHelperLogo(DEVICE_A);
    expect(logo).toEqual({ sha256: sha(A_BYTES), mime: 'image/png' });

    const block = await buildHeartbeatPromptIdentity(DEVICE_A);
    expect(block?.state).toBe('set');
    expect(block?.state === 'set' ? block.logo?.sha256 : undefined).toBe(logo?.sha256);
    expect(block?.state === 'set' ? block.logo?.mime : undefined).toBe(logo?.mime);
  });

  it('the shape is exactly {sha256, mime}: no byte count, no source URL, no bytes', async () => {
    const logo = await callerHelperLogo(DEVICE_A);
    expect(Object.keys(logo ?? {}).sort()).toEqual(['mime', 'sha256']);
    expect(JSON.stringify(logo)).not.toContain('data:');
  });

  it('agrees with the heartbeat when the heartbeat resolved first (one shared per-device cache)', async () => {
    const block = await buildHeartbeatPromptIdentity(DEVICE_A);
    // The partner changes its logo after the heartbeat cached the identity;
    // the helper must still name what the agent was told, not the new image.
    setPartnerLogo('partner-a', dataUrl(png(16, 16)));
    const logo = await callerHelperLogo(DEVICE_A);
    expect(block?.state === 'set' ? block.logo?.sha256 : undefined).toBe(sha(A_BYTES));
    expect(logo?.sha256).toBe(sha(A_BYTES));
  });

  it("no cross-partner leak: partner P1's device never gets partner P2's sha, even with P2's logo warm everywhere", async () => {
    // P2's own device resolved first: its identity and its logo are cached.
    expect((await callerHelperLogo(DEVICE_B))?.sha256).toBe(sha(B_BYTES));
    expect((await buildHeartbeatPromptIdentity(DEVICE_B))).toMatchObject({ logo: { sha256: sha(B_BYTES) } });

    const logo = await callerHelperLogo(DEVICE_A);
    expect(logo?.sha256).toBe(sha(A_BYTES));
    expect(logo?.sha256).not.toBe(sha(B_BYTES));
  });

  it("no cross-partner leak: P1's device with no logo of its own gets null, not P2's", async () => {
    await callerHelperLogo(DEVICE_B);
    setPartnerLogo('partner-a', null);
    expect(await callerHelperLogo(DEVICE_A)).toBeNull();
  });

  it("a device whose org resolves to another partner than the authenticated one gets null (refused, not served)", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Device A's credential says partner-b; its org says partner-a.
    expect(await callerHelperLogo({ ...DEVICE_A, partnerId: 'partner-b' })).toBeNull();
    // ...and a cached identity for the right partner is not served to the wrong one.
    await callerHelperLogo(DEVICE_A);
    expect(await callerHelperLogo({ ...DEVICE_A, partnerId: 'partner-b' })).toBeNull();
  });

  it('an invalid logo (svg) is null', async () => {
    setPartnerLogo('partner-a', `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`);
    expect(await callerHelperLogo(DEVICE_A)).toBeNull();
  });

  it('a cold https logo is null this time and never waits on the fetch (mirrors the heartbeat)', async () => {
    setPartnerLogo('partner-a', 'https://logos.example.com/a.png');
    // The logo host never answers (the loader's own deadline is shortened
    // only so the background load does not outlive the test).
    __setPromptLogoDeadlineForTests(200);
    h.safeFetch.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    expect(await callerHelperLogo(DEVICE_A)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a warm https logo carries its sha', async () => {
    setPartnerLogo('partner-a', 'https://logos.example.com/a.png');
    h.safeFetch.mockResolvedValue(new Response(Buffer.from(A_BYTES), { status: 200, headers: { 'content-type': 'image/png' } }));
    expect(await callerHelperLogo(DEVICE_A)).toBeNull(); // cold: starts the background load
    await vi.waitFor(async () => {
      expect(await callerHelperLogo(DEVICE_A)).toEqual({ sha256: sha(A_BYTES), mime: 'image/png' });
    });
  });

  it('a failure resolving the identity is null, never thrown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.rows.organizations = new Proxy({}, { get: () => { throw new Error('db down'); } });
    await expect(callerHelperLogo(DEVICE_A)).resolves.toBeNull();
  });
});
