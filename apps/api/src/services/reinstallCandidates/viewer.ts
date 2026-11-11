/**
 * The reattach dialog's candidates read (#8318 wave 2-2, spec
 * docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
 * §7.3 "No leaks", §8 "Confirmation", §9).
 *
 * For one SOURCE device: the ranked targets, each with its evidence and the
 * side-by-side comparison fields, plus the two values the `device_reattach`
 * step-up binds (the target's agent id and install incarnation). The ranking
 * is the detection's own (`readRankedReinstallCandidates`): nothing re-ranks.
 *
 * Who sees what:
 *  - the SOURCE itself must be visible to the viewer, or the answer is a 404:
 *      - a parked source (the holding org, which no user's accessible orgs
 *        hold) only to holding-area viewers: full partner admins of its
 *        partner (§9; wave H adds technicians when the partner turns on
 *        technician triage);
 *      - a source in a real org to a viewer with that org, its site and (for a
 *        device-bound AI run) the device itself;
 *  - a CANDIDATE is listed only to a partner user whose accessible orgs hold
 *    the candidate's org and whose site ceiling holds its site; the
 *    accessible orgs are the live reachable set RLS gives the user;
 *  - everyone else learns only `reviewPending: true`: that a possible
 *    reinstall awaits partner review. Never a hostname, an id, an org or a
 *    count of what they cannot see.
 *
 * Reads run in one short system context of their own (the search is
 * partner-wide and reads the ledger), so the route holds no request
 * transaction (middleware/selfManagedDbContextRoutes.ts).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceHardware, deviceReattachIntents, devices, organizations, sites } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies } from '../partnerWideAccess';
import { OPEN_REATTACH_INTENT_STATES } from '../deviceReattach/protocol';
import { isUnassignedPoolOrgType } from '../unassignedPool/orgType';
import { readRankedReinstallCandidates } from './index';
import type { RankedCandidate } from './ranking';

export type CandidatesViewer = Pick<
  AuthContext,
  'scope' | 'partnerId' | 'partnerOrgAccess' | 'canAccessOrg' | 'allowedSiteIds' | 'canAccessSite' | 'allowedDeviceIds'
>;

/** The evidence wording the dialog shows beside every candidate (§8 "Confirmation"). */
export const HINT_EVIDENCE_NOTICE = 'Hardware identifiers reported by the device. Not verified.';

/** The comparison fields of one side, all reported by the device itself. */
export interface ReattachComparisonFields {
  hostname: string;
  displayName: string | null;
  osType: string;
  osVersion: string;
  agentVersion: string | null;
  status: string;
  enrolledAt: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  decommissionedAt: string | null;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  systemUuid: string | null;
}

export interface ReattachCandidateView extends ReattachComparisonFields {
  deviceId: string;
  orgId: string;
  orgName: string | null;
  siteId: string;
  siteName: string | null;
  /** What matched, strongest first: `system_uuid` > `serial` > `hostname`. */
  evidence: RankedCandidate['evidence'];
  /** The flag reason the evidence records (`hardware` | `hostname`). */
  reason: RankedCandidate['reason'];
  /** The §4.3 evidence level a reattach onto this candidate is requested with. */
  evidenceLevel: 'hint';
  /** The candidate the source's `possible_replacement_of_device_id` names. */
  flagged: boolean;
  /** The two installs report different operating systems: the request needs `acknowledgeOsChange`. */
  osChanged: boolean;
  /** The record is removed: the request needs `restoreDecommissioned`. */
  requiresRestore: boolean;
  /** The values the `device_reattach` step-up binds, as they are now. */
  stepUpBinding: { targetAgentId: string; targetIncarnation: number };
}

export interface ReinstallCandidatesView {
  source: ReattachComparisonFields & {
    deviceId: string;
    parked: boolean;
    /** The source agent speaks the rebind protocol; without it every request is refused (§8). */
    rebindSupported: boolean;
  };
  candidates: ReattachCandidateView[];
  /** A possible reinstall exists that this viewer is not shown: it awaits partner review. */
  reviewPending: boolean;
  /** The source's open reattach, when its target is in an org this viewer reaches. */
  openIntent: { intentId: string; state: string; targetDeviceId: string; expiresAt: string } | null;
  evidenceNotice: string;
}

function siteVisible(viewer: CandidatesViewer, siteId: string | null): boolean {
  if (viewer.canAccessSite) return viewer.canAccessSite(siteId);
  return !viewer.allowedSiteIds || (siteId !== null && viewer.allowedSiteIds.includes(siteId));
}

function deviceVisible(viewer: CandidatesViewer, deviceId: string): boolean {
  return !viewer.allowedDeviceIds || viewer.allowedDeviceIds.includes(deviceId);
}

/** Whether `viewer` may see the source at all (a 404 otherwise). */
export function canViewReattachSource(
  viewer: CandidatesViewer,
  source: { id: string; orgId: string; siteId: string; orgType: string | null; partnerId: string },
): boolean {
  if (isUnassignedPoolOrgType(source.orgType)) {
    // §9: the holding area is a full-partner-admin surface until wave H.
    return viewer.scope === 'partner'
      && viewer.partnerId === source.partnerId
      && canManagePartnerWidePolicies({ scope: 'partner', partnerOrgAccess: viewer.partnerOrgAccess })
      && deviceVisible(viewer, source.id);
  }
  return viewer.canAccessOrg(source.orgId) && siteVisible(viewer, source.siteId) && deviceVisible(viewer, source.id);
}

/**
 * Whether `viewer` may see a candidate: only the partner reattaches (§8), so
 * only partner users are shown targets, and only in their reachable orgs.
 */
