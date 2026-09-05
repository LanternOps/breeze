/**
 * AI Tool Input Schemas
 *
 * Zod schemas for validating tool inputs before execution.
 * Provides defense-in-depth against malformed or malicious inputs
 * from the AI model.
 */

import { z } from 'zod';
import { isIP } from 'node:net';
import { ACTOR_TYPES, AI_AGENT_KINDS, INVOICE_STATUSES, currencyCodeSchema } from '@breeze/shared';
import { backupProfileSelectionsSchema, ringAutoApproveSchema } from '@breeze/shared/validators';
import { aiRunContextInputShape } from './scriptRunRequest';
import { fleetToolInputSchemas } from './aiToolSchemasFleet';
import { backupToolSchemas } from './aiToolSchemasBackup';
import { m365ToolSchemas } from './aiToolSchemasM365';
import {
  peripheralDeviceClassEnum,
  peripheralPolicyActionEnum,
  peripheralPolicyTargetTypeEnum,
  peripheralEventTypeEnum
} from '../db/schema';
import { CONFIG_FEATURE_TYPES } from './configFeatureTypes';
import { CONTACT_ROLES } from './contacts/types';

// Reusable validators
const uuid = z.string().guid();
const deviceId = z.object({ deviceId: uuid });
const ipAddress = z.string().trim().max(45).refine(
  (value) => {
    const withoutZone = value.includes('%') ? value.slice(0, Math.max(value.indexOf('%'), 0)) : value;
    return isIP(withoutZone) !== 0;
  },
  { message: 'Invalid IP address format' }
);

// Path traversal defense
const BLOCKED_PATH_PREFIXES = [
  '/etc/shadow', '/etc/passwd', '/etc/sudoers',
  '/proc', '/sys', '/dev',
  '/root/.ssh', '/home/*/.ssh',
  '/var/run', '/var/lib/docker',
  'C:\\Windows\\System32\\config',
  'C:\\Windows\\SAM',
  'C:\\Users\\*\\AppData',
];

