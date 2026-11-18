/**
 * Input schemas for the W13 PR A tools (full-control W13, #6783):
 * `get_device_events`, `get_device_health`, `get_process_samples`,
 * `get_management_posture`, `manage_device_function`, `manage_device_links`,
 * `manage_manual_assets`, `manage_device_warranty`.
 *
 * Plain strict `z.object`s with an `action` enum where the tool multiplexes (no
 * top-level unions or refinements) so `toolActionEnum` can read
 * `.shape.action.options` and the chat SDK `tool()` declarations can take
 * `.shape` directly. Per-action required fields and the route's own body
 * schemas are applied in the handlers. No `z.undefined()` anywhere: it empties
 * the model's tool list.
 *
 * Deliberately ABSENT (W13 plan, "Not built"): process-sample range markers
 * (`from` / `to`), and any event-feed input that would return `details`, actor
 * emails or IP addresses (W13-D4).
 */
import { z } from 'zod';
import { AUDIT_RESULTS } from '@breeze/shared';

export const DEVICE_FUNCTION_ACTIONS = ['get', 'set'] as const;
export const DEVICE_LINK_ACTIONS = ['list', 'get', 'for_device', 'create', 'update', 'dissolve'] as const;
export const MANUAL_ASSET_ACTIONS = ['list', 'create', 'update', 'delete', 'link', 'unlink'] as const;
export const DEVICE_WARRANTY_ACTIONS = ['get', 'expiring', 'refresh'] as const;
export const LINK_GROUP_KIND_VALUES = ['multiboot', 'vm_host'] as const;
// W13 PR B (#6783).
export const EVENT_LOG_ACTIONS = ['list_logs', 'query', 'get_event'] as const;
export const EVENT_LOG_LEVELS = ['information', 'warning', 'error', 'critical', 'verbose'] as const;
/** The agent's own page cap for an event-log query (agent/internal/remote/tools/result_limits.go). */
export const MAX_EVENT_LOG_PAGE = 20;
export const TENANT_VARIABLE_ACTIONS = ['list', 'create', 'update', 'delete'] as const;
/** W13-D8 / W13-D14: `create` is not built (the join code needs a sealed reveal path). */
export const SUPPORT_SESSION_ACTIONS = ['list', 'get', 'end'] as const;
export const DEVICE_EVENT_CATEGORIES = [
  'device', 'agent', 'script', 'patch', 'alert', 'policy', 'deployment', 'backup',
  'discovery', 'automation', 'maintenance', 'monitoring', 'ai', 'software', 'system',
] as const;
export const DEVICE_EVENT_INITIATORS = ['manual', 'ai', 'automation', 'policy', 'schedule', 'agent', 'integration'] as const;

/**
 * The `discovered_asset_type` pg enum (db/schema/discovery.ts), listed here so this module never reads the schema at
 * load time (many suites mock `../db/schema`). aiToolsDeviceOps.classes.contract.test.ts pins the two equal.
 */
/**
 * The management-posture categories (routes/agents/schemas.ts MANAGEMENT_POSTURE_CATEGORIES), listed here so tool code
 * never loads a route schema module at import time (agent route suites mock `./schemas` with hand-listed factories).
 * aiToolsDeviceOps.classes.contract.test.ts pins the two equal.
 */
export const POSTURE_CATEGORIES = [
  'mdm', 'rmm', 'remoteAccess', 'endpointSecurity', 'policyEngine', 'backup', 'identityMfa', 'siem',
  'dnsFiltering', 'zeroTrustVpn', 'patchManagement',
] as const;

export const MANUAL_ASSET_TYPES = [
  'workstation', 'server', 'printer', 'router', 'switch', 'firewall', 'access_point', 'phone', 'iot', 'camera', 'nas',
  'unknown', 'website', 'service',
] as const;
const uuid = z.string().uuid();
const isoDateTime = z.string().datetime({ offset: true });
const page = z.number().int().min(1).max(10000);

