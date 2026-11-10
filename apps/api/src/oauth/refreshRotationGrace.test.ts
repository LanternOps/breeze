import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider } from 'oidc-provider';

vi.mock('./log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./log')>();
  return { ...actual, logOauthWarn: vi.fn(), logOauthDebug: vi.fn() };
});

import { ERROR_IDS, logOauthWarn } from './log';
import { metricsRegistry } from '../services/metricsRegistry';
import {
  REFRESH_ROTATION_GRACE_METRIC,
  configureRotationSealKey,
  createRotationGraceHitLogger,
  currentRefreshGrantRequest,
  installRotationSuccessorIds,
  markRotationGraceHit,
  rotationGraceHit,
  recordRotationGraceOutcome,
  refreshRotationGraceMs,
  newSuccessorTokenValue,
  openRotationSuccessor,
  rotationSealingAvailable,
  sealRotationSuccessor,
  setPendingRotationSuccessor,
  takePendingRotationSuccessor,
} from './refreshRotationGrace';

const warnMock = vi.mocked(logOauthWarn);
const ENV = 'OAUTH_REFRESH_ROTATION_GRACE_MS';

function refreshCtx(presented: string, clientId: string | null = 'client-a', grantType = 'refresh_token') {
  return {
    oidc: {
      client: clientId ? { clientId } : undefined,
      params: { grant_type: grantType, refresh_token: presented, client_id: clientId ?? undefined },
    },
    get: (name: string) => (name.toLowerCase() === 'user-agent' ? 'Example-Agent/1.0' : ''),
  };
}

function withProviderCtx(ctx: unknown) {
  return vi.spyOn(Provider, 'ctx', 'get').mockReturnValue(ctx as never);
}

describe('refreshRotationGraceMs', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    delete process.env[ENV];
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env[ENV];
    warn.mockRestore();
  });

  it('defaults to 10 s when unset or empty (Compose passes an empty string)', () => {
    expect(refreshRotationGraceMs()).toBe(10_000);
    process.env[ENV] = '';
    expect(refreshRotationGraceMs()).toBe(10_000);
  });

  it('0 disables the window', () => {
    process.env[ENV] = '0';
    expect(refreshRotationGraceMs()).toBe(0);
  });

  it('accepts a value up to the 30 s hard cap and clamps anything above it', () => {
    process.env[ENV] = '25000';
    expect(refreshRotationGraceMs()).toBe(25_000);
    process.env[ENV] = '45000';
    expect(refreshRotationGraceMs()).toBe(30_000);
  });

  it('falls back to the strict behaviour (0) on an unparseable value', () => {
    for (const bad of ['10s', '-5', 'abc', '1e4']) {
      process.env[ENV] = bad;
      expect(refreshRotationGraceMs(), bad).toBe(0);
    }
    expect(warn).toHaveBeenCalled();
  });
});

describe('successor sealing', () => {
  const SECRET = 'seal-secret-one-at-least-32-characters-long';
  const parent = { parentRaw: 'raw-parent-token', parentStorageId: 'digest-of-parent' };
  afterEach(() => configureRotationSealKey(null));

  it('is unavailable until a key is configured', () => {
    configureRotationSealKey(null);
    expect(rotationSealingAvailable()).toBe(false);
    expect(sealRotationSuccessor({ ...parent, successorRaw: 'rt-1' })).toBeNull();
  });

  it('round-trips the successor for the same parent token and row', () => {
    configureRotationSealKey(SECRET);
    const successorRaw = newSuccessorTokenValue();
    const sealed = sealRotationSuccessor({ ...parent, successorRaw })!;
    expect(sealed).not.toContain(successorRaw);
    expect(openRotationSuccessor({ ...parent, sealed })).toBe(successorRaw);
  });

  it('cannot be opened without the raw parent, for another row, or under another secret', () => {
    configureRotationSealKey(SECRET);
    const sealed = sealRotationSuccessor({ ...parent, successorRaw: 'rt-1' })!;
    expect(openRotationSuccessor({ ...parent, parentRaw: 'other-parent', sealed })).toBeNull();
    expect(openRotationSuccessor({ ...parent, parentStorageId: 'other-digest', sealed })).toBeNull();
    configureRotationSealKey('seal-secret-two-at-least-32-characters-long');
    expect(openRotationSuccessor({ ...parent, sealed })).toBeNull();
  });

  it('rejects malformed or tampered seals', () => {
    configureRotationSealKey(SECRET);
    const sealed = sealRotationSuccessor({ ...parent, successorRaw: 'rt-1' })!;
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA');
    for (const bad of ['', 'v1.', 'v2.' + sealed.slice(3), 'v1.AAAA', tampered]) {
      expect(openRotationSuccessor({ ...parent, sealed: bad }), bad).toBeNull();
    }
  });

  it('mints successors with the shape of a provider opaque token (43 base64url chars)', () => {
    const a = newSuccessorTokenValue();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSuccessorTokenValue()).not.toBe(a);
  });
});

describe('currentRefreshGrantRequest', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the presented token and the authenticated client from the provider request', () => {
    const ctx = refreshCtx('rt-0', 'client-a');
    withProviderCtx(ctx);
    expect(currentRefreshGrantRequest()).toEqual({ ctx, presentedToken: 'rt-0', clientId: 'client-a' });
  });

  it('is null outside a refresh_token grant (no request, other grant types, other endpoints)', () => {
    withProviderCtx(undefined);
    expect(currentRefreshGrantRequest()).toBeNull();
    withProviderCtx(refreshCtx('rt-0', 'client-a', 'authorization_code'));
    expect(currentRefreshGrantRequest()).toBeNull();
    withProviderCtx({ oidc: { params: { token: 'rt-0' } } });
    expect(currentRefreshGrantRequest()).toBeNull();
  });

  it('keeps clientId null when the provider has not authenticated a client', () => {
    withProviderCtx(refreshCtx('rt-0', null));
    expect(currentRefreshGrantRequest()?.clientId).toBeNull();
  });
});

