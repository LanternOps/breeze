import { Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { useApprovalTheme, spacing, type } from '../../../theme';
import { FleetBar, type FleetSegments } from '../../../components/FleetBar';

interface Props {
  copy: string;
  segments: FleetSegments | null;
  legend: string | null;
  loading: boolean;
}

// The lead. One Title-sized line, breakdown bar, optional legend.
// Skeletons take over when `loading` and there is no last-known data.
export function Hero({ copy, segments, legend, loading }: Props) {
  const theme = useApprovalTheme('dark');

  if (loading && !segments) {
    return (
      <View style={{ paddingHorizontal: spacing[6], paddingTop: spacing[6] }}>
        <View
          style={{
            height: 28,
            borderRadius: 6,
            backgroundColor: theme.bg2,
            width: '70%',
            marginBottom: spacing[4],
          }}
        />
        <View
          style={{
            height: 6,
            borderRadius: 0,
            backgroundColor: theme.bg2,
          }}
        />
      </View>
    );
  }

  return (
    <Animated.View
      entering={FadeIn.duration(240)}
      style={{ paddingHorizontal: spacing[6], paddingTop: spacing[6] }}
    >
      <Text style={[type.title, { color: theme.textHi }]}>{copy}</Text>
      <View style={{ marginTop: spacing[4] }}>
        <FleetBar segments={segments ?? { healthy: 0, warning: 0, critical: 0 }} />
      </View>
      {legend ? (
        <Text
          style={[type.meta, { color: theme.textMd, marginTop: spacing[2] }]}
        >
          {legend}
        </Text>
      ) : null}
    </Animated.View>
  );
}
