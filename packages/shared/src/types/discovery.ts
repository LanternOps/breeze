// ============================================
// Network Discovery Types
// ============================================

export type DiscoveredAssetType =
  | 'workstation' | 'server' | 'printer' | 'router' | 'switch'
  | 'firewall' | 'access_point' | 'phone' | 'iot' | 'camera' | 'nas' | 'unknown';

export type DiscoveredAssetStatus = 'new' | 'identified' | 'managed' | 'ignored' | 'offline';

export type DiscoveryJobStatus = 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';

export type DiscoveryMethod = 'arp' | 'ping' | 'port_scan' | 'snmp' | 'wmi' | 'ssh' | 'mdns' | 'netbios';

export type DiscoverySchedule =
  | { type: 'manual' }
  | { type: 'cron'; cron: string }
  | { type: 'interval'; intervalMinutes: number };

export interface DiscoveryProfile {
  id: string;
  orgId: string;
  siteId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  subnets: string[];
  excludeIps: string[];
  methods: DiscoveryMethod[];
  schedule: DiscoverySchedule | null;
  deepScan: boolean;
  resolveHostnames: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DiscoveryJob {
  id: string;
  orgId: string;
  profileId: string;
  profileName?: string | null;
  agentId: string | null;
  status: DiscoveryJobStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  hostsScanned: number | null;
  hostsDiscovered: number | null;
  newAssets: number | null;
  errors: unknown | null;
  createdAt: string;
}

export interface DiscoveredAsset {
  id: string;
  orgId: string;
  assetType: DiscoveredAssetType;
  status: DiscoveredAssetStatus;
  hostname: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  manufacturer: string | null;
  model: string | null;
  openPorts: Array<{ port: number; protocol?: string; service?: string }> | null;
  linkedDeviceId: string | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NetworkTopologyNode {
  id: string;
  type: DiscoveredAssetType;
  label: string;
  status: DiscoveredAssetStatus;
  ipAddress: string | null;
  macAddress: string | null;
}

export interface NetworkTopologyEdge {
  id: string;
  sourceId: string;
  targetId: string;
  sourceType: string;
  targetType: string;
  connectionType: string;
  bandwidth: number | null;
  latency: number | null;
}
