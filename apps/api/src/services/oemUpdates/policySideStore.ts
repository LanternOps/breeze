/**
 * The materialised vendor update policy side, per device (#11242).
 *
 * `device_oem_policy_side` holds what a device's policy contributes to its display
 * state, computed here by the same functions the device section and the overdue sweep
 * call live (`oemOfferedLane`, `pickOemLink`, `oemPolicySide`), plus the instants at
 * which that answer changes on its own (`occurrenceBoundaries`). The fleet view reads
 * it and evaluates the rest of the rule in SQL (`displayStateSql.ts`).
 *
 * Staleness contract. Rows are refreshed:
 *  - for every fleet device on each worker tick, rows already due first;
 *  - for one partner or org within seconds of a write to its vendor updates policy
 *    links or assignments (`policySideRefreshTrigger.ts`);
 *  - in the fleet request itself, for a bounded number of devices it found pending.
 * A row is *pending* (not trusted: the fleet view does not join it, refreshes it in the
 * request when it can, and otherwise says how many are pending) when it is missing,
 * its `refresh_after` has passed, or its `gates_fingerprint` differs from this
 * process's: env flags, kill switches and the manifest are fixed per deploy, so a kill
 * switch flipped at deploy is authoritative before the first tick. Device-side changes
 * outside those paths (hardware model, role, site or group membership, zone settings)
 * show within one tick.
 *
 * With the flag off nothing is written (rows already stored stay, unused): the fleet
 * view leaves the policy side out of its query then, and no device can be offered a
 * lane anyway.
 */
import { createHash } from 'node:crypto';
import { and, eq, gt, inArray, isNull, ne, not, or, sql, type SQL } from 'drizzle-orm';
import { OEM_CATEGORIES, OEM_LANES, type OemLane } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  deviceGroupMemberships,
  deviceHardware,
  deviceOemPolicySide,
  devices,
  organizations,
  partners,
  sites,
  type OemPolicyRebootMode,
} from '../../db/schema';
import { captureException } from '../sentry';
import { UNASSIGNED_POOL_ORG_TYPE } from '../unassignedPool/orgType';
import { effectiveTimezoneFrom, type DeviceTimezoneFields } from './candidates';
import { laneDisabledByKillSwitch, oemUpdatesFlagOn } from './flags';
import { occurrenceBoundaries, type OemOccurrenceBoundaries } from './occurrence';
import { oemOccurrenceMemo, oemOfferedLane, oemPolicySide, type OemDeviceFacts } from './policySide';
import { loadOemLinkCandidates, pickOemLink, type OemLinkCandidate, type ResolvedOemUpdatesLink } from './resolver';
import { getLaneManifest, SHIPPED_OEM_LANES } from './toolManifest';

/**
 * Bump when `computeOemPolicySideRow` changes what it stores for the same inputs: it is
 * part of the fingerprint, so every row computed by older code reads as pending.
 */
const OEM_POLICY_SIDE_VERSION = 1;

const PAGE_SIZE = 500;

export type OemPolicySideRow = {
  deviceId: string;
  orgId: string;
  offeredLane: OemLane | null;
  gatesFingerprint: string;
  linkId: string | null;
  linkEnabled: boolean;
  rebootMode: OemPolicyRebootMode | null;
  occurrenceKey: string | null;
  lastNightStart: Date | null;
  pastLastNightAt: Date | null;
  refreshAfter: Date | null;
  managedSince: Date | null;
};

/** What one device's row is computed from: the facts the live rule reads, with its zone chain. */
export type OemPolicySideFacts = Pick<
  OemDeviceFacts,
  'deviceId' | 'partnerId' | 'osType' | 'isVirtual' | 'deviceRole' | 'enrolledAt' | 'manufacturer' | 'model'
> & DeviceTimezoneFields & {
  orgId: string;
  siteId: string;
  groupIds: readonly string[];
};

export type OemPolicySideScope = { partnerId: string } | { orgId: string } | { deviceIds: readonly string[] };

