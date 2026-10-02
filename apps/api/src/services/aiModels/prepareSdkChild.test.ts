import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rec = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: (e: Record<string, unknown>) => rec.events.push(e) }));

import { closeModelGateway, getModelGateway } from './gateway';
import { prepareSdkChild } from './connectionFactory';
import { createIsolatedSdkCwd } from './sdkChildEnv';
import { makeResolvedModel } from './__fixtures__/resolvedModel';
import { getLlmEgressProxy } from '../llm/llmEgressProxy';
import { resolveToolSearchPolicy } from '../aiToolSearchPolicy';

const PARENT = {
  PATH: '/usr/bin', HOME: '/home/breeze', ANTHROPIC_API_KEY: 'sk-platform-PARENT', ANTHROPIC_AUTH_TOKEN: 'tok-PARENT',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-PARENT', ANTHROPIC_BASE_URL: 'https://parent.example.com', IS_HOSTED: 'false',
  HTTPS_PROXY: 'http://corp:3128', https_proxy: 'http://corp:3128', NO_PROXY: '*', no_proxy: '*',
  AWS_SECRET_ACCESS_KEY: 'aws-parent', ANTHROPIC_MODEL: 'claude-parent-override',
};

/** CONNECT through a proxy URL (userinfo = token); resolves the status code. */
function connectThrough(proxyUrl: string, target: string): Promise<number> {
  const u = new URL(proxyUrl);
  const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: Number(u.port), method: 'CONNECT', path: target, agent: false,
      headers: { 'Proxy-Authorization': `Basic ${auth}` },
    });
    req.once('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
    req.once('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.once('error', reject);
    req.end();
  });
}

