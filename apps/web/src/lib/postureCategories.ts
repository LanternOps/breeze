/**
 * Management-posture category/status constants shared by the per-device
 * Management tab and the fleet posture report. Keys mirror the API's
 * MANAGEMENT_POSTURE_CATEGORIES (apps/api/src/routes/agents/schemas.ts) —
 * the ingest enum is the source of truth; add new categories there first.
 *
 * Labels are product/technical vocabulary (RMM, MDM, SIEM…) and deliberately
 * not i18n'd, matching the original DeviceManagementTab convention.
 */

export type DetectionStatus = "active" | "installed" | "unknown";

export type CategoryKey =
  | "mdm"
  | "rmm"
  | "remoteAccess"
  | "endpointSecurity"
  | "policyEngine"
  | "backup"
  | "identityMfa"
  | "siem"
  | "dnsFiltering"
  | "zeroTrustVpn"
  | "patchManagement";

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  mdm: "MDM",
  rmm: "RMM",
  remoteAccess: "Remote Access",
  endpointSecurity: "Endpoint Security",
  policyEngine: "Policy Engine",
  backup: "Backup",
  identityMfa: "Identity / MFA",
  siem: "SIEM",
  dnsFiltering: "DNS Filtering",
  zeroTrustVpn: "Zero Trust / VPN",
  patchManagement: "Patch Management",
};

export const STATUS_BADGE: Record<DetectionStatus, string> = {
  active: "bg-emerald-500/20 text-emerald-700 border-emerald-500/40",
  installed: "bg-blue-500/20 text-blue-700 border-blue-500/40",
  unknown: "bg-gray-500/20 text-gray-600 border-gray-500/30",
};

export function isCategoryKey(value: string): value is CategoryKey {
  return Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, value);
}
