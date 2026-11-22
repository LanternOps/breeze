import { sql, type SQL } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { NETWORK_DEVICE_RETENTION_DAYS, UNASSIGNED_NETWORK_RETENTION_DAYS } from './constants';

/**
 * Learned networks W01b (#12369): the hourly last-seen refresh and the daily retention (spec §6, §8.1; index E4).
 *
 * The heartbeat never touches a shared row's `last_seen_at` (an office of agents would contend on one row): it
 * stores each device's confirmation time on the device, and this refresh copies it outward, device rows first,
 * then gateways, networks and WAN rows. Each batch is its own system-context transaction; `SKIP LOCKED` keeps a
 * batch from waiting on, or deadlocking with, a heartbeat's apply.
 *
 * Retention is a worker write to `devices` (it clears `network_attachment_digest` for devices that lose a current
 * row, A8), outside the agent path. Never import this module from `ingest.ts` or an agent route.
 */

const BATCH_SIZE = 1_000;
const DAY_MS = 86_400_000;

async function returnedRows(query: SQL): Promise<Array<{ id: string }>> {
  return (await db.execute(query)) as unknown as Array<{ id: string }>;
}

/** Run one batch statement per transaction until a batch comes back short. Returns the rows touched. */
async function inBatches(batch: () => SQL): Promise<number> {
  let total = 0;
  for (;;) {
    const touched = await withSystemDbAccessContext(async () => (await returnedRows(batch())).length);
    total += touched;
    if (touched < BATCH_SIZE) return total;
  }
}

export async function refreshLearnedNetworkLastSeen(
  _now: Date,
): Promise<{ gateways: number; networks: number; devices: number; wan: number }> {
  const devices = await inBatches(() => sql`
    WITH due AS (
      SELECT m.id, d.network_attachments_confirmed_at AS seen
        FROM learned_network_devices m JOIN devices d ON d.id = m.device_id
       WHERE m.is_current AND d.network_attachments_confirmed_at > m.last_seen_at
       ORDER BY m.id LIMIT ${BATCH_SIZE} FOR NO KEY UPDATE OF m SKIP LOCKED)
    UPDATE learned_network_devices m SET last_seen_at = due.seen FROM due WHERE m.id = due.id
    RETURNING m.id`);

  const gateways = await inBatches(() => sql`
    WITH due AS (
      SELECT g.id, src.seen
        FROM learned_network_gateways g
        CROSS JOIN LATERAL (SELECT max(m.last_seen_at) AS seen FROM learned_network_devices m
                             WHERE m.gateway_id = g.id) src
       WHERE src.seen > g.last_seen_at
       ORDER BY g.id LIMIT ${BATCH_SIZE} FOR NO KEY UPDATE OF g SKIP LOCKED)
    UPDATE learned_network_gateways g SET last_seen_at = due.seen FROM due WHERE g.id = due.id
    RETURNING g.id`);

  const networks = await inBatches(() => sql`
    WITH due AS (
      SELECT n.id, src.seen
        FROM learned_networks n
        CROSS JOIN LATERAL (SELECT max(g.last_seen_at) AS seen FROM learned_network_gateways g
                             WHERE g.network_id = n.id) src
       WHERE src.seen > n.last_seen_at
       ORDER BY n.id LIMIT ${BATCH_SIZE} FOR NO KEY UPDATE OF n SKIP LOCKED)
    UPDATE learned_networks n SET last_seen_at = due.seen FROM due WHERE n.id = due.id
    RETURNING n.id`);

  // No per-device WAN is stored (spec non-goal). A WAN row is dated from the confirmations of devices whose
  // current primary row is on its network and whose last trusted client address is that WAN address.
  const wan = await inBatches(() => sql`
    WITH src AS (
      SELECT g.network_id, d.last_seen_ip AS ip, max(d.network_attachments_confirmed_at) AS seen
        FROM learned_network_devices m
        JOIN learned_network_gateways g ON g.id = m.gateway_id
        JOIN devices d ON d.id = m.device_id
       WHERE m.is_current AND m.is_primary AND d.last_seen_ip IS NOT NULL
         AND d.network_attachments_confirmed_at IS NOT NULL
       GROUP BY g.network_id, d.last_seen_ip),
    due AS (
      SELECT w.id, src.seen
        FROM learned_network_wan_addresses w
        JOIN src ON src.network_id = w.network_id AND host(w.address) = src.ip
       WHERE src.seen > w.last_seen_at
       ORDER BY w.id LIMIT ${BATCH_SIZE} FOR NO KEY UPDATE OF w SKIP LOCKED)
    UPDATE learned_network_wan_addresses w SET last_seen_at = due.seen FROM due WHERE w.id = due.id
    RETURNING w.id`);

  const result = { gateways, networks, devices, wan };
  if (devices + gateways + networks + wan > 0) console.log('[learnedNetworks] last-seen refresh', result);
  return result;
}

