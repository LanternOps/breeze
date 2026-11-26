/**
 * #12730 — a one-off migration clears the stored credentials on every
 * SentinelOne and Huntress integration that is not active, so an integration
 * deactivated before Disconnect existed (#12691) holds no credential either.
 *
 * It clears exactly what Disconnect clears and nothing else:
 *   - s1_integrations.api_token_encrypted, where is_active = false
 *   - s1_org_mappings.registration_token, where the mapping's integration
 *     (composite FK integration_id, partner_id) has is_active = false
 *   - huntress_integrations.api_key_encrypted, account_key_encrypted and
 *     webhook_secret_encrypted, where is_active = false
 *
 * Active rows must come through byte-for-byte unchanged and not even
 * rewritten (same xmin). Every other column of a cleared row, updated_at
 * included, must be unchanged. A second run must rewrite nothing.
 *
 * The file is applied as the unprivileged `breeze_app` role, which forced RLS
 * binds, so a missing system-scope election would show up here as zero rows
 * cleared. The negative control strips that election and expects exactly that.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/securityIntegrationInactiveCredentialCleanup.integration.test.ts
 */
import './setup';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { huntressIntegrations, s1Integrations, s1OrgMappings } from '../../db/schema';
import { encryptSecret } from '../../services/secretCrypto';
import { createOrganization, createPartner } from './db-utils';
import { getAppDb, getTestDb } from './setup';

const MIGRATION = '2027-01-30-190000-clear-credentials-on-inactive-security-integrations.sql';
const MIGRATION_FILE = new URL(`../../../migrations/${MIGRATION}`, import.meta.url);

const S1_SECRET_COLUMNS = ['api_token_encrypted'] as const;
const MAPPING_SECRET_COLUMNS = ['registration_token'] as const;
const HUNTRESS_SECRET_COLUMNS = ['api_key_encrypted', 'account_key_encrypted', 'webhook_secret_encrypted'] as const;

type Snapshot = Map<string, { xmin: string; row: Record<string, unknown>; text: string }>;

function idList(ids: string[]): SQL {
  return sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
}

async function snapshot(table: 's1_integrations' | 's1_org_mappings' | 'huntress_integrations', ids: string[]): Promise<Snapshot> {
  const rows = (await getTestDb().execute(sql`
    SELECT t.id::text AS id, t.xmin::text AS xmin, to_jsonb(t) AS row, to_jsonb(t)::text AS text
      FROM ${sql.identifier(table)} t
     WHERE t.id IN (${idList(ids)})
  `)) as unknown as Array<{ id: string; xmin: string; row: Record<string, unknown>; text: string }>;
  expect(rows).toHaveLength(ids.length);
  return new Map(rows.map((r) => [r.id, { xmin: r.xmin, row: r.row, text: r.text }]));
}

function without(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy = { ...row };
  for (const key of keys) delete copy[key];
  return copy;
}

function migrationSql(): string {
  return readFileSync(MIGRATION_FILE, 'utf8');
}

async function applyAsApp(content = migrationSql()): Promise<void> {
  await getAppDb().execute(sql.raw(content));
}

async function s1Integration(partnerId: string, label: string, opts: { active: boolean; token: boolean }) {
  const [row] = await (getTestDb() as any).insert(s1Integrations).values({
    partnerId,
    name: `S1 ${label}`,
    apiTokenEncrypted: opts.token ? encryptSecret(`s1-token-${label}`) : null,
    managementUrl: 'https://usea1-test.sentinelone.net',
    isActive: opts.active,
    lastSyncStatus: 'success',
    updatedAt: new Date('2026-01-02T03:04:05Z'),
  }).returning();
  return row as { id: string };
}

async function s1Mapping(integrationId: string, partnerId: string, orgId: string, label: string, token: boolean) {
  const [row] = await (getTestDb() as any).insert(s1OrgMappings).values({
    integrationId,
    partnerId,
    s1SiteId: `site-${label}`,
    s1SiteName: `Site ${label}`,
    orgId,
    agentsCount: 3,
    metadata: { label },
    registrationToken: token
      ? encryptSecret(`reg-token-${label}`, { aad: 's1_org_mappings.registration_token' })
      : null,
    updatedAt: new Date('2026-01-02T03:04:05Z'),
  }).returning();
  return row as { id: string };
}

