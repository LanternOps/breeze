/**
 * W03 Task 6B (#7601, review finding 9): after the authority flip the
 * /ai/provider facade edits the registry natively — connect / disconnect /
 * rotate / default-model changes are offering-id remaps — and never
 * re-projects it from legacy config, never writes partner_llm_configs, and the
 * W02 legacy → connection mirror trigger is gone.
 */
import './setup';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { columnAad } from '../../services/encryptedColumnRegistry';
import { encryptSecret } from '../../services/secretCrypto';
import {
  deletePartnerLlmConfig,
  getPartnerLlmStatus,
  savePartnerLlmKey,
  updatePartnerLlmConfig,
} from '../../services/partnerLlmConfig';
import { loadOfferingCandidate } from '../../services/aiModels/candidateLoader';
import { markPartnerLlmError, resolveLlmConfig } from '../../services/llm/llmConfigResolver';
import { closeRegistryFixtures, fixtureSql, keySpec, seedByokConnection } from './aiModelRegistryFixtures';
import { seedPricedPlatformModel, seedRegistryPartner } from './helpers/aiModelRegistrySeed';
import { createOrganization, createPartner, createUser } from './db-utils';

// The facade's key probe is the only network call: stub the client the
// connection factory builds (the probe goes through createAnthropicClient).
vi.mock('../../services/aiModels/connectionFactory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/aiModels/connectionFactory')>()),
  createAnthropicClient: () => ({ messages: { create: async () => ({ id: 'probe' }) } }),
}));

// Finding 9's invariant: nothing re-projects a cut-over partner. The real
// reconcile stays in place (the cutover of a NOT-yet-cut-over partner needs
// it); the spy proves the facade never reaches it for a cut-over partner.
const reconcileSpy = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../services/aiModels/legacyReconcile', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/aiModels/legacyReconcile')>();
  return {
    ...real,
    reconcilePartnerFromLegacyInTx: async (...args: Parameters<typeof real.reconcilePartnerFromLegacyInTx>) => {
      reconcileSpy.calls.push(args[0]);
      return real.reconcilePartnerFromLegacyInTx(...args);
    },
  };
});

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);
beforeEach(() => { reconcileSpy.calls = []; });

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

const chatDefault = async (partnerId: string) => (await fixtureSql`
  SELECT a.options, a.allow_user_choice, o.id AS offering_id, o.connection_id AS conn,
         COALESCE(o.model_id, pm.model_id) AS model
    FROM ai_model_assignments a
    JOIN partner_ai_models o ON o.id = a.default_offering_id
    LEFT JOIN ai_platform_models pm ON pm.id = o.platform_model_id
   WHERE a.partner_id = ${partnerId} AND a.org_id IS NULL AND a.surface = 'chat'`)[0]!;

const offering = async (id: string) => (await fixtureSql`SELECT id, enabled, connection_id FROM partner_ai_models WHERE id = ${id}`)[0];

