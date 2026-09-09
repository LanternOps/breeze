import { useEffect } from 'react';
import { Text } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useApprovalTheme, palette, radii, spacing, type } from '../theme';
import { duration, ease } from '../lib/motion';

interface Props {
  text: string;
  kind: 'success' | 'error';
  onHidden: () => void;
}

/**
 * The toast pill. Slides down + fades in 240ms, holds 1800ms, exits 180ms.
 *
 * Presentational only: it is mounted by `toast/ToastHost`'s outlet, which owns
 * whether a toast exists and which one. Screens post through
 * `useToast().show(...)` and never render this directly — mounting it per
 * screen, each with its own bottom offset, is what put toasts on top of
 * composers, inputs and the timer bar (#5368).
 *
 * Anchored to the TOP safe-area inset (below the status bar, above the screen
 * headers) and `pointerEvents="none"`, so it competes with nothing on screen
 * and swallows no taps.
 */
export function Toast({ text, kind, onHidden }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useApprovalTheme('dark');
  const opacity = useSharedValue(0);
  const ty = useSharedValue(-20);

  useEffect(() => {
    opacity.value = withTiming(1, { duration: duration.base, easing: ease });
    ty.value = withTiming(0, { duration: duration.base, easing: ease });
    const t = setTimeout(() => {
      opacity.value = withTiming(0, { duration: duration.fast, easing: ease });
      ty.value = withTiming(-10, { duration: duration.fast, easing: ease }, (finished) => {
        if (finished) runOnJS(onHidden)();
      });
    }, 1800);
    return () => clearTimeout(t);
  }, []);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: ty.value }],
  }));

  const bg = kind === 'success' ? theme.approve : theme.deny;
  const fg = kind === 'success' ? palette.approve.onBase : palette.deny.onBase;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: spacing[6],
          right: spacing[6],
          top: insets.top + spacing[2],
          padding: spacing[4],
          borderRadius: radii.md,
          backgroundColor: bg,
        },
        style,
      ]}
    >
      <Text style={[type.bodyMd, { color: fg }]}>{text}</Text>
    </Animated.View>
  );
}
