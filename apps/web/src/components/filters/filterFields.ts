// Canonical web mirror of the device filter catalog.
//
// THE single web copy of `apps/api/src/services/filterEngine.ts` FILTER_FIELDS
// (the backend is the source of truth; `validateFilter` there enforces the
// field/operator set, so this must track it). Both the advanced FilterBuilder
// (`DEFAULT_FILTER_FIELDS`) and the chip bar (`V2_FILTER_FIELDS`) re-export this
// — do not maintain a second hand-copy.
//
// Operator lists mirror the backend per type, MINUS numeric `between`: the
// shared ValueInput renders `between` as a date-range picker only, so exposing
// it on a number field would render the wrong widget. Every operator listed
// here is both backend-valid and renderable by ValueInput/OperatorSelector.
import type { FilterFieldDefinition, FilterOperator } from '@breeze/shared';

const S: FilterOperator[] = ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'matches', 'in', 'notIn', 'isNull', 'isNotNull'];
const N: FilterOperator[] = ['equals', 'notEquals', 'greaterThan', 'greaterThanOrEquals', 'lessThan', 'lessThanOrEquals', 'isNull', 'isNotNull'];
const B: FilterOperator[] = ['equals', 'notEquals'];
const DT: FilterOperator[] = ['equals', 'notEquals', 'before', 'after', 'between', 'withinLast', 'notWithinLast', 'isNull', 'isNotNull'];
const A: FilterOperator[] = ['hasAny', 'hasAll', 'isEmpty', 'isNotEmpty', 'contains'];
const E: FilterOperator[] = ['equals', 'notEquals', 'in', 'notIn'];

export const FILTER_FIELDS: FilterFieldDefinition[] = [
  // Core
  { key: 'hostname', label: 'Hostname', category: 'core', type: 'string', operators: S },
  { key: 'displayName', label: 'Display Name', category: 'core', type: 'string', operators: S },
  { key: 'status', label: 'Status', category: 'core', type: 'enum', operators: E,
    enumValues: ['online', 'offline', 'maintenance', 'decommissioned', 'quarantined', 'updating', 'pending'] },
  { key: 'agentVersion', label: 'Agent Version', category: 'core', type: 'string', operators: S },
  { key: 'enrolledAt', label: 'Enrolled At', category: 'core', type: 'datetime', operators: DT },
  { key: 'lastSeenAt', label: 'Last Seen At', category: 'core', type: 'datetime', operators: DT },
  { key: 'tags', label: 'Tags', category: 'core', type: 'array', operators: A },
  { key: 'deviceRole', label: 'Device Role', category: 'core', type: 'enum', operators: E,
    enumValues: ['workstation', 'server', 'printer', 'router', 'switch', 'firewall', 'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown'] },
  { key: 'lastUser', label: 'Last User', category: 'core', type: 'string', operators: S },
  { key: 'isHeadless', label: 'Headless', category: 'core', type: 'boolean', operators: B },
  { key: 'uptimeSeconds', label: 'Uptime (seconds)', category: 'core', type: 'number', operators: N },
  { key: 'watchdogStatus', label: 'Watchdog Status', category: 'core', type: 'enum', operators: E, enumValues: ['connected', 'failover', 'offline'] },
  { key: 'quarantinedAt', label: 'Quarantined At', category: 'core', type: 'datetime', operators: DT },
  // Device-state predicates — backend models these as booleans (EXISTS against
  // device_patches / alerts / patch_job_results); operators equals/notEquals so
  // the negative case ("is not") is expressible.
  { key: 'patches.pending', label: 'Needs Patches', category: 'core', type: 'boolean', operators: B },
  { key: 'alerts.critical', label: 'Critical Alert Active', category: 'core', type: 'boolean', operators: B },
  { key: 'system.rebootRequired', label: 'Reboot Required', category: 'core', type: 'boolean', operators: B },

  // OS
  { key: 'osType', label: 'OS Type', category: 'os', type: 'enum', operators: E, enumValues: ['windows', 'macos', 'linux'] },
  { key: 'osVersion', label: 'OS Version', category: 'os', type: 'string', operators: S },
  { key: 'osBuild', label: 'OS Build', category: 'os', type: 'string', operators: S },
  { key: 'architecture', label: 'Architecture', category: 'os', type: 'enum', operators: E, enumValues: ['x64', 'x86', 'arm64'] },

  // Hardware
  { key: 'hardware.manufacturer', label: 'Manufacturer', category: 'hardware', type: 'string', operators: S },
  { key: 'hardware.model', label: 'Model', category: 'hardware', type: 'string', operators: S },
  { key: 'hardware.serialNumber', label: 'Serial Number', category: 'hardware', type: 'string', operators: S },
  { key: 'hardware.cpuModel', label: 'CPU Model', category: 'hardware', type: 'string', operators: S },
  { key: 'hardware.cpuCores', label: 'CPU Cores', category: 'hardware', type: 'number', operators: N },
  { key: 'hardware.ramTotalMb', label: 'RAM (MB)', category: 'hardware', type: 'number', operators: N },
  { key: 'hardware.diskTotalGb', label: 'Disk Size (GB)', category: 'hardware', type: 'number', operators: N },
  { key: 'hardware.gpuModel', label: 'GPU Model', category: 'hardware', type: 'string', operators: S },

  // Network
  { key: 'network.ipAddress', label: 'IP Address', category: 'network', type: 'string', operators: S },
  { key: 'network.publicIp', label: 'Public IP', category: 'network', type: 'string', operators: S },
  { key: 'network.macAddress', label: 'MAC Address', category: 'network', type: 'string', operators: S },
  { key: 'lastSeenIp', label: 'Last Seen IP', category: 'network', type: 'string', operators: S },

  // Metrics
  { key: 'metrics.cpuPercent', label: 'CPU %', category: 'metrics', type: 'number', operators: N },
  { key: 'metrics.ramPercent', label: 'RAM %', category: 'metrics', type: 'number', operators: N },
  { key: 'metrics.diskPercent', label: 'Disk %', category: 'metrics', type: 'number', operators: N },

  // Software — multi-select chip uses hasAny/hasAll; contains/notContains keep
  // the single-name form working.
  { key: 'software.installed', label: 'Has Software Installed', category: 'software', type: 'string', operators: ['contains', 'notContains', 'equals', 'in', 'hasAny', 'hasAll'] },
  { key: 'software.notInstalled', label: 'Missing Software', category: 'software', type: 'string', operators: ['contains', 'equals', 'in', 'hasAny'] },

  // Hierarchy
  { key: 'orgId', label: 'Organization', category: 'hierarchy', type: 'string', operators: ['equals', 'in'] },
  { key: 'siteId', label: 'Site', category: 'hierarchy', type: 'string', operators: ['equals', 'in'] },
  { key: 'groupId', label: 'Device Group', category: 'hierarchy', type: 'string', operators: ['equals', 'in'] },

  // Computed
  { key: 'daysSinceLastSeen', label: 'Days Since Last Seen', category: 'computed', type: 'number', operators: N, computed: true },
  { key: 'daysSinceEnrolled', label: 'Days Since Enrolled', category: 'computed', type: 'number', operators: N, computed: true },
];
