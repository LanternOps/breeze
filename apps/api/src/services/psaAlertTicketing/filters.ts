import {
  alertTicketingSeverityMeetsMinimum,
  type ConnectwiseAlertTicketingStored,
} from '@breeze/shared';
export function matchesTicketingFilters(
  alert: { severity: string; ruleId: string | null; monitorId: string | null },
  config: ConnectwiseAlertTicketingStored
) {
  return (
    alertTicketingSeverityMeetsMinimum(alert.severity, config.minSeverity) &&
    (!config.ruleIds?.length || (alert.ruleId !== null && config.ruleIds.includes(alert.ruleId))) &&
    (!config.monitorIds?.length ||
      (alert.monitorId !== null && config.monitorIds.includes(alert.monitorId)))
  );
}
