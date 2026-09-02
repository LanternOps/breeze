/**
 * Device-role SSOT (#3205 moved it here from the validators barrel).
 *
 * Lives in its own module so sibling validators (contracts.ts) can import it
 * directly. The barrel re-exports contracts.ts BEFORE the line where these
 * tuples used to be declared, so importing them back through index.ts during
 * schema construction was an initialization cycle waiting to happen.
 *
 * Adding a role here means also widening `contract_lines_device_roles_chk`
 * (migration 2026-10-04-100100) and the web mirror in apps/web/src/lib/deviceRoles.ts.
 */
export const BILLABLE_DEVICE_ROLES = [
  'workstation', 'server', 'printer', 'router', 'switch',
  'firewall', 'access_point', 'phone', 'iot', 'camera', 'nas',
] as const;
export type BillableDeviceRole = typeof BILLABLE_DEVICE_ROLES[number];

/** `unknown` is the enrollment default: a classification gap, never a rate. */
export const DEVICE_ROLES = [...BILLABLE_DEVICE_ROLES, 'unknown'] as const;
export type DeviceRole = typeof DEVICE_ROLES[number];
