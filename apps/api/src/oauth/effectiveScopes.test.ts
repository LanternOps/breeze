import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthGrants } from '../db/schema';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('./partnerScopePolicy', () => ({
  getPartnerScopePolicy: vi.fn(),
}));

// Deliberately still mocked even though effectiveScopes.ts no longer imports it:
// the point of the durable-grant fix is that a WARM process-local cache must not
// be able to answer a tenancy question. If the fast path ever comes back, this
// primed cache is what it would read.
vi.mock('./adapter', () => ({
  getGrantBreezeMeta: vi.fn(),
}));

import { getGrantBreezeMeta } from './adapter';
import { getPartnerScopePolicy } from './partnerScopePolicy';
import {
  ALL_MCP_SCOPES,
  computeEffectiveMcpScopes,
  GrantTenancyError,
  resolveGrantContext,
} from './effectiveScopes';

const selectMock = vi.mocked(db.select);
const getGrantBreezeMetaMock = vi.mocked(getGrantBreezeMeta);
const getPartnerScopePolicyMock = vi.mocked(getPartnerScopePolicy);

/**
 * Collect the qualified column names a drizzle `where` clause actually
 * references. Asserting on the columns (not on a stringified predicate) keeps
 * this independent of drizzle's SQL rendering and of any enum/param values that
 * a naive deep string search would false-positive on.
 */
function whereColumnNames(clause: unknown): string[] {
  const names: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      chunks.forEach(visit);
      return;
    }
    const { name, table } = node as { name?: unknown; table?: unknown };
    if (typeof name === 'string' && table) names.push(name);
  };
  visit(clause);
  return names;
}

function mockSelectRow(row: unknown) {
  const limit = vi.fn(async () => (row === undefined ? [] : [row]));
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  selectMock.mockReturnValueOnce({ from } as unknown as ReturnType<typeof db.select>);
  return { from, where, limit };
}

function mockSelectError(err: unknown) {
  const limit = vi.fn(async () => {
    throw err;
  });
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  selectMock.mockReturnValueOnce({ from } as unknown as ReturnType<typeof db.select>);
}

beforeEach(() => {
  vi.clearAllMocks();
  getGrantBreezeMetaMock.mockReturnValue(undefined);
  getPartnerScopePolicyMock.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveGrantContext', () => {
  it('ignores warm process-local tenancy metadata and answers from the durable row', async () => {
    // A stale in-memory entry survives its Grant's revoked_at transition, so it
    // must never short-circuit the lookup. Prime it with DIFFERENT tenancy than
    // the DB row: whichever one comes back tells us which path ran.
    getGrantBreezeMetaMock.mockReturnValue({ partner_id: 'stale-cached-partner', org_id: 'stale-cached-org' });
    mockSelectRow({ partnerId: 'partner-1', orgId: 'org-1' });

    const context = await resolveGrantContext('grant-1');

    expect(context).toEqual({ grantId: 'grant-1', partnerId: 'partner-1', orgId: 'org-1' });
    expect(selectMock).toHaveBeenCalledOnce();
  });

  it('cache miss: loads the oauth_grants row and returns its durable tenancy', async () => {
    mockSelectRow({ partnerId: 'partner-2', orgId: null });

    const context = await resolveGrantContext('grant-2');

    expect(context).toEqual({ grantId: 'grant-2', partnerId: 'partner-2', orgId: null });
    expect(selectMock).toHaveBeenCalledWith({ partnerId: oauthGrants.partnerId, orgId: oauthGrants.orgId });
  });

  it('cache miss + grant row does not exist: returns null (not a tenancy failure)', async () => {
    mockSelectRow(undefined);

    const context = await resolveGrantContext('grant-missing');

    expect(context).toBeNull();
  });

  it('constrains the lookup to unrevoked, unexpired Grants (revoked rows never match)', async () => {
    const { where } = mockSelectRow(undefined);

    await expect(resolveGrantContext('grant-revoked')).resolves.toBeNull();

    const columns = whereColumnNames((where.mock.calls as unknown as unknown[][])[0]?.[0]);
    expect(columns).toContain(oauthGrants.id.name);
    expect(columns).toContain(oauthGrants.revokedAt.name);
    expect(columns).toContain(oauthGrants.expiresAt.name);
  });

  it('cache miss + row exists with NULL partnerId: throws GrantTenancyError (fail closed — the -02 bug)', async () => {
    mockSelectRow({ partnerId: null, orgId: null });

    await expect(resolveGrantContext('grant-orphaned')).rejects.toThrow(GrantTenancyError);
  });

  it('propagates a DB lookup failure rather than falling back to null (fail closed)', async () => {
    const dbErr = new Error('connection refused');
    mockSelectError(dbErr);

    await expect(resolveGrantContext('grant-3')).rejects.toBe(dbErr);
  });

  it('exits request DB context before opening system DB context (mirrors adapter.ts convention)', async () => {
    mockSelectRow({ partnerId: 'partner-4', orgId: null });

    await resolveGrantContext('grant-4');

    expect(runOutsideDbContext).toHaveBeenCalled();
    expect(withSystemDbAccessContext).toHaveBeenCalled();
  });
});

