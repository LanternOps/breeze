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
import * as dbModule from '../db';
import { alerts, devices } from '../db/schema';
import type { BreezeEvent } from './eventBus';

const { db } = dbModule;

// #4085 final-review fix: publish() (eventBus.ts) invokes durable-registry
// handlers via runOutsideDbContext, i.e. scope 'none' — under forced RLS
// (queue-mode dispatch) that is a 42501 the moment this handler's `db.select`/
// `db.insert(alerts)` run without an explicit access context. Mirrors
// policyAlertBridge.ts's local helper exactly.
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

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
    .select({
      hostname: devices.hostname,
      displayName: devices.displayName,
      isEphemeral: devices.isEphemeral,
    })
    .from(devices)
    .where(eq(devices.id, payload.deviceId))
    .limit(1);

  // Quick Support exclusion: ephemeral devices live in the hidden per-partner
  // 'quick_support' org and are a stranger's personal machine borrowed for one
  // ~20-minute session. That org stays inside technicians' accessibleOrgIds for
  // RLS reasons, so nothing upstream filters them out. A DNS threat on someone's
  // home network is not the MSP's incident and must not page an on-call tech.
  if (device?.isEphemeral) {
    return { alertId: null, reason: 'ephemeral_device' };
  }

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
 * Handle a `dns.threat.blocked` event.
 *
 * Registered under subscriber id `dns-threat-alerts` (services/eventSubscribers.ts).
 * MUST throw on failure — queue-mode dispatch (#4085) retries on a thrown
 * rejection; local delivery's wrapper (eventBus.ts's invokeLocalHandlers)
 * provides the swallow-and-log semantics the old subscriber's try/catch used
 * to provide itself.
 */
export async function handleDnsThreatBlockedEvent(event: BreezeEvent): Promise<void> {
  const payload = event.payload as unknown as DnsThreatBlockedPayload;
  try {
    await runWithSystemDbAccess(() => handleDnsThreatBlocked(event.orgId, payload));
  } catch (err) {
    // Structured log kept for ops to trace the DNS-alert path specifically,
    // then rethrown so the failure is visible to retry/observability layers
    // above (queue-mode dispatch retries it; local delivery's captureException
    // still fires one layer up).
    console.error(
      '[DnsThreatAlerts] handler failed',
      JSON.stringify({
        errorId: 'DNS_THREAT_ALERT_HANDLER_FAILED',
        orgId: event.orgId,
        domain: payload?.domain,
        category: payload?.category,
        error: err instanceof Error ? err.message : String(err),
      })
    );
    throw err;
  }
}
