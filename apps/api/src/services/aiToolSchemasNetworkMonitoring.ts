/**
 * Input schemas for the W09 SNMP / network-monitoring tools (full-control W09,
 * #6779): `manage_snmp_templates`, `get_snmp_metrics`, `probe_network_asset`,
 * `manage_known_guests`, `get_unifi_status`, `trigger_unifi_sync`.
 *
 * Plain strict `z.object`s with an `action` enum where the tool multiplexes (no
 * unions or refinements) so `toolActionEnum` can read `.shape.action.options`
 * and the chat SDK `tool()` declarations can take `.shape` directly. Per-action
 * required fields are validated in the handlers. No `z.undefined()` anywhere:
 * it empties the model's tool list.
 *
 * Keys and enums mirror each tool's registry `input_schema` one-for-one;
 * aiToolSchemas.networkMonitoring.test.ts pins that.
 */
import { z } from 'zod';

export const SNMP_TEMPLATE_ACTIONS = [
  'list', 'get', 'browse_oids', 'validate_oids', 'create', 'update', 'delete',
] as const;
export const SNMP_METRICS_ACTIONS = ['history', 'dashboard'] as const;
export const KNOWN_GUEST_ACTIONS = ['list', 'add', 'delete'] as const;
export const UNIFI_STATUS_ACTIONS = [
  'status', 'hosts', 'collectors', 'mappings', 'telemetry', 'sync_runs', 'controller_sites',
] as const;

export const SNMP_BUCKETS = ['auto', '1m', '5m', '1h', '1d'] as const;
export const SNMP_OID_MODES = ['get', 'walk'] as const;
export const SNMP_OID_CADENCES = ['fast', 'slow'] as const;

const uuid = z.string().guid();

/** One OID row. The REST route's schema is the authority (handlers re-parse with it); this is the model-facing shape. */
const snmpOidItem = z.object({
  id: z.string().max(100).optional(),
  oid: z.string().min(1).max(200),
  name: z.string().max(200).optional(),
  label: z.string().max(200).optional(),
  unit: z.string().max(50).optional(),
  type: z.string().max(50).optional(),
  mode: z.enum(SNMP_OID_MODES).optional(),
  cadence: z.enum(SNMP_OID_CADENCES).optional(),
  description: z.string().max(500).optional(),
}).strict();

export const networkMonitoringToolShapes = {
  manage_snmp_templates: {
    action: z.enum(SNMP_TEMPLATE_ACTIONS),
    orgId: uuid.optional(),
    templateId: uuid.optional(),
    source: z.enum(['builtin', 'custom']).optional(),
    search: z.string().trim().max(200).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    vendor: z.string().max(100).optional(),
    deviceType: z.string().max(100).optional(),
    oids: z.array(snmpOidItem).min(1).max(500).optional(),
    query: z.string().trim().max(200).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  get_snmp_metrics: {
    action: z.enum(SNMP_METRICS_ACTIONS),
    orgId: uuid.optional(),
    assetId: uuid.optional(),
    oid: z.string().trim().min(1).max(2000).optional(),
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    bucket: z.enum(SNMP_BUCKETS).optional(),
    delta: z.boolean().optional(),
  },
  probe_network_asset: {
    assetId: uuid,
  },
  manage_known_guests: {
    action: z.enum(KNOWN_GUEST_ACTIONS),
    guestId: uuid.optional(),
    macAddress: z.string().max(17).optional(),
    label: z.string().trim().min(1).max(255).optional(),
    notes: z.string().max(2000).optional(),
  },
  get_unifi_status: {
    action: z.enum(UNIFI_STATUS_ACTIONS),
    partnerId: uuid.optional(),
    siteId: uuid.optional(),
  },
  trigger_unifi_sync: {
    partnerId: uuid.optional(),
  },
} as const;

export const networkMonitoringToolSchemas: Record<string, z.ZodType> = Object.fromEntries(
  Object.entries(networkMonitoringToolShapes).map(([name, shape]) => [name, z.object(shape).strict()]),
);
