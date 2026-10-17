/**
 * AI model registry W08b (#7606): archive, then drop, the legacy AI model
 * configuration (2026-12-30-200000-ai-model-registry-legacy-drop.sql).
 *
 * Every migration case runs inside ONE postgres.js transaction that is rolled
 * back (same harness as legacyLabourPricingDrop.integration.test.ts): the
 * legacy objects are restored (fixtures/aiModelRegistryLegacyConfig.ts),
 * legacy values are seeded, the migration file is executed exactly as
 * autoMigrate would, and the ROLLBACK leaves the live test schema as a fresh
 * migrate produced it (where the migration has already run once).
 *
 * What is proven:
 *  - every legacy value that exists is archived — the archive row count equals
 *    the seeded value count, per source — never key material; then every
 *    legacy object is dropped and the counts are reported;
 *  - a re-apply is a no-op (no new archive rows, nothing raised);
 *  - a partial set (a column already dropped by hand) is archived column by
 *    column and never refused (#6472: no boot refusal);
 *  - the archive insert sees rows under FORCE RLS only because it elects
 *    system scope (run as breeze_app: breeze_test is a superuser and bypasses
 *    RLS, so it cannot prove this);
 *  - the archive is partner-axis: a partner sees only its rows, an org token
 *    none, and a cross-partner forge fails 42501.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { RESTORE_AI_MODEL_LEGACY_CONFIG_SQL } from './fixtures/aiModelRegistryLegacyConfig';

const MIGRATION = '2026-12-30-200000-ai-model-registry-legacy-drop.sql';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
type Tx = postgres.TransactionSql<Record<string, unknown>>;
class Rollback extends Error { constructor() { super('intentional rollback'); } }

const loadMigration = () => readFile(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');

/** Runs `body` in a transaction that is always rolled back; collects NOTICE/WARNINGs. */
async function inRolledBackTx(body: (tx: Tx, notices: string[]) => Promise<void>): Promise<void> {
  const notices: string[] = [];
  const client = postgres(DATABASE_URL, { max: 1, onnotice: (n) => { notices.push(n.message ?? ''); } });
  try {
    await client.begin(async (tx) => { await body(tx as unknown as Tx, notices); throw new Rollback(); });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  } finally {
    await client.end({ timeout: 1 });
  }
}

const legacyObjects = async (tx: Tx) => (await tx`SELECT
    to_regclass('public.partner_llm_configs') IS NOT NULL AS llm_configs,
    to_regclass('public.ai_model_registry_state') IS NOT NULL AS state,
    to_regclass('public.partner_ai_connections_compat_uq') IS NOT NULL AS compat_uq,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND (
      (table_name = 'partner_ai_connections' AND column_name = 'legacy_default_model') OR
      (table_name = 'ai_budgets' AND column_name = 'allowed_models') OR
      (table_name = 'ai_script_policies' AND column_name = 'reviewer_model') OR
      (table_name = 'client_ai_org_policies' AND column_name = 'allowed_models') OR
      (table_name = 'ai_agents' AND column_name = 'model'))) AS columns`)[0]!;

type Tenant = { partnerId: string; orgId: string; userId: string };

/**
 * Both tenants at once. The partner-export lock hierarchy refuses a NEW
 * partner lock once an organization lock is held in the transaction, so both
 * partners' exclusive locks are taken up front, before any organization row.
 */
async function insertTenants(tx: Tx, labels: readonly string[]): Promise<Tenant[]> {
  const tenants = labels.map(() => ({ partnerId: randomUUID(), orgId: randomUUID(), userId: randomUUID() }));
  for (const [i, t] of tenants.entries()) {
    await tx`INSERT INTO partners (id, name, slug, currency_code) VALUES (${t.partnerId}, ${`W08b ${labels[i]}`}, ${`w08b-${labels[i]}-${t.partnerId}`}, 'USD')`;
  }
  await tx`SELECT public.breeze_partner_export_lock_partners_exclusive(${tenants.map((t) => t.partnerId)}::uuid[])`;
  for (const [i, t] of tenants.entries()) {
    await tx`INSERT INTO organizations (id, partner_id, name, slug, currency_code)
      VALUES (${t.orgId}, ${t.partnerId}, ${`W08b ${labels[i]} org`}, ${`w08b-${labels[i]}-org-${t.orgId}`}, 'USD')`;
    // ai_agents rows need a human creator (ai_agents_creator_chk).
    await tx`INSERT INTO users (id, partner_id, email, name, password_hash)
      VALUES (${t.userId}, ${t.partnerId}, ${`w08b-${t.userId}@example.com`}, 'W08b user', 'not-a-real-hash')`;
  }
  return tenants;
}

