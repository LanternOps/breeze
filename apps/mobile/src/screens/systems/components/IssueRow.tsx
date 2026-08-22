import { useCallback, useRef } from 'react';
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

/**
 * Two swipe-opens closer together than this are treated as one gesture. Long
 * enough to swallow a duplicated event, far below the time a user needs to
 * deliberately swipe the same row twice.
 */
const DOUBLE_DISPATCH_WINDOW_MS = 600;

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
  // Collapse a same-tick double open into one dispatch. The optimistic path
  // removes the row, so the unmount usually ends the gesture — but that is a
  // race, not a guarantee. The refcounting is symmetric so a double open nets
  // to zero rather than corrupting it; the real cost is a second, redundant
  // acknowledge request for an alert already being acknowledged.
  //
  // Deliberately time-boxed rather than a permanent per-row latch: a failed
  // acknowledge RESTORES the row, which is the whole point of the rollback
  // path, and a latch that never resets would leave that restored row
  // un-acknowledgeable by swipe for as long as React kept the instance alive.
  // Recovering from a failure must not cost the user the gesture.
  const lastDispatchRef = useRef(0);
  const handleSwipeOpen = useCallback(
    (direction: 'left' | 'right') => {
      if (direction !== 'right') return;
      const now = Date.now();
      if (now - lastDispatchRef.current < DOUBLE_DISPATCH_WINDOW_MS) return;
      lastDispatchRef.current = now;
      haptic.tap();
      onSwipeAcknowledge?.();
    },
    [onSwipeAcknowledge]
  );

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
      onSwipeableOpen={handleSwipeOpen}
    >
      {body}
    </ReanimatedSwipeable>
  );
}