export function canViewReattachCandidate(
  viewer: CandidatesViewer,
  target: { id: string; orgId: string; siteId: string },
): boolean {
  return viewer.scope === 'partner'
    && viewer.canAccessOrg(target.orgId)
    && siteVisible(viewer, target.siteId)
    && deviceVisible(viewer, target.id);
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

const comparisonColumns = {
  id: devices.id,
  hostname: devices.hostname,
  displayName: devices.displayName,
  osType: devices.osType,
  osVersion: devices.osVersion,
  agentVersion: devices.agentVersion,
  status: devices.status,
  enrolledAt: devices.enrolledAt,
  createdAt: devices.createdAt,
  lastSeenAt: devices.lastSeenAt,
  decommissionedAt: devices.decommissionedAt,
  agentId: devices.agentId,
  installIncarnation: devices.installIncarnation,
  rebindProtocolVersion: devices.rebindProtocolVersion,
  serialNumber: deviceHardware.serialNumber,
  manufacturer: deviceHardware.manufacturer,
  model: deviceHardware.model,
  systemUuid: deviceHardware.systemUuid,
  orgName: organizations.name,
  siteName: sites.name,
};

type ComparisonRow = {
  [K in keyof typeof comparisonColumns]: (typeof comparisonColumns)[K]['_']['data'] | null;
};

async function readComparisonRows(deviceIds: string[]): Promise<Map<string, ComparisonRow>> {
  if (deviceIds.length === 0) return new Map();
  const rows = await db
    .select(comparisonColumns)
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(sites, eq(sites.id, devices.siteId))
    .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
    .where(inArray(devices.id, deviceIds));
  return new Map(rows.map((row) => [row.id, row as ComparisonRow]));
}

function comparisonFields(row: ComparisonRow): ReattachComparisonFields {
  return {
    hostname: row.hostname ?? '',
    displayName: row.displayName ?? null,
    osType: row.osType ?? '',
    osVersion: row.osVersion ?? '',
    agentVersion: row.agentVersion ?? null,
    status: row.status ?? '',
    enrolledAt: iso(row.enrolledAt),
    createdAt: iso(row.createdAt) ?? '',
    lastSeenAt: iso(row.lastSeenAt),
    decommissionedAt: iso(row.decommissionedAt),
    serialNumber: row.serialNumber ?? null,
    manufacturer: row.manufacturer ?? null,
    model: row.model ?? null,
    systemUuid: row.systemUuid ?? null,
  };
}

async function readOpenIntent(sourceDeviceId: string) {
  const [row] = await db
    .select({
      id: deviceReattachIntents.id,
      state: deviceReattachIntents.state,
      targetDeviceId: deviceReattachIntents.targetDeviceId,
      targetOrgId: deviceReattachIntents.targetOrgId,
      expiresAt: deviceReattachIntents.expiresAt,
    })
    .from(deviceReattachIntents)
    .where(and(
      eq(deviceReattachIntents.sourceDeviceId, sourceDeviceId),
      inArray(deviceReattachIntents.state, [...OPEN_REATTACH_INTENT_STATES]),
    ))
    .orderBy(desc(deviceReattachIntents.requestedAt))
    .limit(1);
  return row ?? null;
}

/**
 * The candidates of `sourceDeviceId` as `viewer` may see them, or null when
 * the viewer may not see the source (the route answers 404, the same as a
 * device that does not exist).
 */
export async function readReinstallCandidatesForViewer(input: {
  sourceDeviceId: string;
  viewer: CandidatesViewer;
}): Promise<ReinstallCandidatesView | null> {
  const { viewer } = input;
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const ranked = await readRankedReinstallCandidates(input.sourceDeviceId);
    if (!ranked) return null;
    const { source } = ranked;
    if (!canViewReattachSource(viewer, source)) return null;

    const visible = ranked.ranked.filter((candidate) => canViewReattachCandidate(viewer, candidate.target));
    const openIntentRow = await readOpenIntent(source.id);
    const rows = await readComparisonRows([source.id, ...visible.map((candidate) => candidate.target.id)]);
    const sourceRow = rows.get(source.id);
    if (!sourceRow) return null;

    const candidates: ReattachCandidateView[] = [];
    for (const candidate of visible) {
      const row = rows.get(candidate.target.id);
      if (!row || !row.agentId || row.installIncarnation === null) continue;
      candidates.push({
        deviceId: candidate.target.id,
        orgId: candidate.target.orgId,
        orgName: row.orgName ?? null,
        siteId: candidate.target.siteId,
        siteName: row.siteName ?? null,
        ...comparisonFields(row),
        evidence: candidate.evidence,
        reason: candidate.reason,
        evidenceLevel: 'hint',
        flagged: source.storedTargetId === candidate.target.id,
        osChanged: row.osType !== sourceRow.osType,
        requiresRestore: row.status === 'decommissioned',
        stepUpBinding: { targetAgentId: row.agentId, targetIncarnation: row.installIncarnation },
      });
    }

    // The source's open intent, shown only when its target is in an org this
    // partner viewer reaches (the intents RLS floor, §4.3, applied here).
    const openIntent = openIntentRow && viewer.scope === 'partner' && viewer.canAccessOrg(openIntentRow.targetOrgId)
      ? {
        intentId: openIntentRow.id,
        state: openIntentRow.state,
        targetDeviceId: openIntentRow.targetDeviceId,
        expiresAt: openIntentRow.expiresAt.toISOString(),
      }
      : null;

    return {
      source: {
        deviceId: source.id,
        ...comparisonFields(sourceRow),
        parked: isUnassignedPoolOrgType(source.orgType),
        rebindSupported: (sourceRow.rebindProtocolVersion ?? 0) >= 1,
      },
      candidates,
      reviewPending: candidates.length < ranked.ranked.length,
      openIntent,
      evidenceNotice: HINT_EVIDENCE_NOTICE,
    };
  }));
}
