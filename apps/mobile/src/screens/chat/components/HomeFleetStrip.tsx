import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';

import { useApprovalTheme, radii, spacing, type } from '../../../theme';
import { haptic } from '../../../lib/motion';
import { reportInternalError } from '../../../lib/errorReporting';
import { FleetBar } from '../../../components/FleetBar';
import { getMobileSummary, type MobileSummary } from '../../../services/systems';
import type { MainTabParamList } from '../../../navigation/MainNavigator';
import { formatFleetStripCopy } from './homeFleetStripCopy';

/**
 * Compact online/offline/issues strip shown above the cold-open chips on a
 * new conversation (#5141, decision 3 of #5117). Reuses the same
 * `/mobile/summary` fetch the Systems tab hero is built from (via
 * `getMobileSummary`, `services/systems.ts`) — no new endpoint. The parent
 * (HomeScreen) only mounts this while the conversation is empty, so it
 * disappears the instant the first message lands; no visibility prop needed
 * here.
 *
 * Fails soft: a skeleton covers the fetch, and any rejection hides the strip
 * entirely rather than showing a red banner above the composer — Home is not
 * the place to surface a Systems-tab data error.
 */
export function HomeFleetStrip() {
  const theme = useApprovalTheme('dark');
  const navigation = useNavigation<BottomTabNavigationProp<MainTabParamList>>();
  const [summary, setSummary] = useState<MobileSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMobileSummary()
      .then((s) => {
        if (cancelled) return;
        setSummary(s);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        // Hidden from the user by design (never a red banner on Home), but
        // still worth a Sentry breadcrumb — otherwise the strip going quiet
        // for every user (expired token, endpoint regression) has zero
        // signal anywhere. Mirrors useSystemsData.ts's handling of the same
        // getMobileSummary() call.
        reportInternalError(err, 'home-fleet-strip');
        setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return null;

  if (loading || !summary) {
    return (
      <View style={{ paddingHorizontal: spacing[6], marginBottom: spacing[4] }}>
        <View
          style={{
            height: 54,
            borderRadius: radii.lg,
            backgroundColor: theme.bg2,
          }}
        />
      </View>
    );
  }

  const { online, offline } = summary.devices;
  const issues = summary.alerts.active;

  return (
    <View style={{ paddingHorizontal: spacing[6], marginBottom: spacing[4] }}>
      <Pressable
        onPress={() => {
          haptic.tap();
          navigation.navigate('SystemsTab');
        }}
        style={({ pressed }) => ({
          backgroundColor: theme.bg2,
          borderRadius: radii.lg,
          padding: spacing[4],
          borderWidth: 1,
          borderColor: pressed ? theme.brand : 'transparent',
        })}
      >
        <FleetBar segments={{ healthy: online, warning: issues, critical: offline }} />
        <Text style={[type.bodyMd, { color: theme.textHi, marginTop: spacing[3] }]}>
          {formatFleetStripCopy(summary)}
        </Text>
      </Pressable>
    </View>
  );
}
