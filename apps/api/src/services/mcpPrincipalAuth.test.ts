import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// B-W04 (#6158, D-B26): an `mcp_api` intent is released under a context
// rebuilt from the LIVE origin credential by the same function the MCP call
// used (buildAuthFromApiKey) — never the widened user-owned rebuild.

const { tables, dbState, mocks } = vi.hoisted(() => {
  const col = (name: string) => ({ name });
  const apiKeys = {
    id: col('id'), orgId: col('org_id'), name: col('name'), scopes: col('scopes'), expiresAt: col('expires_at'),
    createdBy: col('created_by'), status: col('status'), source: col('source'), principalType: col('principal_type'),
    principalId: col('principal_id'), creatorAuthEpoch: col('creator_auth_epoch'), creatorMfaEpoch: col('creator_mfa_epoch'),
    creatorCredentialEpoch: col('creator_credential_epoch'), mcpDomains: col('mcp_domains'),
  };
  const users = {
    id: col('id'), status: col('status'), authEpoch: col('auth_epoch'), mfaEpoch: col('mfa_epoch'),
    credentialEpoch: col('credential_epoch'),
  };
  const oauthGrants = {
    id: col('id'), accountId: col('account_id'), clientId: col('client_id'), partnerId: col('partner_id'),
    orgId: col('org_id'), payload: col('payload'), mcpDomains: col('mcp_domains'),
  };
  const oauthClients = { id: col('id'), disabledAt: col('disabled_at') };
  return {
    tables: { apiKeys, users, oauthGrants, oauthClients },
    dbState: { rows: new Map<unknown, unknown[][]>() },
    mocks: {
      getUserPermissions: vi.fn(),
      authorizeHumanApiKeyCreator: vi.fn(),
      authorizeServicePrincipalKey: vi.fn(),
      getActiveOrgTenant: vi.fn(),
      assertActiveTenantContext: vi.fn(),
      resolvePartnerAccessibleOrgIds: vi.fn(),
      filterBlockedOAuthClientOrgIds: vi.fn(),
      isGrantRevoked: vi.fn(),
      computeEffectiveMcpScopes: vi.fn(),
      hasSatisfiedMfa: vi.fn(),
    },
  };
});

function queue(table: unknown, ...results: unknown[][]) {
  dbState.rows.set(table, [...(dbState.rows.get(table) ?? []), ...results]);
}

vi.mock('../db', () => {
  const take = (table: unknown) => Promise.resolve(dbState.rows.get(table)?.shift() ?? []);
  const chain = (table: unknown) => {
    const p: Record<string, unknown> = {};
    p.where = () => p;
    p.limit = () => take(table);
    return p;
  };
  return {
    db: { select: () => ({ from: (t: unknown) => chain(t) }) },
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  };
});
vi.mock('../db/schema/apiKeys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/schema/apiKeys')>()), apiKeys: tables.apiKeys,
}));
vi.mock('../db/schema/users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/schema/users')>()), users: tables.users,
}));
vi.mock('../db/schema/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/schema/oauth')>()), oauthGrants: tables.oauthGrants, oauthClients: tables.oauthClients,
}));
vi.mock('../middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/auth')>()), hasSatisfiedMfa: mocks.hasSatisfiedMfa,
}));
vi.mock('../oauth/grantStatus', () => ({ activeGrantCondition: vi.fn(() => ({ op: 'activeGrant' })) }));
vi.mock('../oauth/revocationCache', () => ({ isGrantRevoked: mocks.isGrantRevoked }));
vi.mock('../oauth/effectiveScopes', () => ({ computeEffectiveMcpScopes: mocks.computeEffectiveMcpScopes }));
vi.mock('./permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./permissions')>()), getUserPermissions: mocks.getUserPermissions,
}));
vi.mock('./apiKeyAuthorization', () => ({
  authorizeHumanApiKeyCreator: mocks.authorizeHumanApiKeyCreator,
  authorizeServicePrincipalKey: mocks.authorizeServicePrincipalKey,
}));
vi.mock('./tenantStatus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tenantStatus')>();
  return { ...actual, getActiveOrgTenant: mocks.getActiveOrgTenant, assertActiveTenantContext: mocks.assertActiveTenantContext };
});
vi.mock('../middleware/bearerTokenAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/bearerTokenAuth')>();
  return {
    ...actual,
    resolvePartnerAccessibleOrgIds: mocks.resolvePartnerAccessibleOrgIds,
    filterBlockedOAuthClientOrgIds: mocks.filterBlockedOAuthClientOrgIds,
  };
});

