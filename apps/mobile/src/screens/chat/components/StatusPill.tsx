import { Pressable, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { createSelector } from '@reduxjs/toolkit';

import { useApprovalTheme, palette, radii, spacing, type } from '../../../theme';
import { useAppSelector, selectAlerts } from '../../../store';
import { haptic } from '../../../lib/motion';
import { useNetworkConnected } from '../../../lib/useNetworkConnected';
import type { MainTabParamList } from '../../../navigation/MainNavigator';

/**
 * Module-scope (not per-render) so `createSelector`'s memoization actually
 * holds: it caches on the identity of `selectAlerts(state)`, i.e. the alerts
 * array reference. Redux/immer only gives that array a new reference when an
 * alerts-slice reducer actually ran, so any unrelated dispatch (tickets,
 * auth, timer ticks, ...) returns the SAME `{ critical, warning }` object —
 * which is what stops useSelector from re-rendering this component on every
 * store update (the "Selector ... returned a different result" warning).
 * An inline selector here would allocate a brand-new object every call
 * regardless of whether the alerts array changed, which is what caused it.
 */
// Exported for StatusPill.test.ts, which imports it directly rather than
// mounting the component (this app has no RN test renderer configured — see
// vitest.config.ts).
export const selectAlertCounts = createSelector([selectAlerts], (alerts) => {
  let critical = 0;
  let warning = 0;
  for (const a of alerts) {
    if (a.acknowledged) continue;
    if (a.severity === 'critical') critical++;
    else if (a.severity === 'high' || a.severity === 'medium') warning++;
  }
  return { critical, warning };
});

// Copy ladder, in priority order:
//   1. Offline → deny-red, "Offline · Approvals still work"  (deferred — needs NetInfo)
//   2. Critical unacked count > 0 → deny-red, "{n} critical"
//   3. Warning unacked count > 0 → warning-amber, "{n} warning"
//   4. Default → small brand-teal dot, no text
//
// Reads from the existing alertsSlice; the AlertList screen keeps it warm.
// Home triggers a fetch on mount (HomeScreen) so first paint isn't stale.
export function StatusPill() {
  const theme = useApprovalTheme('dark');
  const navigation = useNavigation<BottomTabNavigationProp<MainTabParamList>>();
  const connected = useNetworkConnected();

  const counts = useAppSelector(selectAlertCounts);

  // Copy ladder, top wins:
  //   1. Offline → deny-red, "Offline · Approvals still work"
  //   2. Critical unacked count > 0 → deny-red, "{n} critical"
  //   3. Warning unacked count > 0 → warning-amber, "{n} warning"
  //   4. Default → bare brand-teal dot, no chrome
  let dotColor: string = theme.brand;
  let label: string | null = null;

  if (!connected) {
    dotColor = palette.deny.base;
    label = 'Offline · Approvals still work';
  } else if (counts.critical > 0) {
    dotColor = palette.deny.base;
    label = `${counts.critical} critical`;
  } else if (counts.warning > 0) {
    dotColor = palette.warning.base;
    label = `${counts.warning} warning`;
  }

  const visible = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: label ? spacing[3] : 0,
        height: 32,
        borderRadius: radii.full,
        backgroundColor: label ? theme.bg2 : 'transparent',
      }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: dotColor,
          marginRight: label ? spacing[2] : 0,
        }}
      />
      {label ? (
        <Text style={[type.meta, { color: theme.textHi }]}>{label}</Text>
      ) : null}
    </View>
  );

  // Without a label, or when offline, the pill is ambient — no tap.
  // With an alert count it jumps to Systems so the count is actionable.
  if (!label || !connected) return visible;

  return (
    <Pressable
      onPress={() => {
        haptic.tap();
        navigation.navigate('SystemsTab');
      }}
      hitSlop={6}
    >
      {visible}
    </Pressable>
  );
}
