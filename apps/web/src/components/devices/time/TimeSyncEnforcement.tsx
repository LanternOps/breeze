import { useTranslation } from 'react-i18next';
import type { TimeSyncEnforcementState } from '@breeze/shared';
import '@/lib/i18n';
export default function TimeSyncEnforcement({
  report,
}: {
  report: TimeSyncEnforcementState | null;
}) {
  const { t } = useTranslation('devices');
  const outcomes = {
    ok: t('timeSync.enforcement.ok'),
    failed: t('timeSync.enforcement.failed'),
    skipped: t('timeSync.enforcement.skipped'),
  };
  const reasons = {
    applied: t('timeSync.enforcement.applied'),
    already_compliant: t('timeSync.enforcement.already_compliant'),
    role_unknown: t('timeSync.enforcement.role_unknown'),
    conflict_gpo: t('timeSync.enforcement.conflict_gpo'),
    readback_mismatch: t('timeSync.enforcement.readback_mismatch'),
    exec_failed: t('timeSync.enforcement.exec_failed'),
    invalid_settings: t('timeSync.enforcement.invalid_settings'),
    auto_timezone_on: t('timeSync.enforcement.auto_timezone_on'),
    no_expected_timezone: t('timeSync.enforcement.no_expected_timezone'),
  };
  if (!report?.ntp && !report?.timezone)
    return (
      <p className="text-sm text-muted-foreground">
        {t('timeSync.enforcement.none')}
      </p>
    );
  return (
    <section aria-label={t('timeSync.enforcement.title')} className="space-y-3">
      <h4 className="font-medium">{t('timeSync.enforcement.title')}</h4>
      {(['ntp', 'timezone'] as const).map((kind) => {
        const result = report?.[kind];
        if (!result) return null;
        const color =
          result.outcome === 'failed'
            ? 'bg-destructive/15 text-destructive border-destructive/30'
            : result.outcome === 'skipped'
              ? 'bg-warning/15 text-warning border-warning/30'
              : 'bg-success/15 text-success border-success/30';
        return (
          <article
            key={kind}
            data-testid={`time-sync-enforcement-${kind}`}
            className="rounded-md border p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h5>
                {kind === 'ntp'
                  ? t('timeSync.enforcement.ntp')
                  : t('timeSync.enforcement.timezone')}
              </h5>
              <span
                className={`rounded-full border px-2 py-0.5 text-xs ${color}`}
              >
                {outcomes[result.outcome]}
              </span>
            </div>
            <p className="text-sm">{reasons[result.reason]}</p>
            <p className="text-sm text-muted-foreground">
              {t('timeSync.enforcement.reportedAt')}:{' '}
              <time
                data-testid={`time-sync-enforcement-at-${kind}`}
                dateTime={result.at}
              >
                {new Date(result.at).toLocaleString()}
              </time>
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <h6 className="text-sm font-medium">
                  {t('timeSync.enforcement.before')}
                </h6>
                <pre
                  data-testid={`time-sync-before-${kind}`}
                  className="overflow-auto whitespace-pre-wrap break-words text-xs"
                >
                  {JSON.stringify(result.before, null, 2)}
                </pre>
              </div>
              <div>
                <h6 className="text-sm font-medium">
                  {t('timeSync.enforcement.after')}
                </h6>
                <pre
                  data-testid={`time-sync-after-${kind}`}
                  className="overflow-auto whitespace-pre-wrap break-words text-xs"
                >
                  {JSON.stringify(result.after, null, 2)}
                </pre>
              </div>
            </div>
            {result.error && (
              <p className="break-words text-sm text-destructive">
                {result.error}
              </p>
            )}
          </article>
        );
      })}
    </section>
  );
}
