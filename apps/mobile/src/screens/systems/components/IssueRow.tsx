import { Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { useApprovalTheme, palette, spacing, type } from '../../../theme';
import type { Alert } from '../../../services/api';
import { haptic } from '../../../lib/motion';
import { relativeTime } from '../../../lib/relativeTime';

interface Props {
  alert: Alert;
  onPress: () => void;
  onLongPress?: () => void;
  showDivider?: boolean;
  dividerColor?: string;
}

function severityColor(sev: Alert['severity']): string {
  switch (sev) {
    case 'critical':
      return palette.deny.base;
    case 'high':
      return palette.deny.base;
    case 'medium':
      return palette.warning.base;
    case 'low':
      return palette.warning.base;
    case 'info':
    default:
      return palette.dark.textLo;
  }
}

export function IssueRow({
  alert,
  onPress,
  onLongPress,
  showDivider,
  dividerColor,
}: Props) {
  const theme = useApprovalTheme('dark');
  const dot = severityColor(alert.severity);
  const subtitle = alert.deviceName ?? '';
  const time = relativeTime(alert.createdAt);

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
        onLongPress={
          onLongPress
            ? () => {
                haptic.tap();
                onLongPress();
              }
            : undefined
        }
        style={({ pressed }) => ({
          paddingHorizontal: spacing[6],
          paddingVertical: spacing[3],
          backgroundColor: pressed ? theme.bg2 : 'transparent',
          flexDirection: 'row',
          alignItems: 'center',
        })}
      >
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: dot,
            marginRight: spacing[3],
          }}
        />
        <View style={{ flex: 1, marginRight: spacing[3] }}>
          <Text
            style={[type.bodyMd, { color: theme.textHi }]}
            numberOfLines={1}
          >
            {alert.title}
          </Text>
          {subtitle ? (
            <Text
              style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}
              numberOfLines={1}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
        <Text style={[type.meta, { color: theme.textLo }]}>{time}</Text>
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