import {
  rebuildMcpOriginAuthContext,
  checkMcpOriginReleaseAuthority,
  loadLiveMcpOriginCredential,
} from './mcpPrincipalAuth';
import { TenantInactiveError } from './tenantStatus';
import type { ActionIntent } from '../db/schema/actionIntents';

const KEY_ID = '11111111-1111-4111-8111-111111111111';
const GRANT_ID = 'grant-abc';
const USER = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const OTHER_ORG = '44444444-4444-4444-8444-444444444444';
const PARTNER = '55555555-5555-4555-8555-555555555555';

function intent(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    id: 'intent-1', orgId: ORG, partnerId: PARTNER, requestedByUserId: USER, requestingApiKeyId: null,
    requestingAgentRunId: null, source: 'mcp_api', originPrincipalKind: 'api_key', originPrincipalId: KEY_ID,
    actionName: 'execute_command', arguments: { deviceId: 'd1', command: 'whoami' }, status: 'executing',
    ...overrides,
  } as ActionIntent;
}

function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID, orgId: ORG, name: 'ci key', scopes: ['ai:read', 'ai:write', 'ai:execute'], expiresAt: null,
    createdBy: USER, status: 'active', source: 'manual', principalType: 'human', principalId: null,
    creatorAuthEpoch: 1, creatorMfaEpoch: 1, creatorCredentialEpoch: 1, mcpDomains: null,
    ...overrides,
  };
}
const liveUser = (overrides: Record<string, unknown> = {}) => ({ id: USER, status: 'active', authEpoch: 1, mfaEpoch: 1, credentialEpoch: 1, ...overrides });

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: GRANT_ID, accountId: USER, clientId: 'client-1', partnerId: PARTNER, orgId: null,
    payload: { resources: { 'https://app.example.com/api/v1/mcp': 'mcp:read mcp:write mcp:execute' } },
    mcpDomains: null, ...overrides,
  };
}

const okAuthz = (scopes: string[]) => ({ ok: true, permissions: {}, allowedSiteIds: undefined, clampedScopes: scopes });

beforeEach(() => {
  vi.clearAllMocks();
  dbState.rows.clear();
  process.env.MCP_TIER3_INTENTS_ENABLED = 'true';
  process.env.OAUTH_RESOURCE_URL = 'https://app.example.com/api/v1/mcp';
  mocks.getActiveOrgTenant.mockResolvedValue({ orgId: ORG, partnerId: PARTNER });
  mocks.authorizeHumanApiKeyCreator.mockImplementation(async ({ scopes }: { scopes: string[] }) => okAuthz(scopes));
  mocks.getUserPermissions.mockResolvedValue({ permissions: [], scope: 'partner' });
  mocks.resolvePartnerAccessibleOrgIds.mockResolvedValue([ORG, OTHER_ORG]);
  mocks.filterBlockedOAuthClientOrgIds.mockImplementation(async (ids: string[]) => ids);
  mocks.isGrantRevoked.mockResolvedValue(false);
  mocks.hasSatisfiedMfa.mockReturnValue(true);
  mocks.assertActiveTenantContext.mockResolvedValue(undefined);
  mocks.computeEffectiveMcpScopes.mockImplementation(async ({ requested }: { requested: string[] }) =>
    requested.filter((s) => s.startsWith('mcp:')));
});

afterEach(() => {
  delete process.env.MCP_TIER3_INTENTS_ENABLED;
});

function seedKey(row = keyRow(), user = liveUser()) {
  queue(tables.apiKeys, [row]);
  queue(tables.users, [user]);
}

