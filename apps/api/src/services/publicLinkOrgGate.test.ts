/**
 * Unit tests for the public-link tenant gate (org-lifecycle Wave 4, final
 * review fix C-A.1). The DB is mocked; what is under test is the mapping from
 * a resolved org status to `blocked`, and the "no row → gate open" rule that
 * keeps a missing quote a 404 instead of a 410 existence oracle.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbResults, ambient } = vi.hoisted(() => ({
  dbResults: [] as unknown[][],
  ambient: { current: undefined as { scope: string } | undefined },
}));

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'innerJoin', 'where', 'limit']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(dbResults.shift() ?? []).then(resolve);
    return chain;
  };
  return {
    db: makeChain(),
    getCurrentDbAccessContext: () => ambient.current,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import {
  isPublicLinkOrgStatusLive,
  PUBLIC_LINK_ORG_UNAVAILABLE,
  resolveOrgLinkGate,
  resolveQuoteLinkOrgGate,
} from './publicLinkOrgGate';

const ORG_ID = '22222222-2222-2222-2222-222222222222';
const SURVIVOR_ORG_ID = '33333333-3333-3333-3333-333333333333';
const QUOTE_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  dbResults.length = 0;
  ambient.current = undefined;
});

describe('isPublicLinkOrgStatusLive', () => {
  it.each(['active', 'trial'])('admits %s', (status) => {
    expect(isPublicLinkOrgStatusLive(status)).toBe(true);
  });

  it.each(['archived', 'purging', 'merging', 'suspended', 'churned', 'offboarding', null, undefined])(
    'refuses %s',
    (status) => {
      expect(isPublicLinkOrgStatusLive(status as string | null | undefined)).toBe(false);
    },
  );
});

describe('resolveQuoteLinkOrgGate', () => {
  it('blocks when the quote resolves to an archived org', async () => {
    dbResults.push([{ orgId: ORG_ID, status: 'archived' }]);
    const gate = await resolveQuoteLinkOrgGate(QUOTE_ID, [ORG_ID]);
    expect(gate).toEqual({ orgId: ORG_ID, status: 'archived', blocked: true });
  });

  it('does NOT block when the merge SURVIVOR org is still active', async () => {
    // Wave 2 continuity: the token names the merged-away loser, the row now
    // lives under the survivor, and the survivor's status is what gates.
    dbResults.push([{ orgId: SURVIVOR_ORG_ID, status: 'active' }]);
    const gate = await resolveQuoteLinkOrgGate(QUOTE_ID, [ORG_ID, SURVIVOR_ORG_ID]);
    expect(gate).toEqual({ orgId: SURVIVOR_ORG_ID, status: 'active', blocked: false });
  });

  it('leaves the gate OPEN when no quote row matched (404 stays a 404)', async () => {
    dbResults.push([]);
    const gate = await resolveQuoteLinkOrgGate(QUOTE_ID, [ORG_ID]);
    expect(gate).toEqual({ orgId: null, status: null, blocked: false });
  });

  it('short-circuits without a query when there are no candidate orgs', async () => {
    const gate = await resolveQuoteLinkOrgGate(QUOTE_ID, []);
    expect(gate.blocked).toBe(false);
    expect(dbResults).toHaveLength(0);
  });
});

describe('resolveOrgLinkGate', () => {
  it.each(['archived', 'purging', 'merging', 'suspended'])('blocks a %s org', async (status) => {
    dbResults.push([{ id: ORG_ID, status }]);
    expect((await resolveOrgLinkGate(ORG_ID)).blocked).toBe(true);
  });

  it('admits an active org', async () => {
    dbResults.push([{ id: ORG_ID, status: 'active' }]);
    expect((await resolveOrgLinkGate(ORG_ID)).blocked).toBe(false);
  });

  it('reuses an already-system ambient context instead of escalating', async () => {
    ambient.current = { scope: 'system' };
    dbResults.push([{ id: ORG_ID, status: 'active' }]);
    expect((await resolveOrgLinkGate(ORG_ID)).status).toBe('active');
  });
});

describe('PUBLIC_LINK_ORG_UNAVAILABLE', () => {
  it('is the single non-leaky body every public route returns', () => {
    expect(PUBLIC_LINK_ORG_UNAVAILABLE).toEqual({
      error: 'This link is no longer available',
      code: 'ORG_UNAVAILABLE',
    });
    // No tenant name, id or status — a 410 must not become an oracle.
    expect(JSON.stringify(PUBLIC_LINK_ORG_UNAVAILABLE)).not.toContain('archiv');
  });
});
