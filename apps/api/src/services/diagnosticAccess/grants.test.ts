import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {}, runOutsideDbContext: vi.fn(), withSystemDbAccessContext: vi.fn() }));
vi.mock('../auditService', () => ({ createAuditLog: vi.fn() }));
vi.mock('../expoPush', () => ({ dispatchApprovalPushToTokens: vi.fn(), getUserPushTokens: vi.fn() }));
vi.mock('../usersWithPermission', () => ({ resolveUsersWithPermissionForOrg: vi.fn() }));

import type { AuthContext } from '../../middleware/auth';
import { beneficiaryOf, evaluateGrantCoverage, scopesCover, validateRequestedScope, type GrantRow } from './grants';

const NOW = new Date('2026-09-28T17:00:00Z');
const DEVICE = { id: 'dev-1', orgId: 'org-1', osType: 'windows' as const };

// The two locations from the original report that the default AI path
// restriction refused ("Access to this path is blocked").
const GEFORCE = 'C:\\Users\\Alice\\AppData\\Local\\NVIDIA Corporation\\GeForceNOW';
const BATTLENET = 'C:\\Users\\Alice\\AppData\\Local\\Battle.net\\Logs';

function grant(over: Partial<GrantRow> = {}): GrantRow {
  return {
    id: 'g1',
    orgId: 'org-1',
    deviceId: 'dev-1',
    status: 'active',
    operations: ['list', 'read'],
    scopes: [
      { path: BATTLENET, recursive: true },
      { path: GEFORCE, recursive: false },
    ],
    sensitiveClasses: [],
    approvedByUserId: 'approver-1',
    approvedAt: new Date(NOW.getTime() - 60_000),
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
    ...over,
  } as GrantRow;
}

describe('validateRequestedScope', () => {
  it('accepts the previously blocked AppData locations as requestable scopes', () => {
    expect(validateRequestedScope({ path: GEFORCE, recursive: true }, DEVICE, new Set())).toBeNull();
    expect(validateRequestedScope({ path: BATTLENET, recursive: true }, DEVICE, new Set())).toBeNull();
  });

  it('rejects traversal, relative and wrong-platform forms', () => {
    expect(validateRequestedScope({ path: 'C:\\Users\\..\\Windows', recursive: true }, DEVICE, new Set())).not.toBeNull();
    expect(validateRequestedScope({ path: 'Users\\Alice', recursive: true }, DEVICE, new Set())).not.toBeNull();
    expect(validateRequestedScope({ path: '/var/log', recursive: true }, DEVICE, new Set())).toMatch(/Windows device/);
    expect(validateRequestedScope({ path: 'C:\\Temp', recursive: true }, { osType: 'linux' }, new Set())).toMatch(/not a Windows/);
  });

  it('never allows virtual filesystems or the agent configuration', () => {
    expect(validateRequestedScope({ path: '/proc/1', recursive: false }, { osType: 'linux' }, new Set())).toMatch(/never available/);
    expect(validateRequestedScope({ path: '/sys', recursive: true }, { osType: 'linux' }, new Set())).toMatch(/never available/);
  });

  it('refuses volume roots and scopes shallower than two levels', () => {
    for (const path of ['C:\\', 'D:\\', 'C:\\Users', 'C:\\Windows\\']) {
      expect(validateRequestedScope({ path, recursive: true }, DEVICE, new Set())).toMatch(/too broad/);
    }
    for (const path of ['/', '/home', '/var/']) {
      expect(validateRequestedScope({ path, recursive: false }, { osType: 'linux' }, new Set())).toMatch(/too broad/);
    }
    expect(validateRequestedScope({ path: 'C:\\ProgramData\\Vendor', recursive: true }, DEVICE, new Set())).toBeNull();
    expect(validateRequestedScope({ path: '/var/log', recursive: true }, { osType: 'linux' }, new Set())).toBeNull();
  });

  it('requires a sensitive store to be named explicitly', () => {
    const cookies = 'C:\\Users\\Alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Network\\Cookies';
    expect(validateRequestedScope({ path: cookies, recursive: false }, DEVICE, new Set())).toMatch(/browser_secrets/);
    expect(validateRequestedScope({ path: cookies, recursive: false }, DEVICE, new Set(['browser_secrets']))).toBeNull();
  });
});

