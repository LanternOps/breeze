/**
 * New remote access / RMM tool alerts (#11306).
 *
 * The agent's management-posture scan (agent/internal/mgmtdetect) reports the
 * remote access and RMM tools it finds. When a scan finds one the previous scan
 * for that device did not (knownTools.ts), the partner gets an alert on the
 * device. Remote access tools are a common tech-support scam vector, and an
 * unexpected second RMM is worth a look too.
 *
 * - **One built-in rule per tool per org**, created lazily on first fire under
 *   the `management-posture` built-in source (BUILT_IN_ALERT_RULE_SOURCES).
 *   The rule's Active switch in the Built-in alerts list is the per-org
 *   control: switching off "New remote access tool: Splashtop" means "we use
 *   Splashtop in this org". Every org starts with each rule on.
 * - **One open alert per tool per device.** createAlert dedupes on an open
 *   alert for the (rule, device) pair, so a tool that comes and goes while its
 *   alert is open raises nothing new.
 * - Rule names come only from KNOWN_REMOTE_TOOLS, so the rule count per org is
 *   bounded by the agent's signature list.
 *
 * Alerts go through createAlert (dedupe, cooldown, outbox, notifications),
 * never a bare insert into `alerts` (#5241).
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import * as dbModule from '../../db';
import { alertRules, alertTemplates, devices } from '../../db/schema';
import { createAlert } from '../alertService';
import { insertBuiltInAlertRule } from '../builtInAlertRules';
import { checkDeviceMaintenanceWindow } from '../featureConfigResolver';
import { captureException } from '../sentry';
import type { AppearedRemoteTool, RemoteToolCategory } from './knownTools';

const { db } = dbModule;

export const MANAGEMENT_POSTURE_ALERT_SOURCE = 'management-posture';

type CategoryConfig = {
  templateName: string;
  ruleNamePrefix: string;
  /** Issue #11306: warning for remote access, info for RMM. */
  severity: 'medium' | 'info';
  label: string;
};

const CATEGORY_CONFIG: Record<RemoteToolCategory, CategoryConfig> = {
  remoteAccess: {
    templateName: 'New remote access tool detected',
    ruleNamePrefix: 'New remote access tool: ',
    severity: 'medium',
    label: 'remote access tool',
  },
  rmm: {
    templateName: 'New RMM agent detected',
    ruleNamePrefix: 'New RMM agent: ',
    severity: 'info',
    label: 'RMM agent',
  },
};

/** Short: the alert is about one appearance, and an open alert already dedupes. */
const TEMPLATE_COOLDOWN_MINUTES = 15;

export function remoteToolRuleName(tool: Pick<AppearedRemoteTool, 'name' | 'category'>): string {
  return `${CATEGORY_CONFIG[tool.category].ruleNamePrefix}${tool.name}`;
}

async function ensureGlobalTemplate(category: RemoteToolCategory): Promise<string> {
  const config = CATEGORY_CONFIG[category];
  const [existing] = await db
    .select({ id: alertTemplates.id })
    .from(alertTemplates)
    .where(and(isNull(alertTemplates.orgId), isNull(alertTemplates.partnerId), eq(alertTemplates.name, config.templateName)))
    .orderBy(asc(alertTemplates.createdAt))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(alertTemplates)
    .values({
      orgId: null,
      partnerId: null,
      name: config.templateName,
      description: `Raised when a device's management scan finds a ${config.label} that the previous scan did not`,
      category: 'security',
      conditions: { source: MANAGEMENT_POSTURE_ALERT_SOURCE, toolCategory: category },
      severity: config.severity,
      titleTemplate: `New ${config.label} on {{hostname}}: {{toolName}}`,
      messageTemplate: `Breeze found {{toolName}} on {{hostname}}. It was not there on the previous scan.`,
      autoResolve: false,
      isBuiltIn: true,
      cooldownMinutes: TEMPLATE_COOLDOWN_MINUTES,
    })
    .returning({ id: alertTemplates.id });
  if (!created) throw new Error(`[remoteToolAlerts] failed to create template "${config.templateName}"`);
  return created.id;
}

