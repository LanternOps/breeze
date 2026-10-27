/**
 * Device inventory reads and per-device records (full-control W13, #6783, PR A):
 *
 *  - `get_device_events` (t1): the AI twin of GET /devices/:id/events — the
 *    device's audit timeline from the shared `queryDeviceEventFeed`, projected
 *    narrower than REST (W13-D4): no actor email (not even as the name
 *    fallback), no IP address, no `details`.
 *  - `get_device_health` (t1): GET /devices/:id/health — the agent's latest
 *    per-component health observation. A separate tool (W13-D2).
 *  - `get_process_samples` (t1): GET /devices/:id/process-samples — the
 *    top-process snapshot at or before `at` (default now). Range markers are
 *    not built.
 *  - `get_management_posture` (t1): GET /devices/management-posture/summary,
 *    or the per-product drill-down when `product` is given. The site and
 *    exact-device axes go into the SQL scope BEFORE aggregation (W13-D12).
 *  - `manage_device_function` (get t1 / set supervised, set agent-human-only):
 *    GET/PUT /devices/:id/function through `services/deviceFunction.ts`, the
 *    only writer. Function is an allowed execution-targeting filter (W13 plan
 *    fact 1), hence supervised.
 *  - `manage_device_warranty` (get / expiring t1, refresh supervised): the
 *    refresh calls the manufacturer's warranty API with the serial (fact 9).
 *
 * Device scope is the central `deviceArgs` gate (org + site + exact device +
 * not parked) plus `verifyDeviceAccess` here. Every write's REST twin carries
 * `requireMfa()` (W13-D6). Users-FK columns get a verified user or NULL (W13-D5).
 */
import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  agentHealthObservations,
  deviceAgentHealthLatest,
  deviceHardware,
  deviceProcessSamples,
  devices,
  deviceWarranty,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { verifyDeviceAccess } from './aiTools';
import { mfaGatedToolError } from './aiToolMfaGate';
import { deviceScopeCondition, siteScopeCondition } from './aiToolsSiteScope';
import { DeviceFunctionError, clearDeviceFunction, getDeviceFunction, upsertDeviceFunction } from './deviceFunction';
import { queryDeviceEventFeed, type DeviceEventFeedFilters, type DeviceEventRow } from './deviceEventFeed';
import { getManagementPostureSummary, getPostureDevices } from './managementPostureReport';
import { notParkedDeviceCondition } from './unassignedPool/selectorPredicate';
import { isAgentCollectedWarrantyDevice } from './warrantyDataSources';
import { queueWarrantySyncForDevice } from './warrantyWorker';
import { setDeviceFunctionSchema } from '@breeze/shared';
import {
  DEVICE_EVENT_CATEGORIES,
  DEVICE_EVENT_INITIATORS,
  DEVICE_FUNCTION_ACTIONS,
  DEVICE_WARRANTY_ACTIONS,
} from './aiToolSchemasDeviceOps';
import { MANAGEMENT_POSTURE_CATEGORIES } from './managementPostureReport';
import { AUDIT_RESULTS } from '@breeze/shared';
import {
  auditToolWrite, bounded, clampLimit, json, jsonError, notFound, thrown, verifiedUserIdOrNull,
} from './aiToolsSoftwareShared';

type DeviceRow = typeof devices.$inferSelect;

async function deviceOr404(input: Record<string, unknown>, auth: AuthContext): Promise<DeviceRow | string> {
  if (typeof input.deviceId !== 'string') return jsonError('deviceId is required', 'VALIDATION_ERROR');
  const access = await verifyDeviceAccess(input.deviceId, auth);
  return 'error' in access ? notFound('Device') : access.device;
}

/** W13-D4 / quorum QW7: the actor's display name, never their email (REST falls back to it). */
const ACTOR_TYPE_LABELS: Readonly<Record<string, string>> = {
  user: 'User', agent: 'Agent', ai_agent: 'AI Agent', api_key: 'API Key', system: 'System',
};
export function projectDeviceEvent(row: DeviceEventRow) {
  const nameIsEmail = row.actor.email != null && row.actor.name === row.actor.email;
  return {
    id: row.id,
    timestamp: row.timestamp,
    action: row.action,
    message: row.message,
    category: row.category,
    result: row.result,
    actor: { type: row.actor.type, name: nameIsEmail ? (ACTOR_TYPE_LABELS[row.actor.type] ?? 'Unknown') : row.actor.name },
    resource: row.resource,
    initiatedBy: row.initiatedBy,
    errorMessage: row.errorMessage,
  };
}

