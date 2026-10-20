import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const state = vi.hoisted(() => ({
  device: { id: 'dev-1' } as Record<string, unknown> | null,
  sets: {} as Record<string, Record<string, unknown>>,
  lastSetId: null as string | null,
}));

const { resolvePolicyMock, withSystemSpy } = vi.hoisted(() => ({
  resolvePolicyMock: vi.fn(),
  withSystemSpy: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db', async () => {
  const schema = await import('../../db/schema');
  const select = () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: () => {
          if (table === schema.devices) return Promise.resolve(state.device ? [state.device] : []);
          const row = state.lastSetId ? state.sets[state.lastSetId] : undefined;
          return Promise.resolve(row ? [row] : []);
        },
      }),
    }),
  });
  return { db: { select }, withSystemDbAccessContext: withSystemSpy };
});

vi.mock('../../services/featureConfigResolver', () => ({
  resolveSecurityScanPolicyForDevice: resolvePolicyMock,
}));

import { YARA_BUILTIN_RULE_SET_ID, YARA_BUNDLE_CONTENT_TYPE, SECURITY_SCAN_SETTINGS_DEFAULTS } from '@breeze/shared';
import { agentYaraRuleSetRoutes } from './yaraRuleSets';

const fixtures = resolve(__dirname, '../../../../../agent/internal/yarascan/testdata');
const GOLDEN = readFileSync(resolve(fixtures, 'bundle-v1.golden.json'));
const GOLDEN_SHA = readFileSync(resolve(fixtures, 'bundle-v1.golden.json.sha256'), 'utf8').trim();

const S = '5555aaaa-0000-4000-8000-00000000000a';
const P = '6666bbbb-0000-4000-8000-00000000000b';

function app(role: 'agent' | 'watchdog' = 'agent') {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('agent' as never, { role, agentId: 'A', orgId: 'org-1' } as never);
    await next();
  });
  a.route('/api/v1/agents', agentYaraRuleSetRoutes);
  return a;
}

// The db mock cannot read a drizzle WHERE, so the helper tells it which set
// the request names (the route looks up exactly the id in the path).
const get = (path: string, role: 'agent' | 'watchdog' = 'agent') => {
  state.lastSetId = path.split('/')[0] ?? null;
  return app(role).request(`/api/v1/agents/A/yara/rule-sets/${path}`);
};

beforeEach(() => {
  vi.clearAllMocks();
  state.device = { id: 'dev-1' };
  state.sets = {
    [S]: { id: S, enabled: true, publishedVersion: 4, publishedBundle: GOLDEN, publishedSha256: GOLDEN_SHA },
    [P]: { id: P, enabled: true, publishedVersion: 1, publishedBundle: Buffer.from('{}'), publishedSha256: 'a'.repeat(64) },
    [YARA_BUILTIN_RULE_SET_ID]: { id: YARA_BUILTIN_RULE_SET_ID, isBuiltin: true, enabled: true, publishedVersion: 2, publishedBundle: Buffer.from('{"b":1}'), publishedSha256: 'b'.repeat(64) },
  };
  resolvePolicyMock.mockResolvedValue({ settings: { ...SECURITY_SCAN_SETTINGS_DEFAULTS, ruleSetIds: [S] }, featureLinkId: 'l' });
});

describe('GET /agents/:id/yara/rule-sets/:ruleSetId/:version', () => {
  it('serves the published bundle byte for byte with the C2 headers', async () => {
    const res = await get(`${S}/4`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(GOLDEN)).toBe(true);
    expect(res.headers.get('ETag')).toBe(`"${GOLDEN_SHA}"`);
    expect(res.headers.get('Content-Type')).toBe(YARA_BUNDLE_CONTENT_TYPE);
    expect(resolvePolicyMock).toHaveBeenCalledWith('dev-1');
  });

  it('409 when the requested version is no longer the published one (DECISION W03-b)', async () => {
    expect((await get(`${S}/3`)).status).toBe(409);
  });

  it('404 for a visible set that is not attached to the device\'s policy (DECISION W03-d)', async () => {
    expect((await get(`${P}/1`)).status).toBe(404);
  });

  it('serves the built-in pack even when the policy lists no sets', async () => {
    resolvePolicyMock.mockResolvedValue({ settings: { ...SECURITY_SCAN_SETTINGS_DEFAULTS, ruleSetIds: [] }, featureLinkId: 'l' });
    expect((await get(`${YARA_BUILTIN_RULE_SET_ID}/2`)).status).toBe(200);
  });

  it('the attachment bypass needs the built-in FLAG, not just the well-known id', async () => {
    resolvePolicyMock.mockResolvedValue({ settings: { ...SECURITY_SCAN_SETTINGS_DEFAULTS, ruleSetIds: [] }, featureLinkId: 'l' });
    state.sets[YARA_BUILTIN_RULE_SET_ID] = { ...state.sets[YARA_BUILTIN_RULE_SET_ID]!, isBuiltin: false };
    expect((await get(`${YARA_BUILTIN_RULE_SET_ID}/2`)).status).toBe(404);
  });

  it('404 when no policy governs the device at all', async () => {
    resolvePolicyMock.mockResolvedValue(null);
    expect((await get(`${S}/4`)).status).toBe(404);
  });

  it('404 when the attached set is disabled', async () => {
    state.sets[S] = { ...state.sets[S]!, enabled: false };
    expect((await get(`${S}/4`)).status).toBe(404);
  });

  it('404 when the attached set was never published', async () => {
    state.sets[S] = { ...state.sets[S]!, publishedVersion: 0, publishedBundle: null, publishedSha256: null };
    expect((await get(`${S}/1`)).status).toBe(404);
  });

  it('404 when the attached set is not visible under the agent\'s RLS context', async () => {
    delete state.sets[S];
    expect((await get(`${S}/4`)).status).toBe(404);
  });

  it('404 when the device is unknown', async () => {
    state.device = null;
    expect((await get(`${S}/4`)).status).toBe(404);
  });

  it('403 for a watchdog-role token', async () => {
    expect((await get(`${S}/4`, 'watchdog')).status).toBe(403);
    expect(resolvePolicyMock).not.toHaveBeenCalled();
  });

  it('400 for a malformed set id or version', async () => {
    expect((await get('not-a-uuid/4')).status).toBe(400);
    expect((await get(`${S}/0`)).status).toBe(400);
    expect((await get(`${S}/abc`)).status).toBe(400);
  });

  it('never escapes to a system DB context', async () => {
    await get(`${S}/4`);
    await get(`${P}/1`);
    await get(`${S}/3`);
    expect(withSystemSpy).not.toHaveBeenCalled();
  });
});
