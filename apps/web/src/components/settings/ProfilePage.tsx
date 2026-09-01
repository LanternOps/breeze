import { i18n } from '@/lib/i18n';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import ChangePasswordForm from './ChangePasswordForm';
import ConnectSsoCard from './ConnectSsoCard';
import MFASettings from './MFASettings';
import RemoteToolSettings from './RemoteToolSettings';
import ApproverDevicesSection from './ApproverDevicesSection';
import ThemingSettings from './ThemingSettings';
import { createPasskeyCredential, fetchWithAuth, useAuthStore } from '../../stores/auth';
import type { PasskeyRegistrationOptions, UserPreferences } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { useAvatarBlobUrl } from '@/lib/avatarBlobCache';
import { formatNumber } from '@/lib/i18n/format';
import { runAction } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import {
  stashSsoReauthIntent,
  takeSsoReauthIntent,
  type SsoReauthIntent,
} from '@/lib/ssoReauthIntent';

const createProfileSchema = (t: TFunction) => z.object({
  name: z.string().min(2, t('profilePage.nameMustBeAtLeast2Characters')),
});

type ProfileFormValues = z.infer<ReturnType<typeof createProfileSchema>>;

type User = {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  mfaEnabled?: boolean;
  mfaMethod?: string | null;
  // #4018: surfaced by GET /users/me. `false` means an SSO-provisioned account
  // with no password, which cannot satisfy the password step-up the MFA
  // enrollment endpoints normally demand. Absent = unknown → password road.
  hasPassword?: boolean;
  preferences?: UserPreferences;
};

// Typed reason codes the SSO re-auth callback redirects back with
// (`/settings/profile?ssoReauthError=<code>`). Anything not listed falls back
// to the generic copy — the server is free to add codes without this going
// silent.
//
// NAMESPACED, matching ConnectSsoCard's `ssoLinkError`. A bare `error` param is
// a name every other feature on this page could reasonably claim, and this
// handler would toast SSO copy for any of them.
const SSO_REAUTH_ERROR_PARAM = 'ssoReauthError';
const SSO_REAUTH_ERROR_KEYS: Record<string, string> = {
  // The IdP answered without honouring prompt=login / max_age=0, so nothing was
  // actually re-verified. This is the one an admin can fix, so it says so.
  reauth_not_fresh: 'profilePage.ssoReauthNotFresh',
  identity_mismatch: 'profilePage.ssoReauthIdentityMismatch',
  session_invalid: 'profilePage.ssoReauthSessionInvalid',
  password_set: 'profilePage.ssoReauthPasswordSet',
  reauth_unavailable: 'profilePage.ssoReauthUnavailable',
  // Reached when the provider is disabled, or its config_version is bumped by
  // an admin edit mid-flight — both now land here instead of on /login.
  provider_inactive: 'profilePage.ssoReauthProviderInactive',
  config_changed: 'profilePage.ssoReauthConfigChanged',
  email_unverified: 'profilePage.ssoReauthEmailUnverified',
};

/** Reads and CONSUMES `?ssoReauthError=<code>` from the query string.
 *
 *  Stripping is not cosmetic: `showToast` has no dedupe by design, so a handler
 *  that leaves the param in place re-toasts on every reload and on every shared
 *  link — and, because react-i18next swaps `t`'s identity once its resources
 *  finish loading, fires TWICE on a single page load. Consuming the param makes
 *  the effect idempotent regardless of how often it runs. Same pattern as
 *  M365MailboxCard's `ticketMailbox`. The fragment and every other query param
 *  are preserved — only ours is removed. */
function takeSsoReauthErrorFromQuery(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const code = params.get(SSO_REAUTH_ERROR_PARAM);
  if (!code) return null;
  params.delete(SSO_REAUTH_ERROR_PARAM);
  const qs = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`,
  );
  return code;
}

/** Reads and CONSUMES the `#ssoReauthGrant=<id>` fragment the SSO callback
 *  redirects back with. The grant is single-use, so the fragment is stripped in
 *  the same tick it is read: leaving it in the address bar invites a confusing
 *  second attempt against a proof that has already been spent (a reload would
 *  replay it and fail). The query string is preserved — only the fragment is
 *  ours to clear. */
function takeSsoReauthGrantFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const match = /^#ssoReauthGrant=(.+)$/.exec(window.location.hash);
  if (!match) return null;
  const grantId = decodeURIComponent(match[1]);
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return grantId;
}

type PasskeySummary = {
  id: string;
  name: string;
  createdAt?: string;
  lastUsedAt?: string | null;
};

