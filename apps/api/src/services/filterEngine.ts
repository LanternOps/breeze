import { and, eq, or, not, gt, gte, lt, lte, like, ilike, inArray, isNull, isNotNull, sql, SQL } from 'drizzle-orm';
import { db } from '../db';
import { devices, deviceHardware, deviceNetwork, deviceMetrics, deviceSoftware, deviceGroups, deviceGroupMemberships } from '../db/schema';
import type {
  FilterOperator,
  FilterFieldCategory,
  FilterFieldType,
  FilterFieldDefinition,
  FilterCondition,
  FilterValue,
  FilterConditionGroup,
  FilterEvaluationResult,
  FilterPreviewResult,
  FilterPreviewDevice
} from '@breeze/shared/types/filters';
export type {
  FilterOperator,
  FilterFieldCategory,
  FilterFieldType,
  FilterFieldDefinition,
  FilterCondition,
  FilterValue,
  FilterConditionGroup,
  FilterEvaluationResult,
  FilterPreviewResult,
  FilterPreviewDevice
} from '@breeze/shared/types/filters';

// ============================================
// Field Definitions
// ============================================

const OPERATORS_BY_TYPE: Record<FilterFieldType, FilterOperator[]> = {
  string: ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'matches', 'in', 'notIn', 'isNull', 'isNotNull'],
  number: ['equals', 'notEquals', 'greaterThan', 'greaterThanOrEquals', 'lessThan', 'lessThanOrEquals', 'between', 'isNull', 'isNotNull'],
  boolean: ['equals', 'notEquals', 'isNull', 'isNotNull'],
  date: ['equals', 'notEquals', 'before', 'after', 'between', 'withinLast', 'notWithinLast', 'isNull', 'isNotNull'],
  datetime: ['equals', 'notEquals', 'before', 'after', 'between', 'withinLast', 'notWithinLast', 'isNull', 'isNotNull'],
  array: ['hasAny', 'hasAll', 'isEmpty', 'isNotEmpty', 'contains'],
  enum: ['equals', 'notEquals', 'in', 'notIn']
};

