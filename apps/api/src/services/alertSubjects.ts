/**
 * W03 — per-subject (per-component) alert reconciliation.
 *
 * A hardware/RAID monitor's evidence can name several independent subjects
 * (disks, controllers, ...) in one sweep. Each subject creates/recovers its
 * own alert through the identity-scoped insert in `createAlert` — winning or
 * losing that insert is authoritative, so this function never re-derives
 * "is there already an alert" itself for the create side. For recovery it
 * reads the currently open subject alerts under the caller's lock/transaction
 * and resolves only the ones whose subject evidence reports `recovered`.
 *
 * `autoResolveConditions` is deliberately never read: subject recovery is
 * driven purely by the leaf handler's per-subject evidence, not by
 * re-evaluating a device-level condition tree.
 *
 * The FINAL observation reported to the caller is derived from admitted open
 * alerts AFTER creation/recovery, not from the sweep's raw evidence — an
 * all-suppressed sweep (every create call lost cooldown/dedupe/flapping and
 * every existing alert stays open unresolved... actually stays absent) must
 * report `ok`, never a provisional `breach`, so it opens no episode.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { interpolateAlertTemplate } from '@breeze/shared';
import { db } from '../db';
import { alerts, devices } from '../db/schema';
import { createAlert, resolveAlert, RESOLVABLE_ALERT_STATUSES, type RuleWithTemplate } from './alertService';
import type { EvaluationResult } from './alertConditions/types';
import { allocateSubjectEpisode, type MonitorObservation } from './monitors/episodeService';

export interface SubjectAlertInput {
  rule: RuleWithTemplate['rule'];
  template: RuleWithTemplate['template'];
  device: typeof devices.$inferSelect;
  monitor: RuleWithTemplate['monitor'];
  evidence: EvaluationResult & { createdAlertIds: string[] };
}

export async function evaluateSubjectAlerts({ rule, template, device, monitor, evidence }: SubjectAlertInput): Promise<MonitorObservation> {
  const subjects = evidence.subjects ?? [];
  const overrides = rule.overrideSettings as Record<string, unknown> | null;
  const severity = (overrides?.severity as RuleWithTemplate['effectiveSeverity']) ?? template.severity;
  const autoResolve = (overrides?.autoResolve as boolean) ?? template.autoResolve;
  const allocateEpisode = monitor
    ? () => allocateSubjectEpisode({ monitor, deviceId: device.id, orgId: device.orgId })
    : undefined;

  for (const subject of subjects) {
    if (subject.status !== 'breaching') continue;
    const context = {
      ...evidence.context, ...subject.context, source: 'hardware_health', subjectKey: subject.subjectKey,
      deviceName: device.displayName || device.hostname, hostname: device.hostname, osType: device.osType,
      osVersion: device.osVersion, ruleName: rule.name, severity, actualValue: subject.actualValue,
      templateId: template.id, cooldownMinutes: (overrides?.cooldownMinutes as number) ?? template.cooldownMinutes,
    };
    const id = await createAlert({
      ruleId: rule.id, deviceId: device.id, orgId: device.orgId, subjectKey: subject.subjectKey,
      severity, title: interpolateAlertTemplate(template.titleTemplate, context), message: interpolateAlertTemplate(template.messageTemplate, context),
      context, monitorId: rule.managedByMonitorId, kind: monitor?.kind, allocateSubjectEpisode: allocateEpisode,
    });
    if (id) evidence.createdAlertIds.push(id);
  }

  const open = () => db.select().from(alerts).where(and(
    eq(alerts.ruleId, rule.id), eq(alerts.deviceId, device.id), isNotNull(alerts.subjectKey),
    inArray(alerts.status, [...RESOLVABLE_ALERT_STATUSES]),
  ));

  if (autoResolve) {
    const byKey = new Map(subjects.map(s => [s.subjectKey, s]));
    for (const alert of await open()) {
      const subject = byKey.get(alert.subjectKey!);
      if (!alert.requiresHuman && subject?.status === 'recovered') {
        await resolveAlert(alert.id, `Auto-resolved: ${subject.description}`, undefined, true);
      }
    }
  }

  if ((await open()).length > 0) return 'breach';
  if (evidence.dataState === 'unknown' || subjects.some(s => s.status === 'unknown')) return 'unknown';
  return 'ok';
}
