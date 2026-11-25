/**
 * W02 (#12429): `mcp_tool_list_mode` on api_keys and oauth_grants.
 *
 * The global setup has already applied every migration, so the run-once marker
 * (each table's own CHECK) exists on the shared tables and a replay there can
 * only prove the no-op. The FIRST run — the one that grandfathers existing
 * credentials — needs pre-migration tables, so it runs in a schema of its own:
 * structural copies of the two tables without the column, with FORCE ROW LEVEL
 * SECURITY and the real policies cloned from the catalog. The whole shipped file
 * runs there (every table name in it is `public.`-qualified; the substitution is
 * counted) as a table owner that is neither superuser, BYPASSRLS nor a member of
 * breeze_app: the least-privileged role a database can be migrated with. The
 * row-writing statements also run alone as breeze_app, with and without the
 * scope line. The shared tables' markers are never touched.
 */
import './setup';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { createOrganization, createPartner, createUser } from './db-utils';
import { replayMigration } from './replayMigration';

const MIGRATION = '2027-01-30-160000-mcp-tool-list-mode.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
const SCOPE_LINE = "SELECT set_config('breeze.scope', 'system', true);";
const TABLES = ['api_keys', 'oauth_grants'] as const;
type Table = (typeof TABLES)[number];
type Tx = postgres.TransactionSql;

const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
afterAll(async () => { await adminSql.end({ timeout: 5 }); });

class Rollback extends Error {}
/** Everything a case creates (schema included) is rolled back. */
async function inRolledBackTx(fn: (tx: Tx) => Promise<void>) {
  await adminSql.begin(async (tx) => {
    await fn(tx);
    throw new Rollback();
  }).catch((err) => { if (!(err instanceof Rollback)) throw err; });
}

let ids: { partnerId: string; orgId: string; userId: string };
beforeEach(async () => {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `mcp-mode-${randomUUID()}@example.test` });
  ids = { partnerId: partner.id, orgId: org.id, userId: user.id };
});

/** The shipped file, retargeted at `schema`. The counts prove every reference moved. */
const migrationCode = migrationSql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
function retarget(schema: string, code = migrationCode, expectedReferences = 10): string {
  const references = code.match(/\bpublic\.(api_keys|oauth_grants)\b/g) ?? [];
  // Per table: ALTER ADD COLUMN, the marker regclass, UPDATE, ALTER ADD CONSTRAINT;
  // oauth_grants also NO FORCE and FORCE.
  expect(references).toHaveLength(expectedReferences);
  // Nothing may name a table unqualified, or the copy run would write the shared tables.
  expect(code).not.toMatch(/(?<!public\.)(?<!_)\b(api_keys|oauth_grants)\b(?!_mcp_tool_list_mode)(?!:)(?=\s+(ADD|SET))/);
  const out = code.replaceAll(/\bpublic\.(api_keys|oauth_grants)\b/g, `${schema}.$1`);
  expect(out).not.toContain('public.');
  return out;
}

/** The copies, owned by a role of their own; returns both names. Rolled back with the transaction. */
async function createPreMigrationCopies(tx: Tx): Promise<{ schema: string; owner: string }> {
  const schema = `mcp_mode_${randomUUID().slice(0, 8)}`;
  const owner = `${schema}_owner`;
  await tx.unsafe(`CREATE SCHEMA ${schema}`);
  await tx.unsafe(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await tx.unsafe(`GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${owner}`);
  await tx.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO breeze_app`);
  for (const table of TABLES) {
    await tx.unsafe(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
    // Dropping the column drops the copied CHECK — the run-once marker — too.
    await tx.unsafe(`ALTER TABLE ${schema}.${table} DROP COLUMN mcp_tool_list_mode`);
    const [marker] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conrelid = ${`${schema}.${table}`}::regclass AND conname = ${`${table}_mcp_tool_list_mode_check`}`;
    expect(marker!.n).toBe(0);
    await tx.unsafe(`ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY`);
    await tx.unsafe(`ALTER TABLE ${schema}.${table} FORCE ROW LEVEL SECURITY`);
    const policies = await tx<{ policyname: string; permissive: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null }[]>`
      SELECT policyname, permissive, cmd, roles::text[] AS roles, qual, with_check FROM pg_policies
       WHERE schemaname = 'public' AND tablename = ${table}`;
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) {
      await tx.unsafe(`CREATE POLICY ${p.policyname} ON ${schema}.${table} AS ${p.permissive} FOR ${p.cmd} TO ${p.roles.map((r) => (r === 'public' ? 'PUBLIC' : r)).join(', ')}`
        + (p.qual ? ` USING (${p.qual})` : '') + (p.with_check ? ` WITH CHECK (${p.with_check})` : ''));
    }
    await tx.unsafe(`ALTER TABLE ${schema}.${table} OWNER TO ${owner}`);
    await tx.unsafe(`GRANT SELECT, UPDATE ON ${schema}.${table} TO breeze_app`);
  }
  return { schema, owner };
}

