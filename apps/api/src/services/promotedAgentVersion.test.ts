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
  resetPromotedVersionWarningCache,
} from './promotedAgentVersion';
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
    resetPromotedVersionWarningCache();
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

  it('warns only once per component/os/arch for a persistent gap', async () => {
    // Otherwise a self-hoster with no synced rows logs on every download.
    dbMock._setResult([]);
    await getPromotedComponentVersion('agent', 'linux', 'amd64');
    await getPromotedComponentVersion('agent', 'linux', 'amd64');
    expect(console.warn).toHaveBeenCalledTimes(1);

    // A different tuple is still reported.
    await getPromotedComponentVersion('agent', 'windows', 'amd64');
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('returns null and logs the fault when the lookup throws', async () => {
    // Degrades to the pre-#3499 env-resolved behavior instead of turning a
    // transient DB fault into a failed install. Must never be swallowed.
    dbMock._setError(new Error('connection terminated'));

    await expect(
      getPromotedComponentVersion('agent', 'linux', 'amd64'),
    ).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0]?.[0]).toContain('#3499');
  });
});
