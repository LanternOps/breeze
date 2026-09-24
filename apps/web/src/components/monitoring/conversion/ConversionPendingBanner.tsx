import { useCallback, useEffect, useId, useRef, useState } from 'react';
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

const dismissKey = (viewerId: string, scopeId: string, sweptAt: string) =>
  `breeze.legacyAlertingRetirement.dismissed:${viewerId}:${scopeId}:${sweptAt}`;
function isDismissed(key: string): boolean {
  try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
}
function dismiss(key: string) {
  try { window.localStorage.setItem(key, '1'); } catch { /* Private windows can still dismiss for this render. */ }
}

export default function ConversionPendingBanner({ orgId, onReview, onConverted, revision }: ConversionPendingBannerProps) {
  const { t } = useTranslation(['monitoring', 'common']);
  const claims = useJwtClaims();
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
  const isPartnerScope = claims.status === 'resolved' && claims.claims?.scope === 'partner';
  const viewerId = useAuthStore((s) => s.user?.id ?? 'anonymous');
  const scopeId = orgId ?? (claims.status === 'resolved' ? claims.claims?.partnerId : null) ?? 'unscoped';
  const requestScope = JSON.stringify([viewerId, orgId, claims.status,
    claims.status === 'resolved' ? claims.claims : null]);
  const [report, setReport] = useState<{ scope: string; counts: PendingCounts } | null>(null);
  const counts = report?.scope === requestScope ? report.counts : null;
  const activeScope = useRef<string | null>(null);
  const requestVersion = useRef(0);
  const [confirming, setConfirming] = useState(false);
  const [partnerPreview, setPartnerPreview] = useState<PartnerConversionPreview | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    if (activeScope.current !== requestScope) return;
    const version = ++requestVersion.current;
    try {
      const result = await fetchPendingCounts(orgId);
      if (requestVersion.current === version && activeScope.current === requestScope) {
        setReport({ scope: requestScope, counts: result });
      }
    } catch {
      if (requestVersion.current === version && activeScope.current === requestScope) setReport(null);
    }
  }, [orgId, requestScope]);
  useEffect(() => {
    activeScope.current = requestScope;
    void load();
    return () => { activeScope.current = null; requestVersion.current++; };
  }, [load, requestScope, revision]);

  const sweptAt = counts?.sweep?.sweptAt ?? counts?.unconvertible[0]?.retiredAt ?? 'manual';
  const key = dismissKey(viewerId, scopeId, sweptAt);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const listId = useId();
  const hidden = dismissedKey === key || isDismissed(key);
  const open = openKey === key;

  if (!counts) return null;

  // Two independent counts in one sentence: i18next only pluralizes a single
  // `count`, so each is pluralized on its own and composed into the template
  // (sweep F5 — "1 policies" before this).
  const rowsText = t('monitoring:conversion.banner.rowsCount', { count: counts.rows });
  const policiesText = t('monitoring:conversion.banner.policiesCount', { count: counts.policies });
  const confirmRowsText = partnerPreview
    ? t('monitoring:conversion.banner.rowsCount', { count: partnerPreview.rows })
    : '';
  const confirmPoliciesText = partnerPreview
    ? t('monitoring:conversion.banner.policiesCount', { count: partnerPreview.policies })
    : '';

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
    <>
    {counts.rows > 0 && <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm" data-testid="conversion-pending-banner">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p>{t('monitoring:conversion.banner.text', { rows: rowsText, policies: policiesText })}</p>
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
          <p className="mt-1 text-xs text-muted-foreground">
            {t('monitoring:conversion.banner.confirmBody', { rows: confirmRowsText, policies: confirmPoliciesText })}
          </p>
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
    </div>}
    {!hidden && counts.unconvertible.length > 0 && (
      <div role="status" data-testid="legacy-retirement-banner" className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p>{t('monitoring:conversion.retirement.summary', { count: counts.unconvertible.length })}</p>
          <div className="flex gap-2">
            <button type="button" aria-expanded={open} aria-controls={listId} className="rounded-md border px-3 py-1.5 font-medium hover:bg-muted" onClick={() => setOpenKey(open ? null : key)}>
              {t('monitoring:conversion.retirement.review')}
            </button>
            <button type="button" className="rounded-md border px-3 py-1.5 font-medium hover:bg-muted" onClick={() => { dismiss(key); setDismissedKey(key); }}>
              {t('monitoring:conversion.retirement.dismiss')}
            </button>
          </div>
        </div>
        {open && (
          <div id={listId} className="mt-3">
            <ul className="space-y-2 break-words">
              {counts.unconvertible.map((item) => (
                <li key={`${item.sourceTable}:${item.sourceId}`}>
                  <span className="font-medium">{item.name}</span>
                  {item.policyName ? <span> — {item.policyName}</span> : null}
                  <div className="mt-1">
                    <span>{t([/* i18n-dynamic */ `monitoring:conversion.retirement.reasons.${item.reason.replace(/^unconvertible:/, '')}`, 'monitoring:conversion.retirement.reasons.unknown'])}</span>
                    {' '}<code className="break-all text-xs">{item.reason}</code>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-3">{t('monitoring:conversion.retirement.openAlertsNote')}</p>
          </div>
        )}
      </div>
    )}
    </>
  );
}