/**
 * Legacy values, written inside the rolled-back transaction (after the
 * restore). Returns the archive rows each partner must end up with, as
 * `source_table.source_column` keys, so a test compares the archive against
 * exactly what was seeded.
 */
async function seed(tx: Tx) {
  // Partner A was cut over: its legacy row was copied (same id) into the
  // registry, whose connection still carries the W02 legacy_default_model.
  const [a, b] = (await insertTenants(tx, ['cut', 'uncut'])) as [Tenant, Tenant];
  const aLegacyId = randomUUID();
  await tx`INSERT INTO ai_model_registry_partner_cutover (partner_id) VALUES (${a.partnerId})`;
  await tx`INSERT INTO partner_llm_configs (id, partner_id, api_key_encrypted, key_last4, key_fingerprint, default_model)
    VALUES (${aLegacyId}, ${a.partnerId}, 'enc:v1:SECRET-CIPHERTEXT-A', 'aaaa', 'FINGERPRINT-A', 'claude-legacy-default')`;
  await tx`INSERT INTO partner_ai_connections (id, partner_id, kind, name, api_key_encrypted, key_last4, key_fingerprint, legacy_default_model)
    VALUES (${aLegacyId}, ${a.partnerId}, 'anthropic_byok', 'Anthropic API key', 'enc:v1:SECRET-CIPHERTEXT-A', 'aaaa', 'FINGERPRINT-A', 'claude-pinned')`;
  await tx`INSERT INTO ai_budgets (org_id, allowed_models) VALUES (${a.orgId}, '["claude-a","claude-b"]'::jsonb)`;
  await tx`INSERT INTO ai_script_policies (org_id, reviewer_model) VALUES (${a.orgId}, 'claude-reviewer-org')`;
  await tx`INSERT INTO ai_script_policies (partner_id, reviewer_model) VALUES (${a.partnerId}, 'claude-reviewer-partner')`;
  await tx`INSERT INTO client_ai_org_policies (org_id, allowed_models) VALUES (${a.orgId}, '["claude-office"]'::jsonb)`;
  const agentId = randomUUID();
  await tx`INSERT INTO ai_agents (id, partner_id, kind, name, model, created_by)
    VALUES (${agentId}, ${a.partnerId}, 'triage', 'Triage', 'claude-agent', ${a.userId})`;
  await tx`INSERT INTO ai_agents (org_id, kind, name, model, created_by) VALUES (${a.orgId}, 'patch', 'Patch', 'claude-agent-org', ${a.userId})`;
  // Control that holds nothing to archive: an agent with no model.
  await tx`INSERT INTO ai_agents (partner_id, kind, name, created_by) VALUES (${a.partnerId}, 'helpdesk', 'Helpdesk', ${a.userId})`;

  // Partner B was never cut over: its legacy row was never projected.
  await tx`INSERT INTO partner_llm_configs (partner_id, api_key_encrypted, key_last4, key_fingerprint)
    VALUES (${b.partnerId}, 'enc:v1:SECRET-CIPHERTEXT-B', 'bbbb', 'FINGERPRINT-B')`;
  // The column default is archived too (a full snapshot); an empty Office list is not a value.
  await tx`INSERT INTO ai_budgets (org_id) VALUES (${b.orgId})`;
  await tx`INSERT INTO client_ai_org_policies (org_id) VALUES (${b.orgId})`;

  return {
    a: { ...a, agentId, legacyId: aLegacyId },
    b,
    expected: {
      [a.partnerId]: [
        'ai_agents.model', 'ai_agents.model', 'ai_budgets.allowed_models',
        'ai_script_policies.reviewer_model', 'ai_script_policies.reviewer_model',
        'client_ai_org_policies.allowed_models', 'partner_ai_connections.legacy_default_model', 'partner_llm_configs.row',
      ],
      [b.partnerId]: ['ai_budgets.allowed_models', 'partner_llm_configs.row'],
    } as Record<string, string[]>,
  };
}

