/**
 * Topology demo seed: a synthetic, Whalers-shaped dental site for refining the
 * topology explorer on a LOCAL stack. QA fixture only; refuses any non-local DB.
 *
 *   npx tsx scripts/seed-topology-demo.ts                 # (re)seed, then exit
 *   npx tsx scripts/seed-topology-demo.ts --keep-fresh    # (re)seed, then keep online agents fresh
 *   npx tsx scripts/seed-topology-demo.ts --keep-fresh-only
 *
 * On a `pnpm wt-stack` stack (Postgres is not host-published; scripts/ is not mounted):
 *   C=<project>-api-1
 *   docker cp apps/api/scripts/seed-topology-demo.ts $C:/app/apps/api/scripts/
 *   docker cp apps/api/scripts/seed-topology-demo.lib.ts $C:/app/apps/api/scripts/
 *   docker exec -w /app/apps/api $C npx tsx scripts/seed-topology-demo.ts
 *   docker exec -d -w /app/apps/api $C sh -c 'npx tsx scripts/seed-topology-demo.ts --keep-fresh-only > /tmp/topology-demo-keep-fresh.log 2>&1'
 * The site is reachable at /discovery#topology/site/<DEMO_SITE_ID> after switching to the demo org.
 *
 * Options: --interval=<seconds> (keep-fresh cadence, default 60)
 *          --partner-email=<email> (partner user whose partner owns the demo org; default admin@breeze.local)
 *          --complete-caches (no truncated neighbor cache, so #7816 neighbor upgrades can apply)
 *
 * Idempotent: an existing "Topology Demo — Harbor Dental" org under that partner is
 * erased through the real tenant-erasure cascade (cascadeDeleteOrg) and rebuilt.
 *
 * Paths used (real code wherever one exists):
 *  - Inventory rows (orgs, sites, devices, device_network, discovery profile/jobs,
 *    discovered_assets, legacy topology_layout pins) are written to their normal
 *    tables; their SQL capture triggers emit the legacy `binding.changed` /
 *    `layout.upsert` outbox events exactly as production writes do.
 *  - importLegacyTopologySite stages + drains the legacy snapshot (legacyReplay
 *    publishes device/asset nodes, bindings, aliases and the shared overview
 *    layout with source:'legacy' pins).
 *  - Agent network context goes through topologyHeartbeat (services/topology/heartbeat.ts)
 *    -> negotiateTopologyContext -> ingestTopologyNetworkContext, the heartbeat route's seam.
 *  - reconcileTopologySite (the reconcile worker's turn) publishes; expireTopologyEvidence
 *    (the retention worker's pass) archives support older than 7 days.
 *  - --keep-fresh: real `unchanged` reports through topologyHeartbeat, plus the
 *    devices.last_seen_at/status write the heartbeat route makes (no service seam).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  DAY, DEMO_ORG_ID, DEMO_ORG_NAME, DEMO_ORG_SLUG, DEMO_SITE_ID, DEMO_SITE_NAME, HOUR, MAIN_LAN, SECOND_LAN,
  assertLocalDevDatabase, demoAssets, demoDevices, demoLegacyPins, demoMac,
  type DemoAsset, type DemoDevice,
} from './seed-topology-demo.lib';

assertLocalDevDatabase(process.env);

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const KEEP_FRESH = flag('keep-fresh') || flag('keep-fresh-only');
const SEED = !flag('keep-fresh-only');
const INTERVAL_SECONDS = Math.max(15, Number(option('interval') ?? 60) || 60);
const PARTNER_EMAIL = option('partner-email') ?? 'admin@breeze.local';
const COMPLETE_CACHES = flag('complete-caches');
const FLAGS = { materialization: true, ui: true } as const;

// The DB pool and services load only after the guard above has passed.
const { sql } = await import('drizzle-orm');
const { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } = await import('../src/db');
const { networkContextFullSchema } = await import('@breeze/shared');
const { resolveTopologyFlags, withResolvedTopologyFlags } = await import('../src/services/topology/flags');
const { topologyHeartbeat } = await import('../src/services/topology/heartbeat');
const { importLegacyTopologySite } = await import('../src/services/topology/legacyImport');
const { reconcileTopologySite } = await import('../src/services/topology/reconcile');
const { expireTopologyEvidence } = await import('../src/services/topology/collectionRetention');
const { topologyContextDigest, topologySectionDigest } = await import('../src/services/topology/collectionDigest');
const { registerTopologyPhysicalAuthorities } = await import('../src/services/topology/physicalAuthorities');
const { retryableTopologyTransaction } = await import('../src/services/topology/transactionRetry');
const { cascadeDeleteOrg } = await import('../src/services/tenantCascade');
type NetworkContextFull = import('@breeze/shared').NetworkContextFull;
type Scope = { orgId: string; siteId: string };
type DeviceRow = { id: string; hostname: string; status: string };

const system = <T>(fn: () => Promise<T>, label: string) => runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
const asOrg = <T>(orgId: string, fn: () => Promise<T>) => withDbAccessContext(
  { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null }, fn);
const resolvedFlags = resolveTopologyFlags({ orgSettings: { topologyFeatureFlags: FLAGS } });
const log = (message: string) => console.log(`[seed-topology-demo] ${message}`);

async function retrying<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (error) {
      // The running API's own topology workers drain the same site; a fenced or
      // contended publication is retried exactly as those workers retry it.
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < 8 && (retryableTopologyTransaction(error) || /fenced|could not obtain lock/i.test(message))) {
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      throw new Error(`${label}: ${message}`, { cause: error });
    }
  }
}

// ---------------------------------------------------------------- tenant ---

async function partnerOwner(): Promise<{ userId: string; email: string; partnerId: string }> {
  const rows = await system(() => db.execute<{ id: string; email: string; partner_id: string | null; pu_partner: string | null }>(sql`
    SELECT u.id, u.email, u.partner_id, (SELECT pu.partner_id FROM partner_users pu WHERE pu.user_id=u.id LIMIT 1) AS pu_partner
    FROM users u WHERE lower(u.email)=lower(${PARTNER_EMAIL}) LIMIT 1`), 'demo owner lookup');
  const row = rows[0];
  const partnerId = row?.partner_id ?? row?.pu_partner;
  if (!row || !partnerId) throw new Error(`No partner user ${PARTNER_EMAIL}; pass --partner-email=<a partner user's email>.`);
  return { userId: row.id, email: row.email, partnerId };
}

async function findDemo(partnerId: string): Promise<Scope | null> {
  const rows = await system(() => db.execute<{ org_id: string; site_id: string | null }>(sql`
    SELECT o.id AS org_id, (SELECT s.id FROM sites s WHERE s.org_id=o.id AND s.name=${DEMO_SITE_NAME} LIMIT 1) AS site_id
    FROM organizations o WHERE o.id=${DEMO_ORG_ID}::uuid OR (o.partner_id=${partnerId}::uuid AND (o.slug=${DEMO_ORG_SLUG} OR o.name=${DEMO_ORG_NAME}))
    ORDER BY (o.id=${DEMO_ORG_ID}::uuid) DESC LIMIT 1`), 'demo lookup');
  return rows[0]?.site_id ? { orgId: rows[0].org_id, siteId: rows[0].site_id } : rows[0] ? { orgId: rows[0].org_id, siteId: '' } : null;
}

async function resetDemo(owner: { userId: string; email: string; partnerId: string }) {
  const existing = await findDemo(owner.partnerId);
  if (!existing) return;
  log(`erasing previous demo org ${existing.orgId} through cascadeDeleteOrg…`);
  // Stop the API's topology workers from re-dirtying the site mid-erasure.
  await system(() => db.execute(sql`UPDATE organizations SET settings=COALESCE(settings,'{}'::jsonb)-'topologyFeatureFlags' WHERE id=${existing.orgId}::uuid`), 'demo flags off');
  await retrying('erase demo org', () => cascadeDeleteOrg(existing.orgId, owner.userId, owner.email));
}

// ------------------------------------------------------------- inventory ---

const isoAgo = (now: number, ms: number) => new Date(now - ms).toISOString();

async function seedInventory(partnerId: string, devices: DemoDevice[], assets: DemoAsset[], now: number) {
  return system(async () => {
    const [org] = await db.execute<{ id: string }>(sql`INSERT INTO organizations (id,partner_id,name,slug,type,status,currency_code,settings)
      VALUES (${DEMO_ORG_ID}::uuid,${partnerId}::uuid,${DEMO_ORG_NAME},${DEMO_ORG_SLUG},'customer','active','USD','{}'::jsonb) RETURNING id`);
    const orgId = org!.id;
    const [site] = await db.execute<{ id: string }>(sql`INSERT INTO sites (id,org_id,name,timezone) VALUES (${DEMO_SITE_ID}::uuid,${orgId}::uuid,${DEMO_SITE_NAME},'America/Chicago') RETURNING id`);
    const siteId = site!.id;
    const deviceIds = new Map<string, string>();
    for (const d of devices) {
      const lastSeen = isoAgo(now, d.lastSeenAgoMs);
      const [row] = await db.execute<{ id: string }>(sql`INSERT INTO devices
        (org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version,agent_token_hash,status,last_seen_at,device_role,enrolled_at)
        VALUES (${orgId}::uuid,${siteId}::uuid,${`topology-demo-${d.key}`},${d.hostname},'windows',
          ${d.role === 'server' ? '10.0.20348' : '10.0.19045'},'amd64',${d.agentVersion},${randomBytes(32).toString('hex')},
          ${d.status},${lastSeen},${d.role},${isoAgo(now, 400 * DAY)}) RETURNING id`);
      deviceIds.set(d.key, row!.id);
      // What the agent's inventory upload (routes/agents/inventory.ts) stores for its NICs.
      await db.execute(sql`INSERT INTO device_network (device_id,org_id,interface_name,mac_address,ip_address,ip_type,is_primary)
        VALUES (${row!.id}::uuid,${orgId}::uuid,${d.role === 'server' ? 'Ethernet0' : 'Ethernet'},${d.mac},${d.ip},'ipv4',true)`);
    }
    // Discovery: one profile, the latest completed scan 2 h ago, the one before it
    // 26 h ago, and older completed scans the stale assets were last seen in.
    const [profile] = await db.execute<{ id: string }>(sql`INSERT INTO discovery_profiles (org_id,site_id,name,subnets,methods,schedule)
      VALUES (${orgId}::uuid,${siteId}::uuid,'Main LAN sweep',ARRAY[${MAIN_LAN.prefix}]::text[],ARRAY['arp','ping']::discovery_method[],
        ${JSON.stringify({ type: 'interval', intervalHours: 24 })}::jsonb) RETURNING id`);
    const job = async (completedAgoMs: number, hostsDiscovered: number) => {
      const [row] = await db.execute<{ id: string }>(sql`INSERT INTO discovery_jobs (profile_id,org_id,site_id,agent_id,status,scheduled_at,started_at,completed_at,hosts_scanned,hosts_discovered,new_assets)
        VALUES (${profile!.id}::uuid,${orgId}::uuid,${siteId}::uuid,${'topology-demo-server-01'},'completed',${isoAgo(now, completedAgoMs + 5 * 60_000)},
          ${isoAgo(now, completedAgoMs + 4 * 60_000)},${isoAgo(now, completedAgoMs)},254,${hostsDiscovered},0) RETURNING id`);
      return row!.id;
    };
    const oldJobs = new Map<number, string>();
    for (const days of [...new Set(assets.filter(a => a.staleDays).map(a => a.staleDays!))].sort((a, b) => b - a)) oldJobs.set(days, await job(days * DAY, 70));
    const previousJob = await job(26 * HOUR, 63);
    const latestJob = await job(2 * HOUR, assets.filter(a => a.presence === 'answered').length);
    const assetIds = new Map<string, string>();
    for (const a of assets) {
      const seenAgo = a.presence === 'answered' ? 2 * HOUR : a.presence === 'missed' ? 26 * HOUR : a.staleDays! * DAY;
      const jobId = a.presence === 'answered' ? latestJob : a.presence === 'missed' ? previousJob : oldJobs.get(a.staleDays!)!;
      const linkedId = a.linkedDeviceKey ? deviceIds.get(a.linkedDeviceKey)! : null;
      // `stale` reproduces #7879: is_online is sticky TRUE although the asset was last
      // seen 18–112 days ago and did not answer the latest completed scan.
      const [row] = await db.execute<{ id: string }>(sql`INSERT INTO discovered_assets
        (org_id,site_id,ip_address,mac_address,hostname,asset_type,approval_status,is_online,manufacturer,model,linked_device_id,link_source,
         first_seen_at,last_seen_at,status_observed_at,status_source,last_job_id,discovery_methods,source,response_time_ms)
        VALUES (${orgId}::uuid,${siteId}::uuid,${a.ip}::inet,${a.mac},${a.hostname},${a.assetType},${linkedId ? 'approved' : 'pending'},
          ${a.presence !== 'missed'},${a.manufacturer},${a.model},${linkedId}::uuid,${linkedId ? 'auto' : null},
          ${isoAgo(now, 200 * DAY)},${isoAgo(now, seenAgo)},${isoAgo(now, a.presence === 'stale' ? seenAgo : 2 * HOUR)},'scan',${jobId}::uuid,
          ARRAY['arp','ping']::discovery_method[],'scan',${a.presence === 'answered' ? 2.4 : null}) RETURNING id`);
      assetIds.set(a.key, row!.id);
    }
    // Legacy flat-map pins (topology_layout is the legacy source; its capture
    // trigger -> legacy replay is what turns them into source:'legacy' v2 pins).
    for (const pin of demoLegacyPins(assets)) {
      await db.execute(sql`INSERT INTO topology_layout (org_id,site_id,node_type,node_id,x,y,pinned,updated_at)
        VALUES (${orgId}::uuid,${siteId}::uuid,'discovered_asset',${assetIds.get(pin.assetKey)!}::uuid,${pin.x},${pin.y},true,${isoAgo(now, 120 * DAY)})`);
    }
    return { orgId, siteId, deviceIds };
  }, 'topology demo inventory');
}

async function enableTopology(scope: Scope) {
  await system(() => db.execute(sql`UPDATE organizations
    SET settings=jsonb_set(COALESCE(settings,'{}'::jsonb),'{topologyFeatureFlags}',${JSON.stringify(FLAGS)}::jsonb,true) WHERE id=${scope.orgId}::uuid`), 'demo flags on');
  for (let pass = 0; pass < 50; pass++) {
    const result = await retrying('legacy import', () => system(
      () => withResolvedTopologyFlags({ orgId: scope.orgId, flags: resolvedFlags }, () => importLegacyTopologySite(scope, { batchSize: 200 })), 'demo legacy import'));
    if (result.complete) { log(`legacy import complete: ${JSON.stringify(result.counts)}`); return; }
  }
  throw new Error('legacy import did not complete');
}

// --------------------------------------------------------- network context ---

/** Canonical (URL-normalized) IPv6 link-local address for one device. */
const linkLocalFor = (index: number) => `fe80::b7:${(0x1a00 + index).toString(16)}:${(0x2c00 + index * 13).toString(16)}`;