/**
 * Which devices the fleet view lists, and so which ones need a row.
 *
 * The parked check is `notParkedDeviceCondition`'s rule written as `NOT IN` over the
 * holding orgs, which Postgres can run once as a hashed subplan (the 10,000-device
 * fleet test's plans do): the correlated `NOT EXISTS` form re-reads `organizations`,
 * and re-evaluates its RLS, for every device, about a quarter of a 10,000-device count
 * under a partner context when measured for #11242. Same answer: `organizations.id`
 * and `devices.org_id` are NOT NULL, and a caller who can read a device can read its org.
 */
export function oemFleetDeviceCondition(): SQL {
  return and(
    // Quick Support devices sit in an org the caller can reach; nothing else drops them.
    eq(devices.isEphemeral, false),
    sql`${devices.orgId} NOT IN (SELECT holding_org.id FROM organizations holding_org WHERE holding_org.type = ${UNASSIGNED_POOL_ORG_TYPE})`,
    ne(devices.status, 'decommissioned'),
  )!;
}

function csv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

let fingerprintMemo: { key: string; value: string } | null = null;

/**
 * Everything outside the database that can change a device's policy side, hashed:
 * the master flag, the partner allowlist, the kill switches, the lab override, and
 * the manifest's gates and shipped lanes. The canonical form is rebuilt on each call
 * (it is small); the hash is recomputed only when that form changes.
 */
export function oemGatesFingerprint(): string {
  const canonical = JSON.stringify({
    version: OEM_POLICY_SIDE_VERSION,
    flag: oemUpdatesFlagOn(),
    allowlist: csv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST'),
    killed: OEM_LANES.filter((lane) => laneDisabledByKillSwitch(lane)),
    // isLabDevice is inert in production, so the list is too.
    lab: process.env.NODE_ENV === 'production' ? [] : csv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS'),
    shipped: [...SHIPPED_OEM_LANES],
    manifest: OEM_LANES.map((lane) => {
      const manifest = getLaneManifest(lane);
      return [lane, manifest.laneGate, OEM_CATEGORIES.map((category) => manifest.categoryGates[category]), [...manifest.codeBlocks].sort()];
    }),
  });
  if (fingerprintMemo?.key !== canonical) {
    fingerprintMemo = { key: canonical, value: createHash('sha256').update(canonical).digest('hex') };
  }
  return fingerprintMemo.value;
}

/** One refresh's shared work: most devices share a link and a zone. */
export function oemPolicySideMemo(now: Date) {
  const boundaries = new Map<string, OemOccurrenceBoundaries>();
  return {
    now,
    fingerprint: oemGatesFingerprint(),
    occurrenceOf: oemOccurrenceMemo(now),
    boundariesOf(link: ResolvedOemUpdatesLink, timezone: string): OemOccurrenceBoundaries {
      const key = `${link.linkId}|${timezone}`;
      let found = boundaries.get(key);
      if (!found) {
        found = occurrenceBoundaries({ ...link.settings.schedule, catchUpNights: link.settings.catchUpNights }, timezone, now);
        boundaries.set(key, found);
      }
      return found;
    },
    boundariesComputed: () => boundaries.size,
  };
}
export type OemPolicySideMemo = ReturnType<typeof oemPolicySideMemo>;

/** Always a row: `offeredLane` null and nothing else set when no lane reaches the device. */
export function computeOemPolicySideRow(
  facts: OemPolicySideFacts,
  candidates: readonly OemLinkCandidate[],
  now: Date,
  memo: OemPolicySideMemo,
): OemPolicySideRow {
  const offeredLane = oemOfferedLane(facts);
  const link = offeredLane && candidates.length > 0
    ? pickOemLink(
        candidates,
        { id: facts.deviceId, orgId: facts.orgId, siteId: facts.siteId, deviceRole: facts.deviceRole, osType: facts.osType },
        facts.partnerId,
        facts.groupIds,
      )
    : null;
  const timezone = effectiveTimezoneFrom(facts);
  const side = oemPolicySide({
    deviceId: facts.deviceId,
    lane: offeredLane,
    link,
    timezone,
    now,
    enrolledAt: facts.enrolledAt,
    occurrenceOf: memo.occurrenceOf,
  });
  const bounds = side.linkEnabled && link ? memo.boundariesOf(link, timezone) : null;
  return {
    deviceId: facts.deviceId,
    orgId: facts.orgId,
    offeredLane,
    gatesFingerprint: memo.fingerprint,
    linkId: link?.linkId ?? null,
    linkEnabled: side.linkEnabled,
    rebootMode: side.rebootMode ?? null,
    occurrenceKey: bounds?.occurrenceKey ?? null,
    lastNightStart: bounds?.lastNightStart ?? null,
    pastLastNightAt: bounds?.pastLastNightAt ?? null,
    refreshAfter: bounds?.refreshAfter ?? null,
    managedSince: side.linkEnabled ? side.managedSince ?? null : null,
  };
}