const archiveKeys = async (tx: Tx, partnerId: string) =>
  (await tx`SELECT source_table || '.' || source_column AS k FROM ai_model_registry_legacy_archive
    WHERE partner_id = ${partnerId} ORDER BY 1`).map((r) => r.k as string);

describe('archive then drop the legacy AI model config (#7606 W08b)', () => {
  it('archives every seeded legacy value (never key material), then drops every legacy object', async () => {
    const migration = await loadMigration();
    await inRolledBackTx(async (tx, notices) => {
      await tx`SELECT set_config('breeze.scope', 'system', true)`;
      await tx.unsafe(RESTORE_AI_MODEL_LEGACY_CONFIG_SQL);
      expect(await legacyObjects(tx)).toEqual({ llm_configs: true, state: true, compat_uq: true, columns: 5 });
      const s = await seed(tx);
      await tx.unsafe(migration);

      expect(await legacyObjects(tx)).toEqual({ llm_configs: false, state: false, compat_uq: false, columns: 0 });
      // Archive row count == seeded value count, per partner and per source.
      for (const [partnerId, keys] of Object.entries(s.expected)) {
        expect(await archiveKeys(tx, partnerId), partnerId).toEqual([...keys].sort());
      }

      const rows = await tx`SELECT source_table, source_column, source_id, org_id, value, had_cutover
        FROM ai_model_registry_legacy_archive WHERE partner_id IN (${s.a.partnerId}, ${s.b.partnerId})`;
      expect(JSON.stringify(rows)).not.toMatch(/SECRET-CIPHERTEXT|FINGERPRINT/);
      const llmA = rows.find((r) => r.source_table === 'partner_llm_configs' && r.had_cutover === true)!;
      expect(llmA).toMatchObject({ source_id: s.a.legacyId, org_id: null });
      expect(llmA.value).toMatchObject({ default_model: 'claude-legacy-default', key_last4: 'aaaa', status: 'active', in_registry: true });
      expect(Object.keys(llmA.value as object)).not.toContain('api_key_encrypted');
      expect(Object.keys(llmA.value as object)).not.toContain('key_fingerprint');
      expect(rows.find((r) => r.source_table === 'partner_llm_configs' && r.had_cutover === false)!.value)
        .toMatchObject({ key_last4: 'bbbb', default_model: null, in_registry: false });
      expect(rows.find((r) => r.source_table === 'partner_ai_connections')).toMatchObject({ source_id: s.a.legacyId, value: 'claude-pinned', had_cutover: true });
      expect(rows.find((r) => r.source_table === 'ai_budgets' && r.org_id === s.a.orgId)).toMatchObject({ value: ['claude-a', 'claude-b'], had_cutover: true });
      expect(rows.find((r) => r.source_table === 'ai_budgets' && r.org_id === s.b.orgId)).toMatchObject({ value: ['claude-sonnet-4-5-20250929'], had_cutover: false });
      expect(rows.filter((r) => r.source_table === 'ai_script_policies').map((r) => [r.org_id, r.value]).sort())
        .toEqual([[null, 'claude-reviewer-partner'], [s.a.orgId, 'claude-reviewer-org']].sort());
      expect(rows.find((r) => r.source_id === s.a.agentId)).toMatchObject({ org_id: null, value: { model: 'claude-agent', offering_id: null, disabled_at: null } });

      expect(notices).toContainEqual(expect.stringContaining('1 partner(s) held legacy AI model config without a registry row'));
      expect(notices).toContainEqual(expect.stringContaining('archived 2 partner_llm_configs row(s)'));
      expect(notices).toContainEqual(expect.stringContaining('archived 1 partner_ai_connections.legacy_default_model value(s)'));
      expect(notices).toContainEqual(expect.stringContaining('archived 2 ai_budgets.allowed_models value(s)'));
      expect(notices).toContainEqual(expect.stringContaining('archived 2 ai_script_policies.reviewer_model value(s)'));
      expect(notices).toContainEqual(expect.stringContaining('archived 1 client_ai_org_policies.allowed_models value(s)'));
      expect(notices).toContainEqual(expect.stringContaining('archived 2 ai_agents.model value(s)'));
      expect(notices).toContainEqual(expect.stringContaining('dropping ai_model_registry_state (cutover_completed_at = '));
      expect(notices).toContainEqual(expect.stringContaining('legacy AI model config dropped'));

      // Re-apply: a no-op that still proves the drop.
      const [before] = await tx`SELECT count(*)::int AS n FROM ai_model_registry_legacy_archive`;
      notices.length = 0;
      await tx.unsafe(migration);
      const [after] = await tx`SELECT count(*)::int AS n FROM ai_model_registry_legacy_archive`;
      expect(after!.n).toBe(before!.n);
      expect(notices).toContainEqual(expect.stringContaining('partner_llm_configs already dropped; archived 0'));
      expect(notices).toContainEqual(expect.stringContaining('ai_agents.model already dropped; archived 0'));
      expect(notices).toContainEqual(expect.stringContaining('legacy AI model config dropped'));
    });
  });

  it('a column already dropped by hand is skipped, the rest archived — never refused', async () => {
    const migration = await loadMigration();
    await inRolledBackTx(async (tx, notices) => {
      await tx`SELECT set_config('breeze.scope', 'system', true)`;
      await tx.unsafe(RESTORE_AI_MODEL_LEGACY_CONFIG_SQL);
      const s = await seed(tx);
      await tx.unsafe('ALTER TABLE ai_script_policies DROP COLUMN reviewer_model');
      await tx.unsafe('DROP TABLE ai_model_registry_state');
      await expect(tx.unsafe(migration)).resolves.toBeDefined();
      expect(await archiveKeys(tx, s.a.partnerId))
        .toEqual(s.expected[s.a.partnerId]!.filter((k) => k !== 'ai_script_policies.reviewer_model').sort());
      expect(await archiveKeys(tx, s.b.partnerId)).toEqual([...s.expected[s.b.partnerId]!].sort());
      expect(await legacyObjects(tx)).toEqual({ llm_configs: false, state: false, compat_uq: false, columns: 0 });
      expect(notices).toContainEqual(expect.stringContaining('ai_script_policies.reviewer_model already dropped; archived 0'));
    });
  });

  it('the archive insert sees rows under FORCE RLS only because it elects system scope', async () => {
    const migration = await loadMigration();
    const block = migration.match(/-- 3\) Archive[\s\S]*?END \$\$;/)?.[0];
    expect(block, 'archive block not found').toBeDefined();
    const election = "PERFORM set_config('breeze.scope', 'system', true);";
    expect(block).toContain(election);
    const mutated = block!.replace(election, '');
    expect(mutated).not.toContain(election);
    const archiveDdl = migration.match(/-- 2\) The archive table[\s\S]*?(?=-- 3\) Archive)/)?.[0];
    expect(archiveDdl, 'archive DDL not found').toBeDefined();

    const runAsApp = async (archiveBlock: string) => {
      let archived = -1;
      await inRolledBackTx(async (tx) => {
        await tx`SELECT set_config('breeze.scope', 'system', true)`;
        await tx.unsafe(RESTORE_AI_MODEL_LEGACY_CONFIG_SQL);
        await tx.unsafe(archiveDdl!);
        const s = await seed(tx);
        await tx.unsafe('SET LOCAL ROLE breeze_app');
        await tx`SELECT set_config('breeze.scope', 'none', true)`;
        await tx.unsafe(archiveBlock);
        await tx.unsafe('RESET ROLE');
        await tx`SELECT set_config('breeze.scope', 'system', true)`;
        const [n] = await tx`SELECT count(*)::int AS n FROM ai_model_registry_legacy_archive
          WHERE partner_id IN (${s.a.partnerId}, ${s.b.partnerId})`;
        archived = n!.n as number;
      });
      return archived;
    };
    // Control: without the election, breeze_app archives nothing (the fail-open the election closes).
    expect(await runAsApp(mutated)).toBe(0);
    // Real block: every seeded value.
    expect(await runAsApp(block!)).toBe(10);
  });
});

