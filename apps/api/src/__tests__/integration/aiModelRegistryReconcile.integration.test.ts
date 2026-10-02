/**
 * W02 reconcile against real Postgres (#7600): the DB state it writes is
 * semantically the projection (every parity query resolves identically over
 * the DB and over the pure desired state), it is idempotent, concurrent runs
 * converge, and deletion / reconnect / kind-switch / errored / unknown-model
 * shapes hold.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { columnAad } from '../../services/encryptedColumnRegistry';
import { decryptSecret, encryptSecret } from '../../services/secretCrypto';
import { buildDesiredRegistryState, type LegacyProjectionEnv } from '../../services/aiModels/legacyProjection';
import { loadLegacySnapshot, lockPartnerRegistryReconcile, reconcilePartnerFromLegacy, reconcilePartnerFromLegacyInTx } from '../../services/aiModels/legacyReconcile';
import { parityQueries, type ParityFixture } from '../../services/aiModels/parity/harness';
import { materializeDesiredState, projectSurfaceUse, type RegistrySnapshot } from '../../services/aiModels/parity/storeProjection';
import { getLegacyModelRates } from '../../services/aiModels/legacySurfaceModels';
import { deletePartnerLlmConfig, getPartnerLlmStatus, updatePartnerLlmConfig } from '../../services/partnerLlmConfig';
import { markPartnerLlmError } from '../../services/llm/llmConfigResolver';
import { cutoverPartner } from '../../services/aiModels/registryCutover';
import { createOrganization, createPartner, createUser } from './db-utils';
import { closeRegistryFixtures, fixtureSql as adminSql, keySpec, seedAgent, seedByokConnection } from './aiModelRegistryFixtures';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

const env: LegacyProjectionEnv = {
  defaultModel: 'claude-sonnet-5-5',
  reviewerModel: 'claude-sonnet-5-5',
  extensionModel: 'claude-haiku-4-5',
  legacyRates: (m) => getLegacyModelRates(m).rates,
};

/** Drizzle wraps a failed statement as `Failed query: …`; the Postgres error is the cause. */
function pgMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? error.cause.message : error.message;
}

async function pgCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

async function seedLegacyConfig(partnerId: string, over: { defaultModel?: string | null; status?: 'active' | 'error'; key?: string } = {}): Promise<string> {
  const id = randomUUID();
  const sealed = encryptSecret(over.key ?? 'sk-ant-api03-reconcile-0042', { aad: columnAad(keySpec('partner_llm_configs'), id) })!;
  await adminSql`INSERT INTO partner_llm_configs (id, partner_id, api_key_encrypted, key_last4, key_fingerprint, default_model, status)
                 VALUES (${id}, ${partnerId}, ${sealed}, '0042', 'fp', ${over.defaultModel ?? null}, ${over.status ?? 'active'})`;
  return id;
}

/**
 * W08 (#7606): the cutover no longer projects legacy config. A partner with a
 * legacy row always also has the W02-copied connection (same id), which the
 * W08 bootstrap adopts — seed that copy so the facade cases below exercise
 * the state a real un-cut-over partner is in.
 */
async function seedLegacyConfigWithCopy(partnerId: string): Promise<string> {
  const id = await seedLegacyConfig(partnerId);
  await seedByokConnection(partnerId, id);
  return id;
}

/** Read the registry back from the DB in the storeProjection shape. */
async function registryFromDb(partnerId: string): Promise<RegistrySnapshot> {
  const [connections, offerings, platformModels, assignments, agents, sessions] = await Promise.all([
    adminSql`SELECT id, kind, status, api_key_encrypted FROM partner_ai_connections WHERE partner_id = ${partnerId}`,
    adminSql`SELECT id, connection_id, model_id, platform_model_id, enabled FROM partner_ai_models WHERE partner_id = ${partnerId}`,
    adminSql`SELECT id, model_id FROM ai_platform_models`,
    adminSql`SELECT * FROM ai_model_assignments WHERE offering_partner_id = ${partnerId}`,
    adminSql`SELECT a.id, a.kind, a.org_id, a.offering_id FROM ai_agents a LEFT JOIN organizations o ON o.id = a.org_id
             WHERE a.partner_id = ${partnerId} OR o.partner_id = ${partnerId}`,
    adminSql`SELECT s.id, s.offering_id FROM ai_sessions s JOIN organizations o ON o.id = s.org_id WHERE o.partner_id = ${partnerId}`,
  ]);
  return {
    partnerId,
    connections: connections.map((c) => ({ id: c.id, kind: c.kind, status: c.status, apiKeyEncrypted: c.api_key_encrypted })),
    offerings: offerings.map((o) => ({ id: o.id, connectionId: o.connection_id, modelId: o.model_id, platformModelId: o.platform_model_id, enabled: o.enabled })),
    platformModels: platformModels.map((m) => ({ id: m.id, modelId: m.model_id })),
    assignments: assignments.map((a) => ({
      id: a.id, role: a.role, orgId: a.org_id, surface: a.surface, defaultOfferingId: a.default_offering_id,
      permittedOfferingIds: a.permitted_offering_ids, allowUserChoice: a.allow_user_choice, options: a.options,
      fallbackOfferingIds: a.fallback_offering_ids, fallbackMayCrossFunding: a.fallback_may_cross_funding,
    })),
    agents: agents.map((a) => ({ id: a.id, kind: a.kind, orgId: a.org_id, offeringId: a.offering_id })),
    sessions: sessions.map((s) => ({ id: s.id, offeringId: s.offering_id })),
    catalogProvider: null,
  };
}

