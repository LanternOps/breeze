import type { AlertSeverity } from '@breeze/shared';

export interface OfflineObservation {
  deviceId: string;
  orgId: string;
  siteId: string;
  hostname: string;
  displayName: string | null;
  osType: string;
  osVersion: string;
  observedLastSeenAt: string;
}

export interface OfflineRulePlan {
  ruleId: string;
  policy: boolean;
  name: string;
  severity: AlertSeverity;
  conditions: unknown;
  cooldownMinutes: number;
  titleTemplate: string;
  messageTemplate: string;
  templateId?: string;
}

export type OfflineEffectPayload =
  | { type: 'offline-event' | 'alert-plan'; observation: OfflineObservation }
  | { type: 'alert-rule'; observation: OfflineObservation; rule: OfflineRulePlan }
  | { type: 'alert-event'; siteId: string; occurredAt: string; event: Record<string, unknown> }
  | {
    type: 'alert-postprocess'; ruleId: string; policy: boolean; alertId: string | null;
    occurredAt: string; multiplier: number; recordTrigger: boolean;
  };
