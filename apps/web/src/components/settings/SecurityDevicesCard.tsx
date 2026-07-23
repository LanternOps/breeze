import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import {
  StepUpError,
  createPasskeyCredential,
  fetchWithAuth,
  mintStepUpGrants,
  type AddFactorStepUp,
  type PasskeyRegistrationOptions,
  type StepUpOperation,
} from '../../stores/auth';
import {
  adoptPasskeyAsApprover,
  listApproverDevices,
  registerApproverDevice,
  revokeApproverDevice,
  renameApproverDevice,
  type RegisterReauth,
} from '../../stores/authenticator';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import StepUpPrompt, { pickReauthTier, type ReauthTier } from './StepUpPrompt';
import { mergeSecurityDevices, type PasskeySummary, type SecurityDeviceRow } from './securityDevices';

// registerApproverDevice runs the full WebAuthn registration ceremony (options
// → Touch ID/Hello → verify) and resolves void on success. A rejected re-auth
// (wrong code/password, rate-limited, expired grant) throws with a `status`.
// Converting that into a non-2xx Response here — rather than letting it
// escape request() as a throw — lets runAction's status-aware isApiFailure
// branch carry the real status through to the toast and to the 403 handling
// below (a throw straight out of `request()` always collapses to a generic
// status-0 "network error" toast, per runAction's documented contract in
// runAction.test.ts). Ported verbatim from the deleted ApproverDevicesSection.
const OK_RESPONSE = { ok: true, status: 200, json: async () => ({ success: true }) } as Response;