export const FILTER_FIELDS: FilterFieldDefinition[] = [
  // Core Device fields
  { key: 'hostname', label: 'Hostname', category: 'core', type: 'string', operators: OPERATORS_BY_TYPE.string },
  { key: 'displayName', label: 'Display Name', category: 'core', type: 'string', operators: OPERATORS_BY_TYPE.string },
  { key: 'status', label: 'Status', category: 'core', type: 'enum', operators: OPERATORS_BY_TYPE.enum, enumValues: ['online', 'offline', 'maintenance', 'decommissioned'] },
  { key: 'agentVersion', label: 'Agent Version', category: 'core', type: 'string', operators: OPERATORS_BY_TYPE.string },
  { key: 'enrolledAt', label: 'Enrolled At', category: 'core', type: 'datetime', operators: OPERATORS_BY_TYPE.datetime },
  { key: 'lastSeenAt', label: 'Last Seen At', category: 'core', type: 'datetime', operators: OPERATORS_BY_TYPE.datetime },
  { key: 'tags', label: 'Tags', category: 'core', type: 'array', operators: OPERATORS_BY_TYPE.array },

  // OS fields
  { key: 'osType', label: 'OS Type', category: 'os', type: 'enum', operators: OPERATORS_BY_TYPE.enum, enumValues: ['windows', 'macos', 'linux'] },
  { key: 'osVersion', label: 'OS Version', category: 'os', type: 'string', operators: OPERATORS_BY_TYPE.string },
  { key: 'osBuild', label: 'OS Build', category: 'os', type: 'string', operators: OPERATORS_BY_TYPE.string },
  { key: 'architecture', label: 'Architecture', category: 'os', type: 'enum', operators: OPERATORS_BY_TYPE.enum, enumValues: ['x64', 'x86', 'arm64'] },

  // Hardware fields
  { key: 'hardware.manufacturer', label: 'Manufacturer', category: 'hardware', type: 'string', operators: OPERATORS_BY_TYPE.string },
  { key: 'hardware.model', label: 'Model', category: 'hardware', type: 'string', operators: OPERATORS_BY_TYPE.string },
  { key: 'hardware.serialNumber', label: 'Serial Number', category: 'hardware', type: 'string', operators: OPERATORS_BY_TYPE.string },
  { key: 'hardware.cpuModel', label: 'CPU Model', category: 'hardware', type: 'string', operators: OPERATORS_BY_TYPE.string },
  { key: 'hardware.cpuCores', label: 'CPU Cores', category: 'hardware', type: 'number', operators: OPERATORS_BY_TYPE.number },
  { key: 'hardware.ramTotalMb', label: 'RAM (MB)', category: 'hardware', type: 'number', operators: OPERATORS_BY_TYPE.number },
  { key: 'hardware.diskTotalGb', label: 'Disk Size (GB)', category: 'hardware', type: 'number', operators: OPERATORS_BY_TYPE.number },
  { key: 'hardware.gpuModel', label: 'GPU Model', category: 'hardware', type: 'string', operators: OPERATORS_BY_TYPE.string },

  // Network fields
  { key: 'network.ipAddress', label: 'IP Address', category: 'network', type: 'string', operators: OPERATORS_BY_TYPE.string },
  { key: 'network.publicIp', label: 'Public IP', category: 'network', type: 'string', operators: OPERATORS_BY_TYPE.string },
  { key: 'network.macAddress', label: 'MAC Address', category: 'network', type: 'string', operators: OPERATORS_BY_TYPE.string },

  // Metrics fields (from latest metrics)
  { key: 'metrics.cpuPercent', label: 'CPU %', category: 'metrics', type: 'number', operators: OPERATORS_BY_TYPE.number },
  { key: 'metrics.ramPercent', label: 'RAM %', category: 'metrics', type: 'number', operators: OPERATORS_BY_TYPE.number },
  { key: 'metrics.diskPercent', label: 'Disk %', category: 'metrics', type: 'number', operators: OPERATORS_BY_TYPE.number },

  // Software fields
  { key: 'software.installed', label: 'Has Software Installed', category: 'software', type: 'string', operators: ['contains', 'notContains'], description: 'Check if software name contains value' },
  { key: 'software.notInstalled', label: 'Missing Software', category: 'software', type: 'string', operators: ['contains'], description: 'Check if software is not installed' },

  // Hierarchy fields
  { key: 'orgId', label: 'Organization', category: 'hierarchy', type: 'string', operators: ['equals', 'in'] },
  { key: 'siteId', label: 'Site', category: 'hierarchy', type: 'string', operators: ['equals', 'in'] },
  { key: 'groupId', label: 'Device Group', category: 'hierarchy', type: 'string', operators: ['equals', 'in'] },

  // Computed fields
  { key: 'daysSinceLastSeen', label: 'Days Since Last Seen', category: 'computed', type: 'number', operators: OPERATORS_BY_TYPE.number, computed: true },
  { key: 'daysSinceEnrolled', label: 'Days Since Enrolled', category: 'computed', type: 'number', operators: OPERATORS_BY_TYPE.number, computed: true }
];

export function getFieldDefinition(fieldKey: string): FilterFieldDefinition | undefined {
  // Check for custom fields
  if (fieldKey.startsWith('custom.')) {
    return {
      key: fieldKey,
      label: fieldKey.replace('custom.', ''),
      category: 'custom',
      type: 'string', // Default type, actual type determined at runtime
      operators: OPERATORS_BY_TYPE.string
    };
  }
  return FILTER_FIELDS.find(f => f.key === fieldKey);
}

export function getFieldsByCategory(category: FilterFieldCategory): FilterFieldDefinition[] {
  return FILTER_FIELDS.filter(f => f.category === category);
}

