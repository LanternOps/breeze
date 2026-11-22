import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiAgentOpenCircuitDto } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { handleActionError, runAction } from '@/lib/runAction';
import { badgeClass } from '../../aiAgents/statusBadge';
import { ConfirmDialog } from '../../shared/ConfirmDialog';

/** The reset route's own bound (`reason: z.string().trim().min(3)`). */
const MIN_REASON_LENGTH = 3;

type Props = {
  agentId: string;
  agentName: string;
  /** `undefined` = the server did not report circuits (an older API): render nothing. */
  openCircuits: AiAgentOpenCircuitDto[] | undefined;
  /** The page's selected org, or null on "All organizations". */
  selectedOrgId: string | null;
  onUnauthorized: () => void;
  /** Called after a successful reset so the list reloads. */
  onReset: () => void;
};

/**
 * #12347 — an agent's OPEN circuit breakers, one line per org, each with a
 * Reset.
 *
 * An open circuit refuses every run of this agent in that org until a human
 * resets it. That is by design (agentCircuit.ts: "manual MFA reset only",
 * never automatic), but nothing on the page said a circuit was open, so a
 * tripped agent sat skipping its scheduled runs with no visible sign.
 *
 * Reset calls the EXISTING `POST /ai/agents/:id/circuit/reset` and adds no
 * gate of its own: that route already requires `ai_agents:write`, a session
 * that satisfies the tenant's MFA policy (`requireMfa()`, a 403
 * `MFA_REQUIRED` otherwise), and — because an open circuit covers every site
 * in the org — a caller with no site or device ceiling (`assertAgentWriteAllowed`,
 * a 403 carrying the server's site-ceiling message). This page has no ceiling
 * data and its other write controls are not gated on it, so the button is
 * shown and a refusal is the server's own words in the toast. The route takes
 * no step-up grant, so there is no step-up prompt to show — the MFA refusal is
 * named in the toast instead. The route also requires a reason for its audit
 * row, which is why Reset opens a dialog rather than firing.
 *
 * Always posts the CIRCUIT's org, never the page's selected org: a partner on
 * "All organizations" resets the org it clicked.
 */
export default function AgentCircuitNotice({
  agentId,
  agentName,
  openCircuits,
  selectedOrgId,
  onUnauthorized,
  onReset,
}: Props) {
  const { t } = useTranslation('settings');
  const reasonId = useId();
  const [target, setTarget] = useState<AiAgentOpenCircuitDto | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Same single-fire latch as the page's re-enable (#3705).
  const submittingRef = useRef(false);

  const shown = !openCircuits
    ? []
    : selectedOrgId
      ? openCircuits.filter((circuit) => circuit.orgId === selectedOrgId)
      : openCircuits;
  const targetShown = target !== null && shown.some((circuit) => circuit.orgId === target.orgId);

  // A pending reset whose circuit has left the list (another admin reset it,
  // the page switched org) is dropped, not parked: left in state it would pop
  // the dialog back open, old reason and all, the next time that circuit
  // opened. Never while a request is in flight — that one settles on its own.
  useEffect(() => {
    if (target !== null && !targetShown && !submittingRef.current) {
      setTarget(null);
      setReason('');
    }
  }, [target, targetShown]);

  const close = useCallback(() => {
    if (submittingRef.current) return;
    setTarget(null);
    setReason('');
  }, []);

  const confirmReset = useCallback(async () => {
    if (!target || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    let reset = false;
    try {
      await runAction({
        // Inline thunk: the no-silent-mutations guard is a lexical check.
        request: () => fetchWithAuth(`/ai/agents/${agentId}/circuit/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgId: target.orgId, reason: reason.trim() }),
        }),
        successMessage: t('aiAgentsPage.circuit.toasts.reset'),
        errorFallback: t('aiAgentsPage.circuit.toasts.resetFailed'),
        friendly: (code) => (code === 'MFA_REQUIRED' ? t('aiAgentsPage.circuit.errors.mfaRequired') : undefined),
        onUnauthorized,
      });
      reset = true;
    } catch (err) {
      handleActionError(err, t('aiAgentsPage.circuit.toasts.resetFailed'));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
    if (reset) {
      setTarget(null);
      setReason('');
      onReset();
    }
  }, [agentId, onReset, onUnauthorized, reason, t, target]);

  if (shown.length === 0) return null;

  return (
    <>
      <ul className="mt-2 space-y-1.5" data-testid={`ai-agent-circuits-${agentId}`}>
        {shown.map((circuit) => (
          <li
            key={circuit.orgId}
            className="flex flex-wrap items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs"
            data-testid={`ai-agent-circuit-open-${agentId}-${circuit.orgId}`}
          >
            <span className={badgeClass('danger', { size: 'sm' })}>{t('aiAgentsPage.circuit.badge')}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-foreground">
                {circuit.openedAt
                  ? t('aiAgentsPage.circuit.openedSince', { org: circuit.orgName, at: formatDateTime(circuit.openedAt) })
                  : t('aiAgentsPage.circuit.opened', { org: circuit.orgName })}
              </span>
              {circuit.openedReason && (
                <span className="block text-muted-foreground">
                  {t('aiAgentsPage.circuit.reason', { reason: circuit.openedReason })}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => { setReason(''); setTarget(circuit); }}
              className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
              data-testid={`ai-agent-circuit-reset-${agentId}-${circuit.orgId}`}
            >
              {t('aiAgentsPage.circuit.reset')}
            </button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={targetShown}
        onClose={close}
        onConfirm={() => void confirmReset()}
        title={t('aiAgentsPage.circuit.dialog.title')}
        message={t('aiAgentsPage.circuit.dialog.message', { agent: agentName, org: target?.orgName ?? '' })}
        confirmLabel={t('aiAgentsPage.circuit.dialog.confirm')}
        variant="warning"
        isLoading={submitting}
        confirmDisabled={reason.trim().length < MIN_REASON_LENGTH}
        confirmTestId="ai-agent-circuit-reset-confirm"
        dialogTestId="ai-agent-circuit-reset-dialog"
      >
        <label htmlFor={reasonId} className="block text-sm font-medium text-foreground">
          {t('aiAgentsPage.circuit.dialog.reasonLabel')}
        </label>
        <textarea
          id={reasonId}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={1000}
          rows={3}
          placeholder={t('aiAgentsPage.circuit.dialog.reasonPlaceholder')}
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          data-testid="ai-agent-circuit-reset-reason"
        />
      </ConfirmDialog>
    </>
  );
}