const uuidList = (ids: readonly string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

/**
 * Daily retention (spec §6). Each batch reads its target ids, clears the digest of devices that lose a current row
 * (devices before membership rows: the heartbeat's lock order), then deletes by id with the predicate re-checked.
 * An assigned, ignored or profile-referenced network is never deleted. `deviceRowsDeleted` counts direct deletes;
 * rows under a deleted network go with it by cascade.
 */
export async function runLearnedNetworkRetention(
  now: Date,
): Promise<{ networksDeleted: number; deviceRowsDeleted: number }> {
  const networkCutoff = new Date(now.getTime() - UNASSIGNED_NETWORK_RETENTION_DAYS * DAY_MS).toISOString();
  const deviceCutoff = new Date(now.getTime() - NETWORK_DEVICE_RETENTION_DAYS * DAY_MS).toISOString();
  const networkDue = sql`n.site_id IS NULL AND n.ignored_at IS NULL AND n.last_seen_at < ${networkCutoff}::timestamptz
    AND NOT EXISTS (SELECT 1 FROM discovery_profiles p WHERE p.network_id = n.id)`;

  let networksDeleted = 0;
  for (;;) {
    const deleted = await withSystemDbAccessContext(async () => {
      const targets = await returnedRows(sql`
        SELECT n.id FROM learned_networks n WHERE ${networkDue} ORDER BY n.id LIMIT ${BATCH_SIZE}`);
      if (targets.length === 0) return { count: 0, read: 0 };
      const ids = targets.map((r) => r.id);
      await db.execute(sql`
        UPDATE devices SET network_attachment_digest = NULL
         WHERE network_attachment_digest IS NOT NULL
           AND id IN (SELECT m.device_id FROM learned_network_devices m
                        JOIN learned_network_gateways g ON g.id = m.gateway_id
                       WHERE m.is_current AND g.network_id IN (${uuidList(ids)}))`);
      const gone = await returnedRows(sql`
        DELETE FROM learned_networks n WHERE n.id IN (${uuidList(ids)}) AND ${networkDue} RETURNING n.id`);
      return { count: gone.length, read: targets.length };
    });
    networksDeleted += deleted.count;
    if (deleted.read < BATCH_SIZE) break;
  }

  let deviceRowsDeleted = 0;
  for (;;) {
    const deleted = await withSystemDbAccessContext(async () => {
      const targets = (await db.execute(sql`
        SELECT id, device_id, is_current FROM learned_network_devices
         WHERE last_seen_at < ${deviceCutoff}::timestamptz ORDER BY id LIMIT ${BATCH_SIZE}`)) as unknown as Array<{
        id: string; device_id: string; is_current: boolean;
      }>;
      if (targets.length === 0) return { count: 0, read: 0 };
      const losing = [...new Set(targets.filter((r) => r.is_current).map((r) => r.device_id))].sort();
      if (losing.length > 0) {
        await db.execute(sql`
          UPDATE devices SET network_attachment_digest = NULL
           WHERE network_attachment_digest IS NOT NULL AND id IN (${uuidList(losing)})`);
      }
      const gone = await returnedRows(sql`
        DELETE FROM learned_network_devices
         WHERE id IN (${uuidList(targets.map((r) => r.id))}) AND last_seen_at < ${deviceCutoff}::timestamptz
        RETURNING id`);
      return { count: gone.length, read: targets.length };
    });
    deviceRowsDeleted += deleted.count;
    if (deleted.read < BATCH_SIZE) break;
  }

  const result = { networksDeleted, deviceRowsDeleted };
  console.log('[learnedNetworks] retention', result);
  return result;
}
