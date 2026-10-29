import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type {
  FlowConversionDto,
  FlowConversionFinding,
  FlowConversionFindingSeverity,
  FlowConversionPreviewDto,
  FlowDetailDto,
  FlowValidationResult,
} from '@breeze/shared';
import { ActionError } from '@/lib/runAction';
import { resolvedFormattingLocale } from '@/lib/i18n/format';
import { showToast } from '../../shared/Toast';
import { Dialog } from '../../shared/Dialog';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { FlowStepList } from '../../flows/FlowStepList';
import { getFlow } from '../../flows/api';
import { FidelityBadge } from './FidelityBadge';
import { SwitchDialog } from './SwitchDialog';
import {
  createConversion,
  getConversion,
  previewConversion,
  revertConversion,
  type SwitchConversionResult,
} from './conversionApi';

export const CONVERT_HASH_PREFIX = 'convert-';

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(resolvedFormattingLocale());
}

/** `#convert-<automationId>` → the automation id; anything else does not apply. */
export function parseConvertHash(hash: string): string | null | undefined {
  return hash.startsWith(CONVERT_HASH_PREFIX) ? hash.slice(CONVERT_HASH_PREFIX.length) || undefined : undefined;
}

export interface ConversionPanelJob {
  id: string;
  name: string;
  /** null = partner-wide. */
  orgId?: string | null;
  triggerType: string;
}

const SEVERITY_ORDER: FlowConversionFindingSeverity[] = ['blocker', 'review', 'info'];
const SEVERITY_TONE: Record<FlowConversionFindingSeverity, string> = {
  blocker: 'border-destructive/40',
  review: 'border-amber-500/40',
  info: 'border-border',
};

