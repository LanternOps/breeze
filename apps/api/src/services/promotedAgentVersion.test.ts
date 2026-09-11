/**
 * Tests for getPromotedComponentVersion — the single query that makes the
 * public component-download routes serve bytes from the SAME agent_versions
 * row that GET /agent-versions/latest serves the checksum from (issue #3499).
 *
 * The route-level behavior (redirect target actually uses this version) is
 * pinned in routes/agents/download.test.ts. This file pins the resolver's own
 * contract: the WHERE structure it queries with — including the route-os →
 * DB-platform mapping that a checksum/bytes mismatch would otherwise hide —
 * and its two fall-back-to-env paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted() must run before any import.
// ---------------------------------------------------------------------------
const { dbMock } = vi.hoisted(() => {
  let nextResult: unknown[] = [];
  let nextError: Error | null = null;
  const chains: any[] = [];

  const makeSelectChain = () => {
    const settle = () =>
      nextError ? Promise.reject(nextError) : Promise.resolve(nextResult);
    const chain: any = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => settle()),
    };
    chains.push(chain);
    return chain;
  };

  const dbMock = {
    select: vi.fn(() => makeSelectChain()),
    _setResult(rows: unknown[]) {
      nextResult = rows;
      nextError = null;
    },
    _setError(err: Error) {
      nextError = err;
    },
    /** The `.where()` argument of the most recent select chain. */
    _lastWhereArg(): unknown {
      const chain = chains[chains.length - 1];
      return chain?.where.mock.calls[0]?.[0];
    },
    _reset() {
      chains.length = 0;
      nextResult = [];
      nextError = null;
    },
  };

  return { dbMock };
});

vi.mock('../db', () => ({ db: dbMock }));

