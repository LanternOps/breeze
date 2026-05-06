import { useEffect } from 'react';
import { Text } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, runOnJS } from 'react-native-reanimated';
import { useApprovalTheme, type, spacing, radii } from '../../../theme';
import { duration, ease } from '../../../lib/motion';

interface Props {
  visible: boolean;
  text: string;
  kind: 'approve' | 'deny';
  onHidden: () => void;
}

export function ApprovalToast({ visible, text, kind, onHidden }: Props) {
  const theme = useApprovalTheme('dark');
  const opacity = useSharedValue(0);
  const ty = useSharedValue(20);

  useEffect(() => {
    if (visible) {
      opacity.value = withTiming(1, { duration: duration.base, easing: ease });
      ty.value = withTiming(0, { duration: duration.base, easing: ease });
      const t = setTimeout(() => {
        opacity.value = withTiming(0, { duration: duration.fast, easing: ease });
        ty.value = withTiming(10, { duration: duration.fast, easing: ease }, (finished) => {
          if (finished) runOnJS(onHidden)();
        });
      }, 1800);
      return () => clearTimeout(t);
    }
  }, [visible]);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: ty.value }],
  }));

  if (!visible) return null;

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: spacing[6],
          right: spacing[6],
          bottom: spacing[20],
          padding: spacing[4],
          borderRadius: radii.md,
          backgroundColor: kind === 'approve' ? theme.approve : theme.deny,
        },
        style,
      ]}
    >
      <Text style={[type.bodyMd, { color: kind === 'approve' ? '#04230f' : '#fff5f3' }]}>{text}</Text>
    </Animated.View>
  );
}
