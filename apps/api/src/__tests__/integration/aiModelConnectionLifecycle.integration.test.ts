/**
 * W08 (#7606): id-keyed Anthropic connection writes against real Postgres
 * (replaces W03's aiProviderAuthority.integration.test.ts; its still-relevant
 * cases are ported here). The key probe and the discovery queue are stubbed;
 * everything else is real.
 *  - connect moves every platform reference except patch_test onto the key,
 *    keeps options, rows and explicit choices, and disables the platform
 *    offerings left routing nothing;
 *  - rotate is in place by id; assignments do not move;
 *  - a connection id of another partner is refused and writes nothing;
 *  - disconnect moves only that connection's references back to the platform
 *    and SOFT-disconnects it (#7700 finding 1): the row stays keyless, its
 *    offerings disabled, config_version bumped; a reconnect is a NEW id;
 *  - a soft-disconnected id is refused by every write and never revived;
 *  - a rotated or disconnected key never survives in partner_llm_configs
 *    (#7700 finding 4);
 *  - a registry-native edit (options, verbatim fallback list, org override,
 *    explicit session model) survives rotate and disconnect (W03, W09).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/aiModels/connectionProbe', async (orig) => ({
  ...(await orig<typeof import('../../services/aiModels/connectionProbe')>()),
  probeAnthropicKey: vi.fn(async () => undefined),
}));
vi.mock('../../jobs/aiModelDiscoveryWorker', () => ({ enqueueConnectionSync: vi.fn(async () => undefined) }));

import { db, withSystemDbAccessContext } from '../../db';
import { aiModelAssignments, partnerAiConnections, partnerAiModels } from '../../db/schema';
import {
  changeAnthropicEndpoint, createAnthropicKeyConnection, deleteAnthropicConnection, rotateAnthropicKey,
} from '../../services/aiModels/anthropicConnectionWrites';
import { loadOfferingCandidate } from '../../services/aiModels/candidateLoader';
import { __resetRegistryCutoverMemoForTests, ensurePartnerCutover } from '../../services/aiModels/registryCutover';
import { columnAad } from '../../services/encryptedColumnRegistry';
import { markPartnerLlmError, resolveLlmConfig } from '../../services/llm/llmConfigResolver';
import { encryptSecret } from '../../services/secretCrypto';
import { closeRegistryFixtures, fixtureSql, keySpec, seedByokConnection, seedOffering, seedPricedPlatformModel } from './aiModelRegistryFixtures';
import { createOrganization, createPartner, createUser } from './db-utils';
import { seedPricedPlatformModel as seedW03PlatformModel, seedRegistryPartner } from './helpers/aiModelRegistrySeed';

const RUN = !!process.env.DATABASE_URL;

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

async function bootstrappedPartner(): Promise<{ partnerId: string; orgId: string; userId: string }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  expect(await ensurePartnerCutover(partner.id)).toBe(true);
  // connected_by is a users FK: a real user, never a random id.
  const user = await createUser({ partnerId: partner.id });
  return { partnerId: partner.id, orgId: org.id, userId: user.id };
}

const partnerRows = (partnerId: string) => sys(() => db.select().from(aiModelAssignments)
  .where(and(eq(aiModelAssignments.partnerId, partnerId), isNull(aiModelAssignments.orgId))));
const offering = (id: string | null) => sys(async () => id
  ? (await db.select().from(partnerAiModels).where(eq(partnerAiModels.id, id)))[0] : undefined);
const connectionRow = async (id: string) => (await fixtureSql`
  SELECT partner_id, status, api_key_encrypted, key_last4, key_fingerprint, config_version, last_error
    FROM partner_ai_connections WHERE id = ${id}`)[0];
/** The partner's live (not disconnected) Anthropic connection, as the retired status read reported it. */
const liveConnection = async (partnerId: string) => (await fixtureSql`
  SELECT id, status, key_last4, last_error FROM partner_ai_connections
   WHERE partner_id = ${partnerId} AND kind IN ('anthropic_byok', 'catalog') AND status <> 'disconnected'`)[0];
const chatDefault = async (partnerId: string) => (await fixtureSql`
  SELECT a.options, o.id AS offering_id, o.connection_id AS conn, COALESCE(o.model_id, pm.model_id) AS model
    FROM ai_model_assignments a
    JOIN partner_ai_models o ON o.id = a.default_offering_id
    LEFT JOIN ai_platform_models pm ON pm.id = o.platform_model_id
   WHERE a.partner_id = ${partnerId} AND a.org_id IS NULL AND a.surface = 'chat'`)[0]!;