describe('rebuildMcpOriginAuthContext — api_key origin', () => {
  it('rebuilds through buildAuthFromApiKey: org pin, token {} (no synthetic MFA), live clamped scopes', async () => {
    seedKey();
    const rebuilt = await rebuildMcpOriginAuthContext(intent());
    if ('error' in rebuilt) throw new Error(`unexpected ${rebuilt.error}`);
    expect(rebuilt.auth.accessibleOrgIds).toEqual([ORG]);
    expect(rebuilt.auth.token).toEqual({});
    expect((rebuilt.auth.token as { mfa?: unknown }).mfa).toBeUndefined();
    expect(rebuilt.auth.principal).toEqual({ kind: 'api_key', apiKeyId: KEY_ID });
    expect(rebuilt.credential.scopes).toEqual(['ai:read', 'ai:write', 'ai:execute']);
    expect(rebuilt.credential.humanUserId).toBe(USER);
  });

  it('release never widens an org-pinned key to targetOrgId (partner-wide creator, manage_tickets move_org)', async () => {
    seedKey();
    const moveIntent = intent({
      actionName: 'manage_tickets',
      arguments: { action: 'move_org', ticketId: 't1', targetOrgId: OTHER_ORG },
    });
    const rebuilt = await rebuildMcpOriginAuthContext(moveIntent);
    if ('error' in rebuilt) throw new Error(`unexpected ${rebuilt.error}`);
    expect(rebuilt.auth.canAccessOrg(OTHER_ORG)).toBe(false);
    expect(checkMcpOriginReleaseAuthority(moveIntent, rebuilt)).toEqual({ ok: false, errorCode: 'mcp_org_out_of_scope' });
  });

  it.each([
    ['key revoked', () => seedKey(keyRow({ status: 'revoked' }))],
    ['key expired', () => seedKey(keyRow({ expiresAt: new Date(Date.now() - 1000) }))],
    ['key row gone', () => { queue(tables.apiKeys, []); }],
    ['credential epoch bumped', () => seedKey(keyRow(), liveUser({ credentialEpoch: 2 }))],
    ['mfa epoch bumped', () => seedKey(keyRow(), liveUser({ mfaEpoch: 2 }))],
    ['pre-credential-epoch key, auth epoch bumped', () => seedKey(keyRow({ creatorCredentialEpoch: null }), liveUser({ authEpoch: 2 }))],
    ['creator disabled', () => seedKey(keyRow(), liveUser({ status: 'disabled' }))],
    ['pre-epoch key (NULL snapshots), creator disabled', () => seedKey(
      keyRow({ creatorAuthEpoch: null, creatorMfaEpoch: null, creatorCredentialEpoch: null }), liveUser({ status: 'disabled' }),
    )],
    ['creator row gone', () => { queue(tables.apiKeys, [keyRow()]); queue(tables.users, []); }],
    ['creator != requested_by_user_id', () => seedKey(keyRow({ createdBy: '99999999-9999-4999-8999-999999999999' }))],
    ['org service-principal key', () => seedKey(keyRow({ principalType: 'service', principalId: 'sp-1' }))],
    ['owning org inactive', () => { seedKey(); mocks.getActiveOrgTenant.mockResolvedValue(null); }],
    ['creator lost membership', () => { seedKey(); mocks.authorizeHumanApiKeyCreator.mockResolvedValue({ ok: false, reason: 'no_membership' }); }],
  ])('release refuses when the origin credential changed after creation: %s → mcp_origin_revoked', async (_label, seed) => {
    seed();
    expect(await rebuildMcpOriginAuthContext(intent())).toEqual({ error: 'mcp_origin_revoked' });
  });

  it('a pre-epoch key with NULL snapshots and a live creator is not epoch-checked', async () => {
    seedKey(keyRow({ creatorAuthEpoch: null, creatorMfaEpoch: null, creatorCredentialEpoch: null }), liveUser({ authEpoch: 9, mfaEpoch: 9, credentialEpoch: 9 }));
    const rebuilt = await rebuildMcpOriginAuthContext(intent());
    expect('error' in rebuilt).toBe(false);
  });

  it('delegation no longer backed by the creator → mcp_scope_lost', async () => {
    seedKey();
    mocks.authorizeHumanApiKeyCreator.mockResolvedValue({ ok: false, reason: 'scope_exceeds_current_permissions' });
    expect(await rebuildMcpOriginAuthContext(intent())).toEqual({ error: 'mcp_scope_lost' });
  });

  it('non-MCP-origin intents never reach the origin rebuild (fail closed if called)', async () => {
    for (const i of [
      intent({ source: 'chat', originPrincipalKind: 'user_session', originPrincipalId: null }),
      intent({ source: 'mcp_api', originPrincipalKind: 'user_session', originPrincipalId: null }),
      intent({ source: 'ai_agent', originPrincipalKind: 'agent', originPrincipalId: 'agent-1' }),
    ]) {
      expect(await rebuildMcpOriginAuthContext(i)).toEqual({ error: 'mcp_origin_revoked' });
    }
    expect(mocks.authorizeHumanApiKeyCreator).not.toHaveBeenCalled();
  });
});

