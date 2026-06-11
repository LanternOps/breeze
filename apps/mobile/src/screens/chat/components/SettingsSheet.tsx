import { useEffect, useState } from 'react';
import {
  Alert,
  Dimensions,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Constants from 'expo-constants';

import { useApprovalTheme, palette, radii, spacing, type } from '../../../theme';
import { useAppDispatch, useAppSelector } from '../../../store';
import { logoutAsync } from '../../../store/authSlice';
import {
  blockPairedDevice,
  fetchConnectedApps,
  fetchPairedDevices,
  revokeConnectedAppAsync,
  selectActiveConnectedAppsCount,
  selectActivePairedDevicesCount,
  selectConnectedApps,
  selectPairedDevices,
} from '../../../store/lifecycleSlice';
import {
  checkBiometricAvailability,
  isBiometricEnabled,
  setBiometricEnabled,
} from '../../../services/biometrics';
import { ease, duration } from '../../../lib/motion';
import { track } from '../../../lib/analytics';
import { relativeTime } from '../../../lib/relativeTime';
import { Toast } from '../../../components/Toast';
import { Avatar } from './Avatar';
import { ChangePasswordSheet } from './ChangePasswordSheet';
import type { PairedMobileDevice } from '../../../services/mobileDevices';
import type { ConnectedApp } from '../../../services/connectedApps';

interface Props {
  visible: boolean;
  onCancel: () => void;
}

const NOTIF_KEY = 'notificationsEnabled';
const NOTIF_CRITICAL_ONLY_KEY = 'notificationsCriticalOnly';
const TERMS_URL = 'https://breezermm.com/legal/terms-of-service/';
const PRIVACY_URL = 'https://breezermm.com/legal/privacy-policy/';
const DELETE_ACCOUNT_URL = 'https://breezermm.com/account/delete';

async function safeOpen(url: string) {
  try {
    if (await Linking.canOpenURL(url)) {
      await Linking.openURL(url);
    } else {
      Alert.alert('Cannot open link', url);
    }
  } catch {
    Alert.alert('Cannot open link', url);
  }
}

export function SettingsSheet({ visible, onCancel }: Props) {
  const theme = useApprovalTheme('dark');
  const dispatch = useAppDispatch();
  const insets = useSafeAreaInsets();
  const user = useAppSelector((s) => s.auth.user);
  const pairedDevices = useAppSelector(selectPairedDevices);
  const connectedApps = useAppSelector(selectConnectedApps);
  const activeDeviceCount = useAppSelector(selectActivePairedDevicesCount);
  const activeAppCount = useAppSelector(selectActiveConnectedAppsCount);
  const pendingDeviceId = useAppSelector((s) => s.lifecycle.pendingDeviceId);
  const pendingAppId = useAppSelector((s) => s.lifecycle.pendingAppId);

  const screenWidth = Dimensions.get('window').width;
  const sheetWidth = Math.min(screenWidth * 0.84, 420);

  const tx = useSharedValue(sheetWidth);
  const scrim = useSharedValue(0);

  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricOn, setBiometricOn] = useState(false);
  const [notificationsOn, setNotificationsOn] = useState(true);
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!visible) {
      tx.value = withTiming(sheetWidth, { duration: duration.exit, easing: ease });
      scrim.value = withTiming(0, { duration: duration.base, easing: ease });
      return;
    }
    tx.value = withTiming(0, { duration: duration.swell, easing: ease });
    scrim.value = withTiming(0.55, { duration: duration.base, easing: ease });

    (async () => {
      const avail = await checkBiometricAvailability();
      setBiometricAvailable(avail);
      if (avail) setBiometricOn(await isBiometricEnabled());
      const stored = await AsyncStorage.getItem(NOTIF_KEY);
      if (stored !== null) setNotificationsOn(stored === 'true');
      const critical = await AsyncStorage.getItem(NOTIF_CRITICAL_ONLY_KEY);
      if (critical !== null) setCriticalOnly(critical === 'true');
    })();

    // Refresh both lifecycle lists every time the sheet opens (tab focus
    // semantics — the sheet is the entry point).
    void dispatch(fetchPairedDevices());
    void dispatch(fetchConnectedApps());
  }, [visible, sheetWidth, dispatch]);

  function onRevokeDevice(device: PairedMobileDevice) {
    if (device.isCurrent) {
      Alert.alert(
        'Cannot revoke this device',
        'Sign in on another phone or use the web dashboard to revoke this device.',
      );
      return;
    }
    if (device.status === 'blocked') return;

    const isLastTrustedDevice = activeDeviceCount <= 1;
    const warning = isLastTrustedDevice
      ? 'This is your only trusted device. Revoking it means you will need to re-pair before approving anything from your phone.'
      : 'The device will be signed out and stop receiving approval pushes immediately.';

    Alert.alert(
      `Revoke ${device.model ?? device.platform}?`,
      warning,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            const result = await dispatch(blockPairedDevice({ id: device.id }));
            if (blockPairedDevice.fulfilled.match(result)) {
              setToast({ kind: 'success', text: 'Device revoked.' });
            } else {
              setToast({ kind: 'error', text: 'Could not revoke device.' });
            }
          },
        },
      ],
    );
  }

  function onRevokeApp(app: ConnectedApp) {
    if (app.revokedAt) return;
    const isLast = activeAppCount <= 1;
    const message = isLast
      ? `This is your only connected app. Revoking ${app.displayName} will require re-authorization before it can request approvals again.`
      : `Revoke ${app.displayName}? This will sign it out and require re-authorization.`;

    Alert.alert('Revoke app', message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke',
        style: 'destructive',
        onPress: async () => {
          const result = await dispatch(revokeConnectedAppAsync({ clientId: app.clientId }));
          if (revokeConnectedAppAsync.fulfilled.match(result)) {
            setToast({ kind: 'success', text: 'App revoked.' });
          } else {
            setToast({ kind: 'error', text: 'Could not revoke app.' });
          }
        },
      },
    ]);
  }

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: scrim.value,
  }));

  async function onToggleBiometric(next: boolean) {
    try {
      await setBiometricEnabled(next);
      setBiometricOn(next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not update biometric setting.';
      Alert.alert('Biometric', msg);
    }
  }

  async function onToggleNotifications(next: boolean) {
    setNotificationsOn(next);
    await AsyncStorage.setItem(NOTIF_KEY, String(next));
  }

  async function onToggleCriticalOnly(next: boolean) {
    setCriticalOnly(next);
    await AsyncStorage.setItem(NOTIF_CRITICAL_ONLY_KEY, String(next));
  }

  function onPressChangePassword() {
    setPasswordOpen(true);
  }

  function onPasswordSuccess() {
    setPasswordOpen(false);
    setToast({ kind: 'success', text: 'Password updated.' });
  }

  function onPressDeleteAccount() {
    Alert.alert(
      'Delete account',
      'You will be taken to a secure page on the web to submit a deletion request. Your account is processed within 30 days; you can cancel anytime before then.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () => {
            // We track the user-intent click, not the actual server-side
            // deletion request (that happens on the web flow).
            track('account_deletion_requested');
            safeOpen(DELETE_ACCOUNT_URL);
          },
        },
      ],
    );
  }

  function onSignOut() {
    Alert.alert('Sign out', 'You will need to sign in again to receive approvals.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          onCancel();
          dispatch(logoutAsync());
        },
      },
    ]);
  }

  const buildVersion = (Constants.expoConfig?.version ?? '0.0.0') + (
    Constants.expoConfig?.extra?.commitHash
      ? ` · ${String(Constants.expoConfig.extra.commitHash).slice(0, 7)}`
      : ''
  );

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onCancel}>
      <View style={{ flex: 1, flexDirection: 'row' }}>
        <Animated.View style={[{ flex: 1, backgroundColor: '#000' }, scrimStyle]}>
          <Pressable style={{ flex: 1 }} onPress={onCancel} />
        </Animated.View>
        <Animated.View
          style={[
            {
              width: sheetWidth,
              backgroundColor: theme.bg1,
              borderLeftWidth: 1,
              borderLeftColor: theme.border,
            },
            sheetStyle,
          ]}
        >
          <SheetBody
            user={user}
            theme={theme}
            insetTop={insets.top}
            insetBottom={insets.bottom}
            biometricAvailable={biometricAvailable}
            biometricOn={biometricOn}
            notificationsOn={notificationsOn}
            criticalOnly={criticalOnly}
            buildVersion={buildVersion}
            pairedDevices={pairedDevices}
            connectedApps={connectedApps}
            pendingDeviceId={pendingDeviceId}
            pendingAppId={pendingAppId}
            onToggleBiometric={onToggleBiometric}
            onToggleNotifications={onToggleNotifications}
            onToggleCriticalOnly={onToggleCriticalOnly}
            onPressChangePassword={onPressChangePassword}
            onPressTerms={() => safeOpen(TERMS_URL)}
            onPressPrivacy={() => safeOpen(PRIVACY_URL)}
            onPressDeleteAccount={onPressDeleteAccount}
            onSignOut={onSignOut}
            onRevokeDevice={onRevokeDevice}
            onRevokeApp={onRevokeApp}
          />
          {/* Toast inside the sliding container so its left/right gutters
              are relative to the sheet (84% width), not the modal root. */}
          <Toast
            visible={!!toast}
            text={toast?.text ?? ''}
            kind={toast?.kind ?? 'success'}
            onHidden={() => setToast(null)}
            bottomOffset={insets.bottom + spacing[16]}
          />
        </Animated.View>
      </View>

      <ChangePasswordSheet
        visible={passwordOpen}
        onCancel={() => setPasswordOpen(false)}
        onSuccess={onPasswordSuccess}
      />
    </Modal>
  );
}

