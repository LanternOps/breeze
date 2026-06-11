import { useEffect } from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  withTiming,
  Easing,
  cancelAnimation,
  runOnJS,
} from 'react-native-reanimated';
import { useApprovalTheme } from '../../../theme';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

interface Props {
  expiresAt: string;
  size?: number;
  stroke?: number;
  onExpire?: () => void;
}

export function CountdownRing({ expiresAt, size = 56, stroke = 3, onExpire }: Props) {
  const theme = useApprovalTheme('dark');
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  const totalMs = Math.max(1, new Date(expiresAt).getTime() - Date.now());
  const progress = useSharedValue(1);

  useEffect(() => {
    const remaining = Math.max(0, new Date(expiresAt).getTime() - Date.now());
    progress.value = remaining / totalMs;
    progress.value = withTiming(
      0,
      { duration: remaining, easing: Easing.linear },
      (finished) => {
        if (finished && onExpire) {
          runOnJS(onExpire)();
        }
      }
    );
    return () => cancelAnimation(progress);
  }, [expiresAt]);

  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: circumference * (1 - progress.value),
  }));

  return (
    <View>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={theme.bg3}
          strokeWidth={stroke}
          fill="none"
        />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={theme.brand}
          strokeWidth={stroke}
          strokeDasharray={`${circumference} ${circumference}`}
          animatedProps={animatedProps}
          fill="none"
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
    </View>
  );
}
