/**
 * IOC sweep target resolution (#6263 W05-5): which devices a sweep request
 * reaches, which rule-set versions it pins, and the digest a confirmation must
 * echo back.
 *
 * Runs in the CALLER's DB context only (its RLS is the outer fence), and then
 * applies the caller's live per-org RBAC as the inner one:
 *  - `devices:execute` is resolved PER TARGET ORG (`getUserPermissions` with
 *    that org), so an org membership narrower than the partner membership wins
 *    in that org;
 *  - devices are intersected with the org's `allowedSiteIds` and the caller's
 *    `allowedDeviceIds`;
 *  - a named org / site / device outside those is a 403 for the whole request
 *    (never a silent narrowing of what the operator asked for); for `all`,
 *    `orgs` and `groups` the unreachable devices simply drop.
 *
 * Every pinned set must be eligible for the device's org by the same ownership
 * rule the dispatcher uses (`resolveYaraRuleSetRefs`): the device's org's own
 * sets, its partner's partner-wide sets, and the built-in pack. An ineligible
 * device is skipped (`rule_set_not_eligible`), never sent a partial-set scan;
 * a device below the YARA agent minimum is skipped (`agent_too_old`), never
 * sent a legacy scan.
 */
import { and, eq, inArray, ne, type SQL } from 'drizzle-orm';
import type {
  SecuritySweepScanType,
  SecuritySweepScope,
  SecuritySweepSkipReason,
  YaraRuleSetPin,
} from '@breeze/shared';
import { db } from '../db';
import { findPartnerOwnedGroupIds, partnerGroupTargetRefusal } from './deviceGroupOwnership';
import { deviceGroupMemberships, devices, organizations, sites, yaraRuleSets } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { isAutomationPrincipal } from '../middleware/principalKind';
import { canonicalizeArguments, computeArgumentDigest } from './actionIntents/canonicalize';
import { getUserPermissions, hasPermission, type UserPermissions } from './permissions';
import { normalizeSiteAllowlist } from './siteAllowlist';
import { notParkedDeviceCondition } from './unassignedPool/selectorPredicate';
import { agentSupportsYaraScan } from './yaraScanRefs';
import { sweepMaxDevices } from './securityScanSweepConfig';

export type SweepTargetErrorCode =
  | 'ORG_OUT_OF_SCOPE'
  | 'SITE_OUT_OF_SCOPE'
  | 'DEVICE_OUT_OF_SCOPE'
  | 'RULE_SET_NOT_FOUND'
  | 'RULE_SET_NOT_PUBLISHED'
  | 'SWEEP_TOO_LARGE'
  | 'NO_ELIGIBLE_DEVICES'
  | ReturnType<typeof partnerGroupTargetRefusal>['code'];

export interface SweepTargetsInput {
  ruleSetIds: string[];
  scope: SecuritySweepScope;
  scanType: SecuritySweepScanType;
  paths?: string[];
  /** Restrict the scope to one org (the AI path is single-org). */
  onlyOrgId?: string;
}

export type SweepSkipCounts = Record<SecuritySweepSkipReason, number>;

export interface SweepTargetsResolved {
  ok: true;
  /** org id -> sorted target device ids. Only orgs with at least one target. */
  byOrg: Map<string, string[]>;
  orgNames: Map<string, string>;
  targeted: number;
  skipped: SweepSkipCounts;
  /** The same counts split by device org (orgs with no target included). */
  skippedByOrg: Map<string, SweepSkipCounts>;
  /** Sorted by id. */
  pins: YaraRuleSetPin[];
  ruleSetNames: Map<string, string>;
  /** Sorted, or undefined for a non-custom scan. */
  paths: string[] | undefined;
  previewDigest: string;
}

export type SweepTargetsFailure = {
  ok: false;
  status: 400 | 403 | 404;
  code: SweepTargetErrorCode;
  detail?: Record<string, unknown>;
};

export type SweepTargetsResult = SweepTargetsResolved | SweepTargetsFailure;

const fail = (
  status: SweepTargetsFailure['status'],
  code: SweepTargetErrorCode,
  detail?: Record<string, unknown>,
): SweepTargetsFailure => ({ ok: false, status, code, ...(detail ? { detail } : {}) });

export const emptySkipCounts = (): SweepSkipCounts => ({
  agent_too_old: 0,
  busy_same_sweep: 0,
  rule_set_not_eligible: 0,
});

