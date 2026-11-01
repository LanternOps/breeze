import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { png } from '../../__tests__/helpers/syntheticLogos';

/**
 * The logo route against the REAL services/promptIdentity and
 * services/promptIdentityLogo (#10314 review). Only the edges are faked:
 *
 * - a DB whose reads answer by the id in the WHERE clause, holding two
 *   partners, each with one org and one logo (data: URLs, so nothing dials out);
 * - Redis as an in-memory map (both the device cache and the logo cache);
 * - the agent context, as agentAuthMiddleware would set it.
 *
 * Nothing here knows the cross-partner rule; the route and the services must
 * enforce it themselves.
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
vi.mock('../../services/redis', () => ({
  getRedis: () => ({
    get: async (k: string) => h.redis.get(k) ?? null,
    set: async (k: string, v: string) => { h.redis.set(k, v); return 'OK'; },
  }),
}));
vi.mock('../../services/urlSafety', () => ({ safeFetch: (...args: unknown[]) => h.safeFetch(...args) }));

import { promptIdentityLogoRoutes } from './promptIdentityLogo';
import { __resetPromptLogoMemoForTests } from '../../services/promptIdentityLogo';

const AGENT_A = { role: 'agent', deviceId: 'device-a', agentId: 'agent-a', orgId: 'org-a', partnerId: 'partner-a' };

function app(agent: Record<string, unknown> = AGENT_A): Hono {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('agent', agent as never);
    await next();
  });
  a.route('/agents', promptIdentityLogoRoutes);
  return a;
}

beforeEach(() => {
  h.redis.clear();
  h.safeFetch.mockReset();
  __resetPromptLogoMemoForTests();
  h.rows = {
    organizations: { 'org-a': { partnerId: 'partner-a' }, 'org-b': { partnerId: 'partner-b' } },
    partners: {
      'partner-a': { name: 'Example IT A', settings: { branding: { logoUrl: dataUrl(A_BYTES) } } },
      'partner-b': { name: 'Example IT B', settings: { branding: { logoUrl: dataUrl(B_BYTES) } } },
    },
    portal_branding: {},
  };
});

describe('GET /agents/:id/prompt-identity/logo (real services)', () => {
  it("serves the device's own current logo", async () => {
    const res = await app().request(`/agents/agent-a/prompt-identity/logo?sha256=${sha(A_BYTES)}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(A_BYTES))).toBe(true);
  });

  it("no cross-partner leak: partner A's device gets 404 for partner B's logo, even with B's correct sha", async () => {
    // B's logo is warm in every cache first (B's own device fetched it).
    const asB = { role: 'agent', deviceId: 'device-b', agentId: 'agent-b', orgId: 'org-b', partnerId: 'partner-b' };
    expect((await app(asB).request(`/agents/agent-b/prompt-identity/logo?sha256=${sha(B_BYTES)}`)).status).toBe(200);

    const res = await app().request(`/agents/agent-a/prompt-identity/logo?sha256=${sha(B_BYTES)}`);
    expect(res.status).toBe(404);
    expect(Buffer.from(await res.arrayBuffer()).includes(Buffer.from(B_BYTES))).toBe(false);
  });

  it("naming B's agent id in the path changes nothing: the authenticated device decides", async () => {
    const res = await app().request(`/agents/agent-b/prompt-identity/logo?sha256=${sha(B_BYTES)}`);
    expect(res.status).toBe(404);
  });

  it('404 on a stale sha after the partner changes its logo (once the device cache turns over)', async () => {
    expect((await app().request(`/agents/agent-a/prompt-identity/logo?sha256=${sha(A_BYTES)}`)).status).toBe(200);
    const NEW = png(16, 16);
    h.rows.partners!['partner-a'] = { name: 'Example IT A', settings: { branding: { logoUrl: dataUrl(NEW) } } };
    h.redis.clear();
    __resetPromptLogoMemoForTests();
    expect((await app().request(`/agents/agent-a/prompt-identity/logo?sha256=${sha(A_BYTES)}`)).status).toBe(404);
    expect((await app().request(`/agents/agent-a/prompt-identity/logo?sha256=${sha(NEW)}`)).status).toBe(200);
  });

  it('never fetches anything for a data: logo', async () => {
    await app().request(`/agents/agent-a/prompt-identity/logo?sha256=${sha(A_BYTES)}`);
    expect(h.safeFetch).not.toHaveBeenCalled();
  });
});
