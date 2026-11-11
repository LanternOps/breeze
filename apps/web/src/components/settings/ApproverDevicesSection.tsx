import { i18n } from '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, ShieldCheck, X } from 'lucide-react';
import {
  listApproverDevices,
  registerApproverDevice,
  revokeApproverDevice,
  renameApproverDevice,
  type ApproverDevice,
  type RegisterReauth,
} from '../../stores/authenticator';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { formatAbsolute, formatRelative } from '../account/relativeTime';
import StepUpPrompt, { pickRegisterReauthTier, type RegisterReauthTier } from './StepUpPrompt';

/**
 * Profile "Approval security" section (Breeze Authenticator Phase 2).
 *
 * Mirrors the ProfilePage passkey list + MobileDevicesPage revoke/confirm
 * pattern, but swaps the data source to the typed `stores/authenticator`
 * helpers. Registering this browser/platform authenticator lets the signed-in
 * tech approve high-risk requests with Windows Hello / Touch ID (records a
 * `webauthn_platform` assurance factor — opt-in, never enforced in P2).
 *
 * Every mutation flows through `runAction` so success/failure always surfaces
 * to the user (CLAUDE.md `no-silent-mutations`).
 *
 * #9007: a passwordless (SSO-only) account with no passkey or TOTP proves
 * itself with a fresh IdP re-auth. ProfilePage owns that round-trip and the
 * grant it brings back (shared with the MFA cards); this section only shows the
 * verify step, spends the grant on submit, and tells the page it is gone.
 */

type ConfirmState = {
  device: ApproverDevice;
};

function deviceTitle(d: ApproverDevice): string {
  if (d.label && d.label.trim().length > 0) return d.label;
  return 'Unnamed device';
}

/**
 * Mirrors `L4_TRUSTED_PLATFORM_BOUND_BASES` in
 * `apps/api/src/services/authenticatorAssurance.ts` (#1374 W07, issue #5162) —
 * the ONLY bases that reach critical-tier (L4) approvals. Keep in sync with
 * that server-side set; this is UI-only and never itself a security gate.
 * A missing/undefined `platformBoundBasis` (API predates #1374 W02, or the
 * legacy single-POST registration path) is deliberately NOT trusted here —
 * fail toward the honest "Not attested" badge, never the reverse.
 */
const L4_TRUSTED_PLATFORM_BOUND_BASES = new Set<NonNullable<ApproverDevice['platformBoundBasis']>>([
  'webauthn_backup_flags',
  'ios_se_p256_app_attest',
  'android_tee_key_attestation',
  'android_strongbox_key_attestation',
]);

function isHardwareAttested(device: ApproverDevice): boolean {
  return device.platformBoundBasis !== undefined && L4_TRUSTED_PLATFORM_BOUND_BASES.has(device.platformBoundBasis);
}

const OK_RESPONSE = { ok: true, status: 200, json: async () => ({ success: true }) } as Response;

