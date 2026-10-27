/**
 * Tool Catalog W06 (#5221) Task A4 — the `create_alert` built-in (Tier 2,
 * `alerts.write`): one alert on one device of the RUN org, written by the
 * legacy automation alert writer (services/alertCreation.ts) so a converted
 * Job's alert is the same row. Attribution is the flow run, never an
 * automation id.
 *
 * The device must be a device of the run org; anything else is refused before
 * any write (`reference_not_owned`). The write runs under the flow principal's
 * run-org DB context. A failed write is `alert_create_failed` (onFailure
 * applies); nothing was raised.
 */
import { and, eq } from 'drizzle-orm';
import type { FlowValue } from '@breeze/shared';
import { db, runOutsideDbContext, withDbAccessContext } from '../../../db';
import { devices } from '../../../db/schema';
import { createAutomationStyleAlert } from '../../alertCreation';
import { flowDbAccessContext } from '../flowAuthContext';
import type { StepOutcome } from '../stepExecutor';
import type { BuiltinContext } from './types';

export interface CreateAlertInput {
  deviceId: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title?: string;
  message: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FLOW_ALERT_DEFAULT_TITLE = 'Flow alert';

export async function executeCreateAlert(input: CreateAlertInput, ctx: BuiltinContext): Promise<StepOutcome> {
  if (!UUID_RE.test(input.deviceId)) {
    return { kind: 'failed', code: 'input_invalid', message: 'deviceId must be a device id.', policy: true };
  }
  const orgId = ctx.run.orgId;
  const outcome = await runOutsideDbContext(() => withDbAccessContext(flowDbAccessContext(orgId, ctx.auth.partnerId!), async () => {
    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, input.deviceId), eq(devices.orgId, orgId)))
      .limit(1);
    if (!device) return 'not_owned' as const;
    try {
      return await createAutomationStyleAlert({
        orgId,
        deviceId: device.id,
        severity: input.severity,
        title: input.title ?? FLOW_ALERT_DEFAULT_TITLE,
        message: input.message,
        provenance: { kind: 'flow', flowRunId: ctx.run.id },
      }) ?? ('failed' as const);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }));
  if (outcome === 'not_owned') {
    return { kind: 'failed', code: 'reference_not_owned', message: 'This device is not in the run\'s organization.', policy: true };
  }
  if (outcome === 'failed' || 'error' in outcome) {
    const detail = outcome === 'failed' ? 'the alert row was not written' : outcome.error;
    return { kind: 'failed', code: 'alert_create_failed', message: `The alert could not be created: ${detail.slice(0, 300)}`, policy: false };
  }
  return { kind: 'completed', output: { alertId: outcome.alertId } as FlowValue, truncated: false };
}
