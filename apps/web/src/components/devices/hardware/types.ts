import type {
  HardwareComponentType, HardwareHealth, HardwareSource, HardwareSourceReport,
} from '@breeze/shared';
export interface HardwareComponentView {
  id: string; deviceId: string; orgId: string; componentKey: string;
  componentType: HardwareComponentType; parentKey: string | null;
  source: HardwareSource; name: string; model: string | null;
  serial: string | null; firmware: string | null; sizeBytes: number | null;
  health: HardwareHealth; state: string; stateDetail: string | null;
  progressPercent: number | null; temperatureC: number | null;
  predictiveFailure: boolean; alertExempt: boolean;
  attributes: Record<string, unknown>;
  unhealthyStreak: number; criticalStreak: number; healthyStreak: number;
  belowCriticalStreak: number; predictiveStreak: number;
  stale: boolean; staleSince: string | null;
  firstSeenAt: string; lastSeenAt: string; createdAt: string; updatedAt: string;
  fresh: boolean;
}
export interface HardwareEventView {
  id: string; deviceId: string; orgId: string; componentKey: string;
  componentType: HardwareComponentType;
  eventType: 'first_seen' | 'health_changed' | 'state_changed' | 'disk_replaced'
    | 'predictive_failure_set' | 'predictive_failure_cleared' | 'stale' | 'removed';
  fromHealth: HardwareHealth | null; toHealth: HardwareHealth | null;
  fromState: string | null; toState: string | null;
  detail: Record<string, unknown>; snapshotId: string | null;
  occurredAt: string; createdAt: string;
}
export interface HardwareHealthView {
  health: HardwareHealth; collectorHealth: HardwareHealth;
  lastReceivedAt: string | null; lastCollectedAt: string | null;
  pollIntervalMinutes: number | null; diskHealthIntervalMinutes: number | null;
  tiersRun: string[]; agentVersion: string | null;
  sources: HardwareSourceReport[];
  components: HardwareComponentView[]; events: HardwareEventView[];
  policy: { enabled: boolean; source: 'default' | 'policy'; policyName?: string } | null;
}