const ALLOWED_AVATAR_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${formatNumber(n / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
  return `${formatNumber(n / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

function formatPasskeyDate(value?: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

type ProfilePageProps = {
  initialUser?: User;
};

export default function ProfilePage({ initialUser }: ProfilePageProps) {
  const { t } = useTranslation('settings');
  const [user, setUser] = useState<User | null>(initialUser ?? null);
  const [isLoadingUser, setIsLoadingUser] = useState(!initialUser);
  const [profileError, setProfileError] = useState<string | undefined>();
  const [profileSuccess, setProfileSuccess] = useState<string | undefined>();
  const [tourResetMsg, setTourResetMsg] = useState<string | undefined>();
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [passwordSuccess, setPasswordSuccess] = useState<string | undefined>();
  const [mfaError, setMfaError] = useState<string | undefined>();
  const [mfaSuccess, setMfaSuccess] = useState<string | undefined>();
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | undefined>();
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | undefined>();
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [passkeyName, setPasskeyName] = useState('');
  const [passkeyPassword, setPasskeyPassword] = useState('');
  const [passkeyError, setPasskeyError] = useState<string | undefined>();
  const [passkeySuccess, setPasskeySuccess] = useState<string | undefined>();
  const [isLoadingPasskeys, setIsLoadingPasskeys] = useState(false);
  const [isAddingPasskey, setIsAddingPasskey] = useState(false);
  const [editingPasskeyId, setEditingPasskeyId] = useState<string | null>(null);
  const [editingPasskeyName, setEditingPasskeyName] = useState('');
  const [mutatingPasskeyId, setMutatingPasskeyId] = useState<string | null>(null);
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [mfaLoading, setMfaLoading] = useState(false);
  // #4018: the SSO re-auth grant picked up from the redirect fragment. Held for
  // the rest of the enrollment flow because /mfa/setup consumes it
  // non-destructively and the terminal /mfa/enable burns it — one IdP
  // round-trip covers both calls.
  const [ssoReauthGrantId, setSsoReauthGrantId] = useState<string | null>(null);
  const [ssoSetupReady, setSsoSetupReady] = useState(false);
  const [isStartingSsoReauth, setIsStartingSsoReauth] = useState(false);
  // #4055: this page load IS the return leg of a round-trip the PASSKEY card
  // started, so the passkey card — not the TOTP one — is where the user must be
  // put down. Distinct from `hasSsoReauthGrant`, which only says a grant is in
  // hand and stays true for the rest of the flow: this fires the one-shot
  // "bring the card to the user" landing and then stops mattering.
  const [passkeyReauthReturn, setPasskeyReauthReturn] = useState(false);
  const passkeyNameRef = useRef<HTMLInputElement | null>(null);
  const passkeyLandingDone = useRef(false);

  // Avatar upload state
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [isDeletingAvatar, setIsDeletingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState<string | undefined>();
  const [avatarSuccess, setAvatarSuccess] = useState<string | undefined>();
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const updateAuthUser = useAuthStore((s) => s.updateUser);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<ProfileFormValues>({
    resolver: zodResolver(createProfileSchema(t)),
    defaultValues: {
      name: user?.name ?? '',
    }
  });

  const isProfileLoading = useMemo(
    () => isUpdatingProfile || isSubmitting,
    [isUpdatingProfile, isSubmitting]
  );
  // Preview priority: locally-selected file (object URL) → user's current
  // avatar (fetched as blob through fetchWithAuth so the Bearer token gets
  // attached — the API requires auth on GET /users/:id/avatar, and <img src=>
  // can't send headers).
  const resolvedAvatarUrl = useAvatarBlobUrl(avatarPreview ? null : user?.avatarUrl ?? null);
  const previewAvatarUrl = avatarPreview || resolvedAvatarUrl || '';

  // Fetch user data on mount
  useEffect(() => {
    if (initialUser) {
      return;
    }

    const fetchUser = async () => {
      try {
        setIsLoadingUser(true);
        const response = await fetchWithAuth('/users/me');
        if (!response.ok) {
          if (response.status === 401) {
            void navigateTo('/login', { replace: true });
            return;
          }
          throw new Error(t('profilePage.failedToFetchUserData'));
        }
        const userData = await response.json();
        setUser(userData);
        reset({
          name: userData.name ?? '',
        });
      } catch {
        setProfileError(t('profilePage.failedToLoadProfileData'));
      } finally {
        setIsLoadingUser(false);
      }
    };

    fetchUser();
  }, [initialUser, reset]);

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
  }, []);

  useEffect(() => {
    loadPasskeys();
  }, [loadPasskeys]);

  const clearMessages = useCallback(() => {
    setProfileError(undefined);
    setProfileSuccess(undefined);
  }, []);

  const handleProfileSubmit = async (values: ProfileFormValues) => {
    clearMessages();
    try {
      setIsUpdatingProfile(true);
      const payload = {
        name: values.name.trim(),
      };

      const response = await fetchWithAuth('/users/me', {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message ?? t('profilePage.failedToUpdateProfile'));
      }

      const updatedUser = await response.json();
      setUser(updatedUser);
      reset({
        name: updatedUser.name ?? '',
      });
      setProfileSuccess(t('profilePage.profileUpdatedSuccessfully'));
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : t('profilePage.failedToUpdateProfile'));
    } finally {
      setIsUpdatingProfile(false);
    }
  };

  // --- Avatar upload handlers ---

  const validateAvatarFile = useCallback((file: File): string | null => {
    if (!ALLOWED_AVATAR_MIMES.includes(file.type)) {
      return t('profilePage.unsupportedAvatarType');
    }
    if (file.size > MAX_AVATAR_BYTES) {
      return t('profilePage.avatarTooLarge', { max: formatBytes(MAX_AVATAR_BYTES) });
    }
    if (file.size === 0) {
      return t('profilePage.fileIsEmpty');
    }
    return null;
  }, [t]);

  const clearAvatarMessages = useCallback(() => {
    setAvatarError(undefined);
    setAvatarSuccess(undefined);
  }, []);

  const selectAvatarFile = useCallback((file: File) => {
    clearAvatarMessages();
    const err = validateAvatarFile(file);
    if (err) {
      setAvatarError(err);
      return;
    }
    // Revoke any previous preview to avoid leaks.
    if (avatarPreview && avatarPreview.startsWith('blob:')) {
      URL.revokeObjectURL(avatarPreview);
    }
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  }, [avatarPreview, validateAvatarFile, clearAvatarMessages]);

  const cancelAvatarSelection = useCallback(() => {
    if (avatarPreview && avatarPreview.startsWith('blob:')) {
      URL.revokeObjectURL(avatarPreview);
    }
    setAvatarFile(null);
    setAvatarPreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [avatarPreview]);

  const handleAvatarUpload = useCallback(async () => {
    if (!avatarFile) return;
    clearAvatarMessages();

    try {
      setIsUploadingAvatar(true);
      const form = new FormData();
      form.append('file', avatarFile);
      // fetchWithAuth skips its default JSON content-type for FormData bodies so
      // the browser can set multipart/form-data with the correct boundary.
      const response = await fetchWithAuth('/users/me/avatar', {
        method: 'POST',
        body: form,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error ?? errorData.message ?? t('profilePage.failedToUploadAvatar'));
      }

      const data = await response.json();
      const newAvatarUrl: string = data.avatarUrl;
      setUser((prev) => (prev ? { ...prev, avatarUrl: newAvatarUrl } : prev));
      // Update the global auth store so the Header avatar refreshes immediately.
      updateAuthUser({ avatarUrl: newAvatarUrl });

      // Clear local preview state — the canonical URL will be used now.
      cancelAvatarSelection();
      setAvatarSuccess(t('profilePage.avatarUpdated'));
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : t('profilePage.failedToUploadAvatar'));
    } finally {
      setIsUploadingAvatar(false);
    }
  }, [avatarFile, clearAvatarMessages, cancelAvatarSelection, updateAuthUser]);

  const handleAvatarDelete = useCallback(async () => {
    clearAvatarMessages();
    try {
      setIsDeletingAvatar(true);
      const response = await fetchWithAuth('/users/me/avatar', { method: 'DELETE' });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error ?? errorData.message ?? t('profilePage.failedToRemoveAvatar'));
      }
      setUser((prev) => (prev ? { ...prev, avatarUrl: undefined } : prev));
      updateAuthUser({ avatarUrl: undefined });
      cancelAvatarSelection();
      setAvatarSuccess(t('profilePage.avatarRemoved'));
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : t('profilePage.failedToRemoveAvatar'));
    } finally {
      setIsDeletingAvatar(false);
    }
  }, [clearAvatarMessages, cancelAvatarSelection, updateAuthUser]);

  const handleAvatarFilePicked = useCallback((evt: React.ChangeEvent<HTMLInputElement>) => {
    const file = evt.target.files?.[0];
    if (file) selectAvatarFile(file);
  }, [selectAvatarFile]);

  const handleAvatarDrop = useCallback((evt: React.DragEvent<HTMLDivElement>) => {
    evt.preventDefault();
    setIsDragging(false);
    const file = evt.dataTransfer.files?.[0];
    if (file) selectAvatarFile(file);
  }, [selectAvatarFile]);

  // Clean up object URLs on unmount.
  useEffect(() => {
    return () => {
      if (avatarPreview && avatarPreview.startsWith('blob:')) {
        URL.revokeObjectURL(avatarPreview);
      }
    };
  }, [avatarPreview]);

  const handlePasswordChange = async (values: {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  }) => {
    setPasswordError(undefined);
    setPasswordSuccess(undefined);
    try {
      setIsChangingPassword(true);
      const response = await fetchWithAuth('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: values.currentPassword,
          newPassword: values.newPassword
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message ?? t('profilePage.failedToChangePassword'));
      }

      setPasswordSuccess(t('profilePage.passwordChangedSuccessfully'));
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : t('profilePage.failedToChangePassword'));
    } finally {
      setIsChangingPassword(false);
    }
  };

  // The enrollment endpoints accept EITHER proof (#4018): a password, or an
  // SSO re-auth grant for an account that has no password. Exactly one is sent.
  const requestMfaSetup = useCallback(
    async (proof: { currentPassword: string } | { ssoReauthGrantId: string }): Promise<boolean> => {
      setMfaError(undefined);
      setMfaSuccess(undefined);
      // Clear any QR code from a prior aborted attempt before issuing a new one.
      setQrCodeDataUrl(undefined);
      try {
        setMfaLoading(true);
        const response = await fetchWithAuth('/auth/mfa/setup', {
          method: 'POST',
          body: JSON.stringify(proof)
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.error ?? errorData.message ?? t('profilePage.failedToStartMfaHttp', { status: response.status })
          );
        }

        const data = await response.json();
        setQrCodeDataUrl(data.qrCodeDataUrl);
        return true;
      } catch (error) {
        setMfaError(error instanceof Error ? error.message : t('profilePage.failedToStartMFASetup'));
        return false;
      } finally {
        setMfaLoading(false);
      }
    },
    [t]
  );

  const handleMfaRequestSetup = (currentPassword: string): Promise<boolean> =>
    requestMfaSetup({ currentPassword });

  // #4018, ONE source of truth for both enrollment roads on this page (TOTP via
  // MFASettings, passkeys via the card below). `undefined` is UNKNOWN — a
  // session persisted before /users/me carried the field — and must keep the
  // password road, which is the fail-safe direction: the server rejects a wrong
  // password, whereas wrongly hiding the prompt strands a password user.
  const isPasswordless = user?.hasPassword === false;
  // The grant is minted by the SSO re-auth callback and held only here. Both
  // register/options (validate, non-consuming) and register/verify (consume)
  // take the SAME id, so one IdP round-trip installs exactly one factor —
  // whichever road spends it first.
  const hasSsoReauthGrant = ssoReauthGrantId !== null;

  // Consume an `#ssoReauthGrant=<id>` handed back by the SSO callback: the user
  // has just re-proved their identity at the IdP. Mount-only by design — the
  // fragment is stripped as it is read, so this can never fire twice.
  //
  // #4055: BOTH the TOTP card and the passkey card start the same round-trip
  // and the callback returns everyone to the same fragment, so the return leg
  // has to be told which card to go back to. It used to run /mfa/setup
  // unconditionally, which dropped a user who wanted a PASSKEY onto the TOTP QR
  // screen and minted a TOTP secret nobody asked for — one that then sits in
  // Redis under `mfa:setup:<userId>` until its TTL expires, because only the
  // TOTP confirm step clears it.
  useEffect(() => {
    const grantId = takeSsoReauthGrantFromHash();
    // Consumed unconditionally, grant or not: an error return
    // (`?ssoReauthError=`) has nothing to route, and an intent left behind
    // would misroute the NEXT round-trip instead.
    const intent = takeSsoReauthIntent();
    if (!grantId) return;
    setSsoReauthGrantId(grantId);
    if (intent === 'passkey') {
      // Deliberately NO /mfa/setup here. The passkey road spends the same grant
      // on register/options + register/verify, which the card below already
      // knows how to do once `hasSsoReauthGrant` is true.
      setPasskeyReauthReturn(true);
      return;
    }
    // `null` (nothing recorded — storage blocked, or a link from before #4055)
    // keeps the historical TOTP road rather than stranding the user on a page
    // where neither card does anything.
    void requestMfaSetup({ ssoReauthGrantId: grantId }).then((ok) => {
      // Only open the QR view when the server actually issued a secret. On
      // failure the error banner is already set and the user stays on the
      // status card, which is where the retry button lives.
      if (ok) setSsoSetupReady(true);
    });
    // Empty deps ON PURPOSE: `requestMfaSetup` is deliberately excluded so a
    // re-created callback identity can never re-fire this. It is safe either
    // way — the fragment is stripped as it is read — but re-running would burn
    // a second /mfa/setup call for nothing.
  }, []);

  // #4055: the IdP trip is a full-page navigation, so the browser puts the user
  // back at the TOP of a long settings page while the passkey card they left
  // from sits below the fold. Routing them back to it means actually taking
  // them there. Focus does the same job for keyboard and screen-reader users,
  // and lands on the one field they still have to fill in.
  //
  // A CALLBACK ref, keyed on the flag, rather than an effect over an object
  // ref. The real page is `<ProfilePage client:load />` with no `initialUser`,
  // so the component sits behind the `isLoadingUser` early return below while
  // GET /users/me is in flight — the card does not exist in the DOM at the
  // moment the mount effect sets the flag, and an effect keyed only on the flag
  // would find a null ref and never run again. React re-invokes a callback ref
  // whose identity changed, so this fires whichever way the race lands: card
  // already mounted (identity change re-invokes it) or card mounted later (the
  // attach invokes it). Child refs attach before parents, so the name input is
  // already populated by the time this runs. The latch keeps it one-shot.
  const passkeyCardRef = useCallback((node: HTMLDivElement | null) => {
    if (!node || !passkeyReauthReturn || passkeyLandingDone.current) return;
    passkeyLandingDone.current = true;
    // jsdom has no layout and so no `scrollIntoView`; optional-call it.
    node.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    passkeyNameRef.current?.focus?.();
  }, [passkeyReauthReturn]);

  // Surface the callback's failure codes
  // (`/settings/profile?ssoReauthError=<code>`), exactly once.
  //
  // Mount-only, and the param is consumed as it is read. Both matter: this used
  // to depend on `[t]`, and react-i18next hands back a NEW `t` identity once its
  // resources finish loading async, so the effect re-ran and — showToast having
  // no dedupe — the user saw the same error toast twice. Leaving the param in
  // the URL also re-toasted on every reload, forever.
  useEffect(() => {
    const code = takeSsoReauthErrorFromQuery();
    if (!code) return;
    const key = SSO_REAUTH_ERROR_KEYS[code];
    // An unrecognized code must still say SOMETHING — a silent no-op here would
    // leave the user staring at an unchanged page after a failed IdP trip.
    showToast({
      type: 'error',
      message: key ? t(/* i18n-dynamic */ key) : t('profilePage.ssoReauthFailed'),
    });
    // Empty deps ON PURPOSE — see above. `t` is read at first render, which is
    // the correct language for a toast fired at mount. No eslint-disable here:
    // this repo's web eslint config carries no react-hooks plugin, so a
    // directive for `exhaustive-deps` is itself an error ("Definition for rule
    // ... was not found") and fails the Lint job.
  }, []);

  // #4055: `intent` is the CARD this trip started from. Every scrap of React
  // state dies at the navigation below and the callback's return URL is minted
  // server-side, so the only way the return leg can know where to put the user
  // down is to write it somewhere that survives the trip.
  const handleSsoReauthStart = async (intent: SsoReauthIntent) => {
    setMfaError(undefined);
    setMfaSuccess(undefined);
    setIsStartingSsoReauth(true);
    try {
      const body = await runAction<{ authUrl: string }>({
        request: () => fetchWithAuth('/sso/reauth/start', { method: 'POST' }),
        errorFallback: t('profilePage.couldNotStartIdentityProviderVerification'),
      });
      if (body?.authUrl) {
        // Recorded only once there is somewhere to go: a failed start never
        // leaves the page, so writing it earlier would just leave a stale value
        // for a trip that did not happen.
        stashSsoReauthIntent(intent);
        // External IdP URL — a full-page navigation, not the SPA router (which
        // rejects an off-origin path as an open redirect).
        window.location.assign(body.authUrl);
        return;
      }
      // 200 with no authUrl: nothing to navigate to, and runAction saw a
      // success. Say so rather than leaving the button spinning silently.
      showToast({ type: 'error', message: t('profilePage.couldNotStartIdentityProviderVerification') });
      setIsStartingSsoReauth(false);
    } catch {
      // runAction already toasted the failure.
      setIsStartingSsoReauth(false);
    }
  };

  /**
   * #4413: returns FALSE when the write was rejected. MFASettings keeps the QR
   * view (and the password behind it) open on `false`, so a mistyped code costs
   * one retry instead of a whole re-enrollment against a fresh secret.
   */
  const handleMfaEnable = async (code: string, currentPassword: string): Promise<boolean> => {
    setMfaError(undefined);
    setMfaSuccess(undefined);
    try {
      setMfaLoading(true);
      // Mirror the setup call: send whichever proof this account actually has.
      // A passwordless account with no grant left has NOTHING to send, and the
      // server answers `enrollment_proof_required`. MFASettings withholds the
      // submit in that state (it shows the IdP re-verify CTA instead), so this
      // is the belt-and-braces half of the same rule.
      if (!currentPassword && !ssoReauthGrantId && isPasswordless) {
        setMfaError(t('profilePage.ssoReauthProofExpired'));
        return false;
      }
      const proof = currentPassword
        ? { currentPassword }
        : ssoReauthGrantId
          ? { ssoReauthGrantId }
          : {};
      const response = await fetchWithAuth('/auth/mfa/enable', {
        method: 'POST',
        // #4413: this endpoint answers 401 for "that TOTP is wrong", not for
        // "your bearer expired". Handing that to fetchWithAuth's generic 401
        // path either replays a single-use code or — when the refresh does not
        // restore — signs the user out mid-enrollment (auth.ts handleSessionExpired).
        // Take the raw 401 and render it ourselves. The durable fix is on the
        // API side (400/422 + a stable code for a rejected factor proof).
        skipUnauthorizedRetry: true,
        body: JSON.stringify({ code, ...proof })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error ?? errorData.message ?? t('profilePage.failedToEnableMfaHttp', { status: response.status })
        );
      }

      const data = await response.json();
      setUser(prev => (prev ? { ...prev, mfaEnabled: true } : null));
      setRecoveryCodes(data.recoveryCodes);
      setMfaSuccess(t('profilePage.multiFactorAuthenticationEnabledSuccessfully'));
      setQrCodeDataUrl(undefined);
      // /mfa/enable is the terminal write that BURNS the grant. Drop it so a
      // later action on this page can't retry with a proof the server has
      // already spent.
      setSsoReauthGrantId(null);
      setSsoSetupReady(false);
      return true;
    } catch (error) {
      setMfaError(error instanceof Error ? error.message : t('profilePage.failedToEnableMFA'));
      return false;
    } finally {
      setMfaLoading(false);
    }
  };

  const handleMfaDisable = async (code: string, currentPassword: string): Promise<boolean> => {
    setMfaError(undefined);
    setMfaSuccess(undefined);
    try {
      setMfaLoading(true);
      const response = await fetchWithAuth('/auth/mfa/disable', {
        method: 'POST',
        // Same overloaded 401 as /mfa/enable above — see the comment there.
        skipUnauthorizedRetry: true,
        body: JSON.stringify({ code, currentPassword })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error ?? errorData.message ?? t('profilePage.failedToDisableMfaHttp', { status: response.status })
        );
      }

      setUser(prev => (prev ? { ...prev, mfaEnabled: false } : null));
      setRecoveryCodes(undefined);
      setMfaSuccess(t('profilePage.multiFactorAuthenticationDisabled'));
      return true;
    } catch (error) {
      setMfaError(error instanceof Error ? error.message : t('profilePage.failedToDisableMFA'));
      return false;
    } finally {
      setMfaLoading(false);
    }
  };

  /**
   * #4414: this endpoint REGENERATES — it invalidates every code the user
   * already holds. MFASettings gates it behind an explicit confirm and only
   * reveals codes when this resolves `true`, so a failed call can never
   * re-display the previous set as though it were the new one.
   */
  const handleGenerateRecoveryCodes = async (currentPassword: string): Promise<boolean> => {
    setMfaError(undefined);
    setMfaSuccess(undefined);
    try {
      setMfaLoading(true);
      const response = await fetchWithAuth('/auth/mfa/recovery-codes', {
        method: 'POST',
        // Same overloaded 401 as /mfa/enable above — a wrong password here is a
        // rejected proof, not an expired session.
        skipUnauthorizedRetry: true,
        body: JSON.stringify({ currentPassword })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error ?? errorData.message ?? t('profilePage.failedToGenerateRecoveryCodes')
        );
      }

      const data = await response.json();
      setRecoveryCodes(data.recoveryCodes);
      setMfaSuccess(t('profilePage.newRecoveryCodesGenerated'));
      return true;
    } catch (error) {
      setMfaError(error instanceof Error ? error.message : t('profilePage.failedToGenerateRecoveryCodes'));
      return false;
    } finally {
      setMfaLoading(false);
    }
  };

  const handleAddPasskey = async () => {
    if (isAddingPasskey) return;
    // #4018: a passwordless SSO account proves identity with a fresh forced IdP
    // round-trip instead of a password it does not have. Without this the
    // handler hard-returned on `!passkeyPassword` and a passwordless user could
    // never register a passkey at all — the exact dead end this feature exists
    // to remove, with the API side already accepting the grant and no caller.
    if (isPasswordless) {
      if (!ssoReauthGrantId) {
        // Belt-and-braces: the card renders the re-verify CTA instead of a
        // submit in this state, so this is only reachable programmatically.
        setPasskeyError(t('profilePage.passkeyIdpVerificationRequired'));
        return;
      }
    } else if (!passkeyPassword) {
      return;
    }
    setPasskeyError(undefined);
    setPasskeySuccess(undefined);
    try {
      setIsAddingPasskey(true);
      const label = passkeyName.trim() || 'Passkey';
      // The SAME grant id goes to BOTH calls: register/options only VALIDATES
      // it, register/verify CONSUMES it. Minting a second grant in between
      // would fail the consume — each is bound to the epochs + sid captured at
      // mint time — and burn the user's round trip for nothing.
      //
      // The password road is deliberately asymmetric: it proves itself ONCE at
      // register/options. registerVerifySchema carries no password field at all
      // (the server calls resolveEnrollmentStepUp there with
      // `passwordAlreadyProven`), so re-sending the plaintext password would be
      // a second exposure buying nothing.
      const optionsProof = isPasswordless
        ? { ssoReauthGrantId }
        : { currentPassword: passkeyPassword };
      const verifyProof = isPasswordless ? { ssoReauthGrantId } : {};
      const optionsResponse = await fetchWithAuth('/auth/passkeys/register/options', {
        method: 'POST',
        body: JSON.stringify({ ...optionsProof, name: label })
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
        body: JSON.stringify({ name: label, credential, ...verifyProof })
      });

      const verifyData = await verifyResponse.json().catch(() => ({}));
      if (!verifyResponse.ok) {
        throw new Error(
          verifyData.error ?? verifyData.message ?? t('profilePage.failedToSavePasskeyHttp', { status: verifyResponse.status })
        );
      }

      setUser(prev => (prev ? { ...prev, mfaEnabled: true } : null));
      setPasskeyName('');
      setPasskeyPassword('');
      // register/verify is the terminal write that BURNS the grant. Drop it so
      // a later action on this page can't retry with a proof the server has
      // already spent — same rule as the TOTP terminal write.
      setSsoReauthGrantId(null);
      setSsoSetupReady(false);
      if (Array.isArray(verifyData.recoveryCodes)) {
        setRecoveryCodes(verifyData.recoveryCodes);
      }
      setPasskeySuccess(t('profilePage.passkeyAdded'));
      await loadPasskeys();
    } catch (error) {
      if (error instanceof Error && error.name === 'NotAllowedError') {
        setPasskeyError(t('profilePage.passkeySetupWasCanceledOrTimedOut'));
      } else {
        setPasskeyError(error instanceof Error ? error.message : t('profilePage.failedToAddPasskey'));
      }
    } finally {
      setIsAddingPasskey(false);
    }
  };

  const handleRenamePasskey = async (passkeyId: string) => {
    const name = editingPasskeyName.trim();
    if (!name || mutatingPasskeyId) return;
    setPasskeyError(undefined);
    setPasskeySuccess(undefined);
    try {
      setMutatingPasskeyId(passkeyId);
      const response = await fetchWithAuth(`/auth/passkeys/${encodeURIComponent(passkeyId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error ?? data.message ?? t('profilePage.failedToRenamePasskeyHttp', { status: response.status }));
      }
      setPasskeys(prev => prev.map(passkey => (
        passkey.id === passkeyId ? { ...passkey, name: data.passkey?.name ?? name } : passkey
      )));
      setEditingPasskeyId(null);
      setEditingPasskeyName('');
      setPasskeySuccess(t('profilePage.passkeyRenamed'));
    } catch (error) {
      setPasskeyError(error instanceof Error ? error.message : t('profilePage.failedToRenamePasskey'));
    } finally {
      setMutatingPasskeyId(null);
    }
  };

  const handleDeletePasskey = async (passkeyId: string) => {
    if (mutatingPasskeyId) return;
    setPasskeyError(undefined);
    setPasskeySuccess(undefined);
    if (!passkeyPassword) {
      setPasskeyError(t('profilePage.currentPasswordIsRequiredToDeleteAPasskey'));
      return;
    }
    try {
      setMutatingPasskeyId(passkeyId);
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
      setMutatingPasskeyId(null);
    }
  };

  if (isLoadingUser) {
    return (
      <div className="flex u-min-h-px-400 items-center justify-center">
        <div className="text-sm text-muted-foreground">{t('profilePage.loadingProfile')}</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('profilePage.profileSettings')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('profilePage.manageYourAccountSettingsAndSecurityPreferences')}</p>
      </div>

      {/* Profile Information */}
      <form
        onSubmit={handleSubmit(handleProfileSubmit)}
        className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
      >
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t('profilePage.profileInformation')}</h2>
          <p className="text-sm text-muted-foreground">{t('profilePage.updateYourPersonalDetails')}</p>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-medium">{t('profilePage.avatar')}</p>
          <div className="flex items-start gap-4">
            <div
              data-testid="avatar-dropzone"
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleAvatarDrop}
              className={`flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-full border text-xl font-medium ${
                isDragging
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-transparent bg-muted text-muted-foreground'
              }`}
            >
              {previewAvatarUrl ? (
                <img
                  src={previewAvatarUrl}
                  alt={user?.name ?? t('profilePage.userAvatar')}
                  className="h-24 w-24 rounded-full object-cover"
                />
              ) : (
                user?.name?.charAt(0).toUpperCase() ?? '?'
              )}
            </div>
            <div className="flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={handleAvatarFilePicked}
                  data-testid="avatar-file-input"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploadingAvatar || isDeletingAvatar}
                  className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {t('profilePage.uploadNewPicture')}</button>
                {user?.avatarUrl && !avatarFile && (
                  <button
                    type="button"
                    onClick={handleAvatarDelete}
                    disabled={isUploadingAvatar || isDeletingAvatar}
                    className="rounded-md border px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isDeletingAvatar ? t('profilePage.removing') : t('profilePage.remove')}
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('profilePage.pNGJPGOrWebPMax5MBDragAndDropOntoTheCircleOrClickUpload')}</p>
              {avatarFile && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  <span className="truncate">{avatarFile.name}</span>
                  <span className="text-xs text-muted-foreground">{formatBytes(avatarFile.size)}</span>
                  <div className="ml-auto flex gap-2">
                    <button
                      type="button"
                      onClick={handleAvatarUpload}
                      disabled={isUploadingAvatar}
                      className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isUploadingAvatar ? t('profilePage.uploading') : t('profilePage.upload')}
                    </button>
                    <button
                      type="button"
                      onClick={cancelAvatarSelection}
                      disabled={isUploadingAvatar}
                      className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {t('profilePage.cancel')}</button>
                  </div>
                </div>
              )}
              {avatarError && (
                <p className="text-sm text-destructive" role="alert">{avatarError}</p>
              )}
              {avatarSuccess && (
                <p className="text-sm text-emerald-600" role="status">{avatarSuccess}</p>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="name" className="text-sm font-medium">
            {t('profilePage.name')}</label>
          <input
            id="name"
            type="text"
            autoComplete="name"
            placeholder={t('profilePage.yourName')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="email" className="text-sm font-medium">
            {t('profilePage.email')}</label>
          <input
            id="email"
            type="email"
            value={user?.email ?? ''}
            disabled
            className="h-10 w-full rounded-md border bg-muted px-3 text-sm text-muted-foreground"
          />
          <p className="text-xs text-muted-foreground">
            {t('profilePage.emailCannotBeChangedContactSupportForAssistance')}</p>
        </div>

        {profileError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {profileError}
          </div>
        )}

        {profileSuccess && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600">
            {profileSuccess}
          </div>
        )}

        <button
          type="submit"
          disabled={isProfileLoading}
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isProfileLoading ? t('profilePage.saving') : t('profilePage.saveChanges')}
        </button>
      </form>

      {/* Change Password */}
      <ChangePasswordForm
        onSubmit={handlePasswordChange}
        errorMessage={passwordError}
        successMessage={passwordSuccess}
        loading={isChangingPassword}
      />

      {/* MFA Settings */}
      <MFASettings
        enabled={user?.mfaEnabled ?? false}
        hasPassword={user?.hasPassword}
        onSsoReauth={() => handleSsoReauthStart('totp')}
        ssoSetupReady={ssoSetupReady}
        ssoReauthGrantAvailable={hasSsoReauthGrant}
        qrCodeDataUrl={qrCodeDataUrl}
        recoveryCodes={recoveryCodes}
        onRequestSetup={handleMfaRequestSetup}
        onEnable={handleMfaEnable}
        onDisable={handleMfaDisable}
        onGenerateRecoveryCodes={handleGenerateRecoveryCodes}
        errorMessage={mfaError}
        successMessage={mfaSuccess}
        loading={mfaLoading || isStartingSsoReauth}
      />

      {/* Connect SSO (self-service identity linking, #2183) */}
      <ConnectSsoCard />

      {/* Passkeys */}
      <div
        ref={passkeyCardRef}
        data-testid="passkey-card"
        className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
      >
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t('profilePage.passkeys')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('profilePage.managePasskeysThatCanBeUsedAsMultiFactorAuthenticationFo')}</p>
        </div>

        <div className="space-y-3">
          {isLoadingPasskeys ? (
            <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
              {t('profilePage.loadingPasskeys')}</div>
          ) : passkeys.length ? (
            passkeys.map(passkey => (
              <div key={passkey.id} className="rounded-md border bg-muted/30 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    {editingPasskeyId === passkey.id ? (
                      <input
                        type="text"
                        value={editingPasskeyName}
                        onChange={event => setEditingPasskeyName(event.target.value)}
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                        disabled={mutatingPasskeyId === passkey.id}
                        autoFocus
                      />
                    ) : (
                      <p className="truncate text-sm font-medium">{passkey.name || t('profilePage.passkey')}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {t('profilePage.lastUsedAt', { date: formatPasskeyDate(passkey.lastUsedAt) })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {editingPasskeyId === passkey.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => handleRenamePasskey(passkey.id)}
                          disabled={!editingPasskeyName.trim() || mutatingPasskeyId === passkey.id}
                          className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {mutatingPasskeyId === passkey.id ? t('profilePage.saving') : t('profilePage.save')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingPasskeyId(null);
                            setEditingPasskeyName('');
                          }}
                          disabled={mutatingPasskeyId === passkey.id}
                          className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {t('profilePage.cancel')}</button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingPasskeyId(passkey.id);
                            setEditingPasskeyName(passkey.name || 'Passkey');
                            setPasskeyError(undefined);
                            setPasskeySuccess(undefined);
                          }}
                          disabled={!!mutatingPasskeyId}
                          className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {t('profilePage.rename')}</button>
                        <button
                          type="button"
                          onClick={() => handleDeletePasskey(passkey.id)}
                          disabled={!!mutatingPasskeyId}
                          className="h-9 rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {mutatingPasskeyId === passkey.id ? t('profilePage.deleting') : t('profilePage.delete')}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
              {t('profilePage.noPasskeysAreRegisteredForThisAccount')}</div>
          )}
        </div>

        <div className="space-y-4 rounded-md border p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">{t('profilePage.addPasskey')}</h3>
            <p className="text-xs text-muted-foreground">
              {/* #4055: "re-verify BEFORE adding a passkey" is stale the moment
                  the grant lands — saying it to someone who just completed the
                  round-trip reads as a failed trip. */}
              {isPasswordless
                ? hasSsoReauthGrant
                  ? t('profilePage.yourIdentityIsVerifiedNameThisPasskeyAndContinue')
                  : t('profilePage.thisAccountSignsInThroughAnIdentityProviderVerifyBeforeAddingAPasskey')
                : t('profilePage.reEnterYourAccountPasswordBeforeAddingOrDeletingAPasskey')}</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="passkey-name">
              {t('profilePage.passkeyName')}</label>
            <input
              id="passkey-name"
              ref={passkeyNameRef}
              type="text"
              value={passkeyName}
              onChange={event => setPasskeyName(event.target.value)}
              placeholder={t('profilePage.macBookTouchID')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              disabled={isAddingPasskey}
            />
          </div>
          {/* #4018: no password field for an account that has no password —
              the proof is a fresh IdP round-trip instead. */}
          {!isPasswordless && (
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
          )}
          {isPasswordless && !hasSsoReauthGrant ? (
            <button
              type="button"
              data-testid="passkey-sso-reauth"
              onClick={() => { void handleSsoReauthStart('passkey'); }}
              disabled={isAddingPasskey || isStartingSsoReauth}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('profilePage.verifyWithYourIdentityProvider')}
            </button>
          ) : (
            <button
              type="button"
              data-testid="passkey-add"
              onClick={handleAddPasskey}
              disabled={isAddingPasskey || (!isPasswordless && !passkeyPassword)}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isAddingPasskey ? t('profilePage.adding') : t('profilePage.addPasskey')}
            </button>
          )}
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
      </div>

      {/* Approval security (Breeze Authenticator) */}
      <ApproverDevicesSection passkeyCount={passkeys.length} mfaMethod={user?.mfaMethod ?? null} />
      <ThemingSettings
        preferences={user?.preferences}
        onSaved={(preferences) => setUser(prev => (prev ? { ...prev, preferences } : prev))}
      />
      <RemoteToolSettings
        preferences={user?.preferences}
        onSaved={(preferences) => setUser(prev => (prev ? { ...prev, preferences } : prev))}
      />

      {/* Onboarding */}
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('profilePage.onboarding')}</h2>
        <p className="text-sm text-muted-foreground mt-1 mb-4">
          {t('profilePage.resetTheProductTourToSeeTheWelcomeWalkthroughAgain')}</p>
        {tourResetMsg && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600 mb-3">
            {tourResetMsg}
          </div>
        )}
        <button
          type="button"
          onClick={() => {
            try {
              localStorage.removeItem('breeze-onboarding-complete');
              setTourResetMsg('Tour reset. It will appear on your next page load.');
              setTimeout(() => setTourResetMsg(undefined), 4000);
            } catch { /* ignore */ }
          }}
          className="rounded-md border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
        >
          {t('profilePage.restartTour')}</button>
      </div>
    </div>
  );
}
