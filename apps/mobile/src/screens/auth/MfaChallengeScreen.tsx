import { useEffect, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import {
  Button,
  HelperText,
  Surface,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAppDispatch, useAppSelector } from '../../store';
import { clearMfaChallenge, verifyMfaAsync } from '../../store/authSlice';
import { sendMfaSms } from '../../services/api';

const RESEND_COOLDOWN_SECONDS = 30;

export function MfaChallengeScreen() {
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const { isLoading, error, mfaChallenge } = useAppSelector((state) => state.auth);

  const [code, setCode] = useState('');
  const [smsSent, setSmsSent] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);

  const isSms = mfaChallenge?.mfaMethod === 'sms';

  useEffect(() => {
    if (!isSms || !mfaChallenge?.tempToken || smsSent) return;
    setSmsSent(true);
    setCooldown(RESEND_COOLDOWN_SECONDS);
    sendMfaSms(mfaChallenge.tempToken).catch((err: { message?: string }) => {
      setSmsError(err?.message || 'Failed to send SMS code');
      setSmsSent(false);
      setCooldown(0);
    });
  }, [isSms, mfaChallenge?.tempToken, smsSent]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 250);
    return () => clearTimeout(t);
  }, []);

  if (!mfaChallenge) {
    return null;
  }

  function handleChangeCode(value: string) {
    const digits = value.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
  }

  async function handleVerify() {
    if (!mfaChallenge || code.length !== 6) return;
    dispatch(verifyMfaAsync({ code, tempToken: mfaChallenge.tempToken }));
  }

  async function handleResend() {
    if (!mfaChallenge || cooldown > 0) return;
    setSmsError(null);
    setCooldown(RESEND_COOLDOWN_SECONDS);
    try {
      await sendMfaSms(mfaChallenge.tempToken);
    } catch (err) {
      const apiError = err as { message?: string };
      setSmsError(apiError.message || 'Failed to resend SMS code');
      setCooldown(0);
    }
  }

  function handleCancel() {
    setCode('');
    dispatch(clearMfaChallenge());
  }

  const canSubmit = code.length === 6 && !isLoading;
  const subtitle = isSms
    ? mfaChallenge.phoneLast4
      ? `We sent a 6-digit code to the phone ending in ${mfaChallenge.phoneLast4}.`
      : 'We sent a 6-digit code to your phone.'
    : 'Enter the 6-digit code from your authenticator app.';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Text variant="headlineLarge" style={[styles.title, { color: theme.colors.primary }]}>
              Two-factor verification
            </Text>
            <Text
              variant="bodyLarge"
              style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}
            >
              {subtitle}
            </Text>
          </View>

          <Surface style={[styles.formContainer, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <TextInput
              ref={inputRef}
              label="Verification code"
              value={code}
              onChangeText={handleChangeCode}
              mode="outlined"
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              maxLength={6}
              style={styles.input}
              left={<TextInput.Icon icon="shield-key" />}
              onSubmitEditing={handleVerify}
              returnKeyType="go"
            />

            {error && (
              <HelperText type="error" visible={true}>
                {error}
              </HelperText>
            )}
            {smsError && (
              <HelperText type="error" visible={true}>
                {smsError}
              </HelperText>
            )}

            <Button
              mode="contained"
              onPress={handleVerify}
              loading={isLoading}
              disabled={!canSubmit}
              style={styles.verifyButton}
              contentStyle={styles.buttonContent}
            >
              Verify
            </Button>

            {isSms && (
              <Button
                mode="text"
                onPress={handleResend}
                disabled={cooldown > 0 || isLoading}
                style={styles.resendButton}
              >
                {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
              </Button>
            )}

            <Button
              mode="text"
              onPress={handleCancel}
              disabled={isLoading}
              style={styles.cancelButton}
            >
              Sign in with a different account
            </Button>
          </Surface>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  keyboardView: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
  },
  header: { alignItems: 'center', marginBottom: 32 },
  title: { fontWeight: 'bold', marginBottom: 8, textAlign: 'center' },
  subtitle: { textAlign: 'center', paddingHorizontal: 16 },
  formContainer: { padding: 24, borderRadius: 16 },
  input: { marginBottom: 4 },
  verifyButton: { marginTop: 16 },
  resendButton: { marginTop: 8 },
  cancelButton: { marginTop: 4 },
  buttonContent: { paddingVertical: 8 },
});
