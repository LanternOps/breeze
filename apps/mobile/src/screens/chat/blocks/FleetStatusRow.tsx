import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { useApprovalTheme, spacing, type } from '../../../theme';
import { haptic } from '../../../lib/motion';
import { FleetBar } from '../../../components/FleetBar';
import type { DeviceLike } from './DeviceCard';
import { DeviceCard } from './DeviceCard';

interface Props {
  devices: DeviceLike[];
  total: number;
}

interface Aggregate {
  total: number;
  healthy: number;
  issues: number;
  offline: number;
}

function aggregate(devices: DeviceLike[], totalReported: number): Aggregate {
  let healthy = 0;
  let issues = 0;
  let offline = 0;
  for (const d of devices) {
    const s = (d.status ?? '').toLowerCase();
    if (s === 'online' || s === 'healthy' || s === 'active') healthy++;
    else if (s === 'offline' || s === 'decommissioned') offline++;
    else if (s) issues++;
  }
  // The aggregate is computed from the returned slice, but `total` is the
  // server's full count. If `total > devices.length`, the bar still reflects
  // the slice's proportions, which is the best we can do without another
  // round-trip. Honest: we label the count as "showing N of T" inline below.
  return { total: totalReported, healthy, issues, offline };
}

// A single horizontal proportion bar (no gaps, no rounding) above one
// declarative line of body text. Tap to expand to show the top 5 devices
// inline; tap again to collapse.
export function FleetStatusRow({ devices, total }: Props) {
  const theme = useApprovalTheme('dark');
  const [expanded, setExpanded] = useState(false);
  const agg = aggregate(devices, total);

  const summary =
    agg.issues === 0 && agg.offline === 0
      ? `${agg.total} devices, all healthy.`
      : `${agg.total} devices · ${agg.issues} issues · ${agg.offline} offline.`;

  return (
    <View style={{ marginTop: spacing[4] }}>
      <Pressable
        onPress={() => {
          haptic.tap();
          setExpanded((v) => !v);
        }}
        style={{ paddingHorizontal: spacing[6] }}
      >
        <FleetBar
          segments={{
            healthy: agg.healthy,
            warning: agg.issues,
            critical: agg.offline,
          }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: spacing[2] }}>
          <Text style={[type.body, { color: theme.textHi, flex: 1 }]}>{summary}</Text>
          <Text style={[type.meta, { color: theme.textLo }]}>{expanded ? 'Hide' : 'Show'}</Text>
        </View>
        {devices.length < agg.total ? (
          <Text style={[type.meta, { color: theme.textLo, marginTop: spacing[1] }]}>
            Showing {devices.length} of {agg.total}.
          </Text>
        ) : null}
      </Pressable>

      {expanded ? (
        <Animated.View
          entering={FadeIn.duration(240)}
          exiting={FadeOut.duration(180)}
          style={{ marginTop: spacing[2] }}
        >
          {devices.slice(0, 5).map((d, i) => (
            <DeviceCard key={d.id ?? `dev-${i}`} device={d} />
          ))}
        </Animated.View>
      ) : null}
    </View>
  );
}
