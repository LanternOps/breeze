import React, { useState, useEffect } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  Alert,
} from 'react-native';
import {
  Text,
  useTheme,
  Surface,
  List,
  Switch,
  Divider,
  Button,
  Avatar,
} from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAppDispatch, useAppSelector } from '../../store';
import { logoutAsync } from '../../store/authSlice';
import { checkBiometricAvailability, setBiometricEnabled, isBiometricEnabled } from '../../services/biometrics';

export function SettingsScreen() {
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const { user } = useAppSelector((state) => state.auth);

  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabledState] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);

  useEffect(() => {
    checkBiometrics();
  }, []);

  async function checkBiometrics() {
    const available = await checkBiometricAvailability();
    setBiometricAvailable(available);

    if (available) {
      const enabled = await isBiometricEnabled();
      setBiometricEnabledState(enabled);
    }
  }

  async function handleBiometricToggle(value: boolean) {
    await setBiometricEnabled(value);
    setBiometricEnabledState(value);
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
            onPress={() => {/* TODO: Implement password change */}}
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
                onValueChange={setNotificationsEnabled}
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
                value={false}
                onValueChange={() => {}}
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
            onPress={() => {/* TODO: Open terms */}}
          />
          <Divider />

          <List.Item
            title="Privacy Policy"
            left={(props) => <List.Icon {...props} icon="shield-account" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={() => {/* TODO: Open privacy policy */}}
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
});
