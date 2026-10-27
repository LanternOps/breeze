import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { png } from '../../__tests__/helpers/syntheticLogos';

// A two-partner world behind the service seam: each org belongs to one
// partner, each partner has one logo. The fake answers the way
// loadDevicePromptLogo does — from the ids it is GIVEN — so these tests pin
// which ids the route hands it (the authenticated agent's, never the URL's).
const A_BYTES = png(32, 32);
const B_BYTES = png(48, 48);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const WORLD = {
  orgs: { 'org-a': 'partner-a', 'org-b': 'partner-b' } as Record<string, string>,
  logos: {
    'partner-a': { mime: 'image/png' as const, width: 32, height: 32, data: A_BYTES, bytes: A_BYTES.length, sha256: sha(A_BYTES) },
    'partner-b': { mime: 'image/png' as const, width: 48, height: 48, data: B_BYTES, bytes: B_BYTES.length, sha256: sha(B_BYTES) },
  } as Record<string, { mime: 'image/png'; width: number; height: number; data: Uint8Array; bytes: number; sha256: string }>,
};

const h = vi.hoisted(() => ({ loadDevicePromptLogo: vi.fn() }));
vi.mock('../../services/promptIdentity', () => ({
  loadDevicePromptLogo: (...args: unknown[]) => h.loadDevicePromptLogo(...args),
}));

import { promptIdentityLogoRoutes } from './promptIdentityLogo';

function app(agent: Record<string, unknown>): Hono {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('agent', { role: 'agent', ...agent } as never);
    await next();
  });
  a.route('/agents', promptIdentityLogoRoutes);
  return a;
}

const AGENT_A = { deviceId: 'device-a', agentId: 'agent-a', orgId: 'org-a', partnerId: 'partner-a' };

beforeEach(() => {
  h.loadDevicePromptLogo.mockReset();
  h.loadDevicePromptLogo.mockImplementation(async (args: { orgId: string; partnerId: string; sha256: string }) => {
    const partner = WORLD.orgs[args.orgId];
    if (!partner || partner !== args.partnerId) return null;
    const logo = WORLD.logos[partner];
    return logo && logo.sha256 === args.sha256 ? logo : null;
  });
});

describe('GET /agents/:id/prompt-identity/logo', () => {
  it("returns the device's current logo bytes with its mime, length and safe headers", async () => {
    const res = await app(AGENT_A).request(`/agents/agent-a/prompt-identity/logo?sha256=${sha(A_BYTES)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-length')).toBe(String(A_BYTES.length));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600, immutable');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(A_BYTES))).toBe(true);
  });

  it('resolves with the authenticated device, org and partner only', async () => {
    await app(AGENT_A).request(`/agents/agent-a/prompt-identity/logo?sha256=${sha(A_BYTES)}&orgId=org-b&partnerId=partner-b`);
    expect(h.loadDevicePromptLogo).toHaveBeenCalledWith({
      deviceId: 'device-a', orgId: 'org-a', partnerId: 'partner-a', sha256: sha(A_BYTES),
    });
  });

  it('404 on a stale sha', async () => {
    const res = await app(AGENT_A).request(`/agents/agent-a/prompt-identity/logo?sha256=${'0'.repeat(64)}`);
    expect(res.status).toBe(404);
  });

  it("no cross-partner leak: partner A's device gets 404 for partner B's logo, even with B's correct sha", async () => {
    const res = await app(AGENT_A).request(`/agents/agent-a/prompt-identity/logo?sha256=${sha(B_BYTES)}`);
    expect(res.status).toBe(404);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.includes(Buffer.from(B_BYTES))).toBe(false);
  });

  it("the URL's :id does not choose the device: the agent context does", async () => {
    // Even naming another agent in the path, the lookup uses device-a's own ids.
    await app(AGENT_A).request(`/agents/agent-b/prompt-identity/logo?sha256=${sha(B_BYTES)}`);
    expect(h.loadDevicePromptLogo).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'device-a', orgId: 'org-a', partnerId: 'partner-a' }));
  });

  it.each(['', 'abc', 'G'.repeat(64), sha(A_BYTES).toUpperCase(), `${sha(A_BYTES)}0`])('400 for a malformed sha (%s)', async (value) => {
    const res = await app(AGENT_A).request(`/agents/agent-a/prompt-identity/logo?sha256=${value}`);
    expect(res.status).toBe(400);
    expect(h.loadDevicePromptLogo).not.toHaveBeenCalled();
  });

  it('refuses the watchdog credential', async () => {
    const res = await app({ ...AGENT_A, role: 'watchdog' }).request(`/agents/agent-a/prompt-identity/logo?sha256=${sha(A_BYTES)}`);
    expect(res.status).toBe(403);
    expect(h.loadDevicePromptLogo).not.toHaveBeenCalled();
  });

  it('a resolver failure is a 503, never the bytes of anything', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.loadDevicePromptLogo.mockRejectedValue(new Error('db down'));
    const res = await app(AGENT_A).request(`/agents/agent-a/prompt-identity/logo?sha256=${sha(A_BYTES)}`);
    expect(res.status).toBe(503);
  });
});
