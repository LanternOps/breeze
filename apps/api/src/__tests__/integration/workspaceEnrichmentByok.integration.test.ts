/**
 * Integration proof for #3917: `ee/workspace` content enrichment must honor a
 * partner's BYOK Anthropic key when one is configured, get real cost tracking
 * for it (billing_source = 'partner_key'), and never silently fall back to
 * the platform key when the BYOK config breaks.
 *
 * This drives the REAL host capability (`buildExtensionAiContext`, the same
 * function `stageExtension.ts` wires onto `context.ai` for every built-in
 * extension) into the REAL `ee/workspace` enrichment service against real
 * Postgres + Redis. Only the Anthropic client is stubbed, at the resolver
 * boundary (`Anthropic.Messages.prototype.create` — shared across every
 * `new Anthropic(...)` instance the resolver constructs, platform or partner)
 * — see `catalogEnrichmentService.ts`/`llmConfigResolver.ts` for why that
 * class-prototype method is the right seam instead of mocking `@anthropic-ai/sdk`
 * wholesale (this suite still needs the SDK's real `APIError` etc. elsewhere).
 *
 * Two assertions the mocked unit suites (extensionAi.test.ts,
 * enrichmentService.test.ts) cannot make on their own:
 *  - the FULL chain (resolver -> rate limit -> budget -> Anthropic call ->
 *    recordUsage) actually lands a real `ai_cost_usage` row tagged
 *    billing_source='partner_key' for a real BYOK partner, with zero calls to
 *    the billing-credit deduction path — the host DOES draw prepaid credits
 *    down for platform-funded extension spend, so this proves the partner-key
 *    branch is excluded from it end to end (the unit suites mock both
 *    recordUsage and the deduction, so only this one exercises the real wiring);
 *  - flipping the partner's config to status='error' makes the run fail LOUD
 *    (a visible TransientIngestError, mapped by the ingest runner to a
 *    transient release / by the admin route to a 503) instead of quietly
 *    reusing the platform key — the phase-1 BYOK invariant this whole feature
 *    must never violate.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import Anthropic from '@anthropic-ai/sdk';
import { createEnrichmentService } from '@breeze/ext-workspace/src/services/enrichmentService';
import { TransientIngestError } from '@breeze/ext-workspace/src/services/ingestErrors';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { aiCostUsage, partnerLlmConfigs } from '../../db/schema';
import { buildExtensionAiContext } from '../../services/extensionAi';
import { columnAad, encryptedColumnRegistry } from '../../services/encryptedColumnRegistry';
import { encryptSecret, hmacFingerprint } from '../../services/secretCrypto';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/**
 * `ee/workspace`'s tables (workspace_sources, workspace_file_content, ...)
 * are NOT applied by this suite's own `globalSetup` — that runs core
 * `autoMigrate()` only. In real deployments and in CI, they are created by
 * `loadBuiltinExtensions()`, which runs exclusively at actual `apps/api`
 * server boot (`src/index.ts`) with `BREEZE_WORKSPACE_ENABLED=true` — see the
 * "Boot API once to apply built-in extension migrations (ee)" step in
 * `.github/workflows/ci.yml`, which runs AFTER this package's own
 * `test:integration` step, and only for shard 1. This suite's own DB
 * (whichever shard it lands on, or a bare local `pnpm test-stack up`, which
 * never boots the server at all) therefore cannot assume those tables exist.
 *
 * Rather than depend on CI step ordering (or add a cross-shard dependency
 * that doesn't exist today), this test applies the three ee/workspace
 * migration files its own fixtures touch directly against the admin
 * connection — the exact same idempotent per-file `tx.unsafe(content)`
 * mechanism `autoMigrate.ts` uses for core migrations. Every migration file
 * in this repo is written to be idempotent by contract, so re-applying here
 * is a safe no-op if the real boot step already ran on this DB, and the real
 * boot step re-applying afterwards (recording its own `breeze_migrations`
 * ledger rows) is equally a safe no-op against schema this already created.
 *
 * THE LEAK THIS FIXTURE MUST NOT CAUSE (CI run 33031202932, shard 4/4).
 * The `public` schema of the integration database is a SHARED, CONTRACT-CHECKED
 * namespace: `tenantCascade.integration.test.ts` enumerates every `org_id`-
 * columned public BASE TABLE in the live DB and fails when one isn't registered
 * in `getOrgCascadeDeleteOrder()`. Extension tables are deliberately absent from
 * that core list — registering them would break the sibling "no entry references
 * a non-existent table" assertion on every extension-less deployment — so tables
 * this fixture creates and LEAVES BEHIND red the core cascade contract for the
 * rest of the vitest run. That is exactly what happened: all eleven relations
 * below survived into `tenantCascade`'s enumeration and it reported ten of them
 * (`workspace_sources` was the only one it did not, being already covered).
 *
 * The fix is fixture hygiene, not cascade registration: this suite now owns the
 * full lifecycle of the schema it creates — a defensive drop in `beforeAll`
 * (so a crashed prior run cannot poison this one) and a mandatory drop in
 * `afterAll` that ASSERTS nothing survived. `vitest.integration.config.ts` sets
 * `fileParallelism: false` and `sequence.concurrent: false`, so no other suite
 * is running while this file holds the schema and an `afterAll` drop is
 * sufficient; a per-file throwaway database (the approach
 * `extensions/builtinTableProbe.integration.test.ts` takes) is not, because
 * unlike that probe this suite needs the FULL core schema — organizations,
 * partners, devices, ai_sessions, partner_llm_configs, ai_cost_usage, the
 * `breeze_app` role and the `breeze_has_org_access` helpers — i.e. a complete
 * 400+ file `autoMigrate()` replay per run, plus a `DATABASE_URL` swap before
 * the module-level `../../db` handle is constructed.
 *
 * WHY THE MIGRATION FILES AND NOT HAND-WRITTEN DDL. This is an integration
 * PROOF: the real `ee/workspace` enrichment service runs against the real
 * extension schema. Hand-copying a trimmed subset of the DDL here would let the
 * fixture drift silently away from the shipped migrations and quietly hollow
 * the proof out. The file set is already minimal — three of the extension's
 * eight migrations; the crawler/finder/chunks/ingest-jobs files are NOT applied.
 * `memory_blocks` and `workspace_file_activity` are unavoidable collateral of
 * `2026-07-10-workspace-foundation.sql` (which is also the only source of the
 * `workspace_sources`/`workspace_file_index` the fixtures need), and shipped
 * migrations must never be edited — so they are created and then dropped like
 * everything else, rather than skipped.
 */
