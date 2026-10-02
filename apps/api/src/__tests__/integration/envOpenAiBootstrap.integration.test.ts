/**
 * W06 Task 15 (#7604, Decision D6) against real Postgres: the MCP_LLM_* env
 * bootstrap creates exactly one env-managed openai_compatible connection and
 * one priced, enabled manual offering per partner, re-points the partner's
 * chat default once and only from a platform offering, never touches other
 * surfaces or org overrides, and is idempotent across restarts AND across
 * replicas booting concurrently (the per-partner registry lock). The cutover
 * runs first and can never undo it.
 *
 * DNS for the env base URL is stubbed to a public address so the egress
 * policy passes deterministically offline. Verification enqueue is stubbed
 * (ids only — asserted); the verifier has its own suite.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setLookupForTests } from '../../services/urlSafety';
import {
  ENV_CONNECTION_NAME,
  bootstrapEnvOpenAiConnections,
  type EnvBootstrapReport,
  type EnvOpenAiSettings,
} from '../../services/aiModels/envOpenAiBootstrap';
import { __resetRegistryCutoverMemoForTests, cutoverPartner } from '../../services/aiModels/registryCutover';
import { createManualOffering, deleteGatewayConnection, updateGatewayConnection } from '../../services/aiModels/gatewayConnections';
import { updateOfferingDetails } from '../../services/aiModels/offeringWrites';
import { getOffering } from '../../services/aiModels/offerings';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { FIDELITY_HARNESS_VERSION } from '../../services/llm/providerFidelityHarness';
import { endpointFingerprint, verifiedCapabilitiesTree } from '../../services/aiModels/gatewayCapabilities';
import { partnerRegistryReconcileLockKey } from '../../services/aiModels/legacyReconcile';
import { closeRegistryFixtures, fixtureSql } from './aiModelRegistryFixtures';
import { seedRegistryPartner } from './helpers/aiModelRegistrySeed';
import { createPartner } from './db-utils';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

const SETTINGS: EnvOpenAiSettings = {
  baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-env-integration-0001', model: 'qwen', inputCentsPerM: 15, outputCentsPerM: 60,
};

const savedHosted = process.env.IS_HOSTED;
const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => {
  process.env.IS_HOSTED = 'false';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-w06-integration-placeholder';
  __setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
});
afterEach(() => {
  __setLookupForTests(null);
  if (savedHosted === undefined) delete process.env.IS_HOSTED; else process.env.IS_HOSTED = savedHosted;
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
});

function run(partnerIds: string[], settings: EnvOpenAiSettings | null = SETTINGS, enqueue = vi.fn(async () => {})): Promise<EnvBootstrapReport> {
  return bootstrapEnvOpenAiConnections({ settings, partnerIds, enqueueVerification: enqueue });
}

interface EnvConnRow { id: string; status: string; base_url: string; provider_config: Record<string, unknown> | null; config_version: number; key_last4: string | null; api_key_encrypted: string | null }
async function envConnections(partnerId: string): Promise<EnvConnRow[]> {
  return fixtureSql<EnvConnRow[]>`
    SELECT id, status, base_url, provider_config, config_version, key_last4, api_key_encrypted
      FROM partner_ai_connections
     WHERE partner_id = ${partnerId} AND kind = 'openai_compatible'
     ORDER BY created_at`;
}
interface OfferingRow { id: string; model_id: string; source: string; enabled: boolean; capabilities: unknown; in: string; out: string; cr: string; cw: string }
async function offerings(connectionId: string): Promise<OfferingRow[]> {
  return fixtureSql<OfferingRow[]>`
    SELECT id, model_id, source, enabled, capabilities,
           price_input_cents_per_m::text AS in, price_output_cents_per_m::text AS out,
           price_cache_read_cents_per_m::text AS cr, price_cache_write_cents_per_m::text AS cw
      FROM partner_ai_models WHERE connection_id = ${connectionId} ORDER BY created_at`;
}
interface AssignmentRow { id: string; surface: string; org_id: string | null; default_offering_id: string | null; permitted_offering_ids: string[] | null; updated_at: Date }
async function assignments(partnerId: string): Promise<AssignmentRow[]> {
  return fixtureSql<AssignmentRow[]>`
    SELECT id, surface, org_id, default_offering_id, permitted_offering_ids, updated_at
      FROM ai_model_assignments WHERE offering_partner_id = ${partnerId} ORDER BY surface, org_id NULLS FIRST`;
}
const partnerChat = async (partnerId: string) =>
  (await assignments(partnerId)).find((a) => a.surface === 'chat' && a.org_id === null);

describe.skipIf(!RUN)('MCP_LLM_* env bootstrap (real DB)', () => {
  it('two partners, two boots: one env connection + one priced enabled offering each; chat re-pointed only from platform, once', async () => {
    const platform = await seedRegistryPartner('platform');
    const byok = await seedRegistryPartner('byok');
    const byokBefore = await assignments(byok.partnerId);
    const platformBefore = await assignments(platform.partnerId);
    const enqueue = vi.fn(async () => {});

    const first = await run([platform.partnerId, byok.partnerId], SETTINGS, enqueue);
    expect(first).toMatchObject({ partners: 2, created: 2, chatRepointed: 1, failed: [], error: null });

    for (const partnerId of [platform.partnerId, byok.partnerId]) {
      const conns = await envConnections(partnerId);
      expect(conns).toHaveLength(1);
      expect(conns[0]).toMatchObject({ status: 'active', base_url: SETTINGS.baseUrl, key_last4: '0001' });
      expect(conns[0]!.provider_config).toMatchObject({ managedBy: 'env', envModel: 'qwen' });
      expect(conns[0]!.api_key_encrypted).not.toContain(SETTINGS.apiKey!);
      const offs = await offerings(conns[0]!.id);
      expect(offs).toEqual([expect.objectContaining({
        model_id: 'qwen', source: 'manual', enabled: true, capabilities: null,
        in: '15.000000', out: '60.000000', cr: '15.000000', cw: '0.000000',
      })]);
    }
    const [envConn] = await envConnections(platform.partnerId);
    const [envOffering] = await offerings(envConn!.id);
    expect((await partnerChat(platform.partnerId))!.default_offering_id).toBe(envOffering!.id);

    // Every other surface of the platform partner is untouched.
    const platformAfter = await assignments(platform.partnerId);
    expect(platformAfter.filter((a) => a.surface !== 'chat')).toEqual(platformBefore.filter((a) => a.surface !== 'chat'));
    // The BYOK partner's assignments are byte-identical (updated_at included).
    expect(await assignments(byok.partnerId)).toEqual(byokBefore);

    // Ids-only verification payloads, one per created offering.
    expect(enqueue.mock.calls).toHaveLength(2);
    for (const [payload] of enqueue.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(Object.keys(payload).sort()).toEqual(['offeringId', 'partnerId']);
    }

    // Restart with the same env: nothing changes.
    const chatAfterFirst = await partnerChat(platform.partnerId);
    const second = await run([platform.partnerId, byok.partnerId]);
    expect(second).toMatchObject({ created: 0, resynced: 0, chatRepointed: 0, failed: [] });
    expect(await envConnections(platform.partnerId)).toHaveLength(1);
    expect(await partnerChat(platform.partnerId)).toEqual(chatAfterFirst);
    expect(await assignments(byok.partnerId)).toEqual(byokBefore);
  });

  it('two replicas booting concurrently for the same partner: exactly one env connection, one offering, chat re-pointed once', async () => {
    const p = await seedRegistryPartner('platform');
    const [a, b] = await Promise.all([run([p.partnerId]), run([p.partnerId])]);
    expect([a.failed, b.failed]).toEqual([[], []]);
    expect(a.created + b.created).toBe(1);
    expect(a.chatRepointed + b.chatRepointed).toBe(1);
    const conns = await envConnections(p.partnerId);
    expect(conns).toHaveLength(1);
    expect(await offerings(conns[0]!.id)).toHaveLength(1);
  });

  it('an admin who later moved chat elsewhere is respected on the next boot', async () => {
    const p = await seedRegistryPartner('platform');
    await run([p.partnerId]);
    await fixtureSql`UPDATE ai_model_assignments SET default_offering_id = ${p.offeringId}, updated_at = now()
      WHERE partner_id = ${p.partnerId} AND surface = 'chat'`;
    const r = await run([p.partnerId]);
    expect(r.chatRepointed).toBe(0);
    expect((await partnerChat(p.partnerId))!.default_offering_id).toBe(p.offeringId);
  });

  it('the bootstrap runs the partner cutover first; a later cutover/sweep cannot undo it (Codex review #4)', async () => {
    __resetRegistryCutoverMemoForTests();
    const partner = await createPartner();   // never cut over: the bootstrap must do it first
    const r = await run([partner.id]);
    expect(r).toMatchObject({ created: 1, failed: [] });
    const [cut] = await fixtureSql`SELECT 1 AS x FROM ai_model_registry_partner_cutover WHERE partner_id = ${partner.id}`;
    expect(cut).toBeDefined();
    const [conn] = await envConnections(partner.id);
    const [off] = await offerings(conn!.id);
    const chatBefore = await partnerChat(partner.id);

    __resetRegistryCutoverMemoForTests();
    expect(await cutoverPartner(partner.id)).toBe('already');
    expect((await offerings(conn!.id))[0]!.enabled).toBe(true);
    expect(await partnerChat(partner.id)).toEqual(chatBefore);
    if (chatBefore) expect(chatBefore.default_offering_id).toBe(off!.id);
  });

  it('MCP_LLM_MODEL change → new offering, old disabled, chat moved only where it was the old env offering; org override untouched', async () => {
    const p = await seedRegistryPartner('platform');
    await run([p.partnerId]);
    const [conn] = await envConnections(p.partnerId);
    const [oldOff] = await offerings(conn!.id);
    await fixtureSql`
      INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, role, default_offering_id)
      VALUES (${p.orgId}, ${p.partnerId}, 'chat', 'default', ${p.offeringId})`;
    const orgBefore = (await assignments(p.partnerId)).find((a) => a.surface === 'chat' && a.org_id === p.orgId);

    const enqueue = vi.fn(async () => {});
    const r = await run([p.partnerId], { ...SETTINGS, model: 'qwen2' }, enqueue);
    expect(r).toMatchObject({ created: 0, resynced: 1, chatRepointed: 1 });
    const offs = await offerings(conn!.id);
    const next = offs.find((o) => o.model_id === 'qwen2')!;
    expect(offs.find((o) => o.id === oldOff!.id)!.enabled).toBe(false);
    expect(next).toMatchObject({ enabled: true, in: '15.000000' });
    expect((await partnerChat(p.partnerId))!.default_offering_id).toBe(next.id);
    expect((await assignments(p.partnerId)).find((a) => a.surface === 'chat' && a.org_id === p.orgId)).toEqual(orgBefore);
    expect((await envConnections(p.partnerId))[0]!.provider_config).toMatchObject({ managedBy: 'env', envModel: 'qwen2' });
    expect(enqueue).toHaveBeenCalledWith({ offeringId: next.id, partnerId: p.partnerId });
  });

  it('base URL / key change → connection rewritten in place (config_version bumped), still one connection', async () => {
    const p = await seedRegistryPartner('platform');
    await run([p.partnerId]);
    const [before] = await envConnections(p.partnerId);
    const r = await run([p.partnerId], { ...SETTINGS, baseUrl: 'https://llm2.example.com/v1', apiKey: 'sk-env-integration-0002' });
    expect(r).toMatchObject({ resynced: 1, created: 0 });
    const after = await envConnections(p.partnerId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before!.id, base_url: 'https://llm2.example.com/v1', key_last4: '0002', config_version: before!.config_version + 1 });
  });

  it('variables unset later → released, not handed over: still env-managed, key kept, active; nothing deleted', async () => {
    const p = await seedRegistryPartner('platform');
    await run([p.partnerId]);
    const [conn] = await envConnections(p.partnerId);
    const r = await run([p.partnerId], null);
    expect(r.released).toBeGreaterThanOrEqual(1);
    const [after] = await envConnections(p.partnerId);
    expect(after).toMatchObject({ id: conn!.id, status: 'active', base_url: SETTINGS.baseUrl, config_version: conn!.config_version, key_last4: '0001' });
    expect(after!.api_key_encrypted).not.toBeNull();
    expect(after!.provider_config).toMatchObject({ managedBy: 'env', envModel: 'qwen', envReleasedAt: expect.any(String) });
    expect((await offerings(conn!.id))[0]!.enabled).toBe(true);
    // A second unset boot does not release it again.
    const releasedAt = after!.provider_config!.envReleasedAt;
    await run([p.partnerId], null);
    expect((await envConnections(p.partnerId))[0]!.provider_config!.envReleasedAt).toBe(releasedAt);
  });

  it('a released connection stays read-only for the partner (URL/key, hand-entered models, price, name refused); disconnect is allowed', async () => {
    const p = await seedRegistryPartner('platform');
    await run([p.partnerId]);
    await run([p.partnerId], null);
    const [conn] = await envConnections(p.partnerId);
    const [off] = await offerings(conn!.id);
    const refusal = (promise: Promise<unknown>) => promise.then(() => null, (e: { code?: string; status?: number }) => [e.status, e.code]);

    expect(await refusal(updateGatewayConnection({
      partnerId: p.partnerId, connectionId: conn!.id, baseUrl: 'https://evil.example.net/v1', expectedConfigVersion: conn!.config_version,
    }))).toEqual([409, 'managed_by_env']);
    expect(await refusal(updateGatewayConnection({
      partnerId: p.partnerId, connectionId: conn!.id, apiKey: 'sk-partner-own-key-1', expectedConfigVersion: conn!.config_version,
    }))).toEqual([409, 'managed_by_env']);
    expect(await refusal(createManualOffering({ partnerId: p.partnerId, connectionId: conn!.id, modelId: 'extra-model' }))).toEqual([409, 'managed_by_env']);
    const offRow = await withSystemDbAccessContext(() => getOffering(off!.id));
    expect(await refusal(updateOfferingDetails({
      partnerId: p.partnerId, offeringId: off!.id,
      patch: { expectedUpdatedAt: offRow!.updatedAt.toISOString(), prices: { inputCentsPerM: 1, outputCentsPerM: 1, cacheReadCentsPerM: 1, cacheWriteCentsPerM: 0 } },
    }))).toEqual([409, 'managed_by_env']);
    const [unchanged] = await envConnections(p.partnerId);
    expect(unchanged).toMatchObject({ base_url: SETTINGS.baseUrl, key_last4: '0001', config_version: conn!.config_version });
    expect(await offerings(conn!.id)).toHaveLength(1);

    // Disconnect: move chat off the env model first (a default blocks it), then remove.
    await fixtureSql`UPDATE ai_model_assignments SET default_offering_id = ${p.offeringId}, updated_at = now()
      WHERE partner_id = ${p.partnerId} AND org_id IS NULL AND surface = 'chat'`;
    await deleteGatewayConnection({ partnerId: p.partnerId, connectionId: conn!.id });
    const [gone] = await envConnections(p.partnerId);
    expect(gone).toMatchObject({ id: conn!.id, status: 'disconnected', key_last4: null, api_key_encrypted: null });
  });

  it('variables set again → the released connection is re-adopted (same id, re-synced), chat NOT re-pointed a second time', async () => {
    const p = await seedRegistryPartner('platform');
    const first = await run([p.partnerId]);
    expect(first.chatRepointed).toBe(1);
    await run([p.partnerId], null);
    const [released] = await envConnections(p.partnerId);
    // Meanwhile the admin moved chat back to a platform model.
    await fixtureSql`UPDATE ai_model_assignments SET default_offering_id = ${p.offeringId}, updated_at = now()
      WHERE partner_id = ${p.partnerId} AND org_id IS NULL AND surface = 'chat'`;

    const r = await run([p.partnerId], { ...SETTINGS, baseUrl: 'https://llm3.example.com/v1', apiKey: 'sk-env-integration-0003' });
    expect(r).toMatchObject({ created: 0, chatRepointed: 0, failed: [] });
    const conns = await envConnections(p.partnerId);
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ id: released!.id, status: 'active', base_url: 'https://llm3.example.com/v1', key_last4: '0003' });
    expect(conns[0]!.provider_config).toEqual({ managedBy: 'env', envModel: 'qwen' });
    expect((await partnerChat(p.partnerId))!.default_offering_id).toBe(p.offeringId);
  });

  it('a later boot re-queues verification unless the offering has a PASSING record for the current endpoint', async () => {
    const p = await seedRegistryPartner('platform');
    await run([p.partnerId]);
    const [conn] = await envConnections(p.partnerId);
    const [off] = await offerings(conn!.id);
    const record = (over: { passed: boolean; baseUrl: string }) => verifiedCapabilitiesTree({
      harnessVersion: FIDELITY_HARNESS_VERSION,
      endpointFingerprint: endpointFingerprint({ kind: 'openai_compatible', baseUrl: over.baseUrl, providerConfig: null }),
      at: new Date().toISOString(), passed: over.passed, toolUse: over.passed, adaptiveEffort: false,
      summary: over.passed ? null : 'direct_tool_use: endpoint still loading',
    }, null);
    const setCaps = (caps: unknown) => fixtureSql`
      UPDATE partner_ai_models SET capabilities = ${JSON.stringify(caps)}::jsonb WHERE id = ${off!.id}`;
    const enqueuedOn = async () => {
      const enqueue = vi.fn(async () => {});
      await run([p.partnerId], SETTINGS, enqueue);
      return enqueue.mock.calls.length;
    };

    await setCaps(record({ passed: false, baseUrl: SETTINGS.baseUrl }));           // failed
    expect(await enqueuedOn()).toBe(1);
    await setCaps(record({ passed: true, baseUrl: 'https://old-llm.example.com/v1' }));   // stale
    expect(await enqueuedOn()).toBe(1);
    await setCaps(record({ passed: true, baseUrl: SETTINGS.baseUrl }));            // verified
    expect(await enqueuedOn()).toBe(0);
  });

  it('release takes the partner registry lock for each row: it waits for a held lock instead of writing past it', async () => {
    const p = await seedRegistryPartner('platform');
    await run([p.partnerId]);
    let release!: () => void;
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = fixtureSql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${partnerRegistryReconcileLockKey(p.partnerId)}, 0))`;
      locked();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await lockTaken;
    let settled = false;
    const releasing = run([p.partnerId], null).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(settled).toBe(false);
    // Read through the app pool: the fixture pool's connection is the lock holder.
    const [waiting] = await withSystemDbAccessContext(() => db.execute<{ released: string | null }>(sql`
      SELECT provider_config->>'envReleasedAt' AS released FROM partner_ai_connections
       WHERE partner_id = ${p.partnerId}::uuid AND kind = 'openai_compatible'`));
    expect(waiting!.released).toBeNull();
    release();
    await holder;
    const r = await releasing;
    expect(r.released).toBeGreaterThanOrEqual(1);
    expect((await envConnections(p.partnerId))[0]!.provider_config).toMatchObject({ envReleasedAt: expect.any(String) });
  });

  it('a partner-scoped id that does not exist fails alone (reported), others still bootstrapped', async () => {
    const p = await seedRegistryPartner('platform');
    const ghost = randomUUID();
    const r = await run([ghost, p.partnerId]);
    expect(r.failed).toEqual([ghost]);
    expect(r.created).toBe(1);
    expect(await envConnections(p.partnerId)).toHaveLength(1);
    expect(ENV_CONNECTION_NAME).toBeTruthy();
  });
});