function neighborRows(d: DemoDevice, index: number, devices: DemoDevice[], assets: DemoAsset[]) {
  type Row = NetworkContextFull['sections'][number] & { kind: 'neighbors' };
  const rows: Row['rows'] = [];
  const add = (address: string, mac: string, state: 'reachable' | 'stale' | 'delay' | 'permanent', isRouter = false) =>
    rows.push({ rowKey: `n4-${address}`, address, family: 'ipv4', zone: null, interfaceKey: 'if-lan', mac, state, isRouter });
  if (d.lan === 'second') {
    add(SECOND_LAN.gateway, demoMac(3, 1), 'reachable', true);
    for (const peer of devices.filter(p => p.lan === 'second' && p.key !== d.key)) add(peer.ip, peer.mac, 'stale');
    return rows;
  }
  const gatewayAsset = assets.find(a => a.ip === MAIN_LAN.gateway)!;
  add(MAIN_LAN.gateway, gatewayAsset.mac, 'reachable', true);
  // A rotating window of assets that answered the latest scan: exact IP+MAC matches.
  const answered = assets.filter(a => a.presence === 'answered' && a.ip !== d.ip && a.ip !== MAIN_LAN.gateway);
  for (let i = 0; i < 9; i++) {
    const asset = answered[(index * 5 + i * 3) % answered.length]!;
    if (!rows.some(r => r.address === asset.ip)) add(asset.ip, asset.mac, i % 3 === 0 ? 'stale' : 'reachable');
  }
  // Phones .160-.162: FRONT-01 sees the inventory MAC; FRONT-02 sees a different one.
  for (const [i, ip] of ['10.1.2.160', '10.1.2.161', '10.1.2.162'].entries()) {
    const asset = assets.find(a => a.ip === ip)!;
    const conflicting = d.extras.includes('neighbor_mac_conflicts');
    if (!conflicting && d.key !== 'front-01') continue;
    const existing = rows.findIndex(r => r.address === ip);
    if (existing >= 0) rows.splice(existing, 1);
    add(ip, conflicting ? demoMac(9, i + 1) : asset.mac, 'reachable');
  }
  return rows;
}