const WORKSPACE_MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../ee/workspace/migrations',
);
const REQUIRED_WORKSPACE_MIGRATIONS = [
  '2026-07-10-workspace-foundation.sql',
  '2026-07-19-content.sql',
  '2026-07-24-org-settings-dlp.sql',
];

/**
 * The tables the three migrations above create — the DROP MECHANISM, not the
 * guard. Dropped in one statement with CASCADE, so declaration order is
 * irrelevant.
 *
 * This list used to be the contract as well, which made the teardown assertion
 * vacuous in exactly the case that matters: a migration that starts creating a
 * NEW table is invisible here, so the assertion below would have happily
 * reported "nothing survived" while the new relation leaked into `public` and
 * red `tenantCascade.integration.test.ts` minutes later, in another file. The
 * guard is now a before/after snapshot of every public BASE TABLE (see
 * `assertPublicSchemaRestored`), which needs no maintenance and catches any
 * table these migrations grow. Keeping this list current still matters — it is
 * what actually removes them — but forgetting to now fails HERE, by name.
 */
const WORKSPACE_FIXTURE_TABLES = [
  // 2026-07-10-workspace-foundation.sql
  'workspace_sources',
  'workspace_file_index',
  'workspace_file_activity',
  'memory_blocks',
  // 2026-07-19-content.sql
  'workspace_file_content',
  'workspace_content_entities',
  'workspace_file_enrichment',
  'workspace_projects',
  'workspace_project_crosswalk',
  'workspace_email_filings',
  // 2026-07-24-org-settings-dlp.sql
  'workspace_org_settings',
] as const;

/**
 * The enum types those same migrations create. Dropped after the tables so the
 * next `ensureWorkspaceSchema()` re-runs their `CREATE TYPE` branch from a
 * clean slate (in particular re-establishing `workspace_content_status`'s
 * `blocked_dlp` value, which `2026-07-24` adds via `ALTER TYPE ... ADD VALUE`).
 */
