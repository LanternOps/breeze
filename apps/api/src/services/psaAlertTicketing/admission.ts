import { alertTicketingSeverityMeetsMinimum, type ConnectwiseAlertTicketingStored } from '@breeze/shared';
import { loadAdmission, insertAdmission, wakeAlertMappings } from './storage';
export type AdmissionResult = 'admitted' | 'exists' | 'filtered' | 'inactive';
export interface AdmissionAlert {
  id: string; orgId: string; deviceId: string | null; status: string; severity: string;
  ruleId: string | null; monitorId: string | null; triggeredAt: Date;
}
export interface AdmissionTarget {
  connectionId: string; config: ConnectwiseAlertTicketingStored; rev: number; enabledAt: Date;
}
export interface AdmissionDeps {
  load(id: string): Promise<{ alert: AdmissionAlert; target: AdmissionTarget } | null>;
  insert(alert: AdmissionAlert, target: AdmissionTarget, source: 'auto' | 'manual'): Promise<string | null>;
  wake(alertId: string): Promise<void>;
}
export function makeAdmission(deps: AdmissionDeps) {
  return async (alertId: string, source: 'auto' | 'manual', opts?: { bypassFilters?: boolean }): Promise<AdmissionResult> => {
    const loaded = await deps.load(alertId);
    if (!loaded) return 'inactive';
    const { alert, target } = loaded;
    if (!['active', 'acknowledged'].includes(alert.status)) return 'filtered';
    const c = target.config;
    if (!opts?.bypassFilters && (!alertTicketingSeverityMeetsMinimum(alert.severity, c.minSeverity)
      || (c.ruleIds?.length && (!alert.ruleId || !c.ruleIds.includes(alert.ruleId)))
      || (c.monitorIds?.length && (!alert.monitorId || !c.monitorIds.includes(alert.monitorId))))) return 'filtered';
    const id = await deps.insert(alert, target, source);
    // Durable insertion is already committed. Redis loss is repaired by the sweep.
    await deps.wake(alertId).catch(() => {});
    return id ? 'admitted' : 'exists';
  };
}
export const admitAlert = makeAdmission({ load: loadAdmission, insert: insertAdmission, wake: wakeAlertMappings });
