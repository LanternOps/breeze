/**
 * Input schemas for the W12 tools (full-control W12, #6782):
 * `manage_software_catalog`, `search_packages`, `manage_software_deployments`,
 * `get_device_software`, `manage_device_software`, `manage_software_inventory`,
 * `bootstrap_homebrew`, `manage_fleet_findings`, `manage_custom_fields`.
 *
 * Plain strict `z.object`s with an `action` enum where the tool multiplexes (no
 * top-level unions or refinements) so `toolActionEnum` can read
 * `.shape.action.options` and the chat SDK `tool()` declarations can take
 * `.shape` directly. Per-action required fields, and the route's own body
 * schemas, are applied in the handlers. No `z.undefined()` anywhere: it empties
 * the model's tool list.
 *
 * Deliberately ABSENT (W12 plan, "Not built"): a version `downloadUrl` reader
 * (presigned bearer URL), version upload, `preInstallScript` /
 * `postInstallScript`, deployment targets other than named devices (groups,
 * `all`, `filter`, `sites`), and the deprecated POST /deploy. aiToolSchemas.software.test.ts pins them.
 */
import { z } from 'zod';
import { SOFTWARE_FILE_TYPES } from '@breeze/shared';

export const SOFTWARE_CATALOG_ACTIONS = [
  'list', 'get', 'create', 'update', 'archive',
  'add_version', 'update_version', 'promote_version',
  'add_install_method', 'update_install_method', 'delete_install_method', 'import_package',
] as const;
export const SOFTWARE_DEPLOYMENT_ACTIONS = ['list', 'get', 'summary', 'results', 'create', 'cancel', 'retry'] as const;
export const DEVICE_SOFTWARE_ACTIONS = ['update', 'uninstall'] as const;
export const SOFTWARE_INVENTORY_ACTIONS = ['list', 'names', 'devices', 'approve', 'deny', 'clear'] as const;
export const FLEET_FINDING_ACTIONS = ['acknowledge', 'dismiss', 'reopen'] as const;
export const CUSTOM_FIELD_ACTIONS = ['create_definition', 'update_definition', 'delete_definition', 'set_values'] as const;

/**
 * W12 plan + quorum QW3: a deployment targets named devices only (≤ 100), so the approver sees the exact set.
 * Groups (whose membership is resolved at release and can hold the whole org), `all` and `filter` are absent.
 */
export const MAX_DEPLOYMENT_DEVICE_TARGETS = 100;

const PLATFORMS = ['windows', 'macos', 'linux'] as const;
const INSTALL_METHOD_PLATFORMS = ['windows', 'macos'] as const;
const INSTALL_METHOD_KINDS = ['winget', 'homebrew_cask', 'homebrew_formula'] as const;
const CATALOG_CATEGORIES = [
  'browser', 'utility', 'compression', 'productivity', 'communication', 'developer', 'media', 'security',
] as const;
const RESULT_STATUSES = [
  'pending', 'running', 'paused', 'downloading', 'installing', 'completed', 'failed', 'cancelled', 'rollback',
] as const;
const CUSTOM_FIELD_TYPES = ['text', 'number', 'boolean', 'dropdown', 'date'] as const;
const OWNER_SCOPES = ['organization', 'partner'] as const;

const uuid = z.string().guid();
const limit = z.number().int().min(1).max(500);
const offset = z.number().int().min(0);

