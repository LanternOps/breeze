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
 *    the billing-credit deduction path (recordUsage() never calls it, but the
 *    unit suites mock recordUsage itself, which would hide a regression that
 *    wired deduction into it);
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
import { beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
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

async function ensureWorkspaceSchema(): Promise<void> {
  const adminUrl =
    process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
  const admin = postgres(adminUrl, { max: 1 });
  try {
    for (const filename of REQUIRED_WORKSPACE_MIGRATIONS) {
      const content = readFileSync(join(WORKSPACE_MIGRATIONS_DIR, filename), 'utf8');
      await admin.begin((tx) => tx.unsafe(content));
    }
  } finally {
    await admin.end();
  }
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
        const enrichment = createEnrichmentService(db, { invoke: ai.invoke });

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
