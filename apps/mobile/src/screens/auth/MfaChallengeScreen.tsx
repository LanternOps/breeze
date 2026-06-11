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
import { useApprovalTheme, palette, radii, spacing, type } from '../../theme';
import { Spinner } from '../../components/Spinner';
import { haptic } from '../../lib/motion';

const RESEND_COOLDOWN_SECONDS = 30;

export function MfaChallengeScreen() {
  const theme = useApprovalTheme('dark');
  const dispatch = useAppDispatch();
  const { isLoading, error, mfaChallenge } = useAppSelector((state) => state.auth);

  const [code, setCode] = useState('');
  const [smsSent, setSmsSent] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const inputRef = useRef<TextInput>(null);

  const isSms = mfaChallenge?.mfaMethod === 'sms';

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
    const digits = value.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
  }

  async function handleVerify() {
    if (!mfaChallenge || code.length !== 6) return;
    haptic.tap();
    dispatch(verifyMfaAsync({ code, tempToken: mfaChallenge.tempToken }));
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

  const canSubmit = code.length === 6 && !isLoading;
  const subtitle = isSms
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
            <Text style={[type.metaCaps, { color: theme.textLo }]}>
              VERIFICATION CODE
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
                keyboardType="number-pad"
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                maxLength={6}
                placeholder="123456"
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
                    letterSpacing: 6,
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
