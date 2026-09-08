import type { ComponentType } from 'react';
import type { DeviceRole as SharedDeviceRole } from '@breeze/shared';
import {
  Monitor,
  Server,
  Printer,
  Router,
  Network,
  Shield,
  Wifi,
  Phone,
  Cpu,
  Camera,
  HardDrive,
  HelpCircle,
  Globe,
  Cloud,
} from 'lucide-react';

export const DEVICE_ROLES = [
  'workstation', 'server', 'printer', 'router', 'switch',
  'firewall', 'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown'
] as const;

export type DeviceRole = typeof DEVICE_ROLES[number];
type _RolesMatch = [DeviceRole] extends [SharedDeviceRole]
  ? ([SharedDeviceRole] extends [DeviceRole] ? true : never)
  : never;
const _rolesMatch: _RolesMatch = true;

/** Roles a contract line may bill (#3205). `unknown` is a classification gap, not a rate. */
export const BILLABLE_DEVICE_ROLES = DEVICE_ROLES.filter(
  (r): r is Exclude<DeviceRole, 'unknown'> => r !== 'unknown',
);

export type DeviceRoleSource = 'auto' | 'manual' | 'discovery';

type DeviceRoleMeta = {
  label: string;
  icon: ComponentType<{ className?: string }>;
};

const ROLE_META: Record<DeviceRole, DeviceRoleMeta> = {
  workstation:   { label: 'Workstation',   icon: Monitor },
  server:        { label: 'Server',        icon: Server },
  printer:       { label: 'Printer',       icon: Printer },
  router:        { label: 'Router',        icon: Router },
  switch:        { label: 'Switch',        icon: Network },
  firewall:      { label: 'Firewall',      icon: Shield },
  access_point:  { label: 'Access Point',  icon: Wifi },
  phone:         { label: 'Phone',         icon: Phone },
  iot:           { label: 'IoT',           icon: Cpu },
  camera:        { label: 'Camera',        icon: Camera },
  nas:           { label: 'NAS',           icon: HardDrive },
  unknown:       { label: 'Unknown',       icon: HelpCircle },
};

// #5213 W03: 'website'/'service' are valid discovery asset types (an IP-less
// manual asset whose identity is a URL) but are deliberately NOT billable
// device roles — DEVICE_ROLES above governs contract_lines_device_roles_chk,
// and a website isn't a "device" a contract line bills per-seat/per-unit.
// DeviceList's unified Type column calls these lookups on the raw discovery
// `assetType` for every device class, though, so a non-billable asset type
// still needs a real label/icon instead of the raw enum literal — this is a
// separate, additive lookup, never a change to the billing tuple itself.
const NON_BILLABLE_ROLE_META: Record<'website' | 'service', DeviceRoleMeta> = {
  website: { label: 'Website', icon: Globe },
  service: { label: 'Service', icon: Cloud },
};

export function getDeviceRoleLabel(role: string): string {
  return ROLE_META[role as DeviceRole]?.label
    ?? NON_BILLABLE_ROLE_META[role as keyof typeof NON_BILLABLE_ROLE_META]?.label
    ?? role;
}

export function getDeviceRoleIcon(role: string): ComponentType<{ className?: string }> {
  return ROLE_META[role as DeviceRole]?.icon
    ?? NON_BILLABLE_ROLE_META[role as keyof typeof NON_BILLABLE_ROLE_META]?.icon
    ?? HelpCircle;
}

export function getDeviceRoleSourceLabel(source: string): string {
  switch (source) {
    case 'auto': return 'Auto-detected';
    case 'manual': return 'Manually set';
    case 'discovery': return 'From discovery';
    default: return source;
  }
}

export function getDeviceRoleSourceColor(source: string): string {
  switch (source) {
    case 'auto': return 'bg-blue-500/20 text-blue-700 border-blue-500/40';
    case 'manual': return 'bg-purple-500/20 text-purple-700 border-purple-500/40';
    case 'discovery': return 'bg-teal-500/20 text-teal-700 border-teal-500/40';
    default: return 'bg-muted/40 text-muted-foreground border-muted';
  }
}
