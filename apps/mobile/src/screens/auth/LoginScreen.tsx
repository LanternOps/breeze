import { useState, useEffect } from 'react';
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
import Svg, { Circle, Path } from 'react-native-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { useAppDispatch, useAppSelector } from '../../store';
import { loginAsync, clearError } from '../../store/authSlice';
import {
  checkBiometricAvailability,
  authenticateWithBiometrics,
} from '../../services/biometrics';
import { getStoredToken, getStoredUser } from '../../services/auth';
import { getServerUrl } from '../../services/serverConfig';
import { useApprovalTheme, palette, radii, spacing, type } from '../../theme';
import { Spinner } from '../../components/Spinner';
import { haptic } from '../../lib/motion';
import type { AuthStackParamList } from '../../navigation/AuthNavigator';

type Props = NativeStackScreenProps<AuthStackParamList, 'Login'>;

function EyeGlyph({ color, hidden }: { color: string; hidden: boolean }) {
  if (hidden) {
    return (
      <Svg width={18} height={18} viewBox="0 0 24 24">
        <Path
          d="M3 3 L21 21"
          stroke={color}
          strokeWidth={1.75}
          strokeLinecap="round"
          fill="none"
        />
        <Path
          d="M2.5 12 C 5 8, 8 5.5, 12 5.5 C 14 5.5, 15.7 6.1, 17.2 7.0 M21.5 12 C 19 16, 16 18.5, 12 18.5 C 10 18.5, 8.3 17.9, 6.8 17.0"
          stroke={color}
          strokeWidth={1.75}
          strokeLinecap="round"
          fill="none"
        />
      </Svg>
    );
  }
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        d="M2.5 12 C 5 8, 8 5.5, 12 5.5 C 16 5.5, 19 8, 21.5 12 C 19 16, 16 18.5, 12 18.5 C 8 18.5, 5 16, 2.5 12 Z"
        stroke={color}
        strokeWidth={1.75}
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx={12} cy={12} r={2.5} stroke={color} strokeWidth={1.75} fill="none" />
    </Svg>
  );
}