function fullReport(d: DemoDevice, index: number, devices: DemoDevice[], assets: DemoAsset[], cfg: { producerEpoch: string; sourceIdentity: string }, sequence: string): NetworkContextFull {
  const lan = d.lan === 'main' ? MAIN_LAN : SECOND_LAN;
  type Iface = Extract<NetworkContextFull['sections'][number], { kind: 'interfaces' }>['rows'][number];
  type Route = Extract<NetworkContextFull['sections'][number], { kind: 'routes' }>['rows'][number];
  const interfaces: Iface[] = [];
  const routes: Route[] = [];
  const lanAddresses: Iface['addresses'] = d.extras.includes('apipa_only') ? [] : [{ address: d.ip, prefixLength: 24, family: 'ipv4', zone: null, state: 'preferred', assignment: 'dhcp' }];
  if (d.linkLocal) lanAddresses.push({ address: linkLocalFor(index), prefixLength: 64, family: 'ipv6', zone: '12', state: 'preferred', assignment: 'link_local' });
  interfaces.push({ rowKey: 'if-lan', interfaceKey: 'if-lan', osIndex: 12, name: d.role === 'server' ? 'Ethernet0' : 'Ethernet', kind: 'ethernet',
    adminState: 'up', operState: 'up', mtu: 1500, addresses: lanAddresses, currentMac: d.mac, permanentMac: d.mac });
  routes.push({ rowKey: 'r4-default', family: 'ipv4', destinationPrefix: '0.0.0.0/0', interfaceKey: 'if-lan', tableKey: 'main', routeType: 'unicast', metric: 25,
    nextHops: [{ address: lan.gateway, zone: null, interfaceKey: 'if-lan', weight: null }], osFlags: 0 });
  if (lanAddresses.some(a => a.family === 'ipv4')) routes.push({ rowKey: 'r4-lan', family: 'ipv4', destinationPrefix: lan.prefix, interfaceKey: 'if-lan', tableKey: 'main',
    routeType: 'on_link', metric: 281, nextHops: [{ address: null, zone: null, interfaceKey: 'if-lan', weight: null }], osFlags: 0 });
  if (d.linkLocal) routes.push({ rowKey: 'r6-link-local', family: 'ipv6', destinationPrefix: 'fe80::/64', interfaceKey: 'if-lan', tableKey: 'main',
    routeType: 'on_link', metric: 281, nextHops: [{ address: null, zone: null, interfaceKey: 'if-lan', weight: null }], osFlags: 0 });
  if (d.extras.includes('apipa_nic') || d.extras.includes('apipa_only')) {
    interfaces.push({ rowKey: 'if-eth2', interfaceKey: 'if-eth2', osIndex: 18, name: 'Ethernet 2', kind: 'ethernet', adminState: 'up', operState: 'up', mtu: 1500,
      addresses: [{ address: d.extras.includes('apipa_only') ? '169.254.37.12' : '169.254.211.40', prefixLength: 16, family: 'ipv4', zone: null, state: 'preferred', assignment: 'link_local' }],
      currentMac: demoMac(4, index), permanentMac: demoMac(4, index) });
  }
  if (d.extras.includes('tailscale')) {
    interfaces.push({ rowKey: 'if-ts', interfaceKey: 'if-ts', osIndex: 31, name: 'Tailscale', kind: 'tunnel', adminState: 'up', operState: 'up', mtu: 1280,
      addresses: [{ address: '100.86.41.17', prefixLength: 32, family: 'ipv4', zone: null, state: 'preferred', assignment: 'static' },
        { address: 'fd7a:115c:a1e0::4a01:2b11', prefixLength: 128, family: 'ipv6', zone: null, state: 'preferred', assignment: 'static' }] });
    routes.push({ rowKey: 'r4-tailnet', family: 'ipv4', destinationPrefix: '100.64.0.0/10', interfaceKey: 'if-ts', tableKey: 'main', routeType: 'on_link', metric: 5,
      nextHops: [{ address: null, zone: null, interfaceKey: 'if-ts', weight: null }], osFlags: 0 });
  }
  if (d.extras.includes('vpn_full_tunnel')) {
    interfaces.push({ rowKey: 'if-vpn', interfaceKey: 'if-vpn', osIndex: 44, name: 'OpenVPN Data Channel Offload', kind: 'tunnel', adminState: 'up', operState: 'up', mtu: 1400,
      addresses: [{ address: '10.212.134.18', prefixLength: 24, family: 'ipv4', zone: null, state: 'preferred', assignment: 'static' }] });
    for (const prefix of ['0.0.0.0/1', '128.0.0.0/1']) routes.push({ rowKey: `r4-vpn-${prefix.split('.')[0]}`, family: 'ipv4', destinationPrefix: prefix, interfaceKey: 'if-vpn',
      tableKey: 'main', routeType: 'unicast', metric: 0, nextHops: [{ address: '10.212.134.1', zone: null, interfaceKey: 'if-vpn', weight: null }], osFlags: 0 });
  }
  const neighbors = d.extras.some(e => e.startsWith('neighbors')) ? neighborRows(d, index, devices, assets) : [];
  const truncated = d.extras.includes('neighbors_truncated') && !COMPLETE_CACHES;
  const families = interfaces.some(i => i.addresses.some(a => a.family === 'ipv6')) ? ['ipv4', 'ipv6'] as const : ['ipv4'] as const;
  const section = <K extends string, R>(kind: K, rows: R[], extra: Record<string, unknown> = {}) =>
    ({ kind, contextKey: 'default', contentDigest: '0'.repeat(64), outcome: 'complete', rowCount: rows.length, rows, ...extra });
  const capturedAt = new Date(Date.now() - (d.capture?.ageMs ?? 0));
  const draft = {
    version: 1, producerEpoch: cfg.producerEpoch, snapshotId: randomUUID(), sequence, capturedAt: capturedAt.toISOString(),
    captureAgeAtSendMs: d.capture?.ageMs ?? 0, expectedIntervalSeconds: 300, contentDigest: '0'.repeat(64), reportKind: 'full',
    capabilities: ['interfaces', 'routes', 'rules', 'resolvers', 'neighbors'].map(name => ({ name, version: 1, supported: true })),
    contextManifest: { outcome: 'complete', contexts: [{ contextKey: 'default', families: [...families] }] },
    sections: [
      section('interfaces', interfaces),
      section('routes', routes),
      section('rules', []),
      section('resolvers', [{ rowKey: 'dns-1', address: lan.gateway, zone: null, interfaceKey: 'if-lan', isLocalStub: false, port: 53, transport: 'udp_tcp',
        domains: [{ name: 'harbor-dental.example', routeOnly: false }], mechanism: 'ip_helper' }]),
      section('neighbors', neighbors, truncated ? { outcome: 'partial', reasonCode: 'limit_exceeded', omittedRowCount: 112 } : {}),
    ],
  };
  // Digest the PARSED form, exactly as normalizeNetworkContext re-derives it.
  const report = networkContextFullSchema.parse(draft);
  for (const s of report.sections) s.contentDigest = topologySectionDigest(report, s, cfg.sourceIdentity);
  report.contentDigest = topologyContextDigest(report, cfg.sourceIdentity);
  return report;
}