function SheetBody({
  user,
  theme,
  insetTop,
  insetBottom,
  biometricAvailable,
  biometricOn,
  notificationsOn,
  criticalOnly,
  buildVersion,
  pairedDevices,
  connectedApps,
  pendingDeviceId,
  pendingAppId,
  onToggleBiometric,
  onToggleNotifications,
  onToggleCriticalOnly,
  onPressChangePassword,
  onPressTerms,
  onPressPrivacy,
  onPressDeleteAccount,
  onSignOut,
  onRevokeDevice,
  onRevokeApp,
}: {
  user: { name: string; email: string } | null;
  theme: ReturnType<typeof useApprovalTheme>;
  insetTop: number;
  insetBottom: number;
  biometricAvailable: boolean;
  biometricOn: boolean;
  notificationsOn: boolean;
  criticalOnly: boolean;
  buildVersion: string;
  pairedDevices: PairedMobileDevice[];
  connectedApps: ConnectedApp[];
  pendingDeviceId: string | null;
  pendingAppId: string | null;
  onToggleBiometric: (v: boolean) => void;
  onToggleNotifications: (v: boolean) => void;
  onToggleCriticalOnly: (v: boolean) => void;
  onPressChangePassword: () => void;
  onPressTerms: () => void;
  onPressPrivacy: () => void;
  onPressDeleteAccount: () => void;
  onSignOut: () => void;
  onRevokeDevice: (device: PairedMobileDevice) => void;
  onRevokeApp: (app: ConnectedApp) => void;
}) {
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: insetTop + spacing[6],
          paddingBottom: spacing[8],
        }}
      >
        <View
          style={{
            paddingHorizontal: spacing[6],
            paddingBottom: spacing[6],
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          <Avatar name={user?.name} size={48} />
          <View style={{ marginLeft: spacing[3], flex: 1 }}>
            <Text style={[type.bodyMd, { color: theme.textHi }]} numberOfLines={1}>
              {user?.name ?? 'Signed in'}
            </Text>
            {user?.email ? (
              <Text
                style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}
                numberOfLines={1}
              >
                {user.email}
              </Text>
            ) : null}
          </View>
        </View>

        <SectionDivider color={theme.border} />

        {biometricAvailable ? (
          <ToggleRow
            label="Biometric"
            description="Use Face ID / Touch ID for approvals"
            value={biometricOn}
            onChange={onToggleBiometric}
            theme={theme}
          />
        ) : null}

        <ToggleRow
          label="Notifications"
          description="Approval pushes and alerts"
          value={notificationsOn}
          onChange={onToggleNotifications}
          theme={theme}
        />

        {notificationsOn ? (
          <ToggleRow
            label="Critical only"
            description="Quiet pushes for medium and warning alerts"
            value={criticalOnly}
            onChange={onToggleCriticalOnly}
            theme={theme}
          />
        ) : null}

        <SectionDivider color={theme.border} />

        <LinkRow
          label="Change password"
          onPress={onPressChangePassword}
          theme={theme}
        />
        <LinkRow label="Terms of Service" onPress={onPressTerms} theme={theme} />
        <LinkRow label="Privacy Policy" onPress={onPressPrivacy} theme={theme} />

        <SectionDivider color={theme.border} />

        <SectionHeader label="This phone + others" theme={theme} />
        {pairedDevices.length === 0 ? (
          <EmptyHint
            text="No paired devices yet. Sign in on another phone to see it here."
            theme={theme}
          />
        ) : (
          pairedDevices.map((d) => (
            <DeviceRow
              key={d.id}
              device={d}
              theme={theme}
              pending={pendingDeviceId === d.id}
              onRevoke={() => onRevokeDevice(d)}
            />
          ))
        )}

        <SectionDivider color={theme.border} />

        <SectionHeader label="Connected apps" theme={theme} />
        {connectedApps.length === 0 ? (
          <EmptyHint
            text="No apps connected. Tools like Claude Desktop appear here once you authorize them."
            theme={theme}
          />
        ) : (
          connectedApps.map((a) => (
            <AppRow
              key={a.clientId}
              app={a}
              theme={theme}
              pending={pendingAppId === a.clientId}
              onRevoke={() => onRevokeApp(a)}
            />
          ))
        )}

        <SectionDivider color={theme.border} />

        <Pressable
          onPress={onPressDeleteAccount}
          style={({ pressed }) => ({
            paddingHorizontal: spacing[6],
            paddingVertical: spacing[4],
            backgroundColor: pressed ? theme.bg2 : 'transparent',
          })}
        >
          <Text style={[type.bodyMd, { color: palette.deny.base }]}>
            Delete account
          </Text>
        </Pressable>

        <Pressable
          onPress={onSignOut}
          style={({ pressed }) => ({
            paddingHorizontal: spacing[6],
            paddingVertical: spacing[4],
            backgroundColor: pressed ? theme.bg2 : 'transparent',
          })}
        >
          <Text style={[type.bodyMd, { color: palette.deny.base }]}>Sign out</Text>
        </Pressable>
      </ScrollView>

      <View
        style={{
          paddingHorizontal: spacing[6],
          paddingBottom: insetBottom + spacing[3],
          paddingTop: spacing[3],
          borderTopWidth: 1,
          borderTopColor: theme.border,
        }}
      >
        <Text style={[type.metaCaps, { color: theme.textLo }]}>BREEZE MOBILE</Text>
        <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>
          {buildVersion}
        </Text>
      </View>
    </View>
  );
}

