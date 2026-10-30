import { useEffect, useReducer, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import {
  CONVERSION_MIN_SHADOW_MS,
  FLEET_MAX_TARGETS,
  type FlowConversionDto,
  type FlowConversionFinding,
  type FlowConversionPreviewDto,
} from '@breeze/shared';
import { ActionError } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import { Dialog } from '../../shared/Dialog';
import {
  conversionErrorMessage,
  conversionErrorToken,
  switchConversion,
  type SwitchConversionResult,
} from './conversionApi';

interface SwitchErrorBody {
  error?: string;
  /** The server's message, shown when the token has no localized copy (these refusals are never toasted). */
  message?: string;
  findings?: FlowConversionFinding[];
  validation?: { issues?: Array<{ code: string; message: string }> };
  missing?: Array<{ stepId: string; permission: string }>;
  stepId?: string;
  reason?: string | null;
}

/** Gate refusals the dialog lets the user acknowledge (plan Decision 3). */
const ACKNOWLEDGEABLE = new Set(['shadow_too_short', 'shadow_divergent']);

function parseMaxTargets(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= 1 && n <= FLEET_MAX_TARGETS ? n : null;
}

/**
 * The switch (#5221 W06, plan Decision 4): every authority the flow gains is
 * accepted affirmatively, nothing is pre-ticked.
 *   - each fleet pre-approval, with its `maxTargets` (1..500), the frozen-device
 *     and live-membership wording, and the per-org multiplication for a
 *     partner-wide Job;
 *   - a widened scope (`site_ceiling_removed`);
 *   - the delegator lifecycle (a deactivated or narrowed switcher pauses the flow);
 *   - each generated script, shown with its body.
 * Switch is never offered before the shadow is 10 minutes old; an unmet
 * evidence gate needs an explicit acknowledgement.
 */
export function SwitchDialog({
  open,
  jobName,
  partnerWide,
  isWebhook,
  conversion,
  preview,
  flowVersion,
  onClose,
  onSwitched,
  onStale,
  now = Date.now,
}: {
  open: boolean;
  jobName: string;
  partnerWide: boolean;
  isWebhook: boolean;
  conversion: FlowConversionDto;
  preview: FlowConversionPreviewDto;
  /** The draft flow's `definitionVersion` (the switch's optimistic-concurrency check). */
  flowVersion: number;
  onClose: () => void;
  onSwitched: (result: SwitchConversionResult) => void;
  /** A 409 (source changed, version conflict): the caller reloads. */
  onStale?: () => void;
  now?: () => number;
}) {
  const { t } = useTranslation('flows');
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [maxTargets, setMaxTargets] = useState<Record<string, string>>({});
  const [acceptScope, setAcceptScope] = useState(false);
  const [acceptDelegator, setAcceptDelegator] = useState(false);
  const [acceptScripts, setAcceptScripts] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<SwitchErrorBody | null>(null);

  const startedAt = Date.parse(conversion.shadow.startedAt);
  const tooNew = !Number.isFinite(startedAt) || now() - startedAt < CONVERSION_MIN_SHADOW_MS;
  // Re-render once the 10-minute floor passes, so an open dialog unlocks by itself.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!tooNew || !Number.isFinite(startedAt)) return;
    const wait = Math.max(0, startedAt + CONVERSION_MIN_SHADOW_MS - now()) + 250;
    const timer = setTimeout(rerender, wait);
    return () => clearTimeout(timer);
  }, [tooNew, startedAt, now]);
  const blockedBy = conversion.switchBlockedBy;
  const needsAck = blockedBy !== null && ACKNOWLEDGEABLE.has(blockedBy);
  const hardBlocked = tooNew || (blockedBy !== null && !needsAck);
  const widensScope = conversion.findings.some((f) => f.code === 'site_ceiling_removed');
  const scripts = preview.generatedScripts;
  const candidates = preview.preApprovalCandidates;

  const preApprovals = candidates
    .filter((c) => approved[c.stepId])
    .map((c) => ({ stepId: c.stepId, maxTargets: parseMaxTargets(maxTargets[c.stepId]) }));
  const preApprovalsValid = preApprovals.every((p) => p.maxTargets !== null);

  const canSubmit =
    !submitting &&
    !hardBlocked &&
    (!needsAck || acknowledge) &&
    (!widensScope || acceptScope) &&
    acceptDelegator &&
    (scripts.length === 0 || acceptScripts) &&
    preApprovalsValid;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    let result: SwitchConversionResult;
    try {
      result = await switchConversion(conversion.id, {
        expectedFlowVersion: flowVersion,
        preApprovals: preApprovals.map((p) => ({ stepId: p.stepId, maxTargets: p.maxTargets as number })),
        acceptScopeWidening: widensScope && acceptScope,
        acceptDelegatorLifecycle: true,
        acknowledgeDivergence: needsAck && acknowledge,
      });
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (err instanceof ActionError) {
        const body = err.body && typeof err.body === 'object' ? (err.body as SwitchErrorBody) : {};
        setError({ ...body, error: conversionErrorToken(err) ?? body.error, message: err.message });
        if (err.status === 409) onStale?.();
      } else {
        showToast({ type: 'error', message: t('conversion.errors.switchFailed') });
      }
      return;
    }
    setSubmitting(false);
    // Outside the try: the switch succeeded, so a caller error is never reported as a failed switch.
    onSwitched(result);
  };

  const errorCode = error?.error;
  const errorText = errorCode === 'MFA_REQUIRED'
    ? t('errors:MFA_REQUIRED')
    : conversionErrorMessage(errorCode) ?? error?.message;

  return (
    <Dialog open={open} onClose={onClose} title={t('conversion.switch.title', { name: jobName })} maxWidth="2xl" className="p-6">
      <div className="max-h-[80vh] space-y-4 overflow-y-auto" data-testid="conversion-switch-dialog">
        <h2 className="text-lg font-semibold">{t('conversion.switch.title', { name: jobName })}</h2>
        <p className="text-sm text-muted-foreground">{t('conversion.switch.body')}</p>

        {tooNew ? (
          <p role="status" className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-sm" data-testid="conversion-switch-too-new">
            {t('conversion.switch.blocked.shadow_too_new')}
          </p>
        ) : blockedBy && !needsAck ? (
          <p role="status" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-sm" data-testid={`conversion-switch-blocked-${blockedBy}`}>
            {t(/* i18n-dynamic */ `conversion.switch.blocked.${blockedBy}`)}
          </p>
        ) : null}

        {!tooNew && needsAck && blockedBy && (
          <label className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
            <input
              type="checkbox"
              data-testid="conversion-switch-acknowledge"
              checked={acknowledge}
              onChange={(e) => setAcknowledge(e.target.checked)}
            />
            <span>
              {t(/* i18n-dynamic */ `conversion.switch.blocked.${blockedBy}`)}{' '}
              <span className="font-medium">{t('conversion.switch.acknowledge')}</span>
            </span>
          </label>
        )}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('conversion.switch.preApprovalsHeading')}</h3>
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="conversion-switch-no-preapprovals">
              {t('conversion.switch.noPreApprovals')}
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{t('conversion.switch.preApprovalsHelp')}</p>
              <ul className="space-y-2">
                {candidates.map((c) => {
                  const on = approved[c.stepId] === true;
                  const raw = maxTargets[c.stepId] ?? '';
                  const invalid = on && parseMaxTargets(raw) === null;
                  return (
                    <li key={c.stepId} className="space-y-1 rounded border p-2 text-sm" data-testid={`conversion-switch-step-${c.stepId}`}>
                      <label className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          data-testid={`conversion-switch-preapprove-${c.stepId}`}
                          checked={on}
                          onChange={(e) => setApproved((prev) => ({ ...prev, [c.stepId]: e.target.checked }))}
                        />
                        <span>
                          {t('conversion.switch.preApprove')} <span className="font-mono">{c.stepId}</span>
                          {c.currentTargetCount !== null && (
                            <span className="block text-xs text-muted-foreground">
                              {t('conversion.switch.currentTargets', { count: c.currentTargetCount })}
                            </span>
                          )}
                        </span>
                      </label>
                      {on && (
                        <div className="space-y-1 pl-6">
                          <label className="flex flex-wrap items-center gap-2 text-xs">
                            <span>{t('conversion.switch.maxTargets', { max: FLEET_MAX_TARGETS })}</span>
                            <input
                              type="number"
                              inputMode="numeric"
                              min={1}
                              max={FLEET_MAX_TARGETS}
                              required
                              aria-invalid={invalid}
                              data-testid={`conversion-switch-maxtargets-${c.stepId}`}
                              value={raw}
                              onChange={(e) => setMaxTargets((prev) => ({ ...prev, [c.stepId]: e.target.value }))}
                              className="h-8 w-24 rounded border bg-background px-2"
                            />
                          </label>
                          {invalid && (
                            <p className="text-xs text-destructive" data-testid={`conversion-switch-maxtargets-invalid-${c.stepId}`}>
                              {t('conversion.switch.maxTargetsInvalid', { max: FLEET_MAX_TARGETS })}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground">{t('conversion.switch.liveMembership')}</p>
                          <p className="text-xs text-muted-foreground">{t('conversion.switch.frozenDevices')}</p>
                          {partnerWide && (
                            <p className="text-xs text-muted-foreground" data-testid="conversion-switch-perorg">
                              {t('conversion.switch.perOrgMultiplies')}
                            </p>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {isWebhook && (
            <p className="text-xs text-muted-foreground" data-testid="conversion-switch-webhook-approval">
              {t('conversion.switch.webhookApprovalEachRun')}
            </p>
          )}
        </section>

        {scripts.length > 0 && (
          <section className="space-y-2" data-testid="conversion-switch-scripts">
            <h3 className="text-sm font-semibold">{t('conversion.switch.generatedScriptsHeading')}</h3>
            <p className="text-xs text-muted-foreground">{t('conversion.switch.generatedScriptsHelp')}</p>
            {scripts.map((s) => (
              <div key={s.stepId} className="rounded border p-2 text-xs">
                <div className="font-medium">
                  {s.name} <span className="text-muted-foreground">({s.language})</span>
                </div>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 font-mono">{s.body}</pre>
              </div>
            ))}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="conversion-switch-accept-scripts"
                checked={acceptScripts}
                onChange={(e) => setAcceptScripts(e.target.checked)}
              />
              <span>{t('conversion.switch.acceptScripts')}</span>
            </label>
          </section>
        )}

        {widensScope && (
          <label className="flex items-start gap-2 rounded border p-2 text-sm" data-testid="conversion-switch-scope">
            <input
              type="checkbox"
              data-testid="conversion-switch-accept-scope"
              checked={acceptScope}
              onChange={(e) => setAcceptScope(e.target.checked)}
            />
            <span>{t('conversion.switch.acceptScopeWidening')}</span>
          </label>
        )}

        {isWebhook && (
          <p className="rounded border p-2 text-sm" data-testid="conversion-switch-webhook">
            {t('conversion.switch.webhookChange')}
          </p>
        )}

        <label className="flex items-start gap-2 rounded border p-2 text-sm" data-testid="conversion-switch-delegator">
          <input
            type="checkbox"
            data-testid="conversion-switch-accept-delegator"
            checked={acceptDelegator}
            onChange={(e) => setAcceptDelegator(e.target.checked)}
          />
          <span>{t('conversion.switch.acceptDelegatorLifecycle')}</span>
        </label>

        {error && (
          <div role="alert" className="space-y-2 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="conversion-switch-error">
            <p data-testid={`conversion-switch-error-${errorCode ?? 'generic'}`}>{errorText ?? t('conversion.errors.switchFailed')}</p>
            {errorCode === 'unconvertible' && (error.findings ?? []).length > 0 && (
              <ul className="list-disc pl-5">
                {(error.findings ?? []).filter((f) => f.severity === 'blocker').map((f, i) => (
                  <li key={`${f.code}:${i}`}>{t(/* i18n-dynamic */ `conversion.finding.${f.code}.title`)}</li>
                ))}
              </ul>
            )}
            {errorCode === 'invalid' && (
              <ul className="list-disc pl-5">
                {(error.validation?.issues ?? []).map((issue, i) => (
                  <li key={`${issue.code}:${i}`}>{issue.message}</li>
                ))}
              </ul>
            )}
            {errorCode === 'permission_missing' && (
              <ul className="list-disc pl-5">
                {(error.missing ?? []).map((m) => (
                  <li key={`${m.stepId}:${m.permission}`}>
                    <span className="font-mono">{m.stepId}</span>: <span className="font-mono">{m.permission}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="rounded border px-3 py-1.5 text-sm" data-testid="conversion-switch-cancel" onClick={onClose}>
            {t('actions.cancel')}
          </button>
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            data-testid="conversion-switch-confirm"
            disabled={!canSubmit}
            onClick={submit}
          >
            {submitting ? t('conversion.switch.switching') : t('conversion.switch.confirm')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
