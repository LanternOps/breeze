/**
 * W03 integration seed (#7601): ONE real partner wired end to end on the
 * registry: partner/org/user, a priced + offered platform row, an offering on
 * the requested kind of connection, a partner assignment for every tenant
 * surface, and a chat session bound to the offering. Connections and catalog
 * entries are built with the services the product uses (W02 createConnection,
 * the catalog admin services), not raw ciphertext. Plain rows go through the
 * W02 superuser fixture client. Not a test file.
 */
import { randomUUID } from 'node:crypto';
import { AI_SURFACES } from '@breeze/shared';
import { withSystemDbAccessContext } from '../../../db';
import { createConnection } from '../../../services/aiModels/connections';
import {
  activateRevision,
  createCatalogEntry,
  createRevision,
  recordVerification,
  setEntryStatus,
} from '../../../services/llmProviderCatalog';
import { __setLookupForTests } from '../../../services/urlSafety';
import { fixtureSql, seedOffering, seedPlatformModel } from '../aiModelRegistryFixtures';
import { createOrganization, createPartner, createUser } from '../db-utils';

export type RegistrySeedKind = 'platform' | 'byok' | 'catalog';

export interface SeededRegistryPartner {
  kind: RegistrySeedKind;
  partnerId: string;
  orgId: string;
  userId: string;
  connectionId: string | null;
  offeringId: string;
  platformModelId: string;
  modelId: string;
  catalogEntryId: string | null;
  chatSessionId: string;
}

/** Anthropic-shaped capabilities: adaptive thinking (tools default to supported, W01 D4). */
const SEED_CAPABILITIES = { thinking: { supported: true, types: { adaptive: { supported: true } } } };

/**
 * A platform row W03 can dispatch: priced, platform_offered, available. W02's
 * seedPlatformModel leaves it unpriced and unoffered, so price it here.
 */
export async function seedPricedPlatformModel(modelId = `w03-test-${randomUUID()}`): Promise<string> {
  const id = await seedPlatformModel(modelId);
  await fixtureSql`
    UPDATE ai_platform_models
       SET input_cents_per_m = 200, output_cents_per_m = 1000,
           cache_read_cents_per_m = 20, cache_write_cents_per_m = 250,
           capabilities = ${fixtureSql.json(SEED_CAPABILITIES)},
           platform_offered = true, lifecycle = 'available'
     WHERE id = ${id}`;
  return id;
}

/** A listed catalog entry whose active revision maps + verifies `modelIds`. */
export async function seedListedCatalogEntry(modelIds: string[], createdBy: string): Promise<string> {
  process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
  __setLookupForTests(async () => [{ address: '1.1.1.1', family: 4 }]);   // createRevision's SSRF check, no live DNS
  const { id: entryId } = await createCatalogEntry({ slug: `w03-${randomUUID()}`, name: 'W03 catalog (integration)' });
  const revisionId = await seedCatalogRevision(entryId, modelIds, createdBy);
  await activateRevision({ entryId, revisionId });
  await setEntryStatus({ entryId, status: 'listed' });
  return entryId;
}

/** A new verified revision on `entryId` mapping exactly `modelIds` (not activated). */
export async function seedCatalogRevision(entryId: string, modelIds: string[], createdBy: string): Promise<string> {
  const modelMap = Object.fromEntries(modelIds.map((m) => [m, {
    providerModel: `gw/${m}`, inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375,
  }]));
  const { id: revisionId } = await createRevision({
    entryId, baseUrl: 'https://gw.example.com/v1', authMode: 'x-api-key', modelMap, createdBy,
  });
  for (const modelId of modelIds) {
    await recordVerification({ revisionId, modelId, passed: true, verifiedBy: createdBy });
  }
  return revisionId;
}

/**
 * W06: put an EXISTING partner (e.g. one from setupTestEnvironment) on the
 * registry with a priced, enabled platform offering as the default of every
 * tenant surface, marked cut over. Returns the offering and its wire model id.
 */
export async function seedPlatformRegistryForPartner(partnerId: string): Promise<{ offeringId: string; modelId: string }> {
  const modelId = `w06-test-${randomUUID()}`;
  const platformModelId = await seedPricedPlatformModel(modelId);
  const offeringId = await seedOffering({ partnerId, platformModelId, enabled: true });
  for (const surface of AI_SURFACES) {
    if (surface === 'patch_test') continue;   // platform-only, no assignment
    await fixtureSql`
      INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, role, default_offering_id, allow_user_choice)
      VALUES (${partnerId}, ${partnerId}, ${surface}, 'default', ${offeringId}, true)`;
  }
  await fixtureSql`
    INSERT INTO ai_model_registry_partner_cutover (partner_id) VALUES (${partnerId}) ON CONFLICT DO NOTHING`;
  return { offeringId, modelId };
}

export async function seedRegistryPartner(kind: RegistrySeedKind): Promise<SeededRegistryPartner> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `w03-${randomUUID()}@example.com` });
  const modelId = `w03-test-${randomUUID()}`;
  const platformModelId = await seedPricedPlatformModel(modelId);

  let connectionId: string | null = null;
  let catalogEntryId: string | null = null;
  let offeringId: string;
  if (kind === 'platform') {
    offeringId = await seedOffering({ partnerId: partner.id, platformModelId, enabled: true });
  } else {
    if (kind === 'catalog') catalogEntryId = await seedListedCatalogEntry([modelId], user.id);
    const conn = await withSystemDbAccessContext(() => createConnection({
      partnerId: partner.id,
      kind: kind === 'byok' ? 'anthropic_byok' : 'catalog',
      name: `W03 ${kind}`,
      apiKey: `sk-w03-${randomUUID()}`,
      catalogEntryId,
      connectedBy: user.id,
      verifiedAt: new Date(),
    }));
    connectionId = conn.id;
    offeringId = await seedOffering({
      partnerId: partner.id,
      connectionId: conn.id,
      platformModelId: kind === 'byok' ? platformModelId : null,
      modelId,
      source: kind === 'byok' ? 'discovered' : 'catalog',
      enabled: true,
    });
  }

  for (const surface of AI_SURFACES) {
    if (surface === 'patch_test') continue;   // platform-only, no assignment
    await fixtureSql`
      INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, role, default_offering_id, allow_user_choice)
      VALUES (${partner.id}, ${partner.id}, ${surface}, 'default', ${offeringId}, true)`;
  }

  // The seeded registry IS this partner's authority (the post-cutover world,
  // Task 6A): mark it cut over so resolveModel's gate never re-projects it
  // from (empty) legacy config over the rows above.
  await fixtureSql`
    INSERT INTO ai_model_registry_partner_cutover (partner_id) VALUES (${partner.id}) ON CONFLICT DO NOTHING`;

  const [session] = await fixtureSql`
    INSERT INTO ai_sessions (org_id, user_id, type, model, offering_id, offering_partner_id, billing_source)
    VALUES (${org.id}, ${user.id}, 'general', ${modelId}, ${offeringId}, ${partner.id},
            ${kind === 'platform' ? 'platform' : 'partner_key'})
    RETURNING id`;

  return {
    kind, partnerId: partner.id, orgId: org.id, userId: user.id, connectionId, offeringId,
    platformModelId, modelId, catalogEntryId, chatSessionId: String(session!.id),
  };
}
