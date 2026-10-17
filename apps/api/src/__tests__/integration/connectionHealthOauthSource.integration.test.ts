/**
 * Connection health OAuth grant source (spec 2026-10-15 §3). observe() runs in
 * the reconciler's system context, so every call here goes through asSystem.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { oauthClients, oauthGrants } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { oauthGrantSource, cleanDisplayName, brokenCandidatesQuery } from '../../services/connectionHealth/sources/oauthGrant';
import { HEALTH_SOURCES } from '../../services/connectionHealth/sources';

const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const asSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

type Seed = {
  id?: string; accountId?: string; clientId?: string; partnerId?: string | null; orgId?: string;
  createdAt?: Date; expiresAt?: Date; revokedAt?: Date | null; revokedReason?: string | null;
  revokedByUserId?: string; clientName?: string; clientDisabledAt?: Date;
};

async function seedUser(partnerId: string): Promise<string> {
  return (await createUser({ partnerId, email: `ch-oauth-${randomUUID()}@example.test` })).id;
}

async function seedGrant(over: Seed = {}) {
  const partnerId = over.partnerId === undefined ? (await createPartner()).id : over.partnerId;
  const accountId = over.accountId ?? (await seedUser(partnerId ?? (await createPartner()).id));
  const clientId = over.clientId ?? `client-${randomUUID()}`;
  const createdAt = over.createdAt ?? daysAgo(5);
  await asSystem(async () => {
    await db.insert(oauthClients).values({
      id: clientId, partnerId: null, metadata: { client_name: over.clientName ?? 'Test MCP Client' },
      disabledAt: over.clientDisabledAt ?? null,
    }).onConflictDoNothing();
    await db.insert(oauthGrants).values({
      id: over.id ?? randomUUID(), accountId, clientId, partnerId, orgId: over.orgId ?? null, payload: {},
      createdAt, expiresAt: over.expiresAt ?? new Date(createdAt.getTime() + 14 * 86_400_000),
      revokedAt: over.revokedAt ?? null, revokedReason: over.revokedReason ?? null,
      revokedByUserId: over.revokedByUserId ?? null,
    });
  });
  return { accountId, clientId, partnerId: partnerId as string };
}

// Another grant for an existing pair (same account, client and partner).
const sibling = (g: { accountId: string; clientId: string; partnerId: string }, over: Seed = {}) =>
  seedGrant({ accountId: g.accountId, clientId: g.clientId, partnerId: g.partnerId, ...over });

const observe = (tracked: string[] = []) => asSystem(() => oauthGrantSource.observe(NOW, tracked));

describe('oauthGrantSource', () => {
  it('is registered', () => {
    expect(HEALTH_SOURCES).toContain(oauthGrantSource);
    expect(oauthGrantSource).toMatchObject({ kind: 'oauth_grant', intervalMinutes: 15 });
  });

  it('reports a reuse-revoked grant with no replacement as broken/permanent', async () => {
    const g = await seedGrant({ createdAt: daysAgo(12), revokedAt: daysAgo(10), revokedReason: 'refresh-token-reuse' });
    expect(await observe()).toEqual([expect.objectContaining({
      sourceKind: 'oauth_grant', sourceId: `${g.accountId}:${g.clientId}`, state: 'broken', severity: 'permanent',
      condition: 'grant_revoked_reuse', ownerUserId: g.accountId, partnerId: g.partnerId, detail: null,
      fixHref: '/settings/connected-apps', ownerFixHref: '/account/connected-apps',
      viewPermission: { resource: 'connected_apps', action: 'read' },
      repairPermission: { resource: 'connected_apps', action: 'manage' },
      displayName: 'Test MCP Client',
    })]);
  });

  it('a newer active grant for the same pair makes it healthy when tracked, absent when not', async () => {
    const g = await seedGrant({ revokedAt: daysAgo(2), revokedReason: 'refresh-token-reuse' });
    await seedGrant({ accountId: g.accountId, clientId: g.clientId, partnerId: g.partnerId, createdAt: daysAgo(1) });
    expect(await observe()).toEqual([]);
    expect(await observe([`${g.accountId}:${g.clientId}`])).toEqual([expect.objectContaining({ state: 'healthy' })]);
  });

  it('user revocation after re-consent retires', async () => {
    const g = await seedGrant({ revokedAt: daysAgo(3), revokedReason: 'refresh-token-reuse' });
    await seedGrant({
      accountId: g.accountId, clientId: g.clientId, partnerId: g.partnerId, createdAt: daysAgo(2),
      revokedAt: daysAgo(1), revokedReason: 'user-revoke', revokedByUserId: g.accountId,
    });
    expect(await observe()).toEqual([]);
    expect(await observe([`${g.accountId}:${g.clientId}`])).toEqual([expect.objectContaining({ state: 'retired' })]);
  });

  it('a tracked pair with no grants left, or a malformed tracked id, yields no observation', async () => {
    expect(await observe(['00000000-0000-0000-0000-000000000000:gone', 'not-a-uuid:x', 'nocolon'])).toEqual([]);
  });

  it('a disabled client is retired when tracked and absent when not', async () => {
    const g = await seedGrant({ revokedAt: daysAgo(1), revokedReason: 'refresh-token-reuse', clientDisabledAt: daysAgo(0) });
    expect(await observe()).toEqual([]);
    expect(await observe([`${g.accountId}:${g.clientId}`])).toEqual([expect.objectContaining({ state: 'retired' })]);
  });

  it('a grant revoked with provider-revoke-grant yields no incident (deliberate RP revocation / end_session)', async () => {
    await seedGrant({ revokedAt: daysAgo(1), revokedReason: 'provider-revoke-grant' });
    expect(await observe()).toEqual([]);
  });

  it('a tracked pair whose newest event is provider-revoke-grant retires', async () => {
    const solo = await seedGrant({ revokedAt: daysAgo(1), revokedReason: 'provider-revoke-grant' });
    const g = await seedGrant({ revokedAt: daysAgo(3), revokedReason: 'refresh-token-reuse' });
    await sibling(g, { createdAt: daysAgo(2), revokedAt: daysAgo(1), revokedReason: 'provider-revoke-grant' });
    const ids = [`${solo.accountId}:${solo.clientId}`, `${g.accountId}:${g.clientId}`];
    const out = await observe(ids);
    expect(out.map((o) => [o.sourceId, o.state]).sort()).toEqual(ids.map((id) => [id, 'retired']).sort());
  });

  it('two installs: an older active install does not hide a newer reuse-revoked one', async () => {
    const g = await seedGrant({ createdAt: daysAgo(5) }); // install A, still active
    await sibling(g, { createdAt: daysAgo(3), revokedAt: daysAgo(1), revokedReason: 'refresh-token-reuse' }); // install B
    expect(await observe()).toEqual([expect.objectContaining({ sourceId: `${g.accountId}:${g.clientId}`, state: 'broken', condition: 'grant_revoked_reuse' })]);
  });

  it('an active grant created before the reuse revoke keeps the pair broken', async () => {
    const g = await seedGrant({ createdAt: daysAgo(4), revokedAt: daysAgo(1), revokedReason: 'refresh-token-reuse' });
    await sibling(g, { createdAt: daysAgo(2) }); // newer by created_at, but older than the revoke
    expect(await observe()).toEqual([expect.objectContaining({ state: 'broken' })]);
  });

  it('re-consent after the reuse revoke is healthy', async () => {
    const g = await seedGrant({ createdAt: daysAgo(4), revokedAt: daysAgo(2), revokedReason: 'refresh-token-reuse' });
    await sibling(g, { createdAt: daysAgo(1) });
    expect(await observe([`${g.accountId}:${g.clientId}`])).toEqual([expect.objectContaining({ state: 'healthy' })]);
  });

  it('an orphan grant (partner_id NULL) created after the reuse revoke is ignored', async () => {
    const g = await seedGrant({ revokedAt: daysAgo(2), revokedReason: 'refresh-token-reuse' });
    await sibling(g, { partnerId: null, createdAt: daysAgo(1) }); // active, but unattributed
    expect(await observe()).toEqual([expect.objectContaining({ state: 'broken', partnerId: g.partnerId })]);
  });

  it('ties on revoked_at and created_at resolve deterministically (highest id wins)', async () => {
    const p = (await createPartner()).id;
    const [orgLow, orgHigh] = [(await createOrganization({ partnerId: p })).id, (await createOrganization({ partnerId: p })).id];
    const at = daysAgo(3);
    const tie = { createdAt: at, revokedAt: daysAgo(1), revokedReason: 'refresh-token-reuse' };
    const base = randomUUID();
    // The loser goes in first, so a sort that falls back to physical order picks it.
    const g = await seedGrant({ ...tie, partnerId: p, id: `${base}-a`, orgId: orgLow });
    await sibling(g, { ...tie, id: `${base}-b`, orgId: orgHigh });
    for (let i = 0; i < 3; i += 1) {
      expect(await observe()).toEqual([expect.objectContaining({ state: 'broken', orgId: orgHigh })]);
    }
  });

  it('ignores deliberate revocations and null reasons', async () => {
    const p = (await createPartner()).id;
    const owner = await seedUser(p);
    await seedGrant({ partnerId: p, revokedAt: daysAgo(1), revokedReason: 'refresh-token-reuse', revokedByUserId: owner });
    await seedGrant({ revokedAt: daysAgo(1), revokedReason: null });
    expect(await observe()).toEqual([]);
  });

  it('ignores revocations older than 30 days', async () => {
    await seedGrant({ revokedAt: daysAgo(31), revokedReason: 'refresh-token-reuse' });
    expect(await observe()).toEqual([]);
  });

  it('caps and cleans client_name', async () => {
    await seedGrant({ revokedAt: daysAgo(1), revokedReason: 'refresh-token-reuse', clientName: `\u0001\u001f\u0085\u202e<b>\u200b${'x'.repeat(500)}\n` });
    const [o] = await observe();
    expect(Array.from(o!.displayName).length).toBeLessThanOrEqual(80);
    expect(o!.displayName).toMatch(/^<b>x+$/);
  });

  it('cleanDisplayName strips C1, bidi, zero-width and line-separator characters', () => {
    expect(cleanDisplayName('a\u0080\u009fb', 'cid')).toBe('a b');
    expect(cleanDisplayName('\u202aA\u202b\u202c\u202d\u202eB\u2066\u2067\u2068\u2069C', 'cid')).toBe('ABC');
    expect(cleanDisplayName('Z\u200b\u200c\u200d\u200e\u200fW\ufeff', 'cid')).toBe('ZW');
    expect(cleanDisplayName('one\u2028two\u2029three', 'cid')).toBe('one two three');
    expect(cleanDisplayName('\u200b\u202e', 'cid')).toBe('cid');
  });

  it('cleanDisplayName caps at 80 code points without splitting a surrogate pair', () => {
    const emoji = '\u{1F600}';
    const capped = cleanDisplayName(`${'a'.repeat(79)}${emoji}b`, 'cid');
    expect(capped).toBe(`${'a'.repeat(79)}${emoji}`);
    expect(cleanDisplayName(`${'a'.repeat(78)}${emoji}${emoji}`, 'cid')).toBe(`${'a'.repeat(78)}${emoji}${emoji}`);
    expect(Array.from(cleanDisplayName(emoji.repeat(100), 'cid'))).toHaveLength(80);
    // A zero-width char at the boundary is removed before the cap, not counted.
    expect(cleanDisplayName(`${'a'.repeat(79)}\u200b${emoji}`, 'cid')).toBe(`${'a'.repeat(79)}${emoji}`);
  });

  it('cleanDisplayName falls back for non-strings and blanks', () => {
    expect(cleanDisplayName(undefined, 'cid')).toBe('cid');
    expect(cleanDisplayName('  \n ', 'cid')).toBe('cid');
    expect(cleanDisplayName('a\tb  c', 'cid')).toBe('a b c');
  });

  it('returns one observation per pair when several revoked grants exist', async () => {
    const g = await seedGrant({ revokedAt: daysAgo(3), revokedReason: 'refresh-token-reuse' });
    await seedGrant({
      accountId: g.accountId, clientId: g.clientId, partnerId: g.partnerId, createdAt: daysAgo(2),
      revokedAt: daysAgo(2), revokedReason: 'refresh-token-reuse',
    });
    expect(await observe()).toHaveLength(1);
  });

  it('the broken-set query uses oauth_grants_auto_revoked_idx', async () => {
    const plan = await asSystem(() => db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const rows = (await tx.execute(sql`EXPLAIN ${brokenCandidatesQuery(NOW)}`)) as unknown as Array<Record<string, string>>;
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    }));
    expect(plan).toContain('oauth_grants_auto_revoked_idx');
  });
});
