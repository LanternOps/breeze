import { useEffect } from 'react';
import { Pressable, Text } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { radii, spacing, type, useApprovalTheme } from '../theme';
import { duration, ease } from '../lib/motion';

interface Props {
  text: string;
  /** How long the action stays retractable. Also this toast's lifetime. */
  windowMs: number;
  onUndo: () => void;
  /** Fired when the window closes WITHOUT an undo — the caller then commits. */
  onExpire: () => void;
  bottomOffset?: number;
}

/**
 * A toast that holds an action open instead of announcing a finished one.
 *
 * Separate from `Toast` on purpose: that one is a fixed-lifetime notice with no
 * controls, and acknowledging needs the opposite — the request has NOT been
 * sent yet, and this is the only chance to stop it. There is no unacknowledge
 * route, so a stray swipe is otherwise unrecoverable.
 *
 * `onExpire` is what commits the action, so it must fire exactly once. The
 * timer is cleared on unmount and the tap path cancels before calling back, so
 * neither can double-fire.
 */
export function UndoToast({
  text,
  windowMs,
  onUndo,
  onExpire,
  bottomOffset,
}: Props) {
  const theme = useApprovalTheme('dark');
  const opacity = useSharedValue(0);
  const ty = useSharedValue(20);

  useEffect(() => {
    opacity.value = withTiming(1, { duration: duration.base, easing: ease });
    ty.value = withTiming(0, { duration: duration.base, easing: ease });

    const t = setTimeout(() => {
      // Commit FIRST, then animate out. Reversing these would leave a window
      // where the toast is gone but the request has not been queued, and a
      // navigation landing in it would drop the acknowledge silently.
      onExpire();
      opacity.value = withTiming(0, { duration: duration.fast, easing: ease });
      ty.value = withTiming(10, { duration: duration.fast, easing: ease });
    }, windowMs);

    return () => clearTimeout(t);
    // `text` is in the deps so a NEW batch restarts the window rather than
    // inheriting the remainder of the previous one.
  }, [text, windowMs]);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: ty.value }],
  }));

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: spacing[6],
          right: spacing[6],
          bottom: bottomOffset ?? spacing[20],
          paddingVertical: spacing[3],
          paddingLeft: spacing[4],
          paddingRight: spacing[2],
          borderRadius: radii.md,
          backgroundColor: theme.bg3,
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing[3],
        },
        style,
      ]}
    >
      <Text style={[type.bodyMd, { color: theme.textHi, flex: 1 }]} numberOfLines={1}>
        {text}
      </Text>
      <Pressable
        onPress={onUndo}
        accessibilityRole="button"
        accessibilityLabel="Undo acknowledge"
        // Comfortably past the 44pt minimum: this is the retraction control for
        // an action that cannot be reversed once it is sent.
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        style={{ paddingHorizontal: spacing[3], paddingVertical: spacing[2] }}
      >
        <Text style={[type.metaCaps, { color: theme.approve }]}>UNDO</Text>
      </Pressable>
    </Animated.View>
  );
}
