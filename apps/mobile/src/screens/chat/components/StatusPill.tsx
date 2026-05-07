import { Pressable, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';

import { useApprovalTheme, palette, radii, spacing, type } from '../../../theme';
import { useAppSelector } from '../../../store';
import { haptic } from '../../../lib/motion';
import type { MainTabParamList } from '../../../navigation/MainNavigator';

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

  const counts = useAppSelector((state) => {
    const alerts = state.alerts.alerts;
    let critical = 0;
    let warning = 0;
    for (const a of alerts) {
      if (a.acknowledged) continue;
      if (a.severity === 'critical') critical++;
      else if (a.severity === 'high' || a.severity === 'medium') warning++;
    }
    return { critical, warning };
  });

  let dotColor: string = theme.brand;
  let label: string | null = null;

  if (counts.critical > 0) {
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

  // Without a label the pill is purely ambient — no tap. With a label it
  // jumps to the Alerts tab so the count is actionable.
  if (!label) return visible;

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