export const softwareToolSchemas = {
  manage_software_catalog: z.object({
    action: z.enum(SOFTWARE_CATALOG_ACTIONS),
    orgId: uuid.optional(),
    catalogId: uuid.optional(),
    versionId: uuid.optional(),
    methodId: uuid.optional(),
    search: z.string().max(200).optional(),
    category: z.enum(CATALOG_CATEGORIES).optional(),
    ownerScope: z.enum(OWNER_SCOPES).optional(),
    name: z.string().min(1).max(200).optional(),
    vendor: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    iconUrl: z.string().url().optional(),
    websiteUrl: z.string().url().optional(),
    isManaged: z.boolean().optional(),
    version: z.string().min(1).max(100).optional(),
    releaseDate: z.string().datetime().optional(),
    releaseNotes: z.string().max(5000).optional(),
    downloadUrl: z.string().url().optional(),
    fileType: z.enum(SOFTWARE_FILE_TYPES).optional(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    fileSize: z.number().min(0).optional(),
    supportedOs: z.array(z.enum(PLATFORMS)).max(3).optional(),
    architecture: z.string().max(20).optional(),
    silentInstallArgs: z.string().max(2000).optional(),
    silentUninstallArgs: z.string().max(2000).optional(),
    detectionRules: z.record(z.string(), z.unknown()).optional(),
    successExitCodes: z.array(z.number().int()).max(32).optional(),
    platform: z.enum(INSTALL_METHOD_PLATFORMS).optional(),
    kind: z.enum(INSTALL_METHOD_KINDS).optional(),
    packageId: z.string().min(1).max(256).optional(),
    enabled: z.boolean().optional(),
    methods: z.array(z.object({
      platform: z.enum(INSTALL_METHOD_PLATFORMS),
      kind: z.enum(INSTALL_METHOD_KINDS),
      packageId: z.string().min(1).max(256),
    }).strict()).min(1).max(4).optional(),
    limit: limit.optional(),
  }).strict(),

  search_packages: z.object({
    platform: z.enum(INSTALL_METHOD_PLATFORMS),
    query: z.string().min(2).max(100),
    limit: z.number().int().min(1).max(25).optional(),
  }).strict(),

  manage_software_deployments: z.object({
    action: z.enum(SOFTWARE_DEPLOYMENT_ACTIONS),
    orgId: uuid.optional(),
    deploymentId: uuid.optional(),
    resultStatus: z.enum(RESULT_STATUSES).optional(),
    name: z.string().min(1).max(255).optional(),
    softwareVersionId: uuid.optional(),
    catalogId: uuid.optional(),
    versionMode: z.enum(['latest', 'exact']).optional(),
    requestedVersion: z.string().min(1).max(64).optional(),
    scheduleType: z.enum(['immediate', 'scheduled', 'maintenance']).optional(),
    scheduledAt: z.string().datetime().optional(),
    maintenanceWindowId: uuid.optional(),
    deviceIds: z.array(uuid).min(1).max(MAX_DEPLOYMENT_DEVICE_TARGETS).optional(),
    reason: z.string().max(500).optional(),
    limit: limit.optional(),
    offset: offset.optional(),
  }).strict(),

  get_device_software: z.object({
    deviceId: uuid,
    search: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: offset.optional(),
  }).strict(),

  manage_device_software: z.object({
    action: z.enum(DEVICE_SOFTWARE_ACTIONS),
    deviceId: uuid,
    name: z.string().min(1).max(200),
    version: z.string().max(100).optional(),
    packageId: z.string().max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional(),
  }).strict(),

  manage_software_inventory: z.object({
    action: z.enum(SOFTWARE_INVENTORY_ACTIONS),
    orgId: uuid.optional(),
    search: z.string().max(200).optional(),
    vendor: z.string().max(200).optional(),
    softwareName: z.string().min(1).max(500).optional(),
    query: z.string().min(1).max(200).optional(),
    sortBy: z.enum(['name', 'vendor', 'deviceCount', 'lastSeen']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: offset.optional(),
  }).strict(),

  bootstrap_homebrew: z.object({
    deviceId: uuid,
  }).strict(),

  manage_fleet_findings: z.object({
    action: z.enum(FLEET_FINDING_ACTIONS),
    findingId: uuid,
    notes: z.string().max(2000).optional(),
  }).strict(),

  manage_custom_fields: z.object({
    action: z.enum(CUSTOM_FIELD_ACTIONS),
    definitionId: uuid.optional(),
    orgId: uuid.optional(),
    ownerScope: z.enum(OWNER_SCOPES).optional(),
    name: z.string().min(1).max(100).optional(),
    fieldKey: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/).optional(),
    type: z.enum(CUSTOM_FIELD_TYPES).optional(),
    choices: z.array(z.string().min(1).max(255)).max(200).optional(),
    required: z.boolean().optional(),
    defaultValue: z.union([z.string().max(10000), z.number(), z.boolean()]).optional(),
    deviceTypes: z.array(z.enum(PLATFORMS)).max(3).optional(),
    scriptWrite: z.boolean().optional(),
    deviceId: uuid.optional(),
    values: z.record(z.string(), z.union([z.string().max(10000), z.number(), z.boolean(), z.null()])).optional(),
  }).strict(),
} as const satisfies Record<string, z.ZodObject<z.ZodRawShape>>;
