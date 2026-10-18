/**
 * B-W02 (#6156): `mcp_domains` on api_keys and oauth_grants. NULL and a
 * non-empty set are accepted; the shape CHECK rejects [], 'core' and a NULL
 * element (which would otherwise make `'core' = ANY(...)` UNKNOWN and pass).
 * The migration re-runs as a no-op.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { createOrganization, createPartner, createUser } from './db-utils';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-12-30-200100-mcp-tool-domains.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
afterAll(async () => { await adminSql.end({ timeout: 5 }); });

let seq = 0;
const uniq = () => `${Date.now()}-${++seq}`;

async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `mcp-domains-${uniq()}@example.test` });
  return { partner, org, user };
}

async function insertApiKey(domains: string | null) {
  const { org, user } = await seedTenant();
  const id = uniq();
  // `domains` is a Postgres array literal (or NULL) so the test can express a
  // NULL element, which a JS array cannot round-trip through the driver.
  return adminSql`
    insert into api_keys (org_id, name, key_hash, key_prefix, created_by, mcp_domains)
    values (${org.id}, ${'k-' + id}, ${'hash-' + id}, ${'brz_' + id.slice(-6)}, ${user.id}, ${domains}::text[])
    returning mcp_domains`;
}

async function insertGrant(domains: string | null) {
  const { partner, org, user } = await seedTenant();
  const id = uniq();
  await adminSql`insert into oauth_clients (id, metadata) values (${'client-' + id}, ${adminSql.json({ client_name: 'mcp domains test' })})`;
  return adminSql`
    insert into oauth_grants (id, account_id, client_id, partner_id, org_id, payload, expires_at, mcp_domains)
    values (${'grant-' + id}, ${user.id}, ${'client-' + id}, ${partner.id}, ${org.id}, ${adminSql.json({ accountId: user.id })},
            now() + interval '1 hour', ${domains}::text[])
    returning mcp_domains`;
}

describe.skipIf(!RUN)('mcp_domains columns (B-W02 #6156)', () => {
  it('migration re-runs as a no-op and adds nullable text[] columns', async () => {
    await adminSql.unsafe(migrationSql);
    await adminSql.unsafe(migrationSql);
    const cols = await adminSql`
      select table_name, data_type, udt_name, is_nullable from information_schema.columns
      where column_name = 'mcp_domains' and table_name in ('api_keys', 'oauth_grants')
      order by table_name`;
    expect(cols.map((c) => [c.table_name, c.data_type, c.udt_name, c.is_nullable])).toEqual([
      ['api_keys', 'ARRAY', '_text', 'YES'],
      ['oauth_grants', 'ARRAY', '_text', 'YES'],
    ]);
  });

  for (const [table, insert] of [['api_keys', insertApiKey], ['oauth_grants', insertGrant]] as const) {
    const check = new RegExp(`${table}_mcp_domains_shape_check`);

    it(`${table} accepts NULL and a non-empty set`, async () => {
      expect((await insert(null))[0]!.mcp_domains).toBeNull();
      expect((await insert('{tickets,devices}'))[0]!.mcp_domains).toEqual(['tickets', 'devices']);
    });

    it(`${table} rejects an empty array`, async () => {
      await expect(insert('{}')).rejects.toThrow(check);
    });

    it(`${table} rejects core`, async () => {
      await expect(insert('{tickets,core}')).rejects.toThrow(check);
    });

    it(`${table} rejects a NULL element`, async () => {
      await expect(insert('{tickets,NULL}')).rejects.toThrow(check);
    });
  }
});