/** sha256 hex over the exact targets, pins, scan type and paths (W05-5). */
export function computeSweepPreviewDigest(input: {
  deviceIds: readonly string[];
  pins: readonly YaraRuleSetPin[];
  scanType: string;
  paths?: readonly string[];
}): string {
  // The canonicalizer sorts object keys but keeps array order, so every array
  // is sorted here: the digest must not depend on input order.
  return computeArgumentDigest(
    canonicalizeArguments({
      v: 1,
      targets: [...input.deviceIds].sort(),
      pins: [...input.pins]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((p) => ({ id: p.id, version: p.version, sha256: p.sha256 })),
      scanType: input.scanType,
      paths: [...(input.paths ?? [])].sort(),
    }),
  );
}

/**
 * The caller's live permission set in one org — what `requirePermission`
 * would resolve were the request made with that org selected. A system token
 * with no axis (platform admin) resolves once, org-independently.
 */
export function createOrgPermissionResolver(auth: AuthContext) {
  const cache = new Map<string, Promise<UserPermissions | null>>();
  const axisless = auth.scope === 'system' && !auth.partnerId && !auth.orgId;
  return (orgId: string): Promise<UserPermissions | null> => {
    if (isAutomationPrincipal(auth)) return Promise.resolve(null);
    const key = axisless ? '*' : orgId;
    let pending = cache.get(key);
    if (!pending) {
      pending = axisless
        ? getUserPermissions(auth.user.id, { scope: 'system' })
        : getUserPermissions(auth.user.id, {
            partnerId: auth.partnerId || undefined,
            orgId,
            scope: auth.scope,
          });
      cache.set(key, pending);
    }
    return pending;
  };
}

/** Site + device ceilings for one org's permission set and the auth context. */
export function deviceWithinCeiling(
  auth: Pick<AuthContext, 'allowedSiteIds' | 'allowedDeviceIds'>,
  perms: UserPermissions,
  device: { id: string; siteId: string | null },
): boolean {
  const permSites = normalizeSiteAllowlist(perms.allowedSiteIds);
  if (permSites !== undefined && (!device.siteId || !permSites.includes(device.siteId))) return false;
  const authSites = normalizeSiteAllowlist(auth.allowedSiteIds);
  if (authSites !== undefined && (!device.siteId || !authSites.includes(device.siteId))) return false;
  if (auth.allowedDeviceIds !== undefined && !auth.allowedDeviceIds.includes(device.id)) return false;
  return true;
}

type RuleSetRow = {
  id: string;
  name: string;
  orgId: string | null;
  partnerId: string | null;
  isBuiltin: boolean;
  enabled: boolean;
  publishedVersion: number;
  publishedSha256: string | null;
};

function ruleSetEligibleForDevice(set: RuleSetRow, device: { orgId: string; partnerId: string | null }): boolean {
  if (set.isBuiltin) return true;
  if (set.orgId) return set.orgId === device.orgId;
  return set.partnerId !== null && set.partnerId === device.partnerId;
}

