// Field catalog for the v2 chip-based filter UI.
//
// This is a web-side mirror of `apps/api/src/services/filterEngine.ts`
// FILTER_FIELDS. Kept here (rather than importing) so the web bundle
// doesn't pull api code. Should track the API list. POC scope.
import type { FilterFieldDefinition, FilterOperator } from '@breeze/shared';

const OP_STRING: FilterOperator[] = ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'isNull', 'isNotNull'];
const OP_NUMBER: FilterOperator[] = ['equals', 'notEquals', 'greaterThan', 'greaterThanOrEquals', 'lessThan', 'lessThanOrEquals'];
const OP_DATETIME: FilterOperator[] = ['before', 'after', 'withinLast', 'notWithinLast', 'isNull', 'isNotNull'];
const OP_ARRAY: FilterOperator[] = ['hasAny', 'hasAll', 'isEmpty', 'isNotEmpty'];
const OP_ENUM: FilterOperator[] = ['equals', 'notEquals', 'in', 'notIn'];

export const V2_FILTER_FIELDS: FilterFieldDefinition[] = [
  // Core
  { key: 'hostname', label: 'Hostname', category: 'core', type: 'string', operators: OP_STRING },
  { key: 'displayName', label: 'Display Name', category: 'core', type: 'string', operators: OP_STRING },
  { key: 'status', label: 'Status', category: 'core', type: 'enum', operators: OP_ENUM,
    enumValues: ['online', 'offline', 'maintenance', 'decommissioned'] },
  { key: 'agentVersion', label: 'Agent Version', category: 'core', type: 'string', operators: OP_STRING },
  { key: 'enrolledAt', label: 'Enrolled At', category: 'core', type: 'datetime', operators: OP_DATETIME },
  { key: 'lastSeenAt', label: 'Last Seen At', category: 'core', type: 'datetime', operators: OP_DATETIME },
  { key: 'tags', label: 'Tags', category: 'core', type: 'array', operators: OP_ARRAY },
  { key: 'deviceRole', label: 'Device Role', category: 'core', type: 'enum', operators: OP_ENUM,
    enumValues: ['workstation', 'server', 'printer', 'router', 'switch', 'firewall', 'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown'] },

  // OS
  { key: 'osType', label: 'OS Type', category: 'os', type: 'enum', operators: OP_ENUM, enumValues: ['windows', 'macos', 'linux'] },
  { key: 'osVersion', label: 'OS Version', category: 'os', type: 'string', operators: OP_STRING },
  { key: 'osBuild', label: 'OS Build', category: 'os', type: 'string', operators: OP_STRING },
  { key: 'architecture', label: 'Architecture', category: 'os', type: 'enum', operators: OP_ENUM, enumValues: ['x64', 'x86', 'arm64'] },

  // Hardware
  { key: 'hardware.manufacturer', label: 'Manufacturer', category: 'hardware', type: 'string', operators: OP_STRING },
  { key: 'hardware.model', label: 'Model', category: 'hardware', type: 'string', operators: OP_STRING },
  { key: 'hardware.serialNumber', label: 'Serial Number', category: 'hardware', type: 'string', operators: OP_STRING },
  { key: 'hardware.cpuModel', label: 'CPU Model', category: 'hardware', type: 'string', operators: OP_STRING },
  { key: 'hardware.cpuCores', label: 'CPU Cores', category: 'hardware', type: 'number', operators: OP_NUMBER },
  { key: 'hardware.ramTotalMb', label: 'RAM (MB)', category: 'hardware', type: 'number', operators: OP_NUMBER },
  { key: 'hardware.diskTotalGb', label: 'Disk Size (GB)', category: 'hardware', type: 'number', operators: OP_NUMBER },
  { key: 'hardware.gpuModel', label: 'GPU Model', category: 'hardware', type: 'string', operators: OP_STRING },

  // Network
  { key: 'network.ipAddress', label: 'IP Address', category: 'network', type: 'string', operators: OP_STRING },
  { key: 'network.publicIp', label: 'Public IP', category: 'network', type: 'string', operators: OP_STRING },
  { key: 'network.macAddress', label: 'MAC Address', category: 'network', type: 'string', operators: OP_STRING },

  // Metrics
  { key: 'metrics.cpuPercent', label: 'CPU %', category: 'metrics', type: 'number', operators: OP_NUMBER },
  { key: 'metrics.ramPercent', label: 'RAM %', category: 'metrics', type: 'number', operators: OP_NUMBER },
  { key: 'metrics.diskPercent', label: 'Disk %', category: 'metrics', type: 'number', operators: OP_NUMBER },

  // Software — `hasAny`/`hasAll` support the multi-select chip (spec 4.2).
  // `contains` / `notContains` kept for backwards compatibility with the
  // pre-multi-select single-name form.
  { key: 'software.installed', label: 'Has Software Installed', category: 'software', type: 'string', operators: ['hasAny', 'hasAll', 'contains', 'notContains'] },
  { key: 'software.notInstalled', label: 'Missing Software', category: 'software', type: 'string', operators: ['hasAny', 'contains'] },

  // Hierarchy
  { key: 'orgId', label: 'Organization', category: 'hierarchy', type: 'string', operators: ['equals', 'in'] },
  { key: 'siteId', label: 'Site', category: 'hierarchy', type: 'string', operators: ['equals', 'in'] },
  { key: 'groupId', label: 'Device Group', category: 'hierarchy', type: 'string', operators: ['equals', 'in'] },

  // Computed
  { key: 'daysSinceLastSeen', label: 'Days Since Last Seen', category: 'computed', type: 'number', operators: OP_NUMBER, computed: true },
  { key: 'daysSinceEnrolled', label: 'Days Since Enrolled', category: 'computed', type: 'number', operators: OP_NUMBER, computed: true },

  // Device-state predicates — virtual EXISTS fields (server resolves these
  // against device_patches / alerts / patch_job_results). Single 'yes' value
  // drives the quick-add chips; server also accepts notEquals for negation.
  { key: 'patches.pending', label: 'Needs Patches', category: 'computed', type: 'enum', operators: ['equals'], enumValues: ['yes'], computed: true },
  { key: 'alerts.critical', label: 'Critical Alert Active', category: 'computed', type: 'enum', operators: ['equals'], enumValues: ['yes'], computed: true },
  { key: 'system.rebootRequired', label: 'Reboot Required', category: 'computed', type: 'enum', operators: ['equals'], enumValues: ['yes'], computed: true }
];