describe('rebuildMcpOriginAuthContext — oauth_grant origin', () => {
  const oauthIntent = (o: Partial<ActionIntent> = {}) => intent({ originPrincipalKind: 'oauth_grant', originPrincipalId: GRANT_ID, ...o });
  function seedGrant(g = grantRow(), user = liveUser(), client: Record<string, unknown> | null = { id: 'client-1', disabledAt: null }) {
    queue(tables.oauthGrants, [g]);
    queue(tables.users, [user]);
    queue(tables.oauthClients, client ? [client] : []);
  }

  it('builds the key input from the grant row and expands mcp:* → ai:* before the ai:execute check', async () => {
    seedGrant();
    const rebuilt = await rebuildMcpOriginAuthContext(oauthIntent());
    if ('error' in rebuilt) throw new Error(`unexpected ${rebuilt.error}`);
    expect(rebuilt.credential.keyInput).toMatchObject({
      id: `oauth:grant:${GRANT_ID}`, orgId: null, partnerId: PARTNER, createdBy: USER, name: 'OAuth bearer', oauthGrantId: GRANT_ID,
    });
    expect(rebuilt.credential.scopes).toEqual(expect.arrayContaining(['ai:read', 'ai:write', 'ai:execute']));
    expect(rebuilt.auth.principal).toEqual({ kind: 'oauth_grant', grantId: GRANT_ID });
    expect(rebuilt.auth.token).toEqual({});
    expect(checkMcpOriginReleaseAuthority(oauthIntent(), rebuilt)).toEqual({ ok: true });
  });

  it('a grant without mcp:execute → mcp_scope_lost at the authority check', async () => {
    seedGrant(grantRow({ payload: { resources: { 'https://app.example.com/api/v1/mcp': 'mcp:read mcp:write' } } }));
    const rebuilt = await rebuildMcpOriginAuthContext(oauthIntent());
    if ('error' in rebuilt) throw new Error(`unexpected ${rebuilt.error}`);
    expect(checkMcpOriginReleaseAuthority(oauthIntent(), rebuilt)).toEqual({ ok: false, errorCode: 'mcp_scope_lost' });
  });

  it.each([
    ['revoked or expired grant', () => { queue(tables.oauthGrants, []); }],
    ['grant user != requester', () => seedGrant(grantRow({ accountId: '99999999-9999-4999-8999-999999999999' }))],
    ['grant user disabled', () => seedGrant(grantRow(), liveUser({ status: 'disabled' }))],
    ['client disabled', () => seedGrant(grantRow(), liveUser(), { id: 'client-1', disabledAt: new Date() })],
    ['client gone', () => seedGrant(grantRow(), liveUser(), null)],
    ['client blocked for the intent org', () => { seedGrant(); mocks.filterBlockedOAuthClientOrgIds.mockResolvedValue([]); }],
    ['partner inactive', () => { seedGrant(); mocks.assertActiveTenantContext.mockRejectedValue(new TenantInactiveError('Partner is not active')); }],
    ['grant has no partner', () => seedGrant(grantRow({ partnerId: null }))],
    ['Redis revocation marker set', () => { seedGrant(); mocks.isGrantRevoked.mockResolvedValue(true); }],
  ])('%s → mcp_origin_revoked', async (_label, seed) => {
    seed();
    expect(await rebuildMcpOriginAuthContext(oauthIntent())).toEqual({ error: 'mcp_origin_revoked' });
  });

  it('partner inactive is checked strictly (strictForOauth), as on the bearer path', async () => {
    seedGrant();
    await rebuildMcpOriginAuthContext(oauthIntent());
    expect(mocks.assertActiveTenantContext).toHaveBeenCalledWith(
      { scope: 'partner', partnerId: PARTNER, orgId: null }, { strictForOauth: true },
    );
  });
});

