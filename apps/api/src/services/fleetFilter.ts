/**
 * The API side of the typed fleet filter (#12418 W01).
 *
 * `fleetFilterSchema` (shared) is the facade the model writes. This module
 * compiles it to the filter engine's `FilterConditionGroup`, which the
 * engine's own `buildGroupSQL` renders, so a fleet count and (W02) a fleet
 * step's frozen set come from one WHERE clause. It also reports which engine
 * fields a filter used and which of those a device reports about itself with
 * targeting value (`isExecutionRefusedFilterField`): the read side labels
 * them, the action side refuses them.
 *
 * Pure: no query, no device read.
 */
import { z } from 'zod';
import {
  FLEET_FILTER_DESCRIPTIONS,
  FLEET_FILTER_GROUP_BY,
  FLEET_FILTER_OS_TYPES,
  FLEET_FILTER_STATUSES,
  fleetFilterSchema,
  type FleetFilter,
} from '@breeze/shared';
import { isExecutionRefusedFilterField, type FilterCondition, type FilterConditionGroup } from './filterEngine';

export const FLEET_FILTER_PARAM_DESCRIPTION =
  'Typed device filter; present fields are ANDed. Fields marked Device-reported can be counted but never select action targets';
export const FLEET_GROUP_BY_PARAM_DESCRIPTION = 'Break the count down by one device field: top 50 rows by count plus otherCount';

/** One engine condition per present field, in the facade's declared order. */
export function compileFleetFilter(filter: FleetFilter): FilterConditionGroup {
  const conditions: FilterCondition[] = [];
  const add = (field: string, operator: FilterCondition['operator'], value: FilterCondition['value']) =>
    conditions.push({ field, operator, value });

  if (filter.status !== undefined) add('status', 'equals', filter.status);
  if (filter.osType !== undefined) add('osType', 'equals', filter.osType);
  if (filter.osVersionContains !== undefined) add('osVersion', 'contains', filter.osVersionContains);
  if (filter.hostnameContains !== undefined) add('hostname', 'contains', filter.hostnameContains);
  if (filter.siteId !== undefined) add('siteId', 'equals', filter.siteId);
  if (filter.groupId !== undefined) add('groupId', 'equals', filter.groupId);
  if (filter.tags !== undefined) add('tags', 'hasAll', [...filter.tags]);
  if (filter.agentVersion !== undefined) add('agentVersion', 'equals', filter.agentVersion);
  if (filter.softwareInstalled !== undefined) add('software.installed', 'contains', filter.softwareInstalled);
  if (filter.softwareMissing !== undefined) add('software.notInstalled', 'contains', filter.softwareMissing);
  if (filter.softwareVersionBelow !== undefined) {
    const { name, version } = filter.softwareVersionBelow;
    add('software.version', 'below', { name, version });
  }
  if (filter.pendingPatches !== undefined) add('patches.pending', 'equals', filter.pendingPatches);
  if (filter.criticalAlerts !== undefined) add('alerts.critical', 'equals', filter.criticalAlerts);
  if (filter.rebootRequired !== undefined) add('system.rebootRequired', 'equals', filter.rebootRequired);
  if (filter.lastSeenDaysOver !== undefined) add('daysSinceLastSeen', 'greaterThan', filter.lastSeenDaysOver);

  return { operator: 'AND', conditions };
}

/** Engine keys the filter uses, sorted and unique. */
export function fleetFilterFieldsUsed(filter: FleetFilter): string[] {
  const keys = compileFleetFilter(filter).conditions.map((c) => (c as FilterCondition).field);
  return [...new Set(keys)].sort();
}

/** The subset of `fleetFilterFieldsUsed` a device reports about itself with targeting value. */
export function fleetFilterExecutionRefusedFields(filter: FleetFilter): string[] {
  return fleetFilterFieldsUsed(filter).filter(isExecutionRefusedFilterField);
}

const d = FLEET_FILTER_DESCRIPTIONS;

/**
 * The registry `definition.input_schema` entry for `filter`. Hand-written to
 * match `fleetFilterSchema` (names, descriptions and bounds); a test holds the
 * two together.
 */
export function fleetFilterParamSchema(): Record<string, unknown> {
  const text = (min: number, max: number, description: string) => ({ type: 'string', minLength: min, maxLength: max, description });
  return {
    type: 'object',
    additionalProperties: false,
    description: FLEET_FILTER_PARAM_DESCRIPTION,
    properties: {
      status: { type: 'string', enum: [...FLEET_FILTER_STATUSES], description: d.status },
      osType: { type: 'string', enum: [...FLEET_FILTER_OS_TYPES], description: d.osType },
      osVersionContains: text(1, 100, d.osVersionContains),
      hostnameContains: text(1, 200, d.hostnameContains),
      siteId: { type: 'string', format: 'uuid', description: d.siteId },
      groupId: { type: 'string', format: 'uuid', description: d.groupId },
      tags: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: { type: 'string', minLength: 1, maxLength: 100 },
        description: d.tags,
      },
      agentVersion: text(1, 50, d.agentVersion),
      softwareInstalled: text(1, 200, d.softwareInstalled),
      softwareMissing: text(1, 200, d.softwareMissing),
      softwareVersionBelow: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'version'],
        properties: {
          name: text(1, 200, d.softwareVersionBelowName),
          version: { ...text(1, 100, d.softwareVersionBelowVersion), pattern: '^\\d' },
        },
        description: d.softwareVersionBelow,
      },
      pendingPatches: { type: 'boolean', description: d.pendingPatches },
      criticalAlerts: { type: 'boolean', description: d.criticalAlerts },
      rebootRequired: { type: 'boolean', description: d.rebootRequired },
      lastSeenDaysOver: { type: 'integer', minimum: 1, maximum: 3650, description: d.lastSeenDaysOver },
    },
  };
}

/** The registry `definition.input_schema` entry for `groupBy`. */
export function fleetGroupByParamSchema(): Record<string, unknown> {
  return { type: 'string', enum: [...FLEET_FILTER_GROUP_BY], description: FLEET_GROUP_BY_PARAM_DESCRIPTION };
}

/** `filter` + `groupBy` for the two Zod surfaces (`toolInputSchemas` and the SDK `tool()` shape). */
export function fleetFilterZodShape() {
  return {
    filter: fleetFilterSchema.optional().describe(FLEET_FILTER_PARAM_DESCRIPTION),
    groupBy: z.enum(FLEET_FILTER_GROUP_BY).optional().describe(FLEET_GROUP_BY_PARAM_DESCRIPTION),
  };
}