function isoOrUndefined(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Org + site + exact-device + not-parked scope over `devices`, applied inside the aggregate (W13-D12). */
export function postureScope(auth: AuthContext, orgId: string | undefined): SQL | 'forbidden' {
  const conditions: SQL[] = [notParkedDeviceCondition()];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) conditions.push(orgCond);
  if (orgId) {
    if (!auth.canAccessOrg(orgId)) return 'forbidden';
    conditions.push(eq(devices.orgId, orgId));
  }
  const siteCond = siteScopeCondition(auth, devices.siteId);
  if (siteCond) conditions.push(siteCond);
  const deviceCond = deviceScopeCondition(auth, devices.id);
  if (deviceCond) conditions.push(deviceCond);
  return and(...conditions)!;
}

export function registerDeviceInventoryTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('get_device_events', {
    tier: 1,
    domain: 'devices',
    searchHint: 'device activity timeline: commands, scripts, patches, alerts and changes recorded for one device',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'get_device_events',
      description: 'Activity timeline for one device (audit events: what ran, changed or failed, who or what did it), newest first. Filter by category, result, initiator, time or text.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Device UUID' },
          search: { type: 'string', description: 'Text in the action or resource name' },
          category: { type: 'string', enum: [...DEVICE_EVENT_CATEGORIES], description: 'Event category' },
          result: { type: 'string', enum: [...AUDIT_RESULTS], description: 'Outcome' },
          initiatedBy: { type: 'string', enum: [...DEVICE_EVENT_INITIATORS], description: 'What started it' },
          from: { type: 'string', description: 'ISO datetime lower bound' },
          to: { type: 'string', description: 'ISO datetime upper bound' },
          page: { type: 'number', description: 'Page (default 1)' },
          limit: { type: 'number', description: 'Max events per page (default 25, max 100)' },
        },
        required: ['deviceId'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      try {
        const device = await deviceOr404(input, auth);
        if (typeof device === 'string') return device;
        const feed = await queryDeviceEventFeed(
          { id: device.id, orgId: device.orgId },
          {
            search: typeof input.search === 'string' ? input.search : undefined,
            category: typeof input.category === 'string' ? input.category : undefined,
            result: typeof input.result === 'string' ? input.result as DeviceEventFeedFilters['result'] : undefined,
            initiatedBy: typeof input.initiatedBy === 'string' ? input.initiatedBy as DeviceEventFeedFilters['initiatedBy'] : undefined,
            from: isoOrUndefined(input.from),
            to: isoOrUndefined(input.to),
            page: clampLimit(input.page, 1, 10000),
            limit: clampLimit(input.limit, 25, 100),
            includeAutomated: false,
            withTotal: false,
          },
        );
        return bounded({
          device: { id: device.id, hostname: device.hostname },
          events: feed.data.map(projectDeviceEvent),
          page: feed.pagination.page,
          limit: feed.pagination.limit,
        });
      } catch (error) {
        return thrown('get_device_events', error);
      }
    },
  });

  aiTools.set('get_device_health', {
    tier: 1,
    domain: 'devices',
    searchHint: 'Breeze agent health on one device: overall state and each component (heartbeat, services, metrics)',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'get_device_health',
      description: "The Breeze agent's latest self-reported health on one device: overall state and per-component state with reasons.",
      input_schema: {
        type: 'object' as const,
        properties: { deviceId: { type: 'string', description: 'Device UUID' } },
        required: ['deviceId'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      try {
        const device = await deviceOr404(input, auth);
        if (typeof device === 'string') return device;
        const [row] = await db
          .select({
            schemaVersion: agentHealthObservations.schemaVersion,
            agentVersion: agentHealthObservations.agentVersion,
            overall: agentHealthObservations.overall,
            metricsAvailable: agentHealthObservations.metricsAvailable,
            components: agentHealthObservations.components,
            observedAt: agentHealthObservations.observedAt,
            receivedAt: deviceAgentHealthLatest.receivedAt,
          })
          .from(deviceAgentHealthLatest)
          .innerJoin(
            agentHealthObservations,
            and(
              eq(agentHealthObservations.id, deviceAgentHealthLatest.observationId),
              eq(agentHealthObservations.deviceId, deviceAgentHealthLatest.deviceId),
              eq(agentHealthObservations.orgId, deviceAgentHealthLatest.orgId),
            ),
          )
          .where(and(eq(deviceAgentHealthLatest.deviceId, device.id), eq(deviceAgentHealthLatest.orgId, device.orgId)))
          .limit(1);
        // Same rule as the route: anything but a v1 observation is "unknown".
        if (!row || row.schemaVersion !== 1) {
          return json({ device: { id: device.id, hostname: device.hostname }, status: 'unknown', observation: null });
        }
        return bounded({
          device: { id: device.id, hostname: device.hostname },
          status: 'known',
          observation: {
            agentVersion: row.agentVersion,
            overall: row.overall,
            metricsAvailable: row.metricsAvailable,
            components: row.components,
            observedAt: row.observedAt.toISOString(),
          },
          receivedAt: row.receivedAt.toISOString(),
        });
      } catch (error) {
        return thrown('get_device_health', error);
      }
    },
  });

  aiTools.set('get_process_samples', {
    tier: 1,
    domain: 'devices',
    searchHint: 'historical top-process snapshot on one device (what was using CPU or memory at a past time)',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'get_process_samples',
      description: 'The recorded top-process snapshot on one device at or before a time (default now): process names, CPU and memory. History, not a live list.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Device UUID' },
          at: { type: 'string', description: 'ISO datetime; the nearest sample at or before it (default now)' },
        },
        required: ['deviceId'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      try {
        const device = await deviceOr404(input, auth);
        if (typeof device === 'string') return device;
        const at = isoOrUndefined(input.at) ?? new Date();
        const [sample] = await db
          .select({
            timestamp: deviceProcessSamples.timestamp,
            agentTimestamp: deviceProcessSamples.agentTimestamp,
            topProcesses: deviceProcessSamples.topProcesses,
          })
          .from(deviceProcessSamples)
          .where(and(eq(deviceProcessSamples.deviceId, device.id), lte(deviceProcessSamples.timestamp, at)))
          .orderBy(desc(deviceProcessSamples.timestamp))
          .limit(1);
        if (!sample) {
          // Route parity (#1722): "never recorded" vs "none at or before this time".
          const [any] = await db
            .select({ timestamp: deviceProcessSamples.timestamp })
            .from(deviceProcessSamples)
            .where(eq(deviceProcessSamples.deviceId, device.id))
            .limit(1);
          return json({ device: { id: device.id, hostname: device.hostname }, sample: null, hasAnySample: Boolean(any) });
        }
        return bounded({
          device: { id: device.id, hostname: device.hostname },
          sample: {
            timestamp: sample.timestamp.toISOString(),
            agentTimestamp: sample.agentTimestamp ? sample.agentTimestamp.toISOString() : null,
            topProcesses: sample.topProcesses,
          },
          hasAnySample: true,
        });
      } catch (error) {
        return thrown('get_process_samples', error);
      }
    },
  });

  aiTools.set('get_management_posture', {
    tier: 1,
    domain: 'devices',
    searchHint: 'other management products detected on devices (RMM, antivirus, backup, MDM agents) and coverage gaps',
    definition: {
      name: 'get_management_posture',
      description: 'Which management products (other RMMs, endpoint security, backup, MDM, …) are detected across the fleet, per org; pass product for the devices running it.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Limit to one organization' },
          category: { type: 'string', enum: [...MANAGEMENT_POSTURE_CATEGORIES], description: 'Product category (default rmm)' },
          stalenessDays: { type: 'number', description: 'Scans older than this count as stale (default 7)' },
          product: { type: 'string', description: 'Product name from the summary: list its devices' },
          status: { type: 'string', enum: ['active', 'installed', 'unknown'], description: 'With product: detection status' },
          page: { type: 'number', description: 'With product: page (default 1)' },
          limit: { type: 'number', description: 'Max devices per page, with product (default 50, max 200)' },
        },
        required: [],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      try {
        const orgId = typeof input.orgId === 'string' ? input.orgId : undefined;
        const scope = postureScope(auth, orgId);
        if (scope === 'forbidden') return notFound('Organization');
        const category = (typeof input.category === 'string' ? input.category : 'rmm') as (typeof MANAGEMENT_POSTURE_CATEGORIES)[number];
        const stalenessDays = clampLimit(input.stalenessDays, 7, 365);
        if (typeof input.product === 'string' && input.product !== '') {
          const pageNo = clampLimit(input.page, 1, 10000);
          const limit = clampLimit(input.limit, 50, 200);
          const result = await getPostureDevices({
            category,
            stalenessDays,
            scope,
            product: input.product,
            detectionStatus: typeof input.status === 'string' ? input.status : undefined,
            limit,
            offset: (pageNo - 1) * limit,
          });
          return bounded({ category, product: input.product, ...result, page: pageNo, limit });
        }
        return bounded(await getManagementPostureSummary({ category, stalenessDays, scope }));
      } catch (error) {
        return thrown('get_management_posture', error);
      }
    },
  });

  aiTools.set('manage_device_function', {
    tier: 1,
    domain: 'devices',
    searchHint: "a device's function (domain controller, file server, workstation, …): read or set it",
    deviceArgs: ['deviceId'],
    definition: {
      name: 'manage_device_function',
      description: "Actions: get or set one device's function (functionKey; null clears; custom:<slug> needs label). Set changes dynamic-group targeting and needs approval.",
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...DEVICE_FUNCTION_ACTIONS], description: 'The action to perform' },
          deviceId: { type: 'string', description: 'Device UUID' },
          functionKey: { type: ['string', 'null'], description: 'set: a function key, custom:<slug>, or null to clear' },
          label: { type: 'string', description: 'set: display label (required for custom keys)' },
        },
        required: ['action', 'deviceId'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as (typeof DEVICE_FUNCTION_ACTIONS)[number];
      if (!DEVICE_FUNCTION_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      try {
        if (action === 'set') {
          const mfa = mfaGatedToolError('manage_device_function', action, auth);
          if (mfa) return mfa;
        }
        const device = await deviceOr404(input, auth);
        if (typeof device === 'string') return device;
        if (action === 'get') return bounded(await getDeviceFunction(device.id, device.orgId));

        // The route's own body schema (packages/shared deviceFunctions.ts).
        const parsed = setDeviceFunctionSchema.safeParse({
          functionKey: input.functionKey === undefined ? undefined : input.functionKey,
          ...(input.label !== undefined ? { label: input.label } : {}),
        });
        if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input', 'VALIDATION_ERROR');
        const body = parsed.data;
        const userId = await verifiedUserIdOrNull(auth);
        let outcome: string;
        try {
          if (body.functionKey === null) {
            outcome = (await clearDeviceFunction({ deviceId: device.id, orgId: device.orgId, userId })).outcome;
          } else {
            outcome = (await upsertDeviceFunction({
              deviceId: device.id, orgId: device.orgId, functionKey: body.functionKey, label: body.label, source: 'manual', userId,
            })).outcome;
          }
        } catch (err) {
          if (err instanceof DeviceFunctionError) {
            return err.code === 'device_not_found' ? notFound('Device') : jsonError(err.code, 'VALIDATION_ERROR');
          }
          throw err;
        }
        auditToolWrite(auth, {
          orgId: device.orgId,
          action: 'device.function.set',
          resourceType: 'device',
          resourceId: device.id,
          resourceName: device.hostname ?? device.displayName ?? undefined,
          details: { functionKey: body.functionKey, outcome },
        });
        return bounded({ outcome, function: await getDeviceFunction(device.id, device.orgId) });
      } catch (error) {
        return thrown('manage_device_function', error);
      }
    },
  });

  aiTools.set('manage_device_warranty', {
    tier: 1,
    domain: 'devices',
    searchHint: 'warranty status, coverage dates and expiring warranties; refresh a device warranty from the vendor',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'manage_device_warranty',
      description: "Actions: get (one device's warranty), expiring (devices whose warranty ends within days, default 90), refresh (re-check one device with the manufacturer; needs approval).",
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...DEVICE_WARRANTY_ACTIONS], description: 'The action to perform' },
          deviceId: { type: 'string', description: 'get / refresh: device UUID' },
          days: { type: 'number', description: 'expiring: window in days (default 90, max 365)' },
          limit: { type: 'number', description: 'Max devices, expiring only (default 50, max 200)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as (typeof DEVICE_WARRANTY_ACTIONS)[number];
      if (!DEVICE_WARRANTY_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      try {
        if (action === 'expiring') return await expiringWarranties(input, auth);
        if (action === 'refresh') {
          const mfa = mfaGatedToolError('manage_device_warranty', action, auth);
          if (mfa) return mfa;
        }
        const device = await deviceOr404(input, auth);
        if (typeof device === 'string') return device;
        if (action === 'get') {
          const [warranty] = await db
            .select({
              manufacturer: deviceWarranty.manufacturer,
              serialNumber: deviceWarranty.serialNumber,
              status: deviceWarranty.status,
              warrantyStartDate: deviceWarranty.warrantyStartDate,
              warrantyEndDate: deviceWarranty.warrantyEndDate,
              isSubscription: deviceWarranty.isSubscription,
              entitlements: deviceWarranty.entitlements,
              dataSource: deviceWarranty.dataSource,
              lastSyncAt: deviceWarranty.lastSyncAt,
              lastSyncError: deviceWarranty.lastSyncError,
            })
            .from(deviceWarranty)
            .where(eq(deviceWarranty.deviceId, device.id))
            .limit(1);
          return bounded({ device: { id: device.id, hostname: device.hostname }, warranty: warranty ?? null });
        }

        // refresh — the route's #5511 W01 (D11) refusal: never queue a sync that cannot produce anything.
        const [hw] = await db
          .select({ manufacturer: deviceHardware.manufacturer })
          .from(deviceHardware)
          .where(eq(deviceHardware.deviceId, device.id))
          .limit(1);
        const [existing] = await db
          .select({ dataSource: deviceWarranty.dataSource })
          .from(deviceWarranty)
          .where(eq(deviceWarranty.deviceId, device.id))
          .limit(1);
        if (isAgentCollectedWarrantyDevice({ manufacturer: hw?.manufacturer ?? null, dataSource: existing?.dataSource ?? null })) {
          return jsonError(
            "This device's warranty is collected by the Breeze agent, not by a vendor lookup. A server-side refresh cannot produce newer data.",
            'WARRANTY_REFRESH_NOT_AVAILABLE',
          );
        }
        await queueWarrantySyncForDevice(device.id, { force: true });
        auditToolWrite(auth, {
          orgId: device.orgId,
          action: 'device.warranty.refresh',
          resourceType: 'device',
          resourceId: device.id,
          resourceName: device.hostname,
          details: { manufacturer: hw?.manufacturer ?? null },
        });
        return json({ queued: true, deviceId: device.id, message: 'Warranty refresh queued' });
      } catch (error) {
        return thrown('manage_device_warranty', error);
      }
    },
  });
}

