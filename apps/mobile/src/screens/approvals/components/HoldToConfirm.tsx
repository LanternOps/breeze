import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  cancelAnimation,
  runOnJS,
} from 'react-native-reanimated';
import { useApprovalTheme, type, spacing, radii } from '../../../theme';
import { ease, duration, haptic } from '../../../lib/motion';

interface Props {
  label: string;
  onComplete: () => void;
  durationMs?: number;
}

export function HoldToConfirm({ label, onComplete, durationMs = 5000 }: Props) {
  const theme = useApprovalTheme('dark');
  const progress = useSharedValue(0);

  useEffect(() => () => cancelAnimation(progress), []);

  const onPressIn = () => {
    haptic.tap();
    progress.value = withTiming(1, { duration: durationMs }, (finished) => {
      if (finished) {
        runOnJS(haptic.hold)();
        runOnJS(onComplete)();
      }
    });
  };
  const onPressOut = () => {
    progress.value = withTiming(0, { duration: duration.fast, easing: ease });
  };

  // Reanimated 3+ supports animated string widths via useAnimatedStyle.
  // Anchor the fill to the left by leaving `left: 0` static and letting
  // width grow rightward — avoids transformOrigin which is unreliable on
  // RN's old architecture.
  const fillStyle = useAnimatedStyle(() => ({
    width: `${progress.value * 100}%` as `${number}%`,
  }));

  return (
    <Pressable onPressIn={onPressIn} onPressOut={onPressOut}>
      <View
        style={{
          height: 56,
          borderRadius: radii.lg,
          backgroundColor: theme.bg2,
          overflow: 'hidden',
          justifyContent: 'center',
          alignItems: 'center',
          borderColor: theme.brand,
          borderWidth: 1,
        }}
      >
        <Animated.View
          style={[
            {
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              backgroundColor: theme.brand,
              opacity: 0.35,
            },
            fillStyle,
          ]}
        />
        <Text style={[type.bodyMd, { color: theme.textHi }]}>{label}</Text>
      </View>
    </Pressable>
  );
}