describe.skipIf(!RUN)('authority flip (finding 9): /ai/provider edits the registry, never re-projects it', () => {
  it('connecting a BYOK key moves platform references to the key but keeps options, rows and explicit choices', async () => {
    const s = await seedRegistryPartner('platform');
    await fixtureSql`UPDATE ai_model_assignments SET options = '{"effort":"low"}'::jsonb
      WHERE partner_id = ${s.partnerId} AND surface = 'catalog_enrichment'`;
    const [before] = await fixtureSql`SELECT count(*)::int AS n FROM ai_model_assignments WHERE offering_partner_id = ${s.partnerId}`;

    await savePartnerLlmKey({ partnerId: s.partnerId, apiKey: 'sk-ant-api03-authority-0001', userId: s.userId });

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
    // …and the platform offering nothing routes to any more is not left enabled
    // for an `all` permitted set to expose.
    expect(await offering(s.offeringId)).toMatchObject({ enabled: false });

    expect(await fixtureSql`SELECT 1 FROM partner_llm_configs WHERE partner_id = ${s.partnerId}`).toHaveLength(0);
    expect(reconcileSpy.calls).toEqual([]);
    expect(await sys(() => getPartnerLlmStatus(s.partnerId))).toMatchObject({ configured: true, status: 'active', keyLast4: '0001' });
  });

  it('disconnecting returns references to platform offerings and soft-disconnects the connection (keyless, offerings disabled)', async () => {
    const s = await seedRegistryPartner('byok');
    expect(await deletePartnerLlmConfig(s.partnerId)).toBe(true);
    // #7700 finding 1: never deleted (in-flight turns and the ledger reference its offerings).
    expect(await fixtureSql`SELECT status, api_key_encrypted, key_last4, key_fingerprint FROM partner_ai_connections WHERE partner_id = ${s.partnerId}`)
      .toEqual([{ status: 'disconnected', api_key_encrypted: null, key_last4: null, key_fingerprint: null }]);
    expect(await offering(s.offeringId)).toMatchObject({ enabled: false, connection_id: s.connectionId });
    expect(await sys(() => getPartnerLlmStatus(s.partnerId))).toMatchObject({ configured: false });
    const d = await chatDefault(s.partnerId);
    expect(d.conn).toBeNull();
    expect(d.model).toBe(s.modelId);
    const [session] = await fixtureSql`SELECT s.offering_id, o.connection_id FROM ai_sessions s JOIN partner_ai_models o ON o.id = s.offering_id WHERE s.id = ${s.chatSessionId}`;
    expect(session!.connection_id).toBeNull();
    expect(await sys(() => getPartnerLlmStatus(s.partnerId))).toMatchObject({ configured: false, status: 'platform' });
    expect(await resolveLlmConfig(s.partnerId)).toMatchObject({ source: 'platform' });
    expect(reconcileSpy.calls).toEqual([]);
  });

  it('a disconnected connection is unusable everywhere, and a reconnect creates a NEW connection (#7700 finding 1)', async () => {
    const s = await seedRegistryPartner('byok');
    await deletePartnerLlmConfig(s.partnerId);
    // A second disconnect finds nothing to disconnect.
    expect(await deletePartnerLlmConfig(s.partnerId)).toBe(false);
    // The disconnected offering is connection_unavailable even when addressed directly.
    const cand = await loadOfferingCandidate(s.offeringId, s.partnerId);
    expect(cand?.connection).toBeNull();
    expect(cand?.facts.connection).toMatchObject({ status: 'disconnected', keyUsable: false });

    await savePartnerLlmKey({ partnerId: s.partnerId, apiKey: 'sk-ant-api03-authority-0009', userId: s.userId });
    const conns = await fixtureSql`SELECT id, status, key_last4 FROM partner_ai_connections WHERE partner_id = ${s.partnerId} ORDER BY created_at`;
    expect(conns).toHaveLength(2);
    expect(conns[0]).toMatchObject({ id: s.connectionId, status: 'disconnected', key_last4: null });
    expect(conns[1]).toMatchObject({ status: 'active', key_last4: '0009' });
    expect(conns[1]!.id).not.toBe(s.connectionId);
    expect(await chatDefault(s.partnerId)).toMatchObject({ conn: conns[1]!.id, model: s.modelId });
    expect(await sys(() => getPartnerLlmStatus(s.partnerId))).toMatchObject({ configured: true, keyLast4: '0009' });
    expect(await resolveLlmConfig(s.partnerId)).toMatchObject({ source: 'partner', configId: conns[1]!.id });
  });

  it('a registry-native edit survives later /ai/provider writes (rotate, default model, disconnect)', async () => {
    const s = await seedRegistryPartner('byok');
    const otherModel = `w03-other-${randomUUID()}`;
    const otherPlatform = await seedPricedPlatformModel(otherModel);
    // Native edits the W02 projection would wipe: assignment options and an
    // explicit fallback, an org override row, and a session on an explicit
    // non-default offering.
    const [explicit] = await fixtureSql`
      INSERT INTO partner_ai_models (partner_id, connection_id, model_id, source, platform_model_id, enabled)
      VALUES (${s.partnerId}, ${s.connectionId}, ${otherModel}, 'discovered', ${otherPlatform}, true) RETURNING id`;
    await fixtureSql`UPDATE ai_model_assignments SET options = '{"effort":"high"}'::jsonb, fallback_offering_ids = ARRAY[${explicit!.id}]::uuid[]
                     WHERE partner_id = ${s.partnerId} AND surface = 'chat'`;
    await fixtureSql`
      INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, role, default_offering_id)
      VALUES (${s.orgId}, ${s.partnerId}, 'helper', 'default', ${explicit!.id})`;
    await fixtureSql`UPDATE ai_sessions SET offering_id = ${explicit!.id} WHERE id = ${s.chatSessionId}`;
    // The partner pins the seeded model as its default (as legacy_default_model).
    await fixtureSql`UPDATE partner_ai_connections SET legacy_default_model = ${s.modelId} WHERE id = ${s.connectionId}`;

    const rotated = await savePartnerLlmKey({ partnerId: s.partnerId, apiKey: 'sk-ant-api03-authority-0002', userId: s.userId });
    expect(rotated.configVersion).toBe(2);
    const [conn] = await fixtureSql`SELECT id, key_last4, config_version FROM partner_ai_connections WHERE partner_id = ${s.partnerId}`;
    expect(conn).toMatchObject({ id: s.connectionId, key_last4: '0002', config_version: 2 });

    let chat = await chatDefault(s.partnerId);
    expect(chat.options).toEqual({ effort: 'high' });
    expect(chat.offering_id).toBe(s.offeringId);

    await updatePartnerLlmConfig({ partnerId: s.partnerId, defaultModel: otherModel });
    chat = await chatDefault(s.partnerId);
    expect(chat).toMatchObject({ offering_id: explicit!.id, conn: s.connectionId, options: { effort: 'high' } });
    const [chatRow] = await fixtureSql`SELECT fallback_offering_ids FROM ai_model_assignments WHERE partner_id = ${s.partnerId} AND surface = 'chat'`;
    expect(chatRow!.fallback_offering_ids).toEqual([explicit!.id]);
    const orgRows = await fixtureSql`SELECT default_offering_id FROM ai_model_assignments WHERE org_id = ${s.orgId}`;
    expect(orgRows).toEqual([{ default_offering_id: explicit!.id }]);
    const [session] = await fixtureSql`SELECT offering_id FROM ai_sessions WHERE id = ${s.chatSessionId}`;
    expect(session!.offering_id).toBe(explicit!.id);
    // The old default still serves the surfaces that never followed the
    // partner default (script_reviewer / extension_content), so it stays enabled.
    expect(await offering(s.offeringId)).toMatchObject({ enabled: true });
    const [reviewer] = await fixtureSql`SELECT default_offering_id FROM ai_model_assignments WHERE partner_id = ${s.partnerId} AND surface = 'script_reviewer'`;
    expect(reviewer!.default_offering_id).toBe(s.offeringId);

    // Disconnect keeps the org override and the session's explicit model — on the platform.
    await deletePartnerLlmConfig(s.partnerId);
    const [org] = await fixtureSql`
      SELECT o.connection_id, pm.model_id FROM ai_model_assignments a JOIN partner_ai_models o ON o.id = a.default_offering_id
        JOIN ai_platform_models pm ON pm.id = o.platform_model_id WHERE a.org_id = ${s.orgId}`;
    expect(org).toEqual({ connection_id: null, model_id: otherModel });
    const [chatAfter] = await fixtureSql`SELECT options FROM ai_model_assignments WHERE partner_id = ${s.partnerId} AND surface = 'chat'`;
    expect(chatAfter!.options).toEqual({ effort: 'high' });
    expect(await fixtureSql`SELECT 1 FROM ai_model_assignments WHERE org_id = ${s.orgId}`).toHaveLength(1);
    expect(reconcileSpy.calls).toEqual([]);
  });

  // W08 (#7606): the cutover is a registry-native bootstrap. A not-yet-cut-over
  // partner with a legacy row also has the W02-copied connection (same id); the
  // bootstrap adopts it and never projects legacy config.
  it('a partner that is not cut over yet is bootstrapped onto its copied connection first (no projection), then edited natively', async () => {
    const partner = await createPartner();
    await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id });
    const legacyId = randomUUID();
    const sealed = encryptSecret('sk-ant-api03-legacy-0003', { aad: columnAad(keySpec('partner_llm_configs'), legacyId) })!;
    await fixtureSql`INSERT INTO partner_llm_configs (id, partner_id, api_key_encrypted, key_last4, key_fingerprint, connected_by)
                     VALUES (${legacyId}, ${partner.id}, ${sealed}, '0003', 'fp', ${user.id})`;
    await seedByokConnection(partner.id, legacyId);

    await updatePartnerLlmConfig({ partnerId: partner.id, defaultModel: 'claude-haiku-4-5' });
    expect(reconcileSpy.calls).toEqual([]);   // no projection: the cutover bootstraps natively
    expect(await fixtureSql`SELECT 1 FROM ai_model_registry_partner_cutover WHERE partner_id = ${partner.id}`).toHaveLength(1);
    expect(await chatDefault(partner.id)).toMatchObject({ conn: legacyId, model: 'claude-haiku-4-5' });
    // The legacy row is frozen: the native edit is not written back.
    const [legacy] = await fixtureSql`SELECT default_model, config_version FROM partner_llm_configs WHERE id = ${legacyId}`;
    expect(legacy).toEqual({ default_model: null, config_version: 1 });

    await updatePartnerLlmConfig({ partnerId: partner.id, defaultModel: null });
    expect(reconcileSpy.calls).toEqual([]);
    expect(await sys(() => getPartnerLlmStatus(partner.id))).toMatchObject({ defaultModel: null });
  });

  it('a revoked key never survives in partner_llm_configs: rotate and disconnect remove the legacy ciphertext (#7700 finding 4)', async () => {
    const seedLegacy = async (suffix: string) => {
      const partner = await createPartner();
      await createOrganization({ partnerId: partner.id });
      const user = await createUser({ partnerId: partner.id });
      const legacyId = randomUUID();
      const sealed = encryptSecret(`sk-ant-api03-legacy-${suffix}`, { aad: columnAad(keySpec('partner_llm_configs'), legacyId) })!;
      await fixtureSql`INSERT INTO partner_llm_configs (id, partner_id, api_key_encrypted, key_last4, key_fingerprint, connected_by)
                       VALUES (${legacyId}, ${partner.id}, ${sealed}, ${suffix}, 'fp', ${user.id})`;
      await seedByokConnection(partner.id, legacyId);   // the W02 copy (W08: the cutover no longer projects)
      return { partnerId: partner.id, userId: user.id, sealed };
    };
    const holdsCiphertext = async (sealed: string) =>
      fixtureSql`SELECT 1 FROM partner_llm_configs WHERE api_key_encrypted = ${sealed}`;

    // Rotation (cuts the partner over first, then rotates in place).
    const rotated = await seedLegacy('0011');
    await savePartnerLlmKey({ partnerId: rotated.partnerId, apiKey: 'sk-ant-api03-authority-0012', userId: rotated.userId });
    expect(await sys(() => getPartnerLlmStatus(rotated.partnerId))).toMatchObject({ configured: true, keyLast4: '0012' });
    expect(await holdsCiphertext(rotated.sealed)).toHaveLength(0);
    expect(await fixtureSql`SELECT 1 FROM partner_llm_configs WHERE partner_id = ${rotated.partnerId}`).toHaveLength(0);

    // Disconnect.
    const disconnected = await seedLegacy('0013');
    expect(await deletePartnerLlmConfig(disconnected.partnerId)).toBe(true);
    expect(await holdsCiphertext(disconnected.sealed)).toHaveLength(0);
    expect(await fixtureSql`SELECT 1 FROM partner_llm_configs WHERE partner_id = ${disconnected.partnerId}`).toHaveLength(0);
  });

  it('the legacy resolver reads the connection: a runtime credential failure marks the connection', async () => {
    const s = await seedRegistryPartner('byok');
    const resolved = await resolveLlmConfig(s.partnerId);
    expect(resolved).toMatchObject({ source: 'partner', configId: s.connectionId, configVersion: 1 });
    expect(await markPartnerLlmError({ configId: s.connectionId!, configVersion: 1, reason: 'auth_rejected' })).toBe(true);
    expect(await sys(() => getPartnerLlmStatus(s.partnerId))).toMatchObject({ status: 'error', lastError: 'auth_rejected' });
    expect(await resolveLlmConfig(s.partnerId)).toEqual({ source: 'unavailable', partnerId: s.partnerId, reason: 'key_error' });
    // A rotation clears it.
    await savePartnerLlmKey({ partnerId: s.partnerId, apiKey: 'sk-ant-api03-authority-0004', userId: s.userId });
    expect(await resolveLlmConfig(s.partnerId)).toMatchObject({ source: 'partner', apiKey: 'sk-ant-api03-authority-0004', configVersion: 2 });
  });

  it('the legacy mirror trigger is gone', async () => {
    const t = await sys(() => db.execute(sql`SELECT 1 FROM pg_trigger WHERE tgname = 'partner_llm_configs_mirror_to_connection'`));
    expect(t).toHaveLength(0);
    const f = await sys(() => db.execute(sql`SELECT 1 FROM pg_proc WHERE proname = 'partner_llm_configs_mirror_to_connection'`));
    expect(f).toHaveLength(0);
  });
});