describe('scopesCover', () => {
  it('recursive root covers the whole subtree, case-insensitively on Windows', () => {
    expect(scopesCover(grant().scopes, `${BATTLENET}\\Agent\\agent.log`, 'read', true)).toBe(true);
    expect(scopesCover(grant().scopes, BATTLENET.toLowerCase(), 'list', true)).toBe(true);
  });

  it('non-recursive root lists itself and reads only direct children', () => {
    const scopes = grant().scopes;
    expect(scopesCover(scopes, GEFORCE, 'list', true)).toBe(true);
    expect(scopesCover(scopes, `${GEFORCE}\\sessions.log`, 'read', true)).toBe(true);
    expect(scopesCover(scopes, `${GEFORCE}\\Sub`, 'list', true)).toBe(false);
    expect(scopesCover(scopes, `${GEFORCE}\\Sub\\x.log`, 'read', true)).toBe(false);
  });

  it('a sibling that shares a prefix is out of scope', () => {
    expect(scopesCover(grant().scopes, `${BATTLENET}Evil\\x.log`, 'read', true)).toBe(false);
    expect(scopesCover(grant().scopes, 'C:\\Users\\Alice\\AppData\\Local\\Battle.net', 'list', true)).toBe(false);
  });

  it('is case-sensitive on Linux', () => {
    const scopes = [{ path: '/var/log/app', recursive: true }];
    expect(scopesCover(scopes, '/var/log/app/a.log', 'read', false)).toBe(true);
    expect(scopesCover(scopes, '/var/log/APP/a.log', 'read', false)).toBe(false);
  });
});

describe('evaluateGrantCoverage', () => {
  const read = (g: GrantRow, path: string, device = DEVICE, op: 'list' | 'read' = 'read') =>
    evaluateGrantCoverage(g, device, path, op, NOW);

  it('authorizes an in-scope read', () => {
    expect(read(grant(), `${BATTLENET}\\Agent.log`)).toMatchObject({ ok: true });
  });

  it.each([
    ['wrong device', grant(), { ...DEVICE, id: 'dev-2' }, 'no_grant'],
    ['cross-org', grant(), { ...DEVICE, orgId: 'org-2' }, 'no_grant'],
    ['pending', grant({ status: 'pending_approval' }), DEVICE, 'grant_pending'],
    ['revoked', grant({ status: 'revoked' }), DEVICE, 'grant_revoked'],
    ['denied', grant({ status: 'denied' }), DEVICE, 'grant_expired'],
    ['expired by clock', grant({ expiresAt: new Date(NOW.getTime() - 1) }), DEVICE, 'grant_expired'],
    ['operation not granted', grant({ operations: ['list'] }), DEVICE, 'operation_not_granted'],
  ])('denies: %s', (_label, g, device, reason) => {
    expect(read(g, `${BATTLENET}\\Agent.log`, device)).toMatchObject({ ok: false, reason });
  });

  it('denies out-of-scope, traversal and sensitive paths', () => {
    expect(read(grant(), 'C:\\Users\\Alice\\Documents\\taxes.pdf')).toMatchObject({ ok: false, reason: 'out_of_scope' });
    expect(read(grant(), `${BATTLENET}\\..\\..\\Google\\x`)).toMatchObject({ ok: false, reason: 'invalid_path' });
    const wide = grant({ scopes: [{ path: 'C:\\Users\\Alice\\AppData\\Local', recursive: true }] });
    expect(read(wide, 'C:\\Users\\Alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data')).toMatchObject({
      ok: false,
      reason: 'sensitive_not_granted',
    });
  });
});

describe('beneficiaryOf', () => {
  const ctx = (principal: Record<string, unknown>, userId = 'u1') =>
    ({ principal, user: { id: userId } }) as unknown as AuthContext;

  it('binds to the exact requesting principal', () => {
    expect(beneficiaryOf(ctx({ kind: 'user_session' }))).toEqual({ kind: 'user', id: 'u1' });
    expect(beneficiaryOf(ctx({ kind: 'api_key', apiKeyId: 'k1' }))).toEqual({ kind: 'api_key', id: 'k1' });
    expect(beneficiaryOf(ctx({ kind: 'oauth_grant', grantId: 'o1' }))).toEqual({ kind: 'oauth_grant', id: 'o1' });
  });

  it('never grants an AI operator agent or other machine principal', () => {
    expect(beneficiaryOf(ctx({ kind: 'ai_agent' }))).toBeNull();
    expect(beneficiaryOf(ctx({ kind: 'api_key' }))).toBeNull();
  });
});