/** The heartbeat route's topology call: org-scoped tx, resolved flags, topologyHeartbeat. */
const heartbeat = (scope: Scope, deviceId: string, input: { networkContextV1?: unknown }) => asOrg(scope.orgId,
  () => withResolvedTopologyFlags({ orgId: scope.orgId, flags: resolvedFlags },
    () => db.transaction(() => topologyHeartbeat({ id: deviceId, orgId: scope.orgId, siteId: scope.siteId }, input))));

async function reportFull(scope: Scope, deviceId: string, d: DemoDevice, index: number, devices: DemoDevice[], assets: DemoAsset[], sequence: string) {
  const { config } = await heartbeat(scope, deviceId, {});
  if (!('producerEpoch' in config) || !config.producerEpoch || !config.sourceIdentity) throw new Error(`${d.hostname}: topology collection not negotiated`);
  const report = fullReport(d, index, devices, assets, { producerEpoch: config.producerEpoch, sourceIdentity: config.sourceIdentity }, sequence);
  const { receipt } = await heartbeat(scope, deviceId, { networkContextV1: report });
  if (!receipt?.accepted) throw new Error(`${d.hostname}: network context rejected (${receipt?.reason ?? 'no receipt'}) ${JSON.stringify(receipt?.sourceReceipts?.filter(r => !r.accepted))}`);
}

