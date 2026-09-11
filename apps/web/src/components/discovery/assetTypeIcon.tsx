import {
  Camera,
  Cloud,
  Cpu,
  Globe,
  HardDrive,
  HelpCircle,
  Monitor,
  Network,
  Phone,
  Printer,
  Router,
  Server,
  Shield,
  Wifi,
  type LucideIcon,
} from 'lucide-react';
import type { DiscoveredAssetType } from './DiscoveredAssetList';

// Per-type icon for the network asset header (and, later, the list). Kept in
// its own module — separate from DiscoveredAssetList's typeConfig — so a
// future list adoption doesn't have to import the page-detail component.
export const assetTypeIcons: Record<DiscoveredAssetType, LucideIcon> = {
  workstation: Monitor,
  server: Server,
  printer: Printer,
  router: Router,
  switch: Network,
  firewall: Shield,
  access_point: Wifi,
  phone: Phone,
  iot: Cpu,
  camera: Camera,
  nas: HardDrive,
  website: Globe,
  service: Cloud,
  unknown: HelpCircle,
};

export function assetTypeIcon(type: DiscoveredAssetType): LucideIcon {
  return assetTypeIcons[type] ?? HelpCircle;
}
