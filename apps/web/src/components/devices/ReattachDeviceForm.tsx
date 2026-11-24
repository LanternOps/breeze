import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Clock } from 'lucide-react';
import { useReauthTier } from '../../lib/reauthTier';
import { mintStepUpGrant, StepUpMintError } from '../../lib/mfaStepUp';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { formatDateTime } from '@/lib/dateTimeFormat';
import {
  canonicalDeviceReattachResource,
  confirmTargetNameMatches,
  deviceReattachRequestBody,
  isKnownReattachRefusal,
  reattachPath,
  type ReattachCandidate,
  type ReattachRequestedIntent,
  type ReinstallCandidatesView,
} from '../../lib/deviceReattach';
import '../../lib/i18n';

export interface ReattachDeviceFormProps {
  /** The new install (the source row, which the reattach retires). */
  source: ReinstallCandidatesView['source'];
  /** The existing record the new install takes over. */
  candidate: ReattachCandidate;
  /** Known factor counts skip the discovery reads; tests pass them. */
  passkeyCount?: number;
  mfaMethod?: string | null;
  /** Whether an authenticator app is enrolled (`GET /users/me`), as primary or backup. */
  totpEnrolled?: boolean;
  /** Back out without requesting (also closes the pending view). */
  onClose: () => void;
  /** The server accepted the request (202): the parent refreshes what it shows. */
  onRequested: (intent: ReattachRequestedIntent) => void;
  /** The target re-enrolled or changed since it was shown: the parent re-reads the candidates. */
  onTargetChanged?: () => void;
  /**
   * Any 409 refusal: the rows changed under the dialog (a removed target, an
   * OS change, liveness). The parent re-reads the candidates so the form can
   * show the confirmation the current rows need without a reload.
   */
  onConflict?: (code: string | undefined) => void;
  /** The form is submitting or waiting for the second factor: the parent locks its own choices. */
  onBusyChange?: (busy: boolean) => void;
}

/**
 * How long a minted grant is reused for. The server keeps a `device_reattach`
 * grant 300 s (services/mfaStepUpGrant.ts TTL_SECONDS); a margin keeps the
 * dialog from sending one that expires in flight.
 */
const HELD_GRANT_MS = 270_000;

interface HeldGrant {
  grantId: string;
  /** The bound resource it was minted for, serialised: any change drops it. */
  key: string;
  mintedAt: number;
}

type Phase = 'form' | 'stepUp' | 'pending';

const STEP_UP_REQUIRED = 'STEP_UP_REQUIRED';

/**
 * The reattach request of #8318 §8, shared by the holding-area assign dialog
 * and the possible-replacement banner.
 *
 * It shows the two rows side by side and the evidence as it is: identifiers
 * the device reported, not verified. It asks for what the server checks: the
 * possession confirmation, the existing record's name typed for `hint`
 * evidence, the OS change acknowledged when the two installs differ, and the
 * restore made explicit for a removed record.
 *
 * Server-driven step-up, the AssignParkedDeviceDialog contract: the first
 * submit carries no grant. The server answers 403 STEP_UP_REQUIRED only after
 * every other refusal, so a refusal never asks for a factor first. Then the
 * `device_reattach` grant is minted for exactly the pair, the target version,
 * the evidence level and the restore choice shown, and spent by the retry.
 * With two-factor authentication off the first submit is accepted.
 *
 * A 202 is not the end: the new install's agent stages and confirms the
 * rebind on its own (§6), so the form says the request is pending.
 */