/** GET /devices/warranty/expiring, plus the exact-device axis and the parked-device rule (W13-D12). */
async function expiringWarranties(input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  const days = clampLimit(input.days, 90, 365);
  const limit = clampLimit(input.limit, 50, 200);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);
  const conditions: SQL[] = [
    gte(deviceWarranty.warrantyEndDate, sql`CURRENT_DATE`),
    sql`${deviceWarranty.warrantyEndDate} <= ${cutoff.toISOString().split('T')[0]}`,
    notParkedDeviceCondition(),
  ];
  const orgCond = auth.orgCondition(deviceWarranty.orgId);
  if (orgCond) conditions.push(orgCond);
  const siteCond = siteScopeCondition(auth, devices.siteId);
  if (siteCond) conditions.push(siteCond);
  const deviceCond = deviceScopeCondition(auth, devices.id);
  if (deviceCond) conditions.push(deviceCond);
  const rows = await db
    .select({
      deviceId: devices.id,
      hostname: devices.hostname,
      displayName: devices.displayName,
      manufacturer: deviceWarranty.manufacturer,
      status: deviceWarranty.status,
      warrantyEndDate: deviceWarranty.warrantyEndDate,
      isSubscription: deviceWarranty.isSubscription,
    })
    .from(deviceWarranty)
    .innerJoin(devices, eq(deviceWarranty.deviceId, devices.id))
    .where(and(...conditions))
    .orderBy(asc(deviceWarranty.warrantyEndDate))
    .limit(limit);
  return bounded({ days, devices: rows, count: rows.length });
}