describe('computeEffectiveMcpScopes', () => {
  it('reduces the requested set to a read-only partner policy', async () => {
    getPartnerScopePolicyMock.mockResolvedValue({ mcp_allowed_scopes: ['mcp:read'] });

    const scopes = await computeEffectiveMcpScopes({
      requested: ['mcp:read', 'mcp:write', 'mcp:execute'],
      partnerId: 'partner-readonly',
      hasGrant: true,
    });

    expect(scopes).toEqual(['mcp:read']);
  });

  it('throws when a grant is present but partnerId is null (fail closed, cannot escape to all scopes)', async () => {
    await expect(
      computeEffectiveMcpScopes({
        requested: [...ALL_MCP_SCOPES],
        partnerId: null,
        hasGrant: true,
      }),
    ).rejects.toThrow(GrantTenancyError);
    expect(getPartnerScopePolicyMock).not.toHaveBeenCalled();
  });

  it('grantless client-only flow with no resolvable partner keeps all requested scopes (documented legacy behavior)', async () => {
    const scopes = await computeEffectiveMcpScopes({
      requested: [...ALL_MCP_SCOPES],
      partnerId: null,
      hasGrant: false,
    });

    expect(scopes).toEqual([...ALL_MCP_SCOPES]);
    expect(getPartnerScopePolicyMock).not.toHaveBeenCalled();
  });

  it('propagates a partner policy lookup failure instead of falling back to a scope set (fail closed)', async () => {
    const err = new Error('policy lookup exploded');
    getPartnerScopePolicyMock.mockRejectedValue(err);

    await expect(
      computeEffectiveMcpScopes({
        requested: [...ALL_MCP_SCOPES],
        partnerId: 'partner-5',
        hasGrant: true,
      }),
    ).rejects.toBe(err);
  });

  it('further intersects with an explicit displayed set', async () => {
    getPartnerScopePolicyMock.mockResolvedValue({}); // no partner policy narrowing

    const scopes = await computeEffectiveMcpScopes({
      requested: ['mcp:read', 'mcp:write', 'mcp:execute'],
      displayed: ['mcp:read', 'mcp:write'],
      partnerId: 'partner-6',
      hasGrant: true,
    });

    expect(scopes).toEqual(['mcp:read', 'mcp:write']);
  });

  it('applies both the displayed set and the partner policy together', async () => {
    getPartnerScopePolicyMock.mockResolvedValue({ mcp_allowed_scopes: ['mcp:read', 'mcp:write'] });

    const scopes = await computeEffectiveMcpScopes({
      requested: ['mcp:read', 'mcp:write', 'mcp:execute'],
      displayed: ['mcp:write', 'mcp:execute'],
      partnerId: 'partner-7',
      hasGrant: true,
    });

    // requested ∩ displayed = {mcp:write, mcp:execute}; ∩ policy {read,write} = {mcp:write}
    expect(scopes).toEqual(['mcp:write']);
  });

  it('ignores scopes outside the requested set even when the partner policy allows them', async () => {
    getPartnerScopePolicyMock.mockResolvedValue({ mcp_allowed_scopes: ['mcp:read', 'mcp:write', 'mcp:execute'] });

    const scopes = await computeEffectiveMcpScopes({
      requested: ['mcp:read'],
      partnerId: 'partner-8',
      hasGrant: true,
    });

    expect(scopes).toEqual(['mcp:read']);
  });

  it('never returns a scope outside ALL_MCP_SCOPES even if requested/displayed/policy all claim it', async () => {
    getPartnerScopePolicyMock.mockResolvedValue({ mcp_allowed_scopes: ['mcp:read', 'bogus:scope'] });

    const scopes = await computeEffectiveMcpScopes({
      requested: ['mcp:read', 'bogus:scope'],
      partnerId: 'partner-9',
      hasGrant: true,
    });

    expect(scopes).toEqual(['mcp:read']);
  });
});
