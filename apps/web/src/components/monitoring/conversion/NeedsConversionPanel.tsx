import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import {
  conversionPaths, convertBody, fetchPolicyPreview, readConvertResult, readRetireResult, retireBody,
  type ConversionPreviewItem, type ConvertResult, type PolicyConversionPreview, type PreviewProgress,
} from './conversionApi';

export interface NeedsConversionPanelProps {
  policyId: string;
  /** False when the policy has no legacy link — nothing renders and nothing is fetched. */
  hasLegacyRows: boolean;
  /** Fired after a successful convert or retirement so the tab reloads its links. */
  onChanged: () => void;
}

type Load = { status: 'idle' | 'loading' | 'ready' | 'error'; error?: string };

export default function NeedsConversionPanel({ policyId, hasLegacyRows, onChanged }: NeedsConversionPanelProps) {
  const { t } = useTranslation(['monitoring', 'common']);
  const [preview, setPreview] = useState<PolicyConversionPreview | null>(null);
  const [load, setLoad] = useState<Load>({ status: 'idle' });
  const [busy, setBusy] = useState<string | null>(null);
  const activePreview = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<PreviewProgress | null>(null);

  const reload = useCallback(async () => {
    activePreview.current?.abort();
    const controller = new AbortController();
    activePreview.current = controller;
    setPreview(null);
    setProgress(null);
    setLoad({ status: 'loading' });
    try {
      const next = await fetchPolicyPreview(policyId, {
        signal: controller.signal,
        onProgress: (value) => { if (!controller.signal.aborted) setProgress(value); },
      });
      if (!controller.signal.aborted) {
        setPreview(next);
        setLoad({ status: 'ready' });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setLoad({ status: 'error', error: err instanceof Error ? err.message : t('monitoring:conversion.errors.preview') });
      }
    }
  }, [policyId, t]);

  useEffect(() => {
    if (hasLegacyRows) void reload();
    return () => activePreview.current?.abort();
  }, [hasLegacyRows, reload]);

  const handleActionFailure = (err: unknown, fallback: string) => {
    if (err instanceof ActionError && err.status === 401) return;
    if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
    // A stale previewHash (409) or any refused write means the preview moved: re-read it.
    void reload();
  };

  // #6444: the equivalence proof covers the full set, so never submit a subset.
  const convert = async () => {
    if (!canConvert || convertible.length === 0 || !preview) return;
    setBusy('all');
    try {
      const result = await runAction<ConvertResult>({
        request: () => fetchWithAuth(conversionPaths.convert(policyId), {
          method: 'POST',
          body: JSON.stringify(convertBody(preview.previewHash)),
        }),
        parseSuccess: readConvertResult,
        errorFallback: t('monitoring:conversion.errors.convert'),
      });
      showToast({
        type: 'success',
        message: t('monitoring:conversion.converted', { rows: result.retired, monitors: result.monitorsCreated }),
      });
      onChanged();
      await reload();
    } catch (err) {
      handleActionFailure(err, t('monitoring:conversion.errors.convert'));
    } finally {
      setBusy(null);
    }
  };

  const retire = async (item: ConversionPreviewItem) => {
    setBusy(item.sourceId);
    try {
      await runAction<{ conversionId: string }>({
        request: () => fetchWithAuth(conversionPaths.retire(), {
          method: 'POST',
          body: JSON.stringify(retireBody(item.sourceTable, item.sourceId, item.reason?.startsWith('unconvertible:') ? item.reason as `unconvertible:${string}` : 'operator')),
        }),
        parseSuccess: readRetireResult,
        errorFallback: t('monitoring:conversion.errors.retire'),
        successMessage: t('monitoring:conversion.retired', { name: item.name }),
      });
      onChanged();
      await reload();
    } catch (err) {
      handleActionFailure(err, t('monitoring:conversion.errors.retire'));
    } finally {
      setBusy(null);
    }
  };

  if (!hasLegacyRows) return null;
  if (load.status === 'ready' && preview && !preview.blockedBy && preview.items.length === 0) return null;

  const deltas = preview?.equivalence.deltas ?? [];
  const blocked = preview?.blockedBy;
  const canConvert = load.status === 'ready' && !!preview && !blocked && deltas.length === 0 && busy === null;
  const convertible = (preview?.items ?? []).filter((it) => it.outcome === 'convertible');
  const reasonKey = (reason?: string) => `monitoring:conversion.reasons.${(reason ?? '').replace(/^unconvertible:/, '') || 'unknown'}`;

  return (
    <section className="rounded-md border border-warning/40 bg-warning/5 p-4" data-testid="needs-conversion-panel">
      <h3 className="text-sm font-semibold">{t('monitoring:conversion.title')}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t('monitoring:conversion.description')}</p>

      {load.status === 'loading' && <p className="mt-3 text-sm" data-testid="conversion-loading">{t('monitoring:conversion.checking')}{' '}{progress && <progress value={progress.checked} max={Math.max(1, progress.total)} aria-label={t('monitoring:conversion.checking')} data-testid="conversion-progress" />}</p>}
      {load.status === 'error' && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {load.error}
          <button type="button" className="ml-2 underline" onClick={() => void reload()}>{t('common:actions.retry')}</button>
        </div>
      )}

      {preview && (
        <>
          <p className="mt-2 text-xs text-muted-foreground">
            {t('monitoring:conversion.devicesChecked', { count: preview.equivalence.devicesChecked })}
          </p>
          {blocked && (
            <div className="mt-3 rounded-md border px-3 py-2 text-sm" data-testid="conversion-blocked">
              {t(/* i18n-dynamic */ `monitoring:conversion.blocked.${blocked}`)}
            </div>
          )}
          {deltas.length > 0 && (
            <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" data-testid="conversion-deltas">
              <p className="font-medium">{t('monitoring:conversion.refusedTitle', { count: deltas.length })}</p>
              <ul className="mt-1 list-disc pl-4 text-xs">
                {deltas.map((d) => <li key={`${d.deviceId}:${d.detail}`}>{d.deviceId}: {d.detail}</li>)}
              </ul>
            </div>
          )}

          <ul className="mt-3 space-y-2">
            {preview.items.map((item) => (
              <li key={`${item.sourceTable}:${item.sourceId}`} data-testid={`conversion-item-${item.sourceId}`} className="rounded-md border bg-background px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t(/* i18n-dynamic */ `monitoring:conversion.sourceTables.${item.sourceTable}`)}
                      {' · '}
                      {t(/* i18n-dynamic */ `monitoring:conversion.outcomes.${item.outcome}`)}
                      {item.openAlerts > 0 && <> · {t('monitoring:conversion.openAlerts', { count: item.openAlerts })}</>}
                    </p>
                  </div>
                  {item.outcome === 'unconvertible' && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        data-testid={`conversion-retire-${item.sourceId}`}
                        disabled={busy !== null}
                        onClick={() => void retire(item)}
                        className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
                      >
                        {t('monitoring:conversion.retire')}
                      </button>
                    </div>
                  )}
                </div>
                {item.outcome === 'unconvertible' && (
                  <p className="mt-1 text-xs text-destructive">{t(/* i18n-dynamic */ [reasonKey(item.reason), 'monitoring:conversion.reasons.unknown'], { code: item.reason ?? '' })}</p>
                )}
                {item.notes.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                    {item.notes.map((n) => <li key={n}>{n}</li>)}
                  </ul>
                )}
                {item.proposed.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {item.proposed.map((p) => (
                      <li key={`${p.role}:${p.name}`} data-testid={`conversion-proposed-${item.sourceId}-${p.role}`} className="rounded-full border px-2 py-0.5 text-xs">
                        <span className="font-medium">{t(/* i18n-dynamic */ `monitoring:conversion.roles.${p.role}`)}</span>{' '}
                        {p.name} · {p.kind} · {t(/* i18n-dynamic */ `monitoring:severities.${p.severity}`, { defaultValue: p.severity })}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-3 flex justify-end">
            <button
              type="button"
              data-testid="conversion-convert-all"
              disabled={!canConvert || convertible.length === 0}
              onClick={() => void convert()}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {t('monitoring:conversion.convertAll', { count: convertible.length })}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
