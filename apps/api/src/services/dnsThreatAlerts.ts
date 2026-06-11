/**
 * DNS Threat Alert evaluator (#829)
 *
 * Subscribes to `dns.threat.blocked` events on the event bus and inserts
 * a row into `alerts` (severity=high, ruleId=null) when a device hits a
 * threat-categorized domain that DNS blocked, subject to a per-(device,
 * category) cooldown.
 *
 * Mirrors the rule-less alert insert pattern used in
 * `services/warrantyAlertEvaluator.ts` and `services/networkBaseline.ts`
 * — the built-in template lives in `db/seed.ts` for documentation /
 * customer visibility, but the consumer doesn't require a per-org
 * `alertRules` row to fire. This avoids the auto-rule-creation problem
 * the wider alert engine has and ships a working signal today.
 */
import { and, eq, gt, inArray } from 'drizzle-orm';
import { db } from '../db';
import { alerts, devices } from '../db/schema';
import { getEventBus, EVENT_TYPES } from './eventBus';

const DEFAULT_COOLDOWN_MINUTES = 60;
const ALERT_SOURCE = 'dns_threat_evaluator';

export interface DnsThreatBlockedPayload {
  deviceId: string | null;
  domain: string;
  category: string;
  integrationId: string | null;
  timestamp: string;
}

/**
 * Handle a single `dns.threat.blocked` event. Public for tests.
 */
export async function handleDnsThreatBlocked(
  orgId: string,
  payload: DnsThreatBlockedPayload,
  options: { cooldownMinutes?: number } = {}
): Promise<{ alertId: string | null; reason: string }> {
  if (!payload.deviceId) {
    // No device resolution — the DNS event couldn't be tied back to a
    // managed device. Nothing useful to alert on. (Could be a guest
    // device hitting the resolver, or sourceIp unmapped.)
    return { alertId: null, reason: 'no_device' };
  }

  const cooldownMinutes = options.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES;
  const cutoff = new Date(Date.now() - cooldownMinutes * 60 * 1000);

  // Cooldown: skip if an active/acknowledged DNS-threat alert for the same
  // device + category has been raised within the window. The category
  // (e.g. "malware", "phishing") is the dedup key so a phishing hit and a
  // separate malware hit on the same device still both fire.
  const [recent] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(
      and(
        eq(alerts.deviceId, payload.deviceId),
        eq(alerts.configItemName, `dns_threat_${payload.category}`),
        inArray(alerts.status, ['active', 'acknowledged']),
        gt(alerts.triggeredAt, cutoff)
      )
    )
    .limit(1);

  if (recent) {
    return { alertId: null, reason: 'cooldown' };
  }

  // Resolve hostname for the message template. Best-effort — fall back to
  // a stable identifier if device lookup fails.
  const [device] = await db
    .select({ hostname: devices.hostname, displayName: devices.displayName })
    .from(devices)
    .where(eq(devices.id, payload.deviceId))
    .limit(1);

  const hostname = device?.displayName || device?.hostname || payload.deviceId;

  const title = `DNS threat blocked: ${payload.domain} (${payload.category})`;
  const message =
    `Device ${hostname} attempted to reach ${payload.domain} (${payload.category}). ` +
    `Query blocked at the resolver.`;

  const [inserted] = await db
    .insert(alerts)
    .values({
      ruleId: null,
      deviceId: payload.deviceId,
      orgId,
      configPolicyId: null,
      configItemName: `dns_threat_${payload.category}`,
      severity: 'high',
      title,
      message,
      context: {
        source: ALERT_SOURCE,
        domain: payload.domain,
        category: payload.category,
        integrationId: payload.integrationId,
        dnsEventTimestamp: payload.timestamp,
      },
      status: 'active',
      triggeredAt: new Date(),
    })
    .returning({ id: alerts.id });

  return { alertId: inserted?.id ?? null, reason: 'created' };
}

/**
 * Subscribe to the event bus on process startup. Idempotent — subsequent
 * calls return the same unsubscribe function. Caller (`api/index.ts`)
 * invokes this from the boot path.
 */
let activeUnsubscribe: (() => void) | null = null;

export function registerDnsThreatAlertSubscriber(): () => void {
  if (activeUnsubscribe) return activeUnsubscribe;

  const bus = getEventBus();
  activeUnsubscribe = bus.subscribe<DnsThreatBlockedPayload>(
    EVENT_TYPES.DNS_THREAT_BLOCKED,
    async (event) => {
      try {
        await handleDnsThreatBlocked(event.orgId, event.payload);
      } catch (err) {
        // EventBus already swallows + structured-logs handler failures
        // (#820), but log a dedicated line so ops can trace the DNS-alert
        // path specifically.
        console.error(
          '[DnsThreatAlerts] handler failed',
          JSON.stringify({
            errorId: 'DNS_THREAT_ALERT_HANDLER_FAILED',
            orgId: event.orgId,
            domain: event.payload.domain,
            category: event.payload.category,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    }
  );
  return activeUnsubscribe;
}

/** Test-only: clear the registered subscription so a fresh test run starts clean. */
export function _resetDnsThreatAlertSubscriberForTests(): void {
  if (activeUnsubscribe) {
    activeUnsubscribe();
    activeUnsubscribe = null;
  }
}
