import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ResetPasswordForm from './ResetPasswordForm';
import StatusIcon from './StatusIcon';
import {
  apiAcceptInvite,
  apiPreviewInvite,
  fetchAndApplyPreferences,
  isInstalledAuthSessionCurrent,
  StaleWebSessionError,
} from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';
import { scrubQueryParamsFromCurrentUrl } from '../../lib/sensitiveUrl';

type TokenState =
  | { phase: 'loading' }
  | { phase: 'present'; token: string }
  | { phase: 'absent' };

interface InvitePreview {
  email?: string;
  name?: string;
  orgName?: string;
  partnerName?: string;
}

export default function AcceptInvitePage() {
  const { t } = useTranslation('auth');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [tokenState, setTokenState] = useState<TokenState>({ phase: 'loading' });
  const [preview, setPreview] = useState<InvitePreview | undefined>();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get('token');
    if (tokenParam) {
      scrubQueryParamsFromCurrentUrl(['token']);
    }
    setTokenState(
      tokenParam ? { phase: 'present', token: tokenParam } : { phase: 'absent' },
    );
  }, []);

  useEffect(() => {
    if (tokenState.phase !== 'present') return;
    let cancelled = false;
    apiPreviewInvite(tokenState.token).then((result) => {
      if (cancelled) return;
      if (result.success) {
        setPreview({
          email: result.email,
          name: result.name,
          orgName: result.orgName,
          partnerName: result.partnerName,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tokenState]);

  const handleSubmit = async (values: { password: string }) => {
    if (tokenState.phase !== 'present') {
      setError(t('acceptInvite.errors.missingToken', { defaultValue: 'Invalid or missing invite token' }));
      return;
    }

    setLoading(true);
    setError(undefined);

    try {
      const result = await apiAcceptInvite(tokenState.token, values.password);

      if (!result.success) {
        setError(result.error || t('acceptInvite.errors.acceptFailed', { defaultValue: 'Failed to accept invite' }));
        return;
      }

      if (result.user && result.tokens) {
        if (!isInstalledAuthSessionCurrent(result.installedSession)) return;
        await fetchAndApplyPreferences();
        if (!isInstalledAuthSessionCurrent(result.installedSession)) return;
        await navigateTo('/');
        return;
      } else {
        await navigateTo('/login', { replace: true });
        return;
      }
    } catch (caught) {
      if (!(caught instanceof StaleWebSessionError)) {
        setError(t('acceptInvite.errors.acceptFailed', { defaultValue: 'Failed to accept invite' }));
      }
    } finally {
      setLoading(false);
    }
  };

  if (tokenState.phase === 'loading') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs" aria-busy="true">
        <div className="space-y-2 text-center">
          <StatusIcon variant="pending" label={t('common.loadingLabel', { defaultValue: 'Loading' })} />
          <h2 className="text-lg font-semibold">{t('common.loadingEllipsis', { defaultValue: 'Loading…' })}</h2>
        </div>
      </div>
    );
  }

  if (tokenState.phase === 'absent') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-2 text-center">
          <StatusIcon variant="error" />
          <h2 className="text-lg font-semibold">{t('acceptInvite.invalid.title', { defaultValue: "This link doesn't work" })}</h2>
          <p className="text-sm text-muted-foreground">
            {t('acceptInvite.invalid.description', {
              defaultValue:
                'The invite link is invalid or has expired. Ask your administrator to send a new invitation.',
            })}
          </p>
        </div>
        <a
          href="/login"
          className="flex h-11 w-full items-center justify-center rounded-md border text-sm font-medium transition hover:bg-muted"
        >
          {t('common.backToSignIn', { defaultValue: 'Back to sign in' })}
        </a>
      </div>
    );
  }

  const target = preview?.orgName ?? preview?.partnerName;
  const greetingName = preview?.name?.split(' ')[0];

  return (
    <div className="space-y-4">
      {(target || preview?.email) && (
        <div className="space-y-1 text-center">
          <h2 className="text-lg font-semibold">
            {greetingName
              ? t('acceptInvite.greetingWithName', { defaultValue: `Hi ${greetingName}, `, name: greetingName })
              : ''}
            {target
              ? t('acceptInvite.invitedToTarget', {
                  defaultValue: `you're invited to ${target}`,
                  target,
                })
              : t('acceptInvite.invitedToBreeze', { defaultValue: "you're invited to Breeze" })}
          </h2>
          {preview?.email && (
            <p className="text-sm text-muted-foreground">
              {t('acceptInvite.finishAccountPrefix', {
                defaultValue: 'Set a password to finish creating your ',
              })}
              <strong>{preview.email}</strong>
              {t('acceptInvite.finishAccountSuffix', { defaultValue: ' account.' })}
            </p>
          )}
        </div>
      )}
      <ResetPasswordForm
        onSubmit={handleSubmit}
        errorMessage={error}
        loading={loading}
        submitLabel={t('acceptInvite.setPasswordAndSignIn', { defaultValue: 'Set password & sign in' })}
      />
    </div>
  );
}
