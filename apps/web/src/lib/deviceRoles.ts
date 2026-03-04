import type { ComponentType } from 'react';
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
} from 'lucide-react';

export const DEVICE_ROLES = [
  'workstation', 'server', 'printer', 'router', 'switch',
  'firewall', 'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown'
] as const;

export type DeviceRole = typeof DEVICE_ROLES[number];

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

export function getDeviceRoleLabel(role: string): string {
  return ROLE_META[role as DeviceRole]?.label ?? role;
}

export function getDeviceRoleIcon(role: string): ComponentType<{ className?: string }> {
  return ROLE_META[role as DeviceRole]?.icon ?? HelpCircle;
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
