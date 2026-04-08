import { useState } from 'react';
import PartnerRegisterForm from './PartnerRegisterForm';
import { useAuthStore, apiRegisterPartner } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';

export default function PartnerRegisterPage() {
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

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
      await navigateTo(result.redirectUrl ?? '/');
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
