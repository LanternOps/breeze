import { useState } from 'react';
import LoginForm from './LoginForm';
import MFAVerifyForm from './MFAVerifyForm';
import { useAuthStore, apiLogin, apiVerifyMFA, apiSendSmsMfaCode } from '../../stores/auth';
import type { MfaMethod } from '../../stores/auth';

export default function LoginPage() {
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [tempToken, setTempToken] = useState<string>();
  const [mfaMethod, setMfaMethod] = useState<MfaMethod>('totp');
  const [phoneLast4, setPhoneLast4] = useState<string>();
  const [smsSending, setSmsSending] = useState(false);
  const [smsSent, setSmsSent] = useState(false);

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
      setMfaMethod(result.mfaMethod || 'totp');
      setPhoneLast4(result.phoneLast4);
      setSmsSent(false);
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

    const result = await apiVerifyMFA(code, tempToken, mfaMethod);

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

  const handleSendSmsCode = async () => {
    if (!tempToken) return;

    setSmsSending(true);
    setError(undefined);

    const result = await apiSendSmsMfaCode(tempToken);

    if (!result.success) {
      setError(result.error);
    } else {
      setSmsSent(true);
    }

    setSmsSending(false);
  };

  if (mfaRequired) {
    return (
      <MFAVerifyForm
        onSubmit={handleMfaVerify}
        errorMessage={error}
        loading={loading}
        mfaMethod={mfaMethod}
        phoneLast4={phoneLast4}
        onSendSmsCode={handleSendSmsCode}
        smsSending={smsSending}
        smsSent={smsSent}
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
