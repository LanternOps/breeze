import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { RISK_LEVELS, dataTypeLabel } from './constants';

// Display labels for Sensitive Data enum values. The API values stay as the
// stable keys (filters still send `false_positive`, not the label); only the
// rendered text goes through i18n (#9928).

const RISK_KEYS: Record<string, string> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

const FINDING_STATUS_KEYS: Record<string, string> = {
  open: 'open',
  remediated: 'remediated',
  accepted: 'accepted',
  false_positive: 'falsePositive',
};

const SCAN_STATUS_KEYS: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

// PCI / PHI / PII are acronyms that read the same in every locale, so they
// have no catalog entry and fall through to `dataTypeLabel`.
const DATA_TYPE_KEYS: Record<string, string> = {
  credential: 'credential',
  financial: 'financial',
};

/** Raw value with underscores spaced out — the fallback for an unknown enum value. */
function humanizeRaw(value: string): string {
  return value.replace(/_/g, ' ');
}

/** Severity rank for a risk level: 0 = critical. Unknown levels sort last. */
export function riskRank(risk: string): number {
  const index = (RISK_LEVELS as readonly string[]).indexOf(risk);
  return index === -1 ? RISK_LEVELS.length : index;
}

/** Sort `[risk, value]` entries by severity (critical → low), unknown levels last. */
export function sortByRisk<T>(entries: Array<[string, T]>): Array<[string, T]> {
  return [...entries].sort(([a], [b]) => riskRank(a) - riskRank(b));
}

export function useSensitiveDataLabels() {
  const { t } = useTranslation('security');
  return useMemo(() => {
    const lookup = (group: string, keys: Record<string, string>, value: string, fallback: string) => {
      const key = keys[value];
      return key ? t(/* i18n-dynamic */ `sensitiveDataLabels.${group}.${key}`, { defaultValue: fallback }) : fallback;
    };
    return {
      riskLabel: (risk: string) => lookup('risk', RISK_KEYS, risk, humanizeRaw(risk)),
      findingStatusLabel: (status: string) =>
        lookup('findingStatus', FINDING_STATUS_KEYS, status, humanizeRaw(status)),
      scanStatusLabel: (status: string) => lookup('scanStatus', SCAN_STATUS_KEYS, status, humanizeRaw(status)),
      dataTypeLabel: (dataType: string) =>
        lookup('dataType', DATA_TYPE_KEYS, dataType, dataTypeLabel(dataType)),
    };
  }, [t]);
}
