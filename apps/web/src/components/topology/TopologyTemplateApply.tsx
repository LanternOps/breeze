import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { topologyTemplatePreviewSchema, topologyTemplateApplicationSchema } from '@breeze/shared/validators/topologyConfiguration';
import type { TopologyTemplatePreview, TopologyTemplateApplication, TopologyTemplatePreviewRequest } from '@breeze/shared';
import { runAction, ActionError, handleActionError } from '../../lib/runAction';
import { topologyRead } from './topologyApi';
import { topologyConfigurationApi } from './topologyConfigurationApi';
export default function TopologyTemplateApply({ request, canApply, onComplete }: { request: TopologyTemplatePreviewRequest; canApply: boolean; onComplete: () => void }) {
  const { t } = useTranslation('topology');
  const [preview, setPreview] = useState<TopologyTemplatePreview>(), [operation, setOperation] = useState<TopologyTemplateApplication>(), [busy, setBusy] = useState(false), [expired, setExpired] = useState(false);
  const [applyKey, setApplyKey] = useState('');
  const requestKey = JSON.stringify(request);
  const latestRequest = useRef(requestKey); latestRequest.current = requestKey;
  useEffect(() => { setPreview(undefined); setExpired(false); }, [requestKey]);
  // Derived as well as timed: the effect below runs after paint, so without this an
  // already-expired preview renders one frame with Apply enabled.
  const previewExpired = expired || (preview !== undefined && Date.parse(preview.expiresAt) <= Date.now());
  useEffect(() => {
    if (!preview) return; const delay = Date.parse(preview.expiresAt) - Date.now();
    if (delay <= 0) { setExpired(true); return; }
    const timer = setTimeout(() => setExpired(true), delay); return () => clearTimeout(timer);
  }, [preview]);
  useEffect(() => {
    if (!operation || !['queued', 'running'].includes(operation.state)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.hidden) { timer = setTimeout(poll, 5000); return; }
      try {
        const next = await topologyRead(`/topology/template-applications/${operation.id}`, topologyTemplateApplicationSchema, controller.signal);
        if (!controller.signal.aborted) { setOperation(next); if (!['queued', 'running'].includes(next.state)) onComplete(); }
      } catch (cause) { if (!controller.signal.aborted) { handleActionError(cause, t('loadFailed')); timer = setTimeout(poll, 5000); } }
    };
    timer = setTimeout(poll, 2000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [operation]);
  const previewChanges = async () => {
    setBusy(true); const submittedRequest = requestKey;
    try {
      const value = await runAction({ request: () => topologyConfigurationApi.previewResponse(request), errorFallback: t('previewFailed'), successMessage: t('previewReady'), parseSuccess: (data) => topologyTemplatePreviewSchema.parse(data) });
      if (submittedRequest !== latestRequest.current) return;
      setPreview(value); setOperation(undefined); setExpired(false); setApplyKey(crypto.randomUUID());
    } catch (cause) { handleActionError(cause, t('loadFailed'));  }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview || previewExpired || !canApply) return; setBusy(true);
    try {
      const result = await runAction({ request: () => topologyConfigurationApi.applyResponse(preview.token, applyKey), errorFallback: t('applyFailed'), successMessage: t('applyAccepted'), parseSuccess: (data) => topologyTemplateApplicationSchema.parse(data) });
      setOperation(result); if (!['queued', 'running'].includes(result.state)) onComplete();
    } catch (cause) { if (cause instanceof ActionError && cause.code === 'preview_expired') setExpired(true); handleActionError(cause, t('loadFailed'));  }
    finally { setBusy(false); }
  };
  return <div className="space-y-3">
    <button data-testid="topology-template-preview" className="rounded border px-3 py-2" disabled={busy || !canApply} onClick={() => void previewChanges()}>{t('previewChanges')}</button>
    {preview && <div data-testid="topology-template-diff" className="space-y-3 border-t pt-3">
      <h4 className="font-medium">{t('reviewChanges')}</h4>
      <p className="text-sm">{t('previewExpiry', { time: new Date(preview.expiresAt).toLocaleTimeString() })}</p>
      {preview.sites.map((site) => <div key={site.siteId} className="text-sm"><p>{t('site')}: {site.siteId} · {t('revision')}: {site.expectedBindingRevision}</p><ul className="list-inside list-disc">{site.effects.map((effect, index) => <li key={index}>{effect.field}: {effect.action} · {effect.capability}{effect.reason ? ` · ${effect.reason}` : ''}</li>)}</ul>{site.errors.map((error, index) => <p role="alert" className="text-destructive" key={index}>{error.code}{error.field ? `: ${error.field}` : ''}</p>)}</div>)}
      {previewExpired && <p role="alert">{t('previewExpired')}</p>}
      <button data-testid="topology-template-apply" className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={busy || previewExpired || !canApply || preview.sites.some((site) => site.errors.length > 0) || !!operation} onClick={() => void apply()}>{t('applyReviewed')}</button>
    </div>}
    {operation && <div data-testid="topology-template-status" role="status"><p>{operation.state}</p>{operation.sites.map((site) => <p key={site.siteId}>{site.siteId}: {site.state}{site.code ? ` · ${site.code}` : ''}</p>)}</div>}
    <p data-testid="topology-recurring-capability" className="text-sm text-muted-foreground">{t('recurringUnavailable')}</p>
    <button data-testid="topology-enable-recurring" disabled className="rounded border px-3 py-2 opacity-50">{t('enableRecurring')}</button>
  </div>;
}
