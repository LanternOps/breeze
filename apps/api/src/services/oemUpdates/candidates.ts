/**
 * Which devices a vendor update run is due for on this tick (#11065, spec 4.2).
 *
 * Walks the fleet in pages, narrowest test first, because this runs every 10
 * minutes at 10,000+ agents: the flag, then whether any active policy arms
 * anything, then a device query scoped to the orgs and partners those policies can
 * reach, then the tests that need no link, and only then the link and the calendar.
 * The per-device maintenance lookup is last, and only for a device otherwise due.
 *
 * The gates are read here as well as at the seam so that a closed lane or an old
 * agent cannot use up the per-tick cap and starve a lane that is open. The seam
 * stays the authority: it checks all of them again at send time.
 *
 * Reads run in short system contexts, one per page, so a tick never pins a pooled
 * connection across the fleet (#1105).
 */
import { and, eq, gt, inArray, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  agentSupportsOemUpdates,
  canonicalizeTimezone,
  hasArmedCategory,
  OEM_CATEGORIES,
  OEM_LANES,
  resolveEffectiveTimezone,
  type OemCategory,
  type OemLane,
  type OemOutcome,
} from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import {
  configPolicyEffectiveFeatureLinks,
  configurationPolicies,
  deviceCommands,
  deviceHardware,
  deviceOemUpdateStatus,
  devices,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { checkDeviceMaintenanceWindow, partnerTimezoneFrom } from '../featureConfigResolver';
import { envInt } from '../../utils/envInt';
import { captureException } from '../sentry';
import { notParkedDeviceCondition } from '../unassignedPool/selectorPredicate';
import { normalizeTimezone } from '../zonedTime';
import { resolveApplicability, stillNotSupported } from './applicability';
import { FINISHED_OUTCOMES } from './displayState';
import { laneDisabledByKillSwitch, oemUpdatesEnabled, oemUpdatesFlagOn } from './flags';
import {
  computeOccurrence,
  notAfterFor,
  OEM_MAX_ATTEMPTS_PER_OCCURRENCE,
  stableOffsetMinutes,
  type OemOccurrence,
} from './occurrence';
import { hasSendableCategory } from './policySide';
import { resolveOemUpdatesLinksForDevices, type ResolvedOemUpdatesLink } from './resolver';
import { getLaneManifest, isLaneOpen, SHIPPED_OEM_LANES } from './toolManifest';

const MINUTE_MS = 60_000;
const PAGE_SIZE = 500;
const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set(['pending', 'sent']);
const DEFAULT_MAX_DISPATCH_PER_TICK = 200;

/** Across a whole fleet in one window this is 1,200 an hour. A device left over retries next tick. */
export function maxDispatchPerTick(): number {
  // envInt truncates '1.5' to 1; a cap must be a whole number, so a fraction falls back to the default.
  if (/[.]/.test(process.env.OEM_UPDATES_MAX_DISPATCH_PER_TICK ?? '')) return DEFAULT_MAX_DISPATCH_PER_TICK;
  const configured = envInt('OEM_UPDATES_MAX_DISPATCH_PER_TICK', DEFAULT_MAX_DISPATCH_PER_TICK);
  return configured > 0 ? configured : DEFAULT_MAX_DISPATCH_PER_TICK;
}

/** The status row's fields a decision reads. All absent for a device that has never run. */
export type ScheduledRunStatus = {
  occurrenceKey?: string | null;
  attempts?: number | null;
  lastOutcome?: OemOutcome | null;
  /** The trigger of the run `lastOutcome` came from. Only a scheduled run finishes an occurrence. */
  lastTrigger?: string | null;
  lastAttemptAt?: Date | null;
  rebootPendingSince?: Date | null;
};

export type ScheduledRunRefusal =
  | 'no_link'
  | 'link_invalid'
  | 'link_disabled'
  | 'vendor_disabled'
  | 'no_open_categories'
  | 'not_in_window'
  | 'past_not_after'
  | 'offset_not_reached'
  | 'finished'
  | 'attempts_exhausted'
  | 'attempted_tonight'
  | 'reboot_pending';

export type ScheduledRunPlan = {
  due: true;
  occurrenceKey: string;
  windowStart: Date;
  windowEnd: Date;
  /** The agent refuses to start after this, and the row stops being deliverable. */
  notAfter: Date;
  requestedCategories: OemCategory[];
  blockedUpdateIds: string[];
  /** False skips bios and firmware, at the seam: they need a reboot Breeze controls. */
  rebootControlled: boolean;
};

export type ScheduledRunDecision = ScheduledRunPlan | { due: false; reason: ScheduledRunRefusal };

function refused(reason: ScheduledRunRefusal): ScheduledRunDecision {
  return { due: false, reason };
}

/**
 * Whether a link sends this device a run right now, and with what. Pure, given the
 * gates. The tick calls it twice: on selection, and again on a freshly resolved link
 * immediately before the send, so a policy turned off in between sends nothing.
 */
export function decideScheduledRun(
  input: {
    deviceId: string;
    lane: OemLane;
    status: ScheduledRunStatus;
    link: ResolvedOemUpdatesLink | null;
    timezone: string;
    now: Date;
  },
  occurrenceOf: (link: ResolvedOemUpdatesLink) => OemOccurrence = (link) =>
    computeOccurrence(
      { ...link.settings.schedule, catchUpNights: link.settings.catchUpNights },
      input.timezone,
      input.now,
    ),
): ScheduledRunDecision {
  const { deviceId, lane, status, link, now } = input;
  if (!link) return refused('no_link');
  if (link.invalidStoredSettings) return refused('link_invalid');
  const { settings } = link;
  if (!settings.enabled) return refused('link_disabled');
  const vendor = settings.vendors[lane];
  if (!vendor?.enabled) return refused('vendor_disabled');

  const requestedCategories = OEM_CATEGORIES.filter((category) => vendor.categories[category] === true);
  const rebootControlled = settings.reboot === 'overnight';
  if (!hasSendableCategory(settings, lane, deviceId)) return refused('no_open_categories');

  const occurrence = occurrenceOf(link);
  if (!occurrence.inWindow) return refused('not_in_window');
  const notAfter = notAfterFor(occurrence.windowEnd, occurrence.windowMinutes);
  if (now.getTime() >= notAfter.getTime()) return refused('past_not_after');
  const startsAt = occurrence.windowStart.getTime()
    + stableOffsetMinutes(deviceId, occurrence.windowMinutes) * MINUTE_MS;
  if (now.getTime() < startsAt) return refused('offset_not_reached');

  if (status.occurrenceKey === occurrence.occurrenceKey) {
    // A Run Now success does not count: it may have left out bios and firmware, and
    // the policy's run would then wait a month for them.
    if (status.lastTrigger === 'scheduled' && status.lastOutcome && FINISHED_OUTCOMES.has(status.lastOutcome)) {
      return refused('finished');
    }
    if ((status.attempts ?? 0) >= OEM_MAX_ATTEMPTS_PER_OCCURRENCE) return refused('attempts_exhausted');
  }
  // One run a night: a failure retries on the next night (spec 4.2), not the next tick.
  if (status.lastAttemptAt && status.lastAttemptAt.getTime() >= occurrence.windowStart.getTime()) {
    return refused('attempted_tonight');
  }
  // Overnight has a restart of its own coming, and the run follows it. Under `never`
  // nothing else will ask, and a clean answer from the tool is what clears the wait.
  if (rebootControlled && status.rebootPendingSince) return refused('reboot_pending');

  return {
    due: true,
    occurrenceKey: occurrence.occurrenceKey,
    windowStart: occurrence.windowStart,
    windowEnd: occurrence.windowEnd,
    notAfter,
    requestedCategories,
    blockedUpdateIds: vendor.blockedUpdateIds,
    rebootControlled,
  };
}

/** What the timezone chain needs from a device's site, org and partner. */
export type DeviceTimezoneFields = {
  siteTimezone: string | null;
  orgSettings: unknown;
  partnerTimezone: string | null;
  partnerSettings: unknown;
};

/**
 * The zone a device's windows open in, from columns a page has already read: site,
 * then org, then partner, then UTC, as `resolveDeviceTimezone`, with one difference.
 *
 * A site's `UTC` counts as unset here. `sites.timezone` is NOT NULL with a `UTC`
 * default, and sites are created with it, so the plain chain stops at the site for
 * almost every device and an org or partner zone is never reached: a default 01:00
 * window would open at 17:00 on the US west coast and at noon in Sydney, for BIOS
 * flashes and reboots. The partner column already treats its `UTC` default the same
 * way (`partnerTimezoneFrom`). A site that really is on UTC still gets UTC when its
 * org and partner say nothing else.
 */
export function effectiveTimezoneFrom(row: DeviceTimezoneFields): string {
  const orgTz = row.orgSettings && typeof row.orgSettings === 'object'
    ? (row.orgSettings as Record<string, unknown>).timezone
    : null;
  const siteTz = canonicalizeTimezone(row.siteTimezone);
  return normalizeTimezone(resolveEffectiveTimezone({
    siteTz: siteTz === 'UTC' ? null : siteTz,
    orgTz: typeof orgTz === 'string' ? orgTz : null,
    partnerTz: partnerTimezoneFrom(row.partnerTimezone, row.partnerSettings),
  }));
}

export type CandidateRow = DeviceTimezoneFields & ScheduledRunStatus & {
  deviceId: string;
  orgId: string;
  partnerId: string;
  osType: string;
  isVirtual: boolean;
  deviceRole: string;
  agentVersion: string | null;
  manufacturer: string | null;
  model: string | null;
  applicability: string | null;
  notSupportedToolVersion: string | null;
  notSupportedModel: string | null;
  takeoverState: string | null;
  commandStatus: string | null;
};

export type DueDevice = ScheduledRunPlan & {
  deviceId: string;
  /** The org the decision was made under: what `expectedOrgId` carries to the seam. */
  orgId: string;
  lane: OemLane;
  timezone: string;
  status: ScheduledRunStatus;
};

/** The orgs and partners an armed active policy can reach, flag-allowed. Null when none. */
export async function armedScope(): Promise<SQL | null> {
  const rows = await db
    .select({
      orgId: configurationPolicies.orgId,
      partnerId: configurationPolicies.partnerId,
      inlineSettings: configPolicyEffectiveFeatureLinks.inlineSettings,
    })
    .from(configPolicyEffectiveFeatureLinks)
    .innerJoin(configurationPolicies, eq(configurationPolicies.id, configPolicyEffectiveFeatureLinks.configPolicyId))
    .where(and(
      eq(configPolicyEffectiveFeatureLinks.featureType, 'oem_updates'),
      eq(configurationPolicies.status, 'active'),
    ));

  const orgIds = new Set<string>();
  const partnerIds = new Set<string>();
  for (const row of rows) {
    if (!hasArmedCategory(row.inlineSettings)) continue;
    if (row.orgId) orgIds.add(row.orgId);
    else if (row.partnerId && oemUpdatesEnabled(row.partnerId)) partnerIds.add(row.partnerId);
  }
  if (orgIds.size === 0 && partnerIds.size === 0) return null;
  return or(
    ...(orgIds.size > 0 ? [inArray(devices.orgId, [...orgIds])] : []),
    ...(partnerIds.size > 0 ? [inArray(organizations.partnerId, [...partnerIds])] : []),
  )!;
}

async function loadPage(scope: SQL, after: string | null, upTo: string | null): Promise<CandidateRow[]> {
  return db
    .select({
      deviceId: devices.id,
      orgId: devices.orgId,
      partnerId: organizations.partnerId,
      osType: devices.osType,
      isVirtual: devices.isVirtual,
      deviceRole: devices.deviceRole,
      agentVersion: devices.agentVersion,
      manufacturer: deviceHardware.manufacturer,
      model: deviceHardware.model,
      siteTimezone: sites.timezone,
      orgSettings: organizations.settings,
      partnerTimezone: partners.timezone,
      partnerSettings: partners.settings,
      occurrenceKey: deviceOemUpdateStatus.occurrenceKey,
      attempts: deviceOemUpdateStatus.attempts,
      lastOutcome: deviceOemUpdateStatus.lastOutcome,
      lastAttemptAt: deviceOemUpdateStatus.lastAttemptAt,
      rebootPendingSince: deviceOemUpdateStatus.rebootPendingSince,
      applicability: deviceOemUpdateStatus.applicability,
      notSupportedToolVersion: deviceOemUpdateStatus.notSupportedToolVersion,
      notSupportedModel: deviceOemUpdateStatus.notSupportedModel,
      takeoverState: deviceOemUpdateStatus.takeoverState,
      commandStatus: deviceCommands.status,
      lastTrigger: sql<string | null>`${deviceCommands.payload} ->> 'trigger'`,
    })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .leftJoin(sites, eq(sites.id, devices.siteId))
    .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
    .leftJoin(deviceOemUpdateStatus, eq(deviceOemUpdateStatus.deviceId, devices.id))
    // The seam writes every run's id here, Run Now's too, so this one row answers
    // "run in flight" without a scan. The seam checks again under its lock.
    .leftJoin(deviceCommands, eq(deviceCommands.id, deviceOemUpdateStatus.lastCommandId))
    .where(and(
      eq(devices.osType, 'windows'),
      eq(devices.status, 'online'),
      eq(devices.isEphemeral, false),
      eq(devices.isVirtual, false),
      ne(devices.deviceRole, 'server'),
      notParkedDeviceCondition(),
      scope,
      ...(after ? [gt(devices.id, after)] : []),
      ...(upTo ? [lte(devices.id, upTo)] : []),
    ))
    .orderBy(devices.id)
    .limit(PAGE_SIZE) as Promise<CandidateRow[]>;
}

/** The lane, when nothing about the device alone already rules a run out. */
function laneWithoutALink(row: CandidateRow): OemLane | null {
  if (!oemUpdatesEnabled(row.partnerId)) return null;
  if (row.commandStatus && IN_FLIGHT_STATUSES.has(row.commandStatus)) return null;
  // A release on its way would undo the takeover a run makes. The sweep settles it first.
  if (row.takeoverState === 'releasing') return null;

  const applicability = resolveApplicability({
    osType: row.osType,
    isVirtual: row.isVirtual,
    deviceRole: row.deviceRole,
    manufacturer: row.manufacturer,
    model: row.model,
    enabledLanes: OEM_LANES,
    shippedLanes: SHIPPED_OEM_LANES,
  });
  if (applicability.state !== 'applicable') return null;
  const { lane } = applicability;

  if (laneDisabledByKillSwitch(lane)) return null;
  if (!isLaneOpen(lane, { deviceId: row.deviceId })) return null;
  if (!agentSupportsOemUpdates(row.agentVersion)) return null;
  if (stillNotSupported(row, getLaneManifest(lane).tool?.version ?? null, row.model)) return null;
  return lane;
}

/** Fails closed: a lookup that cannot answer sends nothing, and the next tick asks again. */
export async function maintenanceAllowsRun(deviceId: string, orgId: string, now: Date): Promise<boolean> {
  try {
    const maintenance = await withSystemDbAccessContext(() => checkDeviceMaintenanceWindow(deviceId, now));
    return !maintenance.active || !maintenance.suppressPatching;
  } catch (error) {
    console.error(`[OemUpdates] maintenance lookup failed for device ${deviceId}:`, error);
    captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
      worker: 'oemUpdatesWorker',
      org_id: orgId,
    });
    return false;
  }
}

