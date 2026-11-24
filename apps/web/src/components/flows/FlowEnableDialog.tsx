import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowDetailDto, FlowValidationResult } from '@breeze/shared';
import { ActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { Dialog } from '../shared/Dialog';
import { enableFlow, type EnableFlowResult } from './api';
import { FleetMaxTargetsField, parseFleetMaxTargets } from './FleetMaxTargetsField';

interface EnableErrorBody {
  error?: string;
  validation?: { issues?: Array<{ code: string; message: string; severity?: string }> };
  missing?: Array<{ stepId: string; permission: string }>;
  stepId?: string;
  reason?: string;
}

/** Plain-message error codes: each maps to one localized sentence. */
const SIMPLE_ERRORS: Record<string, string> = {
  version_conflict: 'enable.versionConflict',
  already_enabled: 'enable.alreadyEnabled',
  event_dispatch_not_durable: 'enable.eventNotDurable',
  foreach_concurrency_not_available: 'enable.foreachConcurrencyNotAvailable',
  delegation_scope_restricted: 'enable.delegationScopeRestricted',
  partner_wide_forbidden: 'enable.partnerWideForbidden',
  interactive_session_required: 'enable.interactiveRequired',
  slug_unavailable: 'enable.slugUnavailable',
  webhook_secret_missing: 'enable.webhookSecretMissing',
  ai_budget_unavailable: 'enable.aiBudgetUnavailable',
  flow_conversion_not_switched: 'enable.conversionNotSwitched',
  flow_not_found: 'errors.notFound',
  MFA_REQUIRED: 'errors:MFA_REQUIRED',
};

/** The fleet lane (W6): a pre-approval of this tool also needs the user's `maxTargets`. */
const FLEET_TOOL = 'run_script_on_targets';

function readBody(err: ActionError): EnableErrorBody {
  const body = err.body;
  const parsed = body && typeof body === 'object' ? (body as EnableErrorBody) : {};
  // MFA_REQUIRED rides `code`; its `error` is prose ("MFA required").
  if (err.code === 'MFA_REQUIRED') return { ...parsed, error: 'MFA_REQUIRED' };
  // version_conflict arrives as a 409 whose code may only be on the error.
  if (!parsed.error && err.code) return { ...parsed, error: err.code };
  return parsed;
}

export function FlowEnableDialog({
  open,
  flow,
  validation,
  onClose,
  onEnabled,
  onStale,
}: {
  open: boolean;
  flow: FlowDetailDto;
  validation: FlowValidationResult;
  onClose: () => void;
  /** Receives the enable result: `webhookSecretInvalidated` must be shown (#10270). */
  onEnabled: (result: EnableFlowResult) => void;
  /** Called on a 409 (version conflict / already enabled) so the caller can reload the flow. */
  onStale?: () => void;
}) {
  const { t } = useTranslation('flows');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [maxTargets, setMaxTargets] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<EnableErrorBody | null>(null);

  const tier3 = validation.steps.filter((s) => s.tier === 3);
  const eligibility = flow.preApprovalEligibility ?? {};
  // A webhook run never honours a pre-approval (Flows spec §6.5), so a webhook
  // flow offers none and sends none.
  const isWebhook = flow.definition.trigger.type === 'webhook';
  const partnerWide = flow.ownerScope === 'partner';

  // The one list both the payload and the Confirm gate are computed from: a
  // tick on a step that is not (or no longer) eligible authorizes nothing.
  const preApproved = isWebhook
    ? []
    : tier3
        .filter((s) => checked.has(s.id) && eligibility[s.id]?.eligible === true)
        .map((s) => ({
          id: s.id,
          maxTargets: s.tool === FLEET_TOOL ? parseFleetMaxTargets(maxTargets[s.id]) : undefined,
        }));
  const fleetPreApproved = preApproved.filter((p) => p.maxTargets !== undefined);
  const preApprovalsValid = fleetPreApproved.every((p) => p.maxTargets !== null);
  const canSubmit = !submitting && preApprovalsValid;

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const preApprovedStepIds = preApproved.map((p) => p.id);
      // canSubmit guarantees every entry parsed; the guard keeps the compiler checking it.
      const fleetMaxTargets = Object.fromEntries(
        fleetPreApproved.flatMap((p) => (typeof p.maxTargets === 'number' ? [[p.id, p.maxTargets] as const] : [])),
      );
      const result = await enableFlow(flow.id, {
        expectedVersion: flow.definitionVersion,
        preApprovedStepIds,
        ...(fleetPreApproved.length > 0 ? { fleetMaxTargets } : {}),
      });
      onEnabled(result);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (err instanceof ActionError) {
        // 422 is not toasted by enableFlow, so render it inline. Any other status
        // was already toasted by runAction; still surface a known code inline.
        setError(readBody(err));
        if (err.status === 409) onStale?.();
      } else {
        showToast({ type: 'error', message: t('enable.generic') });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const errorCode = error?.error;
  const simpleKey = errorCode ? SIMPLE_ERRORS[errorCode] : undefined;

  return (
    <Dialog open={open} onClose={onClose} title={t('enable.title')} maxWidth="lg" className="p-6">
      <div className="space-y-4" data-testid="flow-enable-dialog">
        <h2 className="text-lg font-semibold">{t('enable.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('enable.body')}</p>

        {flow.definition.trigger.type === 'event' && (
          <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-sm" data-testid="flow-enable-event-scope">
            {t('enable.eventScope')}
          </p>
        )}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('enable.tier3Heading')}</h3>
          {tier3.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="flow-enable-no-tier3">{t('enable.noTier3')}</p>
          ) : isWebhook ? (
            <>
              <p className="text-sm text-muted-foreground" data-testid="flow-enable-webhook-no-preapproval">
                {t('conversion.switch.webhookApprovalEachRun')}
              </p>
              <ul className="space-y-2">
                {tier3.map((step) => (
                  <li key={step.id} className="rounded border p-2 text-sm" data-testid={`flow-enable-step-${step.id}`}>
                    <span className="font-mono">{step.id}</span>{' '}
                    <span className="text-muted-foreground">{step.tool}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <ul className="space-y-2">
              {tier3.map((step) => {
                const el = eligibility[step.id];
                const eligible = el?.eligible === true;
                const reason = el && !el.eligible ? el.reason : 'not_tier3';
                const ticked = eligible && checked.has(step.id);
                return (
                  <li key={step.id} className="rounded border p-2 text-sm" data-testid={`flow-enable-step-${step.id}`}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        data-testid={`flow-enable-preapprove-${step.id}`}
                        disabled={!eligible || submitting}
                        checked={ticked}
                        onChange={() => toggle(step.id)}
                      />
                      <span>
                        <span className="font-mono">{step.id}</span>{' '}
                        <span className="text-muted-foreground">{step.tool}</span>
                        <span className="block text-xs">{t('enable.preApprove')}</span>
                      </span>
                    </label>
                    {ticked && step.tool === FLEET_TOOL && (
                      <FleetMaxTargetsField
                        stepId={step.id}
                        value={maxTargets[step.id] ?? ''}
                        onChange={(v) => setMaxTargets((prev) => ({ ...prev, [step.id]: v }))}
                        partnerWide={partnerWide}
                        testIdPrefix="flow-enable-maxtargets"
                        perOrgTestId={`flow-enable-perorg-${step.id}`}
                      />
                    )}
                    {eligible ? (
                      <p className="mt-1 text-xs text-muted-foreground">{t('enable.preApproveHelp')}</p>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground" data-testid={`flow-enable-notEligible-${step.id}`}>
                        {t(/* i18n-dynamic */ `enable.notEligible.${reason}`)}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {error && (
          <div role="alert" className="space-y-2 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="flow-enable-error">
            {errorCode === 'permission_missing' && (
              <div data-testid="flow-enable-missing">
                <p>{t('enable.missingPermissions')}</p>
                <ul className="list-disc pl-5">
                  {(error.missing ?? []).map((m) => (
                    <li key={`${m.stepId}:${m.permission}`}>
                      <span className="font-mono">{m.stepId}</span>: <span className="font-mono">{m.permission}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {errorCode === 'invalid' && (
              <div data-testid="flow-enable-validation">
                <p>{t('enable.validationFailed')}</p>
                <ul className="list-disc pl-5">
                  {(error.validation?.issues ?? []).map((issue, i) => (
                    <li key={`${issue.code}:${i}`}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            )}
            {errorCode === 'pre_approval_not_eligible' && (
              <p data-testid="flow-enable-error-pre_approval_not_eligible">
                {t('enable.preApprovalNotEligible', {
                  stepId: error.stepId ?? '',
                  reason: error.reason ? t(/* i18n-dynamic */ `enable.notEligible.${error.reason}`) : '',
                })}
              </p>
            )}
            {simpleKey && errorCode && (
              <p data-testid={`flow-enable-error-${errorCode}`}>{t(/* i18n-dynamic */ simpleKey)}</p>
            )}
            {!simpleKey &&
              errorCode !== 'permission_missing' &&
              errorCode !== 'invalid' &&
              errorCode !== 'pre_approval_not_eligible' && (
                <p data-testid="flow-enable-error-generic">{t('enable.generic')}</p>
              )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="rounded border px-3 py-1.5 text-sm" data-testid="flow-enable-cancel" onClick={onClose}>
            {t('actions.cancel')}
          </button>
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            data-testid="flow-enable-confirm"
            disabled={!canSubmit}
            onClick={submit}
          >
            {t('enable.confirm')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