vi.mock('./sentry', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// Mock columns are plain strings so PgDialect compiles them into bound params,
// letting the assertions pin the real WHERE structure rather than a substring.
vi.mock('../db/schema', () => ({
  agentVersions: {
    version: 'av.version',
    platform: 'av.platform',
    architecture: 'av.architecture',
    component: 'av.component',
    isLatest: 'av.is_latest',
    edition: 'av.edition',
    createdAt: 'av.created_at',
  },
}));

// Import under test — AFTER all mocks are installed.
import {
  getPromotedComponentVersion,
  getRegisteredComponentVersion,
  getPromotedAgentVersionForDisplay,
  PromotedVersionUnavailableError,
  __resetPromotedVersionCaptureCacheForTests,
} from './promotedAgentVersion';
import { captureException, captureMessage } from './sentry';
import { PgDialect } from 'drizzle-orm/pg-core';

function compiledWhere() {
  return new PgDialect().sqlToQuery(dbMock._lastWhereArg() as never);
}

/** Value bound immediately after `column` in the compiled WHERE params. */
function boundValueFor(column: string): unknown {
  const { params } = compiledWhere();
  const idx = params.indexOf(column);
  expect(idx).toBeGreaterThanOrEqual(0);
  return params[idx + 1];
}

describe('getPromotedComponentVersion', () => {
  const OLD_EDITION = process.env.BINARY_EDITION;

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock._reset();
    __resetPromotedVersionCaptureCacheForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (OLD_EDITION === undefined) delete process.env.BINARY_EDITION;
    else process.env.BINARY_EDITION = OLD_EDITION;
    vi.restoreAllMocks();
  });

  it('returns the promoted version for the requested component/os/arch', async () => {
    dbMock._setResult([{ version: '0.104.0' }]);

    await expect(
      getPromotedComponentVersion('agent', 'linux', 'amd64'),
    ).resolves.toBe('0.104.0');
  });

  it('maps the route OS "darwin" to the DB platform "macos"', async () => {
    // agent_versions stores macOS rows as "macos"; the download route paths use
    // Go GOOS ("darwin"). Querying the unmapped value would match no row, and
    // the route would silently fall back to the env version — reintroducing
    // exactly the checksum/bytes divergence this resolver exists to close.
    dbMock._setResult([{ version: '0.104.0' }]);

    await getPromotedComponentVersion('agent', 'darwin', 'arm64');

    expect(boundValueFor('av.platform')).toBe('macos');
    expect(boundValueFor('av.architecture')).toBe('arm64');
  });

  it('passes linux and windows through unmapped', async () => {
    dbMock._setResult([{ version: '0.104.0' }]);
    await getPromotedComponentVersion('watchdog', 'windows', 'amd64');
    expect(boundValueFor('av.platform')).toBe('windows');
    expect(boundValueFor('av.component')).toBe('watchdog');
  });

  it('filters on the promoted row and this server edition', async () => {
    process.env.BINARY_EDITION = 'hosted';
    dbMock._setResult([{ version: '0.104.0' }]);

    await getPromotedComponentVersion('backup', 'linux', 'amd64');

    expect(boundValueFor('av.is_latest')).toBe(true);
    // Same edition scoping as /agent-versions/latest (#4072), so the checksum
    // route and this one can never resolve different editions of a version.
    expect(boundValueFor('av.edition')).toBe('hosted');
  });

  it('ANDs its predicates with equality — not OR, and not negated', async () => {
    // The bound-parameter assertions above are blind to SQL structure: they
    // pass identically whether the predicates are ANDed or ORed, and whether
    // isLatest is compared with = or <>. Both mutations are catastrophic — OR
    // returns a row matching ANY clause (bytes for a different
    // platform/arch/component than the checksum), and <> selects precisely the
    // NON-promoted rows. Pin the operators themselves.
    dbMock._setResult([{ version: '0.104.0' }]);

    await getPromotedComponentVersion('agent', 'linux', 'amd64');
    const { sql } = compiledWhere();

    expect(sql).not.toMatch(/\bor\b/i);
    expect(sql).toMatch(/\band\b/i);
    // Five equality predicates, no negation.
    expect(sql).not.toContain('<>');
    expect(sql.match(/=/g)).toHaveLength(5);
  });

  it('defaults the edition filter to self-host', async () => {
    delete process.env.BINARY_EDITION;
    dbMock._setResult([{ version: '0.104.0' }]);

    await getPromotedComponentVersion('agent', 'linux', 'amd64');

    expect(boundValueFor('av.edition')).toBe('self-host');
  });

  it('returns null and warns when no promoted row exists', async () => {
    // A deployment that has never completed a binary sync. The caller must
    // fall back to the env-resolved version rather than fail the download.
    dbMock._setResult([]);

    await expect(
      getPromotedComponentVersion('agent', 'linux', 'amd64'),
    ).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('#3499');
  });

  it('logs the missing row EVERY time but captures to Sentry only once per tuple', async () => {
    // The console line is what an operator greps to confirm the gap is still
    // happening, so it must not be deduped to one line from whenever the first
    // download landed. The Sentry capture is the expensive one — dedupe that.
    dbMock._setResult([]);
    await getPromotedComponentVersion('agent', 'linux', 'amd64');
    await getPromotedComponentVersion('agent', 'linux', 'amd64');

    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureMessage).mock.calls[0]?.[1]).toMatchObject({
      eventCode: 'agent_promoted_version_missing',
    });

    // A different tuple is a distinct gap and captures again.
    await getPromotedComponentVersion('agent', 'windows', 'amd64');
    expect(captureMessage).toHaveBeenCalledTimes(2);
  });

  it('THROWS when the lookup faults — never silently serves the env version', async () => {
    // Falling back here would reintroduce #3499 (bytes that do not match the
    // checksum the client already holds) and would surface a server-side DB
    // fault to an end user as "Checksum verification failed", the exact string
    // this fix exists to eliminate. The caller turns this into a 503.
    dbMock._setError(new Error('connection terminated'));

    await expect(
      getPromotedComponentVersion('agent', 'linux', 'amd64'),
    ).rejects.toBeInstanceOf(PromotedVersionUnavailableError);

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('treats the "unknown" local-registration sentinel as no promoted row', async () => {
    // binarySync stores the literal "unknown" when BINARY_VERSION_FILE is
    // unset and promotes it under the default AGENT_AUTO_PROMOTE. Returning it
    // would build ".../releases/download/vunknown/..." and 404 every download
    // on a deployment that later switches to BINARY_SOURCE=github.
    dbMock._setResult([{ version: 'unknown' }]);

    await expect(
      getPromotedComponentVersion('agent', 'linux', 'amd64'),
    ).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('THROWS on an unmapped route OS rather than reporting a missing row', async () => {
    // VALID_OS gates this upstream, but that invariant lives in another file.
    // An unmapped OS must not match zero rows and masquerade as a
    // never-synced deployment, which would silently fall back to env.
    dbMock._setResult([{ version: '0.104.0' }]);

    await expect(
      getPromotedComponentVersion('agent', 'solaris', 'amd64'),
    ).rejects.toBeInstanceOf(PromotedVersionUnavailableError);
    expect(dbMock.select).not.toHaveBeenCalled();
  });
});

describe('getRegisteredComponentVersion (issue #5159)', () => {
  const OLD_EDITION = process.env.BINARY_EDITION;

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock._reset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (OLD_EDITION === undefined) delete process.env.BINARY_EDITION;
    else process.env.BINARY_EDITION = OLD_EDITION;
    vi.restoreAllMocks();
  });

  it('returns the version AS STORED, never the caller-supplied string', async () => {
    // The download routes are public and unauthenticated, and the returned
    // value is interpolated into a GitHub release-tag path. It must originate
    // from a row this server registered, not from the query string.
    dbMock._setResult([{ version: '0.110.0' }]);

    await expect(
      getRegisteredComponentVersion('agent', 'windows', 'amd64', '0.110.0'),
    ).resolves.toBe('0.110.0');
  });

  it('matches on the requested version and does NOT filter on isLatest', async () => {
    // The whole point: an org agentVersionPins pilot is deliberately allowed
    // to be un-promoted (#2124). Requiring isLatest here would re-break it.
    dbMock._setResult([{ version: '0.110.0' }]);

    await getRegisteredComponentVersion('agent', 'darwin', 'arm64', '0.110.0');

    expect(boundValueFor('av.version')).toBe('0.110.0');
    expect(boundValueFor('av.platform')).toBe('macos');
    const { sql, params } = compiledWhere();
    expect(params).not.toContain('av.is_latest');
    expect(sql).not.toMatch(/\bor\b/i);
    expect(sql).not.toContain('<>');
    // version, platform, architecture, component, edition — five equalities.
    expect(sql.match(/=/g)).toHaveLength(5);
  });

  it('scopes to this server edition', async () => {
    process.env.BINARY_EDITION = 'hosted';
    dbMock._setResult([{ version: '0.110.0' }]);

    await getRegisteredComponentVersion('backup', 'linux', 'amd64', '0.110.0');

    expect(boundValueFor('av.edition')).toBe('hosted');
  });

  it('returns null when no row matches, so the route can fail closed', async () => {
    dbMock._setResult([]);

    await expect(
      getRegisteredComponentVersion('agent', 'linux', 'amd64', '9.9.9'),
    ).resolves.toBeNull();
  });

  it('treats the "unknown" sentinel as unresolvable', async () => {
    // binarySync stores the literal "unknown" for locally-registered binaries
    // with no version file; "vunknown" is not a release tag.
    dbMock._setResult([{ version: 'unknown' }]);

    await expect(
      getRegisteredComponentVersion('agent', 'linux', 'amd64', 'unknown'),
    ).resolves.toBeNull();
  });

  it('throws PromotedVersionUnavailableError on a lookup fault', async () => {
    dbMock._setError(new Error('connection terminated'));

    await expect(
      getRegisteredComponentVersion('agent', 'linux', 'amd64', '0.110.0'),
    ).rejects.toBeInstanceOf(PromotedVersionUnavailableError);
    expect(captureException).toHaveBeenCalled();
  });

  it('throws on an unmapped route OS rather than matching no row', async () => {
    await expect(
      getRegisteredComponentVersion('agent', 'solaris', 'amd64', '0.110.0'),
    ).rejects.toBeInstanceOf(PromotedVersionUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// getPromotedAgentVersionForDisplay — a deliberately platform/arch-UNSCOPED
// lookup of the promoted "agent" version, used only to feed the Devices list
// colour badge (issue #5285). NOT part of the #3499 lockstep above: this is a
// display hint, not a byte-serving decision, so it fails soft (null) rather
// than throwing.
// ---------------------------------------------------------------------------
describe('getPromotedAgentVersionForDisplay', () => {
  const OLD_EDITION = process.env.BINARY_EDITION;

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock._reset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (OLD_EDITION === undefined) delete process.env.BINARY_EDITION;
    else process.env.BINARY_EDITION = OLD_EDITION;
  });

  it('returns the promoted agent version for this edition', async () => {
    dbMock._setResult([{ version: '0.110.0' }]);
    await expect(getPromotedAgentVersionForDisplay()).resolves.toBe('0.110.0');
    expect(boundValueFor('av.component')).toBe('agent');
    expect(boundValueFor('av.is_latest')).toBe(true);
  });

  it('scopes to this server\'s own build edition', async () => {
    process.env.BINARY_EDITION = 'hosted';
    dbMock._setResult([{ version: '0.110.0' }]);
    await getPromotedAgentVersionForDisplay();
    expect(boundValueFor('av.edition')).toBe('hosted');
  });

  it('returns null when no promoted row exists yet (never synced)', async () => {
    dbMock._setResult([]);
    await expect(getPromotedAgentVersionForDisplay()).resolves.toBeNull();
  });

  it('treats the "unknown" sentinel as unresolvable, same as the other resolvers', async () => {
    dbMock._setResult([{ version: 'unknown' }]);
    await expect(getPromotedAgentVersionForDisplay()).resolves.toBeNull();
  });

  it('fails soft (null) rather than throwing on a lookup fault — this only feeds a display badge', async () => {
    dbMock._setError(new Error('connection terminated'));
    await expect(getPromotedAgentVersionForDisplay()).resolves.toBeNull();
  });
});