export function getAllFilterableFields(): FilterFieldDefinition[] {
  return FILTER_FIELDS;
}

// ============================================
// SQL Query Builder
// ============================================

type ColumnRef = ReturnType<typeof devices.id.getSQL> | SQL<unknown>;

function getColumnForField(field: string): { table: 'devices' | 'hardware' | 'network' | 'metrics' | 'software' | 'groups'; column: string; computed?: SQL<unknown> } {
  // Handle prefixed fields
  if (field.startsWith('hardware.')) {
    return { table: 'hardware', column: field.replace('hardware.', '') };
  }
  if (field.startsWith('network.')) {
    return { table: 'network', column: field.replace('network.', '') };
  }
  if (field.startsWith('metrics.')) {
    return { table: 'metrics', column: field.replace('metrics.', '') };
  }
  if (field.startsWith('software.')) {
    return { table: 'software', column: field.replace('software.', '') };
  }
  if (field.startsWith('custom.')) {
    const customField = field.replace('custom.', '');
    return {
      table: 'devices',
      column: 'customFields',
      computed: sql`${devices.customFields}->>${sql.raw(`'${customField}'`)}`
    };
  }

  // Computed fields
  if (field === 'daysSinceLastSeen') {
    return {
      table: 'devices',
      column: 'lastSeenAt',
      computed: sql`EXTRACT(EPOCH FROM (NOW() - ${devices.lastSeenAt})) / 86400`
    };
  }
  if (field === 'daysSinceEnrolled') {
    return {
      table: 'devices',
      column: 'enrolledAt',
      computed: sql`EXTRACT(EPOCH FROM (NOW() - ${devices.enrolledAt})) / 86400`
    };
  }
  if (field === 'groupId') {
    return { table: 'groups', column: 'groupId' };
  }

  // Default to devices table
  return { table: 'devices', column: field };
}

