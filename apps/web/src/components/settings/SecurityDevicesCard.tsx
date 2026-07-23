import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import {
  StepUpError,
  createPasskeyCredential,
  fetchWithAuth,
  mintAddFactorStepUpGrant,
  type PasskeyRegistrationOptions,
} from '../../stores/auth';
import {
  listApproverDevices,
  revokeApproverDevice,
  renameApproverDevice,
} from '../../stores/authenticator';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import StepUpPrompt from './StepUpPrompt';
import { mergeSecurityDevices, type PasskeySummary, type SecurityDeviceRow } from './securityDevices';

/**
 * Unified "Security devices" card (unified-security-devices Phase 2, Task 5).
 *
 * Renders the merge of `GET /auth/passkeys` (sign-in factors) and
 * `GET /me/approver-devices` (approval factors) as one list, with a badge per
 * capability a row carries. This task moves the two capabilities' state/
 * handlers over UNCHANGED — no dual-enroll checkbox yet (Task 6) and no
 * "register this browser as approver" form (that stays behind in
 * ApproverDevicesSection until a later task decides its fate).
 *
 * i18n note: every string below reuses an EXISTING `profilePage.*` /
 * `approverDevicesSection.*` / `stepUpPrompt.*` key rather than inventing a
 * new one (CI enforces 5-locale key parity, and new keys are out of this
 * task's scope). Several are close-but-not-exact matches for the intended
 * copy — flagged in the task report — and will be replaced by dedicated
 * `securityDevicesCard.*` keys when the card is mounted (Task 7 in the plan).
 */

