/**
 * W08 (#7606): topology AI readiness reads the registry — the org's effective
 * `chat` default offering and its connection — on the caller's HELD system
 * connection (the #6671 pool shape), instead of the retired compat connection
 * and its pinned legacy_default_model.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';

// The key probe is the only network call; the discovery queue needs Redis.
vi.mock('../../services/aiModels/connectionProbe', async (orig) => ({
  ...(await orig<typeof import('../../services/aiModels/connectionProbe')>()),
  probeAnthropicKey: vi.fn(async () => undefined),
}));
vi.mock('../../jobs/aiModelDiscoveryWorker', () => ({ enqueueConnectionSync: vi.fn(async () => undefined) }));

import { db, withSystemDbAccessContext } from '../../db';
import { sql } from 'drizzle-orm';
import { chatReadinessInSystemContext } from '../../services/aiModels/readiness';
import { changeAnthropicEndpoint } from '../../services/aiModels/anthropicConnectionWrites';
import { connectAnthropicConnection } from '../../services/aiModels/connectionRemap';
import { createConnection, createGatewayConnectionRow } from '../../services/aiModels/connections';
import { lockPartnerRegistry } from '../../services/aiModels/registryWriteLock';
import { activateRevision } from '../../services/llmProviderCatalog';
import { __setLookupForTests } from '../../services/urlSafety';
import { fixtureSql, seedOffering } from './aiModelRegistryFixtures';
import { createOrganization, createPartner } from './db-utils';
import { seedCatalogRevision, seedListedCatalogEntry, seedPricedPlatformModel, seedRegistryPartner } from './helpers/aiModelRegistrySeed';

const previousCatalogFlag = process.env.LLM_PROVIDER_CATALOG_ENABLED;
afterAll(() => {
  __setLookupForTests(null);
  if (previousCatalogFlag === undefined) delete process.env.LLM_PROVIDER_CATALOG_ENABLED;
  else process.env.LLM_PROVIDER_CATALOG_ENABLED = previousCatalogFlag;
});

const NO_PLATFORM_KEY = { platformConfigured: () => false };
const ready = (orgId: string, deps = NO_PLATFORM_KEY) =>
  withSystemDbAccessContext(() => chatReadinessInSystemContext(orgId, deps));

const setConnection = (id: string, status: 'active' | 'error' | 'disconnected', opts: { dropKey?: boolean } = {}) =>
  opts.dropKey
    ? fixtureSql`UPDATE partner_ai_connections SET status = ${status}, api_key_encrypted = NULL, key_last4 = NULL, key_fingerprint = NULL WHERE id = ${id}`
    : fixtureSql`UPDATE partner_ai_connections SET status = ${status} WHERE id = ${id}`;

const pointChatAt = (partnerId: string, offeringId: string) => fixtureSql`
  UPDATE ai_model_assignments SET default_offering_id = ${offeringId}
   WHERE partner_id = ${partnerId} AND org_id IS NULL AND surface = 'chat' AND role = 'default'`;

describe('chatReadinessInSystemContext (W08)', () => {
  it('refuses to run outside a held system context', async () => {
    await expect(chatReadinessInSystemContext(randomUUID())).rejects.toThrow(/held system DB context/);
  });

  it('an unknown org is unavailable', async () => {
    expect(await ready(randomUUID())).toBe('ai_unavailable');
  });

  it('a platform-backed chat default is ready only when the platform key is configured', async () => {
    const s = await seedRegistryPartner('platform');
    expect(await ready(s.orgId, { platformConfigured: () => true })).toBeNull();
    expect(await ready(s.orgId)).toBe('ai_not_configured');
  });

  it('a connection-backed chat default (connect moved it onto the key): ready while active, unavailable when errored, undecryptable or disconnected', async () => {
    const s = await seedRegistryPartner('platform');
    const connectionId = await withSystemDbAccessContext(async () => {
      await lockPartnerRegistry(s.partnerId);
      return connectAnthropicConnection(s.partnerId, {
        kind: 'anthropic_byok', apiKey: `sk-ant-test-${randomUUID()}`, catalogEntryId: null, connectedBy: null, movePlatformReferences: true,
      });
    });
    expect(await ready(s.orgId)).toBeNull();

    await setConnection(connectionId, 'error');
    expect(await ready(s.orgId)).toBe('ai_unavailable');

    await setConnection(connectionId, 'active');
    await fixtureSql`UPDATE partner_ai_connections SET api_key_encrypted = 'enc:v3:not-a-real-ciphertext' WHERE id = ${connectionId}`;
    expect(await ready(s.orgId)).toBe('ai_unavailable');

    // A soft-disconnected row (#7700) still referenced by the chat default: keyless, never usable.
    await setConnection(connectionId, 'disconnected', { dropKey: true });
    expect(await ready(s.orgId)).toBe('ai_unavailable');
  });

  it('readiness reads on the caller\'s held system connection: it sees the caller\'s uncommitted write', async () => {
    const s = await seedRegistryPartner('byok');
    expect(await ready(s.orgId)).toBeNull();
    const seenInside = await withSystemDbAccessContext(async () => {
      await db.execute(sql`UPDATE partner_ai_connections SET status = 'error' WHERE id = ${s.connectionId}`);
      const code = await chatReadinessInSystemContext(s.orgId, NO_PLATFORM_KEY);
      await db.execute(sql`UPDATE partner_ai_connections SET status = 'active' WHERE id = ${s.connectionId}`);
      return code;
    });
    // A second pooled connection could not have seen the uncommitted 'error'.
    expect(seenInside).toBe('ai_unavailable');
    expect(await ready(s.orgId)).toBeNull();
  });

  it('a catalog connection selected through changeAnthropicEndpoint is ready when its revision maps + verifies the chat default model (no pinned legacy model needed)', async () => {
    const s = await seedRegistryPartner('byok');
    const entryId = await seedListedCatalogEntry([s.modelId], s.userId);
    await changeAnthropicEndpoint({
      partnerId: s.partnerId, connectionId: s.connectionId!, catalogEntryId: entryId, acknowledgeDataNote: true, userId: s.userId,
    });
    const [conn] = await fixtureSql`SELECT kind, legacy_default_model FROM partner_ai_connections WHERE id = ${s.connectionId}`;
    expect(conn).toEqual({ kind: 'catalog', legacy_default_model: null });
    expect(await ready(s.orgId)).toBeNull();

    // The entry's active revision stops mapping the offering's model → unavailable.
    const otherModel = `not-the-chat-model-${randomUUID()}`;
    await seedPricedPlatformModel(otherModel);
    const otherRevision = await seedCatalogRevision(entryId, [otherModel], s.userId);
    await activateRevision({ entryId, revisionId: otherRevision });
    expect(await ready(s.orgId)).toBe('ai_unavailable');
  });

  it('a chat default on an active OpenAI-compatible gateway is ready, keyless or keyed; errored or disconnected is not', async () => {
    const s = await seedRegistryPartner('platform');
    const keyless = await withSystemDbAccessContext(() => createGatewayConnectionRow({
      partnerId: s.partnerId, kind: 'openai_compatible', name: 'No-auth gateway', baseUrl: 'https://gw.example.com/v1', connectedBy: null,
    }));
    const offeringId = await seedOffering({ partnerId: s.partnerId, connectionId: keyless.id, modelId: 'llama-3.3-70b', source: 'manual', enabled: true });
    await pointChatAt(s.partnerId, offeringId);
    expect(await ready(s.orgId)).toBeNull();

    await setConnection(keyless.id, 'error');
    expect(await ready(s.orgId)).toBe('ai_unavailable');
    await setConnection(keyless.id, 'disconnected');
    expect(await ready(s.orgId)).toBe('ai_unavailable');

    const keyed = await withSystemDbAccessContext(() => createGatewayConnectionRow({
      partnerId: s.partnerId, kind: 'openai_compatible', name: 'Keyed gateway', baseUrl: 'https://gw2.example.com/v1',
      apiKey: `sk-or-v1-${randomUUID()}`, connectedBy: null,
    }));
    const keyedOffering = await seedOffering({ partnerId: s.partnerId, connectionId: keyed.id, modelId: 'llama-3.3-70b', source: 'manual', enabled: true });
    await pointChatAt(s.partnerId, keyedOffering);
    expect(await ready(s.orgId)).toBeNull();
  });

  it('a disabled chat default, or no chat default at all, is unavailable', async () => {
    const s = await seedRegistryPartner('platform');
    await fixtureSql`UPDATE partner_ai_models SET enabled = false WHERE id = ${s.offeringId}`;
    expect(await ready(s.orgId, { platformConfigured: () => true })).toBe('ai_unavailable');
    await fixtureSql`
      UPDATE ai_model_assignments SET default_offering_id = NULL
       WHERE partner_id = ${s.partnerId} AND org_id IS NULL AND surface = 'chat'`;
    expect(await ready(s.orgId, { platformConfigured: () => true })).toBe('ai_unavailable');
  });

  describe('a partner not bootstrapped yet is judged as its bootstrap will leave it', () => {
    async function unbootstrapped() {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      return { partnerId: partner.id, orgId: org.id };
    }

    it('no Anthropic connection → the platform', async () => {
      const { orgId } = await unbootstrapped();
      expect(await ready(orgId, { platformConfigured: () => true })).toBeNull();
      expect(await ready(orgId)).toBe('ai_not_configured');
    });

    it('exactly one live Anthropic connection → that connection (active ready, errored not), never the platform', async () => {
      const { partnerId, orgId } = await unbootstrapped();
      const conn = await withSystemDbAccessContext(() => createConnection({
        partnerId, kind: 'anthropic_byok', name: 'Copied key', apiKey: `sk-ant-test-${randomUUID()}`, connectedBy: null, verifiedAt: new Date(),
      }));
      expect(await ready(orgId)).toBeNull();
      await setConnection(conn.id, 'error');
      expect(await ready(orgId, { platformConfigured: () => true })).toBe('ai_unavailable');
      // A soft-disconnected row is never a bootstrap destination: back to the platform.
      await setConnection(conn.id, 'disconnected', { dropKey: true });
      expect(await ready(orgId, { platformConfigured: () => true })).toBeNull();
      // Nothing was bootstrapped by the readiness read.
      expect(await fixtureSql`SELECT 1 FROM ai_model_registry_partner_cutover WHERE partner_id = ${partnerId}`).toHaveLength(0);
    });
  });
});