function buildConditionSQL(condition: FilterCondition): SQL<unknown> {
  const { field, operator, value } = condition;
  const fieldInfo = getColumnForField(field);

  // Get the actual column reference
  let columnRef: SQL<unknown>;

  if (fieldInfo.computed) {
    columnRef = fieldInfo.computed;
  } else if (fieldInfo.table === 'devices') {
    const col = devices[fieldInfo.column as keyof typeof devices];
    if (!col) {
      throw new Error(`Unknown device field: ${fieldInfo.column}`);
    }
    columnRef = sql`${col}`;
  } else if (fieldInfo.table === 'hardware') {
    const col = deviceHardware[fieldInfo.column as keyof typeof deviceHardware];
    if (!col) {
      throw new Error(`Unknown hardware field: ${fieldInfo.column}`);
    }
    columnRef = sql`${col}`;
  } else if (fieldInfo.table === 'network') {
    const col = deviceNetwork[fieldInfo.column as keyof typeof deviceNetwork];
    if (!col) {
      throw new Error(`Unknown network field: ${fieldInfo.column}`);
    }
    columnRef = sql`${col}`;
  } else if (fieldInfo.table === 'groups') {
    columnRef = sql`${deviceGroupMemberships.groupId}`;
  } else {
    throw new Error(`Unsupported table: ${fieldInfo.table}`);
  }

  // Build the SQL condition based on operator
  switch (operator) {
    case 'equals':
      return sql`${columnRef} = ${value}`;
    case 'notEquals':
      return sql`${columnRef} != ${value}`;
    case 'greaterThan':
      return sql`${columnRef} > ${value}`;
    case 'greaterThanOrEquals':
      return sql`${columnRef} >= ${value}`;
    case 'lessThan':
      return sql`${columnRef} < ${value}`;
    case 'lessThanOrEquals':
      return sql`${columnRef} <= ${value}`;
    case 'contains':
      return sql`${columnRef} ILIKE ${'%' + value + '%'}`;
    case 'notContains':
      return sql`${columnRef} NOT ILIKE ${'%' + value + '%'}`;
    case 'startsWith':
      return sql`${columnRef} ILIKE ${value + '%'}`;
    case 'endsWith':
      return sql`${columnRef} ILIKE ${'%' + value}`;
    case 'matches':
      return sql`${columnRef} ~ ${value}`;
    case 'in':
      if (Array.isArray(value)) {
        return sql`${columnRef} = ANY(${value})`;
      }
      throw new Error('Value must be array for "in" operator');
    case 'notIn':
      if (Array.isArray(value)) {
        return sql`${columnRef} != ALL(${value})`;
      }
      throw new Error('Value must be array for "notIn" operator');
    case 'hasAny':
      if (Array.isArray(value)) {
        return sql`${columnRef} && ${value}`;
      }
      throw new Error('Value must be array for "hasAny" operator');
    case 'hasAll':
      if (Array.isArray(value)) {
        return sql`${columnRef} @> ${value}`;
      }
      throw new Error('Value must be array for "hasAll" operator');
    case 'isEmpty':
      return sql`${columnRef} = '{}'::text[]`;
    case 'isNotEmpty':
      return sql`${columnRef} != '{}'::text[]`;
    case 'isNull':
      return sql`${columnRef} IS NULL`;
    case 'isNotNull':
      return sql`${columnRef} IS NOT NULL`;
    case 'before':
      return sql`${columnRef} < ${value}`;
    case 'after':
      return sql`${columnRef} > ${value}`;
    case 'between':
      if (typeof value === 'object' && value !== null && 'from' in value && 'to' in value) {
        return sql`${columnRef} BETWEEN ${value.from} AND ${value.to}`;
      }
      throw new Error('Value must have from/to for "between" operator');
    case 'withinLast':
      if (typeof value === 'object' && value !== null && 'amount' in value && 'unit' in value) {
        const interval = getIntervalSQL(value.amount, value.unit);
        return sql`${columnRef} >= NOW() - ${interval}`;
      }
      throw new Error('Value must have amount/unit for "withinLast" operator');
    case 'notWithinLast':
      if (typeof value === 'object' && value !== null && 'amount' in value && 'unit' in value) {
        const interval = getIntervalSQL(value.amount, value.unit);
        return sql`${columnRef} < NOW() - ${interval}`;
      }
      throw new Error('Value must have amount/unit for "notWithinLast" operator');
    default:
      throw new Error(`Unsupported operator: ${operator}`);
  }
}

function getIntervalSQL(amount: number, unit: string): SQL<unknown> {
  const validUnits = ['minutes', 'hours', 'days', 'weeks', 'months'];
  if (!validUnits.includes(unit)) {
    throw new Error(`Invalid time unit: ${unit}`);
  }
  return sql.raw(`INTERVAL '${amount} ${unit}'`);
}

function buildGroupSQL(group: FilterConditionGroup): SQL<unknown> {
  if (group.conditions.length === 0) {
    return sql`TRUE`;
  }

  const conditionSQLs = group.conditions.map(condition => {
    if ('operator' in condition && (condition.operator === 'AND' || condition.operator === 'OR')) {
      // It's a nested group
      return buildGroupSQL(condition as FilterConditionGroup);
    } else {
      // It's a single condition
      return buildConditionSQL(condition as FilterCondition);
    }
  });

  if (group.operator === 'AND') {
    return sql.join(conditionSQLs, sql` AND `);
  } else {
    return sql`(${sql.join(conditionSQLs, sql` OR `)})`;
  }
}

// ============================================
// Filter Evaluation Functions
// ============================================

export interface EvaluateFilterOptions {
  orgId: string;
  limit?: number;
  offset?: number;
}

/**
 * Evaluate a filter and return matching device IDs
 */