describe('prepareSdkChild', () => {
  beforeEach(async () => { rec.events.length = 0; await getModelGateway(); });
  afterEach(async () => { await closeModelGateway(); await (await getLlmEgressProxy()).close(); });

  it('gateway: loopback base URL with a grant token, placeholder key, deny-all proxy, NO_PROXY the gateway port only', async () => {
    const r = makeResolvedModel('openai_compatible');
    const { env, revoke } = await prepareSdkChild(r, { key: 'sess-1', orgId: 'org-1', aiSessionId: 'sess-1', source: PARENT });
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/g\/[A-Za-z0-9_-]{43}$/);
    expect(env.ANTHROPIC_API_KEY).toBe('breeze-gateway');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.HTTPS_PROXY).toMatch(/^http:\/\/breeze:[^@]+@127\.0\.0\.1:\d+$/);
    expect(env.HTTP_PROXY).toBe(env.HTTPS_PROXY);
    // Exactly the gateway's host:port — not every loopback port, not localhost.
    expect(env.NO_PROXY).toBe(`127.0.0.1:${new URL(env.ANTHROPIC_BASE_URL!).port}`);
    expect(env.no_proxy).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/breeze');
    // Host-context guards survive (#7444).
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    revoke();
  });

  it('gateway: children share one private, empty temp working directory that outlives revoke', async () => {
    // One stable directory: the CLI keys persisted transcripts by working
    // directory, so a fresh directory per spawn would leave a transcript folder
    // behind for every spawn. Isolation holds: empty, private, never the host cwd.
    const r = makeResolvedModel('openai_compatible');
    const a = await prepareSdkChild(r, { key: 'sess-cwd', orgId: 'org-1', aiSessionId: null, source: PARENT });
    const b = await prepareSdkChild(r, { key: 'sess-cwd-2', orgId: 'org-1', aiSessionId: null, source: PARENT });
    expect(a.cwd).toBeDefined();
    expect(path.isAbsolute(a.cwd!)).toBe(true);
    expect(realpathSync(a.cwd!).startsWith(realpathSync(os.tmpdir()))).toBe(true);
    expect(a.cwd!.startsWith(process.cwd())).toBe(false);
    const st = statSync(a.cwd!);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o077).toBe(0);
    expect(readdirSync(a.cwd!)).toEqual([]);
    expect(b.cwd).toBe(a.cwd);
    a.revoke();
    b.revoke();
    expect(existsSync(a.cwd!)).toBe(true);
    expect(() => a.revoke()).not.toThrow();
  });

  it('gateway: an untrustworthy shared directory is never used (per-spawn fallback, removed on revoke)', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'breeze-cwd-test-'));
    try {
      // Group/other-accessible.
      const loose = path.join(base, 'loose');
      mkdirSync(loose, { mode: 0o755 });
      chmodSync(loose, 0o755);
      // Not empty.
      const dirty = path.join(base, 'dirty');
      mkdirSync(dirty, { mode: 0o700 });
      writeFileSync(path.join(dirty, 'CLAUDE.md'), 'injected');
      // A symlink to elsewhere.
      const link = path.join(base, 'link');
      symlinkSync(base, link);
      for (const stableDir of [loose, dirty, link]) {
        const iso = await createIsolatedSdkCwd({ stableDir });
        expect(iso.cwd).not.toBe(stableDir);
        expect(readdirSync(iso.cwd)).toEqual([]);
        iso.remove();
        expect(existsSync(iso.cwd)).toBe(false);
      }
      // A fresh path is created private and reused.
      const fresh = path.join(base, 'fresh');
      const one = await createIsolatedSdkCwd({ stableDir: fresh });
      const two = await createIsolatedSdkCwd({ stableDir: fresh });
      expect(one.cwd).toBe(fresh);
      expect(two.cwd).toBe(fresh);
      expect(statSync(fresh).mode & 0o077).toBe(0);
      one.remove();
      expect(existsSync(fresh)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('gateway: a failed dispatch leaves no working directory behind', async () => {
    const before = new Set(readdirSync(os.tmpdir()).filter((n) => n.startsWith('breeze-sdk-') && !n.startsWith('breeze-sdk-gateway-cwd-')));
    // A kind with no registered adapter: the dispatch fails after the
    // working directory and the grants exist, and must release all of them.
    const base = makeResolvedModel('openai_compatible');
    const broken = { ...base, connection: { ...base.connection, kind: 'no_such_kind' } } as unknown as typeof base;
    await expect(prepareSdkChild(broken, { key: 'sess-x', orgId: 'org-1', aiSessionId: null, source: PARENT }))
      .rejects.toThrow(/No gateway adapter/);
    const after = readdirSync(os.tmpdir()).filter((n) => n.startsWith('breeze-sdk-') && !n.startsWith('breeze-sdk-gateway-cwd-') && !before.has(n));
    expect(after).toEqual([]);
  });

  it('non-gateway kinds get no working directory and no query-option overrides (spawn unchanged)', async () => {
    for (const kind of ['platform', 'anthropic_byok', 'catalog'] as const) {
      const child = await prepareSdkChild(makeResolvedModel(kind), { key: `k-${kind}`, orgId: 'org-1', aiSessionId: null, source: PARENT });
      expect(child.cwd).toBeUndefined();
      expect(child).not.toHaveProperty('queryOptions');
      expect(child.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
      child.revoke();
    }
  });

  it('gateway: the SDK prices the bound wire models at the offering rates, so its budget cap uses the registry price', async () => {
    // Without this the CLI prices an unknown model id at a guessed Claude rate
    // (costBasis "unknown") and maxBudgetUsd trips on a $0 local model.
    const r = makeResolvedModel('openai_compatible', {
      refusalFallback: {
        offeringId: 'o2', displayName: 'b', wireModel: 'qwen-b', wireParams: { betas: [], applied: {} }, options: {},
        rateSnapshot: { source: 'offering', standard: { inputCentsPerM: 0, outputCentsPerM: 0, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 } },
      } as never,
    });
    const child = await prepareSdkChild(r, { key: 'sess-price', orgId: 'org-1', aiSessionId: null, source: PARENT });
    // The CLI honours a host-supplied modelPricing only with this flag set.
    expect(child.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1');
    // USD per million tokens (FIXTURE_STD_RATES is cents per million).
    expect(child.queryOptions).toEqual({
      managedSettings: {
        modelPricing: {
          overrides: {
            'qwen2.5-coder:7b': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
            'qwen-b': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
      },
    });
    child.revoke();
  });

  it('gateway: a rate the SDK cannot express drops the SDK budget cap (the registry-priced guards remain)', async () => {
    const r = makeResolvedModel('openai_compatible', {
      rateSnapshot: { source: 'offering', standard: { inputCentsPerM: 2_000_000, outputCentsPerM: 1, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 } },
    });
    const child = await prepareSdkChild(r, { key: 'sess-price-x', orgId: 'org-1', aiSessionId: null, source: PARENT });
    expect(child.queryOptions).toHaveProperty('maxBudgetUsd', undefined);
    expect(child.queryOptions).not.toHaveProperty('managedSettings');
    child.revoke();
  });

  it('child env carries no credential: not the upstream key, not the platform key, not parent cloud creds', async () => {
    const r = makeResolvedModel('openai_compatible');
    const { env, revoke } = await prepareSdkChild(r, { key: 'sess-2', orgId: 'org-1', aiSessionId: null, source: PARENT });
    const s = JSON.stringify(env);
    for (const secret of ['sk-fixture-upstream', 'sk-platform-PARENT', 'tok-PARENT', 'oauth-PARENT', 'aws-parent', 'llm.example.com', 'parent.example.com']) {
      expect(s).not.toContain(secret);
    }
    revoke();
  });

  it('pins every alias env to the bound wire model', async () => {
    const r = makeResolvedModel('openai_compatible');
    const { env, revoke } = await prepareSdkChild(r, { key: 'sess-3', orgId: 'org-1', aiSessionId: null, source: PARENT });
    for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) {
      expect(env[k]).toBe(r.wireModel);
    }
    // The gateway refuses any other model for this grant (Review Focus 2).
    const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(res.status).toBe(403);
    revoke();
  });

  it('the proxy grant is deny-all: every CONNECT is refused and audited against the connection', async () => {
    const r = makeResolvedModel('openai_compatible');
    const { env, revoke } = await prepareSdkChild(r, { key: 'sess-6', orgId: 'org-1', aiSessionId: 'sess-6', source: PARENT });
    rec.events.length = 0;
    expect(await connectThrough(env.HTTPS_PROXY!, 'api.anthropic.com:443')).toBe(403);
    expect(await connectThrough(env.HTTPS_PROXY!, 'llm.example.com:443')).toBe(403);
    expect(rec.events).toEqual([
      expect.objectContaining({ surface: 'sdk_proxy_connect', host: 'api.anthropic.com', blocked: true, connectionId: 'conn-oai', orgId: 'org-1', partnerId: 'partner-1', aiSessionId: 'sess-6' }),
      expect.objectContaining({ surface: 'sdk_proxy_connect', host: 'llm.example.com', blocked: true, connectionId: 'conn-oai' }),
    ]);
    revoke();
  });

  it('revoke() kills the gateway grant (401 afterwards) and the deny-all proxy grant (407)', async () => {
    const r = makeResolvedModel('openai_compatible');
    const { env, revoke } = await prepareSdkChild(r, { key: 'sess-4', orgId: 'org-1', aiSessionId: null, source: PARENT });
    revoke();
    const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/models`);
    expect(res.status).toBe(401);
    expect(await connectThrough(env.HTTPS_PROXY!, 'api.anthropic.com:443')).toBe(407);
    // Idempotent: a second revoke on another teardown path is harmless.
    expect(() => revoke()).not.toThrow();
  });

  it('binds the refusal fallback wire model too', async () => {
    const r = makeResolvedModel('openai_compatible', {
      refusalFallback: {
        offeringId: 'o2', displayName: 'b', wireModel: 'qwen-b', wireParams: { betas: [], applied: {} }, options: {},
        rateSnapshot: { source: 'offering', standard: { inputCentsPerM: 1, outputCentsPerM: 1, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 } },
      } as never,
    });
    const { env, revoke } = await prepareSdkChild(r, { key: 'sess-7', orgId: 'org-1', aiSessionId: null, source: PARENT });
    const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/models`);
    const body = await res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id).sort()).toEqual(['qwen-b', 'qwen2.5-coder:7b']);
    revoke();
  });

  it('records one sdk_session_create audit row with the connection id', async () => {
    const r = makeResolvedModel('openai_compatible');
    const { revoke } = await prepareSdkChild(r, { key: 'sess-5', orgId: 'org-1', aiSessionId: 'sess-5', source: PARENT });
    expect(rec.events).toEqual([expect.objectContaining({
      surface: 'sdk_session_create', connectionId: 'conn-oai', host: 'llm.example.com', orgId: 'org-1', partnerId: 'partner-1', blocked: false,
    })]);
    revoke();
  });

  it('a gateway env never enables ToolSearch (the translator has no tool_reference)', async () => {
    const r = makeResolvedModel('openai_compatible');
    const { env, revoke } = await prepareSdkChild(r, { key: 'sess-8', orgId: 'org-1', aiSessionId: null, source: PARENT });
    const policy = resolveToolSearchPolicy({ surfaceSearch: true, childEnv: env, remainingTurns: 10, override: 'auto' });
    expect(policy.enabled).toBe(false);
    expect(policy.tools).toEqual([]);
    revoke();
  });

  it('catalog and BYOK behave exactly as before (delegates to buildClaudeSdkChildEnv)', async () => {
    const byok = await prepareSdkChild(makeResolvedModel('anthropic_byok'), { key: 'k', orgId: 'org-1', aiSessionId: null, source: PARENT });
    expect(byok.env.ANTHROPIC_API_KEY).toBe('sk-partner');
    expect(byok.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(byok.env.HTTPS_PROXY).toBe('http://corp:3128');
    byok.revoke();
    expect(rec.events).toEqual([]);

    const plat = await prepareSdkChild(makeResolvedModel('platform'), { key: 'kp', orgId: 'org-1', aiSessionId: null, source: PARENT });
    expect(plat.env.ANTHROPIC_API_KEY).toBe('sk-platform-PARENT');
    expect(plat.env.ANTHROPIC_BASE_URL).toBe('https://parent.example.com');
    plat.revoke();

    const cat = await prepareSdkChild(makeResolvedModel('catalog'), { key: 'k2', orgId: 'org-1', aiSessionId: null, source: PARENT });
    expect(cat.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.com');
    expect(cat.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-partner');
    expect(cat.env.HTTPS_PROXY).toMatch(/127\.0\.0\.1/);
    expect(cat.env.NO_PROXY).toBe('');
    expect(rec.events).toEqual([expect.objectContaining({ surface: 'sdk_session_create', host: 'gw.example.com', catalogEntryId: 'cat-1' })]);
    cat.revoke();
    expect(await connectThrough(cat.env.HTTPS_PROXY!, 'gw.example.com:443')).toBe(407);
  });
});
