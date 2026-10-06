/**
 * Self-hosted installs whose migration role is neither SUPERUSER nor
 * BYPASSRLS, and is not `breeze_app`.
 *
 * A policy declared `TO breeze_app` does not apply to any other role. Under
 * FORCE ROW LEVEL SECURITY such a table is therefore invisible to the
 * migration role (and to every SECURITY DEFINER function it owns) even after
 * `set_config('breeze.scope', 'system', true)`: no policy applies, so every
 * row is filtered. Two places depended on it:
 *
 *  1. 2026-11-12-110000-partner-llm-catalog-pin-default-model.sql ran before
 *     partner_llm_configs had a role-agnostic system policy, so on such an
 *     install it pinned 0 rows (#7618). The replay migration re-applies it.
 *  2. The multi-org report series guard triggers (SECURITY DEFINER, owned by
 *     whoever ran migrations) read `report_series`, whose only policy was
 *     `TO breeze_app`. Owned by any other NOBYPASSRLS role, the two
 *     same-partner guards rejected every valid write (23514) and the
 *     org-partner guard let an org change partner with targets attached.
 *
 * Every case runs as a NOSUPERUSER NOBYPASSRLS role created here, which is
 * deliberately not breeze_app. Report-series cases hand the trigger functions
 * to that role inside a transaction that is always rolled back.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganization, createPartner } from './db-utils';

const MIGRATIONS = join(__dirname, '../../../migrations');
const ORIGINAL_PIN = join(MIGRATIONS, '2026-11-12-110000-partner-llm-catalog-pin-default-model.sql');
const PIN_REPLAY = join(MIGRATIONS, '2026-12-13-100000-partner-llm-catalog-pin-default-model-replay.sql');
const REPORT_SERIES_READ = join(MIGRATIONS, '2026-12-13-100100-report-series-system-read-any-owner.sql');

const MIGRATOR = 'breeze_test_nonbypass_migrator';
const runDb = it.runIf(!!process.env.DATABASE_URL);

let admin: Sql;

class Rollback extends Error {}

/** Run `fn` in a transaction on the superuser connection and always roll it back. */
async function inRolledBackTx(fn: (tx: TransactionSql) => Promise<void>): Promise<void> {
  try {
    await admin.begin(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

/** `<sqlstate>:<constraint>` of the error `p` rejects with, or null if it resolved. */
async function sqlState(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string };
    return `${e.code ?? 'unknown'}:${e.constraint_name ?? ''}`;
  }
}

beforeAll(async () => {
  admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await admin.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATOR}') THEN
        CREATE ROLE ${MIGRATOR} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$;
  `);
  // The privileges a table-owning migrator has on everything it touches here.
  // RLS, not privilege, is what is under test.
  await admin.unsafe(`
    GRANT USAGE ON SCHEMA public TO ${MIGRATOR};
    GRANT SELECT, UPDATE ON public.partner_llm_configs, public.partner_ai_connections TO ${MIGRATOR};
    GRANT SELECT ON public.llm_provider_catalog, public.llm_provider_catalog_revisions TO ${MIGRATOR};
    GRANT SELECT, DELETE ON public.report_series_org_targets TO ${MIGRATOR};
    GRANT SELECT, UPDATE ON public.reports TO ${MIGRATOR};
    GRANT SELECT ON public.report_series, public.organizations TO ${MIGRATOR};
  `);
});

afterAll(async () => {
  if (!admin) return;
  await admin.unsafe(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATOR}') THEN
        EXECUTE 'DROP OWNED BY ${MIGRATOR}';
        EXECUTE 'DROP ROLE ${MIGRATOR}';
      END IF;
    END $$;
  `);
  await admin.end();
});

