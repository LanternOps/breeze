export const HARDWARE_COMPONENT_TYPES = ['controller','virtual_disk','physical_disk','cache_battery','enclosure','bmc','collector'] as const;
export type HardwareComponentType = (typeof HARDWARE_COMPONENT_TYPES)[number];
export const AGENT_REPORTABLE_COMPONENT_TYPES = ['controller','virtual_disk','physical_disk','cache_battery','enclosure','bmc'] as const;
export const HARDWARE_SOURCES = ['storcli','perccli','megacli','ssacli','arcconf','omreport','mdadm','zfs','storage_spaces','windows_physical_disk','smartctl','ipmi','racadm','hponcfg','redfish','snmp'] as const;
export type HardwareSource = (typeof HARDWARE_SOURCES)[number];
export const RAID_TIER_SOURCES = ['storcli','perccli','megacli','ssacli','arcconf','omreport','mdadm','zfs','storage_spaces','ipmi','racadm','hponcfg'] as const;
export const DISK_TIER_SOURCES = ['windows_physical_disk','smartctl'] as const;
export const HARDWARE_HEALTH_LEVELS = ['ok','warning','critical','unknown'] as const;
export type HardwareHealth = (typeof HARDWARE_HEALTH_LEVELS)[number];
export const HARDWARE_HEALTH_RANK: Record<HardwareHealth, number> = {unknown:0,ok:1,warning:2,critical:3};
export const HARDWARE_SOURCE_STATUSES = ['ok','unavailable','superseded','failed','backing_off','disabled'] as const;
export type HardwareSourceStatus = (typeof HARDWARE_SOURCE_STATUSES)[number];
export const HARDWARE_TIERS = ['raid','disk','none','disabled'] as const;
export const HARDWARE_STATES: Record<HardwareComponentType, readonly string[]> = {
  controller:['ok','degraded','failed','unknown'],
  virtual_disk:['optimal','rebuilding','initializing','checking','migrating','degraded','partially_degraded','failed','offline','unknown'],
  physical_disk:['online','hotspare','ready','jbod','unconfigured','rebuilding','copyback','foreign','shielded','predictive_failure','degraded','failed','missing','offline','unknown'],
  cache_battery:['ok','charging','learning','degraded','failed','missing','unknown'],
  enclosure:['ok','degraded','failed','unknown'], bmc:['ok','unknown'], collector:['ok','failed','backing_off'],
};
export const HARDWARE_STATE_HEALTH: Record<HardwareComponentType, Record<string, HardwareHealth>> = {
  controller:{ok:'ok',degraded:'warning',failed:'critical',unknown:'unknown'},
  virtual_disk:{optimal:'ok',rebuilding:'warning',initializing:'warning',checking:'warning',migrating:'warning',degraded:'critical',partially_degraded:'critical',failed:'critical',offline:'critical',unknown:'unknown'},
  physical_disk:{online:'ok',hotspare:'ok',ready:'ok',jbod:'ok',unconfigured:'ok',rebuilding:'warning',copyback:'warning',foreign:'warning',shielded:'warning',predictive_failure:'warning',degraded:'warning',failed:'critical',missing:'critical',offline:'critical',unknown:'unknown'},
  cache_battery:{ok:'ok',charging:'ok',learning:'ok',degraded:'warning',failed:'critical',missing:'critical',unknown:'unknown'},
  enclosure:{ok:'ok',degraded:'warning',failed:'critical',unknown:'unknown'},
  bmc:{ok:'ok',unknown:'unknown'}, collector:{ok:'ok',failed:'warning',backing_off:'warning'},
};
export function worstHardwareHealth(values: readonly HardwareHealth[]): HardwareHealth {
  return values.reduce<HardwareHealth>((a,b) => HARDWARE_HEALTH_RANK[b] > HARDWARE_HEALTH_RANK[a] ? b : a, 'unknown');
}
export function deriveHardwareHealth(input: {
  componentType: HardwareComponentType; state: string; predictiveFailure: boolean;
  memberErrors?: boolean; osHealthStatus?: 'healthy' | 'warning' | 'unhealthy' | null;
  smartPassed?: boolean | null;
}): HardwareHealth {
  return worstHardwareHealth([
    HARDWARE_STATE_HEALTH[input.componentType][input.state] ?? 'unknown',
    input.predictiveFailure || input.memberErrors || input.osHealthStatus === 'warning' ? 'warning' : 'unknown',
    input.osHealthStatus === 'unhealthy' || input.smartPassed === false ? 'critical' : 'unknown',
  ]);
}
