/**
 * Tests for getOrgAgentVersionPinsBatch — the batch variant of
 * getOrgAgentUpdateConfig's pin resolution (routes/agents/helpers.ts), for
 * read paths that need MANY orgs' effective agent-version pins in one round
 * trip (issue #5285: the Devices list "Agent Version" badge, resolved once
 * per page load across every visible org).
 *
 * Deliberately its own file with its own minimal mock harness: this module
 * imports only db/schema + @breeze/shared, NOT routes/agents/helpers.ts
 * (whose import graph is far larger and broke unrelated route tests when
 * this function briefly lived there — see the comment in the source file).
 *
 * IMPORTANT LIMITATION (mirrors enrollmentDefaults.test.ts, issue #2776's
 * pattern): a mocked-DB unit test CANNOT prove that an org-scoped caller
 * actually sees the partner's pin — that requires real Postgres RLS to
 * deny/allow the `partners` row, which no mock can emulate. These tests only
 * prove the WIRING: that the join runs via
 * runOutsideDbContext(withSystemDbAccessContext(...)) whenever the ambient
 * context is not already system-scoped, exactly as `getEnrollmentDefaultsForOrg`
 * (services/enrollmentDefaults.ts) does for the identical org⋈partner RLS
 * shape. Without this escalation, `computeAccessiblePartnerIds` returns `[]`
 * for an organization-scoped caller (middleware/auth.ts), the `partners` FOR
 * SELECT policy `breeze_has_partner_access(id)` denies the row, and the
 * LEFT JOIN silently returns `partnerSettings: null` — a partner-inherited
 * pin would vanish with no error for exactly the population (org-scoped
 * tokens hitting GET /agent-versions/effective) this resolver exists to
 * serve.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dbMock,
  runOutsideDbContextMock,
  withSystemDbAccessContextMock,
  getCurrentDbAccessContextMock,
} = vi.hoisted(() => {
  let nextResult: unknown[] = [];
  const chains: any[] = [];

  const makeSelectChain = () => {
    const chain: any = {
      from: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
    };
    chain.then = (resolve: any, reject: any) => Promise.resolve(nextResult).then(resolve, reject);
    chains.push(chain);
    return chain;
  };

  const dbMock = {
    select: vi.fn(() => makeSelectChain()),
    _setResult(rows: unknown[]) {
      nextResult = rows;
    },
  };

  // Pass-through mocks that still let assertions verify they were invoked —
  // real behavior (exiting the ALS context, setting RLS GUCs) can't be
  // exercised without a real DB; the underlying escape mechanism is already
  // proven against Postgres by enrollmentDefaultsPartnerCap.integration.test.ts.
  const runOutsideDbContextMock = vi.fn((fn: () => unknown) => fn());
  const withSystemDbAccessContextMock = vi.fn((fn: () => unknown) => fn());
  // Ambient DbAccessContext metadata. Default: no context at all (background /
  // contextless caller), which must take the escape just like an org-scoped one.
  const getCurrentDbAccessContextMock = vi.fn((): unknown => undefined);

  return {
    dbMock,
    runOutsideDbContextMock,
    withSystemDbAccessContextMock,
    getCurrentDbAccessContextMock,
  };
});

vi.mock('../db', () => ({
  db: dbMock,
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
  getCurrentDbAccessContext: getCurrentDbAccessContextMock,
}));
vi.mock('../db/schema', () => ({
  organizations: { id: 'orgs.id', settings: 'orgs.settings', partnerId: 'orgs.partner_id' },
  partners: { id: 'partners.id', settings: 'partners.settings' },
}));

import { getOrgAgentVersionPinsBatch } from './orgAgentVersionPins';

/** Stand-in for the metadata AsyncLocalStorage store of an active context. */
function ambientContext(scope: 'system' | 'partner' | 'organization'): unknown {
  return {
    scope,
    orgId: scope === 'organization' ? 'org-a' : null,
    accessibleOrgIds: scope === 'organization' ? ['org-a'] : null,
    accessiblePartnerIds: scope === 'system' ? null : [],
    userId: null,
  };
}

describe('getOrgAgentVersionPinsBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runOutsideDbContextMock.mockImplementation((fn: () => unknown) => fn());
    withSystemDbAccessContextMock.mockImplementation((fn: () => unknown) => fn());
    getCurrentDbAccessContextMock.mockImplementation(() => undefined);
  });

  // The RLS-escalation wiring (partner rows are invisible to an org-scoped
  // request otherwise — see the file header). Mirrors
  // enrollmentDefaults.test.ts's "ambient-context branch" exactly, since this
  // resolver is the same org⋈partner-join-under-RLS shape.
  describe('ambient-context branch', () => {
    it('reads in the AMBIENT context — opening no second context — when the caller is already system-scoped', async () => {
      getCurrentDbAccessContextMock.mockImplementation(() => ambientContext('system'));
      dbMock._setResult([
        { id: 'org-a', orgSettings: { defaults: {} }, partnerSettings: { defaults: { agentVersionPins: { agent: '0.88.0' } } } },
      ]);

      const result = await getOrgAgentVersionPinsBatch(['org-a']);

      expect(result).toEqual({ 'org-a': { agent: '0.88.0', watchdog: null } });
      expect(dbMock.select).toHaveBeenCalledTimes(1);
      expect(runOutsideDbContextMock).not.toHaveBeenCalled();
      expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
    });

    it('escapes to a fresh system context for an ORG-scoped caller, so the partner-inherited pin is not silently lost', async () => {
      getCurrentDbAccessContextMock.mockImplementation(() => ambientContext('organization'));
      dbMock._setResult([
        { id: 'org-a', orgSettings: { defaults: {} }, partnerSettings: { defaults: { agentVersionPins: { agent: '0.88.0' } } } },
      ]);

      const result = await getOrgAgentVersionPinsBatch(['org-a']);

      expect(result).toEqual({ 'org-a': { agent: '0.88.0', watchdog: null } });
      expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
      expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    });

    it('escapes for a PARTNER-scoped caller too (partner scope sees only its OWN partner row otherwise)', async () => {
      getCurrentDbAccessContextMock.mockImplementation(() => ambientContext('partner'));
      dbMock._setResult([{ id: 'org-a', orgSettings: { defaults: {} }, partnerSettings: null }]);

      await getOrgAgentVersionPinsBatch(['org-a']);

      expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
      expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    });

    it('escapes when there is no ambient context at all (background/worker caller)', async () => {
      getCurrentDbAccessContextMock.mockImplementation(() => undefined);
      dbMock._setResult([{ id: 'org-a', orgSettings: { defaults: {} }, partnerSettings: null }]);

      await getOrgAgentVersionPinsBatch(['org-a']);

      expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
      expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    });

    it('does not escalate for an empty orgIds input (no query is issued at all)', async () => {
      getCurrentDbAccessContextMock.mockImplementation(() => ambientContext('organization'));

      const result = await getOrgAgentVersionPinsBatch([]);

      expect(result).toEqual({});
      expect(dbMock.select).not.toHaveBeenCalled();
      expect(runOutsideDbContextMock).not.toHaveBeenCalled();
      expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
    });
  });

  it('returns an empty map without querying for an empty input', async () => {
    const result = await getOrgAgentVersionPinsBatch([]);
    expect(result).toEqual({});
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('resolves pins for multiple orgs from ONE joined query', async () => {
    dbMock._setResult([
      { id: 'org-a', orgSettings: { defaults: { agentVersionPins: { agent: '0.88.0' } } }, partnerSettings: null },
      { id: 'org-b', orgSettings: { defaults: {} }, partnerSettings: { defaults: { agentVersionPins: { agent: '0.90.0' } } } },
      { id: 'org-c', orgSettings: { defaults: {} }, partnerSettings: null },
    ]);
    const result = await getOrgAgentVersionPinsBatch(['org-a', 'org-b', 'org-c']);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      'org-a': { agent: '0.88.0', watchdog: null },
      'org-b': { agent: '0.90.0', watchdog: null },
      'org-c': { agent: null, watchdog: null },
    });
  });

  it('org pin overrides an inherited partner pin, same precedence as the single-org resolver', async () => {
    dbMock._setResult([
      {
        id: 'org-a',
        orgSettings: { defaults: { agentVersionPins: { agent: '0.80.0' } } },
        partnerSettings: { defaults: { agentVersionPins: { agent: '0.88.0' } } },
      },
    ]);
    const result = await getOrgAgentVersionPinsBatch(['org-a']);
    expect(result).toEqual({ 'org-a': { agent: '0.80.0', watchdog: null } });
  });

  it('org inherits the partner pin per component where the org has not set it', async () => {
    dbMock._setResult([
      {
        id: 'org-a',
        orgSettings: { defaults: { agentVersionPins: { watchdog: '0.70.0' } } },
        partnerSettings: { defaults: { agentVersionPins: { agent: '0.88.0' } } },
      },
    ]);
    const result = await getOrgAgentVersionPinsBatch(['org-a']);
    expect(result).toEqual({ 'org-a': { agent: '0.88.0', watchdog: '0.70.0' } });
  });

  it("normalizes the 'latest' sentinel to null (no pin), same as the single-org resolver", async () => {
    dbMock._setResult([
      { id: 'org-a', orgSettings: { defaults: { agentVersionPins: { agent: 'latest' } } }, partnerSettings: null },
    ]);
    const result = await getOrgAgentVersionPinsBatch(['org-a']);
    expect(result).toEqual({ 'org-a': { agent: null, watchdog: null } });
  });

  it('an org missing from the result rows (e.g. deleted mid-request) is simply absent, not a crash', async () => {
    dbMock._setResult([
      { id: 'org-a', orgSettings: { defaults: {} }, partnerSettings: null },
    ]);
    const result = await getOrgAgentVersionPinsBatch(['org-a', 'org-missing']);
    expect(result).toEqual({ 'org-a': { agent: null, watchdog: null } });
  });
});
