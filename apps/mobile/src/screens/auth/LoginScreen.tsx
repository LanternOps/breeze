import React, { useState, useEffect } from 'react';
import {
  View,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Image,
} from 'react-native';
import {
  TextInput,
  Button,
  Text,
  useTheme,
  HelperText,
  Surface,
} from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAppDispatch, useAppSelector } from '../../store';
import { loginAsync, clearError } from '../../store/authSlice';
import { checkBiometricAvailability, authenticateWithBiometrics } from '../../services/biometrics';
import { getStoredToken, getStoredUser } from '../../services/auth';

export function LoginScreen() {
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const { isLoading, error } = useAppSelector((state) => state.auth);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);

  useEffect(() => {
    checkBiometrics();
  }, []);

  async function checkBiometrics() {
    const available = await checkBiometricAvailability();
    setBiometricAvailable(available);
  }

  async function handleLogin() {
    if (!email.trim() || !password.trim()) {
      return;
    }
    dispatch(clearError());
    dispatch(loginAsync({ email: email.trim(), password }));
  }

  async function handleBiometricLogin() {
    const success = await authenticateWithBiometrics();
    if (success) {
      // If biometric auth succeeds, try to get stored credentials
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
              Breeze RMM
            </Text>
            <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant }}>
              Remote Monitoring & Management
            </Text>
          </View>

          <Surface style={[styles.formContainer, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <Text variant="titleLarge" style={styles.formTitle}>
              Sign In
            </Text>

            <TextInput
              label="Email"
              value={email}
              onChangeText={setEmail}
              mode="outlined"
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              left={<TextInput.Icon icon="email" />}
              error={!isEmailValid}
              style={styles.input}
            />
            <HelperText type="error" visible={!isEmailValid}>
              Please enter a valid email address
            </HelperText>

            <TextInput
              label="Password"
              value={password}
              onChangeText={setPassword}
              mode="outlined"
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoComplete="password"
              left={<TextInput.Icon icon="lock" />}
              right={
                <TextInput.Icon
                  icon={showPassword ? 'eye-off' : 'eye'}
                  onPress={() => setShowPassword(!showPassword)}
                />
              }
              style={styles.input}
            />

            {error && (
              <HelperText type="error" visible={true} style={styles.errorText}>
                {error}
              </HelperText>
            )}

            <Button
              mode="contained"
              onPress={handleLogin}
              loading={isLoading}
              disabled={!canSubmit || isLoading}
              style={styles.loginButton}
              contentStyle={styles.buttonContent}
            >
              Sign In
            </Button>

            {biometricAvailable && (
              <Button
                mode="outlined"
                onPress={handleBiometricLogin}
                disabled={isLoading}
                style={styles.biometricButton}
                contentStyle={styles.buttonContent}
                icon="fingerprint"
              >
                Use Biometrics
              </Button>
            )}
          </Surface>

          <Text variant="bodySmall" style={[styles.footer, { color: theme.colors.onSurfaceVariant }]}>
            By signing in, you agree to our Terms of Service and Privacy Policy
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
  },
  title: {
    fontWeight: 'bold',
    marginBottom: 8,
  },
  formContainer: {
    padding: 24,
    borderRadius: 16,
  },
  formTitle: {
    marginBottom: 24,
    textAlign: 'center',
  },
  input: {
    marginBottom: 4,
  },
  errorText: {
    marginBottom: 8,
  },
  loginButton: {
    marginTop: 16,
  },
  biometricButton: {
    marginTop: 12,
  },
  buttonContent: {
    paddingVertical: 8,
  },
  footer: {
    textAlign: 'center',
    marginTop: 24,
    paddingHorizontal: 32,
  },
});
