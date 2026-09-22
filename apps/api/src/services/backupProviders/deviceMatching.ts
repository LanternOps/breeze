import { and, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { backupProviderDevices, deviceNetwork, devices } from '../../db/schema';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import type { ProviderSyncTx } from './persist';

export interface MatchProviderRow {
  id: string;
  orgId: string;
  /** lower(coalesce(computer_name, vendor_device_name)), already normalized. */
  matchName: string | null;
  macAddresses: string[];
}

export interface MatchCandidateDevice {
  deviceId: string;
  /** lower(hostname) or lower(display_name) — a device appears once per distinct name it answers to. */
  matchName: string;
  orgId: string;
  macAddresses: string[];
  /** Already linked to SOME provider row; the partial unique index would reject a second. */
  claimed: boolean;
}

export type DeviceMatchLink = {
  providerDeviceId: string;
  deviceId: string;
  source: 'auto_hostname' | 'auto_mac';
};

function normalize(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * PURE match rules (spec, Device matching section).
 *
 *  1. Candidates are non-decommissioned devices in the row's OWN org whose
 *     hostname or display name equals the row's match name.
 *  2. Exactly one free candidate -> auto_hostname.
 *  3. More than one -> intersect on MAC; exactly one survivor -> auto_mac.
 *  4. Anything else -> unlinked, counted ambiguous.
 *
 * `claimed` devices are excluded from candidacy but still make the row
 * ambiguous: "the machine I would have linked is already taken" is exactly the
 * post-acquisition second-connection case the spec wants surfaced on the
 * connection card, not reported as "no match".
 *
 * Rows are processed in ascending id order so a contested device always goes to
 * the same winner across syncs — a non-deterministic winner would make the link
 * flap and re-raise alerts every poll.
 */
export function resolveDeviceMatches(
  rows: MatchProviderRow[],
  candidates: MatchCandidateDevice[],
): { links: DeviceMatchLink[]; ambiguous: string[] } {
  const byOrgAndName = new Map<string, MatchCandidateDevice[]>();
  for (const candidate of candidates) {
    const key = `${candidate.orgId}::${candidate.matchName}`;
    const bucket = byOrgAndName.get(key);
    if (bucket) {
      if (!bucket.some((c) => c.deviceId === candidate.deviceId)) bucket.push(candidate);
    } else {
      byOrgAndName.set(key, [candidate]);
    }
  }

  const taken = new Set(candidates.filter((c) => c.claimed).map((c) => c.deviceId));
  const links: DeviceMatchLink[] = [];
  const ambiguous: string[] = [];

  for (const row of [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!row.matchName) continue;
    const all = byOrgAndName.get(`${row.orgId}::${row.matchName}`) ?? [];
    if (all.length === 0) continue;

    const free = all.filter((c) => !taken.has(c.deviceId));
    if (free.length === 0) {
      ambiguous.push(row.id);
      continue;
    }
    if (free.length === 1) {
      // The MAC never entered this decision, so the source stays auto_hostname
      // even when the NAME matched several devices.
      taken.add(free[0]!.deviceId);
      links.push({ providerDeviceId: row.id, deviceId: free[0]!.deviceId, source: 'auto_hostname' });
      continue;
    }

    const wanted = new Set(
      row.macAddresses.map((m) => normalize(m)).filter((m): m is string => m !== null),
    );
    const macMatches = wanted.size === 0
      ? []
      : free.filter((c) => c.macAddresses.some((m) => {
        const n = normalize(m);
        return n !== null && wanted.has(n);
      }));
    if (macMatches.length === 1) {
      taken.add(macMatches[0]!.deviceId);
      links.push({ providerDeviceId: row.id, deviceId: macMatches[0]!.deviceId, source: 'auto_mac' });
      continue;
    }
    ambiguous.push(row.id);
  }

  return { links, ambiguous };
}

/** lower(nullif(btrim(coalesce(nullif(btrim(computer_name),''), vendor_device_name)),'')) */
const MATCH_NAME_SQL = sql<string | null>`
  lower(nullif(btrim(coalesce(nullif(btrim(${backupProviderDevices.computerName}), ''),
                              ${backupProviderDevices.vendorDeviceName})), ''))
`;

/**
 * Re-derive every auto link for a connection and report the counters the
 * connection card shows.
 *
 * Four batched statements plus one savepointed write:
 *   1. drop auto links whose device no longer exists / no longer matches;
 *   2. normalise manual rows whose device was hard-deleted (the FK set
 *      breeze_device_id NULL and left device_match_source behind);
 *   3. load the unlinked targets and their candidates, decide in memory;
 *   4. write the links in one UPDATE ... FROM (VALUES ...).
 */
export async function matchProviderDevices(
  tx: ProviderSyncTx,
  connectionId: string,
): Promise<{ linked: number; ambiguous: number }> {
  // 1. Stale auto links. A link survives only while the linked device still
  //    exists in the row's org, is not decommissioned, and still answers to the
  //    row's match name. A rename on either side therefore unlinks within one
  //    poll and re-links in the same pass below.
  await tx.execute(sql`
    UPDATE backup_provider_devices AS p
    SET breeze_device_id = NULL, device_match_source = NULL, updated_at = now()
    WHERE p.connection_id = ${connectionId}::uuid
      AND p.device_match_source IN ('auto_hostname','auto_mac')
      AND (
        p.breeze_device_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM devices d
          WHERE d.id = p.breeze_device_id
            AND d.org_id = p.org_id
            AND d.status <> 'decommissioned'
            AND (
              lower(d.hostname) = lower(nullif(btrim(coalesce(nullif(btrim(p.computer_name), ''), p.vendor_device_name)), ''))
              OR lower(d.display_name) = lower(nullif(btrim(coalesce(nullif(btrim(p.computer_name), ''), p.vendor_device_name)), ''))
            )
        )
      )
  `);

  // 2. Manual links are validated for EXISTENCE only (spec, Device matching
  //    point 3) — a technician's choice is never second-guessed on a rename.
  //    The FK is ON DELETE SET NULL, so a hard-deleted device already cleared
  //    the id; this clears the orphaned source marker so the row reads unlinked.
  await tx
    .update(backupProviderDevices)
    .set({ deviceMatchSource: null, updatedAt: new Date() })
    .where(and(
      eq(backupProviderDevices.connectionId, connectionId),
      eq(backupProviderDevices.deviceMatchSource, 'manual'),
      sql`${backupProviderDevices.breezeDeviceId} IS NULL`,
    ));

  // 3. Targets: backup_manager rows, never manual, currently unlinked.
  const targets = await tx
    .select({
      id: backupProviderDevices.id,
      orgId: backupProviderDevices.orgId,
      matchName: MATCH_NAME_SQL,
      macAddresses: backupProviderDevices.macAddresses,
    })
    .from(backupProviderDevices)
    .where(and(
      eq(backupProviderDevices.connectionId, connectionId),
      eq(backupProviderDevices.accountType, 'backup_manager'),
      sql`${backupProviderDevices.deviceMatchSource} IS DISTINCT FROM 'manual'`,
      sql`${backupProviderDevices.breezeDeviceId} IS NULL`,
    ));

  const named = targets.filter(
    (t): t is typeof t & { matchName: string } => typeof t.matchName === 'string' && t.matchName.length > 0,
  );
  if (named.length === 0) {
    return { linked: await countLinked(tx, connectionId), ambiguous: 0 };
  }

  const orgIds = [...new Set(named.map((t) => t.orgId))];
  const names = [...new Set(named.map((t) => t.matchName))];

  // Candidate devices. `claimed` is a correlated EXISTS over the WHOLE table,
  // not just this connection — the partial unique index on breeze_device_id is
  // global, so a row held by another connection is genuinely unavailable.
  const candidateRows = await tx
    .select({
      deviceId: devices.id,
      orgId: devices.orgId,
      hostname: devices.hostname,
      displayName: devices.displayName,
      claimed: sql<boolean>`EXISTS (
        SELECT 1 FROM backup_provider_devices x WHERE x.breeze_device_id = ${devices.id}
      )`,
    })
    .from(devices)
    .where(and(
      inArray(devices.orgId, orgIds),
      ne(devices.status, 'decommissioned'),
      or(
        inArray(sql<string>`lower(${devices.hostname})`, names),
        inArray(sql<string>`lower(${devices.displayName})`, names),
      ),
    ));

  const macRows = candidateRows.length === 0 ? [] : await tx
    .select({ deviceId: deviceNetwork.deviceId, mac: sql<string>`lower(${deviceNetwork.macAddress})` })
    .from(deviceNetwork)
    .where(and(
      inArray(deviceNetwork.deviceId, candidateRows.map((c) => c.deviceId)),
      isNotNull(deviceNetwork.macAddress),
    ));

  const macsByDevice = new Map<string, string[]>();
  for (const row of macRows) {
    const bucket = macsByDevice.get(row.deviceId);
    if (bucket) bucket.push(row.mac);
    else macsByDevice.set(row.deviceId, [row.mac]);
  }

  const nameSet = new Set(names);
  const candidates: MatchCandidateDevice[] = [];
  for (const row of candidateRows) {
    for (const raw of [row.hostname, row.displayName]) {
      const matchName = normalize(raw);
      if (!matchName || !nameSet.has(matchName)) continue;
      candidates.push({
        deviceId: row.deviceId,
        orgId: row.orgId,
        matchName,
        macAddresses: macsByDevice.get(row.deviceId) ?? [],
        claimed: row.claimed,
      });
    }
  }

  const { links, ambiguous } = resolveDeviceMatches(named, candidates);

  if (links.length > 0) {
    try {
      // SAVEPOINT: drizzle emits one for a nested transaction under the ambient
      // context. A concurrent sync of ANOTHER connection holds a different
      // advisory lock and can take the same device between our candidate read
      // and this write; the resulting 23505 must not poison phase 3.
      await tx.transaction(async (inner) => {
        const values = sql.join(
          links.map((l) => sql`(${l.providerDeviceId}::uuid, ${l.deviceId}::uuid, ${l.source})`),
          sql`, `,
        );
        await inner.execute(sql`
          UPDATE backup_provider_devices AS p
          SET breeze_device_id = v.device_id, device_match_source = v.source, updated_at = now()
          FROM (VALUES ${values}) AS v(provider_device_id, device_id, source)
          WHERE p.id = v.provider_device_id
            AND p.connection_id = ${connectionId}::uuid
            AND p.breeze_device_id IS NULL
            AND p.device_match_source IS DISTINCT FROM 'manual'
        `);
      });
    } catch (error) {
      if (!isPgUniqueViolation(error)) throw error;
      console.warn(
        `[BackupProviderSync] device link batch for connection ${connectionId} lost a `
        + `uniqueness race (${links.length} link(s) skipped); the next sync retries`,
      );
      return {
        linked: await countLinked(tx, connectionId),
        ambiguous: ambiguous.length + links.length,
      };
    }
  }

  return { linked: await countLinked(tx, connectionId), ambiguous: ambiguous.length };
}

async function countLinked(tx: ProviderSyncTx, connectionId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(backupProviderDevices)
    .where(and(
      eq(backupProviderDevices.connectionId, connectionId),
      isNotNull(backupProviderDevices.breezeDeviceId),
    ));
  return row?.n ?? 0;
}
