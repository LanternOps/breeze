import { useState } from 'react';
import PartnerRegisterForm from './PartnerRegisterForm';
import { useAuthStore, apiRegisterPartner } from '../../stores/auth';
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
      try {
        await navigateTo(result.redirectUrl ?? safeNext);
      } catch (err) {
        setError(err instanceof Error ? `Navigation failed: ${err.message}` : 'Navigation failed.');
        setLoading(false);
      }
      return;
    }

    // API returned success but no tokens (e.g. duplicate email — generic message for security)
    if (result.message) {
      setError(result.message);
    }
    setLoading(false);
  };

  return (
    <PartnerRegisterForm
      onSubmit={handleRegister}
      errorMessage={error}
      loading={loading}
    />
  );
}
