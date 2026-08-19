import { Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

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
  /** Swipe-left to acknowledge. Omit to disable the gesture entirely. */
  onSwipeAcknowledge?: () => void;
  /** Selection mode: render a checkbox instead of reacting to a plain tap. */
  selectable?: boolean;
  selected?: boolean;
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
  onSwipeAcknowledge,
  selectable = false,
  selected = false,
}: Props) {
  const theme = useApprovalTheme('dark');
  const dot = severityColor(alert.severity);
  const subtitle = alert.deviceName ?? '';
  const time = relativeTime(alert.createdAt);

  // Revealed behind a left swipe. Acknowledging is the only destructive-ish
  // action offered here, and it is reversible from the web UI, so a single
  // swipe commits rather than asking for confirmation — the row is removed
  // optimistically and restored if the server refuses.
  const renderAcknowledgeAction = () => (
    <View
      style={{
        justifyContent: 'center',
        alignItems: 'flex-end',
        backgroundColor: palette.approve.base,
        paddingHorizontal: spacing[5],
        flex: 1,
      }}
    >
      <Text style={{ ...type.meta, color: palette.approve.onBase }}>Acknowledge</Text>
    </View>
  );

  const body = (
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
        {selectable ? (
          // The severity dot gives up its slot in selection mode so the
          // checkbox lands in the same column the eye already tracks.
          <View
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected }}
            style={{
              width: 20,
              height: 20,
              borderRadius: 10,
              borderWidth: 2,
              borderColor: selected ? palette.brand.base : theme.border,
              backgroundColor: selected ? palette.brand.base : 'transparent',
              marginRight: spacing[3],
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {selected ? (
              <Text style={{ color: theme.textHi, fontSize: 13, lineHeight: 16 }}>✓</Text>
            ) : null}
          </View>
        ) : (
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: dot,
              marginRight: spacing[3],
            }}
          />
        )}
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

  // Selection mode disables the gesture: a half-swipe while ticking boxes
  // would fire an action the user did not intend.
  if (!onSwipeAcknowledge || selectable) return body;

  return (
    <ReanimatedSwipeable
      friction={2}
      rightThreshold={48}
      renderRightActions={renderAcknowledgeAction}
      onSwipeableOpen={(direction) => {
        if (direction === 'right') {
          haptic.tap();
          onSwipeAcknowledge();
        }
      }}
    >
      {body}
    </ReanimatedSwipeable>
  );
}