describe('migration role is NOSUPERUSER NOBYPASSRLS and not breeze_app', () => {
  runDb('precondition: the test migrator neither bypasses RLS nor is breeze_app', async () => {
    const [role] = await admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${MIGRATOR}`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  describe('catalog default-model pin (#7618)', () => {
    async function seedCatalogPartner(mapsSonnet46: boolean) {
      const partner = await createPartner();
      const entryId = randomUUID();
      const revisionId = randomUUID();
      const configId = randomUUID();
      const modelMap = mapsSonnet46
        ? { 'claude-sonnet-4-6': 'vendor/sonnet-4-6' }
        : { 'claude-opus-4-6': 'vendor/opus-4-6' };
      await admin`INSERT INTO llm_provider_catalog (id, slug, name, status)
        VALUES (${entryId}, ${`pin-test-${entryId}`}, 'Pin test endpoint', 'listed')`;
      await admin`INSERT INTO llm_provider_catalog_revisions (id, catalog_entry_id, revision, base_url, auth_mode, model_map)
        VALUES (${revisionId}, ${entryId}, 1, 'https://llm.example.test', 'x-api-key', ${admin.json(modelMap)})`;
      await admin`UPDATE llm_provider_catalog SET active_revision_id = ${revisionId} WHERE id = ${entryId}`;
      await admin`INSERT INTO partner_llm_configs (id, partner_id, api_key_encrypted, key_last4, key_fingerprint, catalog_entry_id)
        VALUES (${configId}, ${partner.id}, 'ciphertext', 'abcd', 'fp', ${entryId})`;
      await admin`INSERT INTO partner_ai_connections (id, partner_id, kind, name, api_key_encrypted, key_last4, key_fingerprint, catalog_entry_id)
        VALUES (${configId}, ${partner.id}, 'catalog', 'Pin test endpoint', 'ciphertext', 'abcd', 'fp', ${entryId})`;
      return { configId, entryId };
    }

    async function readPin(configId: string) {
      const [cfg] = await admin<{ default_model: string | null; config_version: number }[]>`
        SELECT default_model, config_version FROM partner_llm_configs WHERE id = ${configId}`;
      const [conn] = await admin<{ legacy_default_model: string | null }[]>`
        SELECT legacy_default_model FROM partner_ai_connections WHERE id = ${configId}`;
      return { ...cfg!, legacy_default_model: conn!.legacy_default_model };
    }

    async function applyAsMigrator(file: string) {
      await admin.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${MIGRATOR}`);
        await tx.unsafe(readFileSync(file, 'utf8'));
      });
    }

    async function cleanupCatalog(entryIds: string[]) {
      await admin`DELETE FROM partner_ai_connections WHERE catalog_entry_id = ANY(${entryIds}::uuid[])`;
      await admin`DELETE FROM partner_llm_configs WHERE catalog_entry_id = ANY(${entryIds}::uuid[])`;
      await admin`UPDATE llm_provider_catalog SET active_revision_id = NULL WHERE id = ANY(${entryIds}::uuid[])`;
      await admin`DELETE FROM llm_provider_catalog WHERE id = ANY(${entryIds}::uuid[])`;
    }

    runDb('control: the shipped pin matches nothing for this role while partner_llm_configs has only its breeze_app policy', async () => {
      const seeded = await seedCatalogPartner(true);
      try {
        await inRolledBackTx(async (tx) => {
          // Recreate the database as it was when the shipped pin ran: the
          // role-agnostic system policy arrived two days later (2026-11-14).
          await tx.unsafe('DROP POLICY partner_llm_configs_system_only ON public.partner_llm_configs');
          await tx.unsafe(`SET LOCAL ROLE ${MIGRATOR}`);
          await tx.unsafe(readFileSync(ORIGINAL_PIN, 'utf8'));
          await tx.unsafe('RESET ROLE');
          const [row] = await tx<{ default_model: string | null }[]>`
            SELECT default_model FROM partner_llm_configs WHERE id = ${seeded.configId}`;
          expect(row!.default_model).toBeNull();
        });
      } finally {
        await cleanupCatalog([seeded.entryId]);
      }
    });

    runDb('the replay pins tracking catalog rows and their connection mirror, leaves the rest alone, and is idempotent', async () => {
      const tracking = await seedCatalogPartner(true);
      const unmapped = await seedCatalogPartner(false);
      try {
        await applyAsMigrator(PIN_REPLAY);

        expect(await readPin(tracking.configId)).toEqual({
          default_model: 'claude-sonnet-4-6',
          config_version: 2,
          legacy_default_model: 'claude-sonnet-4-6',
        });
        // Its revision does not map claude-sonnet-4-6: it was never served it.
        expect(await readPin(unmapped.configId)).toEqual({
          default_model: null,
          config_version: 1,
          legacy_default_model: null,
        });

        await applyAsMigrator(PIN_REPLAY);
        expect((await readPin(tracking.configId)).config_version).toBe(2);
      } finally {
        await cleanupCatalog([tracking.entryId, unmapped.entryId]);
      }
    });
  });

  describe('report series guard triggers owned by that role', () => {
    const GUARDS = [
      'breeze_report_series_target_partner_guard()',
      'breeze_report_series_child_partner_guard()',
      'breeze_report_series_org_partner_guard()',
      'breeze_report_series_target_mode_reset()',
      'breeze_report_series_archive_children()',
    ];

    async function seedSeries() {
      const partner = await createPartner();
      const otherPartner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const seriesId = randomUUID();
      await admin`INSERT INTO report_series (id, partner_id, name, type, schedule)
        VALUES (${seriesId}, ${partner.id}, 'Monthly inventory', 'device_inventory', 'monthly')`;
      return { partnerId: partner.id, otherPartnerId: otherPartner.id, orgId: org.id, seriesId };
    }

    /** Own the guard functions as MIGRATOR, then act as breeze_app in the partner's request context. */
    async function asPartnerRequest(tx: TransactionSql, partnerId: string, orgId: string) {
      for (const fn of GUARDS) {
        await tx.unsafe(`ALTER FUNCTION public.${fn} OWNER TO ${MIGRATOR}`);
      }
      await tx.unsafe('SET LOCAL ROLE breeze_app');
      await tx`SELECT set_config('breeze.scope', 'partner', true),
                      set_config('breeze.accessible_partner_ids', ${partnerId}, true),
                      set_config('breeze.accessible_org_ids', ${orgId}, true)`;
    }

    runDb('a same-partner target is accepted', async () => {
      const s = await seedSeries();
      await inRolledBackTx(async (tx) => {
        await asPartnerRequest(tx, s.partnerId, s.orgId);
        expect(await sqlState(tx`INSERT INTO report_series_org_targets (series_id, org_id)
          VALUES (${s.seriesId}, ${s.orgId})`)).toBeNull();
      });
    });

    runDb('a same-partner series child is accepted', async () => {
      const s = await seedSeries();
      await inRolledBackTx(async (tx) => {
        await asPartnerRequest(tx, s.partnerId, s.orgId);
        expect(await sqlState(tx`INSERT INTO reports (org_id, name, type, schedule, series_id, series_revision)
          VALUES (${s.orgId}, 'Monthly inventory', 'device_inventory', 'monthly', ${s.seriesId}, 0)`)).toBeNull();
      });
    });

    runDb('an org with series targets still cannot change partner', async () => {
      const s = await seedSeries();
      await admin`INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${s.seriesId}, ${s.orgId})`;
      await inRolledBackTx(async (tx) => {
        for (const fn of GUARDS) {
          await tx.unsafe(`ALTER FUNCTION public.${fn} OWNER TO ${MIGRATOR}`);
        }
        await tx.unsafe('SET LOCAL ROLE breeze_app');
        await tx`SELECT set_config('breeze.scope', 'system', true)`;
        expect(await sqlState(tx`UPDATE organizations SET partner_id = ${s.otherPartnerId} WHERE id = ${s.orgId}`))
          .toBe('23514:organizations_partner_report_series_guard');
      });
    });

    runDb('a cross-partner target is still rejected', async () => {
      const s = await seedSeries();
      const foreignOrg = await createOrganization({ partnerId: s.otherPartnerId });
      await inRolledBackTx(async (tx) => {
        await asPartnerRequest(tx, s.partnerId, `${s.orgId},${foreignOrg.id}`);
        expect(await sqlState(tx`INSERT INTO report_series_org_targets (series_id, org_id)
          VALUES (${s.seriesId}, ${foreignOrg.id})`)).toBe('23514:report_series_org_targets_same_partner');
      });
    });

    runDb('the system read branch adds nothing for a caller outside system scope', async () => {
      const s = await seedSeries();
      await inRolledBackTx(async (tx) => {
        // Grant UPDATE so that RLS, not privilege, decides the write below.
        await tx.unsafe(`GRANT UPDATE ON public.report_series TO ${MIGRATOR}`);
        await tx.unsafe(`SET LOCAL ROLE ${MIGRATOR}`);
        const [blind] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM report_series WHERE id = ${s.seriesId}`;
        expect(blind!.n).toBe(0);
        await tx`SELECT set_config('breeze.scope', 'system', true)`;
        const [sys] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM report_series WHERE id = ${s.seriesId}`;
        expect(sys!.n).toBe(1);
        // SELECT only: no write is opened up, even in system scope.
        const updated = await tx`UPDATE report_series SET name = 'renamed' WHERE id = ${s.seriesId}`;
        expect(updated.count).toBe(0);
      });
    });

    runDb('the policy migration is idempotent', async () => {
      const sql = readFileSync(REPORT_SERIES_READ, 'utf8');
      await admin.unsafe(sql);
      await admin.unsafe(sql);
      const rows = await admin<{ cmd: string; roles: string[] }[]>`
        SELECT cmd, roles::text[] AS roles FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'report_series' AND policyname = 'report_series_system_read'`;
      expect(rows).toEqual([{ cmd: 'SELECT', roles: ['public'] }]);
    });
  });
});
