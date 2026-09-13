import { z } from 'zod';
import type { FleetDesignApproval } from '../types/fleetDesignApply';

const REF_MAX = 2000;
const uuid = z.string().uuid();
// Mirrors device_function_assessments_key_chk / parseFunctionKey.
const KEY = '(?:[a-z][a-z0-9_]{1,47}|custom:[a-z0-9][a-z0-9-]{1,39})';

export const fleetDesignFunctionKeyRefSchema = z.string().regex(new RegExp(`^${KEY}$`));
export const fleetDesignMonitoringRefSchema = z.string().regex(new RegExp(`^monitoring:${KEY}:(?:watch|rule):\\d{1,4}$`));
export const fleetDesignRetiredRefSchema = z.string().regex(/^retired:\d{1,4}$/);
export const fleetDesignAutomationRefSchema = z.string().regex(new RegExp(`^automation:${KEY}:script:\\d{1,4}$`));
export const fleetDesignLegacyRefSchema = z.string().regex(/^legacy:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/**
 * Body of `POST /ai/fleet-design/:reportRunId/apply` and `/apply/preview`.
 * Every array is bounded, refs follow the item-ref grammar, unknown keys are
 * rejected (`.strict()`), and an empty approval is valid (a preview of nothing).
 */
export const fleetDesignApprovalSchema = z.object({
  functions: z.array(fleetDesignFunctionKeyRefSchema).max(REF_MAX).default([]),
  monitoring: z.array(fleetDesignMonitoringRefSchema).max(REF_MAX).default([]),
  retired: z.array(fleetDesignRetiredRefSchema).max(REF_MAX).default([]),
  automation: z.array(fleetDesignAutomationRefSchema).max(REF_MAX).default([]),
  legacy: z.array(fleetDesignLegacyRefSchema).max(REF_MAX).default([]),
  roleCorrections: z.array(uuid).max(REF_MAX).default([]),
  displacementsAccepted: z.array(uuid).max(REF_MAX).default([]),
}).strict();

export type FleetDesignApprovalInput = z.input<typeof fleetDesignApprovalSchema>;
// Compile-time pin: the parsed shape IS the shared contract.
const _pin: FleetDesignApproval = null as unknown as z.output<typeof fleetDesignApprovalSchema>;
void _pin;