export default function ApproverDevicesSection({
  passkeyCount,
  mfaMethod,
  totpEnrolled,
  hasPassword,
  ssoReauthGrantId = null,
  isStartingSsoReauth = false,
  onStartSsoReauth,
  onSsoReauthGrantSpent,
  landOnRegister = false,
}: {
  passkeyCount: number;
  mfaMethod: string | null;
  totpEnrolled?: boolean;
  /** `false` = passwordless account; `undefined` (unknown) keeps the password road. */
  hasPassword?: boolean;
  /** The SSO re-auth grant ProfilePage holds, if any (#9007). */
  ssoReauthGrantId?: string | null;
  isStartingSsoReauth?: boolean;
  onStartSsoReauth?: () => void;
  /** Called the moment the grant is sent: register-grant consumes it whatever
   * happens next, so the page must stop advertising it to every card. */
  onSsoReauthGrantSpent?: () => void;
  /** This page load is the return leg of a trip this section started. */
  landOnRegister?: boolean;
}) {
  const { t } = useTranslation('settings');
  const [devices, setDevices] = useState<ApproverDevice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [label, setLabel] = useState('');
  const [reauthValue, setReauthValue] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const tier: RegisterReauthTier = pickRegisterReauthTier(passkeyCount, mfaMethod, totpEnrolled, hasPassword);
  // #9007: the IdP trip is a full-page navigation that puts the user back at
  // the top of a long settings page. Bring the register form to them once, and
  // focus the button that finishes the job (same pattern as the passkey card).
  const landingDone = useRef(false);
  const registerBlockRef = useCallback((node: HTMLDivElement | null) => {
    if (!node || !landOnRegister || landingDone.current) return;
    landingDone.current = true;
    // jsdom has no layout and so no `scrollIntoView`; optional-call it.
    node.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    node.querySelector<HTMLButtonElement>('[data-testid="approver-device-register"]')?.focus();
  }, [landOnRegister]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(undefined);
    try {
      const result = await listApproverDevices();
      setDevices(result.filter((d) => !d.disabledAt));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('approverDevicesSection.failedToLoadApproverDevices'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeDevices = useMemo(() => devices.filter((d) => !d.disabledAt), [devices]);

  const buildReauth = (): RegisterReauth | null => {
    if (tier === 'passkey') return { method: 'passkey' };
    if (tier === 'totp') return reauthValue.length === 6 ? { method: 'totp', code: reauthValue } : null;
    if (tier === 'sso') return ssoReauthGrantId ? { method: 'sso', ssoReauthGrantId } : null;
    return reauthValue.length > 0 ? { method: 'password', password: reauthValue } : null;
  };

  const mapRegisterError = (err: unknown): string => {
    // A user-cancelled/dismissed WebAuthn ceremony (startRegistration in the
    // register call itself, or startAuthentication inside the passkey re-auth
    // mint) rejects with a DOMException — `NotAllowedError` (dismissed/denied)
    // or `AbortError` (browser aborted it) — that carries no `status`. Must be
    // caught before the status checks below, or it falls through to the final
    // `err.message` branch and shows raw browser jargon.
    if (err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
      return t('approverDevicesSection.registrationCancelled');
    }
    const status = (err as { status?: number })?.status;
    const code = (err as { code?: string })?.code;

    // #9007: the SSO grant was dead, spent, minted for another session, or
    // never sent. Only a fresh IdP trip fixes it, so say "verify again" rather
    // than "session expired". `enrollment_proof_required` carries no `code`;
    // its literal `error` token arrives as the message.
    if (
      status === 400
      && (code === 'enrollment_grant_expired' || (err instanceof Error && err.message === 'enrollment_proof_required'))
    ) {
      return t('approverDevicesSection.ssoVerificationExpired');
    }

    // A rejected re-auth PROOF. Both mint roads answer 400 with a stable
    // `code` (#4470): POST /auth/mfa/step-up for the TOTP + passkey tiers, and
    // POST /authenticator/register-grant for the password + SSO tiers (#9007
    // moved it off 401). Branch on the code, never the message. Any 401 is a
    // rejected BEARER and is handled below.
    const isProofRejection =
      status === 400 && (code === 'mfa_proof_invalid' || code === 'invalid_credentials');

    if (isProofRejection) {
      // The account gained a password since the page loaded, so the server
      // refuses the SSO road. Reloading moves the form to the password tier;
      // "verify again" would loop (the IdP start refuses such an account).
      if (tier === 'sso') return t('approverDevicesSection.signInOptionsChanged');
      if (tier === 'totp') return t('approverDevicesSection.incorrectCode');
      // The passkey tier never shows a password field — a rejection here means
      // the WebAuthn assertion itself was refused (burned/replayed challenge),
      // not a wrong password, so "Incorrect password." would be nonsensical.
      if (tier === 'passkey') return t('approverDevicesSection.passkeyVerificationFailed');
      return t('approverDevicesSection.incorrectPassword');
    }
    if (status === 401) return t('approverDevicesSection.sessionExpiredReloadAndTryAgain');
    if (status === 429) return t('approverDevicesSection.tooManyAttemptsTryAgainInAFewMinutes');
    if (status === 403) {
      // A 403 comes from two places. The mint (register-grant, or the step-up
      // mint) answers "stronger_factor_required" when the account gained a
      // passkey/TOTP in another tab since the page loaded, so the proof field
      // shown here is stale: point the user at reloading rather than letting
      // them retry the same proof forever. The options/verify routes answer
      // 403 when the register grant expired mid-ceremony (>300s in the
      // WebAuthn prompt).
      if (err instanceof Error && err.message === 'stronger_factor_required') {
        return t('approverDevicesSection.useYourPasskeyOrAuthenticatorCodeInstead');
      }
      return t('approverDevicesSection.verificationExpiredPleaseVerifyAgain');
    }
    return err instanceof Error ? err.message : t('approverDevicesSection.failedToRegisterThisDevice');
  };

  const handleRegister = async () => {
    if (isRegistering) return;
    const reauth = buildReauth();
    if (!reauth) return; // submit disabled anyway
    const trimmed = label.trim() || 'This device';
    setIsRegistering(true);
    try {
      // #9007: the SSO grant is single-use and ProfilePage shares it with the
      // MFA cards. Drop it page-wide exactly when it is gone: once the
      // exchange has minted a register grant (consumed, whatever happens in
      // the ceremony after, a dismissed Touch ID prompt included), or when the
      // exchange refuses it (any 400: dead, spent, foreign, or the account now
      // has a password). Everything else (a 401 bearer, the 403 stronger-factor
      // gate, a 503 or a network drop) fails before the server reads the
      // grant, so it stays usable for a retry instead of costing another IdP
      // round-trip. Dropping twice is harmless.
      const isSso = reauth.method === 'sso';
      await runAction({
        // registerApproverDevice runs the full WebAuthn registration ceremony
        // (options → Touch ID/Hello → verify) and resolves void on success. A
        // rejected re-auth (wrong code/password, rate-limited, expired grant)
        // throws with a `status`. Convert that into a non-2xx Response here —
        // rather than letting it escape request() as a throw — so runAction's
        // status-aware isApiFailure branch carries the real status through to
        // the toast and to the 403 handling below (a throw straight out of
        // `request()` always collapses to a generic status-0 "network error"
        // toast, per runAction's documented contract in runAction.test.ts).
        request: async () => {
          try {
            if (isSso) {
              await registerApproverDevice(trimmed, reauth, { onRegisterGrantMinted: () => onSsoReauthGrantSpent?.() });
            } else {
              await registerApproverDevice(trimmed, reauth);
            }
            return OK_RESPONSE;
          } catch (err) {
            if (isSso && (err as { status?: number })?.status === 400) onSsoReauthGrantSpent?.();
            const status = (err as { status?: number })?.status ?? 500;
            return { ok: false, status, json: async () => ({ error: mapRegisterError(err) }) } as Response;
          }
        },
        errorFallback: t('approverDevicesSection.failedToRegisterThisDevice'),
        successMessage: t('approverDevicesSection.thisDeviceCanNowApproveRequests'),
        // A 401 that reaches here is a bearer fetchWithAuth could not refresh.
        // Toast "session expired, reload" rather than relying on the redirect
        // alone, so the failure is never silent.
        treatUnauthorizedAsError: true,
      });
      setLabel('');
      setReauthValue('');
      await load();
    } catch (err) {
      if (err instanceof ActionError) {
        // 403 = stale proof tier or a grant that expired mid-ceremony (see
        // mapRegisterError): keep the label, clear the proof.
        if (err.status === 403) setReauthValue('');
        return; // already toasted by runAction
      }
      // Defensive net only: every documented failure path (400/401/403/429) is
      // converted into a Response above and surfaced via runAction's
      // ActionError branch. This only fires for an error escaping runAction
      // itself (e.g. a bug in runAction), not a live path in normal use.
      showToast({ type: 'error', message: mapRegisterError(err) });
    } finally {
      setIsRegistering(false);
    }
  };

  const handleRevokeConfirm = async () => {
    if (!confirm) return;
    const id = confirm.device.id;
    setMutatingId(id);
    try {
      await runAction({
        request: () => revokeApproverDevice(id),
        errorFallback: t('approverDevicesSection.failedToRevokeDevice'),
        successMessage: t('approverDevicesSection.deviceRevoked'),
      });
      setConfirm(null);
      await load();
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: err instanceof Error ? err.message : t('approverDevicesSection.failedToRevokeDevice') });
      }
    } finally {
      setMutatingId(null);
    }
  };

  const handleRename = async (id: string) => {
    const next = editingLabel.trim();
    if (!next) return;
    setMutatingId(id);
    try {
      await runAction({
        request: () => renameApproverDevice(id, next),
        errorFallback: t('approverDevicesSection.failedToRenameDevice'),
        successMessage: t('approverDevicesSection.deviceRenamed'),
      });
      setDevices((prev) => prev.map((d) => (d.id === id ? { ...d, label: next } : d)));
      setEditingId(null);
      setEditingLabel('');
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: err instanceof Error ? err.message : t('approverDevicesSection.failedToRenameDevice') });
      }
    } finally {
      setMutatingId(null);
    }
  };

  const stepUpPrompt = (
    <StepUpPrompt
      tier={tier}
      reauthValue={reauthValue}
      onChange={setReauthValue}
      disabled={isRegistering}
      sso={{ verified: !!ssoReauthGrantId, starting: isStartingSsoReauth, onStart: onStartSsoReauth }}
    />
  );

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs" data-testid="approver-devices-section">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('approverDevicesSection.approvalSecurity')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('approverDevicesSection.theseDevicesCanConfirmHighRiskApprovalsPrivilegedAccessA')}</p>
      </div>

      <div className="space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t('approverDevicesSection.loadingApproverDevices')}</div>
        ) : loadError ? (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <span>{loadError}</span>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium hover:bg-destructive/5"
            >
              {t('approverDevicesSection.tryAgain')}</button>
          </div>
        ) : activeDevices.length === 0 ? (
          <div
            data-testid="approver-devices-empty"
            className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground"
          >
            {t('approverDevicesSection.noApproverDevicesRegisteredYetSignInToTheBreezeMobileApp')}</div>
        ) : (
          activeDevices.map((device) => {
            const isEditing = editingId === device.id;
            const isMutating = mutatingId === device.id;
            return (
              <div
                key={device.id}
                data-testid={`approver-device-${device.id}`}
                className="rounded-md border bg-muted/30 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
                      {isEditing ? (
                        <input
                          type="text"
                          value={editingLabel}
                          onChange={(e) => setEditingLabel(e.target.value)}
                          className="h-9 rounded-md border bg-background px-3 text-sm"
                          disabled={isMutating}
                          autoFocus
                          data-testid={`approver-device-rename-input-${device.id}`}
                        />
                      ) : (
                        <span
                          data-testid={`approver-device-label-${device.id}`}
                          className="truncate text-sm font-medium"
                        >
                          {deviceTitle(device)}
                        </span>
                      )}
                      {isHardwareAttested(device) ? (
                        <span
                          data-testid={`approver-device-platform-badge-${device.id}`}
                          className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                        >
                          {t('approverDevicesSection.hardwareAttested')}</span>
                      ) : (
                        <span
                          data-testid={`approver-device-platform-badge-${device.id}`}
                          title={t('approverDevicesSection.notAttestedTooltip')}
                          className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                        >
                          {t('approverDevicesSection.notAttested')}</span>
                      )}
                      {device.lastUsedAt === null && (
                        <span
                          data-testid={`approver-device-pending-${device.id}`}
                          className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600"
                        >
                          {t('approverDevicesSection.pendingActivatesOnFirstApproval')}
                        </span>
                      )}
                    </div>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      <dt>{t('approverDevicesSection.registered')}</dt>
                      <dd title={formatAbsolute(device.createdAt)}>{formatRelative(device.createdAt)}</dd>
                      <dt>{t('approverDevicesSection.lastUsed')}</dt>
                      <dd title={formatAbsolute(device.lastUsedAt)}>{formatRelative(device.lastUsedAt)}</dd>
                    </dl>
                  </div>
                  <div className="flex items-center gap-2">
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleRename(device.id)}
                          disabled={!editingLabel.trim() || isMutating}
                          data-testid={`approver-device-rename-save-${device.id}`}
                          className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {isMutating ? t('approverDevicesSection.saving') : t('approverDevicesSection.save')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(null);
                            setEditingLabel('');
                          }}
                          disabled={isMutating}
                          className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {t('approverDevicesSection.cancel')}</button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(device.id);
                            setEditingLabel(deviceTitle(device));
                          }}
                          disabled={!!mutatingId}
                          data-testid={`approver-device-rename-${device.id}`}
                          className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {t('approverDevicesSection.rename')}</button>
                        <button
                          type="button"
                          onClick={() => setConfirm({ device })}
                          disabled={!!mutatingId}
                          data-testid={`approver-device-revoke-${device.id}`}
                          className="h-9 rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {t('approverDevicesSection.revoke')}</button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div ref={registerBlockRef} className="space-y-4 rounded-md border p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{t('approverDevicesSection.registerThisBrowser')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('approverDevicesSection.optionalYourPhoneIsAlreadyAnApproverOnceYouSignInToTheMo')}</p>
        </div>
        {/* The IdP trip is a full-page navigation that loses anything typed, so
            the verify step comes BEFORE the device name. */}
        {tier === 'sso' && stepUpPrompt}
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="approver-device-label">
            {t('approverDevicesSection.deviceName')}</label>
          <input
            id="approver-device-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('approverDevicesSection.frontDeskLaptop')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            disabled={isRegistering}
            data-testid="approver-device-label-input"
          />
        </div>
        {tier !== 'sso' && stepUpPrompt}
        <button
          type="button"
          onClick={() => void handleRegister()}
          disabled={isRegistering || buildReauth() === null}
          data-testid="approver-device-register"
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isRegistering ? t('approverDevicesSection.registering') : t('approverDevicesSection.registerThisDevice')}
        </button>
      </div>

      {confirm && (
        <RevokeConfirmDialog
          device={confirm.device}
          revoking={mutatingId === confirm.device.id}
          onCancel={() => (mutatingId ? null : setConfirm(null))}
          onConfirm={() => void handleRevokeConfirm()}
        />
      )}
    </div>
  );
}

function RevokeConfirmDialog({
  device,
  revoking,
  onCancel,
  onConfirm,
}: {
  device: ApproverDevice;
  revoking: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
            </div>
            <h2 className="text-lg font-semibold">{i18n.t('settings:approverDevicesSection.revokeConfirmTitle', { device: deviceTitle(device) })}</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={revoking}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed"
            aria-label={i18n.t('settings:approverDevicesSection.close')}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <p className="mt-4 text-sm text-muted-foreground">
          {i18n.t('settings:approverDevicesSection.thisDeviceCanNoLongerApproveRequestsWithABiometricYouCan')}</p>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={revoking}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            {i18n.t('settings:approverDevicesSection.cancel')}</button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={revoking}
            data-testid="approver-device-revoke-confirm"
            className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {revoking ? i18n.t('settings:approverDevicesSection.revoking') : i18n.t('settings:approverDevicesSection.revokeDevice')}
          </button>
        </div>
      </div>
    </div>
  );
}
