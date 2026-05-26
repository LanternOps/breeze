import { z } from 'zod';
import { DEVICES_SORT_KEYS } from './cursor';

const DEVICE_ROLES = [
  'workstation', 'server', 'printer', 'router', 'switch',
  'firewall', 'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown'
] as const;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * CSV-of-UUIDs query param. Accepts `?orgIds=uuid1,uuid2,uuid3`.
 * Returns `string[]` on success, `undefined` when the param is absent.
 * Each UUID is shape-validated; a single malformed entry rejects the
 * whole list (no silent dropping of garbage).
 */
const csvUuidList = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined || raw === '') return undefined;
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return undefined;
    for (const p of parts) {
      if (!UUID_RE.test(p)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid uuid: ${p}` });
        return z.NEVER;
      }
    }
    return parts;
  });

const boolStr = z.enum(['true', 'false']).optional();

export const listDevicesSchema = z.object({
  // Legacy offset pagination — still honored when no `cursor` is provided
  // AND `page` is explicitly set, so existing callers keep working. Cursor
  // pagination supersedes for new callers (see Discussion #742).
  page: z.string().optional(),
  limit: z.string().optional(),

  // Cursor pagination (Discussion #742 PR 3).
  cursor: z.string().optional(),
  sort: z.enum(DEVICES_SORT_KEYS).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  /** When true, the cursor-less first response includes a `total` count.
   *  Subsequent cursor pages never recompute — the client carries the
   *  count it received on page 1. Default off because the count(*) is the
   *  most expensive part of the query at scale. */
  includeTotal: boolStr,

  // Single-value filters (compat).
  orgId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),

  // First-class multi-value filters (#742). Plural form of the singletons
  // above; both may be supplied. The handler ANDs them with auth's
  // org-scope so a cross-org filter is rejected by RLS at the row level.
  orgIds: csvUuidList,
  siteIds: csvUuidList,
  groupIds: csvUuidList,

  status: z.enum(['online', 'offline', 'maintenance', 'decommissioned', 'updating']).optional(),
  includeDecommissioned: boolStr,
  osType: z.enum(['windows', 'macos', 'linux']).optional(),
  role: z.enum(DEVICE_ROLES).optional(),
  search: z.string().optional()
});

export const updateDeviceSchema = z.object({
  // Nullable so the inline-edit "clear" path (empty input → PATCH {displayName:null})
  // can unset the name; the devices.display_name column is nullable. See PR #787.
  displayName: z.string().max(255).nullable().optional(),
  siteId: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
  customFields: z.record(
    z.string().max(100),
    z.union([z.string().max(10000), z.number(), z.boolean(), z.null()])
  ).optional(),
  deviceRole: z.enum(DEVICE_ROLES).optional()
});

export const metricsQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  interval: z.enum(['1m', '5m', '1h', '1d']).optional(),
  range: z.enum(['1h', '6h', '24h', '7d', '30d']).optional()
});

export const softwareQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  search: z.string().optional()
});

export const createCommandSchema = z.object({
  // 'wake' is the user-facing wake action. Internally it dispatches via the
  // wakeOnLan service and writes a deviceCommands row of type 'wake_on_lan'
  // addressed to a relay agent. See apps/api/src/services/wakeOnLan.ts.
  type: z.enum(['script', 'reboot', 'reboot_safe_mode', 'shutdown', 'update', 'collect_evidence', 'execute_containment', 'wake', 'refresh_inventory']),
  payload: z.any().optional()
});

/**
 * Per-request cap on bulk command operations. 500 keeps the worst-case
 * wall time well under Cloudflare's ~100s proxy timeout (HTTP 524) even
 * if a future bulk type ends up serial — at the inline 8-worker pool
 * used by the bulk-wake path, 500 devices completes in single-digit
 * seconds. Caps DoS risk from an auth'd caller passing a giant array.
 */
export const BULK_COMMAND_MAX_DEVICES = 500;

export const bulkCommandSchema = z.object({
  deviceIds: z.array(z.string().uuid()).min(1).max(BULK_COMMAND_MAX_DEVICES),
  type: z.enum(['script', 'reboot', 'reboot_safe_mode', 'shutdown', 'update', 'collect_evidence', 'execute_containment', 'wake', 'refresh_inventory']),
  payload: z.any().optional()
});

export const maintenanceModeSchema = z.object({
  enable: z.boolean(),
  durationHours: z.number().int().positive().max(168).optional()
});

export const createGroupSchema = z.object({
  orgId: z.string().uuid(),
  name: z.string().min(1).max(255),
  siteId: z.string().uuid().optional(),
  type: z.enum(['static', 'dynamic']),
  rules: z.any().optional(),
  parentId: z.string().uuid().optional()
});

export const updateGroupSchema = createGroupSchema.partial().omit({ orgId: true });