function SectionDivider({ color }: { color: string }) {
  return <View style={{ height: 1, backgroundColor: color, marginVertical: spacing[2] }} />;
}

function LinkRow({
  label,
  onPress,
  theme,
}: {
  label: string;
  onPress: () => void;
  theme: ReturnType<typeof useApprovalTheme>;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: spacing[6],
        paddingVertical: spacing[4],
        backgroundColor: pressed ? theme.bg2 : 'transparent',
      })}
    >
      <Text style={[type.bodyMd, { color: theme.textHi }]}>{label}</Text>
    </Pressable>
  );
}

function SectionHeader({
  label,
  theme,
}: {
  label: string;
  theme: ReturnType<typeof useApprovalTheme>;
}) {
  return (
    <View style={{ paddingHorizontal: spacing[6], paddingTop: spacing[4], paddingBottom: spacing[2] }}>
      <Text style={[type.metaCaps, { color: theme.textLo }]}>{label.toUpperCase()}</Text>
    </View>
  );
}

function EmptyHint({ text, theme }: { text: string; theme: ReturnType<typeof useApprovalTheme> }) {
  return (
    <View style={{ paddingHorizontal: spacing[6], paddingVertical: spacing[3] }}>
      <Text style={[type.meta, { color: theme.textLo }]}>{text}</Text>
    </View>
  );
}