export const deviceOpsToolSchemas: Record<string, z.ZodType> = {
  get_device_events: z.object({
    deviceId: uuid,
    search: z.string().max(200).optional(),
    category: z.enum(DEVICE_EVENT_CATEGORIES).optional(),
    result: z.enum(AUDIT_RESULTS).optional(),
    initiatedBy: z.enum(DEVICE_EVENT_INITIATORS).optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    page: page.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(),

  get_device_health: z.object({
    deviceId: uuid,
  }).strict(),

  get_process_samples: z.object({
    deviceId: uuid,
    at: isoDateTime.optional(),
  }).strict(),

  get_management_posture: z.object({
    orgId: uuid.optional(),
    category: z.enum(POSTURE_CATEGORIES).optional(),
    stalenessDays: z.number().int().min(1).max(365).optional(),
    product: z.string().min(1).max(255).optional(),
    status: z.enum(['active', 'installed', 'unknown']).optional(),
    page: page.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).strict(),

  manage_device_function: z.object({
    action: z.enum(DEVICE_FUNCTION_ACTIONS),
    deviceId: uuid,
    functionKey: z.string().min(1).max(120).nullable().optional(),
    label: z.string().max(80).optional(),
  }).strict(),

  manage_device_links: z.object({
    action: z.enum(DEVICE_LINK_ACTIONS),
    groupId: uuid.optional(),
    deviceId: uuid.optional(),
    kind: z.enum(LINK_GROUP_KIND_VALUES).optional(),
    name: z.string().min(1).max(255).nullable().optional(),
    deviceIds: z.array(uuid).min(2).max(10).optional(),
    hostDeviceId: uuid.optional(),
    addDeviceIds: z.array(uuid).min(1).max(10).optional(),
    removeDeviceIds: z.array(uuid).min(1).max(10).optional(),
  }).strict(),

  manage_manual_assets: z.object({
    action: z.enum(MANUAL_ASSET_ACTIONS),
    assetId: uuid.optional(),
    orgId: uuid.optional(),
    siteId: uuid.optional(),
    search: z.string().max(200).optional(),
    page: page.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    name: z.string().min(1).max(255).optional(),
    assetType: z.enum(MANUAL_ASSET_TYPES).optional(),
    manufacturer: z.string().max(255).nullable().optional(),
    model: z.string().max(255).nullable().optional(),
    serialNumber: z.string().max(255).nullable().optional(),
    assetTag: z.string().max(128).nullable().optional(),
    location: z.string().max(255).nullable().optional(),
    assignedContactId: uuid.nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    retiredAt: isoDateTime.nullable().optional(),
    deviceId: uuid.optional(),
    discoveredAssetId: uuid.optional(),
  }).strict(),

  manage_device_warranty: z.object({
    action: z.enum(DEVICE_WARRANTY_ACTIONS),
    deviceId: uuid.optional(),
    days: z.number().int().min(1).max(365).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).strict(),

  // ── W13 PR B ────────────────────────────────────────────────────────────
  browse_device_event_log: z.object({
    action: z.enum(EVENT_LOG_ACTIONS),
    deviceId: uuid,
    logName: z.string().min(1).max(256).optional(),
    level: z.enum(EVENT_LOG_LEVELS).optional(),
    source: z.string().max(255).optional(),
    eventId: z.number().int().min(0).max(0xffff).optional(),
    page: z.number().int().min(1).max(MAX_EVENT_LOG_PAGE).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    recordId: z.number().int().min(0).optional(),
  }).strict(),

  // W13-D7: no `isSecret` input — the tool never creates, reads or edits a secret value.
  manage_tenant_variables: z.object({
    action: z.enum(TENANT_VARIABLE_ACTIONS),
    variableId: uuid.optional(),
    orgId: uuid.optional(),
    scope: z.enum(['partner', 'org', 'all']).optional(),
    ownerScope: z.enum(['organization', 'partner']).optional(),
    key: z.string().min(1).max(64).optional(),
    value: z.string().max(4096).optional(),
    description: z.string().max(500).nullable().optional(),
  }).strict(),

  manage_support_sessions: z.object({
    action: z.enum(SUPPORT_SESSION_ACTIONS),
    sessionId: uuid.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(),
};