const CATEGORY_LABEL: Record<string, string> = {
  core: 'Core',
  os: 'OS',
  hardware: 'Hardware',
  network: 'Network',
  metrics: 'Metrics',
  software: 'Software',
  hierarchy: 'Hierarchy',
  computed: 'Computed',
  custom: 'Custom Fields'
};

export function fieldCategoryLabel(category: string): string {
  return CATEGORY_LABEL[category] ?? category;
}

export function getFieldDef(key: string): FilterFieldDefinition | undefined {
  return V2_FILTER_FIELDS.find(f => f.key === key);
}

const OPERATOR_LABEL: Record<FilterOperator, string> = {
  equals: 'is',
  notEquals: 'is not',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  matches: 'matches regex',
  greaterThan: '>',
  greaterThanOrEquals: '>=',
  lessThan: '<',
  lessThanOrEquals: '<=',
  in: 'is any of',
  notIn: 'is none of',
  hasAny: 'has any of',
  hasAll: 'has all of',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
  isNull: 'is null',
  isNotNull: 'is not null',
  before: 'before',
  after: 'after',
  between: 'between',
  withinLast: 'within last',
  notWithinLast: 'not within last'
};

export function operatorLabel(op: FilterOperator): string {
  return OPERATOR_LABEL[op] ?? op;
}
