import { useEffect, useState } from 'react';
import {
  Alert,
  Dimensions,
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
  checkBiometricAvailability,
  isBiometricEnabled,
  setBiometricEnabled,
} from '../../../services/biometrics';
import { ease, duration } from '../../../lib/motion';
import { Avatar } from './Avatar';

interface Props {
  visible: boolean;
  onCancel: () => void;
}

const NOTIF_KEY = 'notificationsEnabled';

export function SettingsSheet({ visible, onCancel }: Props) {
  const theme = useApprovalTheme('dark');
  const dispatch = useAppDispatch();
  const insets = useSafeAreaInsets();
  const user = useAppSelector((s) => s.auth.user);

  const screenWidth = Dimensions.get('window').width;
  const sheetWidth = Math.min(screenWidth * 0.84, 420);

  const tx = useSharedValue(sheetWidth);
  const scrim = useSharedValue(0);

  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricOn, setBiometricOn] = useState(false);
  const [notificationsOn, setNotificationsOn] = useState(true);

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
    })();
  }, [visible, sheetWidth]);

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
            buildVersion={buildVersion}
            onToggleBiometric={onToggleBiometric}
            onToggleNotifications={onToggleNotifications}
            onSignOut={onSignOut}
          />
        </Animated.View>
      </View>
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
  buildVersion,
  onToggleBiometric,
  onToggleNotifications,
  onSignOut,
}: {
  user: { name: string; email: string } | null;
  theme: ReturnType<typeof useApprovalTheme>;
  insetTop: number;
  insetBottom: number;
  biometricAvailable: boolean;
  biometricOn: boolean;
  notificationsOn: boolean;
  buildVersion: string;
  onToggleBiometric: (v: boolean) => void;
  onToggleNotifications: (v: boolean) => void;
  onSignOut: () => void;
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

        <SectionDivider color={theme.border} />

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
