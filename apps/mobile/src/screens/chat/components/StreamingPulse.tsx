import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { useApprovalTheme, spacing } from '../../../theme';
import { ease } from '../../../lib/motion';

// Three brand-teal dots that pulse opacity in a staggered wave. Renders
// under the latest assistant row while waiting for the first content_delta.
// No bounce, no scale change. Just opacity, ease-out-quint. Honors
// prefers-reduced-motion by sitting at full opacity instead of pulsing.
export function StreamingPulse() {
  const theme = useApprovalTheme('dark');
  const reducedMotion = useReducedMotion();
  const a = useSharedValue(0.3);
  const b = useSharedValue(0.3);
  const c = useSharedValue(0.3);

  useEffect(() => {
    if (reducedMotion) {
      a.value = 1;
      b.value = 1;
      c.value = 1;
      return;
    }
    const cycle = (sv: typeof a) =>
      withRepeat(
        withSequence(
          withTiming(1, { duration: 360, easing: ease }),
          withTiming(0.3, { duration: 360, easing: ease }),
        ),
        -1,
        false,
      );
    a.value = cycle(a);
    const tB = setTimeout(() => { b.value = cycle(b); }, 120);
    const tC = setTimeout(() => { c.value = cycle(c); }, 240);
    return () => {
      clearTimeout(tB);
      clearTimeout(tC);
      cancelAnimation(a);
      cancelAnimation(b);
      cancelAnimation(c);
    };
  }, [reducedMotion]);

  const aStyle = useAnimatedStyle(() => ({ opacity: a.value }));
  const bStyle = useAnimatedStyle(() => ({ opacity: b.value }));
  const cStyle = useAnimatedStyle(() => ({ opacity: c.value }));

  const dot = (style: ReturnType<typeof useAnimatedStyle>) => (
    <Animated.View
      style={[
        {
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: theme.brand,
          marginHorizontal: 3,
        },
        style,
      ]}
    />
  );

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing[2],
      }}
    >
      {dot(aStyle)}
      {dot(bStyle)}
      {dot(cStyle)}
    </View>
  );
}
