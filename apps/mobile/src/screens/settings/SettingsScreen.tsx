import React, { useState, useEffect } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  Alert,
  Linking,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Text,
  useTheme,
  Surface,
  List,
  Switch,
  Divider,
  Button,
  Avatar,
  Portal,
  Modal,
  TextInput,
  HelperText,
} from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAppDispatch, useAppSelector } from '../../store';
import { logoutAsync } from '../../store/authSlice';
import { checkBiometricAvailability, setBiometricEnabled, isBiometricEnabled } from '../../services/biometrics';
import { changePassword } from '../../services/api';

const TERMS_URL = 'https://breeze.io/terms';
const PRIVACY_URL = 'https://breeze.io/privacy';

export function SettingsScreen() {
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const { user } = useAppSelector((state) => state.auth);

  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabledState] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [criticalOnly, setCriticalOnly] = useState(false);

  // Password change state
  const [passwordModalVisible, setPasswordModalVisible] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  useEffect(() => {
    checkBiometrics();
    loadNotificationSettings();
  }, []);

  async function loadNotificationSettings() {
    const notificationsValue = await AsyncStorage.getItem('notificationsEnabled');
    if (notificationsValue !== null) {
      setNotificationsEnabled(notificationsValue === 'true');
    }
    const criticalOnlyValue = await AsyncStorage.getItem('criticalAlertsOnly');
    if (criticalOnlyValue !== null) {
      setCriticalOnly(criticalOnlyValue === 'true');
    }
  }

  async function handleNotificationsToggle(value: boolean) {
    setNotificationsEnabled(value);
    await AsyncStorage.setItem('notificationsEnabled', String(value));
  }

  async function handleCriticalOnlyToggle(value: boolean) {
    setCriticalOnly(value);
    await AsyncStorage.setItem('criticalAlertsOnly', String(value));
  }

  async function checkBiometrics() {
    const available = await checkBiometricAvailability();
    setBiometricAvailable(available);

    if (available) {
      const enabled = await isBiometricEnabled();
      setBiometricEnabledState(enabled);
    }
  }

  async function handleBiometricToggle(value: boolean) {
    try {
      await setBiometricEnabled(value);
      setBiometricEnabledState(value);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update biometric settings';
      Alert.alert('Error', message);
    }
  }

  function handleLogout() {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: () => dispatch(logoutAsync()),
        },
      ],
      { cancelable: true }
    );
  }

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((part) => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  // Password change handlers
  const openPasswordModal = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordModalVisible(true);
  };

  const closePasswordModal = () => {
    setPasswordModalVisible(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  const validatePassword = () => {
    if (!currentPassword) {
      return 'Current password is required';
    }
    if (!newPassword) {
      return 'New password is required';
    }
    if (newPassword.length < 8) {
      return 'New password must be at least 8 characters';
    }
    // Match server-side password strength requirements
    if (!/[A-Z]/.test(newPassword)) {
      return 'New password must contain at least one uppercase letter';
    }
    if (!/[a-z]/.test(newPassword)) {
      return 'New password must contain at least one lowercase letter';
    }
    if (!/[0-9]/.test(newPassword)) {
      return 'New password must contain at least one number';
    }
    if (newPassword !== confirmPassword) {
      return 'Passwords do not match';
    }
    if (currentPassword === newPassword) {
      return 'New password must be different from current password';
    }
    return null;
  };

  const handleChangePassword = async () => {
    const error = validatePassword();
    if (error) {
      Alert.alert('Validation Error', error);
      return;
    }

    setPasswordLoading(true);
    try {
      await changePassword(currentPassword, newPassword);
      Alert.alert(
        'Password Changed',
        'Your password has been updated successfully.',
        [{ text: 'OK', onPress: closePasswordModal }]
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to change password';
      Alert.alert('Error', errorMessage);
    } finally {
      setPasswordLoading(false);
    }
  };

  // URL handlers
  const openTermsOfService = async () => {
    try {
      const supported = await Linking.canOpenURL(TERMS_URL);
      if (supported) {
        await Linking.openURL(TERMS_URL);
      } else {
        Alert.alert('Error', 'Unable to open Terms of Service');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to open Terms of Service');
    }
  };

  const openPrivacyPolicy = async () => {
    try {
      const supported = await Linking.canOpenURL(PRIVACY_URL);
      if (supported) {
        await Linking.openURL(PRIVACY_URL);
      } else {
        Alert.alert('Error', 'Unable to open Privacy Policy');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to open Privacy Policy');
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Surface style={[styles.profileCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.profileHeader}>
            <Avatar.Text
              size={64}
              label={user?.name ? getInitials(user.name) : 'U'}
              style={{ backgroundColor: theme.colors.primaryContainer }}
              labelStyle={{ color: theme.colors.onPrimaryContainer }}
            />
            <View style={styles.profileInfo}>
              <Text variant="titleLarge">{user?.name || 'User'}</Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                {user?.email || 'No email'}
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.primary, marginTop: 4 }}>
                {user?.role || 'User'}
              </Text>
            </View>
          </View>
        </Surface>

        <Surface style={[styles.settingsCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <Text variant="titleMedium" style={styles.sectionTitle}>
            Security
          </Text>

          {biometricAvailable && (
            <>
              <List.Item
                title="Biometric Authentication"
                description="Use fingerprint or face to unlock"
                left={(props) => <List.Icon {...props} icon="fingerprint" />}
                right={() => (
                  <Switch
                    value={biometricEnabled}
                    onValueChange={handleBiometricToggle}
                  />
                )}
              />
              <Divider />
            </>
          )}

          <List.Item
            title="Change Password"
            description="Update your account password"
            left={(props) => <List.Icon {...props} icon="lock" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={openPasswordModal}
          />
        </Surface>

        <Surface style={[styles.settingsCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <Text variant="titleMedium" style={styles.sectionTitle}>
            Notifications
          </Text>

          <List.Item
            title="Push Notifications"
            description="Receive alerts on your device"
            left={(props) => <List.Icon {...props} icon="bell" />}
            right={() => (
              <Switch
                value={notificationsEnabled}
                onValueChange={handleNotificationsToggle}
              />
            )}
          />
          <Divider />

          <List.Item
            title="Critical Alerts Only"
            description="Only notify for critical severity"
            left={(props) => <List.Icon {...props} icon="bell-alert" />}
            right={() => (
              <Switch
                value={criticalOnly}
                onValueChange={handleCriticalOnlyToggle}
              />
            )}
          />
        </Surface>

        <Surface style={[styles.settingsCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <Text variant="titleMedium" style={styles.sectionTitle}>
            About
          </Text>

          <List.Item
            title="App Version"
            description="1.0.0"
            left={(props) => <List.Icon {...props} icon="information" />}
          />
          <Divider />

          <List.Item
            title="Terms of Service"
            left={(props) => <List.Icon {...props} icon="file-document" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={openTermsOfService}
          />
          <Divider />

          <List.Item
            title="Privacy Policy"
            left={(props) => <List.Icon {...props} icon="shield-account" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={openPrivacyPolicy}
          />
        </Surface>

        <View style={styles.logoutContainer}>
          <Button
            mode="contained"
            onPress={handleLogout}
            buttonColor={theme.colors.error}
            textColor={theme.colors.onError}
            style={styles.logoutButton}
            contentStyle={styles.buttonContent}
            icon="logout"
          >
            Sign Out
          </Button>
        </View>

        <Text variant="labelSmall" style={[styles.footer, { color: theme.colors.onSurfaceVariant }]}>
          Breeze RMM - Remote Monitoring & Management
        </Text>
      </ScrollView>

      <Portal>
        <Modal
          visible={passwordModalVisible}
          onDismiss={closePasswordModal}
          contentContainerStyle={[styles.modalContent, { backgroundColor: theme.colors.surface }]}
        >
          <Text variant="titleLarge" style={styles.modalTitle}>
            Change Password
          </Text>
          
          <TextInput
            label="Current Password"
            value={currentPassword}
            onChangeText={setCurrentPassword}
            secureTextEntry={!showCurrentPassword}
            mode="outlined"
            style={styles.input}
            right={
              <TextInput.Icon
                icon={showCurrentPassword ? 'eye-off' : 'eye'}
                onPress={() => setShowCurrentPassword(!showCurrentPassword)}
              />
            }
          />
          
          <TextInput
            label="New Password"
            value={newPassword}
            onChangeText={setNewPassword}
            secureTextEntry={!showNewPassword}
            mode="outlined"
            style={styles.input}
            right={
              <TextInput.Icon
                icon={showNewPassword ? 'eye-off' : 'eye'}
                onPress={() => setShowNewPassword(!showNewPassword)}
              />
            }
          />
          <HelperText type="info" visible={true}>
            Password must be at least 8 characters
          </HelperText>
          
          <TextInput
            label="Confirm New Password"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry={!showConfirmPassword}
            mode="outlined"
            style={styles.input}
            right={
              <TextInput.Icon
                icon={showConfirmPassword ? 'eye-off' : 'eye'}
                onPress={() => setShowConfirmPassword(!showConfirmPassword)}
              />
            }
          />
          {confirmPassword && newPassword !== confirmPassword && (
            <HelperText type="error" visible={true}>
              Passwords do not match
            </HelperText>
          )}
          
          <View style={styles.modalButtons}>
            <Button
              mode="outlined"
              onPress={closePasswordModal}
              style={styles.modalButton}
              disabled={passwordLoading}
            >
              Cancel
            </Button>
            <Button
              mode="contained"
              onPress={handleChangePassword}
              style={styles.modalButton}
              loading={passwordLoading}
              disabled={passwordLoading}
            >
              Change Password
            </Button>
          </View>
        </Modal>
      </Portal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  profileCard: {
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
  },
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  profileInfo: {
    marginLeft: 16,
    flex: 1,
  },
  settingsCard: {
    borderRadius: 12,
    marginBottom: 16,
    overflow: 'hidden',
  },
  sectionTitle: {
    padding: 16,
    paddingBottom: 8,
  },
  logoutContainer: {
    marginTop: 8,
    marginBottom: 16,
  },
  logoutButton: {
    borderRadius: 8,
  },
  buttonContent: {
    paddingVertical: 8,
  },
  footer: {
    textAlign: 'center',
    marginBottom: 16,
  },
  modalContent: {
    margin: 20,
    borderRadius: 12,
    padding: 20,
  },
  modalTitle: {
    textAlign: 'center',
    marginBottom: 16,
  },
  input: {
    marginBottom: 8,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 16,
  },
  modalButton: {
    minWidth: 100,
  },
});
