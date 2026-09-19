import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { llmProviderCatalog, partnerLlmConfigs } from '../../db/schema';
import { resolveLlmConfig } from '../../services/llm/llmConfigResolver';
import {
  createCatalogEntry,
  createRevision,
  activateRevision,
  recordVerification,
  setEntryStatus,
} from '../../services/llmProviderCatalog';
import { columnAad, encryptedColumnRegistry, type EncryptedColumnSpec } from '../../services/encryptedColumnRegistry';
import { encryptSecret } from '../../services/secretCrypto';
import { __setLookupForTests } from '../../services/urlSafety';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function partnerContext(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [],
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
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

const MODEL_ID = 'claude-sonnet-4-6';

const API_KEY_SPEC: EncryptedColumnSpec = (() => {
  const spec = encryptedColumnRegistry.find(
    (entry) => entry.table === 'partner_llm_configs' && entry.column === 'api_key_encrypted',
  );
  if (!spec) throw new Error('partner_llm_configs.api_key_encrypted is missing from encryptedColumnRegistry');
  return spec;
})();

function encryptedApiKey(id: string, apiKey: string): string {
  const encrypted = encryptSecret(apiKey, { aad: columnAad(API_KEY_SPEC, id) });
  if (!encrypted) throw new Error('test setup: could not encrypt fixture API key');
  return encrypted;
}

/**
 * Builds a fully listed, verified catalog entry a partner could actually
 * select: entry -> revision (mapping MODEL_ID) -> passing verification ->
 * active revision -> status 'listed'. Mirrors the platform-admin CRUD flow
 * (Task 1.3) end to end against a real database, using the same service
 * functions the admin routes call.
 */
async function seedListedEntry(createdBy: string): Promise<{ entryId: string; revisionId: string }> {
  const { id: entryId } = await createCatalogEntry({
    slug: `openrouter-${randomUUID()}`,
    name: 'OpenRouter (integration test)',
  });
  const { id: revisionId } = await createRevision({
    entryId,
    baseUrl: 'https://openrouter.ai/api/v1',
    authMode: 'x-api-key',
    modelMap: {
      [MODEL_ID]: {
        providerModel: 'anthropic/claude-sonnet-4-6',
        inputCentsPerM: 300,
        outputCentsPerM: 1500,
        cacheReadCentsPerM: 30,
        cacheWriteCentsPerM: 375,
      },
    },
    createdBy,
  });
  await recordVerification({ revisionId, modelId: MODEL_ID, passed: true, verifiedBy: createdBy });
  await activateRevision({ entryId, revisionId });
  await setEntryStatus({ entryId, status: 'listed' });
  return { entryId, revisionId };
}

describe('LLM catalog selection (#3922 W3, Task 3.4)', () => {
  const previousFlag = process.env.LLM_PROVIDER_CATALOG_ENABLED;

  beforeAll(() => {
    process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
    // createRevision's baseUrl validation runs a real SSRF/DNS safety check
    // (assertSafeUrl); pin the lookup to a genuinely public IP (1.1.1.1) so
    // this suite never depends on live DNS for openrouter.ai. TEST-NET/
    // documentation ranges (203.0.113.0/24 etc.) are themselves blocked by
    // urlSafety, so a real public unicast address is required here.
    __setLookupForTests(async () => [{ address: '1.1.1.1', family: 4 }]);
  });

  afterAll(() => {
    __setLookupForTests(null);
    if (previousFlag === undefined) delete process.env.LLM_PROVIDER_CATALOG_ENABLED;
    else process.env.LLM_PROVIDER_CATALOG_ENABLED = previousFlag;
  });

  // =========================================================================
  // Cross-partner forge: even with the catalog_entry_id column in play, the
  // existing partner-axis RLS policy on partner_llm_configs must still reject
  // a write that names another partner's id.
  // =========================================================================
  runDb('rejects a forged cross-partner endpoint selection with 42501', async () => {
    const { partnerA, partnerB, entry } = await withSystemDbAccessContext(async () => {
      const partnerA = await createPartner();
      const partnerB = await createPartner();
      const user = await createUser({ partnerId: partnerA.id });
      const entry = await seedListedEntry(user.id);
      return { partnerA, partnerB, entry };
    });

    await expect(
      withDbAccessContext(partnerContext(partnerA.id), () =>
        db.insert(partnerLlmConfigs).values({
          partnerId: partnerB.id,
          catalogEntryId: entry.entryId,
          apiKeyEncrypted: 'enc:forge-test',
          keyLast4: 'test',
          keyFingerprint: `forge-${randomUUID()}`,
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // =========================================================================
  // Delist-after-select: the resolver must fail closed the moment an entry a
  // partner is already pinned to stops being listed — never silently keep
  // routing traffic to a delisted third party, and never fall back to the
  // platform key.
  // =========================================================================
  runDb('a delisted entry makes the resolver fail closed with provider_delisted for an already-pinned partner', async () => {
    const { partner, entry } = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const user = await createUser({ partnerId: partner.id });
      const entry = await seedListedEntry(user.id);
      return { partner, entry };
    });

    const configId = randomUUID();
    const apiKey = 'sk-ant-integration-test-key-1234567890';
    await withSystemDbAccessContext(() =>
      db.insert(partnerLlmConfigs).values({
        id: configId,
        partnerId: partner.id,
        apiKeyEncrypted: encryptedApiKey(configId, apiKey),
        keyLast4: apiKey.slice(-4),
        keyFingerprint: `integration-${randomUUID()}`,
        status: 'active',
        defaultModel: MODEL_ID,
        catalogEntryId: entry.entryId,
      }),
    );

    const beforeDelist = await resolveLlmConfig(partner.id);
    expect(beforeDelist).toMatchObject({
      source: 'partner',
      partnerId: partner.id,
      endpoint: { kind: 'catalog', catalogEntryId: entry.entryId, revisionId: entry.revisionId },
    });

    await setEntryStatus({ entryId: entry.entryId, status: 'delisted' });

    const afterDelist = await resolveLlmConfig(partner.id);
    expect(afterDelist).toEqual({
      source: 'unavailable',
      partnerId: partner.id,
      reason: 'provider_delisted',
    });
  });

  // =========================================================================
  // Catalog-table write posture: llm_provider_catalog ships with NO RLS at
  // all (see `2026-09-12-llm-provider-catalog.sql`'s own header comment —
  // this mirrors `third_party_package_catalog` exactly, per Task 1.1's
  // instruction to copy that table's posture rather than assume one).
  // Access control is entirely at the route layer (platform-admin role + MFA
  // + requireMfa on the CRUD routes), NOT the database. Pinning that fact
  // here means a future migration that silently adds a broken/half RLS
  // policy — or one that assumes RLS already protects this table — gets
  // caught instead of discovered in production.
  // =========================================================================
  runDb('llm_provider_catalog carries no RLS — the route layer, not the database, is the only gate', async () => {
    const rows = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls_on, c.relforcerowsecurity AS force_on
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('llm_provider_catalog', 'llm_provider_catalog_revisions', 'llm_provider_verifications')
      ORDER BY c.relname;
    `))) as unknown as Array<{ table_name: string; rls_on: boolean; force_on: boolean }>;

    expect(rows.map((r) => r.table_name)).toEqual([
      'llm_provider_catalog',
      'llm_provider_catalog_revisions',
      'llm_provider_verifications',
    ]);
    for (const row of rows) {
      expect(row.rls_on).toBe(false);
      expect(row.force_on).toBe(false);
    }
  });

  runDb('a tenant-scoped breeze_app connection can still write llm_provider_catalog directly, proving the route layer — not RLS — is what protects it', async () => {
    const org = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      return createOrganization({ partnerId: partner.id });
    });

    const slug = `posture-check-${randomUUID()}`;
    const [row] = await withDbAccessContext(orgContext(org.id), () =>
      db.insert(llmProviderCatalog).values({ slug, name: 'Posture check' }).returning({ id: llmProviderCatalog.id }),
    );
    expect(row?.id).toBeDefined();

    await withSystemDbAccessContext(() =>
      db.delete(llmProviderCatalog).where(eq(llmProviderCatalog.id, row!.id)),
    );
  });
});
