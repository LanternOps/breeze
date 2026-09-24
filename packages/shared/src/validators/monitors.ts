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
  'cpu', 'memory', 'disk', 'offline', 'event_log', 'patch_compliance',
  'service', 'process', 'process_resource', 'cert_expiry',
  'bandwidth', 'disk_io', 'network_errors',
  'antivirus', 'software_presence', 'backup_continuity', 'script', 'network_check',
  // W05c1 (alerting consolidation, spec C8): "all/any of the following". Children
  // are restricted to SERVER_EVALUATED_MONITOR_KINDS — agent-delivered and
  // worker-provisioned kinds are selected by ROOT kind when agent config, script
  // probes and network rows are built (helpers.ts, monitorScriptWorker.ts,
  // monitorCompiler.ts), so a composite child of those kinds would never
  // receive evidence.
  'composite',
  // W03 (hardware & RAID monitoring): root-only, evaluates fresh component
  // evidence supplied by the hardware health leaf handler. Not a legal
  // composite child — see `compositeChildSchema` below.
  'hardware_health',
] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];
export const monitorKindSchema = z.enum(MONITOR_KINDS);

/** Kinds whose evidence the server sweep reads itself — the only legal composite children. */
export const SERVER_EVALUATED_MONITOR_KINDS = [
  'cpu', 'memory', 'disk', 'offline', 'event_log', 'patch_compliance', 'cert_expiry',
  'bandwidth', 'disk_io', 'network_errors', 'antivirus', 'software_presence', 'backup_continuity',
] as const satisfies readonly MonitorKind[];
export type ServerEvaluatedMonitorKind = (typeof SERVER_EVALUATED_MONITOR_KINDS)[number];

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

