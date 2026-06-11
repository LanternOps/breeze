import { Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { useApprovalTheme, spacing, type } from '../../../theme';
import { haptic } from '../../../lib/motion';
import type { OrgRollup } from '../useSystemsData';

interface Props {
  org: OrgRollup;
  onPress: () => void;
  showDivider?: boolean;
  dividerColor?: string;
}

export function OrgRow({ org, onPress, showDivider, dividerColor }: Props) {
  const theme = useApprovalTheme('dark');
  const sub =
    org.issueCount === 0
      ? `${org.deviceCount} ${org.deviceCount === 1 ? 'device' : 'devices'}, healthy`
      : `${org.deviceCount} ${org.deviceCount === 1 ? 'device' : 'devices'} · ${org.issueCount} ${org.issueCount === 1 ? 'issue' : 'issues'}`;

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(180)}
      layout={LinearTransition.duration(220)}
    >
      <Pressable
        onPress={() => {
          haptic.tap();
          onPress();
        }}
        style={({ pressed }) => ({
          paddingHorizontal: spacing[6],
          paddingVertical: spacing[3],
          backgroundColor: pressed ? theme.bg2 : 'transparent',
        })}
      >
        <Text style={[type.bodyMd, { color: theme.textHi }]} numberOfLines={1}>
          {org.name}
        </Text>
        <Text
          style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}
          numberOfLines={1}
        >
          {sub}
        </Text>
      </Pressable>
      {showDivider ? (
        <View
          style={{
            height: 1,
            backgroundColor: dividerColor ?? theme.border,
            marginLeft: spacing[6],
          }}
        />
      ) : null}
    </Animated.View>
  );
}