export function normalizePath(path: string): string {
  let result = path
    .replace(/\\/g, '/')      // Normalize backslashes
    .replace(/\/+/g, '/')     // Collapse redundant separators (/etc///shadow → /etc/shadow)
    .toLowerCase();
  // Iteratively remove dot components until stable
  let prev: string;
  do {
    prev = result;
    result = result.replace(/\/\.\//g, '/').replace(/\/\.$/, '/');
  } while (result !== prev);
  return result;
}

export function isBlockedPath(path: string): boolean {
  if (path.includes('..')) return true;
  const normalized = normalizePath(path);
  return BLOCKED_PATH_PREFIXES.some(prefix => {
    const normalizedPrefix = normalizePath(prefix);
    // Handle wildcard prefixes like /home/*/.ssh
    if (normalizedPrefix.includes('*')) {
      const parts = normalizedPrefix.split('*');
      return parts.length === 2 &&
        normalized.startsWith(parts[0]!) &&
        normalized.includes(parts[1]!);
    }
    return normalized.startsWith(normalizedPrefix) ||
      normalized === normalizedPrefix.replace(/\/$/, '');
  });
}

export const safePath = z.string().max(4096).refine(
  (path) => !path.includes('\0'),
  { message: 'Path contains null bytes' }
).refine(
  (path) => !path.includes('..'),
  { message: 'Path traversal (..) not allowed' }
).refine(
  (path) => !isBlockedPath(path),
  { message: 'Access to this path is blocked' }
);

const cleanupPath = z.string().max(4096).refine(
  (path) => !path.includes('\0'),
  { message: 'Path contains null bytes' }
).refine(
  (path) => !path.includes('..'),
  { message: 'Path traversal (..) not allowed' }
);

// Tool schemas
export const toolInputSchemas: Record<string, z.ZodType> = {
  query_devices: z.object({
    status: z.enum(['online', 'offline', 'maintenance', 'decommissioned']).optional(),
    osType: z.enum(['windows', 'macos', 'linux']).optional(),
    siteId: uuid.optional(),
    search: z.string().max(200).optional(),
    tags: z.array(z.string().max(100)).max(20).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_device_details: z.object({
    deviceId: uuid,
  }),

  // BE-16 vulnerability tools. status/severity accept any case (feeds disagree on
  // casing); the handler re-normalizes to lowercase before querying.
  get_vulnerability_report: z.object({
    status: z.string().trim().transform((v) => v.toLowerCase()).pipe(z.enum(['open', 'patched', 'mitigated', 'accepted', 'all'])).optional(),
    severity: z.string().trim().transform((v) => v.toLowerCase()).pipe(z.enum(['low', 'medium', 'high', 'critical'])).optional(),
  }),

  get_device_vulnerabilities: z.object({
    deviceId: uuid,
    status: z.string().trim().transform((v) => v.toLowerCase()).pipe(z.enum(['open', 'patched', 'mitigated', 'accepted', 'all'])).optional(),
  }),

  // `deviceId` (optional) pins the batch to ONE device: the handler refuses
  // the whole call when any finding belongs to a different machine (P2-2 task
  // 5, #4189). A scheduled sweep proposes remediation from its own per-device
  // evidence row, so it always has the id to pin with; interactive chat may
  // still omit it and remediate across devices as before.
  remediate_vulnerability: z.object({
    deviceVulnerabilityIds: z.array(uuid).min(1).max(100),
    deviceId: uuid.optional(),
  }),

  // PAM Brain elevation tools (#1160). durationMinutes/limit are intentionally
  // un-capped here — the handlers clamp them (480 / 100) so the Brain can pass a
  // larger value without a validation failure.
  request_elevation: z.object({
    deviceId: uuid,
    subjectUsername: z.string().min(1).max(255),
    reason: z.string().min(1).max(2000),
    durationMinutes: z.number().int().min(1).optional(),
    subjectAdGroups: z.array(z.string().min(1).max(255)).max(200).optional(),
  }),

  revoke_elevation: z.object({
    elevationRequestId: uuid,
    reason: z.string().min(1).max(2000),
  }),

  get_elevation_history: z.object({
    deviceId: uuid.optional(),
    status: z.enum(['pending', 'approved', 'auto_approved', 'denied', 'expired', 'revoked', 'actuating']).optional(),
    flowType: z.enum(['uac_intercept', 'tech_jit_admin', 'ai_tool_action']).optional(),
    limit: z.number().int().min(1).optional(),
  }),

  get_ip_history: z.object({
    device_id: uuid.optional(),
    ip_address: ipAddress.optional(),
    at_time: z.string().datetime({ offset: true }).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    interface_name: z.string().max(100).optional(),
    assignment_type: z.enum(['dhcp', 'static', 'vpn', 'link-local', 'unknown']).optional(),
    active_only: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }).refine(
    (data) => Boolean(data.device_id || data.ip_address),
    { message: 'Either device_id or ip_address must be provided' }
  ).refine(
    (data) => !data.ip_address || Boolean(data.at_time),
    { message: 'at_time is required when ip_address is provided' }
  ),

  analyze_metrics: z.object({
    deviceId: uuid,
    metric: z.enum(['cpu', 'ram', 'disk', 'network', 'all']).optional(),
    hoursBack: z.number().int().min(1).max(168).optional(),
    aggregation: z.enum(['raw', 'hourly', 'daily']).optional(),
  }),

  // Fleet hygiene findings (Task 8) — read-only fleet-wide aggregation tools.
  analyze_fleet_metrics: z.object({
    metricName: z.enum(['cpu_percent', 'ram_percent', 'disk_percent']),
    windowHours: z.number().int().min(1).max(168).optional(),
    topN: z.number().int().min(1).max(50).optional(),
    orgId: uuid.optional(),
  }),

  get_active_users: z.object({
    deviceId: uuid.optional(),
    limit: z.number().int().min(1).max(200).optional(),
    idleThresholdMinutes: z.number().int().min(1).max(1440).optional(),
  }),

  get_user_experience_metrics: z.object({
    deviceId: uuid.optional(),
    username: z.string().max(255).optional(),
    daysBack: z.number().int().min(1).max(365).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),

  manage_tickets: z.object({
    action: z.enum([
      'list',
      'get',
      'create',
      'comment',
      'assign',
      'update_status',
      'log_time_entry',
      'start_timer',
      'stop_timer',
      'update_fields',
      'link_alert',
      'unlink_alert',
      'create_from_alert',
      'edit_comment',
      'delete_comment',
      'move_org',
      // P2-4 (#4191) ticket-triage executors.
      'link_device',
      'draft',
    ]),
    ticketId: uuid.optional(),
    alertId: uuid.optional(),
    commentId: uuid.optional(),
    expectedTicketId: uuid.optional(),
    targetOrgId: uuid.optional(),
    orgId: uuid.optional(),
    deviceId: uuid.optional(),
    assigneeId: uuid.optional(),
    subject: z.string().min(1).max(255).optional(),
    description: z.string().max(50_000).optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    status: z.enum(['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']).optional(),
    statusName: z.string().min(1).max(60).optional(),
    resolutionNote: z.string().max(10000).optional(),
    content: z.string().max(50_000).optional(),
    // link_device (P2-4): resolve a device by exact hostname or serial number
    // within the ticket's org.
    // O1 (final review #4191): this `serial` max(100) is the bound that
    // packages/shared/src/validators/ticketTriage.ts's `device.serial` is
    // deliberately coupled to (see that file's comment) — a triage
    // proposal's serial longer than this AND <=255 used to pass the
    // validator, then silently drop the device-link slot as `intent_error`
    // here. Keep the two in sync if either changes.
    hostname: z.string().min(1).max(255).optional(),
    serial: z.string().min(1).max(100).optional(),
    // draft (P2-4): which ticket_drafts kind this proposal is.
    kind: z.enum(['reply', 'resolution_note']).optional(),
    isPublic: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    pendingReason: z.string().max(500).optional(),
    startedAt: z.string().datetime().optional(),
    endedAt: z.string().datetime().optional(),
    isBillable: z.boolean().optional(),
    // Interpreted in the ticket org's currency (spec §9); the entry snapshots that currency.
    hourlyRate: z.number().nonnegative().optional(),
    fields: z.object({
      subject: z.string().min(1).max(255).optional(),
      description: z.string().max(50_000).optional(),
      categoryId: uuid.nullable().optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      dueDate: z.string().datetime().nullable().optional(),
      responseSlaMinutes: z.number().int().nonnegative().nullable().optional(),
      resolutionSlaMinutes: z.number().int().nonnegative().nullable().optional(),
      deviceId: uuid.nullable().optional(),
      tags: z.array(z.string().min(1).max(100)).max(50).optional(),
      submittedBy: uuid.nullable().optional(),
      submitterName: z.string().max(255).nullable().optional(),
      submitterEmail: z.string().email().max(255).nullable().optional(),
    }).optional(),
    overrides: z.object({
      subject: z.string().min(1).max(255).optional(),
      description: z.string().max(50_000).optional(),
      categoryId: uuid.optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      assigneeId: uuid.optional(),
    }).optional(),
  }),

  list_invoices: z.object({
    orgId: uuid.optional(),
    status: z.enum(INVOICE_STATUSES).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_invoice: z.object({
    invoiceId: uuid,
  }),

  manage_invoices: z.object({
    action: z.enum([
      'create_draft', 'add_manual_line', 'add_catalog_line', 'add_bundle_line', 'add_contract_line',
      'update_line', 'remove_line', 'update_header', 'delete_draft',
      'assemble_from_org', 'assemble_from_ticket',
      'issue', 'void', 'record_payment', 'void_payment', 'create_pay_link',
    ]),
    orgId: uuid.optional(),
    siteId: uuid.optional(),
    invoiceId: uuid.optional(),
    lineId: uuid.optional(),
    paymentId: uuid.optional(),
    catalogItemId: uuid.optional(),
    bundleId: uuid.optional(),
    contractId: uuid.optional(),
    contractLineId: uuid.optional(),
    ticketId: uuid.optional(),
    quantity: z.number().optional(),
    notes: z.string().optional(),
    termsAndConditions: z.string().optional(),
    reason: z.string().optional(),
    reissue: z.boolean().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    // Assembly header-currency override (#3776). Shared validator on purpose
    // (spec §4): a bare length(3) would admit unsupported codes until the FK.
    currencyCode: currencyCodeSchema.optional(),
    line: z.record(z.string(), z.unknown()).optional(),
    patch: z.record(z.string(), z.unknown()).optional(),
    payment: z.record(z.string(), z.unknown()).optional(),
  }),

  list_quotes: z.object({
    orgId: uuid.optional(),
    status: z.enum(['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'converted', 'superseded']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_quote: z.object({
    quoteId: uuid,
    // Large quotes (many content blocks) can exceed the MCP output cap. These
    // let the caller page the blocks or fetch a block-metadata overview (#3485).
    blocksOffset: z.number().int().min(0).optional(),
    blocksLimit: z.number().int().min(1).max(100).optional(),
    includeBlockContent: z.boolean().optional(),
  }),

  list_organizations: z.object({
    search: z.string().max(255).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  // AI agent governance (P2-5, #4192). `orgId` is an ADDRESS, never an
  // authority — it exists so the effect-digest resolver (which receives
  // `(args, database)` and nothing else, and recomputes under a system context
  // with no ambient org) can name the org whose supervised keys are changing.
  // Creation sets it from the authenticated org and rejects
  // `args.orgId !== intent.orgId`; the executor re-asserts the same equality
  // under the graduation lock before writing. See aiToolsAiAgentGovernance.ts.
  // Keys mirror the tool's advertised input_schema exactly; a key Zod does not
  // know is STRIPPED silently rather than rejected (#2814).
  manage_ai_agents: z.object({
    action: z.enum(['authorize_supervised_key']),
    kind: z.enum(AI_AGENT_KINDS),
    opKey: z.string().min(3).max(120),
    orgId: uuid,
  }),

  manage_organizations: z.object({
    action: z.enum(['create_org', 'update_org', 'create_site', 'add_contact']),
    orgId: uuid.optional(),
    name: z.string().min(1).max(255).optional(),
    status: z.enum(['active', 'suspended', 'trial', 'churned']).optional(),
    address: z.record(z.string(), z.unknown()).optional(),
    email: z.string().email().max(255).optional(),
    siteId: uuid.optional(),
    phone: z.string().max(64).optional(),
    mobile: z.string().max(64).optional(),
    title: z.string().max(255).optional(),
    roles: z.array(z.enum(CONTACT_ROLES)).optional(),
    isPrimary: z.boolean().optional(),
  }),

  manage_quotes: z.object({
    action: z.enum([
      'create_draft',
      'update',
      'delete_draft',
      'add_block',
      'update_block',
      'delete_block',
      'reorder_blocks',
      'add_manual_line',
      'add_catalog_line',
      'update_line',
      'remove_line',
      'move_line',
      'reorder_lines',
      'send',
      'decline',
      'create_pay_link',
    ]),
    quoteId: uuid.optional(),
    blockId: uuid.optional(),
    lineId: uuid.optional(),
    catalogItemId: uuid.optional(),
    quantity: z.number().optional(),
    partNumber: z.string().optional(),
    reason: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    block: z.record(z.string(), z.unknown()).optional(),
    line: z.record(z.string(), z.unknown()).optional(),
    patch: z.record(z.string(), z.unknown()).optional(),
    blockIds: z.array(uuid).optional(),
    lineIds: z.array(uuid).optional(),
  }),

  search_catalog: z.object({
    search: z.string().optional(),
    itemType: z.enum(['hardware', 'software', 'service']).optional(),
    isBundle: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_catalog_item: z.object({
    catalogItemId: uuid,
  }),

  lookup_distributor_product: z.object({
    query: z.string().min(1).max(40),
  }),

  manage_catalog: z.object({
    action: z.enum([
      'create_item',
      'update_item',
      'archive_item',
      'set_org_price',
      'remove_org_price',
      'set_bundle_components',
    ]),
    catalogId: uuid.optional(),
    orgId: uuid.optional(),
    item: z.record(z.string(), z.unknown()).optional(),
    override: z.record(z.string(), z.unknown()).optional(),
    components: z.array(z.record(z.string(), z.unknown())).optional(),
  }),

  list_contracts: z.object({
    orgId: uuid.optional(),
    status: z.enum(['draft', 'active', 'paused', 'cancelled', 'expired']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_contract: z.object({
    contractId: uuid,
  }),

  manage_contracts: z.object({
    action: z.enum([
      'create_draft',
      'update',
      'delete_draft',
      'add_line',
      'remove_line',
      'update_line',
      'activate',
      'pause',
      'resume',
      'cancel',
    ]),
    contractId: uuid.optional(),
    lineId: uuid.optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    line: z.record(z.string(), z.unknown()).optional(),
    patch: z.record(z.string(), z.unknown()).optional(),
  }),

  // Review round 1 (IMPORTANT 5, P2-1): `suppress` and `suppressDuration`
  // were missing here even though the tool definition (aiToolsAlerts.ts)
  // has always supported them — an approved `suppress` action-intent
  // (including one an alert verdict's suggestedAction created, wave P2-1)
  // failed THIS validation at release time, after approval, the worst place
  // for a rejection. `suppressDuration` bounds mirror the tool definition's
  // own doc string: 0-720 hours, 0 meaning "suppress forever".
  manage_alerts: z.object({
    action: z.enum(['list', 'get', 'acknowledge', 'resolve', 'suppress']),
    alertId: uuid.optional(),
    status: z.enum(['active', 'acknowledged', 'resolved', 'suppressed']).optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
    deviceId: uuid.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    resolutionNote: z.string().max(1000).optional(),
    suppressDuration: z.number().int().min(0).max(720).optional(),
  }).refine(
    (data) => {
      if (['get', 'acknowledge', 'resolve', 'suppress'].includes(data.action) && !data.alertId) {
        return false;
      }
      return true;
    },
    { message: 'alertId is required for get/acknowledge/resolve/suppress actions' }
  ),

  get_dns_security: z.object({
    timeRange: z.object({
      start: z.string().datetime({ offset: true }),
      end: z.string().datetime({ offset: true }),
    }),
    deviceId: uuid.optional(),
    integrationId: uuid.optional(),
    action: z.enum(['allowed', 'blocked', 'redirected']).optional(),
    category: z.string().max(100).optional(),
    topN: z.number().int().min(1).max(100).optional(),
  }).superRefine((data, ctx) => {
    const start = new Date(data.timeRange.start);
    const end = new Date(data.timeRange.end);
    if (start.getTime() > end.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeRange', 'start'],
        message: 'timeRange.start must be before or equal to timeRange.end',
      });
      return;
    }
    const maxWindowMs = 90 * 24 * 60 * 60 * 1000;
    if ((end.getTime() - start.getTime()) > maxWindowMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeRange'],
        message: 'timeRange cannot exceed 90 days',
      });
    }
  }),

  get_huntress_status: z.object({
    orgId: uuid.optional(),
    integrationId: uuid.optional(),
  }),

  get_huntress_incidents: z.object({
    orgId: uuid.optional(),
    integrationId: uuid.optional(),
    status: z.enum(['open', 'in_progress', 'resolved', 'dismissed']).optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    deviceId: uuid.optional(),
    search: z.string().max(200).optional(),
    includeResolved: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).max(100000).optional(),
  }),

  sync_huntress_data: z.object({
    orgId: uuid.optional(),
    integrationId: uuid.optional(),
  }),

  manage_dns_policy: z.object({
    integrationId: uuid,
    action: z.enum(['add_block', 'remove_block', 'add_allow', 'remove_allow']),
    domains: z.array(z.string().min(1).max(500)).min(1).max(500),
    reason: z.string().max(2000).optional(),
  }),

  get_s1_status: z.object({
    orgId: uuid.optional(),
  }),

  get_s1_threats: z.object({
    orgId: uuid.optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'unknown']).optional(),
    status: z.enum(['active', 'in_progress', 'quarantined', 'resolved']).optional(),
    deviceId: uuid.optional(),
    search: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),

  s1_isolate_device: z.object({
    orgId: uuid.optional(),
    deviceId: uuid.optional(),
    deviceIds: z.array(uuid).min(1).max(200).optional(),
    isolate: z.boolean().optional(),
  }).superRefine((data, ctx) => {
    const count = (data.deviceId ? 1 : 0) + (data.deviceIds?.length ?? 0);
    if (count === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'deviceId or deviceIds is required',
      });
    }
  }),

  s1_threat_action: z.object({
    orgId: uuid.optional(),
    action: z.enum(['kill', 'quarantine', 'rollback']),
    threatIds: z.array(z.string().min(1).max(128)).min(1).max(200),
  }),

  get_peripheral_activity: z.object({
    org_id: uuid.optional(),
    device_id: uuid.optional(),
    policy_id: uuid.optional(),
    event_type: z.enum(peripheralEventTypeEnum.enumValues).optional(),
    start: z.string().datetime({ offset: true }).optional(),
    end: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }).superRefine((data, ctx) => {
    if (data.start && data.end) {
      const s = new Date(data.start);
      const e = new Date(data.end);
      if (s.getTime() > e.getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['start'],
          message: 'start must be before end',
        });
        return;
      }
      const maxWindowMs = 90 * 24 * 60 * 60 * 1000;
      if ((e.getTime() - s.getTime()) > maxWindowMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['start'],
          message: 'Time range cannot exceed 90 days',
        });
      }
    }
  }),

  manage_peripheral_policy: z.object({
    action: z.enum(['create', 'update', 'disable', 'add_exception', 'remove_exception']),
    policy_id: uuid.optional(),
    org_id: uuid.optional(),
    name: z.string().min(1).max(200).optional(),
    device_class: z.enum(peripheralDeviceClassEnum.enumValues).optional(),
    policy_action: z.enum(peripheralPolicyActionEnum.enumValues).optional(),
    target_type: z.enum(peripheralPolicyTargetTypeEnum.enumValues).optional(),
    target_ids: z.object({
      siteIds: z.array(z.string().guid()).max(1000).optional(),
      groupIds: z.array(z.string().guid()).max(1000).optional(),
      deviceIds: z.array(z.string().guid()).max(5000).optional(),
    }).optional(),
    is_active: z.boolean().optional(),
    exception: z.object({
      vendor: z.string().max(255).optional(),
      product: z.string().max(255).optional(),
      serialNumber: z.string().max(255).optional(),
      allow: z.boolean().optional(),
      reason: z.string().max(2000).optional(),
      expiresAt: z.string().datetime({ offset: true }).optional(),
    }).optional(),
    match: z.object({
      vendor: z.string().max(255).optional(),
      product: z.string().max(255).optional(),
      serialNumber: z.string().max(255).optional(),
    }).optional(),
  }).superRefine((data, ctx) => {
    if ((data.action === 'update' || data.action === 'disable' || data.action === 'add_exception' || data.action === 'remove_exception') && !data.policy_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['policy_id'],
        message: 'policy_id is required for this action',
      });
    }

    if (data.action === 'create') {
      if (!data.name) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['name'],
          message: 'name is required for create',
        });
      }
      if (!data.device_class) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['device_class'],
          message: 'device_class is required for create',
        });
      }
      if (!data.policy_action) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['policy_action'],
          message: 'policy_action is required for create',
        });
      }
      if (!data.target_type) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['target_type'],
          message: 'target_type is required for create',
        });
      }
    }

    if (data.action === 'add_exception') {
      const rule = data.exception ?? {};
      const vendor = typeof rule.vendor === 'string' && rule.vendor.trim().length > 0;
      const product = typeof rule.product === 'string' && rule.product.trim().length > 0;
      const serialNumber = typeof rule.serialNumber === 'string' && rule.serialNumber.trim().length > 0;
      if (!vendor && !product && !serialNumber) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['exception'],
          message: 'exception must include at least one of vendor, product, or serialNumber',
        });
      }
    }

    if (data.action === 'remove_exception') {
      const match = data.match;
      const hasMatch = Boolean(
        (typeof match?.vendor === 'string' && match.vendor.trim().length > 0)
        || (typeof match?.product === 'string' && match.product.trim().length > 0)
        || (typeof match?.serialNumber === 'string' && match.serialNumber.trim().length > 0)
      );
      if (!hasMatch) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['match'],
          message: 'match must include at least one of vendor, product, or serialNumber',
        });
      }
    }
  }),

  execute_command: z.object({
    deviceId: uuid,
    commandType: z.enum([
      'list_processes', 'kill_process',
      'list_services', 'start_service', 'stop_service', 'restart_service',
      'file_list', 'file_read',
      'event_logs_list', 'event_logs_query',
    ]),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),

  run_script: z.object({
    scriptId: uuid,
    deviceIds: z.array(uuid).min(1).max(10),
    parameters: z.record(z.string(), z.unknown()).optional(),
    // #4888 — an assistant may choose the run context, under exactly the
    // constraints a human caller has (services/scriptRunRequest.ts): the enum
    // excludes 'elevated', and the handler re-parses the pair through the very
    // same `executeScriptSchema` the HTTP route uses before it reaches
    // dispatch. The cross-field rules ("targetSessionId needs runAs=user",
    // "…and exactly one device") live there, not here, so the two callers
    // cannot disagree about them.
    ...aiRunContextInputShape,
  }),

  manage_services: z.object({
    deviceId: uuid,
    action: z.enum(['list', 'start', 'stop', 'restart']),
    serviceName: z.string().max(255).optional(),
  }).refine(
    (data) => {
      if (['start', 'stop', 'restart'].includes(data.action) && !data.serviceName) {
        return false;
      }
      return true;
    },
    { message: 'serviceName is required for start/stop/restart actions' }
  ),

  security_scan: z.object({
    deviceId: uuid,
    action: z.enum(['scan', 'status', 'quarantine', 'remove', 'restore']),
    threatId: z.string().max(255).optional(),
  }).refine(
    (data) => {
      if (['quarantine', 'remove', 'restore'].includes(data.action) && !data.threatId) {
        return false;
      }
      return true;
    },
    { message: 'threatId is required for quarantine/remove/restore actions' }
  ),

  manage_processes: z.object({
    action: z.enum(['list', 'kill']),
    deviceId: uuid,
    processId: z.string().max(20).optional(),
    // Optional at the tool-schema level (kill still works without it, same
    // as before) — but required for the manage_processes.kill act-manifest
    // entry to admit the call (actManifest.ts): a bare PID alone is never
    // sufficient identity for an unattended kill.
    processName: z.string().max(500).optional(),
    search: z.string().max(255).optional(),
    sortBy: z.enum(['cpu', 'memory', 'name', 'pid']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).refine(
    (data) => {
      if (data.action === 'kill' && !data.processId) {
        return false;
      }
      return true;
    },
    { message: 'processId is required for kill action' }
  ),

  get_security_posture: z.object({
    deviceId: uuid.optional(),
    orgId: uuid.optional(),
    minScore: z.number().int().min(0).max(100).optional(),
    maxScore: z.number().int().min(0).max(100).optional(),
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    includeRecommendations: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional()
  }),

  get_sensitive_data_overview: z.object({
    view: z.enum(['dashboard', 'findings', 'scans']).optional(),
    status: z.enum(['open', 'remediated', 'accepted', 'false_positive']).optional(),
    risk: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    dataType: z.enum(['pii', 'pci', 'phi', 'credential', 'financial']).optional(),
    deviceId: uuid.optional(),
    scanId: uuid.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),

  remediate_sensitive_data: z.object({
    findingIds: z.array(uuid).min(1).max(250),
    action: z.enum(['encrypt', 'quarantine', 'secure_delete', 'accept_risk', 'false_positive', 'mark_remediated']),
    confirm: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    secondApprovalToken: z.string().max(256).optional(),
    encryptionKeyRef: z.string().max(255).optional(),
    encryptionKeyVersion: z.string().max(100).optional(),
    quarantineDir: safePath.optional(),
  }),

  get_fleet_status: z.object({}),

  delete_tenant: z.object({
    tenant_id: uuid,
    confirmation_phrase: z.string().min(1).max(500),
  }),

  get_fleet_health: z.object({
    orgId: uuid.optional(),
    siteId: uuid.optional(),
    scoreRange: z.enum(['critical', 'poor', 'fair', 'good']).optional(),
    trendDirection: z.enum(['improving', 'stable', 'degrading']).optional(),
    issueType: z.enum(['crashes', 'hangs', 'hardware', 'services', 'uptime']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  // Fleet hygiene findings (Task 8) — deduplicated fleet-wide findings feed.
  // `status` stays a free-form string (not a CSV-of-enum type) because the
  // handler itself validates the comma-separated list via
  // parseFleetFindingStatusCsv and returns a structured error on an invalid
  // value — see aiToolsFleet.ts.
  get_fleet_findings: z.object({
    kind: z.enum(['metric_anomaly_pattern', 'log_correlation', 'reliability_offenders']).optional(),
    severity: z.enum(['info', 'warning', 'error', 'critical']).optional(),
    status: z.string().max(200).optional(),
    orgId: uuid.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),

  get_user_risk_scores: z.object({
    orgId: uuid.optional(),
    siteId: uuid.optional(),
    minScore: z.number().int().min(0).max(100).optional(),
    maxScore: z.number().int().min(0).max(100).optional(),
    trendDirection: z.enum(['up', 'down', 'stable']).optional(),
    search: z.string().max(255).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),

  get_user_risk_detail: z.object({
    userId: uuid,
    orgId: uuid.optional(),
  }),

  assign_security_training: z.object({
    userId: uuid,
    orgId: uuid.optional(),
    moduleId: z.string().min(1).max(120).optional(),
    reason: z.string().min(1).max(500).optional(),
  }),

  // Backup & DR tool modules (extracted to aiToolSchemasBackup.ts)
  ...backupToolSchemas,

  file_operations: z.object({
    deviceId: uuid,
    action: z.enum(['list', 'read', 'write', 'delete', 'mkdir', 'rename']),
    path: safePath,
    content: z.string().max(1_000_000).optional(),
    newPath: safePath.optional(),
  }),

  analyze_disk_usage: z.object({
    deviceId: uuid,
    refresh: z.boolean().optional(),
    path: safePath.optional(),
    maxDepth: z.number().int().min(1).max(64).optional(),
    topFiles: z.number().int().min(1).max(500).optional(),
    topDirs: z.number().int().min(1).max(200).optional(),
    maxEntries: z.number().int().min(1_000).max(25_000_000).optional(),
    workers: z.number().int().min(1).max(32).optional(),
    timeoutSeconds: z.number().int().min(5).max(900).optional(),
    maxCandidates: z.number().int().min(1).max(200).optional(),
  }),

  disk_cleanup: z.object({
    deviceId: uuid,
    action: z.enum(['preview', 'execute']),
    categories: z.array(z.enum(['temp_files', 'browser_cache', 'package_cache', 'trash'])).max(10).optional(),
    paths: z.array(cleanupPath).min(1).max(200).optional(),
    maxCandidates: z.number().int().min(1).max(200).optional(),
  }).refine(
    (data) => data.action === 'preview' || (data.action === 'execute' && Array.isArray(data.paths) && data.paths.length > 0),
    { message: 'paths are required for execute action' }
  ),

  query_audit_log: z.object({
    action: z.string().max(100).optional(),
    resourceType: z.string().max(100).optional(),
    resourceId: uuid.optional(),
    actorType: z.enum(ACTOR_TYPES).optional(),
    hoursBack: z.number().int().min(1).max(168).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_network_changes: z.object({
    org_id: uuid.optional(),
    site_id: uuid.optional(),
    baseline_id: uuid.optional(),
    event_type: z.enum(['new_device', 'device_disappeared', 'device_changed', 'rogue_device']).optional(),
    acknowledged: z.boolean().optional(),
    since: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),

  acknowledge_network_device: z.object({
    event_id: uuid,
    notes: z.string().max(2000).optional(),
  }),

  configure_network_baseline: z.object({
    baseline_id: uuid.optional(),
    org_id: uuid.optional(),
    site_id: uuid.optional(),
    subnet: z.string().regex(/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/).optional(),
    scan_interval_hours: z.number().int().min(1).max(168).optional(),
    alert_on_new_device: z.boolean().optional(),
    alert_on_disappeared: z.boolean().optional(),
    alert_on_changed: z.boolean().optional(),
    alert_on_rogue_device: z.boolean().optional(),
  }),

  query_change_log: z.object({
    deviceId: uuid.optional(),
    startTime: z.string().datetime({ offset: true }).optional(),
    endTime: z.string().datetime({ offset: true }).optional(),
    changeType: z.enum(['software', 'service', 'startup', 'network', 'scheduled_task', 'user_account', 'hardware', 'os_version']).optional(),
    changeAction: z.enum(['added', 'removed', 'modified', 'updated']).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),

  network_discovery: z.object({
    deviceId: uuid,
    subnet: z.string().max(50).regex(
      /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/,
      'Invalid CIDR notation'
    ).optional(),
    scanType: z.enum(['ping', 'arp', 'full']).optional(),
  }),

  take_screenshot: deviceId.extend({
    monitor: z.number().int().min(0).max(10).optional(),
  }),

  analyze_screen: deviceId.extend({
    context: z.string().max(500).optional(),
    monitor: z.number().int().min(0).max(10).optional(),
  }),

  // Brain device context tools
  get_device_context: z.object({
    deviceId: uuid,
    includeResolved: z.boolean().optional().default(false),
  }),

  set_device_context: z.object({
    deviceId: uuid,
    contextType: z.enum(['issue', 'quirk', 'followup', 'preference']),
    summary: z.string().min(1).max(255),
    details: z.record(z.string(), z.unknown()).optional(),
    expiresInDays: z.number().int().positive().max(365).optional(),
  }),

  resolve_device_context: z.object({
    contextId: uuid,
  }),

  // Computer control with conditional field validation
  computer_control: z.object({
    deviceId: uuid,
    action: z.enum([
      'screenshot', 'left_click', 'right_click', 'middle_click',
      'double_click', 'mouse_move', 'scroll', 'key', 'type',
    ]),
    x: z.number().int().min(0).max(10000).optional(),
    y: z.number().int().min(0).max(10000).optional(),
    text: z.string().max(1000).optional(),
    key: z.string().max(50).regex(/^[a-zA-Z0-9_]+$/, 'Invalid key name').optional(),
    modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).max(4).optional(),
    scrollDelta: z.number().int().min(-100).max(100).optional(),
    monitor: z.number().int().min(0).max(10).optional(),
    captureAfter: z.boolean().optional(),
    captureDelayMs: z.number().int().min(0).max(3000).optional(),
  }).superRefine((data, ctx) => {
    const MOUSE_ACTIONS = ['left_click', 'right_click', 'middle_click', 'double_click', 'mouse_move', 'scroll'];
    if (MOUSE_ACTIONS.includes(data.action)) {
      if (data.x === undefined || data.y === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `x and y coordinates are required for ${data.action} action`,
          path: ['x'],
        });
      }
    }
    if (data.action === 'key' && !data.key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'key field is required for key action',
        path: ['key'],
      });
    }
    if (data.action === 'type' && !data.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'text field is required for type action',
        path: ['text'],
      });
    }
  }),

  // Boot performance & startup tools
  analyze_boot_performance: z.object({
    deviceId: uuid,
    bootsBack: z.number().int().min(1).max(30).optional(),
    triggerCollection: z.boolean().optional(),
  }),

  manage_startup_items: z.object({
    deviceId: uuid,
    itemName: z.string().min(1).max(255),
    itemId: z.string().max(512).optional(),
    itemType: z.string().max(64).optional(),
    itemPath: z.string().max(2048).optional(),
    action: z.enum(['disable', 'enable']),
    reason: z.string().max(500).optional(),
  }),

  // CIS hardening tools
  get_cis_compliance: z.object({
    orgId: uuid.optional(),
    baselineId: uuid.optional(),
    deviceId: uuid.optional(),
    osType: z.enum(['windows', 'macos', 'linux']).optional(),
    minScore: z.number().int().min(0).max(100).optional(),
    maxScore: z.number().int().min(0).max(100).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }).refine(
    (data) => data.minScore == null || data.maxScore == null || data.minScore <= data.maxScore,
    { message: 'minScore must be <= maxScore' },
  ),

  get_cis_device_report: z.object({
    deviceId: uuid,
    baselineId: uuid.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  apply_cis_remediation: z.object({
    deviceId: uuid,
    baselineId: uuid.optional(),
    baselineResultId: uuid.optional(),
    checkIds: z.array(z.string().min(1).max(120)).min(1).max(100),
    action: z.enum(['apply', 'rollback']).default('apply'),
    reason: z.string().max(1000).optional(),
  }),

  // Software policy tools
  get_software_compliance: z.object({
    policyId: uuid.optional(),
    deviceIds: z.array(uuid).max(500).optional(),
    status: z.enum(['compliant', 'violation', 'unknown']).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),

  manage_software_policy: z.object({
    action: z.enum(['create', 'update', 'delete', 'list', 'get']),
    policyId: uuid.optional(),
    orgId: uuid.optional(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    mode: z.enum(['allowlist', 'blocklist', 'audit']).optional(),
    software: z.array(z.object({
      name: z.string().min(1).max(500),
      vendor: z.string().max(200).optional(),
      minVersion: z.string().max(100).optional(),
      maxVersion: z.string().max(100).optional(),
      catalogId: uuid.optional(),
      reason: z.string().max(1000).optional(),
    })).max(1000).optional(),
    allowUnknown: z.boolean().optional(),
    targetType: z.enum(['organization', 'site', 'device_group', 'devices']).optional(),
    targetIds: z.array(uuid).max(1000).optional(),
    priority: z.number().int().min(0).max(100).optional(),
    enforceMode: z.boolean().optional(),
    isActive: z.boolean().optional(),
    remediationOptions: z.object({
      autoUninstall: z.boolean().optional(),
      notifyUser: z.boolean().optional(),
      gracePeriod: z.number().int().min(0).max(24 * 90).optional(), // hours; max 90 days
      cooldownMinutes: z.number().int().min(1).max(24 * 90 * 60).optional(),
      maintenanceWindowOnly: z.boolean().optional(),
    }).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).refine(
    (data) => !['update', 'delete', 'get'].includes(data.action) || !!data.policyId,
    { message: 'policyId is required for update/delete/get actions' }
  ).refine(
    // The handler's create branch only reads name/mode (aiToolsCompliance.ts)
    // — it never reads targetType/targetIds, so requiring targetType here
    // rejected valid creates for a field the handler ignores.
    (data) => data.action !== 'create' || (!!data.name && !!data.mode),
    { message: 'name and mode are required for create action' }
  ),

  remediate_software_violation: z.object({
    policyId: uuid,
    deviceIds: z.array(uuid).max(500).optional(),
    autoUninstall: z.boolean().optional(),
  }),

  // Agent log tools
  search_agent_logs: z.object({
    deviceIds: z.array(uuid).max(50).optional(),
    level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    component: z.string().max(100).optional(),
    startTime: z.string().datetime({ offset: true }).optional(),
    endTime: z.string().datetime({ offset: true }).optional(),
    message: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),

  set_agent_log_level: z.object({
    deviceId: uuid,
    level: z.enum(['debug', 'info', 'warn', 'error']),
    durationMinutes: z.number().int().min(1).max(1440).optional(),
  }),

  capture_agent_pprof: z.object({
    deviceId: uuid,
    profile: z.enum(['heap', 'goroutine', 'all']).optional(),
  }),

  // Event log tools
  search_logs: z.object({
    query: z.string().max(500).optional(),
    timeRange: z.object({
      start: z.string().datetime({ offset: true }),
      end: z.string().datetime({ offset: true }),
    }).optional(),
    level: z.array(z.enum(['info', 'warning', 'error', 'critical'])).max(4).optional(),
    category: z.array(z.enum(['security', 'hardware', 'application', 'system'])).max(4).optional(),
    source: z.string().max(255).optional(),
    deviceIds: z.array(uuid).max(500).optional(),
    siteIds: z.array(uuid).max(500).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
    cursor: z.string().max(1024).optional(),
    countMode: z.enum(['exact', 'estimated', 'none']).optional(),
    sortBy: z.enum(['timestamp', 'level', 'device']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  }),

  get_log_trends: z.object({
    timeRange: z.object({
      start: z.string().datetime({ offset: true }),
      end: z.string().datetime({ offset: true }),
    }).optional(),
    groupBy: z.enum(['level', 'source', 'device', 'category']).optional(),
    minLevel: z.enum(['info', 'warning', 'error', 'critical']).optional(),
    source: z.string().max(255).optional(),
    deviceIds: z.array(uuid).max(500).optional(),
    siteIds: z.array(uuid).max(500).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  detect_log_correlations: z.object({
    orgId: uuid.optional(),
    pattern: z.string().min(1).max(1000),
    isRegex: z.boolean().optional(),
    timeWindow: z.number().int().min(30).max(86_400).optional(),
    minDevices: z.number().int().min(1).max(200).optional(),
    minOccurrences: z.number().int().min(1).max(50_000).optional(),
  }),

  // Configuration policy tools
  list_configuration_policies: z.object({
    status: z.enum(['active', 'inactive', 'archived']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_effective_configuration: z.object({
    deviceId: uuid,
  }),

  preview_configuration_change: z.object({
    deviceId: uuid,
    add: z.array(z.object({
      configPolicyId: uuid,
      level: z.enum(['partner', 'organization', 'site', 'device_group', 'device']),
      targetId: uuid,
      priority: z.number().int().optional(),
    })).optional(),
    remove: z.array(uuid).optional(),
  }),

  apply_configuration_policy: z.object({
    configPolicyId: uuid,
    level: z.enum(['partner', 'organization', 'site', 'device_group', 'device']),
    targetId: uuid,
    priority: z.number().int().min(0).max(1000).optional(),
  }),

  remove_configuration_policy_assignment: z.object({
    assignmentId: uuid,
  }),

  manage_configuration_policy: z.object({
    action: z.enum(['create', 'update', 'activate', 'deactivate', 'delete']),
    policyId: uuid.optional(),
    name: z.string().min(1).max(255).optional(),
    description: z.string().optional(),
    status: z.enum(['active', 'inactive', 'archived']).optional(),
    orgId: uuid.optional(),
  }),

  get_configuration_policy: z.object({
    policyId: uuid,
  }),

  configuration_policy_compliance: z.object({
    action: z.enum(['summary', 'status']),
    policyId: uuid.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  manage_policy_feature_link: z.object({
    action: z.enum(['add', 'update', 'remove', 'list']),
    configPolicyId: uuid,
    featureLinkId: uuid.optional(),
    // Derived from the canonical list, never hand-copied: this enum had drifted
    // four values behind `configFeatureTypeEnum` and behind the enum the tool's
    // own definition advertises, so remote_access / pam / onedrive_helper /
    // vulnerability were documented and DB-valid but rejected here — those
    // feature types could not be linked from AI/MCP at all (#2814).
    featureType: z.enum(CONFIG_FEATURE_TYPES).optional(),
    featurePolicyId: uuid.optional().nullable(),
    inlineSettings: z.record(z.string(), z.unknown()).optional().nullable(),
  }),

  manage_backup_profiles: z.object({
    action: z.enum(['list', 'get', 'create', 'update', 'delete']),
    profileId: uuid.optional(),
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).optional(),
    ownerScope: z.enum(['organization', 'partner']).optional(),
    selections: backupProfileSelectionsSchema.optional(),
    isActive: z.boolean().optional(),
  }),

  // Playbook tools
  list_playbooks: z.object({
    category: z.enum(['disk', 'service', 'memory', 'patch', 'security', 'all']).optional(),
  }),

  execute_playbook: z.object({
    playbookId: uuid,
    deviceId: uuid,
    variables: z.record(z.string(), z.unknown()).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
  }),

  get_playbook_history: z.object({
    deviceId: uuid.optional(),
    playbookId: uuid.optional(),
    status: z.enum(['pending', 'running', 'waiting', 'completed', 'failed', 'rolled_back', 'cancelled']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  // Script library tools
  search_script_library: z.object({
    search: z.string().max(200).optional(),
    category: z.string().max(100).optional(),
    language: z.enum(['powershell', 'bash', 'python', 'cmd', 'zsh']).optional(),
    osType: z.enum(['windows', 'macos', 'linux']).optional(),
    includeTemplates: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_script_details: z.object({
    scriptId: uuid,
    includeContent: z.boolean().optional(),
    includeVersionHistory: z.boolean().optional(),
    includeExecutionStats: z.boolean().optional(),
  }),
  // Script-library read tools used by the script-builder assistant. These were
  // wired through TOOL_TIERS + TOOL_PERMISSIONS (#1457) but lacked an input
  // schema here, so validateToolInput rejected every call ("No input schema
  // defined") — the tool surfaced past the guardrail yet still never executed.
  // Shapes mirror the script-builder tool registrations in scriptBuilderTools.ts.
  list_scripts: z.object({
    search: z.string().max(200).optional(),
    category: z.string().optional(),
    language: z.enum(['powershell', 'bash', 'python', 'cmd']).optional(),
    osType: z.enum(['windows', 'macos', 'linux']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  list_script_templates: z.object({
    search: z.string().max(200).optional(),
    category: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  get_script_execution_history: z.object({
    scriptId: uuid,
    limit: z.number().int().min(1).max(50).optional(),
  }),
  get_script_execution: z.object({
    executionId: uuid,
  }),

  // Monitoring tools
  query_monitors: z.object({
    status: z.enum(['online', 'offline', 'degraded', 'unknown']).optional(),
    monitorType: z.string().max(50).optional(),
    isActive: z.boolean().optional(),
    search: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  manage_monitors: z.object({
    action: z.enum(['get', 'create', 'update', 'delete']),
    monitorId: uuid.optional(),
    name: z.string().max(255).optional(),
    monitorType: z.enum(['icmp_ping', 'tcp_port', 'http_check', 'dns_check']).optional(),
    target: z.string().max(500).optional(),
    pollingInterval: z.number().int().min(10).max(86400).optional(),
    timeout: z.number().int().min(1).max(120).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    isActive: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).refine(
    (d) => {
      const needsId = ['get', 'update', 'delete'];
      return !needsId.includes(d.action) || !!d.monitorId;
    },
    { message: 'monitorId is required for get/update/delete actions' },
  ).refine(
    (d) => d.action !== 'create' || (!!d.name && !!d.monitorType && !!d.target),
    { message: 'name, monitorType, and target are required for create' },
  ),

  get_service_monitoring_status: z.object({
    action: z.enum(['status', 'summary', 'results', 'known_services']),
    deviceId: uuid.optional(),
    watchType: z.enum(['service', 'process']).optional(),
    name: z.string().max(255).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    search: z.string().max(255).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }).refine(
    (d) => !['status', 'summary'].includes(d.action) || !!d.deviceId,
    { message: 'deviceId is required for status/summary actions' },
  ),

  // Registration-debt payoff: schemas for tools that were registered in
  // aiTools but had no Zod input schema (legacySchemaGaps in
  // aiToolsRegistryParity.test.ts). See that file's history for context.
  query_analytics: z.object({
    action: z.enum(['sla_compliance', 'capacity_predictions', 'sla_definitions']),
    slaId: uuid.optional(),
    deviceId: uuid.optional(),
    metricType: z.string().max(50).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_executive_summary: z.object({
    periodType: z.string().max(20).optional(),
  }),

  query_psa_status: z.object({
    connectionId: uuid.optional(),
  }),

  search_documentation: z.object({
    query: z.string().min(1).max(500),
    section: z.enum(['getting-started', 'deploy', 'agents', 'security', 'features', 'monitoring', 'reference']).optional(),
  }),

  query_webhooks: z.object({
    status: z.enum(['active', 'disabled', 'error']).optional(),
    includeDeliveries: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),

  test_webhook: z.object({
    webhookId: uuid,
  }),

  manage_notification_channels: z.object({
    action: z.enum(['list', 'test', 'create', 'update', 'delete']),
    channelId: uuid.optional(),
    name: z.string().min(1).max(255).optional(),
    type: z.enum(['email', 'slack', 'teams', 'webhook', 'pagerduty', 'sms']).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }).refine(
    (d) => !['test', 'update', 'delete'].includes(d.action) || !!d.channelId,
    { message: 'channelId is required for test/update/delete actions' },
  ).refine(
    (d) => d.action !== 'create' || (!!d.name && !!d.type && !!d.config),
    { message: 'name, type, and config are required for create' },
  ),

  manage_saved_filters: z.object({
    action: z.enum(['list', 'get', 'create', 'delete']),
    filterId: uuid.optional(),
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).optional(),
    conditions: z.record(z.string(), z.unknown()).optional(),
  }).refine(
    (d) => !['get', 'delete'].includes(d.action) || !!d.filterId,
    { message: 'filterId is required for get/delete actions' },
  ).refine(
    (d) => d.action !== 'create' || (!!d.name && !!d.conditions),
    { message: 'name and conditions are required for create' },
  ),

  query_custom_fields: z.object({
    action: z.enum(['list_definitions', 'get_device_values']),
    deviceId: uuid.optional(),
  }).refine(
    (d) => d.action !== 'get_device_values' || !!d.deviceId,
    { message: 'deviceId is required for get_device_values' },
  ),

  create_incident: z.object({
    title: z.string().min(1).max(500),
    classification: z.enum([
      'malware', 'ransomware', 'phishing', 'data_breach',
      'unauthorized_access', 'denial_of_service', 'insider_threat', 'other',
    ]),
    severity: z.enum(['p1', 'p2', 'p3', 'p4']),
    summary: z.string().max(5000).optional(),
    relatedAlertIds: z.array(uuid).max(200).optional(),
    affectedDeviceIds: z.array(uuid).max(200).optional(),
  }),

  execute_containment: z.object({
    incidentId: uuid,
    deviceId: uuid,
    actionType: z.enum(['process_kill', 'network_isolation', 'account_disable', 'usb_block']),
    parameters: z.record(z.string(), z.unknown()).optional(),
    approvalRef: z.string().max(128).optional(),
  }),

  collect_evidence: z.object({
    incidentId: uuid,
    deviceId: uuid,
    evidenceTypes: z.array(z.enum(['logs', 'processes', 'connections', 'screenshot'])).min(1),
  }),

  get_incident_timeline: z.object({
    incidentId: uuid,
  }),

  generate_incident_report: z.object({
    incidentId: uuid,
  }),

  manage_update_rings: z.object({
    action: z.enum(['list', 'get', 'create', 'update']),
    ringId: uuid.optional(),
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).optional(),
    // Bounds mirror the HTTP route (routes/updateRings.ts) and the underlying
    // columns (#2814 review).
    deferralDays: z.number().int().min(0).max(365).optional(),
    deadlineDays: z.number().int().min(0).max(365).optional(),
    gracePeriodHours: z.number().int().min(0).max(168).optional(),
    categories: z.array(z.string().max(100)).max(50).optional(),
    excludeCategories: z.array(z.string().max(100)).max(50).optional(),
    autoApprove: ringAutoApproveSchema.optional(),
    enabled: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  manage_backup_configs: z.object({
    action: z.enum(['list', 'get', 'create', 'update']),
    configId: uuid.optional(),
    name: z.string().min(1).max(200).optional(),
    type: z.enum(['file', 'system_image', 'database', 'application']).optional(),
    provider: z.enum(['s3', 'azure_blob', 'google_cloud', 'backblaze', 'local']).optional(),
    providerConfig: z.record(z.string(), z.unknown()).optional(),
    schedule: z.record(z.string(), z.unknown()).optional(),
    retention: z.record(z.string(), z.unknown()).optional(),
    compression: z.boolean().optional(),
    encryption: z.boolean().optional(),
    isActive: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  manage_scheduled_tasks: z.object({
    deviceId: uuid,
    action: z.enum(['list', 'run', 'disable', 'enable']),
    taskName: z.string().min(1).max(1024).optional(),
    search: z.string().max(200).optional(),
  }).refine(
    (d) => !['run', 'disable', 'enable'].includes(d.action) || !!d.taskName,
    { message: 'taskName (full task path) is required for run/disable/enable' },
  ),

  registry_operations: z.object({
    action: z.enum(['read_key', 'get_value', 'set_value', 'create_key', 'delete_key']),
    deviceId: uuid,
    keyPath: z.string().min(1).max(2048),
    valueName: z.string().max(255).optional(),
    valueData: z.string().max(8192).optional(),
    valueType: z.enum(['REG_SZ', 'REG_DWORD', 'REG_QWORD', 'REG_BINARY', 'REG_EXPAND_SZ', 'REG_MULTI_SZ']).optional(),
  }).refine(
    (d) => d.action !== 'get_value' || !!d.valueName,
    { message: 'valueName is required for get_value' },
  ).refine(
    (d) => d.action !== 'set_value' || (!!d.valueName && d.valueData !== undefined),
    { message: 'valueName and valueData are required for set_value' },
  ),

  query_agent_versions: z.object({
    action: z.enum(['list_versions', 'check_upgrades']),
    platform: z.enum(['windows', 'macos', 'linux']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),

  trigger_agent_upgrade: z.object({
    deviceIds: z.array(uuid).min(1).max(50),
    targetVersion: z.string().max(100).optional(),
  }),

  trigger_agent_restart: z.object({
    deviceIds: z.array(uuid).min(1).max(50),
  }),

  list_remote_sessions: z.object({
    status: z.enum(['pending', 'connecting', 'active', 'disconnected', 'failed']).optional(),
    type: z.enum(['terminal', 'desktop', 'file_transfer']).optional(),
    deviceId: uuid.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  create_remote_session: z.object({
    deviceId: uuid,
    type: z.enum(['terminal', 'file_transfer']),
  }),

  manage_tags: z.object({
    action: z.enum(['list', 'add', 'remove']),
    deviceId: uuid.optional(),
    tags: z.array(z.string().min(1).max(100)).max(50).optional(),
    search: z.string().max(200).optional(),
  }).refine(
    (d) => d.action === 'list' || !!d.deviceId,
    { message: 'deviceId is required for add/remove' },
  ).refine(
    (d) => d.action === 'list' || (Array.isArray(d.tags) && d.tags.length > 0),
    { message: 'tags array is required for add/remove' },
  ),

  get_browser_security: z.object({
    orgId: uuid.optional(),
    deviceId: uuid.optional(),
    browser: z.enum(['chrome', 'edge', 'firefox', 'safari', 'brave', 'other']).optional(),
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    includeViolations: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),

  manage_browser_policy: z.object({
    action: z.enum(['list', 'create', 'update', 'apply']),
    policyId: uuid.optional(),
    orgId: uuid.optional(),
    name: z.string().min(1).max(255).optional(),
    targetType: z.enum(['org', 'site', 'group', 'device', 'tag']).optional(),
    targetIds: z.array(z.string().min(1).max(255)).max(500).optional(),   // plain strings: 'tag' targets tag NAMES
    allowedExtensions: z.array(z.string().min(1).max(255)).max(1000).optional(),
    blockedExtensions: z.array(z.string().min(1).max(255)).max(1000).optional(),
    requiredExtensions: z.array(z.string().min(1).max(255)).max(1000).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    isActive: z.boolean().optional(),
    deviceIds: z.array(uuid).max(1000).optional(),
  }),

  query_compliance_policies: z.object({
    enabled: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  get_compliance_status: z.object({
    policyId: uuid,
    status: z.enum(['compliant', 'non_compliant', 'pending', 'error']).optional(),
    deviceId: uuid.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),

  manage_software_policies: z.object({
    action: z.enum(['list', 'get', 'create', 'update']),
    policyId: uuid.optional(),
    ownerScope: z.enum(['organization', 'partner']).optional(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    mode: z.enum(['allowlist', 'blocklist', 'audit']).optional(),
    rules: z.object({
      software: z.array(z.object({
        name: z.string().min(1).max(500),
        vendor: z.string().max(200).optional(),
        minVersion: z.string().max(100).optional(),
        maxVersion: z.string().max(100).optional(),
        catalogId: uuid.optional(),
        reason: z.string().max(1000).optional(),
      })).max(1000).optional(),
      allowUnknown: z.boolean().optional(),
    }).optional(),
    enforceMode: z.boolean().optional(),
    remediationOptions: z.object({
      autoUninstall: z.boolean().optional(),
      notifyUser: z.boolean().optional(),
      gracePeriod: z.number().int().min(0).max(2160).optional(),
      cooldownMinutes: z.number().int().min(1).max(129600).optional(),
      maintenanceWindowOnly: z.boolean().optional(),
    }).optional(),
    isActive: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).refine(
    (data) => !['get', 'update'].includes(data.action) || !!data.policyId,
    { message: 'policyId is required for get/update actions' }
  ).refine(
    (data) => data.action !== 'create' || (!!data.name && !!data.mode),
    { message: 'name and mode are required for create action' }
  ),

  manage_peripheral_policies: z.object({
    action: z.enum(['list', 'get', 'create', 'update']),
    policyId: uuid.optional(),
    name: z.string().min(1).max(200).optional(),
    deviceClass: z.enum(peripheralDeviceClassEnum.enumValues).optional(),
    action_type: z.enum(peripheralPolicyActionEnum.enumValues).optional(),
    exceptions: z.array(z.object({
      vendor: z.string().max(255).optional(),
      product: z.string().max(255).optional(),
      serialNumber: z.string().max(255).optional(),
      allow: z.boolean().optional(),
      reason: z.string().max(2000).optional(),
      expiresAt: z.string().datetime({ offset: true }).optional(),
    })).max(500).optional(),
    isActive: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).refine(
    (data) => !['get', 'update'].includes(data.action) || !!data.policyId,
    { message: 'policyId is required for get/update actions' }
  ).refine(
    (data) => data.action !== 'create' || (!!data.name && !!data.deviceClass && !!data.action_type),
    { message: 'name, deviceClass, and action_type are required for create action' }
  ),

  // Fleet orchestration tools
  ...fleetToolInputSchemas,

  // Microsoft 365 typed Graph read-query tools (extracted to aiToolSchemasM365.ts)
  ...m365ToolSchemas,
};

/**
 * Validate tool input against the registered schema.
 * Returns { success: true } if valid, or { success: false, error } with details.
 */
export function validateToolInput(
  toolName: string,
  input: Record<string, unknown>
): { success: true } | { success: false; error: string } {
  const schema = toolInputSchemas[toolName];
  if (!schema) {
    console.warn(`[AI] No input schema defined for tool "${toolName}" — rejecting input`);
    return { success: false, error: `No input schema registered for tool "${toolName}"` };
  }

  const result = schema.safeParse(input);
  if (result.success) {
    return { success: true };
  }

  // Object-level refinements (e.g. "install requires patchIds and deviceIds")
  // carry an empty `path`, so prefixing every message with `${path}: ` yields a
  // dangling `: message` and, once joined onto the banner, a doubled colon
  // ("Invalid input: : ..."). Only prefix the path when there is one.
  const issues = result.error.issues
    .map(i => {
      const path = i.path.join('.');
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join('; ');
  return { success: false, error: `Invalid input: ${issues}` };
}