async function seedRichPartner() {
  const partner = await createPartner();
  const [orgA, orgB] = [await createOrganization({ partnerId: partner.id }), await createOrganization({ partnerId: partner.id })];
  const user = await createUser({ partnerId: partner.id });
  const configId = await seedLegacyConfig(partner.id, { defaultModel: 'claude-opus-5-5' });
  await adminSql`INSERT INTO ai_script_policies (partner_id, reviewer_model) VALUES (${partner.id}, 'claude-haiku-4-5')`;
  await adminSql`INSERT INTO client_ai_org_policies (org_id, allowed_models) VALUES (${orgA.id}, '["claude-haiku-4-5-20251001"]'::jsonb)`;
  await adminSql`INSERT INTO ai_budgets (org_id, allowed_models) VALUES (${orgA.id}, '["claude-haiku-4-5"]'::jsonb)`;
  await seedAgent({ partnerId: partner.id, createdBy: user.id, model: 'claude-opus-5-5' });
  await seedAgent({ orgId: orgA.id, createdBy: user.id, model: 'claude-haiku-4-5' });
  const [live] = await adminSql`INSERT INTO ai_sessions (org_id, model, status) VALUES (${orgB.id}, 'claude-sonnet-5-5', 'active') RETURNING id`;
  const [stale] = await adminSql`INSERT INTO ai_sessions (org_id, model, status, created_at, last_activity_at)
                                VALUES (${orgB.id}, 'claude-sonnet-5-5', 'active', now() - interval '3 days', now() - interval '3 days') RETURNING id`;
  return { partner, orgA, orgB, configId, liveSessionId: String(live!.id), staleSessionId: String(stale!.id) };
}

/** Every parity query resolves identically over the DB and over the pure projection of the CURRENT legacy state. */
async function expectDbMatchesProjection(partnerId: string, projectionEnv: LegacyProjectionEnv = env): Promise<void> {
  const snapshot = await withSystemDbAccessContext(() => loadLegacySnapshot(partnerId));
  const fixture: ParityFixture = { name: 'db', env: {}, snapshot, legacyApiKey: null, catalogProvider: null };
  const [legacyRow] = snapshot.config ? await adminSql`SELECT api_key_encrypted FROM partner_llm_configs WHERE id = ${snapshot.config.id}` : [];
  const fromProjection = materializeDesiredState(buildDesiredRegistryState(snapshot, projectionEnv), fixture, legacyRow?.api_key_encrypted ?? null);
  const fromDb = await registryFromDb(partnerId);
  const queries = parityQueries(fixture);
  expect(queries.length).toBeGreaterThan(0);
  for (const q of queries) {
    expect(projectSurfaceUse(fromDb, q)).toEqual(projectSurfaceUse(fromProjection, q));
  }
}

