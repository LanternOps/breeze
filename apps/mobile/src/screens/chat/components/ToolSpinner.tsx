import { useEffect } from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

interface Props {
  size?: number;
  color: string;
}

// 12px brand-teal arc that rotates linearly. Used in ToolIndicator's
// "started" state to mark in-flight tool calls. Reduced-motion: shows the
// arc at rest (no rotation).
export function ToolSpinner({ size = 12, color }: Props) {
  const reducedMotion = useReducedMotion();
  const rotation = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) {
      rotation.value = 0;
      return;
    }
    rotation.value = withRepeat(
      withTiming(360, { duration: 900, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(rotation);
  }, [reducedMotion]);

  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const r = size / 2 - 1;
  const c = 2 * Math.PI * r;
  // Visible arc spans ~70% of the circle.
  const dash = c * 0.7;
  const gap = c - dash;

  return (
    <Animated.View style={style}>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${gap}`}
          fill="none"
        />
      </Svg>
    </Animated.View>
  );
}