function DeviceRow({
  device,
  theme,
  pending,
  onRevoke,
}: {
  device: PairedMobileDevice;
  theme: ReturnType<typeof useApprovalTheme>;
  pending: boolean;
  onRevoke: () => void;
}) {
  const blocked = device.status === 'blocked';
  const disabled = blocked || pending;
  const subtitleParts: string[] = [];
  if (device.osVersion) subtitleParts.push(`${device.platform === 'ios' ? 'iOS' : 'Android'} ${device.osVersion}`);
  else subtitleParts.push(device.platform === 'ios' ? 'iOS' : 'Android');
  if (device.lastActiveAt) subtitleParts.push(`active ${relativeTime(device.lastActiveAt)}`);
  const subtitle = subtitleParts.join(' · ');

  const title = device.model ?? (device.platform === 'ios' ? 'iPhone' : 'Android device');
  const labelColor = blocked ? theme.textLo : theme.textHi;
  const ctaLabel = blocked
    ? 'Revoked'
    : device.isCurrent
      ? 'This device'
      : pending
        ? 'Revoking…'
        : 'Revoke';
  const ctaColor = blocked || device.isCurrent ? theme.textLo : palette.deny.base;

  return (
    <View
      style={{
        paddingHorizontal: spacing[6],
        paddingVertical: spacing[3],
        flexDirection: 'row',
        alignItems: 'center',
        opacity: blocked ? 0.55 : 1,
      }}
    >
      <View style={{ flex: 1, marginRight: spacing[3] }}>
        <Text style={[type.bodyMd, { color: labelColor }]} numberOfLines={1}>
          {title}
          {device.isCurrent ? '  ·  this device' : ''}
        </Text>
        <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]} numberOfLines={1}>
          {subtitle}
        </Text>
        {blocked && device.blockedReason ? (
          <Text style={[type.meta, { color: theme.textLo, marginTop: spacing[1] }]} numberOfLines={2}>
            {device.blockedReason}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={disabled || device.isCurrent ? undefined : onRevoke}
        disabled={disabled || device.isCurrent}
        style={({ pressed }) => ({
          paddingHorizontal: spacing[3],
          paddingVertical: spacing[2],
          borderRadius: radii.md,
          backgroundColor: pressed && !disabled && !device.isCurrent ? theme.bg2 : 'transparent',
        })}
      >
        <Text style={[type.bodyMd, { color: ctaColor }]}>{ctaLabel}</Text>
      </Pressable>
    </View>
  );
}