export async function resolveSweepTargets(auth: AuthContext, rawInput: SweepTargetsInput): Promise<SweepTargetsResult> {
  // Validators accept any-case UUIDs; rows are stored lower-case.
  const input = normalizeIds(rawInput);
  const { scope } = input;
  if (scope.kind === 'groups') {
    const partnerGroupIds = await findPartnerOwnedGroupIds(scope.groupIds);
    if (partnerGroupIds.length > 0) {
      const refusal = partnerGroupTargetRefusal(partnerGroupIds);
      return fail(400, refusal.code, { groupIds: refusal.groupIds });
    }
  }

  // Named / restricting orgs must be reachable at all (RLS + accessibleOrgIds).
  if (input.onlyOrgId && !auth.canAccessOrg(input.onlyOrgId)) {
    return fail(403, 'ORG_OUT_OF_SCOPE', { orgIds: [input.onlyOrgId] });
  }
  if (scope.kind === 'orgs') {
    const foreign = scope.orgIds.filter((id) => !auth.canAccessOrg(id));
    if (foreign.length > 0) return fail(403, 'ORG_OUT_OF_SCOPE', { orgIds: foreign });
  }

  // ---- Rule sets, once, under the caller's RLS -----------------------------
  const ruleSetIds = [...new Set(input.ruleSetIds)];
  const setRows: RuleSetRow[] = await db
    .select({
      id: yaraRuleSets.id,
      name: yaraRuleSets.name,
      orgId: yaraRuleSets.orgId,
      partnerId: yaraRuleSets.partnerId,
      isBuiltin: yaraRuleSets.isBuiltin,
      enabled: yaraRuleSets.enabled,
      publishedVersion: yaraRuleSets.publishedVersion,
      publishedSha256: yaraRuleSets.publishedSha256,
    })
    .from(yaraRuleSets)
    .where(inArray(yaraRuleSets.id, ruleSetIds));
  const setsById = new Map(setRows.map((r) => [r.id, r]));
  const missingSets = ruleSetIds.filter((id) => !setsById.has(id));
  if (missingSets.length > 0) return fail(404, 'RULE_SET_NOT_FOUND', { ruleSetIds: missingSets });
  const unpublished = setRows
    .filter((r) => !r.enabled || r.publishedVersion < 1 || !r.publishedSha256)
    .map((r) => r.id);
  if (unpublished.length > 0) return fail(400, 'RULE_SET_NOT_PUBLISHED', { ruleSetIds: unpublished });
  const pins: YaraRuleSetPin[] = setRows
    .map((r) => ({ id: r.id, version: r.publishedVersion, sha256: r.publishedSha256! }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const ruleSetNames = new Map(setRows.map((r) => [r.id, r.name]));

  const permsFor = createOrgPermissionResolver(auth);
  const canExecuteIn = async (orgId: string): Promise<UserPermissions | null> => {
    const perms = await permsFor(orgId);
    return perms && hasPermission(perms, 'devices', 'execute') ? perms : null;
  };
  const tenantFence = (column: Parameters<AuthContext['orgCondition']>[0]): SQL[] => {
    const c = auth.orgCondition(column);
    return c ? [c] : [];
  };

  // ---- Named orgs: execute is required in each ----------------------------
  if (scope.kind === 'orgs') {
    const denied: string[] = [];
    for (const orgId of scope.orgIds) if (!(await canExecuteIn(orgId))) denied.push(orgId);
    if (denied.length > 0) return fail(403, 'ORG_OUT_OF_SCOPE', { orgIds: denied });
  }

  // ---- Named sites: visible, executable org, inside the site ceiling -------
  if (scope.kind === 'sites') {
    const siteRows = await db
      .select({ id: sites.id, orgId: sites.orgId })
      .from(sites)
      .where(and(inArray(sites.id, scope.siteIds), ...tenantFence(sites.orgId)));
    const byId = new Map(siteRows.map((s) => [s.id, s]));
    const outside: string[] = [];
    for (const siteId of scope.siteIds) {
      const site = byId.get(siteId);
      const perms = site && (!input.onlyOrgId || site.orgId === input.onlyOrgId) ? await canExecuteIn(site.orgId) : null;
      // The device id is irrelevant to a site check; only the site axis applies.
      if (!site || !perms || !siteWithinCeiling(auth, perms, siteId)) outside.push(siteId);
    }
    if (outside.length > 0) return fail(403, 'SITE_OUT_OF_SCOPE', { siteIds: outside });
  }

  // ---- Named devices: visible, executable org, inside both ceilings --------
  if (scope.kind === 'devices') {
    const named = await db
      .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
      .from(devices)
      .where(and(inArray(devices.id, scope.deviceIds), ...tenantFence(devices.orgId)));
    const byId = new Map(named.map((d) => [d.id, d]));
    const outside: string[] = [];
    for (const deviceId of scope.deviceIds) {
      const device = byId.get(deviceId);
      const perms =
        device && (!input.onlyOrgId || device.orgId === input.onlyOrgId) ? await canExecuteIn(device.orgId) : null;
      if (!device || !perms || !deviceWithinCeiling(auth, perms, device)) outside.push(deviceId);
    }
    if (outside.length > 0) return fail(403, 'DEVICE_OUT_OF_SCOPE', { deviceIds: outside });
  }

  // ---- Candidate devices ---------------------------------------------------
  const conditions: SQL[] = [
    ...tenantFence(devices.orgId),
    eq(devices.isEphemeral, false),
    notParkedDeviceCondition(),
    ne(devices.status, 'decommissioned'),
  ];
  if (input.onlyOrgId) conditions.push(eq(devices.orgId, input.onlyOrgId));
  switch (scope.kind) {
    case 'all':
      break;
    case 'orgs':
      conditions.push(inArray(devices.orgId, scope.orgIds));
      break;
    case 'sites':
      conditions.push(inArray(devices.siteId, scope.siteIds));
      break;
    case 'devices':
      conditions.push(inArray(devices.id, scope.deviceIds));
      break;
    case 'groups': {
      const members = await db
        .select({ deviceId: deviceGroupMemberships.deviceId })
        .from(deviceGroupMemberships)
        .where(and(inArray(deviceGroupMemberships.groupId, scope.groupIds), ...tenantFence(deviceGroupMemberships.orgId)));
      const memberIds = [...new Set(members.map((m) => m.deviceId))];
      if (memberIds.length === 0) return fail(400, 'NO_ELIGIBLE_DEVICES', { skipped: emptySkipCounts() });
      conditions.push(inArray(devices.id, memberIds));
      break;
    }
  }

  const candidates = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      siteId: devices.siteId,
      agentVersion: devices.agentVersion,
      partnerId: organizations.partnerId,
      orgName: organizations.name,
    })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .where(and(...conditions));

  const skipped = emptySkipCounts();
  const skippedByOrg = new Map<string, SweepSkipCounts>();
  const skip = (orgId: string, reason: SecuritySweepSkipReason) => {
    skipped[reason]++;
    const counts = skippedByOrg.get(orgId) ?? emptySkipCounts();
    counts[reason]++;
    skippedByOrg.set(orgId, counts);
  };
  const byOrg = new Map<string, string[]>();
  const orgNames = new Map<string, string>();
  for (const device of candidates) {
    const perms = await canExecuteIn(device.orgId);
    if (!perms || !deviceWithinCeiling(auth, perms, device)) continue; // silently out of reach
    if (!setRows.every((set) => ruleSetEligibleForDevice(set, device))) {
      skip(device.orgId, 'rule_set_not_eligible');
      continue;
    }
    if (!agentSupportsYaraScan(device.agentVersion)) {
      skip(device.orgId, 'agent_too_old');
      continue;
    }
    const list = byOrg.get(device.orgId) ?? [];
    list.push(device.id);
    byOrg.set(device.orgId, list);
    orgNames.set(device.orgId, device.orgName);
  }

  let targeted = 0;
  for (const list of byOrg.values()) {
    list.sort();
    targeted += list.length;
  }
  const max = sweepMaxDevices();
  if (targeted > max) return fail(400, 'SWEEP_TOO_LARGE', { targeted, max });
  if (targeted === 0) return fail(400, 'NO_ELIGIBLE_DEVICES', { skipped });

  const paths = input.scanType === 'custom' && input.paths ? [...input.paths].sort() : undefined;
  return {
    ok: true,
    byOrg,
    orgNames,
    targeted,
    skipped,
    skippedByOrg,
    pins,
    ruleSetNames,
    paths,
    previewDigest: computeSweepPreviewDigest({
      deviceIds: [...byOrg.values()].flat(),
      pins,
      scanType: input.scanType,
      paths,
    }),
  };
}