async function huntressIntegration(
  partnerId: string,
  label: string,
  opts: { active: boolean; apiKey: boolean; accountKey: boolean; webhookSecret: boolean },
) {
  const [row] = await (getTestDb() as any).insert(huntressIntegrations).values({
    partnerId,
    name: `Huntress ${label}`,
    apiKeyEncrypted: opts.apiKey ? encryptSecret(`hk-${label}`) : null,
    accountId: `acct-${label}`,
    accountKeyEncrypted: opts.accountKey
      ? encryptSecret(`acct-key-${label}`, { aad: 'huntress_integrations.account_key_encrypted' })
      : null,
    webhookSecretEncrypted: opts.webhookSecret ? encryptSecret(`webhook-secret-${label}`) : null,
    isActive: opts.active,
    lastSyncStatus: 'success',
    updatedAt: new Date('2026-01-02T03:04:05Z'),
  }).returning();
  return row as { id: string };
}

/**
 * Partner A: an active integration with secrets and, from before a dedupe,
 * an older inactive one with secrets. Partner B: an inactive one with
 * secrets. Partner C: an inactive one already cleared by Disconnect.
 * Each integration has site mappings under it.
 */
async function seed() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const partnerC = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const orgC = await createOrganization({ partnerId: partnerC.id });

  const s1Active = await s1Integration(partnerA.id, 'a-active', { active: true, token: true });
  const s1OldInactive = await s1Integration(partnerA.id, 'a-old', { active: false, token: true });
  const s1Inactive = await s1Integration(partnerB.id, 'b', { active: false, token: true });
  const s1Cleared = await s1Integration(partnerC.id, 'c', { active: false, token: false });

  const mapActive = await s1Mapping(s1Active.id, partnerA.id, orgA.id, 'a-active', true);
  const mapOldInactive = await s1Mapping(s1OldInactive.id, partnerA.id, orgA.id, 'a-old', true);
  const mapInactive1 = await s1Mapping(s1Inactive.id, partnerB.id, orgB.id, 'b-1', true);
  const mapInactive2 = await s1Mapping(s1Inactive.id, partnerB.id, orgB.id, 'b-2', true);
  const mapInactiveNoToken = await s1Mapping(s1Inactive.id, partnerB.id, orgB.id, 'b-3', false);
  const mapCleared = await s1Mapping(s1Cleared.id, partnerC.id, orgC.id, 'c', false);

  const hActive = await huntressIntegration(partnerA.id, 'a-active', { active: true, apiKey: true, accountKey: true, webhookSecret: true });
  const hOldInactive = await huntressIntegration(partnerA.id, 'a-old', { active: false, apiKey: true, accountKey: true, webhookSecret: true });
  const hPartial = await huntressIntegration(partnerB.id, 'b', { active: false, apiKey: false, accountKey: false, webhookSecret: true });
  const hCleared = await huntressIntegration(partnerC.id, 'c', { active: false, apiKey: false, accountKey: false, webhookSecret: false });

  return {
    s1: {
      active: [s1Active.id],
      clear: [s1OldInactive.id, s1Inactive.id],
      alreadyClear: [s1Cleared.id],
    },
    mappings: {
      active: [mapActive.id],
      clear: [mapOldInactive.id, mapInactive1.id, mapInactive2.id],
      alreadyClear: [mapInactiveNoToken.id, mapCleared.id],
    },
    huntress: {
      active: [hActive.id],
      clear: [hOldInactive.id, hPartial.id],
      alreadyClear: [hCleared.id],
    },
  };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function snapshotAll(s: Seeded) {
  return {
    s1: await snapshot('s1_integrations', [...s.s1.active, ...s.s1.clear, ...s.s1.alreadyClear]),
    mappings: await snapshot('s1_org_mappings', [...s.mappings.active, ...s.mappings.clear, ...s.mappings.alreadyClear]),
    huntress: await snapshot('huntress_integrations', [...s.huntress.active, ...s.huntress.clear, ...s.huntress.alreadyClear]),
  };
}

/** How many rows the migration's predicates match, read before it runs. */
async function predicateCounts() {
  const [row] = (await getTestDb().execute(sql`
    SELECT
      (SELECT count(*)::int FROM s1_integrations
        WHERE is_active = false AND api_token_encrypted IS NOT NULL) AS s1,
      (SELECT count(*)::int FROM s1_org_mappings m
         JOIN s1_integrations i ON i.id = m.integration_id AND i.partner_id = m.partner_id
        WHERE i.is_active = false AND m.registration_token IS NOT NULL) AS mappings,
      (SELECT count(*)::int FROM huntress_integrations
        WHERE is_active = false
          AND (api_key_encrypted IS NOT NULL OR account_key_encrypted IS NOT NULL
               OR webhook_secret_encrypted IS NOT NULL)) AS huntress
  `)) as unknown as Array<{ s1: number; mappings: number; huntress: number }>;
  return row;
}

