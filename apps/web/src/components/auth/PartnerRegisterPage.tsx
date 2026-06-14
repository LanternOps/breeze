import { useEffect, useState } from 'react';
import PartnerRegisterForm from './PartnerRegisterForm';
import { useAuthStore, apiRegisterPartner } from '../../stores/auth';
import { useRegistrationGate } from '../../stores/featuresStore';
import { navigateTo } from '../../lib/navigation';
import { getSafeNext } from '../../lib/authNext';

interface PartnerRegisterPageProps {
  next?: string;
}

export default function PartnerRegisterPage({ next }: PartnerRegisterPageProps = {}) {
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const safeNext = getSafeNext(next);

  const login = useAuthStore((state) => state.login);

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

    if (result.user && result.tokens) {
      login(result.user, result.tokens);
      await navigateTo(result.redirectUrl ?? safeNext);
      return;
    }

    // API returned success but no tokens (e.g. duplicate email — generic message for security)
    if (result.message) {
      setError(result.message);
    }
    setLoading(false);
  };

  // Until /config resolves, or once we know registration is disabled (the
  // effect above is redirecting), render nothing rather than the form.
  if (!gateLoaded || !registrationEnabled) {
    return null;
  }

  return (
    <PartnerRegisterForm
      onSubmit={handleRegister}
      errorMessage={error}
      loading={loading}
    />
  );
}
