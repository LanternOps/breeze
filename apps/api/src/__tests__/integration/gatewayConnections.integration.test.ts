/**
 * W06 Task 10 (#7604): gateway connection writes and manual model entry
 * against real Postgres. The services run like the /ai/models routes do:
 * called from a partner request context (breeze_app, FORCE RLS), each write
 * in its own system transaction behind the partner registry lock, so the
 * app-layer partner pin is the guard this suite proves — plus the DB
 * constraints (shape_chk, composite FK, compat_uq predicate) underneath it.
 *
 * DNS for the BYO base URLs is stubbed to a public address so the egress
 * policy passes deterministically offline.
 */
import './setup';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { __setLookupForTests } from '../../services/urlSafety';
import {
  decryptConnectionKey,
  getConnectionKeyMaterial,
  listConnections,
} from '../../services/aiModels/connections';
import {
  createGatewayConnection,
  createManualOffering,
  deleteGatewayConnection,
  updateGatewayConnection,
} from '../../services/aiModels/gatewayConnections';
import {
  endpointFingerprint,
  verifiedCapabilitiesTree,
  verifiedGatewayCapabilities,
} from '../../services/aiModels/gatewayCapabilities';
import { FIDELITY_HARNESS_VERSION } from '../../services/llm/providerFidelityHarness';
import { createPartner } from './db-utils';
import { closeRegistryFixtures, fixtureSql, partnerContext } from './aiModelRegistryFixtures';

afterAll(closeRegistryFixtures);

const ZERO = { inputCentsPerM: 0, outputCentsPerM: 0, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 };
const asPartner = <T>(partnerId: string, fn: () => Promise<T>) => withDbAccessContext(partnerContext(partnerId), fn);
const asSystem = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);
const caught = (p: Promise<unknown>) => p.then(
  () => { throw new Error('expected a rejection'); },
  (e: unknown) => e as { status?: number; code?: string; details?: Record<string, unknown>; cause?: { code?: string } },
);

interface ConnRow {
  status: string; base_url: string | null; api_key_encrypted: string | null; key_last4: string | null;
  key_fingerprint: string | null; config_version: number; provider_config: unknown;
}
async function connRow(id: string): Promise<ConnRow> {
  const [row] = await fixtureSql<ConnRow[]>`
    SELECT status, base_url, api_key_encrypted, key_last4, key_fingerprint, config_version, provider_config
      FROM partner_ai_connections WHERE id = ${id}`;
  if (!row) throw new Error('connection row missing');
  return row;
}
async function offeringRows(connectionId: string) {
  return fixtureSql<Array<{ id: string; enabled: boolean; capabilities: unknown; source: string }>>`
    SELECT id, enabled, capabilities, source FROM partner_ai_models WHERE connection_id = ${connectionId} ORDER BY created_at`;
}
async function seedPartnerDefault(partnerId: string, surface: string, offeringId: string): Promise<void> {
  await fixtureSql`
    INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, role, default_offering_id)
    VALUES (${partnerId}, ${partnerId}, ${surface}, 'default', ${offeringId})`;
}

beforeEach(() => {
  __setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
});
afterEach(() => __setLookupForTests(null));