// ----------------------------------------------------------------- publish ---

async function publishUntilClean(scope: Scope) {
  for (let turn = 0; turn < 60; turn++) {
    const [state] = await system(() => db.execute<{ dirty: string; done: string }>(sql`SELECT dirty_revision::text AS dirty, materialized_input_revision::text AS done
      FROM topology_site_state WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid`), 'demo site state');
    if (state && state.dirty === state.done) return;
    await retrying('reconcile', () => system(() => reconcileTopologySite(scope), 'demo reconcile'));
  }
  throw new Error('topology publication did not converge');
}

async function summary(scope: Scope) {
  const [row] = await system(() => db.execute<Record<string, string>>(sql`SELECT
    (SELECT count(*) FROM topology_nodes WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND lifecycle='active' AND alias_target_id IS NULL AND deleted_at IS NULL)::text AS nodes,
    (SELECT string_agg(kind||'='||c, ' ') FROM (SELECT kind, count(*) c FROM topology_nodes WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid
      AND lifecycle='active' AND alias_target_id IS NULL AND deleted_at IS NULL GROUP BY kind ORDER BY kind) k) AS kinds,
    (SELECT string_agg(lifecycle||'='||c, ' ') FROM (SELECT lifecycle, count(*) c FROM topology_relationships WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid
      AND deleted_at IS NULL GROUP BY lifecycle ORDER BY lifecycle) r) AS relationships,
    (SELECT count(*) FROM topology_nodes n WHERE n.org_id=${scope.orgId}::uuid AND n.site_id=${scope.siteId}::uuid AND n.kind IN ('network','gateway') AND n.lifecycle='active'
      AND n.alias_target_id IS NULL AND NOT EXISTS (SELECT 1 FROM topology_relationships r WHERE r.org_id=n.org_id AND r.site_id=n.site_id AND r.lifecycle='active'
        AND r.deleted_at IS NULL AND (r.source_node_id=n.id OR r.target_node_id=n.id)))::text AS orphans,
    (SELECT count(*) FROM topology_node_positions p JOIN topology_layouts l ON l.id=p.layout_id WHERE p.org_id=${scope.orgId}::uuid AND p.site_id=${scope.siteId}::uuid
      AND p.deleted_at IS NULL AND p.pinned AND p.position_source='legacy')::text AS legacy_pins,
    (SELECT revision::text FROM topology_layouts WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND view='overview' LIMIT 1) AS layout_revision`), 'demo summary');
  log(`graph: ${row!.nodes} active nodes (${row!.kinds}); relationships ${row!.relationships}; ${row!.orphans} orphan network/gateway nodes; `
    + `${row!.legacy_pins} legacy pins (layout revision ${row!.layout_revision})`);
}