function FindingList({ findings }: { findings: readonly FlowConversionFinding[] }) {
  const { t } = useTranslation('flows');
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground" data-testid="conversion-no-findings">{t('conversion.noFindings')}</p>;
  }
  return (
    <ul className="space-y-2" data-testid="conversion-findings">
      {sorted.map((f, i) => (
        <li
          key={`${f.code}:${f.actionIndex ?? 'job'}:${i}`}
          data-testid={`conversion-finding-${f.code}`}
          className={`rounded border-l-4 border bg-card p-2 text-sm ${SEVERITY_TONE[f.severity]}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase text-muted-foreground">
              {t(/* i18n-dynamic */ `conversion.severity.${f.severity}`)}
            </span>
            <span className="font-medium">{t(/* i18n-dynamic */ `conversion.finding.${f.code}.title`)}</span>
            {f.actionIndex !== null && (
              <span className="text-xs text-muted-foreground">{t('conversion.actionNumber', { n: f.actionIndex + 1 })}</span>
            )}
          </div>
          <p className="text-muted-foreground">{t(/* i18n-dynamic */ `conversion.finding.${f.code}.line`)}</p>
        </li>
      ))}
    </ul>
  );
}

function ShadowSummary({ conversion }: { conversion: FlowConversionDto }) {
  const { t } = useTranslation('flows');
  const { shadow } = conversion;
  return (
    <section className="space-y-1 rounded border p-3 text-sm" data-testid="conversion-shadow">
      <h3 className="font-semibold">{t('conversion.shadow.heading')}</h3>
      <p className="text-muted-foreground">{t('conversion.shadow.explain')}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">{t('conversion.shadow.runs')}</dt>
          <dd data-testid="conversion-shadow-runs">{shadow.runs}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('conversion.shadow.divergences')}</dt>
          <dd data-testid="conversion-shadow-divergences">{shadow.divergences}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('conversion.shadow.startedAt')}</dt>
          <dd>{formatDateTime(shadow.startedAt)}</dd>
        </div>
      </dl>
      {shadow.lastDivergence && (
        <p className="text-xs" data-testid="conversion-shadow-last-divergence">
          {t(/* i18n-dynamic */ `conversion.shadow.divergence.${shadow.lastDivergence.kind}`)}{' '}
          <span className="text-muted-foreground">({formatDateTime(shadow.lastDivergence.at)})</span>
        </p>
      )}
      {conversion.switchBlockedBy && (
        <p className="text-xs text-muted-foreground" data-testid={`conversion-gate-${conversion.switchBlockedBy}`}>
          {t(/* i18n-dynamic */ `conversion.switch.blocked.${conversion.switchBlockedBy}`)}
        </p>
      )}
    </section>
  );
}

/**
 * The per-Job "Move to Flows" panel (#5221 W06, plan Decision 10), opened by
 * `#convert-<automationId>`: fidelity and findings from a fresh preview, the
 * converted steps, the shadow counters, and Start shadow / Switch / Revert.
 * Actions render only with `automations.write` (`canWrite`); the server
 * re-checks permission, MFA and an interactive session on every write.
 */
export function ConversionPanel({
  job,
  conversionId,
  canWrite,
  onClose,
  onChanged,
}: {
  job: ConversionPanelJob;
  /** The Job's latest conversion generation, from the list summary; null when never converted. */
  conversionId: string | null;
  canWrite: boolean;
  onClose: () => void;
  /** A conversion was created, switched or reverted: the caller reloads its list. */
  onChanged: () => void;
}) {
  const { t } = useTranslation('flows');
  const [preview, setPreview] = useState<FlowConversionPreviewDto | null>(null);
  const [conversion, setConversion] = useState<FlowConversionDto | null>(null);
  const [flow, setFlow] = useState<{ flow: FlowDetailDto; validation: FlowValidationResult } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The flow is secondary: if it fails to load, findings and Revert stay usable.
  const [flowUnavailable, setFlowUnavailable] = useState(false);
  // Overlapping loads (an explicit reload plus the effect on a new conversionId):
  // only the latest one may write state.
  const loadSeq = useRef(0);
  const [busy, setBusy] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [revertOpen, setRevertOpen] = useState(false);

  const load = useCallback(async (id: string | null) => {
    const mine = ++loadSeq.current;
    const current = () => mine === loadSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [p, c] = await Promise.all([
        previewConversion(job.id),
        id ? getConversion(id) : Promise.resolve(null),
      ]);
      if (!current()) return;
      let f: { flow: FlowDetailDto; validation: FlowValidationResult } | null = null;
      let unavailable = false;
      if (c && c.state !== 'reverted') {
        try {
          f = await getFlow(c.flowId);
        } catch (err) {
          console.warn('[ConversionPanel] could not load the flow', err);
          unavailable = true;
        }
      }
      if (!current()) return;
      setPreview(p);
      setConversion(c);
      setFlow(f);
      setFlowUnavailable(unavailable);
    } catch (err) {
      if (current()) setLoadError(err instanceof Error ? err.message : t('conversion.errors.loadFailed'));
    } finally {
      if (current()) setLoading(false);
    }
  }, [job.id, t]);

  useEffect(() => {
    void load(conversionId);
  }, [load, conversionId]);

  const live = conversion && conversion.state !== 'reverted' ? conversion : null;
  const fidelity = live?.fidelity ?? preview?.fidelity;
  const findings = live?.findings ?? preview?.findings ?? [];
  const steps = flow?.flow.definition.steps ?? preview?.document?.steps ?? [];
  const summaries = flow?.validation.steps ?? [];

  const startShadow = async () => {
    if (!preview || busy) return;
    setBusy(true);
    try {
      const created = await createConversion(job.id, preview.sourceDigest);
      onChanged();
      await load(created.id);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('conversion.errors.createFailed') });
      } else if (err.status === 409) {
        // conversion_exists names the live generation; source_changed has none — reload the preview.
        const existing = err.body && typeof err.body === 'object' ? (err.body as { conversionId?: unknown }).conversionId : undefined;
        if (typeof existing === 'string') onChanged();
        await load(typeof existing === 'string' ? existing : conversion?.id ?? null);
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmRevert = async () => {
    if (!live || busy) return;
    setBusy(true);
    try {
      await revertConversion(live.id);
      setRevertOpen(false);
      onChanged();
      await load(live.id);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('conversion.errors.revertFailed') });
    } finally {
      setBusy(false);
    }
  };

  const onSwitched = (result: SwitchConversionResult) => {
    setSwitchOpen(false);
    setConversion(result.conversion);
    onChanged();
    void load(result.conversion.id);
  };

  return (
    <Dialog open onClose={onClose} title={t('conversion.panel.title', { name: job.name })} maxWidth="3xl" className="p-6">
      <div className="max-h-[85vh] space-y-4 overflow-y-auto" data-testid="conversion-panel" data-automation-id={job.id}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{t('conversion.panel.title', { name: job.name })}</h2>
            <p className="text-sm text-muted-foreground">{t('conversion.panel.subtitle')}</p>
          </div>
          <button type="button" className="rounded border px-3 py-1.5 text-sm" data-testid="conversion-panel-close" onClick={onClose}>
            {t('conversion.panel.close')}
          </button>
        </div>

        {loading && !preview ? (
          <p className="text-sm text-muted-foreground" data-testid="conversion-panel-loading">{t('conversion.panel.loading')}</p>
        ) : loadError ? (
          <div role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="conversion-panel-error">
            {loadError}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {fidelity && <FidelityBadge fidelity={fidelity} findings={findings} />}
              {conversion && (
                <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium" data-testid="conversion-state">
                  {t(/* i18n-dynamic */ `conversion.state.${conversion.state}`)}
                </span>
              )}
              {live && (
                <a href={`/flows/${live.flowId}`} className="text-sm text-primary hover:underline" data-testid="conversion-flow-link">
                  {t('conversion.panel.openFlow')}
                </a>
              )}
            </div>

            {flowUnavailable && (
              <p role="status" className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-sm" data-testid="conversion-flow-unavailable">
                {t('conversion.panel.flowUnavailable')}
              </p>
            )}

            {live?.state === 'switched' && (
              <p className="rounded border p-2 text-sm" data-testid="conversion-switched-note">
                {t('conversion.panel.switchedNote')}
              </p>
            )}

            {live?.state === 'shadow' && <ShadowSummary conversion={live} />}

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{t('conversion.panel.findingsHeading')}</h3>
              <FindingList findings={findings} />
            </section>

            {steps.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">{t('conversion.panel.stepsHeading')}</h3>
                <FlowStepList steps={steps} summaries={summaries} compact />
              </section>
            )}

            {canWrite && (
              <div className="flex flex-wrap justify-end gap-2" data-testid="conversion-actions">
                {!live && fidelity !== 'unconvertible' && (
                  <button
                    type="button"
                    data-testid="conversion-start-shadow"
                    disabled={busy || !preview}
                    onClick={startShadow}
                    className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
                  >
                    {t('conversion.panel.startShadow')}
                  </button>
                )}
                {live?.state === 'shadow' && flow && (
                  <button
                    type="button"
                    data-testid="conversion-open-switch"
                    disabled={busy}
                    onClick={() => setSwitchOpen(true)}
                    className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
                  >
                    {t('conversion.panel.switch')}
                  </button>
                )}
                {live?.state === 'switched' && (
                  <button
                    type="button"
                    data-testid="conversion-open-revert"
                    disabled={busy}
                    onClick={() => setRevertOpen(true)}
                    className="rounded border px-3 py-1.5 text-sm disabled:opacity-50"
                  >
                    {t('conversion.revert.action')}
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {switchOpen && live && preview && flow && (
          <SwitchDialog
            open
            jobName={job.name}
            partnerWide={job.orgId === null}
            isWebhook={job.triggerType === 'webhook'}
            conversion={live}
            preview={preview}
            flowVersion={flow.flow.definitionVersion}
            onClose={() => setSwitchOpen(false)}
            onSwitched={onSwitched}
            onStale={() => void load(live.id)}
          />
        )}

        <ConfirmDialog
          open={revertOpen}
          onClose={() => setRevertOpen(false)}
          onConfirm={confirmRevert}
          title={t('conversion.revert.title', { name: job.name })}
          message={t('conversion.revert.body')}
          confirmLabel={t('conversion.revert.confirm')}
          variant="warning"
          isLoading={busy}
          confirmTestId="conversion-revert-confirm"
        />
      </div>
    </Dialog>
  );
}
