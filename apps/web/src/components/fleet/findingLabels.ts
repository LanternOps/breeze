import { AlertOctagon, AlertTriangle, Info, XCircle } from 'lucide-react';
import type {
  FleetFindingKind, FleetFindingSeverity, FleetFindingStatus, FleetRunStatus,
} from '@/services/fleetFindings';

// Shared badge vocabulary for the fleet findings feed + drawer. Kept in its own
// module (rather than exported from FindingsFeed) so the drawer doesn't have to
// import its own parent — that cycle is how a component ends up rendering
// `undefined` class strings under vitest's module mocking.

/** Filter vocabulary is declared here, not imported from the service, so both
 *  components stay renderable with the service module fully mocked in tests. */
export const FINDING_KINDS: readonly FleetFindingKind[] = [
  'metric_anomaly_pattern',
  'log_correlation',
  'reliability_offenders',
];

export const FINDING_SEVERITIES: readonly FleetFindingSeverity[] = [
  'critical',
  'error',
  'warning',
  'info',
];

export const KIND_LABEL_KEYS: Record<FleetFindingKind, string> = {
  metric_anomaly_pattern: 'longTail.fleet.FindingsFeed.kinds.metricAnomalyPattern',
  log_correlation: 'longTail.fleet.FindingsFeed.kinds.logCorrelation',
  reliability_offenders: 'longTail.fleet.FindingsFeed.kinds.reliabilityOffenders',
};

export const SEVERITY_LABEL_KEYS: Record<FleetFindingSeverity, string> = {
  critical: 'longTail.fleet.FindingsFeed.severities.critical',
  error: 'longTail.fleet.FindingsFeed.severities.error',
  warning: 'longTail.fleet.FindingsFeed.severities.warning',
  info: 'longTail.fleet.FindingsFeed.severities.info',
};

export const STATUS_LABEL_KEYS: Record<FleetFindingStatus, string> = {
  open: 'longTail.fleet.FindingsFeed.statuses.open',
  acknowledged: 'longTail.fleet.FindingsFeed.statuses.acknowledged',
  dismissed: 'longTail.fleet.FindingsFeed.statuses.dismissed',
  resolved: 'longTail.fleet.FindingsFeed.statuses.resolved',
};

export const RUN_STATUS_LABEL_KEYS: Record<FleetRunStatus, string> = {
  queued: 'longTail.fleet.FindingDrawer.runStatuses.queued',
  running: 'longTail.fleet.FindingDrawer.runStatuses.running',
  partial: 'longTail.fleet.FindingDrawer.runStatuses.partial',
  succeeded: 'longTail.fleet.FindingDrawer.runStatuses.succeeded',
  failed: 'longTail.fleet.FindingDrawer.runStatuses.failed',
  cancelled: 'longTail.fleet.FindingDrawer.runStatuses.cancelled',
};

export const SEVERITY_ICONS: Record<
  FleetFindingSeverity,
  React.ComponentType<{ className?: string }>
> = {
  critical: AlertOctagon,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

export const SEVERITY_ICON_CLASSES: Record<FleetFindingSeverity, string> = {
  critical: 'text-red-600 dark:text-red-400',
  error: 'text-orange-600 dark:text-orange-400',
  warning: 'text-yellow-600 dark:text-yellow-500',
  info: 'text-blue-600 dark:text-blue-400',
};

export const STATUS_CHIP_CLASSES: Record<FleetFindingStatus, string> = {
  open: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  acknowledged: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  dismissed: 'bg-muted text-muted-foreground',
  resolved: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
};

export const RUN_STATUS_CHIP_CLASSES: Record<FleetRunStatus, string> = {
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  partial: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  succeeded: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  cancelled: 'bg-muted text-muted-foreground',
};
