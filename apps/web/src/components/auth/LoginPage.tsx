import { useState } from 'react';
import LoginForm from './LoginForm';
import MFAVerifyForm from './MFAVerifyForm';
import { useAuthStore, apiLogin, apiVerifyMFA } from '../../stores/auth';

export default function LoginPage() {
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [tempToken, setTempToken] = useState<string>();

  const login = useAuthStore((state) => state.login);

  const handleLogin = async (values: { email: string; password: string }) => {
    setLoading(true);
    setError(undefined);

    const result = await apiLogin(values.email, values.password);

    if (!result.success) {
      setError(result.error);
      setLoading(false);
      return;
    }

    if (result.mfaRequired) {
      setMfaRequired(true);
      setTempToken(result.tempToken);
      setLoading(false);
      return;
    }

    if (result.user && result.tokens) {
      login(result.user, result.tokens);
      window.location.href = '/';
    }

    setLoading(false);
  };

  const handleMfaVerify = async (code: string) => {
    if (!tempToken) return;

    setLoading(true);
    setError(undefined);

    const result = await apiVerifyMFA(code, tempToken);

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

  if (mfaRequired) {
    return (
      <MFAVerifyForm
        onSubmit={handleMfaVerify}
        errorMessage={error}
        loading={loading}
      />
    );
  }

  return (
    <LoginForm
      onSubmit={handleLogin}
      errorMessage={error}
      loading={loading}
    />
  );
}
