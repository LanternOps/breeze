import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth, useAuthStore } from '../../../stores/auth';
import { useJwtClaims } from '@/lib/authScope';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import { conversionFriendly, conversionPaths, fetchPendingCounts, readPartnerConvertResult, readPartnerPreview, type PartnerConversionPreview, type PartnerConvertResult, type PendingCounts } from './conversionApi';

export interface ConversionPendingBannerProps {
  orgId: string | null;
  onReview: () => void;
  onConverted?: () => void;
  /** Bump to force a refetch after a conversion elsewhere on the page (e.g. an Undo). */
  revision?: number;
}

export default function ConversionPendingBanner({ orgId, onReview, onConverted, revision }: ConversionPendingBannerProps) {
  const { t } = useTranslation(['monitoring', 'common']);
  const claims = useJwtClaims();
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
  const isPartnerScope = claims.status === 'resolved' && claims.claims?.scope === 'partner';
  const [counts, setCounts] = useState<PendingCounts | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [partnerPreview, setPartnerPreview] = useState<PartnerConversionPreview | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try { setCounts(await fetchPendingCounts(orgId)); } catch { setCounts(null); }
  }, [orgId]);
  useEffect(() => { void load(); }, [load, revision]);

  if (!counts || counts.rows === 0) return null;

  const previewEverything = async () => {
    setRunning(true); setPartnerPreview(null); setConfirming(false);
    try {
      const result = await runAction<PartnerConversionPreview>({
        request: () => fetchWithAuth(conversionPaths.partnerPreview(), { method: 'POST' }),
        parseSuccess: readPartnerPreview, friendly: conversionFriendly, errorFallback: t('monitoring:conversion.errors.preview'),
      });
      setPartnerPreview(result); setConfirming(true);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('monitoring:conversion.errors.preview') });
    } finally { setRunning(false); }
  };
  const convertEverything = async () => {
    if (!partnerPreview) return;
    setRunning(true);
    try {
      const result = await runAction<PartnerConvertResult>({
        request: () => fetchWithAuth(conversionPaths.partnerConvertAll(), { method: 'POST', body: JSON.stringify({ previewHash: partnerPreview.previewHash }) }),
        parseSuccess: readPartnerConvertResult,
        friendly: conversionFriendly, errorFallback: t('monitoring:conversion.banner.errors.convertAll'),
      });
      showToast({ type: 'success', message: t('monitoring:conversion.banner.convertedAll', result) });
      setConfirming(false);
      onConverted?.();
      await load();
    } catch (err) {
      setPartnerPreview(null); setConfirming(false); // 409 requires a new preview and confirmation.
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('monitoring:conversion.banner.errors.convertAll') });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm" data-testid="conversion-pending-banner">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p>{t('monitoring:conversion.banner.text', { rows: counts.rows, policies: counts.policies })}</p>
        <div className="flex gap-2">
          <button type="button" data-testid="conversion-pending-review" onClick={onReview} className="rounded-md border px-3 py-1.5 font-medium hover:bg-muted">
            {t('monitoring:conversion.banner.review')}
          </button>
          {isPartnerScope && canManagePartnerWide && !confirming && (
            <button type="button" data-testid="conversion-convert-everything" disabled={running} onClick={() => void previewEverything()} className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90">
              {t('monitoring:conversion.banner.convertEverything')}
            </button>
          )}
        </div>
      </div>
      {confirming && partnerPreview && (
        <div className="mt-3 rounded-md border bg-background p-3" data-testid="conversion-convert-everything-confirm">
          <p className="font-medium">{t('monitoring:conversion.banner.confirmTitle')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('monitoring:conversion.banner.confirmBody', partnerPreview)}</p>
          <ul>{partnerPreview.unconvertible.map((item) => <li key={`${item.sourceTable}:${item.sourceId}`}>
            {item.policyName ?? item.policyId ?? '—'} · {item.name} · {item.reason}
          </li>)}</ul>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirming(false)} className="rounded-md border px-3 py-1.5">{t('common:actions.cancel')}</button>
            <button type="button" data-testid="conversion-convert-everything-run" disabled={running} onClick={() => void convertEverything()} className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:opacity-60">
              {t('monitoring:conversion.banner.confirmRun')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
