/**
 * #3205 W05 fix round 2: `buildOrgDeviceSnapshot` lives in its own module so its
 * calls to `contractQuantities`'s primitives are cross-module — that is what
 * makes `vi.mock('./contractQuantities', ...)` visible to it from a caller's
 * test suite. Keeping it inside contractQuantities.ts (its original home) put
 * it in the same file as `snapshotContractDevices` / `groupMembersForBilling`,
 * and Vitest/Vite's ESM module mocking cannot intercept a same-module function
 * calling another function declared in that same file — the call is a plain
 * lexical reference, never routed through the mocked exports object. Moving
 * the builder here is a pure relocation: same exported names, same signature,
 * same behaviour.
 *
 * Fix round 4: accepts an optional pre-fetched device list so a caller that
 * already has one org-scoped snapshot cached (contractService's `orgSnapshot`,
 * resolving a NEW group id for an org it already snapshotted this calculation)
 * never re-issues the full billable-device scan just to resolve one more group.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { deviceGroups } from '../db/schema';
import { GroupEvaluationError } from './groupMembership';
import type { GroupMembers, OrgDeviceSnapshot } from './contractCoverage';
import { snapshotContractDevices, groupMembersForBilling, type DeviceSnapshotRow } from './contractQuantities';

export interface OrgDeviceSnapshotResult {
  snapshot: OrgDeviceSnapshot;
  /** Groups that could NOT be resolved, by id. A caller degrades the lines that
   *  name a failed group and counts the rest; `snapshot.groups` simply has no
   *  entry for them. Empty on the happy path. */
  groupErrors: ReadonlyMap<string, GroupEvaluationError>;
  /** Name of every device_groups row the builder loaded, by id — resolved AND
   *  failed alike (#3205 W05 fix round 3). The builder already reads each row
   *  to attempt `groupMembersForBilling`; carrying the name forward here means
   *  a caller building a GROUP_EVALUATION_FAILED message never re-queries
   *  deviceGroups for something it already had in hand. */
  groupNames: ReadonlyMap<string, string>;
}

/** Assemble ONE OrgDeviceSnapshot: the org's billable devices plus the member
 *  set of every named group. The single place a snapshot is built — contract
 *  billing (via contractService's per-calculation cache) and quote estimation
 *  both come through here, so nothing ever counts devices with its own query
 *  (#3205 roadmap, settled decision 1).
 *
 *  Returns failures instead of throwing them: a set of lines may reference
 *  several groups, and one bad filter must not decide the fate of the others.
 *  Callers that want all-or-nothing re-throw the first entry — which is exactly
 *  what contractService's orgSnapshot does, preserving W02's behaviour.
 *
 *  A group id that does not come back — deleted between the line read and here,
 *  or not in this org — is simply absent from BOTH maps; callers treat that like
 *  a null id (GROUP_DELETED / unresolved). */
export async function buildOrgDeviceSnapshot(
  orgId: string, groupIds: readonly string[] = [],
  opts?: { devices?: readonly DeviceSnapshotRow[] },
): Promise<OrgDeviceSnapshotResult> {
  const devicesList = opts?.devices ?? await snapshotContractDevices(orgId);
  const groups = new Map<string, GroupMembers>();
  const groupErrors = new Map<string, GroupEvaluationError>();
  const groupNames = new Map<string, string>();
  const wanted = [...new Set(groupIds)];
  if (wanted.length > 0) {
    const rows = await db.select({
      id: deviceGroups.id, orgId: deviceGroups.orgId, name: deviceGroups.name, type: deviceGroups.type,
      siteId: deviceGroups.siteId, filterConditions: deviceGroups.filterConditions,
    }).from(deviceGroups).where(and(inArray(deviceGroups.id, wanted), eq(deviceGroups.orgId, orgId)));
    for (const g of rows) {
      groupNames.set(g.id, g.name);
      try {
        groups.set(g.id, await groupMembersForBilling(g));
      } catch (err) {
        if (err instanceof GroupEvaluationError) {
          groupErrors.set(g.id, err);
          continue;
        }
        throw err;
      }
    }
  }
  return { snapshot: { devices: devicesList, groups }, groupErrors, groupNames };
}
