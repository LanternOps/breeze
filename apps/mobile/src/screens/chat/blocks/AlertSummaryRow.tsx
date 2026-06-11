import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { useApprovalTheme, spacing, type } from '../../../theme';
import { haptic } from '../../../lib/motion';
import { FleetBar } from '../../../components/FleetBar';
import { AlertCard, type AlertLike } from './AlertCard';

interface Props {
  alerts: AlertLike[];
  total: number;
}

interface Aggregate {
  total: number;
  critical: number;
  warning: number;
  info: number;
}

function aggregate(alerts: AlertLike[], totalReported: number): Aggregate {
  let critical = 0;
  let warning = 0;
  let info = 0;
  for (const a of alerts) {
    const sev = (a.severity ?? '').toLowerCase();
    if (sev === 'critical' || sev === 'high') critical++;
    else if (sev === 'medium' || sev === 'low') warning++;
    else info++;
  }
  return { total: totalReported, critical, warning, info };
}

// Summary row for >2 alerts. Reuses FleetBar with severity buckets
// remapped: critical → critical (red), warning → warning (amber), info →
// healthy (green) so a quiet inbox still shows presence. Tap expands the
// top 5 inline as AlertCards.
export function AlertSummaryRow({ alerts, total }: Props) {
  const theme = useApprovalTheme('dark');
  const [expanded, setExpanded] = useState(false);
  const agg = aggregate(alerts, total);

  const summary =
    agg.critical > 0
      ? `${agg.total} alerts · ${agg.critical} critical`
      : agg.warning > 0
        ? `${agg.total} alerts · ${agg.warning} warning`
        : `${agg.total} alerts.`;

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
            healthy: agg.info,
            warning: agg.warning,
            critical: agg.critical,
          }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: spacing[2] }}>
          <Text style={[type.body, { color: theme.textHi, flex: 1 }]}>{summary}</Text>
          <Text style={[type.meta, { color: theme.textLo }]}>{expanded ? 'Hide' : 'Show'}</Text>
        </View>
        {alerts.length < agg.total ? (
          <Text style={[type.meta, { color: theme.textLo, marginTop: spacing[1] }]}>
            Showing {alerts.length} of {agg.total}.
          </Text>
        ) : null}
      </Pressable>

      {expanded ? (
        <Animated.View
          entering={FadeIn.duration(240)}
          exiting={FadeOut.duration(180)}
          style={{ marginTop: spacing[2] }}
        >
          {alerts.slice(0, 5).map((a, i) => (
            <AlertCard key={a.id ?? `a-${i}`} alert={a} />
          ))}
        </Animated.View>
      ) : null}
    </View>
  );
}