describe('grace-hit marker', () => {
  it('is scoped to one request context and one token', () => {
    const ctxA = {};
    const ctxB = {};
    markRotationGraceHit(ctxA, 'digest-0', 'successor-0');
    expect(rotationGraceHit(ctxA, 'digest-0')).toBe('successor-0');
    expect(rotationGraceHit(ctxA, 'digest-1')).toBeNull();
    expect(rotationGraceHit(ctxB, 'digest-0')).toBeNull();
  });
});

describe('installRotationSuccessorIds', () => {
  const SECRET = 'install-secret-at-least-32-characters-long';
  let original: ReturnType<typeof vi.fn>;
  let FakeRefreshToken: { prototype: { generateTokenId: () => string } };

  beforeEach(() => {
    original = vi.fn(() => 'random-provider-id');
    FakeRefreshToken = { prototype: { generateTokenId: original as unknown as () => string } };
    installRotationSuccessorIds({ RefreshToken: FakeRefreshToken } as never, SECRET);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    configureRotationSealKey(null);
  });

  it('configures the sealing key', () => {
    expect(rotationSealingAvailable()).toBe(true);
  });

  it('mints the successor consume() published for this request, exactly once', () => {
    const ctx = refreshCtx('rt-0');
    withProviderCtx(ctx);
    setPendingRotationSuccessor(ctx, 'published-successor');
    expect(FakeRefreshToken.prototype.generateTokenId.call({})).toBe('published-successor');
    expect(original).not.toHaveBeenCalled();
    expect(FakeRefreshToken.prototype.generateTokenId.call({})).toBe('random-provider-id');
  });

  it('keeps provider-random ids when nothing was published (other grants, other requests, no request)', () => {
    const other = refreshCtx('rt-0');
    setPendingRotationSuccessor(other, 'someone-elses-successor');
    withProviderCtx(refreshCtx('rt-0'));
    expect(FakeRefreshToken.prototype.generateTokenId.call({})).toBe('random-provider-id');
    withProviderCtx(undefined);
    expect(FakeRefreshToken.prototype.generateTokenId.call({})).toBe('random-provider-id');
    expect(takePendingRotationSuccessor(other)).toBe('someone-elses-successor');
  });

  it('is idempotent (a second install does not wrap the wrapper)', () => {
    const patched = FakeRefreshToken.prototype.generateTokenId;
    installRotationSuccessorIds({ RefreshToken: FakeRefreshToken } as never, SECRET);
    expect(FakeRefreshToken.prototype.generateTokenId).toBe(patched);
  });
});

describe('createRotationGraceHitLogger', () => {
  beforeEach(() => vi.clearAllMocks());

  const hit = (clientId: string, reuseMs = 32) => ({
    path: 'replay' as const,
    clientId,
    grantId: 'grant-1',
    reuseMs,
  });

  it('logs OAUTH_REFRESH_GRACE_HIT with client, reuse_ms and user agent, never the raw token', () => {
    const log = createRotationGraceHitLogger({ now: () => 0 });
    log(refreshCtx('raw-token-never-logged'), hit('client-a'));
    expect(warnMock).toHaveBeenCalledTimes(1);
    const args = warnMock.mock.calls[0]![0];
    expect(args.errorId).toBe(ERROR_IDS.OAUTH_REFRESH_GRACE_HIT);
    expect(args.context).toMatchObject({
      client_id: 'client-a',
      grant_id: 'grant-1',
      reuse_ms: 32,
      path: 'replay',
      user_agent: 'Example-Agent/1.0',
      suppressed: 0,
    });
    expect(JSON.stringify(args)).not.toContain('raw-token-never-logged');
  });

  it('throttles repeats per client and reports the suppressed count on the next line', () => {
    let now = 0;
    const log = createRotationGraceHitLogger({ now: () => now, windowMs: 1000 });
    log(refreshCtx('t'), hit('client-a'));
    now = 500;
    log(refreshCtx('t'), hit('client-a'));
    log(refreshCtx('t'), hit('client-b'));
    expect(warnMock).toHaveBeenCalledTimes(2);
    now = 1500;
    log(refreshCtx('t'), hit('client-a'));
    expect(warnMock).toHaveBeenCalledTimes(3);
    expect(warnMock.mock.calls[2]![0].context).toMatchObject({ client_id: 'client-a', suppressed: 1 });
  });
});

describe('recordRotationGraceOutcome', () => {
  async function count(outcome: string): Promise<number> {
    const metric = await metricsRegistry.getSingleMetric(REFRESH_ROTATION_GRACE_METRIC)?.get();
    return metric?.values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
  }

  it('counts outcomes under a client-free label set', async () => {
    const before = await count('hit');
    recordRotationGraceOutcome('hit', 40);
    expect(await count('hit')).toBe(before + 1);
    const metric = await metricsRegistry.getSingleMetric(REFRESH_ROTATION_GRACE_METRIC)?.get();
    for (const v of metric?.values ?? []) expect(Object.keys(v.labels)).toEqual(['outcome']);
  });

  it('pre-seeds every outcome at zero so rate() sees a series', async () => {
    const metric = await metricsRegistry.getSingleMetric(REFRESH_ROTATION_GRACE_METRIC)?.get();
    const outcomes = new Set(metric?.values.map((v) => v.labels.outcome));
    for (const o of ['hit', 'concurrent_hit', 'outside_window', 'client_mismatch', 'successor_inactive', 'unsealable']) {
      expect(outcomes.has(o), o).toBe(true);
    }
  });
});