async function seed(tx: Tx, schema: string, table: Table, id: string) {
  if (table === 'api_keys') {
    await tx.unsafe(
      `INSERT INTO ${schema}.api_keys (id, org_id, name, key_hash, key_prefix, created_by) VALUES ($1, $2, 'k', $3, 'brz_x', $4)`,
      [id, ids.orgId, `hash-${id}`, ids.userId],
    );
  } else {
    await tx.unsafe(
      `INSERT INTO ${schema}.oauth_grants (id, account_id, client_id, partner_id, org_id, payload, expires_at)
       VALUES ($1, $2, 'client-x', $3, $4, '{}'::jsonb, now() + interval '1 hour')`,
      [id, ids.userId, ids.partnerId, ids.orgId],
    );
  }
}

const modes = async (tx: Tx, schema: string, table: Table) => Object.fromEntries(
  (await tx.unsafe(`SELECT id::text AS id, mcp_tool_list_mode AS m FROM ${schema}.${table}`)).map((r) => [r.id, r.m]),
);

/** Switch to an unprivileged role; the assertion rules out a vacuous pass. */
async function asRole(tx: Tx, schema: string, role: string) {
  await tx`SELECT set_config('breeze.scope', 'none', true)`;
  await tx.unsafe(`SET LOCAL ROLE ${role}`);
  const [who] = await tx<Record<string, unknown>[]>`
    SELECT current_user AS u,
           (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS bypass,
           public.breeze_current_scope() AS scope,
           (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = ${schema} AND c.relrowsecurity AND c.relforcerowsecurity) AS forced,
           pg_has_role(current_user, 'breeze_app', 'usage') AS member`;
  expect(who).toEqual({ u: role, bypass: false, scope: 'none', forced: 2, member: role === 'breeze_app' });
}
const forcedTables = async (tx: Tx, schema: string) => (await tx<{ n: number }[]>`
  SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = ${schema} AND c.relrowsecurity AND c.relforcerowsecurity`)[0]!.n;

async function seedBoth(tx: Tx, schema: string) {
  const seeded = { api_keys: randomUUID(), oauth_grants: randomUUID() };
  for (const table of TABLES) await seed(tx, schema, table, seeded[table]);
  return seeded;
}

describe(`${MIGRATION}: the first run, as a least-privileged owner under forced RLS`, () => {
  it.each(TABLES)('%s: existing rows read full after the first apply; a later null row survives a replay', async (table) => {
    await inRolledBackTx(async (tx) => {
      const { schema, owner } = await createPreMigrationCopies(tx);
      const [a, b, later] = [randomUUID(), randomUUID(), randomUUID()];
      await seed(tx, schema, table, a);
      await seed(tx, schema, table, b);

      await asRole(tx, schema, owner);
      await tx.unsafe(retarget(schema));
      await tx.unsafe('RESET ROLE');
      expect(await modes(tx, schema, table)).toEqual({ [a]: 'full', [b]: 'full' });
      expect(await forcedTables(tx, schema)).toBe(2);

      // A credential created after the migration inherits (null) — and stays
      // null when the file is applied again.
      await seed(tx, schema, table, later);
      expect((await modes(tx, schema, table))[later]).toBeNull();
      await asRole(tx, schema, owner);
      await tx.unsafe(retarget(schema));
      await tx.unsafe('RESET ROLE');
      expect(await modes(tx, schema, table)).toEqual({ [a]: 'full', [b]: 'full', [later]: null });
      expect(await forcedTables(tx, schema)).toBe(2);
    });
  });

  it('CONTROL: without lifting FORCE, oauth_grants is silently not backfilled for that owner', async () => {
    await inRolledBackTx(async (tx) => {
      const { schema, owner } = await createPreMigrationCopies(tx);
      const seeded = await seedBoth(tx, schema);
      const line = 'ALTER TABLE public.oauth_grants NO FORCE ROW LEVEL SECURITY;';
      const without = migrationCode.replace(line, '');
      expect(without).not.toBe(migrationCode);
      await asRole(tx, schema, owner);
      await tx.unsafe(retarget(schema, without, 9));
      await tx.unsafe('RESET ROLE');
      expect(await modes(tx, schema, 'oauth_grants')).toEqual({ [seeded.oauth_grants]: null });
      expect(await modes(tx, schema, 'api_keys')).toEqual({ [seeded.api_keys]: 'full' });
    });
  });

  it('CONTROL: without the system-scope line, api_keys is silently not backfilled for that owner', async () => {
    await inRolledBackTx(async (tx) => {
      const { schema, owner } = await createPreMigrationCopies(tx);
      const seeded = await seedBoth(tx, schema);
      const without = migrationCode.replace(SCOPE_LINE, '');
      expect(without).not.toBe(migrationCode);
      expect(without).not.toContain("set_config('breeze.scope'");
      await asRole(tx, schema, owner);
      await tx.unsafe(retarget(schema, without));
      await tx.unsafe('RESET ROLE');
      expect(await modes(tx, schema, 'api_keys')).toEqual({ [seeded.api_keys]: null });
    });
  });
});

