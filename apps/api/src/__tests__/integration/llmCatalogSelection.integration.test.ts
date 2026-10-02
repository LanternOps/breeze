import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

// The key probe is the only network call; the discovery queue needs Redis.
vi.mock('../../services/aiModels/connectionProbe', async (orig) => ({
  ...(await orig<typeof import('../../services/aiModels/connectionProbe')>()),
  probeAnthropicKey: vi.fn(async () => undefined),
}));
vi.mock('../../jobs/aiModelDiscoveryWorker', () => ({ enqueueConnectionSync: vi.fn(async () => undefined) }));
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { llmProviderCatalog, partnerAiConnections } from '../../db/schema';
import { changeAnthropicEndpoint } from '../../services/aiModels/anthropicConnectionWrites';
import { probeAnthropicKey } from '../../services/aiModels/connectionProbe';
import {
  createCatalogEntry,
  createRevision,
  activateRevision,
  recordVerification,
  setEntryStatus,
} from '../../services/llmProviderCatalog';
import { __setLookupForTests } from '../../services/urlSafety';
import { createOrganization, createPartner, createUser } from './db-utils';
import { fixtureSql } from './aiModelRegistryFixtures';
import { seedListedCatalogEntry, seedPricedPlatformModel as seedW03PlatformModel, seedRegistryPartner } from './helpers/aiModelRegistrySeed';
import { resolveModel } from '../../services/aiModels/resolveModel';

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
  // partner-axis RLS policy on partner_ai_connections must still reject
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
        db.insert(partnerAiConnections).values({
          partnerId: partnerB.id,
          kind: 'catalog',
          name: 'forge-test',
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
  runDb('a delisted entry makes the resolver fail closed for a partner already routed through it — never the platform key', async () => {
    const s = await seedRegistryPartner('catalog');
    const chat = () => resolveModel({ partnerId: s.partnerId, orgId: s.orgId, surface: 'chat' });

    expect(await chat()).toMatchObject({ ok: true, funding: 'partner_key', connection: { id: s.connectionId } });

    await setEntryStatus({ entryId: s.catalogEntryId!, status: 'delisted' });

    // Fail closed on the connection's catalog revision: no silent fallback to platform funding.
    expect(await chat()).toMatchObject({ ok: false, reason: 'model_unavailable' });
  });

  // =========================================================================
  // W08 (#7606): endpoint selection is id-keyed and validates the partner's
  // chat default model (the per-connection pinned model is gone); a BYOK <->
  // catalog switch converts the connection IN PLACE.
  // =========================================================================
  const connectionState = async (id: string) => (await fixtureSql`
    SELECT kind, catalog_entry_id, api_key_encrypted, config_version, status FROM partner_ai_connections WHERE id = ${id}`)[0]!;
  const offeringsOn = (connectionId: string) => fixtureSql`
    SELECT id, model_id, source, platform_model_id, enabled,
           num_nonnulls(price_input_cents_per_m, price_output_cents_per_m, price_cache_read_cents_per_m, price_cache_write_cents_per_m) AS priced,
           capabilities
      FROM partner_ai_models WHERE connection_id = ${connectionId} ORDER BY id`;
  const assignmentDefaults = (partnerId: string) => fixtureSql`
    SELECT id, default_offering_id, fallback_offering_ids FROM ai_model_assignments WHERE offering_partner_id = ${partnerId} ORDER BY id`;

  runDb('a catalog switch validates the partner chat default model: unmapped on the revision → 409, nothing written or probed', async () => {
    const s = await seedRegistryPartner('byok');
    // The revision maps (and verifies) a different platform model only.
    const otherModel = `not-the-chat-model-${randomUUID()}`;
    await seedW03PlatformModel(otherModel);
    const entryId = await seedListedCatalogEntry([otherModel], s.userId);
    const before = await connectionState(s.connectionId!);
    const offeringsBefore = await offeringsOn(s.connectionId!);
    vi.mocked(probeAnthropicKey).mockClear();

    await expect(changeAnthropicEndpoint({
      partnerId: s.partnerId, connectionId: s.connectionId!, catalogEntryId: entryId, acknowledgeDataNote: true, userId: s.userId,
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('does not currently support your configured AI model') });

    expect(probeAnthropicKey).not.toHaveBeenCalled();
    expect(await connectionState(s.connectionId!)).toEqual(before);
    expect(await offeringsOn(s.connectionId!)).toEqual(offeringsBefore);
  });

  runDb('a BYOK → catalog switch is in place: same id, same key ciphertext, every assignment unchanged; offerings take the catalog shape; config_version + 1', async () => {
    const s = await seedRegistryPartner('byok');
    const entryId = await seedListedCatalogEntry([s.modelId], s.userId);
    const before = await connectionState(s.connectionId!);
    const assignmentsBefore = await assignmentDefaults(s.partnerId);

    const result = await changeAnthropicEndpoint({
      partnerId: s.partnerId, connectionId: s.connectionId!, catalogEntryId: entryId, acknowledgeDataNote: true, userId: s.userId,
    });

    expect(result).toMatchObject({ connectionId: s.connectionId, catalogEntryId: entryId, configVersion: before.config_version + 1 });
    expect(await connectionState(s.connectionId!)).toEqual({
      kind: 'catalog', catalog_entry_id: entryId, api_key_encrypted: before.api_key_encrypted,
      config_version: before.config_version + 1, status: 'active',
    });
    expect(await assignmentDefaults(s.partnerId)).toEqual(assignmentsBefore);
    const offerings = await offeringsOn(s.connectionId!);
    expect(offerings.map((o) => o.id)).toEqual([s.offeringId]);
    expect(offerings[0]).toMatchObject({ source: 'catalog', platform_model_id: null, priced: 0, capabilities: null, enabled: true });
    // Only one Anthropic connection row exists: nothing was created next to it.
    expect(await fixtureSql`SELECT 1 FROM partner_ai_connections WHERE partner_id = ${s.partnerId}`).toHaveLength(1);
    // The registry routes chat through the same connection, now the catalog endpoint, on the partner's key.
    expect(await resolveModel({ partnerId: s.partnerId, orgId: s.orgId, surface: 'chat' })).toMatchObject({
      ok: true, funding: 'partner_key', logicalModel: s.modelId,
    });
  });

  runDb('catalog → direct relinks each offering to its platform row (discovered) and disables one whose model has no platform row', async () => {
    const s = await seedRegistryPartner('catalog');
    const orphanModel = `gw-only-${randomUUID()}`;
    const [orphan] = await fixtureSql`
      INSERT INTO partner_ai_models (partner_id, connection_id, model_id, source, enabled)
      VALUES (${s.partnerId}, ${s.connectionId}, ${orphanModel}, 'catalog', true) RETURNING id`;
    const before = await connectionState(s.connectionId!);
    const assignmentsBefore = await assignmentDefaults(s.partnerId);

    const result = await changeAnthropicEndpoint({
      partnerId: s.partnerId, connectionId: s.connectionId!, catalogEntryId: null, acknowledgeDataNote: false, userId: s.userId,
    });

    expect(result).toEqual({ connectionId: s.connectionId, catalogEntryId: null, configVersion: before.config_version + 1, slug: null, revision: null });
    expect(await connectionState(s.connectionId!)).toEqual({
      kind: 'anthropic_byok', catalog_entry_id: null, api_key_encrypted: before.api_key_encrypted,
      config_version: before.config_version + 1, status: 'active',
    });
    expect(await assignmentDefaults(s.partnerId)).toEqual(assignmentsBefore);
    const byId = new Map((await offeringsOn(s.connectionId!)).map((o) => [o.id, o]));
    expect(byId.get(s.offeringId)).toMatchObject({ source: 'discovered', platform_model_id: s.platformModelId, enabled: true, priced: 0 });
    expect(byId.get(String(orphan!.id))).toMatchObject({ source: 'manual', platform_model_id: null, enabled: false, priced: 0 });
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