function FingerprintGlyph({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        d="M6 11 a6 6 0 0 1 12 0 v2 M9 21 c-1-2-1-4-1-6 a4 4 0 0 1 8 0 v3 M12 21 v-7 M16 19 c1-2 1-4 1-6"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

export function LoginScreen({ navigation }: Props) {
  const theme = useApprovalTheme('dark');
  const dispatch = useAppDispatch();
  const { isLoading, error } = useAppSelector((state) => state.auth);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [serverUrl, setServerUrlState] = useState<string | null>(null);

  useEffect(() => {
    checkBiometricAvailability().then(setBiometricAvailable);
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      getServerUrl().then(setServerUrlState);
    });
    return unsubscribe;
  }, [navigation]);

  async function handleLogin() {
    if (!email.trim() || !password.trim()) return;
    haptic.tap();
    dispatch(clearError());
    dispatch(loginAsync({ email: email.trim(), password }));
  }

  async function handleBiometricLogin() {
    haptic.tap();
    const success = await authenticateWithBiometrics();
    if (success) {
      const token = await getStoredToken();
      const user = await getStoredUser();
      if (token && user) {
        dispatch({ type: 'auth/setCredentials', payload: { token, user } });
      }
    }
  }

  const isEmailValid = email.length === 0 || email.includes('@');
  const canSubmit = email.trim().length > 0 && password.length > 0;

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
            <Text style={[type.display, { color: theme.textHi }]}>Breeze</Text>
            <Text
              style={[
                type.body,
                { color: theme.textMd, marginTop: spacing[2] },
              ]}
            >
              Remote monitoring & management
            </Text>
          </View>

          <View
            style={[
              styles.card,
              { backgroundColor: theme.bg1, borderColor: theme.border },
            ]}
          >
            <Text style={[type.title, { color: theme.textHi }]}>Sign in</Text>

            <View style={{ marginTop: spacing[4] }}>
              <Text style={[type.metaCaps, { color: theme.textLo }]}>EMAIL</Text>
              <View
                style={[
                  styles.inputWrap,
                  {
                    backgroundColor: theme.bg2,
                    borderColor: !isEmailValid ? palette.deny.base : theme.bg2,
                  },
                ]}
              >
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect={false}
                  spellCheck={false}
                  placeholder="you@company.com"
                  placeholderTextColor={theme.textLo}
                  style={[
                    type.body,
                    { color: theme.textHi, padding: spacing[4], minHeight: 48, flex: 1 },
                  ]}
                />
              </View>
              {!isEmailValid && (
                <Text
                  style={[
                    type.meta,
                    { color: palette.deny.base, marginTop: spacing[2] },
                  ]}
                >
                  Enter a valid email address.
                </Text>
              )}
            </View>

            <View style={{ marginTop: spacing[4] }}>
              <Text style={[type.metaCaps, { color: theme.textLo }]}>PASSWORD</Text>
              <View
                style={[
                  styles.inputWrap,
                  { backgroundColor: theme.bg2, borderColor: theme.bg2 },
                ]}
              >
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoComplete="password"
                  autoCorrect={false}
                  spellCheck={false}
                  placeholder="Your password"
                  placeholderTextColor={theme.textLo}
                  style={[
                    type.body,
                    { color: theme.textHi, padding: spacing[4], minHeight: 48, flex: 1 },
                  ]}
                />
                <Pressable
                  onPress={() => setShowPassword((v) => !v)}
                  hitSlop={8}
                  style={styles.iconButton}
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                >
                  <EyeGlyph color={theme.textLo} hidden={!showPassword} />
                </Pressable>
              </View>
            </View>

            {error ? (
              <View
                style={[
                  styles.errorBlock,
                  { backgroundColor: palette.deny.wash, borderColor: palette.deny.base },
                ]}
              >
                <Text style={[type.meta, { color: theme.textHi }]}>{error}</Text>
              </View>
            ) : null}

            <Pressable
              onPress={handleLogin}
              disabled={!canSubmit || isLoading}
              style={({ pressed }) => [
                styles.primaryButton,
                {
                  backgroundColor: theme.brand,
                  opacity: !canSubmit || isLoading ? 0.5 : pressed ? 0.85 : 1,
                },
              ]}
            >
              {isLoading ? (
                <Spinner size={18} color={palette.dark.textHi} />
              ) : (
                <Text style={[type.bodyMd, { color: palette.dark.textHi }]}>Sign in</Text>
              )}
            </Pressable>

            {biometricAvailable && (
              <Pressable
                onPress={handleBiometricLogin}
                disabled={isLoading}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  {
                    backgroundColor: theme.bg2,
                    opacity: isLoading ? 0.5 : pressed ? 0.85 : 1,
                  },
                ]}
              >
                <FingerprintGlyph color={theme.textHi} />
                <Text
                  style={[
                    type.bodyMd,
                    { color: theme.textHi, marginLeft: spacing[2] },
                  ]}
                >
                  Use biometrics
                </Text>
              </Pressable>
            )}
          </View>

          <View style={styles.serverFooter}>
            <Text style={[type.metaCaps, { color: theme.textLo }]}>SERVER</Text>
            <Pressable
              onPress={() => {
                haptic.tap();
                navigation.navigate('ServerSelect', { initialUrl: serverUrl });
              }}
              hitSlop={8}
              style={({ pressed }) => ({
                marginTop: spacing[1],
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text
                style={[type.body, { color: theme.brand }]}
                numberOfLines={1}
              >
                {serverUrl ?? 'Choose a region'}
              </Text>
            </Pressable>
          </View>

          <Text
            style={[
              type.meta,
              {
                color: theme.textLo,
                textAlign: 'center',
                marginTop: spacing[6],
                paddingHorizontal: spacing[6],
              },
            ]}
          >
            Signing in confirms you accept our Terms of Service and Privacy Policy.
          </Text>
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
    paddingRight: spacing[3],
    marginTop: spacing[2],
    borderWidth: 1,
  },
  iconButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
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
    flexDirection: 'row',
  },
  serverFooter: {
    alignItems: 'center',
    marginTop: spacing[6],
  },
});