const savedEnv = { model: process.env.ANTHROPIC_MODEL, key: process.env.ANTHROPIC_API_KEY };
const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
};

// The suite moves the global platform default; put the original back so later suites see the seeded one.
let originalDefaultId: string | null = null;
beforeAll(async () => {
  if (!RUN) return;
  const [row] = await fixtureSql`SELECT id FROM ai_platform_models WHERE is_platform_default`;
  originalDefaultId = row ? String(row.id) : null;
});
afterAll(async () => {
  if (RUN) {
    await fixtureSql`UPDATE ai_platform_models SET is_platform_default = false WHERE is_platform_default`;
    if (originalDefaultId) await fixtureSql`UPDATE ai_platform_models SET is_platform_default = true WHERE id = ${originalDefaultId}`;
  }
  await closeRegistryFixtures();
});

beforeEach(async () => {
  if (!RUN) return;
  __resetRegistryCutoverMemoForTests();
  delete process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-w08-integration-placeholder';
  await seedPricedPlatformModel({ modelId: `w08-conn-default-${randomUUID()}`, isPlatformDefault: true });
});
afterEach(() => {
  restore('ANTHROPIC_MODEL', savedEnv.model);
  restore('ANTHROPIC_API_KEY', savedEnv.key);
});

describe.skipIf(!RUN)('Anthropic connection lifecycle (W08)', () => {
  it('connect moves platform references except patch_test onto the key; rotate is in place', async () => {
    const { partnerId, userId } = await bootstrappedPartner();
    const before = await partnerRows(partnerId);
    const platformOffering = before.find((r) => r.surface === 'chat')!.defaultOfferingId;

    const { connectionId, configVersion } = await createAnthropicKeyConnection({ partnerId, apiKey: 'sk-ant-test-1111111111', userId });
    expect(configVersion).toBe(1);
    const after = await partnerRows(partnerId);
    expect(after.map((r) => r.surface).sort()).toEqual(before.map((r) => r.surface).sort());
    for (const r of after) {
      const o = await offering(r.defaultOfferingId);
      if (r.surface === 'patch_test') expect(o!.connectionId).toBeNull();
      else expect(o!.connectionId).toBe(connectionId);
    }
    // The platform offering still serves patch_test, so it stays enabled.
    expect((await offering(platformOffering))!.enabled).toBe(true);

    const rotated = await rotateAnthropicKey({ partnerId, connectionId, apiKey: 'sk-ant-test-2222222222', userId });
    expect(rotated).toEqual({ last4: '2222', configVersion: 2 });
    const afterRotate = await partnerRows(partnerId);
    const byId = new Map(after.map((r) => [r.id, r.defaultOfferingId]));
    for (const r of afterRotate) expect(r.defaultOfferingId).toBe(byId.get(r.id));
    expect(await connectionRow(connectionId)).toMatchObject({ status: 'active', key_last4: '2222', config_version: 2 });
  });

  it('a connection id of another partner is refused and writes nothing', async () => {
    const a = await bootstrappedPartner();
    const b = await bootstrappedPartner();
    const { connectionId } = await createAnthropicKeyConnection({ partnerId: b.partnerId, apiKey: 'sk-ant-test-3333333333', userId: b.userId });
    await expect(rotateAnthropicKey({ partnerId: a.partnerId, connectionId, apiKey: 'sk-ant-test-4444444444', userId: a.userId }))
      .rejects.toMatchObject({ status: 409 });
    await expect(changeAnthropicEndpoint({ partnerId: a.partnerId, connectionId, catalogEntryId: null, acknowledgeDataNote: false, userId: a.userId }))
      .rejects.toMatchObject({ status: 409 });
    await expect(deleteAnthropicConnection({ partnerId: a.partnerId, connectionId })).resolves.toBe(false);
    const [row] = await sys(() => db.select().from(partnerAiConnections).where(eq(partnerAiConnections.id, connectionId)));
    expect(row).toMatchObject({ partnerId: b.partnerId, keyLast4: '3333', configVersion: 1, status: 'active' });
  });

  it('connecting keeps options, rows and explicit choices; a live session follows the key; nothing is written to partner_llm_configs', async () => {
    const s = await seedRegistryPartner('platform');
    await fixtureSql`UPDATE ai_model_assignments SET options = '{"effort":"low"}'::jsonb
      WHERE partner_id = ${s.partnerId} AND surface = 'catalog_enrichment'`;
    const [before] = await fixtureSql`SELECT count(*)::int AS n FROM ai_model_assignments WHERE offering_partner_id = ${s.partnerId}`;

    await createAnthropicKeyConnection({ partnerId: s.partnerId, apiKey: 'sk-ant-api03-lifecycle-0001', userId: s.userId });

    const [row] = await fixtureSql`
      SELECT a.options, o.connection_id AS conn FROM ai_model_assignments a
        JOIN partner_ai_models o ON o.id = a.default_offering_id
       WHERE a.partner_id = ${s.partnerId} AND a.surface = 'catalog_enrichment'`;
    expect(row!.options).toEqual({ effort: 'low' });
    expect(row!.conn).not.toBeNull();
    const [after] = await fixtureSql`SELECT count(*)::int AS n FROM ai_model_assignments WHERE offering_partner_id = ${s.partnerId}`;
    expect(after!.n).toBe(before!.n);
    // The live chat session follows the key (legacy: every session runs on the partner key)…
    const [session] = await fixtureSql`
      SELECT o.connection_id AS conn, o.model_id FROM ai_sessions s JOIN partner_ai_models o ON o.id = s.offering_id WHERE s.id = ${s.chatSessionId}`;
    expect(session).toEqual({ conn: row!.conn, model_id: s.modelId });
    // …and the platform offering nothing routes to any more is not left enabled.
    expect(await offering(s.offeringId)).toMatchObject({ enabled: false });
    expect(await fixtureSql`SELECT 1 FROM partner_llm_configs WHERE partner_id = ${s.partnerId}`).toHaveLength(0);
    expect(await liveConnection(s.partnerId)).toMatchObject({ status: 'active', key_last4: '0001' });
  });

  it('disconnect moves only that connection\'s references back, then SOFT-disconnects it (keyless, offerings disabled, version bumped)', async () => {
    const { partnerId, orgId, userId } = await bootstrappedPartner();
    const platformChat = (await partnerRows(partnerId)).find((r) => r.surface === 'chat')!.defaultOfferingId!;
    // An org override on the platform: W03 semantics move it with every other platform reference.
    await sys(() => db.insert(aiModelAssignments).values({
      orgId, partnerId: null, offeringPartnerId: partnerId, surface: 'helper', role: 'default',
      defaultOfferingId: platformChat, permittedOfferingIds: null, allowUserChoice: null, options: null, fallbackOfferingIds: null, fallbackMayCrossFunding: null,
    }));
    // A gateway connection's reference is never touched by an Anthropic connect or disconnect.
    const [gateway] = await fixtureSql`
      INSERT INTO partner_ai_connections (partner_id, kind, name, base_url)
      VALUES (${partnerId}, 'openai_compatible', 'Office vLLM', 'https://llm.example.com/v1') RETURNING id`;
    const gatewayOffering = await seedOffering({ partnerId, connectionId: String(gateway!.id), modelId: 'qwen2.5-coder:7b', source: 'manual', enabled: true });
    await fixtureSql`UPDATE ai_model_assignments SET default_offering_id = ${gatewayOffering}
      WHERE partner_id = ${partnerId} AND org_id IS NULL AND surface = 'script_builder'`;

    const { connectionId } = await createAnthropicKeyConnection({ partnerId, apiKey: 'sk-ant-test-5555555555', userId });
    const [orgRow] = await sys(() => db.select().from(aiModelAssignments).where(eq(aiModelAssignments.orgId, orgId)));
    expect((await offering(orgRow!.defaultOfferingId))!.connectionId).toBe(connectionId);
    const scriptBuilder = async () => (await partnerRows(partnerId)).find((r) => r.surface === 'script_builder')!.defaultOfferingId;
    expect(await scriptBuilder()).toBe(gatewayOffering);
    const onConnection = await sys(() => db.select().from(partnerAiModels).where(eq(partnerAiModels.connectionId, connectionId)));
    expect(onConnection.length).toBeGreaterThan(0);

    expect(await deleteAnthropicConnection({ partnerId, connectionId })).toBe(true);
    // References are back on the platform, the same models.
    for (const r of await partnerRows(partnerId)) {
      if (r.surface === 'script_builder') continue;
      expect((await offering(r.defaultOfferingId))!.connectionId).toBeNull();
    }
    const [orgAfter] = await sys(() => db.select().from(aiModelAssignments).where(eq(aiModelAssignments.orgId, orgId)));
    expect((await offering(orgAfter!.defaultOfferingId))!.connectionId).toBeNull();
    expect(await scriptBuilder()).toBe(gatewayOffering);
    // The row stays as provenance: keyless, disconnected, version bumped.
    expect(await connectionRow(connectionId)).toEqual({
      partner_id: partnerId, status: 'disconnected', api_key_encrypted: null, key_last4: null, key_fingerprint: null,
      config_version: 2, last_error: null,
    });
    // Its offerings stay (an in-flight turn may still settle on one), all disabled.
    const offeringsAfter = await sys(() => db.select().from(partnerAiModels).where(eq(partnerAiModels.connectionId, connectionId)));
    expect(offeringsAfter.map((o) => o.id).sort()).toEqual(onConnection.map((o) => o.id).sort());
    expect(offeringsAfter.every((o) => o.enabled === false)).toBe(true);
    expect(await resolveLlmConfig(partnerId)).toMatchObject({ source: 'platform' });
    expect(await liveConnection(partnerId)).toBeUndefined();
  });

  it('a live session on the connection goes back to the same model on the platform', async () => {
    const s = await seedRegistryPartner('byok');
    expect(await deleteAnthropicConnection({ partnerId: s.partnerId, connectionId: s.connectionId! })).toBe(true);
    expect(await offering(s.offeringId)).toMatchObject({ enabled: false, connectionId: s.connectionId });
    const d = await chatDefault(s.partnerId);
    expect(d.conn).toBeNull();
    expect(d.model).toBe(s.modelId);
    const [session] = await fixtureSql`SELECT o.connection_id FROM ai_sessions s JOIN partner_ai_models o ON o.id = s.offering_id WHERE s.id = ${s.chatSessionId}`;
    expect(session!.connection_id).toBeNull();
  });

  it('a disconnected connection is unusable everywhere, and a reconnect creates a NEW connection id (compat_uq ignores it)', async () => {
    const s = await seedRegistryPartner('byok');
    expect(await deleteAnthropicConnection({ partnerId: s.partnerId, connectionId: s.connectionId! })).toBe(true);
    // A second disconnect finds nothing to disconnect.
    expect(await deleteAnthropicConnection({ partnerId: s.partnerId, connectionId: s.connectionId! })).toBe(false);
    // The disconnected offering is connection_unavailable even when addressed directly.
    const cand = await loadOfferingCandidate(s.offeringId, s.partnerId);
    expect(cand?.connection).toBeNull();
    expect(cand?.facts.connection).toMatchObject({ status: 'disconnected', keyUsable: false });

    const { connectionId } = await createAnthropicKeyConnection({ partnerId: s.partnerId, apiKey: 'sk-ant-api03-lifecycle-0009', userId: s.userId });
    expect(connectionId).not.toBe(s.connectionId);
    const conns = await fixtureSql`SELECT id, status, key_last4 FROM partner_ai_connections WHERE partner_id = ${s.partnerId} ORDER BY created_at`;
    expect(conns).toHaveLength(2);
    expect(conns[0]).toMatchObject({ id: s.connectionId, status: 'disconnected', key_last4: null });
    expect(conns[1]).toMatchObject({ id: connectionId, status: 'active', key_last4: '0009' });
    expect(await chatDefault(s.partnerId)).toMatchObject({ conn: connectionId, model: s.modelId });
    expect(await resolveLlmConfig(s.partnerId)).toMatchObject({ source: 'partner', configId: connectionId });
    // The reconnected key rotates normally.
    await expect(rotateAnthropicKey({ partnerId: s.partnerId, connectionId, apiKey: 'sk-ant-api03-lifecycle-0010', userId: s.userId }))
      .resolves.toEqual({ last4: '0010', configVersion: 2 });
  });

  it('every write refuses a soft-disconnected id and never revives it', async () => {
    const s = await seedRegistryPartner('byok');
    await deleteAnthropicConnection({ partnerId: s.partnerId, connectionId: s.connectionId! });
    const before = await connectionRow(s.connectionId!);
    await expect(rotateAnthropicKey({ partnerId: s.partnerId, connectionId: s.connectionId!, apiKey: 'sk-ant-api03-revive-0001', userId: s.userId }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('configuration changed') });
    await expect(changeAnthropicEndpoint({ partnerId: s.partnerId, connectionId: s.connectionId!, catalogEntryId: null, acknowledgeDataNote: false, userId: s.userId }))
      .rejects.toMatchObject({ status: 409 });
    expect(await connectionRow(s.connectionId!)).toEqual(before);
    expect(before).toMatchObject({ status: 'disconnected', api_key_encrypted: null });
    expect(await offering(s.offeringId)).toMatchObject({ enabled: false });
  });

  it('a second Anthropic connection is refused while the R1 cap and compat_uq exist', async () => {
    const { partnerId, userId } = await bootstrappedPartner();
    await createAnthropicKeyConnection({ partnerId, apiKey: 'sk-ant-test-6666666666', userId });
    await expect(createAnthropicKeyConnection({ partnerId, apiKey: 'sk-ant-test-7777777777', userId }))
      .rejects.toMatchObject({ status: 409 });
    expect(await fixtureSql`SELECT 1 FROM partner_ai_connections WHERE partner_id = ${partnerId}`).toHaveLength(1);
  });

  it('a registry-native edit survives later writes (rotate, disconnect): options, the fallback list verbatim, an org override, an explicit session model', async () => {
    const s = await seedRegistryPartner('byok');
    const otherModel = `w08-other-${randomUUID()}`;
    const otherPlatform = await seedW03PlatformModel(otherModel);
    const [explicit] = await fixtureSql`
      INSERT INTO partner_ai_models (partner_id, connection_id, model_id, source, platform_model_id, enabled)
      VALUES (${s.partnerId}, ${s.connectionId}, ${otherModel}, 'discovered', ${otherPlatform}, true) RETURNING id`;
    await fixtureSql`UPDATE ai_model_assignments SET options = '{"effort":"high"}'::jsonb, fallback_offering_ids = ARRAY[${explicit!.id}]::uuid[]
                     WHERE partner_id = ${s.partnerId} AND surface = 'chat'`;
    await fixtureSql`
      INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, role, default_offering_id)
      VALUES (${s.orgId}, ${s.partnerId}, 'helper', 'default', ${explicit!.id})`;
    await fixtureSql`UPDATE ai_sessions SET offering_id = ${explicit!.id} WHERE id = ${s.chatSessionId}`;

    const rotated = await rotateAnthropicKey({ partnerId: s.partnerId, connectionId: s.connectionId!, apiKey: 'sk-ant-api03-lifecycle-0002', userId: s.userId });
    expect(rotated.configVersion).toBe(2);
    expect(await connectionRow(s.connectionId!)).toMatchObject({ key_last4: '0002', config_version: 2 });
    const chat = await chatDefault(s.partnerId);
    expect(chat.options).toEqual({ effort: 'high' });
    expect(chat.offering_id).toBe(s.offeringId);
    const [chatRow] = await fixtureSql`SELECT fallback_offering_ids FROM ai_model_assignments WHERE partner_id = ${s.partnerId} AND surface = 'chat'`;
    expect(chatRow!.fallback_offering_ids).toEqual([explicit!.id]);
    const [session] = await fixtureSql`SELECT offering_id FROM ai_sessions WHERE id = ${s.chatSessionId}`;
    expect(session!.offering_id).toBe(explicit!.id);

    // Disconnect keeps the org override and the session's explicit model — on the platform —
    // and remaps the fallback list entry by array_replace (W09), never drops or reorders it.
    await deleteAnthropicConnection({ partnerId: s.partnerId, connectionId: s.connectionId! });
    const [org] = await fixtureSql`
      SELECT o.connection_id, pm.model_id FROM ai_model_assignments a JOIN partner_ai_models o ON o.id = a.default_offering_id
        JOIN ai_platform_models pm ON pm.id = o.platform_model_id WHERE a.org_id = ${s.orgId}`;
    expect(org).toEqual({ connection_id: null, model_id: otherModel });
    const [chatAfter] = await fixtureSql`
      SELECT a.options, a.fallback_offering_ids, f.connection_id AS fb_conn, pm.model_id AS fb_model
        FROM ai_model_assignments a
        JOIN partner_ai_models f ON f.id = a.fallback_offering_ids[1]
        JOIN ai_platform_models pm ON pm.id = f.platform_model_id
       WHERE a.partner_id = ${s.partnerId} AND a.surface = 'chat'`;
    expect(chatAfter!.options).toEqual({ effort: 'high' });
    expect(chatAfter!.fallback_offering_ids).toHaveLength(1);
    expect(chatAfter).toMatchObject({ fb_conn: null, fb_model: otherModel });
    const [sessionAfter] = await fixtureSql`
      SELECT o.connection_id, pm.model_id FROM ai_sessions s JOIN partner_ai_models o ON o.id = s.offering_id
        JOIN ai_platform_models pm ON pm.id = o.platform_model_id WHERE s.id = ${s.chatSessionId}`;
    expect(sessionAfter).toEqual({ connection_id: null, model_id: otherModel });
    expect(await fixtureSql`SELECT 1 FROM ai_model_assignments WHERE org_id = ${s.orgId}`).toHaveLength(1);
  });

  it('a revoked key never survives in partner_llm_configs: rotate and disconnect remove the legacy ciphertext (#7700 finding 4)', async () => {
    // The legacy table still exists in this release (W08b drops it); seed a
    // pre-cutover partner the way W02 left it: a legacy row plus its byte copy.
    const seedLegacy = async (suffix: string) => {
      const partner = await createPartner();
      await createOrganization({ partnerId: partner.id });
      const user = await createUser({ partnerId: partner.id });
      const legacyId = randomUUID();
      const sealed = encryptSecret(`sk-ant-api03-legacy-${suffix}`, { aad: columnAad(keySpec('partner_llm_configs'), legacyId) })!;
      await fixtureSql`INSERT INTO partner_llm_configs (id, partner_id, api_key_encrypted, key_last4, key_fingerprint, connected_by)
                       VALUES (${legacyId}, ${partner.id}, ${sealed}, ${suffix}, 'fp', ${user.id})`;
      await seedByokConnection(partner.id, legacyId);
      return { partnerId: partner.id, userId: user.id, connectionId: legacyId, sealed };
    };
    const holdsCiphertext = (sealed: string) => fixtureSql`SELECT 1 FROM partner_llm_configs WHERE api_key_encrypted = ${sealed}`;

    // Rotation (bootstraps the partner onto its copied connection first, then rotates in place).
    const rotated = await seedLegacy('0011');
    await rotateAnthropicKey({ partnerId: rotated.partnerId, connectionId: rotated.connectionId, apiKey: 'sk-ant-api03-lifecycle-0012', userId: rotated.userId });
    expect(await liveConnection(rotated.partnerId)).toMatchObject({ id: rotated.connectionId, key_last4: '0012' });
    expect(await holdsCiphertext(rotated.sealed)).toHaveLength(0);
    expect(await fixtureSql`SELECT 1 FROM partner_llm_configs WHERE partner_id = ${rotated.partnerId}`).toHaveLength(0);

    // Disconnect.
    const disconnected = await seedLegacy('0013');
    expect(await deleteAnthropicConnection({ partnerId: disconnected.partnerId, connectionId: disconnected.connectionId })).toBe(true);
    expect(await holdsCiphertext(disconnected.sealed)).toHaveLength(0);
    expect(await fixtureSql`SELECT 1 FROM partner_llm_configs WHERE partner_id = ${disconnected.partnerId}`).toHaveLength(0);
  });

  it('the legacy resolver reads the connection: a runtime credential failure marks it, and a rotation clears it', async () => {
    const s = await seedRegistryPartner('byok');
    expect(await resolveLlmConfig(s.partnerId)).toMatchObject({ source: 'partner', configId: s.connectionId, configVersion: 1 });
    expect(await markPartnerLlmError({ configId: s.connectionId!, configVersion: 1, reason: 'auth_rejected' })).toBe(true);
    expect(await liveConnection(s.partnerId)).toMatchObject({ status: 'error', last_error: 'auth_rejected' });
    expect(await resolveLlmConfig(s.partnerId)).toEqual({ source: 'unavailable', partnerId: s.partnerId, reason: 'key_error' });
    await rotateAnthropicKey({ partnerId: s.partnerId, connectionId: s.connectionId!, apiKey: 'sk-ant-api03-lifecycle-0004', userId: s.userId });
    expect(await resolveLlmConfig(s.partnerId)).toMatchObject({ source: 'partner', apiKey: 'sk-ant-api03-lifecycle-0004', configVersion: 2 });
  });

  it('the W02 legacy mirror trigger is gone', async () => {
    const t = await sys(() => db.execute(sql`SELECT 1 FROM pg_trigger WHERE tgname = 'partner_llm_configs_mirror_to_connection'`));
    expect(t).toHaveLength(0);
    const f = await sys(() => db.execute(sql`SELECT 1 FROM pg_proc WHERE proname = 'partner_llm_configs_mirror_to_connection'`));
    expect(f).toHaveLength(0);
  });
});
