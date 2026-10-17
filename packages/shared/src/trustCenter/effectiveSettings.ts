import type { TelemetryControlId, TrustFramework } from './types';

/**
 * Trust page settings that inherit: org page (non-null) → partner template (W02g, non-null) → built-in default
 * (settings rule 3; spec §19 item 33). The resolved values are what publish freezes into `published_config`.
 */
export const TRUST_SETTING_KEYS = [
  'introHtml', 'searchIndexable', 'showPercentages', 'showDeviceCount', 'showManagedBy', 'showHistory', 'hiddenControlIds', 'frameworkView',
] as const;
export type TrustSettingKey = (typeof TRUST_SETTING_KEYS)[number];
export type TrustSettingSource = 'page' | 'template' | 'default';

export interface TrustSettingValues {
  introHtml: string | null;
  searchIndexable: boolean;
  showPercentages: boolean;
  showDeviceCount: boolean;
  showManagedBy: boolean;
  showHistory: boolean;
  hiddenControlIds: TelemetryControlId[];
  frameworkView: TrustFramework[];
}
/** One level of the chain: null = "not set here, inherit". For `introHtml`, '' = explicitly no intro. */
export type TrustTemplateSettings = { [K in TrustSettingKey]: TrustSettingValues[K] | null };
export interface EffectiveTrustSettings {
  values: TrustSettingValues;
  sources: Record<TrustSettingKey, TrustSettingSource>;
}

/** W1's column defaults (§18.4: percentages and device count off, managed-by on). frameworkView's default is env-dependent (W02e). */
export const TRUST_BUILTIN_DEFAULTS: Readonly<Omit<TrustSettingValues, 'frameworkView'>> = Object.freeze({
  introHtml: null,
  searchIndexable: false,
  showPercentages: false,
  showDeviceCount: false,
  showManagedBy: true,
  showHistory: false,
  hiddenControlIds: Object.freeze([]) as unknown as TelemetryControlId[],
});

const copy = <T>(v: T): T => (Array.isArray(v) ? ([...v] as T) : v);

export function resolveEffectiveTrustSettings(
  page: TrustTemplateSettings,
  template: TrustTemplateSettings | null,
  defaultFrameworkView: TrustFramework[],
): EffectiveTrustSettings {
  const defaults: TrustSettingValues = { ...TRUST_BUILTIN_DEFAULTS, frameworkView: defaultFrameworkView };
  const values = {} as Record<TrustSettingKey, unknown>;
  const sources = {} as Record<TrustSettingKey, TrustSettingSource>;
  for (const key of TRUST_SETTING_KEYS) {
    const pageValue = page[key];
    const templateValue = template ? template[key] : null;
    if (pageValue !== null && pageValue !== undefined) {
      values[key] = copy(pageValue);
      sources[key] = 'page';
    } else if (templateValue !== null && templateValue !== undefined) {
      values[key] = copy(templateValue);
      sources[key] = 'template';
    } else {
      values[key] = copy(defaults[key]);
      sources[key] = 'default';
    }
  }
  // An explicitly empty intro ('') is "no intro", owned by the level that set it — it must not fall through.
  if (values.introHtml === '') values.introHtml = null;
  return { values: values as unknown as TrustSettingValues, sources };
}