function formatPasskeyDate(value?: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

type Props = {
  mfaEnabled: boolean;
  mfaMethod: string | null;
  onFactorAdded: (p: { recoveryCodes?: string[] }) => void;
};

export default function SecurityDevicesCard({ mfaEnabled, mfaMethod, onFactorAdded }: Props) {
  const { t } = useTranslation('settings');

  // --- Passkey (sign-in) state — moved from ProfilePage.tsx unchanged. ---
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [passkeyName, setPasskeyName] = useState('');
  const [passkeyPassword, setPasskeyPassword] = useState('');
  const [passkeyStepUpCode, setPasskeyStepUpCode] = useState('');
  const [passkeyError, setPasskeyError] = useState<string | undefined>();
  const [passkeySuccess, setPasskeySuccess] = useState<string | undefined>();
  const [isLoadingPasskeys, setIsLoadingPasskeys] = useState(false);
  const [isAddingPasskey, setIsAddingPasskey] = useState(false);

  // --- Approver (approval) state — list-only, moved from ApproverDevicesSection.tsx. ---
  const [devices, setDevices] = useState<import('../../stores/authenticator').ApproverDevice[]>([]);
  const [isLoadingApprovers, setIsLoadingApprovers] = useState(false);
  const [approverLoadError, setApproverLoadError] = useState<string | undefined>();

  // --- Shared per-row action state. ---
  const [editingRowKey, setEditingRowKey] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [mutatingRowKey, setMutatingRowKey] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<SecurityDeviceRow | null>(null);

  const loadPasskeys = useCallback(async () => {
    try {
      setIsLoadingPasskeys(true);
      const response = await fetchWithAuth('/auth/passkeys');
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error ?? errorData.message ?? t('profilePage.failedToLoadPasskeys'));
      }
      const data = await response.json();
      setPasskeys(Array.isArray(data) ? data : data.passkeys ?? []);
    } catch (error) {
      setPasskeyError(error instanceof Error ? error.message : t('profilePage.failedToLoadPasskeys'));
    } finally {
      setIsLoadingPasskeys(false);
    }
  }, [t]);

  const loadApprovers = useCallback(async () => {
    setIsLoadingApprovers(true);
    setApproverLoadError(undefined);
    try {
      const result = await listApproverDevices();
      setDevices(result.filter((d) => !d.disabledAt));
    } catch (err) {
      setApproverLoadError(err instanceof Error ? err.message : t('approverDevicesSection.failedToLoadApproverDevices'));
    } finally {
      setIsLoadingApprovers(false);
    }
  }, [t]);

  useEffect(() => {
    loadPasskeys();
    loadApprovers();
  }, [loadPasskeys, loadApprovers]);

  const rows = useMemo(() => mergeSecurityDevices(passkeys, devices), [passkeys, devices]);

  // SR2-20: adding a factor to an already-protected account requires proving
  // an EXISTING factor first — see ProfilePage.tsx's identical comment for the
  // full rationale. Preserved verbatim; the card now reads passkeys/mfa state
  // from its own state + props instead of ProfilePage's `user`.
  const passkeyStepUpTier: 'none' | 'passkey' | 'totp' | 'sms' = useMemo(() => {
    if (passkeys.length > 0) return 'passkey';
    if (!mfaEnabled) return 'none';
    if (mfaMethod === 'totp') return 'totp';
    if (mfaMethod === 'sms') return 'sms';
    return 'none';
  }, [passkeys.length, mfaEnabled, mfaMethod]);

  const handleAddPasskey = async () => {
    if (!passkeyPassword || isAddingPasskey) return;
    if (passkeyStepUpTier === 'sms') return;
    if (passkeyStepUpTier === 'totp' && passkeyStepUpCode.length !== 6) return;
    setPasskeyError(undefined);
    setPasskeySuccess(undefined);
    try {
      setIsAddingPasskey(true);
      let stepUpGrantId: string | undefined;
      if (passkeyStepUpTier === 'passkey') {
        stepUpGrantId = await mintAddFactorStepUpGrant({ method: 'passkey' });
      } else if (passkeyStepUpTier === 'totp') {
        stepUpGrantId = await mintAddFactorStepUpGrant({ method: 'totp', code: passkeyStepUpCode });
      }

      const label = passkeyName.trim() || 'Passkey';
      const optionsResponse = await fetchWithAuth('/auth/passkeys/register/options', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: passkeyPassword,
          name: label,
          ...(stepUpGrantId ? { stepUpGrantId } : {})
        })
      });

      const optionsData = await optionsResponse.json().catch(() => ({}));
      if (!optionsResponse.ok) {
        throw new Error(
          optionsData.error ?? optionsData.message ?? t('profilePage.failedToStartPasskeyHttp', { status: optionsResponse.status })
        );
      }

      const optionsJSON = (optionsData.options ?? optionsData.optionsJSON) as PasskeyRegistrationOptions;
      const credential = await createPasskeyCredential(optionsJSON);
      const verifyResponse = await fetchWithAuth('/auth/passkeys/register/verify', {
        method: 'POST',
        body: JSON.stringify({
          name: label,
          credential,
          ...(stepUpGrantId ? { stepUpGrantId } : {})
        })
      });

      const verifyData = await verifyResponse.json().catch(() => ({}));
      if (!verifyResponse.ok) {
        throw new Error(
          verifyData.error ?? verifyData.message ?? t('profilePage.failedToSavePasskeyHttp', { status: verifyResponse.status })
        );
      }

      setPasskeyName('');
      setPasskeyPassword('');
      setPasskeyStepUpCode('');
      // Delegate the mfaEnabled/recoveryCodes side effects to the parent —
      // this card doesn't own the user record (unlike ProfilePage today).
      onFactorAdded({
        recoveryCodes: Array.isArray(verifyData.recoveryCodes) ? verifyData.recoveryCodes : undefined,
      });
      setPasskeySuccess(t('profilePage.passkeyAdded'));
      await loadPasskeys();
    } catch (error) {
      // NotAllowedError/AbortError: a cancelled/timed-out WebAuthn prompt —
      // either the registration ceremony itself or the step-up assertion
      // ceremony inside the mint (both reject with a DOMException).
      if (error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
        setPasskeyError(t('profilePage.passkeySetupWasCanceledOrTimedOut'));
      } else if (error instanceof StepUpError) {
        if (error.status === 401) {
          setPasskeyError(passkeyStepUpTier === 'totp'
            ? t('profilePage.incorrectAuthenticatorCode')
            : t('profilePage.passkeyVerificationFailed'));
        } else if (error.status === 429) {
          setPasskeyError(t('profilePage.tooManyAttemptsTryAgainInAFewMinutes'));
        } else {
          setPasskeyError(error.message);
        }
      } else if (error instanceof Error && error.message === 'existing_factor_step_up_required') {
        // The grant expired mid-ceremony (>5 min in the WebAuthn prompt) or a
        // factor changed in another tab since it was minted.
        setPasskeyError(t('profilePage.verificationExpiredPleaseVerifyAgain'));
      } else {
        setPasskeyError(error instanceof Error ? error.message : t('profilePage.failedToAddPasskey'));
      }
    } finally {
      setIsAddingPasskey(false);
    }
  };

  const handleDeletePasskey = async (row: SecurityDeviceRow) => {
    if (!row.passkey || mutatingRowKey) return;
    const passkeyId = row.passkey.id;
    setPasskeyError(undefined);
    setPasskeySuccess(undefined);
    if (!passkeyPassword) {
      setPasskeyError(t('profilePage.currentPasswordIsRequiredToDeleteAPasskey'));
      return;
    }
    try {
      setMutatingRowKey(row.key);
      const response = await fetchWithAuth(`/auth/passkeys/${encodeURIComponent(passkeyId)}`, {
        method: 'DELETE',
        body: JSON.stringify({ currentPassword: passkeyPassword })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error ?? data.message ?? t('profilePage.failedToDeletePasskeyHttp', { status: response.status }));
      }
      setPasskeys(prev => prev.filter(passkey => passkey.id !== passkeyId));
      setPasskeyPassword('');
      setPasskeySuccess(t('profilePage.passkeyDeleted'));
    } catch (error) {
      setPasskeyError(error instanceof Error ? error.message : t('profilePage.failedToDeletePasskey'));
    } finally {
      setMutatingRowKey(null);
    }
  };

  const startEdit = (row: SecurityDeviceRow) => {
    if (mutatingRowKey) return;
    setEditingRowKey(row.key);
    setEditingName(row.name);
    setPasskeyError(undefined);
    setPasskeySuccess(undefined);
  };

  const cancelEdit = () => {
    setEditingRowKey(null);
    setEditingName('');
  };

  // Rename is the one control shared by both capabilities: a merged row's
  // Save button renames the passkey (inline error/success state, matching
  // ProfilePage's existing pattern) AND the approver device (via runAction,
  // matching ApproverDevicesSection's existing pattern) with the SAME value.
  const handleRenameSave = async (row: SecurityDeviceRow) => {
    const name = editingName.trim();
    if (!name || mutatingRowKey) return;
    setMutatingRowKey(row.key);
    if (row.passkey) {
      setPasskeyError(undefined);
      setPasskeySuccess(undefined);
    }
    try {
      if (row.passkey) {
        const response = await fetchWithAuth(`/auth/passkeys/${encodeURIComponent(row.passkey.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ name })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error ?? data.message ?? t('profilePage.failedToRenamePasskeyHttp', { status: response.status }));
        }
        setPasskeys(prev => prev.map(passkey => (
          passkey.id === row.passkey!.id ? { ...passkey, name: data.passkey?.name ?? name } : passkey
        )));
      }
      if (row.approver) {
        await runAction({
          request: () => renameApproverDevice(row.approver!.id, name),
          errorFallback: t('approverDevicesSection.failedToRenameDevice'),
          successMessage: t('approverDevicesSection.deviceRenamed'),
        });
        setDevices(prev => prev.map(d => (d.id === row.approver!.id ? { ...d, label: name } : d)));
      }
      if (row.passkey) setPasskeySuccess(t('profilePage.passkeyRenamed'));
      setEditingRowKey(null);
      setEditingName('');
    } catch (error) {
      if (row.passkey) {
        setPasskeyError(error instanceof Error ? error.message : t('profilePage.failedToRenamePasskey'));
      } else if (!(error instanceof ActionError)) {
        showToast({ type: 'error', message: error instanceof Error ? error.message : t('approverDevicesSection.failedToRenameDevice') });
      }
    } finally {
      setMutatingRowKey(null);
    }
  };

  const handleRevokeConfirm = async () => {
    if (!confirmRevoke?.approver) return;
    const row = confirmRevoke;
    setMutatingRowKey(row.key);
    try {
      await runAction({
        request: () => revokeApproverDevice(row.approver!.id),
        errorFallback: t('approverDevicesSection.failedToRevokeDevice'),
        successMessage: t('approverDevicesSection.deviceRevoked'),
      });
      setConfirmRevoke(null);
      await loadApprovers();
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: err instanceof Error ? err.message : t('approverDevicesSection.failedToRevokeDevice') });
      }
    } finally {
      setMutatingRowKey(null);
    }
  };

  const isLoading = isLoadingPasskeys || isLoadingApprovers;

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs" data-testid="security-devices-card">
      <div className="space-y-1">
        {/* i18n compromise: no combined "Security devices" key exists yet
            (added in the later mounting task) — closest existing key reused. */}
        <h2 className="text-lg font-semibold">{t('profilePage.passkeys')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('profilePage.managePasskeysThatCanBeUsedAsMultiFactorAuthenticationFo')}</p>
      </div>

      <div className="space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t('profilePage.loadingPasskeys')}
          </div>
        ) : approverLoadError ? (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <span>{approverLoadError}</span>
            <button
              type="button"
              onClick={() => void loadApprovers()}
              className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium hover:bg-destructive/5"
            >
              {t('approverDevicesSection.tryAgain')}
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div data-testid="secdev-empty" className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
            {/* i18n compromise: reuses the passkey-only empty-state copy; a
                combined-empty key lands with the mounting task. */}
            {t('profilePage.noPasskeysAreRegisteredForThisAccount')}
          </div>
        ) : (
          rows.map(row => {
            const isEditing = editingRowKey === row.key;
            const isMutating = mutatingRowKey === row.key;
            return (
              <div key={row.key} data-testid={`secdev-row-${row.key}`} className="rounded-md border bg-muted/30 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {isEditing ? (
                        <input
                          type="text"
                          value={editingName}
                          onChange={e => setEditingName(e.target.value)}
                          data-testid={`secdev-rename-input-${row.key}`}
                          className="h-9 rounded-md border bg-background px-3 text-sm"
                          disabled={isMutating}
                          autoFocus
                        />
                      ) : (
                        <span data-testid={`secdev-name-${row.key}`} className="truncate text-sm font-medium">
                          {row.name}
                        </span>
                      )}
                      {row.passkey && (
                        <span
                          data-testid="secdev-badge-signin"
                          className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                        >
                          {/* i18n compromise: closest existing key to the intended
                              "Sign-in" badge copy — see task report. */}
                          {t('profilePage.signInSecurity')}
                        </span>
                      )}
                      {row.approver && (
                        <span
                          data-testid="secdev-badge-approvals"
                          className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                        >
                          {t('profilePage.approvals')}
                        </span>
                      )}
                      {row.approver?.isPlatformBound && (
                        <span
                          data-testid="secdev-badge-platform"
                          className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                        >
                          {t('approverDevicesSection.platformBound')}
                        </span>
                      )}
                      {row.approver && row.approver.lastUsedAt === null && (
                        <span
                          data-testid="secdev-badge-pending"
                          className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600"
                        >
                          {t('approverDevicesSection.pendingActivatesOnFirstApproval')}
                        </span>
                      )}
                      {row.passkey && row.approver && row.approver.isPlatformBound === false && (
                        <span
                          data-testid="secdev-badge-synced"
                          className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                        >
                          {/* i18n compromise: no "Synced" key exists yet — see
                              task report; this reuses an unrelated key as a
                              placeholder. */}
                          {t('approverDevicesSection.registered')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('profilePage.lastUsed')}{formatPasskeyDate(row.lastUsedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          onClick={() => handleRenameSave(row)}
                          disabled={!editingName.trim() || isMutating}
                          data-testid={`secdev-rename-save-${row.key}`}
                          className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {isMutating ? t('profilePage.saving') : t('profilePage.save')}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={isMutating}
                          data-testid={`secdev-rename-cancel-${row.key}`}
                          className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {t('profilePage.cancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => startEdit(row)}
                          disabled={!!mutatingRowKey}
                          data-testid={`secdev-rename-${row.key}`}
                          className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {t('profilePage.rename')}
                        </button>
                        {row.passkey && (
                          <button
                            type="button"
                            onClick={() => handleDeletePasskey(row)}
                            disabled={!!mutatingRowKey}
                            data-testid={`secdev-delete-${row.key}`}
                            className="h-9 rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isMutating ? t('profilePage.deleting') : t('profilePage.delete')}
                          </button>
                        )}
                        {row.approver && (
                          <button
                            type="button"
                            onClick={() => setConfirmRevoke(row)}
                            disabled={!!mutatingRowKey}
                            data-testid={`secdev-revoke-${row.key}`}
                            className="h-9 rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {t('approverDevicesSection.revoke')}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="space-y-4 rounded-md border p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{t('profilePage.addPasskey')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('profilePage.reEnterYourAccountPasswordBeforeAddingOrDeletingAPasskey')}</p>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="passkey-name">
            {t('profilePage.passkeyName')}</label>
          <input
            id="passkey-name"
            type="text"
            value={passkeyName}
            onChange={event => setPasskeyName(event.target.value)}
            placeholder={t('profilePage.macBookTouchID')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            disabled={isAddingPasskey}
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="passkey-password">
            {t('profilePage.currentPassword')}</label>
          <input
            id="passkey-password"
            type="password"
            autoComplete="current-password"
            value={passkeyPassword}
            onChange={event => setPasskeyPassword(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            disabled={isAddingPasskey}
          />
        </div>
        {(passkeyStepUpTier === 'passkey' || passkeyStepUpTier === 'totp') && (
          <StepUpPrompt
            tier={passkeyStepUpTier}
            reauthValue={passkeyStepUpCode}
            onChange={setPasskeyStepUpCode}
            disabled={isAddingPasskey}
            idPrefix="passkey-stepup"
          />
        )}
        {passkeyStepUpTier === 'sms' && (
          <p className="text-xs text-muted-foreground" data-testid="passkey-stepup-sms-note">
            {t('profilePage.smsAccountsCannotAddPasskeysFromTheWebYet')}</p>
        )}
        <button
          type="button"
          onClick={handleAddPasskey}
          disabled={
            isAddingPasskey ||
            !passkeyPassword ||
            passkeyStepUpTier === 'sms' ||
            (passkeyStepUpTier === 'totp' && passkeyStepUpCode.length !== 6)
          }
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isAddingPasskey ? t('profilePage.adding') : t('profilePage.addPasskey')}
        </button>
      </div>

      {passkeySuccess && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600">
          {passkeySuccess}
        </div>
      )}
      {passkeyError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {passkeyError}
        </div>
      )}

      {confirmRevoke?.approver && (
        <RevokeConfirmDialog
          name={confirmRevoke.name}
          revoking={mutatingRowKey === confirmRevoke.key}
          onCancel={() => (mutatingRowKey ? null : setConfirmRevoke(null))}
          onConfirm={() => void handleRevokeConfirm()}
        />
      )}
    </div>
  );
}

function RevokeConfirmDialog({
  name,
  revoking,
  onCancel,
  onConfirm,
}: {
  name: string;
  revoking: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
            </div>
            <h2 className="text-lg font-semibold">{t('approverDevicesSection.revoke')}{name}?</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={revoking}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed"
            aria-label={t('approverDevicesSection.close')}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <p className="mt-4 text-sm text-muted-foreground">
          {t('approverDevicesSection.thisDeviceCanNoLongerApproveRequestsWithABiometricYouCan')}</p>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={revoking}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('approverDevicesSection.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={revoking}
            data-testid="secdev-revoke-confirm"
            className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {revoking ? t('approverDevicesSection.revoking') : t('approverDevicesSection.revokeDevice')}
          </button>
        </div>
      </div>
    </div>
  );
}
