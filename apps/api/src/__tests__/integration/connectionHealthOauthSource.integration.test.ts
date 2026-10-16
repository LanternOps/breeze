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
import { createPartner, createUser } from './db-utils';
import { oauthGrantSource, cleanDisplayName, brokenCandidatesQuery } from '../../services/connectionHealth/sources/oauthGrant';
import { HEALTH_SOURCES } from '../../services/connectionHealth/sources';

const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const asSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

type Seed = {
  accountId?: string; clientId?: string; partnerId?: string;
  createdAt?: Date; expiresAt?: Date; revokedAt?: Date | null; revokedReason?: string | null;
  revokedByUserId?: string; clientName?: string; clientDisabledAt?: Date;
};

async function seedUser(partnerId: string): Promise<string> {
  return (await createUser({ partnerId, email: `ch-oauth-${randomUUID()}@example.test` })).id;
}

async function seedGrant(over: Seed = {}) {
  const partnerId = over.partnerId ?? (await createPartner()).id;
  const accountId = over.accountId ?? (await seedUser(partnerId));
  const clientId = over.clientId ?? `client-${randomUUID()}`;
  const createdAt = over.createdAt ?? daysAgo(5);
  await asSystem(async () => {
    await db.insert(oauthClients).values({
      id: clientId, partnerId: null, metadata: { client_name: over.clientName ?? 'Test MCP Client' },
      disabledAt: over.clientDisabledAt ?? null,
    }).onConflictDoNothing();
    await db.insert(oauthGrants).values({
      id: randomUUID(), accountId, clientId, partnerId, payload: {},
      createdAt, expiresAt: over.expiresAt ?? new Date(createdAt.getTime() + 14 * 86_400_000),
      revokedAt: over.revokedAt ?? null, revokedReason: over.revokedReason ?? null,
      revokedByUserId: over.revokedByUserId ?? null,
    });
  });
  return { accountId, clientId, partnerId };
}

const observe = (tracked: string[] = []) => asSystem(() => oauthGrantSource.observe(NOW, tracked));

describe('oauthGrantSource', () => {
  it('is registered', () => {
    expect(HEALTH_SOURCES).toEqual([oauthGrantSource]);
    expect(oauthGrantSource).toMatchObject({ kind: 'oauth_grant', intervalMinutes: 15 });
  });

  it('reports a reuse-revoked grant with no replacement as broken/permanent', async () => {
    const g = await seedGrant({ revokedAt: daysAgo(10), revokedReason: 'refresh-token-reuse' });
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

  it('maps provider-revoke-grant to grant_revoked_code_replay', async () => {
    await seedGrant({ revokedAt: daysAgo(1), revokedReason: 'provider-revoke-grant' });
    expect((await observe())[0]).toMatchObject({ condition: 'grant_revoked_code_replay' });
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
    await seedGrant({ revokedAt: daysAgo(1), revokedReason: 'refresh-token-reuse', clientName: `\u0001\u001f<b>${'x'.repeat(500)}\n` });
    const [o] = await observe();
    expect(o!.displayName.length).toBeLessThanOrEqual(80);
    expect(o!.displayName).not.toMatch(/[\u0000-\u001f]/);
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
