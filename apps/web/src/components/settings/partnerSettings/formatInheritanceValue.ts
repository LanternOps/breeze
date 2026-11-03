import type { TFunction } from 'i18next';
import type { CatalogEntry, ValueProjection } from '@breeze/shared';

const K = 'partnerSettingsPage.inheritance.value';

/**
 * Display labels for enum and coded values, keyed by catalog id, reusing the
 * labels the editing control already shows. A value with no label renders as itself.
 */
const VALUE_LABEL_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // 'staged' is the legacy spelling of 'auto' (#1962); the editor folds it the same way.
  'defaults.agentUpdatePolicy': { auto: 'partnerDefaults.automatic', staged: 'partnerDefaults.automatic', manual: 'partnerDefaults.manual' },
  'aiBudgets.approvalMode': {
    per_step: 'partnerAiBudgets.modes.perStep',
    action_plan: 'partnerAiBudgets.modes.actionPlan',
    auto_approve: 'partnerAiBudgets.modes.autoApprove',
    hybrid_plan: 'partnerAiBudgets.modes.hybridPlan',
  },
  'notifications.pushoverDefaultPriority': {
    '-2': 'partnerNotifications.priorities.lowest',
    '-1': 'partnerNotifications.priorities.low',
    '0': 'partnerNotifications.priorities.normal',
    '1': 'partnerNotifications.priorities.high',
    '2': 'partnerNotifications.priorities.emergency',
  },
};

/** Every label key above, for the locale-existence test. */
export const VALUE_LABEL_KEY_LIST: readonly string[] = Object.values(VALUE_LABEL_KEYS).flatMap(m => Object.values(m));

export function formatMinutes(minutes: number, t: TFunction): string {
  if (minutes > 0 && minutes % 1440 === 0) return t(/* i18n-dynamic */ `${K}.days`, { count: minutes / 1440 });
  if (minutes > 0 && minutes % 60 === 0) return t(/* i18n-dynamic */ `${K}.hours`, { count: minutes / 60 });
  return t(/* i18n-dynamic */ `${K}.minutes`, { count: minutes });
}

function formatNumber(value: number, projection: Extract<ValueProjection, { kind: 'number' }>, t: TFunction, locale: string): string {
  switch (projection.unit) {
    case 'minutes': return formatMinutes(value, t);
    case 'days': return t(/* i18n-dynamic */ `${K}.days`, { count: value });
    case 'cents': return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(value / 100);
    case 'percent': return `${new Intl.NumberFormat(locale).format(value)}%`;
    default: return new Intl.NumberFormat(locale).format(value);
  }
}

/**
 * A projected, non-secret value as display text, or null when there is
 * nothing to show (null/undefined, a presence-only field, an unexpected shape).
 */
export function formatInheritanceValue(
  entry: Pick<CatalogEntry, 'id' | 'projection'>,
  value: unknown,
  t: TFunction,
  locale = 'en',
): string | null {
  if (value === null || value === undefined) return null;
  const labelKey = VALUE_LABEL_KEYS[entry.id]?.[String(value)];
  if (labelKey) return t(/* i18n-dynamic */ labelKey);
  const { projection } = entry;
  switch (projection.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? t(/* i18n-dynamic */ value ? `${K}.on` : `${K}.off`) : null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? formatNumber(value, projection, t, locale) : null;
    case 'enum':
    case 'version':
    case 'color':
      return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
    case 'presence':
    default:
      return null;
  }
}