describe('ai_model_registry_legacy_archive — partner-axis RLS', () => {
  const partnerA = randomUUID();
  const partnerB = randomUUID();
  const orgA = randomUUID();
  const partnerContext = (partnerId: string): DbAccessContext => ({
    scope: 'partner', orgId: null, accessibleOrgIds: [orgA], accessiblePartnerIds: [partnerId], currentPartnerId: partnerId, userId: null,
  });
  // An org token of partner A: the partner's legacy config is not its data, even for its own org.
  const orgContext: DbAccessContext = {
    scope: 'organization', orgId: orgA, accessibleOrgIds: [orgA], accessiblePartnerIds: [], currentPartnerId: partnerA, userId: null,
  };

  // Shared setup truncates partners before each test, so every case reseeds.
  beforeEach(async () => {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`INSERT INTO partners (id, name, slug, currency_code) VALUES
        (${partnerA}, 'Archive A', ${`w08b-a-${partnerA}`}, 'USD'), (${partnerB}, 'Archive B', ${`w08b-b-${partnerB}`}, 'USD')`);
      await db.execute(sql`INSERT INTO organizations (id, partner_id, name, slug, currency_code) VALUES (${orgA}, ${partnerA}, 'Archive org', ${`w08b-org-${orgA}`}, 'USD')`);
      await db.execute(sql`INSERT INTO ai_model_registry_legacy_archive (partner_id, org_id, source_table, source_id, source_column, value, had_cutover) VALUES
        (${partnerA}, NULL, 'partner_llm_configs', ${randomUUID()}, 'row', '{}'::jsonb, true),
        (${partnerA}, ${orgA}, 'ai_budgets', ${randomUUID()}, 'allowed_models', '[]'::jsonb, true)`);
    });
  });

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`DELETE FROM ai_model_registry_legacy_archive WHERE partner_id IN (${partnerA}, ${partnerB})`);
      await db.execute(sql`DELETE FROM organizations WHERE partner_id IN (${partnerA}, ${partnerB})`);
      await db.execute(sql`DELETE FROM partners WHERE id IN (${partnerA}, ${partnerB})`);
    });
  });

  const visible = (ctx: DbAccessContext) => withDbAccessContext(ctx, async () =>
    ((await db.execute(sql`SELECT count(*)::int AS n FROM ai_model_registry_legacy_archive
      WHERE partner_id IN (${partnerA}, ${partnerB})`)) as unknown as Array<{ n: number }>)[0]!.n);

  it('partner A sees its rows; partner B and an org token see none', async () => {
    expect(await visible(partnerContext(partnerA))).toBe(2);
    expect(await visible(partnerContext(partnerB))).toBe(0);
    expect(await visible(orgContext)).toBe(0);
  });

  it("partner B cannot forge a row into partner A's archive (42501)", async () => {
    await expect(withDbAccessContext(partnerContext(partnerB), () => db.execute(sql`
      INSERT INTO ai_model_registry_legacy_archive (partner_id, source_table, source_id, source_column, value, had_cutover)
      VALUES (${partnerA}, 'ai_agents', ${randomUUID()}, 'model', '"x"'::jsonb, true)`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('erasing the org removes its archive rows through the cascading composite FK (rollback safety, W08 D12)', async () => {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`DELETE FROM organizations WHERE id = ${orgA}`);
      const [row] = (await db.execute(sql`SELECT count(*)::int AS n FROM ai_model_registry_legacy_archive WHERE partner_id = ${partnerA}`)) as unknown as Array<{ n: number }>;
      expect(row!.n).toBe(1);
    });
  });
});
