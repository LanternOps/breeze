/**
 * Wisp analysis sessions W02 — the device frame of an `analysis` run
 * (spec §4.3, W00 C6/C7).
 *
 * Admission (`createAndEnqueueAgentRun` step 4d) calls this inside its own
 * system-context transaction, after it has resolved the live grant ceiling,
 * and freezes the result into `staged_inputs.deviceIds`. From there nothing
 * downstream changes: the run's auth context, `runTargets` and every export
 * adapter already work from that frozen list, so a device added to the org
 * after admission is never readable by the run.
 *
 * Invariants this file holds:
 * - An `ok` result NEVER carries an empty `deviceIds`. Downstream an empty
 *   frozen list is read as "no frame", so an empty frame is `frame_empty`.
 * - `allowedSiteIds` is the live ceiling's site allowlist for the org
 *   (`ceilingSiteIdsForOrg`): `null` = unrestricted, `[]` = no site. A
 *   site-limited grantor never gets a wider frame than they could see.
 * - A `site`/`org` expansion loads at most `maxFrameDevices + 1` ids.
 * - Decommissioned devices are left out of a `site`/`org` frame and kept
 *   when listed explicitly (W00 C7a).
 *
 * It uses the ambient `db` and opens no context of its own.
 */
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../../db';
import { devices, sites } from '../../db/schema';
import type { AiAgentRunStagedInputs, AnalysisScopeKind } from '../../db/schema/aiAgents';

export type AnalysisFrameRefusal =
  | 'too_many_input_devices'
  | 'device_not_in_org'
  | 'frame_too_large'
  | 'site_not_in_scope'
  | 'frame_empty';

export type AnalysisFrameResult =
  | { ok: true; deviceIds: string[]; scope: NonNullable<AiAgentRunStagedInputs['scope']> }
  | { ok: false; refusal: AnalysisFrameRefusal };

export interface ResolveAnalysisFrameInput {
  orgId: string;
  scope: AnalysisScopeKind;
  deviceIds: string[];
  siteId: string | null;
  allowedSiteIds: string[] | null;
  maxInputDevices: number;
  maxFrameDevices: number;
}

export async function resolveAnalysisFrame(input: ResolveAnalysisFrameInput): Promise<AnalysisFrameResult> {
  const { orgId, scope, allowedSiteIds } = input;

  if (scope === 'devices') {
    const listed = [...new Set(input.deviceIds)];
    if (listed.length === 0) return { ok: false, refusal: 'frame_empty' };
    // Too many of the technician's OWN devices is its own refusal:
    // `device_not_in_org` is a tenancy signal and must not be reused for it.
    if (listed.length > input.maxInputDevices) return { ok: false, refusal: 'too_many_input_devices' };
    const rows = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(and(inArray(devices.id, listed), eq(devices.orgId, orgId)));
    if (rows.length !== listed.length) return { ok: false, refusal: 'device_not_in_org' };
    if (allowedSiteIds !== null) {
      const allowed = new Set(allowedSiteIds);
      if (rows.some((row) => !allowed.has(row.siteId))) return { ok: false, refusal: 'site_not_in_scope' };
    }
    return { ok: true, deviceIds: listed, scope: { kind: 'devices', siteId: null, deviceCount: listed.length } };
  }

  let siteFilter;
  if (scope === 'site') {
    const siteId = input.siteId;
    // A site scope without a site is never widened to the whole org.
    if (!siteId) return { ok: false, refusal: 'site_not_in_scope' };
    if (allowedSiteIds !== null && !allowedSiteIds.includes(siteId)) return { ok: false, refusal: 'site_not_in_scope' };
    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)))
      .limit(1);
    if (!site) return { ok: false, refusal: 'site_not_in_scope' };
    siteFilter = eq(devices.siteId, siteId);
  } else {
    if (allowedSiteIds !== null && allowedSiteIds.length === 0) return { ok: false, refusal: 'frame_empty' };
    siteFilter = allowedSiteIds !== null ? inArray(devices.siteId, allowedSiteIds) : undefined;
  }

  const rows = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), siteFilter, ne(devices.status, 'decommissioned')))
    .orderBy(asc(devices.id))
    .limit(input.maxFrameDevices + 1);
  if (rows.length > input.maxFrameDevices) return { ok: false, refusal: 'frame_too_large' };
  if (rows.length === 0) return { ok: false, refusal: 'frame_empty' };
  const deviceIds = rows.map((row) => row.id);
  return {
    ok: true,
    deviceIds,
    scope: { kind: scope, siteId: scope === 'site' ? input.siteId : null, deviceCount: deviceIds.length },
  };
}
