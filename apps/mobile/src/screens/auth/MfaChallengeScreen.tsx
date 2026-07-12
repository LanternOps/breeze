import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAppDispatch, useAppSelector } from '../../store';
import { clearMfaChallenge, verifyMfaAsync } from '../../store/authSlice';
import { sendMfaSms } from '../../services/api';
import type { MfaCodeMethod } from '../../services/api';
import { normalizeMfaChallengeCode } from './mfaChallengeContract';
import { useApprovalTheme, palette, radii, spacing, type } from '../../theme';
import { Spinner } from '../../components/Spinner';
import { haptic } from '../../lib/motion';

const RESEND_COOLDOWN_SECONDS = 30;

export function MfaChallengeScreen() {
  const theme = useApprovalTheme('dark');
  const dispatch = useAppDispatch();
  const { isLoading, error, mfaChallenge } = useAppSelector((state) => state.auth);

  const [code, setCode] = useState('');
  const [selectedMethod, setSelectedMethod] = useState<MfaCodeMethod>('totp');
  const [smsSent, setSmsSent] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const inputRef = useRef<TextInput>(null);

  const availableCodeMethods = (mfaChallenge?.allowedMethods ?? [])
    .filter((method): method is MfaCodeMethod => method !== 'passkey');
  const isSms = selectedMethod === 'sms';
  const isRecovery = selectedMethod === 'recovery_code';

  useEffect(() => {
    if (!mfaChallenge) return;
    const primary = mfaChallenge.mfaMethod === 'passkey'
      ? availableCodeMethods[0] ?? 'recovery_code'
      : mfaChallenge.mfaMethod;
    setSelectedMethod(primary);
    setCode('');
  }, [mfaChallenge?.tempToken]);

  useEffect(() => {
    if (!isSms || !mfaChallenge?.tempToken || smsSent) return;
    setSmsSent(true);
    setCooldown(RESEND_COOLDOWN_SECONDS);
    sendMfaSms(mfaChallenge.tempToken).catch((err: { message?: string }) => {
      setSmsError(err?.message || 'Could not send SMS code.');
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
    setCode(normalizeMfaChallengeCode(value, selectedMethod));
  }

  async function handleVerify() {
    if (!mfaChallenge || code.length !== (isRecovery ? 9 : 6)) return;
    haptic.tap();
    dispatch(verifyMfaAsync({ code, tempToken: mfaChallenge.tempToken, method: selectedMethod }));
  }

  async function handleResend() {
    if (!mfaChallenge || cooldown > 0) return;
    haptic.tap();
    setSmsError(null);
    setCooldown(RESEND_COOLDOWN_SECONDS);
    try {
      await sendMfaSms(mfaChallenge.tempToken);
    } catch (err) {
      const apiError = err as { message?: string };
      setSmsError(apiError.message || 'Could not resend SMS code.');
      setCooldown(0);
    }
  }

  function handleCancel() {
    setCode('');
    dispatch(clearMfaChallenge());
  }

  const canSubmit = code.length === (isRecovery ? 9 : 6) && !isLoading;
  const subtitle = isRecovery
    ? 'Enter one of your single-use recovery codes.'
    : isSms
    ? mfaChallenge.phoneLast4
      ? `We sent a 6-digit code to the phone ending in ${mfaChallenge.phoneLast4}.`
      : 'We sent a 6-digit code to your phone.'
    : 'Enter the 6-digit code from your authenticator app.';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.bg0 }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Text
              style={[type.title, { color: theme.textHi, textAlign: 'center' }]}
            >
              Two-factor verification
            </Text>
            <Text
              style={[
                type.body,
                {
                  color: theme.textMd,
                  textAlign: 'center',
                  marginTop: spacing[2],
                  paddingHorizontal: spacing[4],
                },
              ]}
            >
              {subtitle}
            </Text>
          </View>

          <View
            style={[
              styles.card,
              { backgroundColor: theme.bg1, borderColor: theme.border },
            ]}
          >
            {availableCodeMethods.length > 1 ? (
              <View style={styles.methodRow}>
                {availableCodeMethods.map(method => (
                  <Pressable
                    key={method}
                    accessibilityRole="button"
                    accessibilityState={{ selected: selectedMethod === method }}
                    onPress={() => {
                      setSelectedMethod(method);
                      setCode('');
                    }}
                    style={[styles.methodButton, { backgroundColor: selectedMethod === method ? theme.brand : theme.bg2 }]}
                  >
                    <Text style={[type.meta, { color: theme.textHi }]}>
                      {method === 'totp' ? 'Authenticator' : method === 'sms' ? 'Text message' : 'Recovery code'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <Text style={[type.metaCaps, { color: theme.textLo }]}>
              {isRecovery ? 'RECOVERY CODE' : 'VERIFICATION CODE'}
            </Text>
            <View
              style={[
                styles.inputWrap,
                { backgroundColor: theme.bg2 },
              ]}
            >
              <TextInput
                ref={inputRef}
                value={code}
                onChangeText={handleChangeCode}
                keyboardType={isRecovery ? 'default' : 'number-pad'}
                autoComplete={isRecovery ? 'off' : 'one-time-code'}
                textContentType={isRecovery ? 'none' : 'oneTimeCode'}
                autoCapitalize={isRecovery ? 'characters' : 'none'}
                maxLength={isRecovery ? 9 : 6}
                placeholder={isRecovery ? 'XXXX-XXXX' : '123456'}
                placeholderTextColor={theme.textLo}
                onSubmitEditing={handleVerify}
                returnKeyType="go"
                style={[
                  type.mono,
                  {
                    color: theme.textHi,
                    padding: spacing[4],
                    minHeight: 48,
                    flex: 1,
                    fontSize: 22,
                    letterSpacing: isRecovery ? 3 : 6,
                    textAlign: 'center',
                  },
                ]}
              />
            </View>

            {error ? (
              <View
                style={[
                  styles.errorBlock,
                  {
                    backgroundColor: palette.deny.wash,
                    borderColor: palette.deny.base,
                  },
                ]}
              >
                <Text style={[type.meta, { color: theme.textHi }]}>{error}</Text>
              </View>
            ) : null}
            {smsError ? (
              <View
                style={[
                  styles.errorBlock,
                  {
                    backgroundColor: palette.deny.wash,
                    borderColor: palette.deny.base,
                  },
                ]}
              >
                <Text style={[type.meta, { color: theme.textHi }]}>
                  {smsError}
                </Text>
              </View>
            ) : null}

            <Pressable
              onPress={handleVerify}
              disabled={!canSubmit}
              style={({ pressed }) => [
                styles.primaryButton,
                {
                  backgroundColor: theme.brand,
                  opacity: !canSubmit ? 0.5 : pressed ? 0.85 : 1,
                },
              ]}
            >
              {isLoading ? (
                <Spinner size={18} color={palette.dark.textHi} />
              ) : (
                <Text style={[type.bodyMd, { color: palette.dark.textHi }]}>
                  Verify
                </Text>
              )}
            </Pressable>

            {isSms && (
              <Pressable
                onPress={handleResend}
                disabled={cooldown > 0 || isLoading}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  {
                    backgroundColor: theme.bg2,
                    opacity:
                      cooldown > 0 || isLoading ? 0.5 : pressed ? 0.85 : 1,
                  },
                ]}
              >
                <Text style={[type.bodyMd, { color: theme.textHi }]}>
                  {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
                </Text>
              </Pressable>
            )}

            <Pressable
              onPress={handleCancel}
              disabled={isLoading}
              style={({ pressed }) => ({
                marginTop: spacing[3],
                paddingVertical: spacing[3],
                alignItems: 'center',
                opacity: isLoading ? 0.5 : pressed ? 0.7 : 1,
              })}
            >
              <Text style={[type.meta, { color: theme.textMd }]}>
                Sign in with a different account
              </Text>
            </Pressable>
          </View>
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
    padding: spacing[6],
  },
  header: {
    alignItems: 'center',
    marginBottom: spacing[8],
  },
  card: {
    padding: spacing[6],
    borderRadius: radii.lg,
    borderWidth: 1,
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.md,
    marginTop: spacing[2],
  },
  methodRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], marginBottom: spacing[4] },
  methodButton: { borderRadius: radii.md, paddingHorizontal: spacing[3], paddingVertical: spacing[2] },
  errorBlock: {
    marginTop: spacing[4],
    padding: spacing[3],
    borderRadius: radii.md,
    borderWidth: 1,
  },
  primaryButton: {
    marginTop: spacing[6],
    paddingVertical: spacing[5],
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButton: {
    marginTop: spacing[3],
    paddingVertical: spacing[5],
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