/** A stored row the fleet view may use at `now`: computed under these gates, and not past its rollover. */
export function oemPolicySideTrustedCondition(now: Date, fingerprint: string): SQL {
  return and(
    eq(deviceOemPolicySide.gatesFingerprint, fingerprint),
    or(isNull(deviceOemPolicySide.refreshAfter), gt(deviceOemPolicySide.refreshAfter, now)),
  )!;
}

/** Over a LEFT JOIN of the table: a device with no row, or a row that is not trusted. */
export function oemPolicySidePendingCondition(now: Date, fingerprint: string): SQL {
  return or(isNull(deviceOemPolicySide.deviceId), not(oemPolicySideTrustedCondition(now, fingerprint)))!;
}

function scopeCondition(scope: OemPolicySideScope | undefined): SQL | undefined {
  if (!scope) return undefined;
  if ('deviceIds' in scope) return scope.deviceIds.length > 0 ? inArray(devices.id, [...scope.deviceIds]) : sql`false`;
  if ('orgId' in scope) return eq(devices.orgId, scope.orgId);
  return eq(organizations.partnerId, scope.partnerId);
}

type PageRow = Omit<OemPolicySideFacts, 'groupIds' | 'orgSettings' | 'partnerSettings'> & {
  orgTimezone: string | null;
  partnerSettingsTimezone: string | null;
};

function loadPage(where: SQL, after: string | null): Promise<PageRow[]> {
  return db
    .select({
      deviceId: devices.id,
      orgId: devices.orgId,
      siteId: devices.siteId,
      partnerId: organizations.partnerId,
      osType: devices.osType,
      isVirtual: devices.isVirtual,
      deviceRole: devices.deviceRole,
      enrolledAt: devices.enrolledAt,
      manufacturer: deviceHardware.manufacturer,
      model: deviceHardware.model,
      siteTimezone: sites.timezone,
      orgTimezone: sql<string | null>`${organizations.settings} ->> 'timezone'`,
      partnerTimezone: partners.timezone,
      partnerSettingsTimezone: sql<string | null>`${partners.settings} ->> 'timezone'`,
    })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .leftJoin(sites, eq(sites.id, devices.siteId))
    .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
    .leftJoin(deviceOemPolicySide, eq(deviceOemPolicySide.deviceId, devices.id))
    .where(and(where, after ? gt(devices.id, after) : undefined))
    .orderBy(devices.id)
    .limit(PAGE_SIZE) as Promise<PageRow[]>;
}

