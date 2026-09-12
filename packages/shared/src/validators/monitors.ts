import { z } from 'zod';
import { automationActionSchema } from './automationActions';

/**
 * Monitor definitions (#5287 W02).
 *
 * A monitor is ONE object carrying a condition, a severity, responses and
 * delivery — the thing a technician actually authors. The API compiles each
 * definition into the alert template / alert rule / automation rows the
 * existing sweep, dispatcher and automation worker already execute, so nothing
 * downstream learns a new shape.
 *
 * Every kind here maps onto a handler that already exists in
 * `apps/api/src/services/alertConditions`; the per-kind condition schemas below
 * are the AUTHORING shape (what the editor collects), not the evaluation shape.
 * The API's kind registry translates one into the other.
 */
export const MONITOR_KINDS = [
  'cpu',
  'memory',
  'disk',
  'offline',
  'event_log',
  'patch_compliance',
  'service',
  'process',
  'process_resource',
  'cert_expiry',
  'bandwidth',
  'disk_io',
  'network_errors',
] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];
export const monitorKindSchema = z.enum(MONITOR_KINDS);

const operatorSchema = z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']);
const durationMinutesSchema = z.number().int().min(1).max(1440).optional();

/** Percentage thresholds (cpu / memory / disk share one shape). */
const percentThresholdCondition = z
  .object({
    operator: operatorSchema,
    value: z.number().min(0).max(100),
    durationMinutes: durationMinutesSchema,
  })
  .strict();

export const monitorConditionSchemas = {
  cpu: percentThresholdCondition,
  memory: percentThresholdCondition,
  disk: percentThresholdCondition,
  offline: z
    .object({ durationMinutes: z.number().int().min(1).max(10080).default(5) })
    .strict(),
  event_log: z
    .object({
      category: z.enum(['security', 'hardware', 'application', 'system']),
      level: z.enum(['warning', 'error', 'critical']),
      sourcePattern: z.string().max(200).optional(),
      messagePattern: z.string().max(500).optional(),
      countThreshold: z.number().int().min(1).default(1),
      windowMinutes: z.number().int().min(1).max(1440).default(60),
    })
    .strict(),
  patch_compliance: z
    .object({ operator: operatorSchema, value: z.number().min(0).max(100) })
    .strict(),
  service: z
    .object({
      serviceName: z.string().min(1).max(255),
      consecutiveFailures: z.number().int().min(1).max(20).optional(),
    })
    .strict(),
  process: z
    .object({
      processName: z.string().min(1).max(255),
      consecutiveFailures: z.number().int().min(1).max(20).optional(),
    })
    .strict(),
  process_resource: z
    .object({
      resource: z.enum(['cpu', 'memory']),
      processName: z.string().min(1).max(255),
      operator: operatorSchema,
      value: z.number().min(0),
      durationMinutes: durationMinutesSchema,
    })
    .strict(),
  cert_expiry: z.object({ withinDays: z.number().int().min(1).max(365) }).strict(),
  bandwidth: z
    .object({
      direction: z.enum(['in', 'out', 'total']),
      operator: operatorSchema,
      value: z.number().min(0),
      durationMinutes: durationMinutesSchema,
    })
    .strict(),
  disk_io: z
    .object({
      direction: z.enum(['read', 'write', 'total']),
      operator: operatorSchema,
      value: z.number().min(0),
      durationMinutes: durationMinutesSchema,
    })
    .strict(),
  network_errors: z
    .object({
      interfaceName: z.string().max(100).optional(),
      errorType: z.enum(['in', 'out', 'total']),
      operator: operatorSchema,
      value: z.number().min(0),
      windowMinutes: z.number().int().min(1).max(1440).optional(),
    })
    .strict(),
} satisfies Record<MonitorKind, z.ZodTypeAny>;

export type MonitorConditionSchemas = typeof monitorConditionSchemas;

/** Responses reuse the automation action vocabulary verbatim. */
export const monitorResponsesSchema = z.array(automationActionSchema).max(10);
export const monitorDeliveryModeSchema = z.enum(['none', 'inherit', 'channels']);
export type MonitorDeliveryMode = z.infer<typeof monitorDeliveryModeSchema>;
export const monitorSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);

