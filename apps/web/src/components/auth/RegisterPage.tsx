import { useState } from 'react';
import RegisterForm from './RegisterForm';
import { apiRegister, isInstalledAuthSessionCurrent, StaleWebSessionError } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';

export default function RegisterPage() {
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const handleRegister = async (values: { name: string; email: string; password: string }) => {
    setLoading(true);
    setError(undefined);

    let result: Awaited<ReturnType<typeof apiRegister>>;
    try {
      result = await apiRegister(values.email, values.password, values.name);
    } catch (error) {
      if (!(error instanceof StaleWebSessionError)) setError('Registration could not be completed. Please try again.');
      setLoading(false);
      return;
    }

    if (!result.success) {
      setError(result.error);
      setLoading(false);
      return;
    }

    if (result.user && result.tokens) {
      if (!isInstalledAuthSessionCurrent(result.installedSession)) {
        setLoading(false);
        return;
      }
      await navigateTo('/');
      return;
    }

    setLoading(false);
  };

  return (
    <RegisterForm
      onSubmit={handleRegister}
      errorMessage={error}
      loading={loading}
    />
  );
}