describe('gateway connections — tenancy (real DB)', () => {
  it("partner A cannot create a manual offering on partner B's connection (app pin → 404; forge → FK/RLS)", async () => {
    const [a, b] = [(await createPartner()).id, (await createPartner()).id];
    const connB = await asPartner(b, () => createGatewayConnection({ partnerId: b, name: 'B', baseUrl: 'https://b.example.com/v1', connectedBy: null }));
    const err = await caught(asPartner(a, () => createManualOffering({ partnerId: a, connectionId: connB.id, modelId: 'm' })));
    expect([err.code, err.status]).toEqual(['not_found', 404]);
    // Direct forge as breeze_app under A's context fails at the composite FK / RLS.
    const forged = await caught(asPartner(a, () => db.execute(sql`
      INSERT INTO partner_ai_models (partner_id, connection_id, model_id, source)
      VALUES (${a}::uuid, ${connB.id}::uuid, 'm', 'manual')`)));
    expect(['23503', '42501']).toContain(forged.cause?.code);
    expect(await offeringRows(connB.id)).toHaveLength(0);
  });

  it("partner A cannot edit or disconnect partner B's connection (404, row untouched)", async () => {
    const [a, b] = [(await createPartner()).id, (await createPartner()).id];
    const connB = await asPartner(b, () => createGatewayConnection({ partnerId: b, name: 'B', baseUrl: 'https://b.example.com/v1', connectedBy: null }));
    const upd = await caught(asPartner(a, () => updateGatewayConnection({ partnerId: a, connectionId: connB.id, baseUrl: 'https://evil.example.com/v1', expectedConfigVersion: 1 })));
    expect([upd.code, upd.status]).toEqual(['not_found', 404]);
    const del = await caught(asPartner(a, () => deleteGatewayConnection({ partnerId: a, connectionId: connB.id })));
    expect([del.code, del.status]).toEqual(['not_found', 404]);
    expect(await connRow(connB.id)).toMatchObject({ status: 'active', base_url: 'https://b.example.com/v1', config_version: 1 });
  });

  it('the shape CHECK refuses an openai_compatible row with no base_url', async () => {
    const a = (await createPartner()).id;
    const err = await caught(asSystem(() => db.execute(sql`
      INSERT INTO partner_ai_connections (partner_id, kind, name) VALUES (${a}::uuid, 'openai_compatible', 'x')`)));
    expect(err.cause).toMatchObject({ code: '23514', constraint_name: 'partner_ai_connections_shape_chk' });
  });

  it('many openai_compatible connections per partner are allowed (compat_uq predicate excludes them)', async () => {
    const a = (await createPartner()).id;
    await asPartner(a, () => createGatewayConnection({ partnerId: a, name: 'one', baseUrl: 'https://one.example.com/v1', connectedBy: null }));
    await asPartner(a, () => createGatewayConnection({ partnerId: a, name: 'two', baseUrl: 'https://two.example.com/v1', connectedBy: null }));
    const [row] = await fixtureSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM partner_ai_connections WHERE partner_id = ${a} AND kind = 'openai_compatible'`;
    expect(row!.n).toBe(2);
  });

  it('the key ciphertext decrypts only for its own row id (row-bound AAD); keyless leaves all three NULL', async () => {
    const a = (await createPartner()).id;
    const c1 = await asPartner(a, () => createGatewayConnection({ partnerId: a, name: 'k1', baseUrl: 'https://k1.example.com/v1', apiKey: 'sk-k1-secret-123456', connectedBy: null }));
    const c2 = await asPartner(a, () => createGatewayConnection({ partnerId: a, name: 'k2', baseUrl: 'https://k2.example.com/v1', apiKey: 'sk-k2-secret-123456', connectedBy: null }));
    const m1 = await asSystem(() => getConnectionKeyMaterial(c1.id));
    expect(decryptConnectionKey(m1!)).toBe('sk-k1-secret-123456');
    expect(() => decryptConnectionKey({ id: c2.id, apiKeyEncrypted: m1!.apiKeyEncrypted })).toThrow();
    expect((await connRow(c1.id)).key_last4).toBe('3456');

    const keyless = await asPartner(a, () => createGatewayConnection({ partnerId: a, name: 'local', baseUrl: 'https://local.example.com/v1', connectedBy: null }));
    expect(await connRow(keyless.id)).toMatchObject({ api_key_encrypted: null, key_last4: null, key_fingerprint: null });
  });
});

describe('gateway connections — update', () => {
  it('a base-URL change bumps config_version and makes a verification stale without touching offerings; a key rotation does not', async () => {
    const a = (await createPartner()).id;
    const conn = await asPartner(a, () => createGatewayConnection({ partnerId: a, name: 'v', baseUrl: 'https://v1.example.com/v1', apiKey: 'sk-v-secret-123456', connectedBy: null }));
    const off = await asPartner(a, () => createManualOffering({ partnerId: a, connectionId: conn.id, modelId: 'qwen', prices: ZERO }));
    // A verification bound to the current endpoint (what Task 12 writes).
    const fp = endpointFingerprint({ kind: 'openai_compatible', baseUrl: 'https://v1.example.com/v1', providerConfig: null });
    const tree = verifiedCapabilitiesTree({
      harnessVersion: FIDELITY_HARNESS_VERSION, endpointFingerprint: fp, at: new Date().toISOString(),
      passed: true, toolUse: true, adaptiveEffort: false, summary: null,
    }, null);
    await fixtureSql`UPDATE partner_ai_models SET capabilities = ${fixtureSql.json(tree as never)} WHERE id = ${off.id}`;
    const stateFor = async () => {
      const row = await connRow(conn.id);
      const [o] = await offeringRows(conn.id);
      return verifiedGatewayCapabilities(o!.capabilities, endpointFingerprint({ kind: 'openai_compatible', baseUrl: row.base_url, providerConfig: null })).state;
    };
    expect(await stateFor()).toBe('verified');

    // Key rotation: verification stays valid, version bumps.
    const rotated = await asPartner(a, () => updateGatewayConnection({ partnerId: a, connectionId: conn.id, apiKey: 'sk-v-rotated-654321', expectedConfigVersion: 1 }));
    expect(rotated.configVersion).toBe(2);
    expect(await stateFor()).toBe('verified');

    // Stale token refused.
    const stale = await caught(asPartner(a, () => updateGatewayConnection({ partnerId: a, connectionId: conn.id, baseUrl: 'https://v2.example.com/v1', expectedConfigVersion: 1 })));
    expect([stale.code, stale.status]).toEqual(['stale_write', 409]);

    // URL change: verification goes stale by fingerprint; the stored tree is untouched.
    const moved = await asPartner(a, () => updateGatewayConnection({ partnerId: a, connectionId: conn.id, baseUrl: 'https://v2.example.com/v1/', expectedConfigVersion: 2 }));
    expect(moved).toMatchObject({ configVersion: 3, baseUrl: 'https://v2.example.com/v1', status: 'active', lastError: null });
    expect(moved).not.toHaveProperty('apiKeyEncrypted');
    expect(await stateFor()).toBe('stale');
    const [o] = await offeringRows(conn.id);
    expect(o!.capabilities).toEqual(tree);
    // The rotated key is the one stored.
    const m = await asSystem(() => getConnectionKeyMaterial(conn.id));
    expect(decryptConnectionKey(m!)).toBe('sk-v-rotated-654321');
  });

  it('an env-managed connection is read-only (409 managed_by_env)', async () => {
    const a = (await createPartner()).id;
    const conn = await asPartner(a, () => createGatewayConnection({ partnerId: a, name: 'env', baseUrl: 'https://env.example.com/v1', connectedBy: null, managedBy: 'env' }));
    const upd = await caught(asPartner(a, () => updateGatewayConnection({ partnerId: a, connectionId: conn.id, apiKey: 'sk-env-new-123456', expectedConfigVersion: 1 })));
    expect([upd.code, upd.status]).toEqual(['managed_by_env', 409]);
    const del = await caught(asPartner(a, () => deleteGatewayConnection({ partnerId: a, connectionId: conn.id })));
    expect([del.code, del.status]).toEqual(['managed_by_env', 409]);
    expect(await connRow(conn.id)).toMatchObject({ status: 'active', config_version: 1, provider_config: { managedBy: 'env' } });
  });
});

describe('gateway connections — delete (soft-disconnect)', () => {
  it('an offering that is an assignment default blocks it → 409 connection_in_use (no raw 23503)', async () => {
    const a = (await createPartner()).id;
    const conn = await asPartner(a, () => createGatewayConnection({ partnerId: a, name: 'del', baseUrl: 'https://del.example.com/v1', connectedBy: null }));
    const off = await asPartner(a, () => createManualOffering({ partnerId: a, connectionId: conn.id, modelId: 'm', prices: ZERO }));
    await seedPartnerDefault(a, 'script_reviewer', off.id);
    const err = await caught(asPartner(a, () => deleteGatewayConnection({ partnerId: a, connectionId: conn.id })));
    expect([err.code, err.status]).toEqual(['connection_in_use', 409]);
    expect(err.details?.surfaces).toEqual(['script_reviewer']);
    expect((await connRow(conn.id)).status).toBe('active');
  });

  it('disconnects in place: keyless, version bumped, base_url kept, offerings disabled but kept; then unaddressable', async () => {
    const a = (await createPartner()).id;
    const conn = await asPartner(a, () => createGatewayConnection({ partnerId: a, name: 'gone', baseUrl: 'https://gone.example.com/v1', apiKey: 'sk-gone-secret-1234', connectedBy: null }));
    const off = await asPartner(a, () => createManualOffering({ partnerId: a, connectionId: conn.id, modelId: 'm', prices: ZERO }));
    await fixtureSql`UPDATE partner_ai_models SET enabled = true WHERE id = ${off.id}`;

    await asPartner(a, () => deleteGatewayConnection({ partnerId: a, connectionId: conn.id }));
    expect(await connRow(conn.id)).toMatchObject({
      status: 'disconnected', base_url: 'https://gone.example.com/v1', config_version: 2,
      api_key_encrypted: null, key_last4: null, key_fingerprint: null,
    });
    const offs = await offeringRows(conn.id);
    expect(offs).toEqual([expect.objectContaining({ id: off.id, enabled: false })]);
    expect((await asPartner(a, () => listConnections(a))).map((c) => c.id)).not.toContain(conn.id);

    // Never edited, given a model, or disconnected again.
    const again = await caught(asPartner(a, () => deleteGatewayConnection({ partnerId: a, connectionId: conn.id })));
    expect([again.code, again.status]).toEqual(['not_found', 404]);
    const upd = await caught(asPartner(a, () => updateGatewayConnection({ partnerId: a, connectionId: conn.id, apiKey: 'sk-revive-123456', expectedConfigVersion: 2 })));
    expect([upd.code, upd.status]).toEqual(['not_found', 404]);
    const add = await caught(asPartner(a, () => createManualOffering({ partnerId: a, connectionId: conn.id, modelId: 'other' })));
    expect([add.code, add.status]).toEqual(['not_found', 404]);
    expect((await connRow(conn.id)).status).toBe('disconnected');
  });
});

describe('gateway connections — manual models', () => {
  it('lands disabled, unverified, source manual; a duplicate model id is 409 duplicate_model', async () => {
    const a = (await createPartner()).id;
    const conn = await asPartner(a, () => createGatewayConnection({ partnerId: a, name: 'm', baseUrl: 'https://m.example.com/v1', connectedBy: null }));
    const off = await asPartner(a, () => createManualOffering({ partnerId: a, connectionId: conn.id, modelId: 'qwen2.5-coder:7b', displayName: 'Qwen coder' }));
    expect(off).toMatchObject({
      partnerId: a, connectionId: conn.id, modelId: 'qwen2.5-coder:7b', displayName: 'Qwen coder', source: 'manual',
      enabled: false, capabilities: null, priceInputCentsPerM: null, platformModelId: null,
    });
    const dup = await caught(asPartner(a, () => createManualOffering({ partnerId: a, connectionId: conn.id, modelId: 'qwen2.5-coder:7b' })));
    expect([dup.code, dup.status]).toEqual(['duplicate_model', 409]);
    expect(await offeringRows(conn.id)).toHaveLength(1);
  });
});