const leafConditionSchemas = {
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
      consecutiveFailures: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  process: z
    .object({
      processName: z.string().min(1).max(255),
      consecutiveFailures: z.number().int().min(1).max(100).optional(),
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
  antivirus: z
    .object({
      check: z.enum(['not_protected', 'definitions_stale', 'realtime_disabled', 'threats_present']),
      staleAfterDays: z.number().int().min(1).max(365).optional(), // 'definitions_stale' only
      minThreatCount: z.number().int().min(1).max(1000).optional(), // 'threats_present' only
    })
    .strict()
    .refine((v) => v.check !== 'definitions_stale' || v.staleAfterDays != null, {
      message: 'staleAfterDays required for definitions_stale',
      path: ['staleAfterDays'],
    }),
  software_presence: z
    .object({
      name: z.string().min(1).max(500),
      vendor: z.string().max(200).optional(),
      presence: z.enum(['installed', 'not_installed', 'version_below']),
      version: z.string().max(100).optional(), // 'version_below' only
    })
    .strict()
    .refine((v) => v.presence !== 'version_below' || !!v.version, {
      message: 'version required for version_below',
      path: ['version'],
    }),
  backup_continuity: z
    .object({
      check: z.enum(['no_successful_backup', 'consecutive_failures']),
      maxAgeHours: z.number().int().min(1).max(8760).optional(), // 'no_successful_backup' only
      failureCount: z.number().int().min(1).max(50).optional(), // 'consecutive_failures' only
    })
    .strict()
    .refine((v) => v.check !== 'no_successful_backup' || v.maxAgeHours != null, {
      message: 'maxAgeHours required for no_successful_backup',
      path: ['maxAgeHours'],
    })
    .refine((v) => v.check !== 'consecutive_failures' || v.failureCount != null, {
      message: 'failureCount required for consecutive_failures',
      path: ['failureCount'],
    }),
  script: z
    .object({
      scriptId: z.string().uuid(),
      intervalMinutes: z.number().int().min(5).max(1440).default(60),
      timeoutSeconds: z.number().int().min(10).max(3600).default(300),
      parameters: z.record(z.string(), z.unknown()).optional(),
      // Exit-code verdict is the default. A `::breeze:monitor::` marker line in
      // stdout overrides it with a richer detail string; a script that emits
      // neither and exits 0 passes.
      breachOnNonZeroExit: z.boolean().default(true),
    })
    .strict(),
  network_check: z
    .object({
      // These labels ARE the existing `monitor_type` pgEnum values, so the
      // compiler adapter never maps a vocabulary.
      checkType: z.enum(['icmp_ping', 'tcp_port', 'http_check', 'dns_check']),
      target: z.string().min(1).max(500),
      port: z.number().int().min(1).max(65535).optional(), // tcp_port
      expectStatus: z.number().int().min(100).max(599).optional(), // http_check
      // http_check only. Left unset, the compiler picks a default: false when
      // `expectStatus` is itself a 3xx (following the redirect would evaluate
      // the FINAL hop's status instead of the one being asserted, #6510), true
      // otherwise (matches the agent's own default).
      followRedirects: z.boolean().optional(),
      pollingIntervalSeconds: z.number().int().min(30).max(3600).default(60),
      timeoutSeconds: z.number().int().min(1).max(120).default(5),
      consecutiveFailures: z.number().int().min(1).max(100).default(2),
    })
    .strict()
    .refine((v) => v.checkType !== 'tcp_port' || v.port != null, {
      message: 'port required for tcp_port',
      path: ['port'],
    }),
  hardware_health: z
    .object({
      componentTypes: z
        .array(z.enum(['controller', 'virtual_disk', 'physical_disk', 'cache_battery', 'enclosure', 'collector']))
        .min(1),
      minHealth: z.enum(['warning', 'critical']),
      includePredictiveFailure: z.boolean().default(true),
      consecutiveSnapshots: z.number().int().min(1).max(10).default(2),
    })
    .strict(),
} satisfies Record<Exclude<MonitorKind, 'composite'>, z.ZodTypeAny>;

const compositeChildSchema = z
  .object({
    kind: z.enum(SERVER_EVALUATED_MONITOR_KINDS),
    condition: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * `{ match, children }` — no nesting (the child kind enum excludes `composite`),
 * 2..10 children, each child condition validated against its own kind schema so
 * an invalid leaf fails HERE with a `children[i].condition` path, never at
 * compile time. The API kind spec compiles it to `{ logic: and|or, conditions }`,
 * which `alertConditions/index.ts` `evaluateConditionRecursive` already walks.
 */
export const compositeConditionSchema = z
  .object({
    match: z.enum(['all', 'any']).default('all'),
    children: z.array(compositeChildSchema).min(2).max(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    value.children.forEach((child, index) => {
      const result = leafConditionSchemas[child.kind].safeParse(child.condition);
      if (!result.success) {
        ctx.addIssue({
          code: 'custom',
          path: ['children', index, 'condition'],
          message: `child condition does not match kind ${child.kind}: ${result.error.issues[0]?.message ?? 'invalid'}`,
        });
      }
    });
  });
export type CompositeCondition = z.infer<typeof compositeConditionSchema>;

export const monitorConditionSchemas = {
  ...leafConditionSchemas,
  composite: compositeConditionSchema,
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

export const monitorsInheritanceSchema = z.enum(['cumulative', 'replace']);
export type MonitorsInheritance = z.infer<typeof monitorsInheritanceSchema>;

/**
 * `inheritance` (W05c1, spec §Inheritance correction): how this policy's
 * attachment set combines with the rest of the device's chain in
 * `resolveMonitorsForDevice`.
 *  - cumulative (default): every attachment in the chain competes per monitor,
 *    closest wins; the parent's attachments are consulted.
 *  - replace: among the chain's REPLACE-mode links only the closest one
 *    contributes, and that link's parent is not consulted. Cumulative links in
 *    the same chain still add. This is exactly how the legacy `alert_rule`
 *    feature was selected (closest policy holding the feature wins), which is
 *    what a converted policy needs to reproduce its inline behaviour.
 */
export const monitorsInlineSettingsSchema = z.object({
  // Collection interval is normalized on the settings row owned by this link.
  checkIntervalSeconds: z.number().int().min(10).max(3600).default(60),
  items: z.array(monitorAttachmentItemSchema).max(200).default([]),
  inheritance: monitorsInheritanceSchema.default('cumulative'),
});
export type MonitorsInlineSettings = z.infer<typeof monitorsInlineSettingsSchema>;
export type MonitorAttachmentItem = z.infer<typeof monitorAttachmentItemSchema>;
