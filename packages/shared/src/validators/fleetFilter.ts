import { z } from 'zod';

/**
 * The typed fleet filter (#12418): one small facade over the device filter
 * engine, shared by `get_fleet_device_stats` (counts) and, later, the fleet
 * step of a flow (the set an action freezes), so both read the same WHERE.
 *
 * The API compiles it to a `FilterConditionGroup` (`services/fleetFilter.ts`)
 * and renders it with the engine's own SQL builder. Every field is optional;
 * present fields are ANDed. `decommissioned` is not a status here: every
 * tech-facing count already excludes it.
 *
 * Descriptions are model-facing copy, held to the AI tool parameter budget
 * (`aiTools.descriptionBudget.contract.test.ts` walks nested parameters).
 * "count only" marks exactly the fields the API's filter engine refuses as
 * execution targets; `services/fleetFilter.test.ts` holds the two together.
 */

/** Device-scalar columns a fleet count may be grouped by (one-to-many dimensions filter but never group). */
export const FLEET_FILTER_GROUP_BY = ['status', 'osType', 'osVersion', 'siteId', 'agentVersion', 'deviceRole', 'architecture'] as const;
export type FleetFilterGroupBy = (typeof FLEET_FILTER_GROUP_BY)[number];

export const FLEET_FILTER_STATUSES = ['online', 'offline', 'maintenance', 'quarantined', 'updating', 'pending'] as const;
export const FLEET_FILTER_OS_TYPES = ['windows', 'macos', 'linux'] as const;

/** Model-facing copy, shared verbatim by the Zod schema and the API's JSON-schema mirror. */
export const FLEET_FILTER_DESCRIPTIONS = {
  status: 'Device status (decommissioned devices are never counted)',
  osType: 'Operating system family',
  osVersionContains: 'OS version contains this text, case-insensitive',
  hostnameContains: 'Hostname contains this text, case-insensitive. Device-reported, count only',
  siteId: 'Only devices at this site',
  groupId: 'Only members of this device group',
  tags: 'Device has every one of these tags. Device-reported, count only',
  agentVersion: 'Exact Breeze agent version. Device-reported, count only',
  softwareInstalled: 'Has installed software whose name contains this text. Device-reported, count only',
  softwareMissing: 'Has no installed software whose name contains this text. Device-reported, count only',
  softwareVersionBelow: 'Has this exact software name installed below this numeric version. Device-reported, count only',
  softwareVersionBelowName: 'Exact software name, case-insensitive',
  softwareVersionBelowVersion: 'Version starting with a digit, e.g. 23.01',
  pendingPatches: 'true: has at least one pending patch; false: has none',
  criticalAlerts: 'true: has an active critical alert; false: has none',
  rebootRequired: 'true: the OS reports a pending reboot; false: it does not',
  lastSeenDaysOver: 'Last seen more than this many days ago. A device never seen does not match',
} as const;

export const FLEET_FILTER_SOFTWARE_VERSION_PATTERN = /^\d/;

export const fleetFilterSchema = z
  .object({
    status: z.enum(FLEET_FILTER_STATUSES).optional().describe(FLEET_FILTER_DESCRIPTIONS.status),
    osType: z.enum(FLEET_FILTER_OS_TYPES).optional().describe(FLEET_FILTER_DESCRIPTIONS.osType),
    osVersionContains: z.string().min(1).max(100).optional().describe(FLEET_FILTER_DESCRIPTIONS.osVersionContains),
    hostnameContains: z.string().min(1).max(200).optional().describe(FLEET_FILTER_DESCRIPTIONS.hostnameContains),
    siteId: z.string().guid().optional().describe(FLEET_FILTER_DESCRIPTIONS.siteId),
    groupId: z.string().guid().optional().describe(FLEET_FILTER_DESCRIPTIONS.groupId),
    tags: z.array(z.string().min(1).max(100)).min(1).max(20).optional().describe(FLEET_FILTER_DESCRIPTIONS.tags),
    agentVersion: z.string().min(1).max(50).optional().describe(FLEET_FILTER_DESCRIPTIONS.agentVersion),
    softwareInstalled: z.string().min(1).max(200).optional().describe(FLEET_FILTER_DESCRIPTIONS.softwareInstalled),
    softwareMissing: z.string().min(1).max(200).optional().describe(FLEET_FILTER_DESCRIPTIONS.softwareMissing),
    softwareVersionBelow: z
      .object({
        name: z.string().min(1).max(200).describe(FLEET_FILTER_DESCRIPTIONS.softwareVersionBelowName),
        version: z
          .string()
          .min(1)
          .max(100)
          .regex(FLEET_FILTER_SOFTWARE_VERSION_PATTERN)
          .describe(FLEET_FILTER_DESCRIPTIONS.softwareVersionBelowVersion),
      })
      .strict()
      .optional()
      .describe(FLEET_FILTER_DESCRIPTIONS.softwareVersionBelow),
    pendingPatches: z.boolean().optional().describe(FLEET_FILTER_DESCRIPTIONS.pendingPatches),
    criticalAlerts: z.boolean().optional().describe(FLEET_FILTER_DESCRIPTIONS.criticalAlerts),
    rebootRequired: z.boolean().optional().describe(FLEET_FILTER_DESCRIPTIONS.rebootRequired),
    lastSeenDaysOver: z.number().int().min(1).max(3650).optional().describe(FLEET_FILTER_DESCRIPTIONS.lastSeenDaysOver),
  })
  .strict();

export type FleetFilter = z.infer<typeof fleetFilterSchema>;
