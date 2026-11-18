/**
 * Integration test — W09 (#6779) probe_network_asset, manage_known_guests,
 * get_unifi_status and trigger_unifi_sync honour the org axis, the site axis and the
 * partner-wide gate, against real Postgres as the unprivileged `breeze_app` role.
 *
 * Entry point: `executeTool`, so the same dispatch as production runs (permission
 * floor included). Proven against stored rows, not just the tool's reply:
 *   - a probe of an out-of-site / other-org asset is refused and the asset is NOT stamped;
 *   - the known-guest list is keyed by partner: another partner's id is "not found", and
 *     an org caller / a 'selected' partner caller is refused outright;
 *   - UniFi status, telemetry and sync act on the caller's OWN partner integration only:
 *     naming another partner, or a site of another partner's org, is refused;
 *   - a site-restricted partner caller sees only the collectors, mappings and telemetry of its sites.
 * Each refusal has a CONTROL: lifting the guard (the unrestricted / owning caller, same
 * input) lands the effect, so the refusal is the gate and not a broken fixture.
 *
 * The agent dispatch and the sync queue are mocked at the process boundary (no agent or
 * Redis queue is involved); everything before them runs for real.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

const { enqueue, relay } = vi.hoisted(() => ({
  enqueue: vi.fn(async () => undefined),
  relay: { dispatchCommandToAgent: vi.fn(async () => ({ status: 'sent' })) },
}));
vi.mock('../../jobs/unifiWorker', () => ({ enqueueUnifiSync: enqueue }));
vi.mock('../../services/agentCommandRelay', async (importOriginal) => ({ ...(await importOriginal<object>()), ...relay }));
vi.mock('../../services/networkExecutorSelection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  selectNetworkExecutor: vi.fn(async () => ({ agentId: 'agent-under-test' })),
}));
vi.mock('../../services/assetProbe', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  awaitProbeResult: vi.fn(async () => null), // never wait 8 s: the stamp, not the answer, is what is asserted
}));

import { withDbAccessContext } from '../../db';
import {
  discoveredAssets, networkKnownGuests, unifiCollectors, unifiDeviceTelemetry, unifiIntegrations, unifiSiteMappings, unifiSyncRuns,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { executeTool } from '../../services/aiTools';
import { clearPermissionCache } from '../../services/permissions';
import { createDevice } from './db-utils';
import { getTestDb } from './setup';
import { contextFor, seedNetworkMonitoringFixture, type NetworkMonitoringFixture, type Who } from './network-monitoring-ai-fixtures';

let f: NetworkMonitoringFixture;
beforeEach(async () => {
  clearPermissionCache();
  vi.clearAllMocks();
  f = await seedNetworkMonitoringFixture();
});

async function run(who: Who, tool: string, input: Record<string, unknown>, auth?: AuthContext) {
  const raw = await withDbAccessContext(contextFor(f, who), () => executeTool(tool, input, auth ?? f.auth[who]));
  return JSON.parse(raw) as Record<string, any>;
}

const assetRow = async (id: string) => (await getTestDb().select().from(discoveredAssets).where(eq(discoveredAssets.id, id)))[0]!;

describe('probe_network_asset', () => {
  it('stamps and dispatches for an in-site asset (CONTROL), and refuses an out-of-site one without stamping', async () => {
    const inSite = await run('restricted', 'probe_network_asset', { assetId: f.assetA1 });
    expect(inSite.probe?.state, JSON.stringify(inSite)).toBe('pending');
    const stamped = await assetRow(f.assetA1);
    expect(stamped.lastProbeStatus).toBe('pending');
    expect(stamped.lastProbeRef).toMatch(/^probe-/);
    expect(relay.dispatchCommandToAgent).toHaveBeenCalledTimes(1);

    const refused = await run('restricted', 'probe_network_asset', { assetId: f.assetA2 });
    expect(refused.code).toBe('NOT_FOUND');
    expect((await assetRow(f.assetA2)).lastProbeStatus).toBeNull();
    expect(relay.dispatchCommandToAgent).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: with the site ceiling lifted, the same call probes the other site', async () => {
    const lifted = await run('orgAll', 'probe_network_asset', { assetId: f.assetA2 });
    expect(lifted.probe?.state, JSON.stringify(lifted)).toBe('pending');
    expect((await assetRow(f.assetA2)).lastProbeStatus).toBe('pending');
  });

  it('an out-of-site asset and a missing one are one answer', async () => {
    const hidden = await run('restricted', 'probe_network_asset', { assetId: f.assetA2 });
    const missing = await run('restricted', 'probe_network_asset', { assetId: '00000000-0000-4000-8000-00000000dead' });
    expect(hidden).toEqual(missing);
  });

  it("another organization's and another partner's callers cannot probe the asset", async () => {
    for (const who of ['otherOrg', 'otherPartner'] as const) {
      const out = await run(who, 'probe_network_asset', { assetId: f.assetA1 });
      expect(out.code, who).toBe('NOT_FOUND');
    }
    expect((await assetRow(f.assetA1)).lastProbeStatus).toBeNull();
    expect(relay.dispatchCommandToAgent).not.toHaveBeenCalled();
  });

  it('a device-bound caller can only probe an asset linked to an allowed device', async () => {
    const dev = await createDevice({ orgId: f.orgA, siteId: f.siteA1 });
    const bound = { ...f.auth.orgAll, allowedDeviceIds: [dev.id] } as unknown as AuthContext;
    expect((await run('orgAll', 'probe_network_asset', { assetId: f.assetA1 }, bound)).code).toBe('NOT_FOUND');
    expect((await assetRow(f.assetA1)).lastProbeStatus).toBeNull();
    await getTestDb().update(discoveredAssets).set({ linkedDeviceId: dev.id }).where(eq(discoveredAssets.id, f.assetA1));
    const lifted = await run('orgAll', 'probe_network_asset', { assetId: f.assetA1 }, bound);
    expect(lifted.probe?.state, JSON.stringify(lifted)).toBe('pending');
  });

  it('one probe in flight per asset', async () => {
    await run('orgAll', 'probe_network_asset', { assetId: f.assetA1 });
    const second = await run('orgAll', 'probe_network_asset', { assetId: f.assetA1 });
    expect(second.code).toBe('PROBE_IN_FLIGHT');
    expect(relay.dispatchCommandToAgent).toHaveBeenCalledTimes(1);
  });
});

describe('manage_known_guests', () => {
  const guests = (partnerId: string) => getTestDb().select().from(networkKnownGuests).where(eq(networkKnownGuests.partnerId, partnerId));
  async function seedGuest(partnerId: string, mac: string, label: string) {
    const [row] = await getTestDb().insert(networkKnownGuests).values({ partnerId, macAddress: mac, label }).returning();
    return row!;
  }

  it('list is keyed by the caller partner', async () => {
    await seedGuest(f.partnerId, 'aa:aa:aa:aa:aa:01', 'Mine');
    await seedGuest(f.otherPartnerId, 'bb:bb:bb:bb:bb:01', 'Theirs');
    const mine = await run('partnerAdmin', 'manage_known_guests', { action: 'list' });
    expect(mine.guests.map((g: { label: string }) => g.label)).toEqual(['Mine']);
    const theirs = await run('otherPartner', 'manage_known_guests', { action: 'list' });
    expect(theirs.guests.map((g: { label: string }) => g.label)).toEqual(['Theirs']);
  });

  it("deleting another partner's guest is not-found and the row survives; CONTROL: the owner deletes it", async () => {
    const theirs = await seedGuest(f.otherPartnerId, 'bb:bb:bb:bb:bb:02', 'Theirs');
    const refused = await run('partnerAdmin', 'manage_known_guests', { action: 'delete', guestId: theirs.id });
    const missing = await run('partnerAdmin', 'manage_known_guests', { action: 'delete', guestId: '00000000-0000-4000-8000-00000000dead' });
    expect(refused.code).toBe('NOT_FOUND');
    expect(refused).toEqual(missing);
    expect(await guests(f.otherPartnerId)).toHaveLength(1);

    const lifted = await run('otherPartner', 'manage_known_guests', { action: 'delete', guestId: theirs.id });
    expect(lifted.deleted, JSON.stringify(lifted)).toBe(true);
    expect(await guests(f.otherPartnerId)).toHaveLength(0);
  });

  it('add stores the lower-cased MAC under the caller partner; a duplicate is reported, not duplicated', async () => {
    const added = await run('partnerAdmin', 'manage_known_guests', { action: 'add', macAddress: 'AA:BB:CC:DD:EE:FF', label: 'Kiosk' });
    expect(added.added, JSON.stringify(added)).toBe(true);
    const rows = await guests(f.partnerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.macAddress).toBe('aa:bb:cc:dd:ee:ff');
    expect(await guests(f.otherPartnerId)).toHaveLength(0);
    const dup = await run('partnerAdmin', 'manage_known_guests', { action: 'add', macAddress: 'aa:bb:cc:dd:ee:ff', label: 'Again' });
    expect(dup.code).toBe('ALREADY_EXISTS');
    expect(await guests(f.partnerId)).toHaveLength(1);
  });

  it("an org caller and a 'selected' partner caller are refused for every action, with nothing written", async () => {
    for (const who of ['orgAll', 'restricted', 'partnerSel'] as const) {
      for (const input of [
        { action: 'list' },
        { action: 'add', macAddress: 'aa:aa:aa:aa:aa:09', label: 'X' },
        { action: 'delete', guestId: '00000000-0000-4000-8000-00000000dead' },
      ]) {
        const out = await run(who, 'manage_known_guests', input);
        expect(out.code, `${who} ${input.action}`).toBe('ACCESS_DENIED');
      }
    }
    expect(await guests(f.partnerId)).toHaveLength(0);
  });
});

describe('UniFi — status, telemetry and sync act on the caller partner only', () => {
  async function seedUnifi() {
    const db = getTestDb();
    const [intP] = await db.insert(unifiIntegrations).values({ partnerId: f.partnerId, accountLabel: 'Partner P', apiKeyEncrypted: 'not-a-real-key', status: 'connected' }).returning();
    const [intQ] = await db.insert(unifiIntegrations).values({ partnerId: f.otherPartnerId, accountLabel: 'Partner Q', apiKeyEncrypted: 'not-a-real-key', status: 'connected' }).returning();
    await db.insert(unifiSyncRuns).values({ integrationId: intP!.id, partnerId: f.partnerId, trigger: 'manual', status: 'ok' });
    await db.insert(unifiSyncRuns).values({ integrationId: intQ!.id, partnerId: f.otherPartnerId, trigger: 'manual', status: 'failed' });
    const collectors: Record<string, string> = {};
    for (const [key, orgId, siteId] of [['a1', f.orgA, f.siteA1], ['a2', f.orgA, f.siteA2]] as const) {
      const dev = await createDevice({ orgId, siteId });
      const [col] = await db.insert(unifiCollectors).values({
        integrationId: intP!.id, orgId, siteId, unifiHostId: `host-${key}`, collectorDeviceId: dev.id,
        controllerUrl: `https://controller-${key}.example.test`, localApiKeyEncrypted: 'not-a-real-key',
      }).returning();
      collectors[key] = col!.id;
      await db.insert(unifiSiteMappings).values({
        integrationId: intP!.id, orgId, siteId, unifiHostId: `host-${key}`, unifiSiteId: `site-${key}`,
      });
      await db.insert(unifiDeviceTelemetry).values({
        collectorId: col!.id, orgId, siteId, unifiDeviceId: `dev-${key}`, name: `AP ${key}`, raw: { secret: 'vendor-payload' },
      });
    }
    return { intP: intP!, intQ: intQ! };
  }

  const restrictedPartner = () => ({
    ...f.auth.partnerAdmin,
    allowedSiteIds: [f.siteA1],
    canAccessSite: (s: string | null | undefined) => s === f.siteA1,
  }) as unknown as AuthContext;

  it('status reads the caller own integration; naming another partner is refused', async () => {
    await seedUnifi();
    expect((await run('partnerAdmin', 'get_unifi_status', { action: 'status' })).accountLabel).toBe('Partner P');
    expect((await run('otherPartner', 'get_unifi_status', { action: 'status' })).accountLabel).toBe('Partner Q');
    const cross = await run('partnerAdmin', 'get_unifi_status', { action: 'status', partnerId: f.otherPartnerId });
    expect(cross.code).toBe('ACCESS_DENIED');
    expect(JSON.stringify(cross)).not.toMatch(/Partner Q/);
  });

  it("an org caller and a 'selected' partner caller are refused for every UniFi action", async () => {
    await seedUnifi();
    for (const who of ['orgAll', 'restricted', 'partnerSel'] as const) {
      expect((await run(who, 'get_unifi_status', { action: 'status' })).code, who).toBe('ACCESS_DENIED');
      expect((await run(who, 'get_unifi_status', { action: 'sync_runs' })).code, who).toBe('ACCESS_DENIED');
      expect((await run(who, 'trigger_unifi_sync', {})).code, who).toBe('ACCESS_DENIED');
    }
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('sync_runs lists the caller own ledger only', async () => {
    await seedUnifi();
    const mine = await run('partnerAdmin', 'get_unifi_status', { action: 'sync_runs' });
    expect(mine.runs.map((r: { status: string }) => r.status)).toEqual(['ok']);
    const theirs = await run('otherPartner', 'get_unifi_status', { action: 'sync_runs' });
    expect(theirs.runs.map((r: { status: string }) => r.status)).toEqual(['failed']);
  });

  it("sync queues the caller's own integration, never another partner's; naming one is refused", async () => {
    const { intP, intQ } = await seedUnifi();
    const refused = await run('partnerAdmin', 'trigger_unifi_sync', { partnerId: f.otherPartnerId });
    expect(refused.code).toBe('ACCESS_DENIED');
    expect(enqueue).not.toHaveBeenCalled();

    const own = await run('partnerAdmin', 'trigger_unifi_sync', {});
    expect(own.queued, JSON.stringify(own)).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(intP.id, f.partnerId, 'manual');

    const control = await run('otherPartner', 'trigger_unifi_sync', {});
    expect(control.queued).toBe(true);
    expect(enqueue).toHaveBeenLastCalledWith(intQ.id, f.otherPartnerId, 'manual');
  });

  it('sync with no integration connected is an error and queues nothing', async () => {
    const out = await run('partnerAdmin', 'trigger_unifi_sync', {});
    expect(out.code).toBe('NOT_CONNECTED');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('telemetry: a site of another partner’s org is not found; CONTROL: the owner reads it, without the raw payload', async () => {
    await seedUnifi();
    const other = await run('otherPartner', 'get_unifi_status', { action: 'telemetry', siteId: f.siteA1 });
    const missing = await run('otherPartner', 'get_unifi_status', { action: 'telemetry', siteId: '00000000-0000-4000-8000-00000000dead' });
    expect(other.code).toBe('NOT_FOUND');
    expect(other).toEqual(missing);

    const own = await run('partnerAdmin', 'get_unifi_status', { action: 'telemetry', siteId: f.siteA1 });
    expect(own.devices, JSON.stringify(own)).toHaveLength(1);
    expect(JSON.stringify(own)).not.toMatch(/vendor-payload|raw/);
  });

  it('a site-restricted partner caller sees only its sites; CONTROL: the unrestricted caller sees both', async () => {
    await seedUnifi();
    const narrowed = restrictedPartner();
    expect((await run('partnerAdmin', 'get_unifi_status', { action: 'telemetry', siteId: f.siteA2 }, narrowed)).code).toBe('NOT_FOUND');
    expect((await run('partnerAdmin', 'get_unifi_status', { action: 'telemetry', siteId: f.siteA1 }, narrowed)).devices).toHaveLength(1);

    const collectors = await run('partnerAdmin', 'get_unifi_status', { action: 'collectors' }, narrowed);
    expect(collectors.collectors.map((c: { siteId: string }) => c.siteId)).toEqual([f.siteA1]);
    const mappings = await run('partnerAdmin', 'get_unifi_status', { action: 'mappings' }, narrowed);
    expect(mappings.mappings.map((m: { siteId: string }) => m.siteId)).toEqual([f.siteA1]);

    const lifted = await run('partnerAdmin', 'get_unifi_status', { action: 'collectors' });
    expect(lifted.collectors).toHaveLength(2);
    expect(JSON.stringify(lifted)).not.toMatch(/not-a-real-key|localApiKey/);
    expect((await run('partnerAdmin', 'get_unifi_status', { action: 'mappings' })).mappings).toHaveLength(2);
    expect((await run('partnerAdmin', 'get_unifi_status', { action: 'telemetry', siteId: f.siteA2 })).devices).toHaveLength(1);
  });

  it('the other partner’s collectors and mappings never leak into the caller’s view', async () => {
    await seedUnifi();
    const theirs = await run('otherPartner', 'get_unifi_status', { action: 'collectors' });
    expect(theirs.collectors).toEqual([]);
    expect((await run('otherPartner', 'get_unifi_status', { action: 'mappings' })).mappings).toEqual([]);
  });
});