const WORKSPACE_FIXTURE_TYPES = [
  'workspace_source_kind',
  'workspace_source_status',
  'workspace_file_action',
  'workspace_content_status',
  'workspace_filing_status',
  'workspace_filing_confidence',
] as const;

async function withWorkspaceAdmin<T>(fn: (admin: Sql) => Promise<T>): Promise<T> {
  const adminUrl =
    process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

/** Idempotent teardown of everything `ensureWorkspaceSchema()` creates. */
async function dropWorkspaceSchema(): Promise<void> {
  await withWorkspaceAdmin(async (admin) => {
    await admin.unsafe(
      `DROP TABLE IF EXISTS ${WORKSPACE_FIXTURE_TABLES.join(', ')} CASCADE`,
    );
    await admin.unsafe(`DROP TYPE IF EXISTS ${WORKSPACE_FIXTURE_TYPES.join(', ')} CASCADE`);
  });
}

/** Every public BASE TABLE currently in the shared integration database. */
async function listPublicBaseTables(): Promise<Set<string>> {
  // Deliberately unparameterised + filtered in JS: binding a `text[]` into this
  // kind of probe is the exact shape that shipped `malformed array literal` once
  // before (see extensions/builtinTableProbe.integration.test.ts's header).
  const present = await withWorkspaceAdmin(
    (admin) => admin<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `,
  );
  return new Set(present.map((row) => row.table_name));
}

/**
 * The `public` schema this suite inherited, snapshotted before its own
 * migrations run. `null` when the suite is skipped for want of a DATABASE_URL.
 *
 * `vitest.integration.config.ts` sets `fileParallelism: false` and
 * `sequence.concurrent: false`, so nothing else is creating or dropping tables
 * between the two snapshots and set-equality is a sound contract.
 */
let publicTablesBeforeFixture: Set<string> | null = null;

/**
 * Proves the teardown actually landed — by COMPARING the schema, not by
 * re-reading the same hand-maintained list the drop used.
 *
 * Without a real comparison, a silently-failed drop resurfaces as a baffling
 * failure in a DIFFERENT file (`tenantCascade`) potentially minutes later. And
 * a list-based assertion cannot see the case most likely to happen: one of
 * these three shipped migrations growing a new `CREATE TABLE`, which would leak
 * while the assertion reported success. Set-equality against the pre-fixture
 * snapshot catches any table the migrations create, with no list to maintain,
 * and reports it here by name.
 */
async function assertPublicSchemaRestored(): Promise<void> {
  if (!publicTablesBeforeFixture) return;
  const after = await listPublicBaseTables();

  const leaked = [...after].filter((t) => !publicTablesBeforeFixture!.has(t)).sort();
  const removed = [...publicTablesBeforeFixture].filter((t) => !after.has(t)).sort();

  if (leaked.length > 0) {
    throw new Error(
      `workspaceEnrichmentByok teardown leaked tables into the shared integration ` +
        `database: ${leaked.join(', ')}. Every org_id-columned public table is ` +
        `enumerated by tenantCascade.integration.test.ts, so these WILL red the core ` +
        `GDPR cascade contract for the rest of this run. If a shipped ee/workspace ` +
        `migration grew a new table, add it to WORKSPACE_FIXTURE_TABLES.`,
    );
  }
  if (removed.length > 0) {
    throw new Error(
      `workspaceEnrichmentByok teardown dropped tables it did not create: ` +
        `${removed.join(', ')}. WORKSPACE_FIXTURE_TABLES names a relation that ` +
        `belongs to the CORE schema — the CASCADE drop just destroyed it for every ` +
        `suite that runs after this one.`,
    );
  }
}

/**
 * Bring the fixture schema up, snapshotting the inherited `public` schema in
 * between the defensive drop and the migrations.
 *
 * Snapshot ordering is load-bearing: it must come AFTER the defensive drop (a
 * previous run killed mid-flight leaves workspace tables behind, and baking
 * those into the baseline would make the teardown assertion accept them) and
 * BEFORE the migrations (so every relation they create counts as this suite's).
 */
async function ensureWorkspaceSchema(): Promise<void> {
  // Defensive: a run killed mid-flight (Ctrl-C, CI timeout, an unhandled
  // rejection before afterAll) leaves the schema behind. Start from a known
  // state rather than inheriting a half-migrated one.
  await dropWorkspaceSchema();
  publicTablesBeforeFixture = await listPublicBaseTables();
  await withWorkspaceAdmin(async (admin) => {
    for (const filename of REQUIRED_WORKSPACE_MIGRATIONS) {
      const content = readFileSync(join(WORKSPACE_MIGRATIONS_DIR, filename), 'utf8');
      await admin.begin((tx) => tx.unsafe(content));
    }
  });
}

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

const API_KEY_SPEC = encryptedColumnRegistry.find(
  (entry) => entry.table === 'partner_llm_configs' && entry.column === 'api_key_encrypted',
);
if (!API_KEY_SPEC) {
  throw new Error('partner_llm_configs.api_key_encrypted is missing from encryptedColumnRegistry');
}

// Real column-level encryption (row-bound AAD), mirroring
// partnerLlmConfig.ts's private encryptPartnerLlmApiKey — this suite needs a
// key that DECRYPTS successfully so the resolver actually reaches 'partner'
// source, unlike the RLS-only fixtures elsewhere that use a literal 'enc:...'
// string and never exercise decryption.
function encryptTestApiKey(id: string, apiKey: string): string {
  const encrypted = encryptSecret(apiKey, { aad: columnAad(API_KEY_SPEC!, id) });
  if (!encrypted) throw new Error('failed to encrypt test Anthropic API key');
  return encrypted;
}

function mockClassificationResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    usage: { input_tokens: 120, output_tokens: 40 },
  };
}

const CLASSIFICATION_JSON = JSON.stringify({
  docType: 'meeting notes',
  projectKey: null,
  projectLabel: null,
  docDate: null,
  confidence: 'low',
  people: [],
});

describe('workspace enrichment honors partner BYOK', () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) return;
    await ensureWorkspaceSchema();
  });

  // Registered inside the describe on purpose: suite-level afterAll hooks run
  // BEFORE the file-level ones `setup.ts` installs, so the shared pools are
  // still open and the drop cannot race pool teardown.
  afterAll(async () => {
    if (!process.env.DATABASE_URL) return;
    await dropWorkspaceSchema();
    await assertPublicSchemaRestored();
  });

  runDb(
    'BYOK partner: enrichment bills partner_key and never falls back to the platform key on a broken config',
    async () => {
      const createSpy = vi
        .spyOn(Anthropic.Messages.prototype, 'create')
        // @ts-expect-error - real SDK response type is far richer than this test needs
        .mockResolvedValue(mockClassificationResponse(CLASSIFICATION_JSON));

      const previousBillingUrl = process.env.BILLING_SERVICE_URL;
      const previousBillingKey = process.env.BILLING_SERVICE_API_KEY;
      process.env.BILLING_SERVICE_URL = 'https://billing.internal';
      process.env.BILLING_SERVICE_API_KEY = 'billing-key';
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(
            JSON.stringify({ allowed: true, remainingCredits: 1000, plan: 'pro' }),
            { status: 200 },
          ),
        );

      try {
        const { org, configId } = await withSystemDbAccessContext(async () => {
          const partner = await createPartner();
          const org = await createOrganization({ partnerId: partner.id });

          const configId = randomUUID();
          const apiKey = 'sk-ant-integration-test-key-0000000000';
          await db.insert(partnerLlmConfigs).values({
            id: configId,
            partnerId: partner.id,
            apiKeyEncrypted: encryptTestApiKey(configId, apiKey),
            keyLast4: apiKey.slice(-4),
            keyFingerprint: hmacFingerprint(apiKey),
            status: 'active',
          });

          await db.execute(sql`
            INSERT INTO workspace_org_settings (org_id, content_enabled)
            VALUES (${org.id}, true)
            ON CONFLICT (org_id) DO UPDATE SET content_enabled = true
          `);

          const sourceRows = (await db.execute(sql`
            INSERT INTO workspace_sources (org_id, kind, display_name, root_path, status)
            VALUES (${org.id}, 'local_profile', 'BYOK test source', '/tmp/byok-test', 'active')
            RETURNING id
          `)) as unknown as Array<{ id: string }>;
          const sourceId = sourceRows[0]!.id;

          // Two extracted-but-unenriched files: the first proves the success
          // path, the second stays pending so the fail-loud run below has
          // something real to attempt (a run with nothing pending would
          // trivially "succeed" without ever calling invoke()).
          const file1Rows = (await db.execute(sql`
            INSERT INTO workspace_file_index (org_id, source_id, rel_path, parent_path, name, is_dir)
            VALUES (${org.id}, ${sourceId}, 'a-first.txt', '', 'a-first.txt', false)
            RETURNING id
          `)) as unknown as Array<{ id: string }>;
          await db.execute(sql`
            INSERT INTO workspace_file_content (org_id, file_index_id, extracted_text, status)
            VALUES (${org.id}, ${file1Rows[0]!.id}, 'Meeting notes from the site visit on 2026-08-01.', 'extracted')
          `);

          const file2Rows = (await db.execute(sql`
            INSERT INTO workspace_file_index (org_id, source_id, rel_path, parent_path, name, is_dir)
            VALUES (${org.id}, ${sourceId}, 'b-second.txt', '', 'b-second.txt', false)
            RETURNING id
          `)) as unknown as Array<{ id: string }>;
          await db.execute(sql`
            INSERT INTO workspace_file_content (org_id, file_index_id, extracted_text, status)
            VALUES (${org.id}, ${file2Rows[0]!.id}, 'Transmittal letter for the second parcel review.', 'extracted')
          `);

          return { org, configId };
        });

        const ai = buildExtensionAiContext();
        // Same narrowing the host applies at registration (`asWorkspaceDatabase`):
        // ee/workspace types its handle as a schema-less PostgresJsDatabase.
        const enrichment = createEnrichmentService(
          db as unknown as Parameters<typeof createEnrichmentService>[0],
          { invoke: ai.invoke },
        );

        // --- Success: BYOK partner key resolves and bills partner_key ---
        const firstRun = await withDbAccessContext(orgContext(org.id), () =>
          enrichment.run(org.id, 1),
        );
        expect(firstRun.errors).toEqual([]);
        expect(firstRun.processed).toBe(1);
        expect(firstRun.remaining).toBe(1);
        expect(createSpy).toHaveBeenCalledTimes(1);

        const usageAfterSuccess = await withSystemDbAccessContext(() =>
          db
            .select({ billingSource: aiCostUsage.billingSource })
            .from(aiCostUsage)
            .where(and(eq(aiCostUsage.orgId, org.id), eq(aiCostUsage.period, 'daily'))),
        );
        expect(usageAfterSuccess).toEqual([{ billingSource: 'partner_key' }]);

        const deductCalls = fetchSpy.mock.calls.filter(([url]) =>
          String(url).includes('/ai-credits/deduct'),
        );
        expect(deductCalls).toHaveLength(0);

        // --- Fail-loud: a broken BYOK config aborts the run, never falls
        // back to the platform key ---
        await withSystemDbAccessContext(() =>
          db
            .update(partnerLlmConfigs)
            .set({ status: 'error', lastError: 'decrypt_failed' })
            .where(eq(partnerLlmConfigs.id, configId)),
        );

        await expect(
          withDbAccessContext(orgContext(org.id), () => enrichment.run(org.id, 5)),
        ).rejects.toThrow(TransientIngestError);

        // No fallback Anthropic call was attempted for the second file.
        expect(createSpy).toHaveBeenCalledTimes(1);

        const usageAfterFailure = await withSystemDbAccessContext(() =>
          db
            .select({ billingSource: aiCostUsage.billingSource })
            .from(aiCostUsage)
            .where(and(eq(aiCostUsage.orgId, org.id), eq(aiCostUsage.period, 'daily'))),
        );
        // Unchanged from the successful run, and critically: no 'platform' row.
        expect(usageAfterFailure).toEqual([{ billingSource: 'partner_key' }]);
        expect(usageAfterFailure.some((row) => row.billingSource === 'platform')).toBe(false);
      } finally {
        createSpy.mockRestore();
        fetchSpy.mockRestore();
        if (previousBillingUrl === undefined) delete process.env.BILLING_SERVICE_URL;
        else process.env.BILLING_SERVICE_URL = previousBillingUrl;
        if (previousBillingKey === undefined) delete process.env.BILLING_SERVICE_API_KEY;
        else process.env.BILLING_SERVICE_API_KEY = previousBillingKey;
      }
    },
  );
});
