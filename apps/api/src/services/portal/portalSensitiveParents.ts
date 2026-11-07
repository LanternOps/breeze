/**
 * Which portal flags expose sensitive data, and which parent gate each one's
 * data sits behind (full-control W18 PR B, #6789, plan Fact 1). A leaf with no
 * db import, so the tool schema and the effect-digest resolver (loaded by the
 * release worker) can share it with orgPortalSettingsService.ts.
 */
import { PORTAL_PERMISSION_FLAG_KEYS, PORTAL_SENSITIVE_FLAG_KEYS } from '@breeze/shared';

/**
 * Sensitive portal data shown only while a parent gate is ALSO on, keyed by the
 * parent: network alerts and physical placement ride on the network section
 * (routes/portal/network.ts), the hour-block balance on Support usage
 * (`PORTAL_SECTION_GATES` supportUsage row, services/portal/supportUsage.ts).
 * Patch and vulnerability detail are their own gates. Kept exhaustive by a scan
 * in orgPortalSettingsService.test.ts.
 */
export const PORTAL_SENSITIVE_PARENTS = {
  enableNetworkVisibility: ['enableNetworkAlerts', 'enablePhysicalPlacement'],
  enableSupportUsage: ['enableHourBlock'],
} as const satisfies Record<string, readonly (typeof PORTAL_SENSITIVE_FLAG_KEYS)[number][]>;

export type PortalSensitiveParent = keyof typeof PORTAL_SENSITIVE_PARENTS;

/**
 * The keys the four-eyes `set_sensitive_access` sets: every sensitive and
 * permission flag (which the supervised `update` never accepts), plus the two
 * parents (which `update` also accepts, refused only when they would activate).
 */
export const PORTAL_TOOL_SENSITIVE_KEYS = [
  ...PORTAL_SENSITIVE_FLAG_KEYS,
  ...PORTAL_PERMISSION_FLAG_KEYS,
  ...(Object.keys(PORTAL_SENSITIVE_PARENTS) as PortalSensitiveParent[]),
] as const;

export type PortalToolSensitiveKey = (typeof PORTAL_TOOL_SENSITIVE_KEYS)[number];

/** What a portal user gains from each key, for the four-eyes approval card. */
export const PORTAL_TOOL_SENSITIVE_LABELS: Readonly<Record<PortalToolSensitiveKey, string>> = {
  enableNetworkAlerts: 'network alerts',
  enableHourBlock: 'the prepaid support-hours balance',
  enablePatchDetail: 'per-device missing and pending patches',
  enableVulnerabilityDetail: 'per-device vulnerability (CVE) findings',
  enablePhysicalPlacement: 'rack and room placement',
  enableTrustPageEditing: 'editing the trust page draft (portal admins)',
  enableNetworkVisibility: 'the network section',
  enableSupportUsage: 'support usage',
};

/** Missing-row defaults of every key above: all fail closed. */
export const PORTAL_TOOL_SENSITIVE_DEFAULTS: Readonly<Record<PortalToolSensitiveKey, false>> = Object.freeze(
  Object.fromEntries(PORTAL_TOOL_SENSITIVE_KEYS.map((key) => [key, false])) as Record<PortalToolSensitiveKey, false>,
);