const monitorDefinitionFields = {
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  kind: monitorKindSchema,
  enabled: z.boolean().default(true),
  condition: z.record(z.string(), z.unknown()),
  severity: monitorSeveritySchema,
  cooldownMinutes: z.number().int().min(0).max(1440).default(5),
  autoResolve: z.boolean().default(false),
  autoResolveConditions: z.record(z.string(), z.unknown()).nullable().optional(),
  responses: monitorResponsesSchema.default([]),
  deliveryMode: monitorDeliveryModeSchema.default('inherit'),
  deliveryChannelIds: z.array(z.string().uuid()).max(20).default([]),
  escalationPolicyId: z.string().uuid().nullable().optional(),
  recurrenceThreshold: z.number().int().min(2).max(100).nullable().optional(),
  recurrenceWindowHours: z.number().int().min(1).max(8760).nullable().optional(),
  recurrenceActions: monitorResponsesSchema.default([]),
  pauseResponsesOnEscalation: z.boolean().default(true),
  aiAgentId: z.string().uuid().nullable().optional(),
};

const baseDefinition = z.object(monitorDefinitionFields);

interface MonitorDefinitionShape {
  kind?: MonitorKind;
  condition?: Record<string, unknown>;
  recurrenceThreshold?: number | null;
  recurrenceWindowHours?: number | null;
  deliveryMode?: MonitorDeliveryMode;
  deliveryChannelIds?: string[];
  responses?: Array<{ type: string }>;
  aiAgentId?: string | null;
}

/**
 * Cross-field rules shared by create and update.
 *
 * The condition check is skipped when `kind` is absent, which only happens on a
 * PATCH that does not change the kind — the service re-validates the MERGED
 * definition against the stored kind, so a partial update can never persist a
 * condition that does not match.
 */
function refineDefinition<T extends z.ZodType<MonitorDefinitionShape>>(schema: T) {
  return schema
    .refine(
      (v) => {
        if (!v.kind) return true;
        if (v.condition === undefined) return true;
        return monitorConditionSchemas[v.kind].safeParse(v.condition).success;
      },
      { message: 'condition does not match kind', path: ['condition'] },
    )
    .refine((v) => (v.recurrenceThreshold == null) === (v.recurrenceWindowHours == null), {
      message: 'recurrenceThreshold and recurrenceWindowHours must be set together',
      path: ['recurrenceThreshold'],
    })
    .refine((v) => v.deliveryMode !== 'channels' || (v.deliveryChannelIds?.length ?? 0) > 0, {
      message: 'deliveryChannelIds required when deliveryMode is channels',
      path: ['deliveryChannelIds'],
    })
    .refine((v) => !(v.responses ?? []).some((a) => a.type === 'ai_triage') || !!v.aiAgentId, {
      message: 'ai_triage responses require aiAgentId',
      path: ['responses'],
    });
}

/**
 * `ownerScope` exists on CREATE only (CLAUDE.md "Partner-Wide First" step 2).
 * `baseDefinition` carries no ownerScope and zod strips unknown keys, so an
 * update can never re-home a definition from an org to its partner or back.
 */
export const createMonitorDefinitionSchema = refineDefinition(
  baseDefinition.extend({
    ownerScope: z.enum(['organization', 'partner']).default('organization'),
    orgId: z.string().uuid().optional(),
  }),
);

export const updateMonitorDefinitionSchema = refineDefinition(baseDefinition.partial());

export type CreateMonitorDefinitionInput = z.infer<typeof createMonitorDefinitionSchema>;
export type UpdateMonitorDefinitionInput = z.infer<typeof updateMonitorDefinitionSchema>;

/**
 * `monitors` configuration-policy feature inline settings: the attachment list
 * for one policy. `overrides` is a partial condition — only the keys the kind
 * marks overridable are honoured, and the API re-validates the merged result.
 */
export const monitorAttachmentItemSchema = z.object({
  monitorId: z.string().uuid(),
  enabled: z.boolean().default(true),
  overrides: z.record(z.string(), z.unknown()).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const monitorsInlineSettingsSchema = z.object({
  items: z.array(monitorAttachmentItemSchema).max(200).default([]),
});
export type MonitorsInlineSettings = z.infer<typeof monitorsInlineSettingsSchema>;
export type MonitorAttachmentItem = z.infer<typeof monitorAttachmentItemSchema>;