/**
 * Up to `limit` devices due a run now. `startAfter` resumes where the last tick
 * stopped, then wraps round: a device the seam keeps refusing (a partner's trust
 * status, say) takes one turn, not every tick's first slot, so it cannot starve
 * the devices behind it.
 */
export async function selectDueDevices(
  now: Date,
  options: { limit: number; startAfter?: string | null },
): Promise<DueDevice[]> {
  if (!oemUpdatesFlagOn()) return [];
  const scope = await withSystemDbAccessContext(() => armedScope());
  if (!scope) return [];

  const due: DueDevice[] = [];
  // Most devices share a schedule and a zone, and this is the one costly pure step.
  const occurrences = new Map<string, OemOccurrence>();

  const scan = async (from: string | null, upTo: string | null): Promise<void> => {
    let after = from;
    for (;;) {
      const page = await withSystemDbAccessContext(() => loadPage(scope, after, upTo));
      const candidates = page.flatMap((row) => {
        const lane = laneWithoutALink(row);
        return lane ? [{ row, lane }] : [];
      });
      const links = candidates.length > 0
        ? await withSystemDbAccessContext(() => resolveOemUpdatesLinksForDevices(candidates.map(({ row }) => row.deviceId)))
        : new Map<string, ResolvedOemUpdatesLink>();

      for (const { row, lane } of candidates) {
        const link = links.get(row.deviceId) ?? null;
        const timezone = effectiveTimezoneFrom(row);
        const decision = decideScheduledRun(
          { deviceId: row.deviceId, lane, status: row, link, timezone, now },
          (resolved) => {
            const key = `${resolved.linkId}|${timezone}`;
            let occurrence = occurrences.get(key);
            if (!occurrence) {
              occurrence = computeOccurrence(
                { ...resolved.settings.schedule, catchUpNights: resolved.settings.catchUpNights },
                timezone,
                now,
              );
              occurrences.set(key, occurrence);
            }
            return occurrence;
          },
        );
        if (!decision.due) continue;
        if (!await maintenanceAllowsRun(row.deviceId, row.orgId, now)) continue;
        due.push({ ...decision, deviceId: row.deviceId, orgId: row.orgId, lane, timezone, status: row });
        if (due.length >= options.limit) return;
      }

      if (page.length < PAGE_SIZE) return;
      after = page[page.length - 1]!.deviceId;
    }
  };

  const startAfter = options.startAfter ?? null;
  await scan(startAfter, null);
  if (startAfter && due.length < options.limit) await scan(null, startAfter);
  return due;
}
