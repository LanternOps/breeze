import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import PartnerRegisterForm from './PartnerRegisterForm';
import StatusIcon from './StatusIcon';
import { apiRegisterPartner } from '../../stores/auth';
import { useRegistrationGate } from '../../stores/featuresStore';
import { navigateTo } from '../../lib/navigation';
// Initializes the shared i18next singleton. This page's layout has no Sidebar
// (which is what pulls i18n in elsewhere), so without this every t() call here
// renders its raw key.
import '../../lib/i18n';

// The `next` prop is accepted for URL compatibility but is no longer consumed:
// SR2-21 makes signup email-first, so there is no post-submit navigation to
// forward. The eventual login happens on the verify-email page (step 2).
interface PartnerRegisterPageProps {
  next?: string;
}

export default function PartnerRegisterPage(_props: PartnerRegisterPageProps = {}) {
  const { t } = useTranslation('auth');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Runtime registration gate (#1308). The server enforces ENABLE_REGISTRATION
  // on /auth/register-partner; this mirrors it client-side so the form isn't
  // shown (then rejected) when registration is disabled. We wait for /config
  // to load before deciding, so an open deployment never flashes the redirect.
  const { enabled: registrationEnabled, loaded: gateLoaded } = useRegistrationGate();
  useEffect(() => {
    if (gateLoaded && !registrationEnabled) {
      void navigateTo('/login?reason=registration-disabled');
    }
  }, [gateLoaded, registrationEnabled]);

  const handleRegister = async (values: {
    companyName: string;
    name: string;
    email: string;
    password: string;
    acceptTerms: boolean;
  }) => {
    setLoading(true);
    setError(undefined);

    const result = await apiRegisterPartner(
      values.companyName,
      values.email,
      values.password,
      values.name
    );

    if (!result.success) {
      setError(result.error);
      setLoading(false);
      return;
    }

    // SR2-21: registration no longer auto-logs-in. The server created NOTHING —
    // no partner, no user, no session — and deliberately returns the same body
    // whether or not the address already has an account. Render one terminal
    // "check your email" state; branching on anything the server said here
    // would rebuild the enumeration oracle in the client.
    setSubmitted(true);
    setLoading(false);
  };

  // Until /config resolves, or once we know registration is disabled (the
  // effect above is redirecting), render nothing rather than the form.
  if (!gateLoaded || !registrationEnabled) {
    return null;
  }

  if (submitted) {
    return (
      <div data-testid="register-check-email" className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-2 text-center">
          <StatusIcon variant="success" />
          <h2 className="text-lg font-semibold">
            {t('register.checkEmail.title', { defaultValue: 'Check your email' })}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('register.checkEmail.description', {
              defaultValue:
                "If registration can proceed, we've sent a confirmation link to that address. Click it to finish creating your account.",
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

  return (
    <PartnerRegisterForm
      onSubmit={handleRegister}
      errorMessage={error}
      loading={loading}
    />
  );
}