function AppRow({
  app,
  theme,
  pending,
  onRevoke,
}: {
  app: ConnectedApp;
  theme: ReturnType<typeof useApprovalTheme>;
  pending: boolean;
  onRevoke: () => void;
}) {
  const revoked = app.revokedAt !== null;
  const subtitleParts: string[] = [];
  if (app.lastApprovalDecidedAt) subtitleParts.push(`last approval ${relativeTime(app.lastApprovalDecidedAt)}`);
  else if (app.lastUsedAt) subtitleParts.push(`last seen ${relativeTime(app.lastUsedAt)}`);
  if (revoked) subtitleParts.push(`revoked ${relativeTime(app.revokedAt)}`);
  const subtitle = subtitleParts.length > 0 ? subtitleParts.join(' · ') : 'Connected';

  const labelColor = revoked ? theme.textLo : theme.textHi;
  const ctaLabel = revoked ? 'Revoked' : pending ? 'Revoking…' : 'Revoke';
  const ctaColor = revoked ? theme.textLo : palette.deny.base;

  return (
    <View
      style={{
        paddingHorizontal: spacing[6],
        paddingVertical: spacing[3],
        flexDirection: 'row',
        alignItems: 'center',
        opacity: revoked ? 0.55 : 1,
      }}
    >
      <View style={{ flex: 1, marginRight: spacing[3] }}>
        <Text style={[type.bodyMd, { color: labelColor }]} numberOfLines={1}>
          {app.displayName}
        </Text>
        <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <Pressable
        onPress={revoked || pending ? undefined : onRevoke}
        disabled={revoked || pending}
        style={({ pressed }) => ({
          paddingHorizontal: spacing[3],
          paddingVertical: spacing[2],
          borderRadius: radii.md,
          backgroundColor: pressed && !revoked && !pending ? theme.bg2 : 'transparent',
        })}
      >
        <Text style={[type.bodyMd, { color: ctaColor }]}>{ctaLabel}</Text>
      </Pressable>
    </View>
  );
}

function ToggleRow({
  label,
  description,
  value,
  onChange,
  theme,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  theme: ReturnType<typeof useApprovalTheme>;
}) {
  return (
    <View
      style={{
        paddingHorizontal: spacing[6],
        paddingVertical: spacing[3],
        flexDirection: 'row',
        alignItems: 'center',
      }}
    >
      <View style={{ flex: 1, marginRight: spacing[3] }}>
        <Text style={[type.bodyMd, { color: theme.textHi }]}>{label}</Text>
        {description ? (
          <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>
            {description}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: theme.bg3, true: palette.brand.deep }}
        thumbColor={value ? palette.brand.base : theme.textMd}
      />
    </View>
  );
}
