/**
 * W06 Task 11 (#7604): `syncConnectionModels` for an openai_compatible
 * connection against real rows. The REAL discoverer runs (key decryption,
 * forwardUpstream origin/path pin, header injection, response sanitising);
 * only the network dial is stubbed (`__setUpstreamFetchForTests`), so each test
 * plays the partner's /models endpoint, hostile or not.
 *
 * Spec §6 / D5: new ids land discovered, disabled, unpriced, unverified;
 * existing rows keep admin-set enabled/prices/capabilities; lifecycle ages only
 * `discovered` rows (never `manual`); a failed sync changes nothing but
 * discovery_error; a disconnected connection is never called.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { syncConnectionModels } from '../../services/aiModels/discovery';
import { __setUpstreamFetchForTests } from '../../services/aiModels/gateway/forward';
import {
  createGatewayConnection,
  createManualOffering,
  deleteGatewayConnection,
} from '../../services/aiModels/gatewayConnections';
import { __setLookupForTests } from '../../services/urlSafety';
import { closeRegistryFixtures, fixtureSql, partnerContext } from './aiModelRegistryFixtures';
import { createPartner } from './db-utils';

afterAll(closeRegistryFixtures);

const KEY = 'live-partner-key-0123456789abcdef';
const BASE = 'https://llm.example.com/v1';
const DAY = 86_400_000;
const T0 = new Date('2026-11-25T06:00:00.000Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const asPartner = <T>(partnerId: string, fn: () => Promise<T>) => withDbAccessContext(partnerContext(partnerId), fn);

interface Call { url: string; headers: Record<string, string> }
let calls: Call[] = [];
let respond: () => Response = () => Response.json({ data: [] });
function listing(...ids: Array<string | { id: string; name?: string }>) {
  respond = () => Response.json({ object: 'list', data: ids.map((x) => (typeof x === 'string' ? { id: x } : x)) });
}

beforeEach(() => {
  calls = [];
  __setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
  __setUpstreamFetchForTests((async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: { ...init.headers } });
    return respond();
  }) as never);
});
afterEach(() => {
  __setUpstreamFetchForTests(null);
  __setLookupForTests(null);
});

type OfferingRow = {
  model_id: string; enabled: boolean; lifecycle: string; source: string; display_name: string | null;
  platform_model_id: string | null; missed_sync_count: number; last_seen_at: Date | null; capabilities: unknown;
  price_input_cents_per_m: string | null; price_output_cents_per_m: string | null;
};
async function offerings(connectionId: string): Promise<OfferingRow[]> {
  return withSystemDbAccessContext(async () => [...await db.execute<OfferingRow>(sql`
    SELECT model_id, enabled, lifecycle, source, display_name, platform_model_id, missed_sync_count, last_seen_at,
           capabilities, price_input_cents_per_m::text, price_output_cents_per_m::text
      FROM partner_ai_models WHERE connection_id = ${connectionId}::uuid ORDER BY model_id`)]);
}
const offering = async (connectionId: string, modelId: string) =>
  (await offerings(connectionId)).find((o) => o.model_id === modelId);
async function connectionRow(connectionId: string) {
  const [row] = await fixtureSql<Array<{ discovery_error: string | null; last_discovered_at: Date | null }>>`
    SELECT discovery_error, last_discovered_at FROM partner_ai_connections WHERE id = ${connectionId}`;
  return row!;
}

async function seedGateway(apiKey: string | null = KEY): Promise<{ partnerId: string; connectionId: string }> {
  const partnerId = (await createPartner()).id;
  const conn = await asPartner(partnerId, () => createGatewayConnection({
    partnerId, name: `gw-${randomUUID().slice(0, 8)}`, baseUrl: BASE, apiKey: apiKey ?? undefined, connectedBy: null,
  }));
  return { partnerId, connectionId: conn.id };
}

const VERIFIED = { breeze_verification: { fingerprint: 'fp', harnessVersion: 1, passed: true }, tools: true };

describe('syncConnectionModels — openai_compatible (real DB, real discoverer)', () => {
  it('GETs {base}/models with the partner key; new ids land discovered, DISABLED, unpriced, unverified', async () => {
    const { connectionId } = await seedGateway();
    listing('qwen2.5-coder:7b', { id: 'llama3.1:8b', name: 'Llama \u001b[31m3.1' });
    const report = await syncConnectionModels(connectionId, T0);
    expect(report).toMatchObject({ status: 'ok', discovered: 2, added: 2, markedMissing: 0, markedRetired: 0 });
    expect(calls).toEqual([{ url: `${BASE}/models`, headers: expect.objectContaining({ authorization: `Bearer ${KEY}` }) }]);
    const rows = await offerings(connectionId);
    expect(rows.map((r) => r.model_id)).toEqual(['llama3.1:8b', 'qwen2.5-coder:7b']);
    for (const row of rows) {
      expect(row).toMatchObject({
        source: 'discovered', enabled: false, lifecycle: 'available', platform_model_id: null, capabilities: null,
        price_input_cents_per_m: null, price_output_cents_per_m: null, missed_sync_count: 0,
      });
    }
    expect(rows[0]!.display_name).toBe('Llama [31m3.1');
    const conn = await connectionRow(connectionId);
    expect(conn).toMatchObject({ discovery_error: null });
    expect(conn.last_discovered_at).not.toBeNull();
  });

  it('never touches enabled / prices / capabilities / display name of an existing row, and never re-enables a disabled one', async () => {
    const { partnerId, connectionId } = await seedGateway();
    await fixtureSql`
      INSERT INTO partner_ai_models (partner_id, connection_id, model_id, source, display_name, enabled, capabilities,
        price_input_cents_per_m, price_output_cents_per_m, price_cache_read_cents_per_m, price_cache_write_cents_per_m)
      VALUES (${partnerId}, ${connectionId}, 'a', 'discovered', 'Admin name', true, ${fixtureSql.json(VERIFIED)}, 100, 200, 10, 20)`;
    listing({ id: 'a', name: 'Upstream rename' }, 'b');
    await syncConnectionModels(connectionId, T0);
    expect(await offering(connectionId, 'a')).toMatchObject({
      enabled: true, capabilities: VERIFIED, display_name: 'Admin name',
      price_input_cents_per_m: '100.000000', price_output_cents_per_m: '200.000000',
    });
    expect(await offering(connectionId, 'b')).toMatchObject({ enabled: false, capabilities: null });
    await syncConnectionModels(connectionId, at(1));
    expect(await offering(connectionId, 'b')).toMatchObject({ enabled: false });
  });

  it('a hostile listing that echoes the key never stores it: the name is dropped, an id carrying it is skipped', async () => {
    const { connectionId } = await seedGateway();
    listing(
      { id: 'echo-name', display_name: `Leaked ${KEY}` } as never,
      { id: 'window-name', name: `model ${KEY.slice(4, 20)}` },
      { id: `id-${KEY.slice(-16)}` },
      { id: 'clean', name: 'Clean Model' },
    );
    const report = await syncConnectionModels(connectionId, T0);
    expect(report).toMatchObject({ status: 'ok' });
    const rows = await offerings(connectionId);
    expect(rows.map((r) => [r.model_id, r.display_name])).toEqual([
      ['clean', 'Clean Model'],
      ['echo-name', null],
      ['window-name', null],
    ]);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(KEY.slice(4, 16));
    expect(stored).not.toContain(KEY.slice(-12));
  });

  it('a keyless connection lists without any Authorization header', async () => {
    const { connectionId } = await seedGateway(null);
    listing('a');
    expect((await syncConnectionModels(connectionId, T0)).status).toBe('ok');
    expect(calls).toHaveLength(1);
    expect('authorization' in calls[0]!.headers).toBe(false);
  });

  it('a DISCOVERED row absent from 3 successful syncs (≥48 h) → missing; 14 days → retired; re-listing restores it (still disabled)', async () => {
    const { connectionId } = await seedGateway();
    listing('keep', 'gone');
    await syncConnectionModels(connectionId, T0);
    listing('keep');
    await syncConnectionModels(connectionId, at(1));
    await syncConnectionModels(connectionId, at(2));
    expect(await offering(connectionId, 'gone')).toMatchObject({ lifecycle: 'available', missed_sync_count: 2 });
    expect((await syncConnectionModels(connectionId, at(3))).markedMissing).toBe(1);
    expect(await offering(connectionId, 'gone')).toMatchObject({ lifecycle: 'missing', missed_sync_count: 3 });
    expect((await syncConnectionModels(connectionId, at(15))).markedRetired).toBe(1);
    expect(await offering(connectionId, 'gone')).toMatchObject({ lifecycle: 'retired' });
    listing('keep', 'gone');
    await syncConnectionModels(connectionId, at(16));
    expect(await offering(connectionId, 'gone')).toMatchObject({ lifecycle: 'available', missed_sync_count: 0, enabled: false });
  });

  it('never marks a MANUAL row missing, even once a sync has seen it (gateways often list a subset)', async () => {
    const { partnerId, connectionId } = await seedGateway();
    await asPartner(partnerId, () => createManualOffering({ partnerId, connectionId, modelId: 'hand-entered' }));
    await asPartner(partnerId, () => createManualOffering({ partnerId, connectionId, modelId: 'seen-manual' }));
    listing('seen-manual', 'other');
    await syncConnectionModels(connectionId, T0);
    expect(await offering(connectionId, 'seen-manual')).toMatchObject({ source: 'manual' });
    listing('other');
    for (const d of [1, 2, 3, 4, 20]) await syncConnectionModels(connectionId, at(d));
    expect(await offering(connectionId, 'hand-entered')).toMatchObject({ source: 'manual', lifecycle: 'available' });
    expect(await offering(connectionId, 'seen-manual')).toMatchObject({ source: 'manual', lifecycle: 'available' });
  });

  it('a failed sync (401 echoing the key) records a scrubbed discovery_error and changes no lifecycle; the next success clears it', async () => {
    const { connectionId } = await seedGateway();
    listing('keep', 'other');
    await syncConnectionModels(connectionId, T0);
    const before = await offerings(connectionId);
    respond = () => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), { status: 401 });
    for (const d of [1, 2, 3, 20]) {
      expect((await syncConnectionModels(connectionId, at(d))).status).toBe('failed');
    }
    expect(await offerings(connectionId)).toEqual(before);
    const failed = await connectionRow(connectionId);
    expect(failed.discovery_error).toContain('401');
    expect(failed.discovery_error).not.toContain(KEY);
    expect(failed.discovery_error).not.toContain(KEY.slice(-12));
    expect(failed.discovery_error!.length).toBeLessThanOrEqual(600);
    listing('keep', 'other');
    await syncConnectionModels(connectionId, at(21));
    expect((await connectionRow(connectionId)).discovery_error).toBeNull();
  });

  it.each([
    ['more than 500 models', () => Response.json({ data: Array.from({ length: 501 }, (_, i) => ({ id: `m${i}` })) }), /more than 500/],
    ['a non-JSON body', () => new Response('<html>not json</html>'), /model list/],
    ['a wrong-shape body', () => Response.json({ models: [{ id: 'x' }] }), /model list/],
    ['only invalid ids', () => Response.json({ data: [{ id: 'bad id' }, { id: '<script>' }] }), /no usable models/],
    ['a redirect', () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }), /redirect/],
  ])('a hostile listing (%s) is a failed sync: no rows written, error recorded', async (_label, body, pattern) => {
    const { connectionId } = await seedGateway();
    respond = body;
    const report = await syncConnectionModels(connectionId, T0);
    expect(report.status).toBe('failed');
    expect(await offerings(connectionId)).toEqual([]);
    expect((await connectionRow(connectionId)).discovery_error).toMatch(pattern);
  });

  it('a disconnected connection is skipped without any request', async () => {
    const { partnerId, connectionId } = await seedGateway();
    await asPartner(partnerId, () => deleteGatewayConnection({ partnerId, connectionId }));
    listing('a');
    expect(await syncConnectionModels(connectionId, T0)).toMatchObject({ status: 'skipped', error: 'connection disconnected' });
    expect(calls).toEqual([]);
    expect(await offerings(connectionId)).toEqual([]);
  });

  it('a disconnect that lands while listing writes nothing', async () => {
    const { partnerId, connectionId } = await seedGateway();
    __setUpstreamFetchForTests((async () => {
      await asPartner(partnerId, () => deleteGatewayConnection({ partnerId, connectionId }));
      return Response.json({ data: [{ id: 'late' }] });
    }) as never);
    const report = await syncConnectionModels(connectionId, T0);
    expect(report.status).toBe('skipped');
    expect(await offering(connectionId, 'late')).toBeUndefined();
  });

  it('discovery never changes an assignment', async () => {
    const { partnerId, connectionId } = await seedGateway();
    const snapshot = async () => withSystemDbAccessContext(async () => [...await db.execute(sql`
      SELECT * FROM ai_model_assignments WHERE offering_partner_id = ${partnerId}::uuid ORDER BY id`)]);
    const before = await snapshot();
    listing('brand-new');
    await syncConnectionModels(connectionId, T0);
    expect(await snapshot()).toEqual(before);
  });
});
