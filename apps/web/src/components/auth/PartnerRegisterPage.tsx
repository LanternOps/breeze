import { useState } from 'react';
import PartnerRegisterForm from './PartnerRegisterForm';
import { useAuthStore, apiRegisterPartner } from '../../stores/auth';

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
      // Redirect to dashboard
      window.location.href = '/';
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
