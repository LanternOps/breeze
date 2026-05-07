import { useEffect } from 'react';
import { Text } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useApprovalTheme, palette, radii, spacing, type } from '../theme';
import { duration, ease } from '../lib/motion';

interface Props {
  visible: boolean;
  text: string;
  kind: 'success' | 'error';
  onHidden: () => void;
  bottomOffset?: number;
}

// Bottom-anchored toast. Slides up + fades in 240ms, holds 1800ms, exits
// 180ms. Used by approval mode (success/error after a decision) and the
// settings sheet (post-action confirmations).
export function Toast({ visible, text, kind, onHidden, bottomOffset }: Props) {
  const theme = useApprovalTheme('dark');
  const opacity = useSharedValue(0);
  const ty = useSharedValue(20);

  useEffect(() => {
    if (!visible) return;
    opacity.value = withTiming(1, { duration: duration.base, easing: ease });
    ty.value = withTiming(0, { duration: duration.base, easing: ease });
    const t = setTimeout(() => {
      opacity.value = withTiming(0, { duration: duration.fast, easing: ease });
      ty.value = withTiming(10, { duration: duration.fast, easing: ease }, (finished) => {
        if (finished) runOnJS(onHidden)();
      });
    }, 1800);
    return () => clearTimeout(t);
  }, [visible]);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: ty.value }],
  }));

  if (!visible) return null;

  const bg = kind === 'success' ? theme.approve : theme.deny;
  const fg = kind === 'success' ? palette.approve.onBase : palette.deny.onBase;

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: spacing[6],
          right: spacing[6],
          bottom: bottomOffset ?? spacing[20],
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