describe(`${MIGRATION}: the row-writing statements, as breeze_app under forced RLS`, () => {
  // The app role owns nothing, so it cannot run the DDL: the column is added
  // first and only the file's own UPDATE statements run as the role.
  const updates = migrationCode.match(/UPDATE public\.[\s\S]*?;/g) ?? [];

  it.each([
    ['with the system-scope line: rows written', true, 'full'],
    ['CONTROL: without it: zero rows, silently', false, null],
  ] as const)('%s', async (_name, elect, expected) => {
    expect(updates).toHaveLength(2);
    expect(migrationCode.split(SCOPE_LINE)).toHaveLength(2);
    await inRolledBackTx(async (tx) => {
      const { schema } = await createPreMigrationCopies(tx);
      const seeded = await seedBoth(tx, schema);
      for (const table of TABLES) await tx.unsafe(`ALTER TABLE ${schema}.${table} ADD COLUMN mcp_tool_list_mode text`);
      await asRole(tx, schema, 'breeze_app');
      if (elect) await tx.unsafe(SCOPE_LINE);
      await tx.unsafe(retarget(schema, updates.join('\n'), 2));
      await tx.unsafe('RESET ROLE');
      for (const table of TABLES) expect(await modes(tx, schema, table)).toEqual({ [seeded[table]]: expected });
    });
  });
});

describe(`${MIGRATION}: on the shared tables`, () => {
  async function insertShared(table: Table, mode: string | null): Promise<string> {
    const id = randomUUID();
    if (table === 'api_keys') {
      await adminSql`insert into api_keys (id, org_id, name, key_hash, key_prefix, created_by, mcp_tool_list_mode)
        values (${id}, ${ids.orgId}, 'k', ${`hash-${id}`}, 'brz_x', ${ids.userId}, ${mode})`;
    } else {
      await adminSql`insert into oauth_clients (id, metadata) values (${`client-${id}`}, ${adminSql.json({ client_name: 'mcp mode test' })})`;
      await adminSql`insert into oauth_grants (id, account_id, client_id, partner_id, org_id, payload, expires_at, mcp_tool_list_mode)
        values (${id}, ${ids.userId}, ${`client-${id}`}, ${ids.partnerId}, ${ids.orgId}, ${adminSql.json({})}, now() + interval '1 hour', ${mode})`;
    }
    return id;
  }
  const readShared = async (table: Table, id: string) =>
    (await adminSql.unsafe(`select mcp_tool_list_mode as m from ${table} where id::text = $1`, [id]))[0]?.m;

  it.each(TABLES)('%s: nullable text, and a replay changes no value', async (table) => {
    const rows = { full: await insertShared(table, 'full'), progressive: await insertShared(table, 'progressive'), none: await insertShared(table, null) };
    await replayMigration(MIGRATION);
    expect({
      full: await readShared(table, rows.full), progressive: await readShared(table, rows.progressive), none: await readShared(table, rows.none),
    }).toEqual({ full: 'full', progressive: 'progressive', none: null });
    const [col] = await adminSql`select data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = ${table} and column_name = 'mcp_tool_list_mode'`;
    expect(col).toEqual({ data_type: 'text', is_nullable: 'YES', column_default: null });
  });

  it.each(TABLES)("%s: the CHECK refuses anything but the two modes", async (table) => {
    for (const bad of ['bulk', 'Full', '']) {
      await expect(insertShared(table, bad)).rejects.toMatchObject({
        code: '23514', constraint_name: `${table}_mcp_tool_list_mode_check`,
      });
    }
  });
});