async function groupsByDevice(deviceIds: string[], needed: boolean): Promise<Map<string, string[]>> {
  const groups = new Map<string, string[]>();
  if (!needed || deviceIds.length === 0) return groups;
  const rows = await db
    .select({ deviceId: deviceGroupMemberships.deviceId, groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(inArray(deviceGroupMemberships.deviceId, deviceIds));
  for (const row of rows) {
    const list = groups.get(row.deviceId) ?? [];
    list.push(row.groupId);
    groups.set(row.deviceId, list);
  }
  return groups;
}

/** Every column the refresh writes, `computed_at` aside: a row equal on all of them is left alone. */
const COMPARED = [
  'orgId',
  'offeredLane',
  'gatesFingerprint',
  'linkId',
  'linkEnabled',
  'rebootMode',
  'occurrenceKey',
  'lastNightStart',
  'pastLastNightAt',
  'refreshAfter',
  'managedSince',
] as const;

const excluded = (key: (typeof COMPARED)[number] | 'computedAt'): SQL => sql.raw(`excluded."${deviceOemPolicySide[key].name}"`);

async function upsertRows(rows: OemPolicySideRow[], now: Date): Promise<number> {
  if (rows.length === 0) return 0;
  const written = await db
    .insert(deviceOemPolicySide)
    .values(rows.map((row) => ({ ...row, computedAt: now })))
    .onConflictDoUpdate({
      target: deviceOemPolicySide.deviceId,
      set: Object.fromEntries([...COMPARED, 'computedAt' as const].map((key) => [key, excluded(key)])),
      // An unchanged row is not rewritten: a tick over a quiet fleet writes nothing.
      setWhere: sql`(${sql.join(COMPARED.map((key) => deviceOemPolicySide[key]), sql`, `)})
        IS DISTINCT FROM (${sql.join(COMPARED.map((key) => excluded(key)), sql`, `)})`,
    })
    .returning({ deviceId: deviceOemPolicySide.deviceId });
  return written.length;
}

export type OemPolicySideRefreshResult = { upserted: number; pages: number; failedPages: number };

/** Who asked for a refresh, for the error report. */
export type OemPolicySideRefreshSource = 'tick' | 'policy-write' | 'fleet-request';

/**
 * Recomputes and stores the policy side for the scope's fleet devices, in keyset pages
 * of 500, each page in its own short system context (#1105): the zone chain and
 * partner-wide links must resolve the way the worker resolves them, which an org-scoped
 * request context cannot read. Safe to call from a request: it leaves the request's
 * context first, and `deviceIds` never widens beyond the ids passed.
 *
 * `dueOnly` takes just the pending rows (missing, past `refresh_after`, or another
 * fingerprint). The links are re-read per page, so a policy edited during a long run
 * reaches every page written after it.
 *
 * A page that fails after it was read is skipped and the run goes on; a page that
 * cannot be read ends the run, having no cursor to move past it. Either way the
 * result counts it in `failedPages`, the first failure of the run is reported (one
 * event per run, not per page, so a database fault cannot burst), and the next tick
 * computes what was missed.
 */
export async function refreshOemPolicySide(opts: {
  now: Date;
  scope?: OemPolicySideScope;
  dueOnly?: boolean;
  source?: OemPolicySideRefreshSource;
}): Promise<OemPolicySideRefreshResult> {
  const result: OemPolicySideRefreshResult = { upserted: 0, pages: 0, failedPages: 0 };
  if (!oemUpdatesFlagOn()) return result;

  const memo = oemPolicySideMemo(opts.now);
  const where = and(
    oemFleetDeviceCondition(),
    scopeCondition(opts.scope),
    opts.dueOnly ? oemPolicySidePendingCondition(opts.now, memo.fingerprint) : undefined,
  )!;

  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    let pageLength = 0;
    let lastId: string | null = null;
    try {
      await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
        const page = await loadPage(where, cursor);
        pageLength = page.length;
        lastId = page[page.length - 1]?.deviceId ?? null;
        if (page.length === 0) return;
        const candidates = await loadOemLinkCandidates();
        const groups = await groupsByDevice(
          page.map((row) => row.deviceId),
          candidates.some((candidate) => candidate.assignmentLevel === 'device_group'),
        );
        const rows = page.map(({ orgTimezone, partnerSettingsTimezone, ...row }) => computeOemPolicySideRow(
          {
            ...row,
            orgSettings: { timezone: orgTimezone },
            partnerSettings: { timezone: partnerSettingsTimezone },
            groupIds: groups.get(row.deviceId) ?? [],
          },
          candidates,
          opts.now,
          memo,
        ));
        result.upserted += await upsertRows(rows, opts.now);
      }));
    } catch (error) {
      result.failedPages += 1;
      const scopeKind = !opts.scope ? 'fleet' : 'deviceIds' in opts.scope ? 'devices' : 'orgId' in opts.scope ? 'org' : 'partner';
      console.error(`[OemUpdates] policy side refresh (${opts.source ?? 'tick'}, ${scopeKind}): a page failed`, error);
      if (result.failedPages === 1) {
        captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
          worker: 'oemUpdatesWorker',
          stage: 'policy side',
          source: opts.source ?? 'tick',
          scope: scopeKind,
          dueOnly: String(opts.dueOnly === true),
        }, { fingerprint: ['oem-policy-side-refresh-page'] });
      }
      // Without the page's ids there is no cursor to move past it.
      if (lastId === null) return result;
    }
    result.pages += 1;
    if (pageLength < PAGE_SIZE || lastId === null) return result;
    after = lastId;
  }
}
