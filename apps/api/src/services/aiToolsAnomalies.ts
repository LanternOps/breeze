/**
 * `manage_device_anomalies` (full-control W07, #6777): the AI twin of the
 * per-device metric-anomaly routes in routes/devices/anomalies.ts.
 *
 * Actions and classes (aiGuardrails.ts, plan W07):
 *  - `list` — tier 1 read (anomaly rows: metric names, scores, baselines).
 *  - `dismiss`, `resolve` — tier 2: a status label on one anomaly row; nothing
 *    leaves the tenant.
 *  - `promote` — SUPERVISED: it raises a real alert and publishes
 *    `alert.triggered`, which reaches notification channels and ticket
 *    automation. That is the one status that reaches a person.
 *
 * The device gate (`deviceArgs` + `verifyDeviceAccess`) resolves the device
 * under org, site and exact-device axes; the status/list logic is the exported
 * function the REST route itself calls. Every write stamps `auth.user.id` into
 * a users FK (`ml_feedback_events.actor_user_id`, the promoted alert's actor),
 * so an agent proposal is released as the approver
 * (`USER_OWNED_RELEASE_ACTIONS`) and each write branch checks
 * `approverReleaseMismatch(auth, context)`.
 */
import type { AiTool } from './aiTools';
import { verifyDeviceAccess } from './aiTools';
import { ANOMALY_LIST_STATUSES, DEVICE_ANOMALY_ACTIONS } from './aiToolSchemasAlertTriage';
import { agentRefusal, isAgentPrincipal, json, jsonError } from './aiToolsTicketOpsShared';
import { approverReleaseMismatch } from './aiToolReleaseGuards';
import { sanitizeThrownToolError } from './aiToolErrors';
import type { ToolExecutionContext } from './toolExecutionContext';
import { anomaliesQuerySchema, applyAnomalyStatus, queryDeviceAnomalies } from '../routes/devices/anomalies';
import { z } from 'zod';

type AnomalyAction = (typeof DEVICE_ANOMALY_ACTIONS)[number];

const guid = z.string().guid();

/** `dismiss` / `resolve` / `promote` map onto the route's `{ status }` body. */
const STATUS_FOR_ACTION = { dismiss: 'dismissed', resolve: 'resolved', promote: 'promoted' } as const;

export function registerAnomalyTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_device_anomalies', {
    tier: 1,
    domain: 'monitoring',
    searchHint: 'metric anomalies on a device: list unusual CPU, memory, disk or network behaviour, dismiss or resolve one, promote one to an alert',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'manage_device_anomalies',
      description:
        'Metric anomalies on one device. Actions: list (status filter, default open),dismiss,resolve (anomalyId),promote (anomalyId: raises a real alert and needs approval).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...DEVICE_ANOMALY_ACTIONS], description: 'The action to perform' },
          deviceId: { type: 'string', description: 'Device UUID' },
          anomalyId: { type: 'string', description: 'Anomaly UUID from list (dismiss/resolve/promote)' },
          status: { type: 'string', enum: [...ANOMALY_LIST_STATUSES], description: 'list: status filter (default open)' },
          limit: { type: 'number', description: 'list: max rows (default 25, max 100)' },
          note: { type: 'string', description: 'Optional note recorded with the feedback (max 500 chars)' },
        },
        required: ['action', 'deviceId'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth, context?: ToolExecutionContext) => {
      const action = input.action as AnomalyAction;
      if (!DEVICE_ANOMALY_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const deviceId = guid.safeParse(input.deviceId);
      if (!deviceId.success) return jsonError('deviceId (device UUID) is required', 'VALIDATION_ERROR');

      if (action !== 'list') {
        // A supervised agent proposal is released AS THE APPROVER (USER_OWNED_RELEASE_ACTIONS); a direct agent call never writes.
        if (isAgentPrincipal(auth) && !context?.approverRelease) return agentRefusal(action);
        if (approverReleaseMismatch(auth, context)) return jsonError('Approver release mismatch', 'APPROVER_RELEASE_MISMATCH');
      }

      try {
        // org + site + exact-device axes, the route's getDeviceWithOrgAndSiteCheck.
        const access = await verifyDeviceAccess(deviceId.data, auth);
        if ('error' in access) return jsonError(access.error, 'NOT_FOUND');
        const orgId = access.device.orgId;

        if (action === 'list') {
          const parsed = anomaliesQuerySchema.safeParse({
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          });
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input', 'VALIDATION_ERROR');
          const anomalies = await queryDeviceAnomalies(orgId, deviceId.data, parsed.data);
          return json({ deviceId: deviceId.data, count: anomalies.length, anomalies });
        }

        const anomalyId = guid.safeParse(input.anomalyId);
        if (!anomalyId.success) return jsonError(`anomalyId (anomaly UUID from list) is required for ${action}`, 'VALIDATION_ERROR');
        const outcome = await applyAnomalyStatus({
          orgId,
          deviceId: deviceId.data,
          anomalyId: anomalyId.data,
          actorUserId: auth.user.id,
          input: {
            status: STATUS_FOR_ACTION[action],
            ...(typeof input.note === 'string' ? { note: input.note.slice(0, 500) } : {}),
          },
        });
        if (outcome.status === 'not_found') return jsonError('Anomaly not found', 'NOT_FOUND');
        if (outcome.status === 'disabled') return jsonError('Anomaly alert promotion is disabled', 'FEATURE_DISABLED');
        return json({ anomaly: outcome.data });
      } catch (err) {
        console.error('[manage_device_anomalies]', sanitizeThrownToolError('device-anomalies', err), err);
        return jsonError('Operation failed. Check server logs for details.');
      }
    },
  });
}