describe('checkMcpOriginReleaseAuthority', () => {
  async function rebuiltKey(row = keyRow()) {
    seedKey(row);
    const rebuilt = await rebuildMcpOriginAuthContext(intent());
    if ('error' in rebuilt) throw new Error(`unexpected ${rebuilt.error}`);
    return rebuilt;
  }

  it('passes for a live key with ai:execute and an unrestricted domain grant', async () => {
    expect(checkMcpOriginReleaseAuthority(intent(), await rebuiltKey())).toEqual({ ok: true });
  });

  it('ai:execute removed → mcp_scope_lost', async () => {
    expect(checkMcpOriginReleaseAuthority(intent(), await rebuiltKey(keyRow({ scopes: ['ai:read', 'ai:write'] }))))
      .toEqual({ ok: false, errorCode: 'mcp_scope_lost' });
  });

  it('mcp_domains narrowed → mcp_domain_lost', async () => {
    expect(checkMcpOriginReleaseAuthority(intent(), await rebuiltKey(keyRow({ mcpDomains: ['core', 'tickets'] }))))
      .toEqual({ ok: false, errorCode: 'mcp_domain_lost' });
  });

  it('flag off → mcp_intents_disabled', async () => {
    const rebuilt = await rebuiltKey();
    process.env.MCP_TIER3_INTENTS_ENABLED = 'false';
    expect(checkMcpOriginReleaseAuthority(intent(), rebuilt)).toEqual({ ok: false, errorCode: 'mcp_intents_disabled' });
  });

  it('intent org outside the rebuilt accessibleOrgIds → mcp_org_out_of_scope', async () => {
    const rebuilt = await rebuiltKey();
    expect(checkMcpOriginReleaseAuthority(intent({ orgId: OTHER_ORG }), rebuilt))
      .toEqual({ ok: false, errorCode: 'mcp_org_out_of_scope' });
  });

  it('an MFA-gated action for a caller without MFA → mcp_mfa_required', async () => {
    const rebuilt = await rebuiltKey();
    mocks.hasSatisfiedMfa.mockReturnValue(false);
    expect(checkMcpOriginReleaseAuthority(intent({ actionName: 'apply_configuration_policy', arguments: {} }), rebuilt))
      .toEqual({ ok: false, errorCode: 'mcp_mfa_required' });
  });

  it('production: allowlist drops the tool → mcp_tool_not_allowed; missing ai:execute_admin → mcp_scope_lost', async () => {
    vi.resetModules();
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.MCP_EXECUTE_TOOL_ALLOWLIST = 'manage_quotes';
    try {
      const mod = await import('./mcpPrincipalAuth');
      seedKey(keyRow({ scopes: ['ai:read', 'ai:write', 'ai:execute', 'ai:execute_admin'] }));
      const rebuilt = await mod.rebuildMcpOriginAuthContext(intent());
      if ('error' in rebuilt) throw new Error(`unexpected ${rebuilt.error}`);
      expect(mod.checkMcpOriginReleaseAuthority(intent(), rebuilt)).toEqual({ ok: false, errorCode: 'mcp_tool_not_allowed' });
      seedKey();
      const noAdmin = await mod.rebuildMcpOriginAuthContext(intent({ actionName: 'manage_quotes', arguments: {} }));
      if ('error' in noAdmin) throw new Error(`unexpected ${noAdmin.error}`);
      expect(mod.checkMcpOriginReleaseAuthority(intent({ actionName: 'manage_quotes', arguments: {} }), noAdmin))
        .toEqual({ ok: false, errorCode: 'mcp_scope_lost' });
    } finally {
      process.env.NODE_ENV = prevEnv;
      delete process.env.MCP_EXECUTE_TOOL_ALLOWLIST;
    }
  }, 60_000); // re-imports the module graph under production env
});

describe('loadLiveMcpOriginCredential', () => {
  it('reports the domain grant from the live row', async () => {
    seedKey(keyRow({ mcpDomains: ['core', 'devices'] }));
    const cred = await loadLiveMcpOriginCredential(intent());
    if ('error' in cred) throw new Error('unexpected');
    expect(cred.domainGrant.restricted).toBe(true);
    expect(cred.kind).toBe('api_key');
  });
});
