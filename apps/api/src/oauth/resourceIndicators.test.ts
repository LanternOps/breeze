import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const RESOURCE = 'https://region.example/api/v1/mcp';

type Mod = typeof import('./resourceIndicators');

async function importWithResource(resourceUrl: string | undefined): Promise<Mod> {
  if (resourceUrl === undefined) delete process.env.OAUTH_RESOURCE_URL;
  else process.env.OAUTH_RESOURCE_URL = resourceUrl;
  vi.resetModules();
  return import('./resourceIndicators');
}

describe('resourceIndicators (#2363 alias handling)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.OAUTH_RESOURCE_URL;
  });

  describe('normalizeResourceIndicator', () => {
    it('maps the /sse transport alias to the canonical resource', async () => {
      const mod = await importWithResource(RESOURCE);
      expect(mod.normalizeResourceIndicator(`${RESOURCE}/sse`)).toBe(RESOURCE);
    });

    it('maps the trailing-slash alias to the canonical resource', async () => {
      const mod = await importWithResource(RESOURCE);
      expect(mod.normalizeResourceIndicator(`${RESOURCE}/`)).toBe(RESOURCE);
    });

    it('maps the /message transport alias to the canonical resource', async () => {
      const mod = await importWithResource(RESOURCE);
      expect(mod.normalizeResourceIndicator(`${RESOURCE}/message`)).toBe(RESOURCE);
    });

    it('leaves the canonical resource unchanged', async () => {
      const mod = await importWithResource(RESOURCE);
      expect(mod.normalizeResourceIndicator(RESOURCE)).toBe(RESOURCE);
    });

    it('leaves an unrelated resource unchanged (RFC 8707 binding intact)', async () => {
      const mod = await importWithResource(RESOURCE);
      expect(mod.normalizeResourceIndicator('https://evil.example/api/v1/mcp'))
        .toBe('https://evil.example/api/v1/mcp');
    });

    it('does NOT prefix-match arbitrary sub-paths of the canonical resource', async () => {
      const mod = await importWithResource(RESOURCE);
      // Exact-alias allowlist only — anything else must pass through so
      // oidc-provider still rejects it with invalid_target.
      for (const nonAlias of [
        `${RESOURCE}/sse/extra`,
        `${RESOURCE}//`,
        `${RESOURCE}/messages`,
        `${RESOURCE}/other`,
        `${RESOURCE}x`,
      ]) {
        expect(mod.normalizeResourceIndicator(nonAlias)).toBe(nonAlias);
      }
    });

    it('is a no-op when OAUTH_RESOURCE_URL is unset', async () => {
      const mod = await importWithResource(undefined);
      expect(mod.normalizeResourceIndicator('anything/sse')).toBe('anything/sse');
    });
  });

  describe('isAcceptedResourceIndicator', () => {
    it('accepts the canonical resource and all three aliases, nothing else', async () => {
      const mod = await importWithResource(RESOURCE);
      expect(mod.isAcceptedResourceIndicator(RESOURCE)).toBe(true);
      expect(mod.isAcceptedResourceIndicator(`${RESOURCE}/sse`)).toBe(true);
      expect(mod.isAcceptedResourceIndicator(`${RESOURCE}/`)).toBe(true);
      expect(mod.isAcceptedResourceIndicator(`${RESOURCE}/message`)).toBe(true);
      expect(mod.isAcceptedResourceIndicator('https://evil.example/api/v1/mcp')).toBe(false);
      expect(mod.isAcceptedResourceIndicator(`${RESOURCE}/sse/extra`)).toBe(false);
    });
  });

  describe('normalizeFormEncodedResource', () => {
    it('rewrites an /sse alias in a token request body and preserves other params', async () => {
      const mod = await importWithResource(RESOURCE);
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'rt-1',
        client_id: 'client-1',
        resource: `${RESOURCE}/sse`,
      }).toString();

      const rewritten = mod.normalizeFormEncodedResource(body);
      expect(rewritten).not.toBeNull();
      const parsed = new URLSearchParams(rewritten!);
      expect(parsed.get('resource')).toBe(RESOURCE);
      expect(parsed.get('grant_type')).toBe('refresh_token');
      expect(parsed.get('refresh_token')).toBe('rt-1');
      expect(parsed.get('client_id')).toBe('client-1');
    });

    it('returns null (no rewrite) when the resource is already canonical', async () => {
      const mod = await importWithResource(RESOURCE);
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        resource: RESOURCE,
      }).toString();
      expect(mod.normalizeFormEncodedResource(body)).toBeNull();
    });

    it('returns null (no rewrite) for an unrelated resource — it must still fail invalid_target downstream', async () => {
      const mod = await importWithResource(RESOURCE);
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        resource: 'https://evil.example/api',
      }).toString();
      expect(mod.normalizeFormEncodedResource(body)).toBeNull();
    });

    it('returns null when the body has no resource param', async () => {
      const mod = await importWithResource(RESOURCE);
      expect(mod.normalizeFormEncodedResource('grant_type=refresh_token&client_id=c1')).toBeNull();
    });

    it('normalizes repeated resource params individually', async () => {
      const mod = await importWithResource(RESOURCE);
      const body =
        `resource=${encodeURIComponent(`${RESOURCE}/sse`)}` +
        `&resource=${encodeURIComponent('https://other.example/x')}`;
      const rewritten = mod.normalizeFormEncodedResource(body);
      expect(rewritten).not.toBeNull();
      const parsed = new URLSearchParams(rewritten!);
      expect(parsed.getAll('resource')).toEqual([RESOURCE, 'https://other.example/x']);
    });
  });

  describe('normalizeResourceParams', () => {
    it('rewrites aliases in an authorization query string in place', async () => {
      const mod = await importWithResource(RESOURCE);
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: 'client-1',
        scope: 'openid offline_access mcp:read',
        resource: `${RESOURCE}/`,
      });
      expect(mod.normalizeResourceParams(params)).toBe(true);
      expect(params.get('resource')).toBe(RESOURCE);
      // Space-bearing params survive a re-serialize → re-parse round-trip.
      const roundTripped = new URLSearchParams(params.toString());
      expect(roundTripped.get('scope')).toBe('openid offline_access mcp:read');
    });

    it('reports no change for canonical/unrelated values', async () => {
      const mod = await importWithResource(RESOURCE);
      const canonical = new URLSearchParams({ resource: RESOURCE });
      expect(mod.normalizeResourceParams(canonical)).toBe(false);
      const unrelated = new URLSearchParams({ resource: 'https://evil.example/mcp' });
      expect(mod.normalizeResourceParams(unrelated)).toBe(false);
      expect(unrelated.get('resource')).toBe('https://evil.example/mcp');
    });
  });
});