function expectUnchanged(before: Snapshot, after: Snapshot, ids: string[]) {
  for (const id of ids) {
    expect(after.get(id)!.text).toBe(before.get(id)!.text);
    expect(after.get(id)!.xmin).toBe(before.get(id)!.xmin);
  }
}

function expectCleared(before: Snapshot, after: Snapshot, ids: string[], secretColumns: readonly string[]) {
  for (const id of ids) {
    const was = before.get(id)!.row;
    const now = after.get(id)!.row;
    // The fixture really held at least one secret here.
    expect(secretColumns.some((c) => was[c] !== null)).toBe(true);
    for (const column of secretColumns) expect(now[column]).toBeNull();
    expect(without(now, secretColumns)).toEqual(without(was, secretColumns));
  }
}

describe('#12730 migration: clear credentials on inactive SentinelOne and Huntress integrations', () => {
  it('elects system scope before it writes', () => {
    const content = migrationSql().replace(/--[^\n]*/g, '');
    const election = content.indexOf("SELECT set_config('breeze.scope', 'system', true);");
    expect(election).toBeGreaterThan(-1);
    expect(election).toBeLessThan(content.search(/\b(UPDATE|DELETE|INSERT|MERGE)\b/));
    expect(content).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });

  it('matches exactly the inactive rows that still hold a secret', async () => {
    await seed();
    expect(await predicateCounts()).toEqual({ s1: 2, mappings: 3, huntress: 2 });
    await applyAsApp();
    expect(await predicateCounts()).toEqual({ s1: 0, mappings: 0, huntress: 0 });
  });

  it('clears secrets on inactive rows only, touches nothing else, and is a no-op the second time', async () => {
    const s = await seed();
    const before = await snapshotAll(s);

    await applyAsApp();
    const first = await snapshotAll(s);

    // Active integrations and their mappings: not rewritten at all.
    expectUnchanged(before.s1, first.s1, s.s1.active);
    expectUnchanged(before.mappings, first.mappings, s.mappings.active);
    expectUnchanged(before.huntress, first.huntress, s.huntress.active);
    // Inactive rows that held nothing: not rewritten either.
    expectUnchanged(before.s1, first.s1, s.s1.alreadyClear);
    expectUnchanged(before.mappings, first.mappings, s.mappings.alreadyClear);
    expectUnchanged(before.huntress, first.huntress, s.huntress.alreadyClear);
    // Inactive rows with secrets: secrets gone, every other column (updated_at included) kept.
    expectCleared(before.s1, first.s1, s.s1.clear, S1_SECRET_COLUMNS);
    expectCleared(before.mappings, first.mappings, s.mappings.clear, MAPPING_SECRET_COLUMNS);
    expectCleared(before.huntress, first.huntress, s.huntress.clear, HUNTRESS_SECRET_COLUMNS);

    await applyAsApp();
    const second = await snapshotAll(s);
    const all = (g: { active: string[]; clear: string[]; alreadyClear: string[] }) => [...g.active, ...g.clear, ...g.alreadyClear];
    expectUnchanged(first.s1, second.s1, all(s.s1));
    expectUnchanged(first.mappings, second.mappings, all(s.mappings));
    expectUnchanged(first.huntress, second.huntress, all(s.huntress));
  });

  it('negative control: without the system-scope election, forced RLS lets it clear nothing', async () => {
    const s = await seed();
    const before = await snapshotAll(s);
    const content = migrationSql();
    const stripped = content.replace("SELECT set_config('breeze.scope', 'system', true);", '');
    expect(stripped).not.toBe(content);

    await applyAsApp(stripped);

    const after = await snapshotAll(s);
    expect(await predicateCounts()).toEqual({ s1: 2, mappings: 3, huntress: 2 });
    expect([...after.s1.values()].map((r) => r.text)).toEqual([...before.s1.values()].map((r) => r.text));
    expect([...after.mappings.values()].map((r) => r.text)).toEqual([...before.mappings.values()].map((r) => r.text));
    expect([...after.huntress.values()].map((r) => r.text)).toEqual([...before.huntress.values()].map((r) => r.text));
  });
});
