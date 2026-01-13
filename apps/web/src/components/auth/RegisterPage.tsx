import { useState } from 'react';
import RegisterForm from './RegisterForm';
import { useAuthStore, apiRegister } from '../../stores/auth';

export default function RegisterPage() {
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const login = useAuthStore((state) => state.login);

  const handleRegister = async (values: { name: string; email: string; password: string }) => {
    setLoading(true);
    setError(undefined);

    const result = await apiRegister(values.email, values.password, values.name);

    if (!result.success) {
      setError(result.error);
      setLoading(false);
      return;
    }

    if (result.user && result.tokens) {
      login(result.user, result.tokens);
      window.location.href = '/';
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