describe.skipIf(!RUN)('legacy reconcile (#7600 W02)', () => {
  it('the DB state resolves every parity query exactly like the pure projection', async () => {
    const t = await seedRichPartner();
    await reconcilePartnerFromLegacy(t.partner.id, env);
    // Offering ids differ (keys vs uuids) but SurfaceUse carries none: destination
    // (platform | connection id), funding and models must match exactly.
    await expectDbMatchesProjection(t.partner.id);
    const [live] = await adminSql`SELECT offering_id FROM ai_sessions WHERE id = ${t.liveSessionId}`;
    const [stale] = await adminSql`SELECT offering_id FROM ai_sessions WHERE id = ${t.staleSessionId}`;
    expect(live!.offering_id).not.toBeNull();
    expect(stale!.offering_id).toBeNull();
  });

  it('a failure mid-reconcile throws and leaves nothing behind in the caller\'s transaction (never a partial report)', async () => {
    const t = await seedRichPartner();
    // Fail the assignment step for THIS partner only, after offerings were upserted.
    await adminSql.unsafe(`
      CREATE OR REPLACE FUNCTION w02_test_fail_assignments() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.offering_partner_id = '${t.partner.id}' THEN RAISE EXCEPTION 'injected reconcile failure'; END IF;
        RETURN NEW;
      END $f$;
      DROP TRIGGER IF EXISTS w02_test_fail_assignments ON ai_model_assignments;
      CREATE TRIGGER w02_test_fail_assignments BEFORE INSERT ON ai_model_assignments
        FOR EACH ROW EXECUTE FUNCTION w02_test_fail_assignments();`);
    try {
      let report: unknown = 'not-returned';
      let failure: unknown = null;
      try {
        await withSystemDbAccessContext(async () => {
          report = await reconcilePartnerFromLegacyInTx(t.partner.id, env);
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).not.toBeNull();
      expect(pgMessage(failure)).toMatch(/injected reconcile failure/);
      expect(report).toBe('not-returned');
      expect(await adminSql`SELECT 1 FROM partner_ai_connections WHERE partner_id = ${t.partner.id}`).toHaveLength(0);
      expect(await adminSql`SELECT 1 FROM partner_ai_models WHERE partner_id = ${t.partner.id}`).toHaveLength(0);
      expect(await adminSql`SELECT 1 FROM ai_model_assignments WHERE offering_partner_id = ${t.partner.id}`).toHaveLength(0);
      const [bound] = await adminSql`SELECT offering_id FROM ai_sessions WHERE id = ${t.liveSessionId}`;
      expect(bound!.offering_id).toBeNull();
    } finally {
      await adminSql.unsafe(`DROP TRIGGER IF EXISTS w02_test_fail_assignments ON ai_model_assignments;
                             DROP FUNCTION IF EXISTS w02_test_fail_assignments();`);
    }
  });

  it('is idempotent: a second run changes nothing', async () => {
    const t = await seedRichPartner();
    await reconcilePartnerFromLegacy(t.partner.id, env);
    const before = await adminSql`SELECT updated_at FROM partner_ai_connections WHERE id = ${t.configId}`;
    const counts = async () => (await adminSql`
      SELECT (SELECT count(*) FROM partner_ai_models WHERE partner_id = ${t.partner.id})::int AS offerings,
             (SELECT count(*) FROM ai_model_assignments WHERE offering_partner_id = ${t.partner.id})::int AS assignments`)[0];
    const first = await counts();
    const report = await reconcilePartnerFromLegacy(t.partner.id, env);
    expect(report).toMatchObject({ connection: 'unchanged', assignmentsDeleted: 0, agentsRebound: 0, sessionsRebound: 0 });
    expect(await counts()).toEqual(first);
    const after = await adminSql`SELECT updated_at FROM partner_ai_connections WHERE id = ${t.configId}`;
    expect(after[0]!.updated_at).toEqual(before[0]!.updated_at);
  });

  it('two concurrent reconciles converge (advisory lock + partial-unique upserts)', async () => {
    const t = await seedRichPartner();
    const results = await Promise.allSettled([reconcilePartnerFromLegacy(t.partner.id, env), reconcilePartnerFromLegacy(t.partner.id, env)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const [dupes] = await adminSql`
      SELECT count(*)::int AS n FROM (SELECT connection_id, model_id, platform_model_id FROM partner_ai_models
       WHERE partner_id = ${t.partner.id} GROUP BY 1, 2, 3 HAVING count(*) > 1) d`;
    expect(dupes!.n).toBe(0);
    const [assignmentDupes] = await adminSql`
      SELECT count(*)::int AS n FROM (SELECT org_id, partner_id, surface, role FROM ai_model_assignments
       WHERE offering_partner_id = ${t.partner.id} GROUP BY 1, 2, 3, 4 HAVING count(*) > 1) d`;
    expect(assignmentDupes!.n).toBe(0);
    await expectDbMatchesProjection(t.partner.id);
  });

  it('the partial unique indexes the upserts infer reject a duplicate offering / assignment (23505)', async () => {
    const t = await seedRichPartner();
    await reconcilePartnerFromLegacy(t.partner.id, env);
    const [platform] = await adminSql`SELECT platform_model_id FROM partner_ai_models WHERE partner_id = ${t.partner.id} AND connection_id IS NULL LIMIT 1`;
    const [onConn] = await adminSql`SELECT model_id, source FROM partner_ai_models WHERE connection_id = ${t.configId} LIMIT 1`;
    const [partnerRow] = await adminSql`SELECT surface FROM ai_model_assignments WHERE partner_id = ${t.partner.id} AND org_id IS NULL LIMIT 1`;
    const [orgRow] = await adminSql`SELECT org_id, surface FROM ai_model_assignments WHERE org_id = ${t.orgA.id} LIMIT 1`;
    expect([platform, onConn, partnerRow, orgRow].every(Boolean)).toBe(true);

    expect(await pgCode(() => adminSql`INSERT INTO partner_ai_models (partner_id, platform_model_id, source, enabled)
      VALUES (${t.partner.id}, ${platform!.platform_model_id}, 'platform', true)`)).toBe('23505');
    expect(await pgCode(() => adminSql`INSERT INTO partner_ai_models (partner_id, connection_id, model_id, source, enabled)
      VALUES (${t.partner.id}, ${t.configId}, ${onConn!.model_id}, 'manual', true)`)).toBe('23505');
    expect(await pgCode(() => adminSql`INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, role)
      VALUES (${t.partner.id}, ${t.partner.id}, ${partnerRow!.surface}, 'default')`)).toBe('23505');
    expect(await pgCode(() => adminSql`INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, role)
      VALUES (${orgRow!.org_id}, ${t.partner.id}, ${orgRow!.surface}, 'default')`)).toBe('23505');
  });

  it('an errored config keeps every partner-destination surface on its (errored) connection', async () => {
    const partner = await createPartner();
    await createOrganization({ partnerId: partner.id });
    const configId = await seedLegacyConfig(partner.id, { status: 'error' });
    await reconcilePartnerFromLegacy(partner.id, env);
    const [conn] = await adminSql`SELECT status FROM partner_ai_connections WHERE id = ${configId}`;
    expect(conn!.status).toBe('error');
    const rows = await adminSql`
      SELECT a.surface, m.connection_id FROM ai_model_assignments a JOIN partner_ai_models m ON m.id = a.default_offering_id
       WHERE a.partner_id = ${partner.id} AND a.org_id IS NULL`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.connection_id).toBe(r.surface === 'patch_test' ? null : configId);
  });

  it('an unknown platform default bootstraps one platform row, offered at the legacy rate, reused by every partner', async () => {
    const modelId = `w02-gateway-${randomUUID()}`;
    const [p, q] = [await createPartner(), await createPartner()];
    const r1 = await reconcilePartnerFromLegacy(p.id, { ...env, defaultModel: modelId });
    const r2 = await reconcilePartnerFromLegacy(q.id, { ...env, defaultModel: modelId });
    expect(r1.bootstrapPlatformModels).toEqual([modelId]);
    expect(r2.bootstrapPlatformModels).toEqual([]);
    // #7601 gap A: priced and offered exactly as legacy billed the env id (default-rate fallback), else self-host loses AI.
    const rows = await adminSql`SELECT platform_offered, input_cents_per_m::float8 AS input, output_cents_per_m::float8 AS output,
                                       cache_read_cents_per_m::float8 AS read, cache_write_cents_per_m::float8 AS write
                                  FROM ai_platform_models WHERE model_id = ${modelId}`;
    const legacy = getLegacyModelRates(modelId).rates;
    expect(rows).toEqual([{ platform_offered: true, input: legacy.inputCentsPerM, output: legacy.outputCentsPerM, read: legacy.cacheReadCentsPerM, write: legacy.cacheWriteCentsPerM }]);
  });

  // Final review (I): ai_platform_models is a global catalog. A tenant-typed id
  // must never create a row there (cross-tenant pollution; it would squat an id
  // a later seed migration's ON CONFLICT (model_id) DO NOTHING then skips).
  it('a tenant-typed unknown platform id never creates an ai_platform_models row; a deployment id still does (once)', async () => {
    const tenantModel = `w02-tenant-${randomUUID()}`;
    const envModel = `w02-env-${randomUUID()}`;
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id });
    const allow = JSON.stringify([tenantModel, 'claude-haiku-4-5']);
    await adminSql`INSERT INTO client_ai_org_policies (org_id, allowed_models) VALUES (${org.id}, ${allow}::jsonb)`;
    await adminSql`INSERT INTO ai_budgets (org_id, allowed_models) VALUES (${org.id}, ${allow}::jsonb)`;
    const agentId = await seedAgent({ orgId: org.id, createdBy: user.id, model: tenantModel });
    const [session] = await adminSql`INSERT INTO ai_sessions (org_id, model, status) VALUES (${org.id}, ${tenantModel}, 'active') RETURNING id`;
    const projectionEnv = { ...env, defaultModel: envModel };

    const first = await reconcilePartnerFromLegacy(partner.id, projectionEnv);
    expect(first.bootstrapPlatformModels).toEqual([envModel]);
    expect(first.unknownPlatformModelsSkipped).toBe(1);
    const second = await reconcilePartnerFromLegacy(partner.id, projectionEnv);
    expect(second.bootstrapPlatformModels).toEqual([]);
    expect(second.unknownPlatformModelsSkipped).toBe(1);

    expect(await adminSql`SELECT 1 FROM ai_platform_models WHERE model_id = ${tenantModel}`).toHaveLength(0);
    expect(await adminSql`SELECT 1 FROM ai_platform_models WHERE model_id = ${envModel}`).toHaveLength(1);
    expect(await adminSql`SELECT 1 FROM partner_ai_models m JOIN ai_platform_models p ON p.id = m.platform_model_id
                          WHERE m.partner_id = ${partner.id} AND p.model_id = ${tenantModel}`).toHaveLength(0);
    const [agent] = await adminSql`SELECT offering_id FROM ai_agents WHERE id = ${agentId}`;
    expect(agent!.offering_id).toBeNull();
    const [bound] = await adminSql`SELECT offering_id, offering_partner_id FROM ai_sessions WHERE id = ${session!.id}`;
    expect(bound).toEqual({ offering_id: null, offering_partner_id: null });
    const [office] = await adminSql`SELECT default_offering_id, cardinality(permitted_offering_ids) AS permitted
                                    FROM ai_model_assignments WHERE org_id = ${org.id} AND surface = 'office_chat'`;
    expect(office).toEqual({ default_offering_id: null, permitted: 1 });
    await expectDbMatchesProjection(partner.id, projectionEnv);
  });

  it('deleting the legacy config moves every surface and binding back to the platform and removes the connection', async () => {
    const t = await seedRichPartner();
    await reconcilePartnerFromLegacy(t.partner.id, env);
    await adminSql`DELETE FROM partner_llm_configs WHERE id = ${t.configId}`;
    const report = await reconcilePartnerFromLegacy(t.partner.id, env);
    expect(report.connection).toBe('removed');
    expect(await adminSql`SELECT 1 FROM partner_ai_connections WHERE partner_id = ${t.partner.id}`).toHaveLength(0);
    const onConnection = await adminSql`SELECT 1 FROM partner_ai_models WHERE partner_id = ${t.partner.id} AND connection_id IS NOT NULL`;
    expect(onConnection).toHaveLength(0);
    const [live] = await adminSql`SELECT offering_id FROM ai_sessions WHERE id = ${t.liveSessionId}`;
    expect(live!.offering_id).not.toBeNull();
    await expectDbMatchesProjection(t.partner.id);
  });

  it('delete-then-reconnect (a NEW legacy id, never reconciled in between) replaces the connection without a compat_uq conflict', async () => {
    const t = await seedRichPartner();
    await reconcilePartnerFromLegacy(t.partner.id, env);
    await adminSql`DELETE FROM partner_llm_configs WHERE id = ${t.configId}`;
    const newId = await seedLegacyConfig(t.partner.id, { defaultModel: 'claude-sonnet-4-6', key: 'sk-ant-api03-reconnected-9999' });
    const report = await reconcilePartnerFromLegacy(t.partner.id, env);
    expect(report.connection).toBe('created');
    const conns = await adminSql`SELECT id, api_key_encrypted FROM partner_ai_connections WHERE partner_id = ${t.partner.id}`;
    expect(conns.map((c) => c.id)).toEqual([newId]);
    // The old key left with its row; the new row carries the new key, decryptable under its own id.
    expect(decryptSecret(conns[0]!.api_key_encrypted, { aad: columnAad(keySpec('partner_ai_connections'), newId) }))
      .toBe('sk-ant-api03-reconnected-9999');
    expect(await adminSql`SELECT 1 FROM partner_ai_models WHERE connection_id = ${t.configId}`).toHaveLength(0);
    const [chat] = await adminSql`
      SELECT m.connection_id, m.model_id FROM ai_model_assignments a JOIN partner_ai_models m ON m.id = a.default_offering_id
       WHERE a.partner_id = ${t.partner.id} AND a.org_id IS NULL AND a.surface = 'chat'`;
    expect(chat).toEqual({ connection_id: newId, model_id: 'claude-sonnet-4-6' });
    const [live] = await adminSql`
      SELECT m.connection_id FROM ai_sessions s JOIN partner_ai_models m ON m.id = s.offering_id WHERE s.id = ${t.liveSessionId}`;
    expect(live!.connection_id).toBe(newId);
    await expectDbMatchesProjection(t.partner.id);
  });

  it('removing an orphan connection first clears refusal-fallback references into its offerings (that FK has no ON DELETE)', async () => {
    const t = await seedRichPartner();
    await reconcilePartnerFromLegacy(t.partner.id, env);
    const [doomed] = await adminSql`SELECT id FROM partner_ai_models WHERE connection_id = ${t.configId} LIMIT 1`;
    const [platformOffering] = await adminSql`SELECT id FROM partner_ai_models WHERE partner_id = ${t.partner.id} AND connection_id IS NULL LIMIT 1`;
    // Forge a reference from OUTSIDE the doomed connection (the integrity
    // trigger forbids it on the normal path, so bypass it for this one write).
    await adminSql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE partner_ai_models SET refusal_fallback_offering_id = ${doomed!.id} WHERE id = ${platformOffering!.id}`;
    });
    await adminSql`DELETE FROM partner_llm_configs WHERE id = ${t.configId}`;
    const report = await reconcilePartnerFromLegacy(t.partner.id, env);
    expect(report.connection).toBe('removed');
    const [after] = await adminSql`SELECT refusal_fallback_offering_id FROM partner_ai_models WHERE id = ${platformOffering!.id}`;
    expect(after!.refusal_fallback_offering_id).toBeNull();
    expect(await adminSql`SELECT 1 FROM partner_ai_connections WHERE partner_id = ${t.partner.id}`).toHaveLength(0);
  });

  it('an agent / live session whose org moved to another partner mid-reconcile is skipped, not a 23503 abort', async () => {
    const t = await seedRichPartner();
    const other = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: other.id });
    const [orgAgent] = await adminSql`SELECT id FROM ai_agents WHERE org_id = ${t.orgA.id}`;
    // After the snapshot is taken (the first offering upsert), move the live
    // session and the org agent into another partner's org, in the same
    // transaction, before the rebind step runs.
    await adminSql.unsafe(`
      CREATE OR REPLACE FUNCTION w02_test_move_mid_reconcile() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        UPDATE ai_sessions SET org_id = '${foreignOrg.id}' WHERE id = '${t.liveSessionId}' AND org_id <> '${foreignOrg.id}';
        UPDATE ai_agents SET org_id = '${foreignOrg.id}' WHERE id = '${orgAgent!.id}' AND org_id <> '${foreignOrg.id}';
        RETURN NULL;
      END $f$;
      DROP TRIGGER IF EXISTS w02_test_move_mid_reconcile ON partner_ai_models;
      CREATE TRIGGER w02_test_move_mid_reconcile AFTER INSERT ON partner_ai_models
        FOR EACH ROW WHEN (NEW.partner_id = '${t.partner.id}') EXECUTE FUNCTION w02_test_move_mid_reconcile();`);
    try {
      const report = await reconcilePartnerFromLegacy(t.partner.id, env);
      expect(report.sessionsRebound).toBe(0);
      const [session] = await adminSql`SELECT org_id, offering_id FROM ai_sessions WHERE id = ${t.liveSessionId}`;
      expect(session).toEqual({ org_id: foreignOrg.id, offering_id: null });
      const [agent] = await adminSql`SELECT org_id, offering_id FROM ai_agents WHERE id = ${orgAgent!.id}`;
      expect(agent).toEqual({ org_id: foreignOrg.id, offering_id: null });
    } finally {
      await adminSql.unsafe(`DROP TRIGGER IF EXISTS w02_test_move_mid_reconcile ON partner_ai_models;
                             DROP FUNCTION IF EXISTS w02_test_move_mid_reconcile();`);
    }
  });

  it('a caller that already holds the partner lock can reconcile in the same transaction (xact advisory locks are re-entrant)', async () => {
    const t = await seedRichPartner();
    const report = await withSystemDbAccessContext(async () => {
      await lockPartnerRegistryReconcile(t.partner.id);
      return reconcilePartnerFromLegacyInTx(t.partner.id, env);
    });
    expect(report.connection).toBe('created');
    // Released at commit: a fresh transaction takes it again without waiting.
    await expect(reconcilePartnerFromLegacy(t.partner.id, env)).resolves.toMatchObject({ connection: 'unchanged' });
  });

  it('a BYOK→catalog switch updates offerings in place (same ids)', async () => {
    const partner = await createPartner();
    await createOrganization({ partnerId: partner.id });
    const configId = await seedLegacyConfig(partner.id, { defaultModel: 'claude-sonnet-4-6' });
    await reconcilePartnerFromLegacy(partner.id, env);
    const [before] = await adminSql`SELECT id FROM partner_ai_models WHERE connection_id = ${configId} AND model_id = 'claude-sonnet-4-6'`;
    const [entry] = await adminSql`INSERT INTO llm_provider_catalog (slug, name, status) VALUES (${`w02-${randomUUID()}`}, 'Gateway', 'listed') RETURNING id`;
    await adminSql`UPDATE partner_llm_configs SET catalog_entry_id = ${entry!.id}, config_version = config_version + 1 WHERE id = ${configId}`;
    await reconcilePartnerFromLegacy(partner.id, env);
    const [after] = await adminSql`SELECT id, source, price_input_cents_per_m FROM partner_ai_models WHERE connection_id = ${configId} AND model_id = 'claude-sonnet-4-6'`;
    expect(after).toEqual({ id: before!.id, source: 'catalog', price_input_cents_per_m: null });
    const [conn] = await adminSql`SELECT kind, catalog_entry_id FROM partner_ai_connections WHERE id = ${configId}`;
    expect(conn).toEqual({ kind: 'catalog', catalog_entry_id: entry!.id });
  });
});

describe.skipIf(!RUN)('/ai/provider facade on the registry (#7600 W02; registry-native since #7601 Task 6B)', () => {
  it('PATCH → GET reflects the new pin from the registry, and every partner-default surface moves with it', async () => {
    const partner = await createPartner();
    await createOrganization({ partnerId: partner.id });
    const configId = await seedLegacyConfig(partner.id);
    await reconcilePartnerFromLegacy(partner.id);
    expect(await withSystemDbAccessContext(() => getPartnerLlmStatus(partner.id))).toMatchObject({ configured: true, defaultModel: null });

    await updatePartnerLlmConfig({ partnerId: partner.id, defaultModel: 'claude-haiku-4-5' });
    expect(await withSystemDbAccessContext(() => getPartnerLlmStatus(partner.id))).toMatchObject({ defaultModel: 'claude-haiku-4-5' });
    const [chat] = await adminSql`
      SELECT m.model_id, m.connection_id FROM ai_model_assignments a JOIN partner_ai_models m ON m.id = a.default_offering_id
       WHERE a.partner_id = ${partner.id} AND a.org_id IS NULL AND a.surface = 'chat'`;
    expect(chat).toEqual({ model_id: 'claude-haiku-4-5', connection_id: configId });

    await updatePartnerLlmConfig({ partnerId: partner.id, defaultModel: null });
    expect(await withSystemDbAccessContext(() => getPartnerLlmStatus(partner.id))).toMatchObject({ defaultModel: null });
  });

  it('GET reads the registry (a registry-only change is what GET returns)', async () => {
    const partner = await createPartner();
    const configId = await seedLegacyConfig(partner.id);
    await reconcilePartnerFromLegacy(partner.id);
    await adminSql`UPDATE partner_ai_connections SET key_last4 = 'zzzz' WHERE id = ${configId}`;
    expect((await withSystemDbAccessContext(() => getPartnerLlmStatus(partner.id))).keyLast4).toBe('zzzz');
  });

  it('GET runs under the request partner context: the owner sees its connection, another partner sees the platform', async () => {
    const partner = await createPartner();
    const other = await createPartner();
    await seedLegacyConfig(partner.id);
    await reconcilePartnerFromLegacy(partner.id);
    const asPartner = (partnerId: string) => ({ scope: 'partner' as const, orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [partnerId], userId: null });
    expect(await withDbAccessContext(asPartner(partner.id), () => getPartnerLlmStatus(partner.id))).toMatchObject({ configured: true, keyLast4: '0042' });
    expect(await withDbAccessContext(asPartner(other.id), () => getPartnerLlmStatus(partner.id))).toMatchObject({ configured: false, status: 'platform' });
  });

  // W03 Task 6B (R3): the W02 mirror trigger is gone — markPartnerLlmError
  // writes the connection itself and the legacy row is never touched.
  it('a runtime credential failure (markPartnerLlmError) marks the connection directly; the legacy row stays frozen', async () => {
    const partner = await createPartner();
    const configId = await seedLegacyConfigWithCopy(partner.id);
    await cutoverPartner(partner.id);
    expect(await markPartnerLlmError({ configId, configVersion: 1, reason: 'auth_rejected' })).toBe(true);
    expect(await withSystemDbAccessContext(() => getPartnerLlmStatus(partner.id))).toMatchObject({ status: 'error', lastError: 'auth_rejected' });
    const [legacy] = await adminSql`SELECT status, last_error FROM partner_llm_configs WHERE id = ${configId}`;
    expect(legacy).toEqual({ status: 'active', last_error: null });
  });

  // W03 Task 6B (finding 9): the W02 race (a reconcile mirroring a legacy status
  // read before the error stamp committed) cannot happen to a cut-over partner —
  // nothing re-projects it, so a later cutover attempt is a no-op.
  it('after cutover, a runtime error stamp is never reverted by a later cutover attempt', async () => {
    const partner = await createPartner();
    const configId = await seedLegacyConfigWithCopy(partner.id);
    expect(await cutoverPartner(partner.id)).toBe('done');
    expect(await markPartnerLlmError({ configId, configVersion: 1, reason: 'auth_rejected' })).toBe(true);
    expect(await cutoverPartner(partner.id)).toBe('already');
    const [conn] = await adminSql`SELECT status, last_error FROM partner_ai_connections WHERE id = ${configId}`;
    expect(conn).toEqual({ status: 'error', last_error: 'auth_rejected' });
  });

  it('DELETE → GET reports the platform and the registry holds no LIVE connection (soft-disconnected, keyless)', async () => {
    const partner = await createPartner();
    await createOrganization({ partnerId: partner.id });
    await seedLegacyConfig(partner.id);
    await reconcilePartnerFromLegacy(partner.id);
    expect(await deletePartnerLlmConfig(partner.id)).toBe(true);
    expect(await withSystemDbAccessContext(() => getPartnerLlmStatus(partner.id))).toMatchObject({ configured: false, status: 'platform' });
    // #7700 finding 1: kept as provenance, never deleted — but keyless and not live.
    expect(await adminSql`SELECT status, api_key_encrypted FROM partner_ai_connections WHERE partner_id = ${partner.id}`)
      .toEqual([{ status: 'disconnected', api_key_encrypted: null }]);
  });

  // W03 Task 6B: the gate cuts the partner over first (its one projection), so
  // the platform assignments exist; the 409 itself writes no connection and no
  // legacy row.
  it('a 409 (no key yet) writes no connection and no legacy row', async () => {
    const partner = await createPartner();
    await expect(updatePartnerLlmConfig({ partnerId: partner.id, defaultModel: 'claude-haiku-4-5' })).rejects.toMatchObject({ status: 409 });
    expect(await adminSql`SELECT 1 FROM ai_model_registry_partner_cutover WHERE partner_id = ${partner.id}`).toHaveLength(1);
    expect(await adminSql`SELECT 1 FROM partner_llm_configs WHERE partner_id = ${partner.id}`).toHaveLength(0);
    expect(await adminSql`SELECT 1 FROM partner_ai_connections WHERE partner_id = ${partner.id}`).toHaveLength(0);
  });

  // W03 Task 6B: facade writes and the partner's cutover take the same
  // per-partner lock, so a write racing a request's cutover never deadlocks,
  // the partner is bootstrapped once (W08), and the last native edit wins.
  it('facade writes racing the cutover never deadlock and converge on the last native edit', async () => {
    const partner = await createPartner();
    await createOrganization({ partnerId: partner.id });
    const configId = await seedLegacyConfigWithCopy(partner.id);
    const models = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-sonnet-4-6'];
    for (const model of models) {
      await Promise.all([
        cutoverPartner(partner.id),
        updatePartnerLlmConfig({ partnerId: partner.id, defaultModel: model }),
        cutoverPartner(partner.id),
      ]);
    }
    expect(await withSystemDbAccessContext(() => getPartnerLlmStatus(partner.id))).toMatchObject({ defaultModel: 'claude-sonnet-4-6' });
    const [chat] = await adminSql`
      SELECT m.model_id, m.connection_id FROM ai_model_assignments a JOIN partner_ai_models m ON m.id = a.default_offering_id
       WHERE a.partner_id = ${partner.id} AND a.org_id IS NULL AND a.surface = 'chat'`;
    expect(chat).toEqual({ model_id: 'claude-sonnet-4-6', connection_id: configId });
  });
});
