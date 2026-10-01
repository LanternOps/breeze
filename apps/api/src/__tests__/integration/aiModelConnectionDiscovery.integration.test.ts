/**
 * #7601 W03 Task 16 (spec §6): BYOK and catalog connection discovery against
 * real rows. The provider listing is injected (third parameter), so there is no
 * module mocking: SQL, lifecycle rules and connection bookkeeping are real.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  syncConnectionModels as realSync,
  type AnthropicModelInfo,
} from '../../services/aiModels/discovery';
import { decryptConnectionKey, getConnectionKeyMaterial } from '../../services/aiModels/connections';
import { activateRevision, createRevision, recordVerification } from '../../services/llmProviderCatalog';
import { fixtureSql } from './aiModelRegistryFixtures';
import { seedPricedPlatformModel, seedRegistryPartner } from './helpers/aiModelRegistrySeed';

const m = { discover: vi.fn<(apiKey: string | undefined, target?: unknown) => Promise<AnthropicModelInfo[]>>() };
const syncConnectionModels = (id: string, now?: Date) =>
  realSync(id, now ?? new Date(), { discoverAnthropicModels: m.discover });

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);
const DAY = 86_400_000;
const listed = (...ids: string[]): AnthropicModelInfo[] =>
  ids.map((id) => ({ id, displayName: id, maxInputTokens: 1000, maxOutputTokens: 100, capabilities: { thinking: { supported: true } } }));

type OfferingRow = {
  model_id: string; enabled: boolean; lifecycle: string; source: string;
  platform_model_id: string | null; missed_sync_count: number; last_seen_at: Date | null; capabilities: unknown;
}
async function offerings(connectionId: string): Promise<OfferingRow[]> {
  return sys(async () => [...await db.execute<OfferingRow>(sql`
    SELECT model_id, enabled, lifecycle, source, platform_model_id, missed_sync_count, last_seen_at, capabilities
    FROM partner_ai_models WHERE connection_id = ${connectionId}::uuid ORDER BY model_id`)]);
}
const offering = async (connectionId: string, modelId: string) =>
  (await offerings(connectionId)).find((o) => o.model_id === modelId);

async function connectionRow(connectionId: string) {
  const [row] = await sys(async () => [...await db.execute<{ discovery_error: string | null; last_discovered_at: Date | null }>(sql`
    SELECT discovery_error, last_discovered_at FROM partner_ai_connections WHERE id = ${connectionId}::uuid`)]);
  return row!;
}

describe('syncConnectionModels (BYOK)', () => {
  let s: Awaited<ReturnType<typeof seedRegistryPartner>>;
  let connectionId: string;
  beforeEach(async () => {
    s = await seedRegistryPartner('byok');
    connectionId = s.connectionId!;
    m.discover.mockReset();
  });

  it('lists with the CONNECTION key pinned to the public API, never the platform key', async () => {
    const material = await sys(() => getConnectionKeyMaterial(connectionId));
    const partnerKey = decryptConnectionKey(material!);
    m.discover.mockResolvedValue(listed(s.modelId));
    expect((await syncConnectionModels(connectionId)).status).toBe('ok');
    expect(m.discover).toHaveBeenCalledWith(partnerKey, { kind: 'anthropic' });
    expect(partnerKey).not.toBe(process.env.ANTHROPIC_API_KEY);
  });

  it('new models arrive DISABLED, linked to the platform row when ids match; enabled rows stay enabled', async () => {
    const linkedModelId = `claude-linked-${randomUUID()}`;
    const linkedPlatformId = await seedPricedPlatformModel(linkedModelId);
    m.discover.mockResolvedValue(listed(s.modelId, linkedModelId, 'claude-brand-new-9'));
    const report = await syncConnectionModels(connectionId);
    expect(report).toMatchObject({ status: 'ok', discovered: 3, added: 2, markedMissing: 0, markedRetired: 0 });
    expect(await offering(connectionId, s.modelId)).toMatchObject({ enabled: true, lifecycle: 'available' });
    expect(await offering(connectionId, 'claude-brand-new-9')).toMatchObject({
      enabled: false, source: 'discovered', lifecycle: 'available', platform_model_id: null, missed_sync_count: 0,
    });
    expect(await offering(connectionId, linkedModelId)).toMatchObject({ enabled: false, platform_model_id: linkedPlatformId });
    expect((await connectionRow(connectionId)).last_discovered_at).not.toBeNull();
  });

  it('a re-listed DISABLED model stays disabled (discovery never enables)', async () => {
    m.discover.mockResolvedValue(listed('claude-off-1'));
    await syncConnectionModels(connectionId);
    await syncConnectionModels(connectionId);
    expect(await offering(connectionId, 'claude-off-1')).toMatchObject({ enabled: false });
  });

  it('absent from 3 successful syncs (≥48 h apart in total) → missing; absent 14 days → retired; nothing deleted; a re-listing restores it', async () => {
    const t0 = new Date('2026-11-20T06:00:00.000Z');
    m.discover.mockResolvedValue(listed(s.modelId, 'claude-keeper-1'));
    await syncConnectionModels(connectionId, t0);
    m.discover.mockResolvedValue(listed(s.modelId));
    await syncConnectionModels(connectionId, new Date(t0.getTime() + 1 * DAY));
    await syncConnectionModels(connectionId, new Date(t0.getTime() + 2 * DAY));
    expect(await offering(connectionId, 'claude-keeper-1')).toMatchObject({ lifecycle: 'available', missed_sync_count: 2 });
    const third = await syncConnectionModels(connectionId, new Date(t0.getTime() + 3 * DAY));
    expect(third.markedMissing).toBe(1);
    expect(await offering(connectionId, 'claude-keeper-1')).toMatchObject({ lifecycle: 'missing', missed_sync_count: 3 });
    const late = await syncConnectionModels(connectionId, new Date(t0.getTime() + 15 * DAY));
    expect(late.markedRetired).toBe(1);
    expect(await offering(connectionId, 'claude-keeper-1')).toMatchObject({ lifecycle: 'retired' });

    m.discover.mockResolvedValue(listed(s.modelId, 'claude-keeper-1'));
    await syncConnectionModels(connectionId, new Date(t0.getTime() + 16 * DAY));
    expect(await offering(connectionId, 'claude-keeper-1')).toMatchObject({ lifecycle: 'available', missed_sync_count: 0, enabled: false });
  });

  it('three rapid syncs (manual refresh, rotation) do not mark a model missing within 48 h (W01 rule)', async () => {
    const t0 = new Date('2026-11-20T06:00:00.000Z');
    m.discover.mockResolvedValue(listed(s.modelId, 'claude-blip-1'));
    await syncConnectionModels(connectionId, t0);
    m.discover.mockResolvedValue(listed(s.modelId));
    for (let i = 1; i <= 4; i++) await syncConnectionModels(connectionId, new Date(t0.getTime() + i * 3_600_000));
    expect(await offering(connectionId, 'claude-blip-1')).toMatchObject({ lifecycle: 'available', missed_sync_count: 4 });
  });

  it('a row no sync has ever seen (an alias the listing omits, a projected/manual row) is never aged', async () => {
    await fixtureSql`
      INSERT INTO partner_ai_models (partner_id, connection_id, model_id, source, enabled)
      VALUES (${s.partnerId}, ${connectionId}, 'claude-manual-alias', 'manual', true)`;
    const t0 = new Date('2026-11-20T06:00:00.000Z');
    m.discover.mockResolvedValue(listed('claude-other-1'));
    for (const d of [0, 1, 2, 3, 20]) await syncConnectionModels(connectionId, new Date(t0.getTime() + d * DAY));
    // The seeded offering (source 'discovered', never observed) and the manual row are untouched.
    expect(await offering(connectionId, s.modelId)).toMatchObject({ lifecycle: 'available', missed_sync_count: 0, last_seen_at: null, enabled: true });
    expect(await offering(connectionId, 'claude-manual-alias')).toMatchObject({ lifecycle: 'available', missed_sync_count: 0, enabled: true });
  });

  it('a seen manual row keeps its admin-entered capabilities and is never aged once unlisted', async () => {
    await fixtureSql`
      INSERT INTO partner_ai_models (partner_id, connection_id, model_id, source, enabled, capabilities)
      VALUES (${s.partnerId}, ${connectionId}, 'claude-manual-seen', 'manual', true, ${fixtureSql.json({ admin: true })})`;
    const t0 = new Date('2026-11-20T06:00:00.000Z');
    m.discover.mockResolvedValue(listed('claude-manual-seen'));
    await syncConnectionModels(connectionId, t0);
    expect(await offering(connectionId, 'claude-manual-seen')).toMatchObject({ capabilities: { admin: true }, source: 'manual' });
    m.discover.mockResolvedValue(listed('claude-other-1'));
    for (const d of [1, 2, 3, 20]) await syncConnectionModels(connectionId, new Date(t0.getTime() + d * DAY));
    expect(await offering(connectionId, 'claude-manual-seen')).toMatchObject({ lifecycle: 'available', enabled: true });
  });

  it('a failed sync records a scrubbed discovery_error and changes no lifecycle; the next success clears it', async () => {
    const t0 = new Date('2026-11-20T06:00:00.000Z');
    m.discover.mockResolvedValue(listed(s.modelId, 'claude-keeper-2'));
    await syncConnectionModels(connectionId, t0);
    const before = await offerings(connectionId);
    const material = await sys(() => getConnectionKeyMaterial(connectionId));
    const partnerKey = decryptConnectionKey(material!);
    m.discover.mockRejectedValue(new Error(`401 invalid x-api-key ${partnerKey}`));
    for (const d of [1, 2, 3, 20]) {
      expect((await syncConnectionModels(connectionId, new Date(t0.getTime() + d * DAY))).status).toBe('failed');
    }
    expect(await offerings(connectionId)).toEqual(before);
    const failed = await connectionRow(connectionId);
    expect(failed.discovery_error).toContain('401');
    expect(failed.discovery_error).not.toContain(partnerKey);

    m.discover.mockResolvedValue(listed(s.modelId, 'claude-keeper-2'));
    await syncConnectionModels(connectionId, new Date(t0.getTime() + 21 * DAY));
    expect((await connectionRow(connectionId)).discovery_error).toBeNull();
  });

  it('an empty listing is a failed sync (W01 rule), never a mass "missing"', async () => {
    const t0 = new Date('2026-11-20T06:00:00.000Z');
    m.discover.mockResolvedValue(listed(s.modelId));
    await syncConnectionModels(connectionId, t0);
    m.discover.mockResolvedValue([]);
    for (const d of [1, 2, 3]) {
      expect((await syncConnectionModels(connectionId, new Date(t0.getTime() + d * DAY))).status).toBe('failed');
    }
    expect(await offering(connectionId, s.modelId)).toMatchObject({ lifecycle: 'available', missed_sync_count: 0 });
  });

  it('a key rotation during the listing supersedes the sync: nothing written, retry requested', async () => {
    m.discover.mockImplementation(async () => {
      await fixtureSql`UPDATE partner_ai_connections SET config_version = config_version + 1 WHERE id = ${connectionId}`;
      return listed('claude-stale-1');
    });
    const report = await syncConnectionModels(connectionId);
    expect(report).toMatchObject({ status: 'skipped', retry: true });
    expect(await offering(connectionId, 'claude-stale-1')).toBeUndefined();
  });

  it('discovery never changes an assignment', async () => {
    const snapshot = async () => sys(async () => [...await db.execute(sql`
      SELECT * FROM ai_model_assignments WHERE offering_partner_id = ${s.partnerId}::uuid ORDER BY id`)]);
    const before = await snapshot();
    m.discover.mockResolvedValue(listed('claude-brand-new-10'));
    await syncConnectionModels(connectionId);
    expect(await snapshot()).toEqual(before);
  });

  it('an unknown connection is skipped', async () => {
    expect(await syncConnectionModels(randomUUID())).toMatchObject({ status: 'skipped' });
    expect(m.discover).not.toHaveBeenCalled();
  });
});

describe('syncConnectionModels (catalog)', () => {
  it('mirrors only mapped AND verified models of the listed revision, disabled, without calling the Models API', async () => {
    m.discover.mockReset();
    const s = await seedRegistryPartner('catalog');
    const verified = `cat-verified-${randomUUID()}`;
    const unverified = `cat-unverified-${randomUUID()}`;
    // Catalog model_map keys must be platform model ids (spec §6).
    await seedPricedPlatformModel(verified);
    await seedPricedPlatformModel(unverified);
    // A new active revision mapping all three (activation needs every model
    // verified); a later failed re-verification drops `unverified` out.
    const mapEntry = { providerModel: 'gw/x', inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 };
    const { id: revisionId } = await createRevision({
      entryId: s.catalogEntryId!, baseUrl: 'https://gw.example.com/v1', authMode: 'x-api-key',
      modelMap: { [s.modelId]: mapEntry, [verified]: mapEntry, [unverified]: mapEntry }, createdBy: s.userId,
    });
    for (const modelId of [s.modelId, verified, unverified]) {
      await recordVerification({ revisionId, modelId, passed: true, verifiedBy: s.userId });
    }
    await activateRevision({ entryId: s.catalogEntryId!, revisionId });
    await recordVerification({ revisionId, modelId: unverified, passed: false, verifiedBy: s.userId });

    const report = await syncConnectionModels(s.connectionId!);
    expect(report).toMatchObject({ status: 'ok', discovered: 2, added: 1 });
    expect(m.discover).not.toHaveBeenCalled();
    const rows = await offerings(s.connectionId!);
    expect(rows.map((r) => r.model_id).sort()).toEqual([s.modelId, verified].sort());
    expect(rows.find((r) => r.model_id === verified)).toMatchObject({ source: 'catalog', enabled: false, platform_model_id: null, capabilities: null });
    expect(rows.find((r) => r.model_id === s.modelId)).toMatchObject({ enabled: true });
  });
});