async function seed() {
  const owner = await partnerOwner();
  await resetDemo(owner);
  const now = Date.now();
  const devices = demoDevices();
  const assets = demoAssets(devices);
  const { orgId, siteId, deviceIds } = await seedInventory(owner.partnerId, devices, assets, now);
  const scope = { orgId, siteId };
  log(`inventory: org ${orgId}, site ${siteId}, ${devices.length} devices, ${assets.length} discovered assets`);
  await enableTopology(scope);
  // Device nodes must be published before their own network context projects.
  await publishUntilClean(scope);
  for (const [index, d] of devices.entries()) if (d.capture) await reportFull(scope, deviceIds.get(d.key)!, d, index + 1, devices, assets, '1');
  await publishUntilClean(scope);
  // The retention worker's pass: support last confirmed > 7 days ago is archived.
  const aging = await retrying('retention', () => system(() => expireTopologyEvidence(scope, new Date()), 'demo retention'));
  log(`retention pass: archived ${aging.archived} support rows`);
  await publishUntilClean(scope);
  await summary(scope);
  return scope;
}

// -------------------------------------------------------------- keep fresh ---

async function keepFresh(scope: Scope) {
  const devices = demoDevices();
  const assets = demoAssets(devices);
  const onlineHosts = devices.filter(d => d.status === 'online').map(d => d.hostname);
  log(`keep-fresh: every ${INTERVAL_SECONDS}s re-heartbeat ${onlineHosts.length} online agents (Ctrl-C to stop)`);
  const tick = async () => {
    const rows = await system(() => db.execute<DeviceRow>(sql`UPDATE devices SET last_seen_at=now(), status='online', updated_at=now()
      WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND hostname IN (${sql.join(onlineHosts.map(h => sql`${h}`), sql`,`)})
      RETURNING id, hostname, status`), 'demo last_seen');
    let confirmed = 0;
    for (const row of rows) {
      const index = devices.findIndex(d => d.hostname === row.hostname);
      const d = devices[index]!;
      if (d.capture?.mode !== 'fresh') continue; // stalled collectors stay stale on purpose
      const [root] = await system(() => db.execute<{ producer_epoch: string; accepted_sequence: string; base_snapshot_id: string | null; content_digest: string | null }>(sql`
        SELECT producer_epoch, accepted_sequence::text AS accepted_sequence, base_snapshot_id, content_digest FROM topology_collection_sources
        WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND producer_id=${row.id}::uuid AND producer_kind='agent'
          AND protocol='envelope' AND context_key='root' AND address_family='any'`), 'demo root source');
      const sequence = (BigInt(root?.accepted_sequence ?? '0') + 1n).toString();
      const { receipt } = root?.base_snapshot_id && root.content_digest ? await heartbeat(scope, row.id, { networkContextV1: {
        version: 1, reportKind: 'unchanged', producerEpoch: root.producer_epoch, sequence, snapshotId: randomUUID(), baseSnapshotId: root.base_snapshot_id,
        capturedAt: new Date().toISOString(), captureAgeAtSendMs: 0, expectedIntervalSeconds: 300, contentDigest: root.content_digest,
      } }) : { receipt: undefined };
      if (receipt?.accepted) { confirmed++; continue; }
      // As the agent does on full_snapshot_required: resend the full capture.
      await reportFull(scope, row.id, d, index + 1, devices, assets, sequence);
      confirmed++;
    }
    log(`${new Date().toISOString()} heartbeat: ${rows.length} online, ${confirmed} network contexts confirmed`);
  };
  for (;;) {
    try { await tick(); } catch (error) { console.error('[seed-topology-demo] keep-fresh tick failed:', error); }
    await new Promise(resolve => setTimeout(resolve, INTERVAL_SECONDS * 1000));
  }
}

async function main() {
  registerTopologyPhysicalAuthorities();
  let scope: Scope | null = null;
  if (SEED) scope = await seed();
  else {
    const owner = await partnerOwner();
    scope = await findDemo(owner.partnerId);
    if (!scope?.siteId) throw new Error('No demo site yet; run without --keep-fresh-only first.');
  }
  log(`done. Open /discovery#topology/site/${scope.siteId} as a user of partner ${PARTNER_EMAIL}.`);
  if (KEEP_FRESH) await keepFresh(scope);
  process.exit(0);
}

main().catch(error => { console.error('[seed-topology-demo] failed:', error); process.exit(1); });