/** The org's rule for this tool, created on first fire. */
export async function ensureRemoteToolRule(orgId: string, tool: Pick<AppearedRemoteTool, 'name' | 'category'>): Promise<string> {
  const name = remoteToolRuleName(tool);
  const [existing] = await db
    .select({ id: alertRules.id })
    .from(alertRules)
    .where(and(eq(alertRules.orgId, orgId), eq(alertRules.name, name), isNull(alertRules.retiredAt)))
    .limit(1);
  if (existing) return existing.id;

  const templateId = await ensureGlobalTemplate(tool.category);
  return insertBuiltInAlertRule({
    orgId,
    templateId,
    name,
    overrideSettings: { source: MANAGEMENT_POSTURE_ALERT_SOURCE, toolName: tool.name, toolCategory: tool.category },
  });
}

async function loadHostLabel(deviceId: string, orgId: string): Promise<string> {
  const [row] = await db
    .select({ hostname: devices.hostname, displayName: devices.displayName })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);
  return row?.displayName || row?.hostname || deviceId;
}

/**
 * The template is global and the rule org-owned, so this runs under system
 * scope. The posture route calls it after its own transaction commits, so it
 * holds no context; in place when the caller is already system-scoped.
 */
function runWithSystemDbAccess<T>(fn: () => Promise<T>): Promise<T> {
  if (dbModule.getCurrentDbAccessContext()?.scope === 'system') return fn();
  return dbModule.runOutsideDbContext(() => dbModule.withSystemDbAccessContext(fn));
}

export type RemoteToolAlertInput = {
  deviceId: string;
  orgId: string;
  /** The scan's `collectedAt`. */
  detectedAt: string;
  tools: AppearedRemoteTool[];
};

export type RemoteToolAlertOutcome = {
  raised: string[];
  /** Not raised: rule switched off, an open alert already covers it, cooldown or flapping. */
  held: string[];
  failed: string[];
  suppressedByMaintenance: boolean;
};

/**
 * Raise one alert per appeared tool. Never throws: the posture is already
 * saved when this runs, so a failure is logged and reported to Sentry, and that
 * appearance is not alerted (the audit row the posture route writes still
 * records the change). Each tool runs in its own transaction, so one failure
 * does not stop the rest.
 */
export async function raiseRemoteToolAppearedAlerts(input: RemoteToolAlertInput): Promise<RemoteToolAlertOutcome> {
  const outcome: RemoteToolAlertOutcome = { raised: [], held: [], failed: [], suppressedByMaintenance: false };
  const { deviceId, orgId, detectedAt, tools } = input;
  if (tools.length === 0) return outcome;

  let hostLabel: string;
  try {
    // The maintenance read is in system scope with the rest: with no context
    // of its own, forced RLS would find no window at all.
    const prelude = await runWithSystemDbAccess(async () => ({
      maintenance: await checkDeviceMaintenanceWindow(deviceId),
      hostLabel: await loadHostLabel(deviceId, orgId),
    }));
    if (prelude.maintenance.active && prelude.maintenance.suppressAlerts) {
      outcome.suppressedByMaintenance = true;
      return outcome;
    }
    hostLabel = prelude.hostLabel;
  } catch (error) {
    reportFailure(error, input, tools.map((tool) => tool.name));
    outcome.failed.push(...tools.map((tool) => tool.name));
    return outcome;
  }

  for (const tool of tools) {
    const config = CATEGORY_CONFIG[tool.category];
    try {
      const alertId = await runWithSystemDbAccess(async () => {
        const ruleId = await ensureRemoteToolRule(orgId, tool);
        return createAlert({
          ruleId,
          deviceId,
          orgId,
          severity: config.severity,
          title: `New ${config.label} on ${hostLabel}: ${tool.name}`,
          message: `Breeze found ${tool.name} on ${hostLabel} at ${detectedAt}. It was not there on the previous scan. `
            + 'If your team did not install it, find out who did.',
          context: {
            source: MANAGEMENT_POSTURE_ALERT_SOURCE,
            category: 'security',
            toolName: tool.name,
            toolCategory: tool.category,
            detectionStatus: tool.status,
            detectedAt,
          },
        });
      });
      (alertId ? outcome.raised : outcome.held).push(tool.name);
    } catch (error) {
      outcome.failed.push(tool.name);
      reportFailure(error, input, [tool.name]);
    }
  }
  return outcome;
}

function reportFailure(error: unknown, input: RemoteToolAlertInput, toolNames: string[]): void {
  console.error('[remoteToolAlerts] failed to raise new remote tool alert(s):', {
    deviceId: input.deviceId,
    orgId: input.orgId,
    tools: toolNames,
    error,
  });
  captureException(error, undefined, { errorId: 'remote-tool-alert-failed' }, { fingerprint: ['remote-tool-alert-failed'] });
}
