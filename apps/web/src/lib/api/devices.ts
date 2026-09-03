// Typed fetch wrappers for device-scoped reads that are not part of the device
// list/detail core. Same convention as contracts.ts:1-13 — no generic api
// client; each wrapper calls fetchWithAuth (which auto-injects the active
// orgId) and returns the raw Response so callers keep 401 handling.
import { fetchWithAuth } from '../../stores/auth';
import type { ContractStatus } from './contracts';

export type DeviceCoverageMatchReason = 'org' | 'site' | 'role' | 'group';
export type DeviceCountedLineType = 'per_device' | 'per_device_role' | 'per_device_group';

/** One active contract line that bills this device (#3205 W06). Carries no money. */
export interface DeviceCoverageLine {
  contractId: string;
  contractName: string;
  contractStatus: ContractStatus;
  lineId: string;
  lineType: DeviceCountedLineType;
  description: string;
  matchedBy: DeviceCoverageMatchReason;
  siteId: string | null;
  deviceRoles: string[] | null;
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
  /** Derived server-side: !notBillable && lines.length === 0. */
  uncovered: boolean;
}

/** GET /devices/:id/billing — requires devices:read AND contracts:read, partner scope. */
export function getDeviceBilling(deviceId: string): Promise<Response> {
  return fetchWithAuth(`/devices/${deviceId}/billing`);
}
