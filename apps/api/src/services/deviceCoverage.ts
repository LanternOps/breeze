/**
 * "Which contract lines bill this device?" (#3205 W06).
 *
 * The transpose of the billing path's per-line question, over the SAME
 * predicate: a ONE-DEVICE OrgDeviceSnapshot fed to contractCoverage's
 * coverageMatch. Nothing is re-derived — only the input set is narrowed to the
 * one row the caller asked about, so this costs O(1) reads instead of the
 * O(org) snapshot generateDueInvoice builds. contractService.ts's orgSnapshot /
 * DeviceCache stay exactly where W02 put them; this module does not import them.
 *
 * Derived live, every time, over `active` contracts only: "could this line bill
 * this device?", deliberately not "will it bill this period?" (that depends on
 * the billing calendar and belongs to W07's per-period evidence).
 *
 * The service re-checks the org itself so non-route callers (#4606, a worker)
 * cannot skip it; the ROUTE still owns the site axis, because the site allowlist
 * lives in the Hono permissions context and never in accessibleOrgIds.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { contractLines, contracts, deviceGroups, devices } from '../db/schema';
import { PG_UUID_REGEX } from '../utils/uuid';
import { billableDeviceById } from './contractQuantities';
import { GroupEvaluationError, groupIncludesDevice } from './groupMembership';
import {
  coverageMatch,
  DEVICE_COUNTED_LINE_TYPES,
  type CoverageLine,
  type CoverageMatchReason,
  type DeviceCountedLineType,
  type GroupMembers,
  type OrgDeviceSnapshot,
} from './contractCoverage';

export type ContractStatusValue = (typeof contracts.$inferSelect)['status'];

export interface DeviceCoverageLine {
  contractId: string;
  contractName: string;
  /** Always 'active' in W06; typed for #4606 / W07. */
  contractStatus: ContractStatusValue;
  lineId: string;
  lineType: DeviceCountedLineType;
  description: string;
  matchedBy: CoverageMatchReason;
  /** The line's own site narrowing, verbatim. Non-null implies it equals the device's siteId. */
  siteId: string | null;
  /** per_device_role only; null on every other type. */
  deviceRoles: readonly string[] | null;
  /** per_device_group only. `name` is the line's stamped device_group_name. */
  deviceGroup: { id: string; name: string } | null;
}

export interface DeviceBillingCoverage {
  deviceId: string;
  orgId: string;
  deviceRole: string;
  siteId: string | null;
  notBillable: boolean;
  notBillableReason: 'decommissioned' | 'ephemeral' | 'not_billable' | null;
  lines: DeviceCoverageLine[];
  /** Derived: !notBillable && lines.length === 0. Never true for a not-billable device. */
  uncovered: boolean;
}

export type DeviceCoverageErrorCode = 'DEVICE_NOT_FOUND' | 'GROUP_EVALUATION_FAILED';

/** Owned here rather than reusing ContractServiceError: a device route has no
 *  handleContractError, and the billing error taxonomy should not leak into it. */
export class DeviceCoverageError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 500,
    public readonly code: DeviceCoverageErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DeviceCoverageError';
  }
}

/** null accessibleOrgIds = unrestricted (system/worker); otherwise the caller's orgs. */
export interface DeviceCoverageActor {
  accessibleOrgIds: string[] | null;
}

/** 404 for missing AND for cross-org, never 403: a probe must not be able to
 *  distinguish "exists elsewhere" from "does not exist" (getDeviceWithOrgCheck
 *  returns null for both). */
function deviceNotFound(): DeviceCoverageError {
  return new DeviceCoverageError('Device not found', 404, 'DEVICE_NOT_FOUND');
}

