import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { showToast } from '@/components/shared/Toast';
import { downloadTrustQuestionnaire, type TrustExportFormat } from '@/lib/trustExport';

interface Props {
  publishedAt: string | null;
  partnerSlug: string;
  orgSlug: string;
  isPartnerHome: boolean;
  pageUrl: string;
}

/** CSV/JSON download of the published page's questionnaire answers. GET only: no mutation, so no runAction. */
export default function TrustExportMenu({ publishedAt, partnerSlug, orgSlug, isPartnerHome, pageUrl }: Props) {
  const { t } = useTranslation('trustCenter');
  const [busy, setBusy] = useState<TrustExportFormat | null>(null);
  const published = publishedAt !== null;

  const run = async (format: TrustExportFormat) => {
    setBusy(format);
    try {
      const done = await downloadTrustQuestionnaire(format, { partnerSlug, orgSlug, isPartnerHome, pageUrl });
      if (!done) showToast({ type: 'error', message: t('export.failed') });
    } catch (err) {
      console.error('[TrustExportMenu] export failed', err);
      showToast({ type: 'error', message: t('export.failed') });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2" data-testid="trust-export-menu">
      <div className="text-xs font-medium text-muted-foreground">{t('export.title')}</div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!published || busy !== null}
          onClick={() => void run('csv')}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="trust-export-csv"
        >
          {t('export.csv')}
        </button>
        <button
          type="button"
          disabled={!published || busy !== null}
          onClick={() => void run('json')}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="trust-export-json"
        >
          {t('export.json')}
        </button>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="trust-export-note">
        {published ? t('export.publishedOnlyNote') : t('export.unpublishedNote')}
      </p>
    </div>
  );
}