/**
 * Unified "Security devices" card (unified-security-devices Phase 2).
 *
 * Renders the merge of `GET /auth/passkeys` (sign-in factors) and
 * `GET /me/approver-devices` (approval factors) as one list, with a badge per
 * capability a row carries. Task 5 moved the two capabilities' state/handlers
 * over; Task 6 added the "also register this browser as an approver"
 * dual-enroll checkbox (`secdev-also-approver`, default checked) to the add
 * flow; Task 7 mounted the card on the profile page and gave it its own
 * `securityDevicesCard.*` i18n keys (replacing the placeholder
 * `profilePage.*` / `approverDevicesSection.*` reuses those tasks used as
 * stand-ins — see task-5-report.md / task-6-report.md for the compromise
 * tables). The old standalone "register this browser as approver" form
 * (`ApproverDevicesSection.tsx`) was deleted in Task 7 — its list rendering
 * moved into this card in Task 5, and once ProfilePage stopped mounting it,
 * nothing else referenced the file.
 *
 * Deliberate remaining shared keys (generic vocabulary genuinely common to
 * both the passkey and approver-device flows, not placeholder stand-ins):
 * `profilePage.rename/save/cancel/delete/deleting/adding/lastUsed/addPasskey/
 * passkeyName/macBookTouchID/currentPassword/...` (button labels and the
 * add-passkey form fields, byte-identical across both flows) and
 * `approverDevicesSection.failedToLoadApproverDevices/tryAgain/
 * failedToRenameDevice/deviceRenamed/failedToRevokeDevice/deviceRevoked/
 * cancel/close/revoking/revokeDevice/
 * thisDeviceCanNoLongerApproveRequestsWithABiometricYouCan/
 * failedToRegisterThisDevice` (approver-axis mutation outcomes and the revoke
 * confirm dialog body — accurate, capability-specific copy, not a
 * placeholder).
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
  // Dual-enroll (unified-security-devices §7.1): default checked — most users
  // adding a passkey want it to also work as an approval device.
  const [alsoRegisterApprover, setAlsoRegisterApprover] = useState(true);

  // --- Approver (approval) state — list-only, moved from ApproverDevicesSection.tsx. ---
  const [devices, setDevices] = useState<import('../../stores/authenticator').ApproverDevice[]>([]);
  const [isLoadingApprovers, setIsLoadingApprovers] = useState(false);
  const [approverLoadError, setApproverLoadError] = useState<string | undefined>();

  // --- Shared per-row action state. ---
  const [editingRowKey, setEditingRowKey] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [mutatingRowKey, setMutatingRowKey] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<SecurityDeviceRow | null>(null);

  // --- Approvals-only register state (spec §4.5) — ported from the deleted
  // ApproverDevicesSection.tsx's register flow. Collapsed by default: this is
  // the secondary path for users who don't want a login passkey at all. ---
  const [showApproverOnlyForm, setShowApproverOnlyForm] = useState(false);
  const [approverLabel, setApproverLabel] = useState('');
  const [approverReauthValue, setApproverReauthValue] = useState('');
  const [isRegisteringApprover, setIsRegisteringApprover] = useState(false);

  // --- "Enable approvals" row action (unified-security-devices Task 9) —
  // adopts an EXISTING sign-in-only passkey as an approver device. Only one
  // row's inline confirm panel can be open at a time. ---
  const [enablingApprovalsRowKey, setEnablingApprovalsRowKey] = useState<string | null>(null);
  const [enableApprovalsReauthValue, setEnableApprovalsReauthValue] = useState('');
  const [isEnablingApprovals, setIsEnablingApprovals] = useState(false);

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

  // Strongest-available-factor tiering for the approvals-only register form —
  // same helper the add-passkey step-up uses, applied to the same passkeys/
  // mfaMethod state (an existing passkey is a stronger factor regardless of
  // which flow adds the next credential).
  const approverTier = useMemo(() => pickReauthTier(passkeys.length, mfaMethod), [passkeys.length, mfaMethod]);

  // Shared by both the approvals-only register form and the Task 9
  // "Enable approvals" row action — same tier, different reauth-value state.
  const buildReauthFromTier = (tier: ReauthTier, value: string): RegisterReauth | null => {
    if (tier === 'passkey') return { method: 'passkey' };
    if (tier === 'totp') return value.length === 6 ? { method: 'totp', code: value } : null;
    return value.length > 0 ? { method: 'password', password: value } : null;
  };

  const buildApproverReauth = (): RegisterReauth | null => buildReauthFromTier(approverTier, approverReauthValue);

  // Task 9's "Enable approvals" row action only ever renders on a row that
  // HAS a passkey (see the row-action gate: `row.passkey && !row.approver`),
  // and that passkey is already counted in `passkeys` — so
  // `pickReauthTier(passkeys.length, mfaMethod)` is statically 'passkey' for
  // every row this action can appear on. Hardcoded rather than computed: an
  // earlier version excluded the row's own passkey from the count to avoid
  // using the credential being adopted as its own re-auth proof, but that
  // exclusion made single-passkey/no-TOTP accounts (this feature's primary
  // persona) fall through to the password tier — and the server's password
  // mint (`POST /authenticator/register-grant`) unconditionally 403s
  // `stronger_factor_required` whenever the account holds ANY active passkey
  // (`userHasStrongerReauthFactor` counts all of them, not "all but this
  // one"), producing a dead end with no route to the password tier at all.
  // The fix is to stop pretending the row's own passkey doesn't count and
  // accept the two-webauthn-prompt UX instead (this proof, then the
  // possession assertion inside adoptPasskeyAsApprover) — see task-9-report.md.
  const ENABLE_APPROVALS_TIER: ReauthTier = 'passkey';

  const buildEnableApprovalsReauth = (): RegisterReauth | null =>
    buildReauthFromTier(ENABLE_APPROVALS_TIER, enableApprovalsReauthValue);

  // Mint a register_approver_device grant via a fresh password proof (Task 6's
  // inline password-fallback branch in handleAddPasskey, extracted so Task 9's
  // "Enable approvals" row action can reuse it instead of duplicating the
  // fetch). Throws (with `status` attached) on failure; callers that want to
  // treat `stronger_factor_required` as a degrade-not-fail case (handleAddPasskey)
  // catch that specific error themselves.
  const mintApproverGrantViaPassword = async (password: string): Promise<string> => {
    const grantResponse = await fetchWithAuth('/authenticator/register-grant', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: password }),
      // A 401/403 here means the password/state check failed for THIS proof —
      // replaying it after a token refresh can only fail again.
      skipUnauthorizedRetry: true,
    });
    const grantData = await grantResponse.json().catch(() => ({}));
    if (!grantResponse.ok) {
      const message = grantData.error ?? grantData.message ?? t('approverDevicesSection.failedToRegisterThisDevice');
      throw Object.assign(new Error(message), { status: grantResponse.status });
    }
    return grantData.registerGrantId;
  };

  // Ported VERBATIM from the deleted ApproverDevicesSection.tsx (branch order
  // and copy are load-bearing — see the inline comments there for why each
  // status/message combination is distinguished). `tier` defaults to the
  // approvals-only register form's tier; Task 9's row action passes its own
  // per-row tier (see `enableApprovalsTierFor`) since it can differ from it.
  const mapRegisterError = (err: unknown, tier: ReauthTier = approverTier): string => {
    if (err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
      return t('approverDevicesSection.registrationCancelled');
    }
    const status = (err as { status?: number })?.status;
    // Task 9: the adopt route 409s when the passkey's credential is already
    // registered as an approver device (race with another tab/session).
    if (status === 409) return t('securityDevicesCard.alreadyRegistered');
    if (status === 401) {
      const isCredentialFailure = err instanceof Error && err.message === 'Invalid credentials';
      if (!isCredentialFailure) return t('approverDevicesSection.sessionExpiredReloadAndTryAgain');
      if (tier === 'totp') return t('approverDevicesSection.incorrectCode');
      if (tier === 'passkey') return t('approverDevicesSection.passkeyVerificationFailed');
      return t('approverDevicesSection.incorrectPassword');
    }
    if (status === 429) return t('approverDevicesSection.tooManyAttemptsTryAgainInAFewMinutes');
    if (status === 403) {
      if (err instanceof Error && err.message === 'stronger_factor_required') {
        return t('approverDevicesSection.useYourPasskeyOrAuthenticatorCodeInstead');
      }
      return t('approverDevicesSection.verificationExpiredPleaseVerifyAgain');
    }
    return err instanceof Error ? err.message : t('approverDevicesSection.failedToRegisterThisDevice');
  };

  const handleRegisterApprover = async () => {
    if (isRegisteringApprover) return;
    const reauth = buildApproverReauth();
    if (!reauth) return; // submit disabled anyway
    const trimmed = approverLabel.trim() || 'This device';
    setIsRegisteringApprover(true);
    try {
      await runAction({
        request: async () => {
          try {
            await registerApproverDevice(trimmed, reauth);
            return OK_RESPONSE;
          } catch (err) {
            const status = (err as { status?: number })?.status ?? 500;
            return { ok: false, status, json: async () => ({ error: mapRegisterError(err) }) } as Response;
          }
        },
        errorFallback: t('approverDevicesSection.failedToRegisterThisDevice'),
        successMessage: t('approverDevicesSection.thisDeviceCanNowApproveRequests'),
        treatUnauthorizedAsError: true,
      });
      setApproverLabel('');
      setApproverReauthValue('');
      setShowApproverOnlyForm(false);
      await loadApprovers();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 403) setApproverReauthValue('');
        return; // already toasted by runAction
      }
      showToast({ type: 'error', message: mapRegisterError(err) });
    } finally {
      setIsRegisteringApprover(false);
    }
  };

  // Task 9: adopt an existing sign-in-only passkey as an approver device.
  // Mint the register_approver_device grant with whichever factor the row's
  // tier calls for (passkey/totp → mintStepUpGrants; password → the shared
  // helper above), then run adoptPasskeyAsApprover's single adopt ceremony.
  const handleEnableApprovals = async (row: SecurityDeviceRow) => {
    if (isEnablingApprovals) return;
    const tier = ENABLE_APPROVALS_TIER;
    const reauth = buildEnableApprovalsReauth();
    if (!reauth) return; // confirm disabled anyway (never actually null — tier is statically 'passkey')
    setIsEnablingApprovals(true);
    try {
      await runAction({
        request: async () => {
          try {
            // Legacy rows predating the Task 3 `credentialId` DTO field carry
            // no credential to pin the adopt ceremony to (adoptPasskeyAsApprover
            // requires one, to filter the step-up challenge's allowCredentials
            // down to this exact passkey). Surface the generic register error
            // instead of calling the store fn with an unusable id.
            if (!row.passkey?.credentialId) {
              return {
                ok: false,
                status: 500,
                json: async () => ({ error: t('approverDevicesSection.failedToRegisterThisDevice') }),
              } as Response;
            }
            let grantId: string;
            if (reauth.method === 'password') {
              grantId = await mintApproverGrantViaPassword(reauth.password);
            } else {
              const proof: AddFactorStepUp =
                reauth.method === 'passkey' ? { method: 'passkey' } : { method: 'totp', code: reauth.code };
              const grants = await mintStepUpGrants(proof, ['register_approver_device']);
              grantId = grants.register_approver_device!;
            }
            await adoptPasskeyAsApprover(grantId, row.passkey.credentialId, row.name);
            return OK_RESPONSE;
          } catch (err) {
            const status = (err as { status?: number })?.status ?? 500;
            return { ok: false, status, json: async () => ({ error: mapRegisterError(err, tier) }) } as Response;
          }
        },
        errorFallback: t('approverDevicesSection.failedToRegisterThisDevice'),
        successMessage: t('securityDevicesCard.approvalsEnabled'),
        treatUnauthorizedAsError: true,
      });
      setEnablingApprovalsRowKey(null);
      setEnableApprovalsReauthValue('');
      // Adopting doesn't mutate the passkey row itself (name/credentialId are
      // unchanged) — only the approver list needs refetching for the merge in
      // `rows` to attach this row's Approvals badge.
      await loadApprovers();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 403) setEnableApprovalsReauthValue('');
        return; // already toasted by runAction
      }
      showToast({ type: 'error', message: mapRegisterError(err, tier) });
    } finally {
      setIsEnablingApprovals(false);
    }
  };

  const handleAddPasskey = async () => {
    if (!passkeyPassword || isAddingPasskey) return;
    if (passkeyStepUpTier === 'sms') return;
    if (passkeyStepUpTier === 'totp' && passkeyStepUpCode.length !== 6) return;
    setPasskeyError(undefined);
    setPasskeySuccess(undefined);
    try {
      setIsAddingPasskey(true);

      // Dual-enroll (unified-security-devices §7.1/§4.2). The early `return`
      // above for tier 'sms' means every path below only ever sees
      // 'none' | 'passkey' | 'totp'.
      const wantsApprover = alsoRegisterApprover;
      let stepUpGrantId: string | undefined;
      let approverRegisterGrantId: string | undefined;
      // Tier 'none' password-fallback degrade: the account turned out to
      // already have a stronger factor (race with another tab/session) — the
      // server's /authenticator/register-grant 403s `stronger_factor_required`.
      // Proceed with the passkey add and surface the partial outcome instead
      // of failing the whole request.
      let approverGrantDegraded = false;

      if (passkeyStepUpTier === 'passkey' || passkeyStepUpTier === 'totp') {
        const proof: AddFactorStepUp = passkeyStepUpTier === 'passkey'
          ? { method: 'passkey' }
          : { method: 'totp', code: passkeyStepUpCode };
        const ops: StepUpOperation[] = wantsApprover
          ? ['add_factor', 'register_approver_device']
          : ['add_factor'];
        const grants = await mintStepUpGrants(proof, ops);
        stepUpGrantId = grants.add_factor;
        approverRegisterGrantId = grants.register_approver_device;
      } else if (passkeyStepUpTier === 'none' && wantsApprover) {
        // Unprotected account: add_factor bypasses step-up entirely on the
        // server, but the approver grant still needs a fresh password proof.
        try {
          approverRegisterGrantId = await mintApproverGrantViaPassword(passkeyPassword);
        } catch (err) {
          const status = (err as { status?: number })?.status;
          if (status === 403 && err instanceof Error && err.message === 'stronger_factor_required') {
            approverGrantDegraded = true;
          } else {
            throw err;
          }
        }
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
          ...(stepUpGrantId ? { stepUpGrantId } : {}),
          // approverRegisterGrantId is a verify-only field — /register/options
          // takes only stepUpGrantId (see apps/api/src/routes/auth/passkeys.ts).
          ...(approverRegisterGrantId ? { approverRegisterGrantId } : {})
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

      const approver = verifyData.approver as
        | { registered: boolean; isPlatformBound?: boolean; deviceId?: string; reason?: string }
        | undefined;
      if (approverGrantDegraded || approver?.registered === false) {
        setPasskeySuccess(t('securityDevicesCard.addedButApprovalsFailed'));
      } else if (approver?.registered && approver.isPlatformBound === false) {
        setPasskeySuccess(t('securityDevicesCard.addedSyncedNote'));
      } else {
        setPasskeySuccess(t('profilePage.passkeyAdded'));
      }

      await loadPasskeys();
      await loadApprovers();
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
        <h2 className="text-lg font-semibold">{t('securityDevicesCard.securityDevices')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('securityDevicesCard.oneListDescription')}</p>
      </div>

      <div className="space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t('securityDevicesCard.loading')}
          </div>
        ) : (
          <>
            {/* Approver-device load failures render alongside the list, never
                instead of it — a hiccup fetching approver devices must not
                hide passkeys that loaded successfully (these were two
                independent cards before the Task 5 merge). */}
            {approverLoadError && (
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
            )}
            {rows.length === 0 ? (
              approverLoadError ? null : (
                <div data-testid="secdev-empty" className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
                  {t('securityDevicesCard.empty')}
                </div>
              )
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
                              {t('securityDevicesCard.signInBadge')}
                            </span>
                          )}
                          {row.approver && (
                            <span
                              data-testid="secdev-badge-approvals"
                              className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                            >
                              {t('securityDevicesCard.approvalsBadge')}
                            </span>
                          )}
                          {row.approver?.isPlatformBound && (
                            <span
                              data-testid="secdev-badge-platform"
                              className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                            >
                              {t('securityDevicesCard.platformBoundBadge')}
                            </span>
                          )}
                          {row.approver && row.approver.lastUsedAt === null && (
                            <span
                              data-testid="secdev-badge-pending"
                              className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600"
                            >
                              {t('securityDevicesCard.pendingBadge')}
                            </span>
                          )}
                          {row.passkey && row.approver && row.approver.isPlatformBound === false && (
                            <span
                              data-testid="secdev-badge-synced"
                              className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                            >
                              {t('securityDevicesCard.syncedBadge')}
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
                                {isMutating ? t('profilePage.deleting') : t('securityDevicesCard.removeSignIn')}
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
                                {t('securityDevicesCard.revokeApprovals')}
                              </button>
                            )}
                            {row.passkey && !row.approver && (
                              <button
                                type="button"
                                onClick={() => {
                                  setEnablingApprovalsRowKey(prev => (prev === row.key ? null : row.key));
                                  setEnableApprovalsReauthValue('');
                                }}
                                disabled={!!mutatingRowKey || isEnablingApprovals}
                                data-testid={`secdev-enable-approvals-${row.key}`}
                                className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {t('securityDevicesCard.enableApprovals')}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    {enablingApprovalsRowKey === row.key && (
                      <div
                        className="mt-3 space-y-3 rounded-md border bg-background p-3"
                        data-testid={`secdev-enable-approvals-panel-${row.key}`}
                      >
                        <StepUpPrompt
                          tier={ENABLE_APPROVALS_TIER}
                          reauthValue={enableApprovalsReauthValue}
                          onChange={setEnableApprovalsReauthValue}
                          disabled={isEnablingApprovals}
                          idPrefix="secdev-adopt"
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void handleEnableApprovals(row)}
                            disabled={isEnablingApprovals || buildEnableApprovalsReauth() === null}
                            data-testid={`secdev-enable-approvals-confirm-${row.key}`}
                            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isEnablingApprovals
                              ? t('approverDevicesSection.registering')
                              : t('securityDevicesCard.enableApprovals')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnablingApprovalsRowKey(null)}
                            disabled={isEnablingApprovals}
                            data-testid={`secdev-enable-approvals-cancel-${row.key}`}
                            className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {t('profilePage.cancel')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </>
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
        {passkeyStepUpTier !== 'sms' && (
          <label className="flex items-start gap-2 text-sm text-muted-foreground" htmlFor="secdev-also-approver">
            <input
              id="secdev-also-approver"
              type="checkbox"
              checked={alsoRegisterApprover}
              onChange={event => setAlsoRegisterApprover(event.target.checked)}
              disabled={isAddingPasskey}
              data-testid="secdev-also-approver"
              className="mt-0.5 h-4 w-4 rounded border"
            />
            <span>{t('securityDevicesCard.alsoUseForApprovals')}</span>
          </label>
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

      {/* Standalone "register this browser for approvals only" path (spec
          §4.5) — for users who don't want a login passkey. Collapsed behind a
          toggle so it doesn't compete with the primary add-passkey flow. */}
      {!showApproverOnlyForm ? (
        <button
          type="button"
          onClick={() => setShowApproverOnlyForm(true)}
          data-testid="secdev-approver-only-toggle"
          className="text-sm font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {t('approverDevicesSection.registerThisBrowser')}
        </button>
      ) : (
        <div className="space-y-4 rounded-md border p-4" data-testid="secdev-approver-only-form">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">{t('approverDevicesSection.registerThisBrowser')}</h3>
            <p className="text-xs text-muted-foreground">
              {t('approverDevicesSection.optionalYourPhoneIsAlreadyAnApproverOnceYouSignInToTheMo')}</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="approver-device-label">
              {t('approverDevicesSection.deviceName')}</label>
            <input
              id="approver-device-label"
              type="text"
              value={approverLabel}
              onChange={e => setApproverLabel(e.target.value)}
              placeholder={t('approverDevicesSection.frontDeskLaptop')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              disabled={isRegisteringApprover}
              data-testid="approver-device-label-input"
            />
          </div>
          <StepUpPrompt
            tier={approverTier}
            reauthValue={approverReauthValue}
            onChange={setApproverReauthValue}
            disabled={isRegisteringApprover}
            idPrefix="approver-stepup"
          />
          <button
            type="button"
            onClick={() => void handleRegisterApprover()}
            disabled={isRegisteringApprover || buildApproverReauth() === null}
            data-testid="approver-device-register"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRegisteringApprover ? t('approverDevicesSection.registering') : t('approverDevicesSection.registerThisDevice')}
          </button>
        </div>
      )}

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
            <h2 className="text-lg font-semibold">{t('securityDevicesCard.revokeApprovals')}: {name}?</h2>
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
