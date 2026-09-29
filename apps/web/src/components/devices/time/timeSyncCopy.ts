import type { ExpectedTimezone, TimeSyncFinding } from './types';
type Translate = (key: string) => string;
export function findingCopy(
  t: Translate,
  finding: TimeSyncFinding,
  deviceName: string,
  expected: ExpectedTimezone | null,
): { label: string; hint: string } {
  const detail = {
    ...finding.detail,
    device: deviceName,
    'site or policy':
      expected?.sourceName ??
      (expected
        ? t(/* i18n-dynamic */ `devices:timeSync.${expected.source}`)
        : t('devices:timeSync.unknown')),
  };
  const template = t(
    /* i18n-dynamic */ `devices:timeSync.findings.${finding.code}.hint`,
  );
  return {
    label: t(
      /* i18n-dynamic */ `devices:timeSync.findings.${finding.code}.label`,
    ),
    hint: template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
      const value = (
        detail as Record<string, string | number | null | undefined>
      )[key];
      return value === null || value === undefined
        ? t('devices:timeSync.unknown')
        : String(value);
    }),
  };
}
