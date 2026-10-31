import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { ArrowRightLeft } from 'lucide-react';
import { ActionError } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import { createConversionsBulk } from './conversionApi';

/**
 * The R1 Jobs banner (#5221 W06, plan Decision 10): "Jobs are moving to Flows."
 * With write access it offers "Start shadow for all convertible" for the
 * selected organization — shadow conversions only, never a switch (Decision 2).
 * R2/R3 copy belongs to the release-gated follow-up (#10336).
 */
export function JobsMigrationBanner({
  canWrite,
  orgId,
  onConverted,
}: {
  canWrite: boolean;
  /** The selected organization; omitted for an org-scoped user (the server resolves theirs). */
  orgId?: string | null;
  onConverted: () => void;
}) {
  const { t } = useTranslation('flows');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<{ created: number; skipped: number } | null>(null);

  const convertAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await createConversionsBulk({ ownerScope: 'organization', ...(orgId ? { orgId } : {}) });
      const skipped = Object.values(r.skipped ?? {}).reduce((a, n) => a + n, 0);
      setSummary({ created: r.created, skipped });
      onConverted();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('conversion.errors.bulkFailed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      data-testid="jobs-migration-banner"
      className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-3">
        <ArrowRightLeft className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div>
          <p className="text-sm font-semibold">{t('jobs.migration.banner.r1')}</p>
          <p className="text-sm text-muted-foreground">{t('jobs.migration.banner.r1Body')}</p>
          {summary && (
            <p className="mt-1 text-sm" data-testid="jobs-migration-summary">
              {t('jobs.migration.bulkSummary', { created: summary.created, skipped: summary.skipped })}
            </p>
          )}
        </div>
      </div>
      {canWrite && (
        <button
          type="button"
          data-testid="jobs-migration-convert-all"
          disabled={busy}
          onClick={convertAll}
          className="h-9 shrink-0 rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-60"
        >
          {busy ? t('jobs.migration.converting') : t('jobs.migration.convertAll')}
        </button>
      )}
    </div>
  );
}