export default function ReattachDeviceForm({
  source,
  candidate,
  passkeyCount,
  mfaMethod,
  totpEnrolled,
  onClose,
  onRequested,
  onTargetChanged,
  onConflict,
  onBusyChange,
}: ReattachDeviceFormProps) {
  const { t } = useTranslation('devices');

  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const [possessionConfirmed, setPossessionConfirmed] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [acknowledgeOsChange, setAcknowledgeOsChange] = useState(false);
  const [restoreDecommissioned, setRestoreDecommissioned] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [intent, setIntent] = useState<ReattachRequestedIntent | null>(null);
  // A grant minted and not yet consumed: a refusal before the consume (a 409
  // such as liveness_unknown) leaves it spendable, and the TOTP code it was
  // minted with cannot be used twice, so the retry reuses it.
  const [heldGrant, setHeldGrant] = useState<HeldGrant | null>(null);
  // Bumped whenever the candidate changes, so an answer to a request made for
  // the previous candidate never lands on this one.
  const requestSeq = useRef(0);

  // A different candidate is a different request: start over.
  useEffect(() => {
    requestSeq.current += 1;
    setHeldGrant(null);
    setSubmitting(false);
    setPossessionConfirmed(false);
    setConfirmName('');
    setAcknowledgeOsChange(false);
    setRestoreDecommissioned(false);
    setPhase('form');
    setCode('');
    setError(null);
    setIntent(null);
  }, [candidate.deviceId, candidate.targetVersion]);

  const { tier, ensureTier } = useReauthTier(passkeyCount, mfaMethod, totpEnrolled);
  const noUsableFactor = phase === 'stepUp' && tier === 'password';
  // The level the candidates read showed (#8318 wave T2). It is sent as
  // `expectedEvidenceLevel` and bound in the step-up; a `tpm_continuity`
  // candidate needs no typed name. If the server now judges it weaker, it
  // answers 409 evidence_changed and the parent re-reads the candidates.
  const evidenceLevel = candidate.evidenceLevel === 'tpm_continuity' ? 'tpm_continuity' : 'hint';
  const hint = evidenceLevel === 'hint';

  const resource = canonicalDeviceReattachResource({
    sourceDeviceId: source.deviceId,
    targetDeviceId: candidate.deviceId,
    targetVersion: candidate.targetVersion,
    evidenceLevel,
    restoreDecommissioned: candidate.requiresRestore && restoreDecommissioned,
  });
  const resourceKey = JSON.stringify(resource);
  const usableGrant = heldGrant && heldGrant.key === resourceKey && Date.now() - heldGrant.mintedAt < HELD_GRANT_MS
    ? heldGrant
    : null;

  // An idle dialog drops the grant when it stops being usable, so the step-up
  // shows the code field again instead of "verified" (#8318 2-3 review).
  useEffect(() => {
    if (!heldGrant) return;
    const timer = setTimeout(() => setHeldGrant(null), Math.max(0, heldGrant.mintedAt + HELD_GRANT_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [heldGrant]);

  useEffect(() => {
    onBusyChange?.(submitting || phase === 'stepUp');
  }, [submitting, phase, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const discoverTier = useCallback(async (): Promise<boolean> => {
    if (await ensureTier()) return true;
    setError(t('reattachDialog.genericError'));
    return false;
  }, [ensureTier, t]);

  const refusalMessage = useCallback((refusalCode: string | undefined, fallback: string): string => {
    if (isKnownReattachRefusal(refusalCode)) {
      return t(/* i18n-dynamic */ `reattachDialog.refusals.${refusalCode}`, {
        hostname: candidate.hostname,
        defaultValue: fallback,
      });
    }
    return fallback;
  }, [candidate.hostname, t]);

  const submit = useCallback(async () => {
    const seq = requestSeq.current;
    const current = () => live.current && seq === requestSeq.current;

    let stepUpGrant: string | undefined;
    if (phase === 'stepUp') {
      // Checked again at submit: a background tab can run the expiry timer late.
      if (usableGrant && Date.now() - usableGrant.mintedAt < HELD_GRANT_MS) {
        stepUpGrant = usableGrant.grantId;
      } else if (usableGrant && tier !== 'passkey') {
        // It lapsed while the dialog sat idle: ask for a fresh code, send nothing.
        setHeldGrant(null);
        return;
      } else {
        try {
          stepUpGrant = await mintStepUpGrant({
            operation: 'device_reattach',
            resource,
            reauth: tier === 'passkey' ? { method: 'passkey' } : { method: 'totp', code },
          });
        } catch (err) {
          if (!current()) return;
          setError(err instanceof StepUpMintError || err instanceof Error ? err.message : t('reattachDialog.genericError'));
          return;
        }
        if (!current()) return;
        // The code is spent: a retry reuses the grant, or asks for a new code.
        setCode('');
        setHeldGrant({ grantId: stepUpGrant, key: resourceKey, mintedAt: Date.now() });
      }
    }
    if (!current()) return;

    try {
      const data = await runAction<{ intent: ReattachRequestedIntent }>({
        request: () => fetchWithAuth(reattachPath(source.deviceId), {
          method: 'POST',
          body: JSON.stringify(deviceReattachRequestBody(resource, {
            confirmTargetName: confirmName,
            acknowledgeOsChange: candidate.osChanged && acknowledgeOsChange,
            stepUpGrant,
          })),
        }),
        errorFallback: t('reattachDialog.genericError'),
        friendly: (refusalCode, message) => refusalMessage(refusalCode, message),
        // The step-up request opens the factor step; it is not a failure.
        suppressErrorToast: (status, refusalCode) => status === 403 && refusalCode === STEP_UP_REQUIRED,
        successMessage: t('reattachDialog.requestedToast', { hostname: candidate.hostname }),
      });
      if (!current()) return;
      setHeldGrant(null);
      setIntent(data.intent);
      setPhase('pending');
      setError(null);
      onRequested(data.intent);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('reattachDialog.genericError') });
        return;
      }
      if (!current()) return;
      if (err.status === 403 && err.code === STEP_UP_REQUIRED) {
        // A grant was sent and refused: it expired or no longer matches. Ask
        // for a fresh proof.
        setHeldGrant(null);
        if (stepUpGrant) {
          setCode('');
          setError(t('reattachDialog.stepUpRetry'));
          return;
        }
        if (!(await discoverTier())) return;
        setPhase('stepUp');
        setCode('');
        setError(null);
        return;
      }
      setError(err.message);
      if (err.status === 409) {
        if (err.code === 'target_changed') onTargetChanged?.();
        onConflict?.(err.code);
      }
    }
  }, [source.deviceId, candidate, resource, resourceKey, usableGrant, phase, tier, code, confirmName, acknowledgeOsChange, refusalMessage, onRequested, onTargetChanged, onConflict, discoverTier, t]);

  const handleSubmit = useCallback(() => {
    if (submitting) return;
    setSubmitting(true);
    const seq = requestSeq.current;
    void submit().finally(() => { if (live.current && seq === requestSeq.current) setSubmitting(false); });
  }, [submit, submitting]);

  const nameConfirmed = !hint || confirmTargetNameMatches(confirmName, candidate.hostname);
  const osGate = !candidate.osChanged || acknowledgeOsChange;
  const restoreGate = !candidate.requiresRestore || restoreDecommissioned;
  const canSubmit = source.rebindSupported && possessionConfirmed && nameConfirmed && osGate && restoreGate
    && !submitting && (phase === 'form' || tier === 'passkey' || usableGrant !== null || code.length === 6);
  // Only while a request is in flight. In the step-up phase the fields stay
  // editable so a refusal (an OS change, a removed record) can be answered;
  // a change to a bound field (the restore) drops the held grant by its key.
  const locked = submitting;

  const dash = '—';
  const dateOr = (value: string | null) => (value ? formatDateTime(value) : dash);
  const modelOf = (side: { manufacturer: string | null; model: string | null }) =>
    [side.manufacturer, side.model].filter(Boolean).join(' ') || dash;
  const placeOf = () => [candidate.orgName, candidate.siteName].filter(Boolean).join(' / ') || dash;
  const sourcePlace = source.parked ? t('reattachDialog.holdingArea') : dash;

  const rows: Array<{ key: string; label: string; source: string; target: string }> = [
    { key: 'hostname', label: t('reattachDialog.fields.hostname'), source: source.hostname || dash, target: candidate.hostname || dash },
    { key: 'os', label: t('reattachDialog.fields.os'), source: `${source.osType} ${source.osVersion}`.trim() || dash, target: `${candidate.osType} ${candidate.osVersion}`.trim() || dash },
    { key: 'model', label: t('reattachDialog.fields.model'), source: modelOf(source), target: modelOf(candidate) },
    { key: 'serial', label: t('reattachDialog.fields.serial'), source: source.serialNumber ?? dash, target: candidate.serialNumber ?? dash },
    { key: 'uuid', label: t('reattachDialog.fields.systemUuid'), source: source.systemUuid ?? dash, target: candidate.systemUuid ?? dash },
    { key: 'agent', label: t('reattachDialog.fields.agentVersion'), source: source.agentVersion ?? dash, target: candidate.agentVersion ?? dash },
    { key: 'place', label: t('reattachDialog.fields.place'), source: sourcePlace, target: placeOf() },
    { key: 'enrolled', label: t('reattachDialog.fields.enrolledAt'), source: dateOr(source.enrolledAt), target: dateOr(candidate.enrolledAt) },
    { key: 'lastSeen', label: t('reattachDialog.fields.lastSeenAt'), source: dateOr(source.lastSeenAt), target: dateOr(candidate.lastSeenAt) },
  ];

  // Why a TPM key did not count. No line for a device with no key: most
  // devices have none, and it says nothing new. The source's gaps are judged
  // first (deviceReattach/evidence.ts), so a source gap can show while the
  // old record has no key; the line is still true.
  const tpmGapLabel = (() => {
    switch (candidate.evidenceGap) {
      case 'source_key_changed': return t('reattachDialog.evidenceGap.sourceKeyChanged');
      case 'source_key_not_proven_by_install': return t('reattachDialog.evidenceGap.sourceKeyNotProvenByInstall');
      case 'target_key_changed': return t('reattachDialog.evidenceGap.targetKeyChanged');
      case 'keys_differ': return t('reattachDialog.evidenceGap.keysDiffer');
      case 'key_shared': return t('reattachDialog.evidenceGap.keyShared');
      default: return null;
    }
  })();

  const evidenceLabel = (() => {
    switch (candidate.evidence) {
      case 'tpm_ek': return t('reattachDialog.evidence.tpmEk');
      case 'system_uuid': return t('reattachDialog.evidence.systemUuid');
      case 'serial': return t('reattachDialog.evidence.serial');
      case 'hostname': return t('reattachDialog.evidence.hostname');
      default: return t('reattachDialog.evidence.other');
    }
  })();

  if (phase === 'pending' && intent) {
    return (
      <div className="mt-4 space-y-4" data-testid="reattach-pending">
        <div className="flex items-start gap-3 rounded-md border border-primary/30 bg-primary/5 p-3">
          <Clock className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div className="space-y-1 text-sm">
            <p className="font-medium" data-testid="reattach-pending-title">{t('reattachDialog.pendingTitle')}</p>
            <p className="text-muted-foreground" data-testid="reattach-pending-message">
              {t('reattachDialog.pendingMessage', {
                source: source.hostname,
                target: candidate.hostname,
                expiresAt: formatDateTime(intent.expiresAt),
              })}
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            data-testid="reattach-done"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t('reattachDialog.close')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4" data-testid="reattach-form">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="reattach-comparison">
          <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2" />
              <th className="px-3 py-2">{t('reattachDialog.newInstall')}</th>
              <th className="px-3 py-2">{t('reattachDialog.existingRecord')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t" data-testid={`reattach-compare-${row.key}`}>
                <th scope="row" className="px-3 py-1.5 text-left font-normal text-muted-foreground">{row.label}</th>
                <td className="break-all px-3 py-1.5" data-testid={`reattach-compare-${row.key}-source`}>{row.source}</td>
                <td className="break-all px-3 py-1.5" data-testid={`reattach-compare-${row.key}-target`}>{row.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
        <p data-testid="reattach-evidence">{t('reattachDialog.matchedOn', { evidence: evidenceLabel })}</p>
        <p className="text-xs font-medium text-warning" data-testid="reattach-evidence-notice">
          {/* The TPM sentence is for TPM evidence only: it says key
              continuity, never a genuine TPM. */}
          {!hint
            ? t('reattachDialog.evidenceNoticeTpm')
            : t('reattachDialog.evidenceNoticeHint')}
        </p>
        {hint && tpmGapLabel && (
          <p className="text-xs text-muted-foreground" data-testid="reattach-evidence-gap">{tpmGapLabel}</p>
        )}
      </div>

      <p className="text-sm text-muted-foreground" data-testid="reattach-consequences">
        {t('reattachDialog.consequences', { target: candidate.hostname, source: source.hostname })}
      </p>

      {!source.rebindSupported && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" data-testid="reattach-rebind-unsupported">
          {t('reattachDialog.refusals.rebind_unsupported')}
        </p>
      )}

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="reattach-possession"
          checked={possessionConfirmed}
          onChange={(e) => setPossessionConfirmed(e.target.checked)}
          disabled={locked}
          className="mt-0.5"
        />
        <span>{t('reattachDialog.possession', { target: candidate.hostname })}</span>
      </label>

      {candidate.osChanged && (
        <label className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <input
            type="checkbox"
            data-testid="reattach-ack-os"
            checked={acknowledgeOsChange}
            onChange={(e) => setAcknowledgeOsChange(e.target.checked)}
            disabled={locked}
            className="mt-0.5"
          />
          <span>{t('reattachDialog.acknowledgeOsChange', { sourceOs: source.osType, targetOs: candidate.osType })}</span>
        </label>
      )}

      {candidate.requiresRestore && (
        <label className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <input
            type="checkbox"
            data-testid="reattach-restore"
            checked={restoreDecommissioned}
            onChange={(e) => setRestoreDecommissioned(e.target.checked)}
            disabled={locked}
            className="mt-0.5"
          />
          <span>{t('reattachDialog.restoreDecommissioned', { target: candidate.hostname })}</span>
        </label>
      )}

      {hint && (
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="reattach-confirm-name">
            {t('reattachDialog.confirmNameLabel', { hostname: candidate.hostname })}
          </label>
          <input
            id="reattach-confirm-name"
            data-testid="reattach-confirm-name"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            disabled={locked}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>
      )}

      {phase === 'stepUp' && (
        noUsableFactor ? (
          <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" data-testid="reattach-no-factor">
            {t('reattachDialog.noStepUpFactor')}
          </p>
        ) : (
          <div className="space-y-2 rounded-md border p-3" data-testid="reattach-stepup">
            <p className="text-sm font-medium">{t('reattachDialog.stepUpHeading')}</p>
            <p className="text-xs text-muted-foreground">{t('reattachDialog.stepUpIntro')}</p>
            {usableGrant ? (
              <p className="text-xs text-muted-foreground" data-testid="reattach-stepup-held">{t('reattachDialog.stepUpHeld')}</p>
            ) : tier === 'passkey' ? (
              <p className="text-xs text-muted-foreground" data-testid="reattach-stepup-passkey">{t('reattachDialog.stepUpPasskeyNote')}</p>
            ) : (
              <>
                <label className="text-sm font-medium" htmlFor="reattach-stepup-code">{t('reattachDialog.stepUpCodeLabel')}</label>
                <input
                  id="reattach-stepup-code"
                  data-testid="reattach-stepup-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  disabled={submitting}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
              </>
            )}
          </div>
        )
      )}

      {error != null && (
        <p className="flex items-start gap-2 text-sm text-destructive" role="alert" data-testid="reattach-error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          data-testid="reattach-cancel"
          className="rounded-md border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          {t('reattachDialog.cancel')}
        </button>
        {!noUsableFactor && (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="reattach-submit"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting
              ? t('reattachDialog.submitting')
              : phase === 'stepUp'
                ? t('reattachDialog.submitStepUp')
                : t('reattachDialog.submit', { hostname: candidate.hostname })}
          </button>
        )}
      </div>
    </div>
  );
}