export async function contractLinesCoveringDevice(
  deviceId: string,
  actor: DeviceCoverageActor,
): Promise<DeviceBillingCoverage> {
  // devices.id is uuid-typed: a malformed param would reach Postgres as 22P02
  // and surface as a 500 (#2968). Same lesson as helpers.ts:174-176.
  if (!PG_UUID_REGEX.test(deviceId)) throw deviceNotFound();

  const [device] = await db
    .select({
      id: devices.id, orgId: devices.orgId, siteId: devices.siteId,
      deviceRole: devices.deviceRole, status: devices.status, isEphemeral: devices.isEphemeral,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) throw deviceNotFound();
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(device.orgId)) throw deviceNotFound();

  const base = {
    deviceId: device.id, orgId: device.orgId,
    deviceRole: device.deviceRole, siteId: device.siteId,
  };

  // The unforked billableDeviceConds verdict. null = decommissioned, ephemeral,
  // or moved org AT THIS INSTANT. Two reads a millisecond apart are allowed to
  // disagree: a benign race gets a correct notBillable with a vaguer reason,
  // never a 500. Returning here also means a not-billable device does NO group
  // work, so it can never fail on an unrelated broken group.
  const row = await billableDeviceById(deviceId, device.orgId);
  if (!row) {
    const notBillableReason = device.status === 'decommissioned'
      ? 'decommissioned' as const
      : device.isEphemeral ? 'ephemeral' as const : 'not_billable' as const;
    return { ...base, notBillable: true, notBillableReason, lines: [], uncovered: false };
  }

  const rows = await db
    .select({
      contractId: contracts.id,
      contractName: contracts.name,
      contractStatus: contracts.status,
      line: contractLines,
    })
    .from(contractLines)
    .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
    .where(and(
      eq(contracts.orgId, device.orgId),
      eq(contracts.status, 'active'),
      eq(contractLines.orgId, device.orgId),   // defence in depth beside W02's (contract_id, org_id) FK
      inArray(contractLines.lineType, [...DEVICE_COUNTED_LINE_TYPES]),
    ))
    .orderBy(contracts.name, contractLines.sortOrder);
  if (rows.length === 0) {
    return { ...base, notBillable: false, notBillableReason: null, lines: [], uncovered: true };
  }

  const referencedGroupIds = [...new Set(
    rows.filter((r) => r.line.lineType === 'per_device_group' && r.line.deviceGroupId)
        .map((r) => r.line.deviceGroupId!),
  )];

  const groups = new Map<string, GroupMembers>();
  if (referencedGroupIds.length > 0) {
    const groupRows = await db
      .select({
        id: deviceGroups.id, orgId: deviceGroups.orgId, name: deviceGroups.name,
        type: deviceGroups.type, siteId: deviceGroups.siteId, filterConditions: deviceGroups.filterConditions,
      })
      .from(deviceGroups)
      .where(and(inArray(deviceGroups.id, referencedGroupIds), eq(deviceGroups.orgId, device.orgId)));

    for (const g of groupRows) {
      // Coverage-level short-circuit: coverageMatch's group branch requires
      // g.siteId === null || g.siteId === row.siteId, so a group bound to a
      // different site cannot cover this device however it is pinned. Keeping
      // the skip HERE rather than inside groupIncludesDevice is what lets that
      // function stay literally parity-testable against resolveEffectiveGroupMembers.
      if (g.siteId !== null && g.siteId !== device.siteId) {
        groups.set(g.id, { siteId: g.siteId, memberIds: new Set() });
        continue;
      }
      try {
        const included = await groupIncludesDevice(g, {
          id: device.id,
          orgId: device.orgId,
          siteId: device.siteId,
          isEphemeral: device.isEphemeral,
        });
        groups.set(g.id, { siteId: g.siteId, memberIds: included ? new Set([device.id]) : new Set() });
      } catch (err) {
        // A group we cannot evaluate is an ERROR, never an empty list (#3205 W02
        // decision 3): reporting "not billed" for an unevaluable group is the
        // silent zero this feature exists to prevent.
        if (err instanceof GroupEvaluationError) {
          throw new DeviceCoverageError(
            `Device group "${g.name}" could not be evaluated (${err.reason})`,
            500, 'GROUP_EVALUATION_FAILED',
            { groupId: g.id, groupName: g.name, reason: err.reason },
          );
        }
        throw err;
      }
    }
  }

  const snapshot: OrgDeviceSnapshot = { devices: [row], groups };
  const out: DeviceCoverageLine[] = [];
  for (const r of rows) {
    const l = r.line;
    // A null device_group_id, or a group id the org-predicated read did not
    // return, cannot match — the same answer uncoveredByRole gives on the
    // contract page. The contract page already flags the orphaned line.
    if (l.lineType === 'per_device_group' && (l.deviceGroupId === null || !groups.has(l.deviceGroupId))) continue;

    const coverageLine: CoverageLine = {
      lineType: l.lineType,
      siteId: l.siteId,
      deviceRoles: l.deviceRoles,
      deviceGroupId: l.deviceGroupId,
    };
    const why = coverageMatch(coverageLine, row, snapshot);
    if (why === null) continue;

    out.push({
      contractId: r.contractId,
      contractName: r.contractName,
      contractStatus: r.contractStatus,
      lineId: l.id,
      lineType: l.lineType as DeviceCountedLineType,
      description: l.description,
      matchedBy: why,
      siteId: l.siteId,
      deviceRoles: l.lineType === 'per_device_role' ? l.deviceRoles : null,
      // The stamped device_group_name, not a fourth query: it is what W02
      // designed the stamp for, and a resolvable line's group exists by
      // definition, so the only drift is a rename after line creation.
      // contract_lines_device_group_chk guarantees the stamped name is non-null.
      deviceGroup: l.lineType === 'per_device_group' && l.deviceGroupId
        ? { id: l.deviceGroupId, name: l.deviceGroupName! }
        : null,
    });
  }

  return { ...base, notBillable: false, notBillableReason: null, lines: out, uncovered: out.length === 0 };
}