function normalizeIds(input: SweepTargetsInput): SweepTargetsInput {
  const lower = (ids: string[]) => ids.map((id) => id.toLowerCase());
  const scope: SecuritySweepScope = (() => {
    switch (input.scope.kind) {
      case 'all':
        return input.scope;
      case 'orgs':
        return { kind: 'orgs', orgIds: lower(input.scope.orgIds) };
      case 'sites':
        return { kind: 'sites', siteIds: lower(input.scope.siteIds) };
      case 'groups':
        return { kind: 'groups', groupIds: lower(input.scope.groupIds) };
      case 'devices':
        return { kind: 'devices', deviceIds: lower(input.scope.deviceIds) };
    }
  })();
  return {
    ...input,
    ruleSetIds: lower(input.ruleSetIds),
    scope,
    ...(input.onlyOrgId ? { onlyOrgId: input.onlyOrgId.toLowerCase() } : {}),
  };
}

function siteWithinCeiling(
  auth: Pick<AuthContext, 'allowedSiteIds'>,
  perms: UserPermissions,
  siteId: string,
): boolean {
  const permSites = normalizeSiteAllowlist(perms.allowedSiteIds);
  if (permSites !== undefined && !permSites.includes(siteId)) return false;
  const authSites = normalizeSiteAllowlist(auth.allowedSiteIds);
  if (authSites !== undefined && !authSites.includes(siteId)) return false;
  return true;
}