export async function evaluateFilter(
  filter: FilterConditionGroup,
  options: EvaluateFilterOptions
): Promise<FilterEvaluationResult> {
  const { orgId, limit, offset } = options;

  // Determine which tables we need to join
  const fieldsUsed = extractFieldsFromFilter(filter);
  const needsHardwareJoin = fieldsUsed.some(f => f.startsWith('hardware.'));
  const needsNetworkJoin = fieldsUsed.some(f => f.startsWith('network.'));
  const needsMetricsJoin = fieldsUsed.some(f => f.startsWith('metrics.'));
  const needsSoftwareJoin = fieldsUsed.some(f => f.startsWith('software.'));
  const needsGroupsJoin = fieldsUsed.includes('groupId');

  // Build the WHERE clause
  const filterSQL = buildGroupSQL(filter);

  // Build the query with required joins
  let query = db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), filterSQL));

  // Note: In a real implementation, we'd add the joins here
  // For now, we'll handle simple device-table-only queries

  const results = await query;

  return {
    deviceIds: results.map(r => r.id),
    totalCount: results.length,
    evaluatedAt: new Date()
  };
}

/**
 * Evaluate a filter and return preview results with device details
 */
export async function evaluateFilterWithPreview(
  filter: FilterConditionGroup,
  options: EvaluateFilterOptions & { previewLimit?: number }
): Promise<FilterPreviewResult> {
  const { orgId, previewLimit = 10 } = options;

  const filterSQL = buildGroupSQL(filter);

  // Get count first
  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), filterSQL));

  // Get preview devices
  const previewDevices = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      displayName: devices.displayName,
      osType: devices.osType,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt
    })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), filterSQL))
    .limit(previewLimit);

  return {
    totalCount: Number(countResult?.count ?? 0),
    devices: previewDevices.map(d => ({
      id: d.id,
      hostname: d.hostname,
      displayName: d.displayName,
      osType: d.osType,
      status: d.status,
      lastSeenAt: d.lastSeenAt
    })),
    evaluatedAt: new Date()
  };
}

/**
 * Check if a single device matches a filter
 */
export async function deviceMatchesFilter(
  deviceId: string,
  filter: FilterConditionGroup
): Promise<boolean> {
  const filterSQL = buildGroupSQL(filter);

  const [result] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.id, deviceId), filterSQL))
    .limit(1);

  return Boolean(result);
}

/**
 * Extract all field keys used in a filter (for optimization)
 */
export function extractFieldsFromFilter(filter: FilterConditionGroup | FilterCondition): string[] {
  const fields: string[] = [];

  if ('conditions' in filter) {
    // It's a group
    for (const condition of filter.conditions) {
      fields.push(...extractFieldsFromFilter(condition as FilterConditionGroup | FilterCondition));
    }
  } else if ('field' in filter) {
    // It's a single condition
    fields.push(filter.field);
  }

  return [...new Set(fields)]; // Remove duplicates
}

/**
 * Validate a filter structure
 */
export function validateFilter(filter: FilterConditionGroup | FilterCondition): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if ('conditions' in filter) {
    // Validate group
    if (!['AND', 'OR'].includes(filter.operator)) {
      errors.push(`Invalid group operator: ${filter.operator}`);
    }
    if (!Array.isArray(filter.conditions) || filter.conditions.length === 0) {
      errors.push('Group must have at least one condition');
    }

    // Validate nested conditions
    for (const condition of filter.conditions) {
      const nested = validateFilter(condition as FilterConditionGroup | FilterCondition);
      errors.push(...nested.errors);
    }
  } else if ('field' in filter) {
    // Validate single condition
    const fieldDef = getFieldDefinition(filter.field);
    if (!fieldDef && !filter.field.startsWith('custom.')) {
      errors.push(`Unknown field: ${filter.field}`);
    }
    if (fieldDef && !fieldDef.operators.includes(filter.operator)) {
      errors.push(`Operator ${filter.operator} not valid for field ${filter.field}`);
    }
  } else {
    errors.push('Invalid filter structure');
  }

  return { valid: errors.length === 0, errors };
}
