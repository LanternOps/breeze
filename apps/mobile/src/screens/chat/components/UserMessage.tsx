import { Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { useApprovalTheme, spacing, radii, type } from '../../../theme';

interface Props {
  content: string;
}

// User messages: subtle Surface-2 pill, right-aligned. Asymmetric with the
// AI canvas treatment by design (DESIGN.md "AI is canvas, user is bubble").
export function UserMessage({ content }: Props) {
  const theme = useApprovalTheme('dark');
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      style={{
        paddingHorizontal: spacing[6],
        marginTop: spacing[5],
        alignItems: 'flex-end',
      }}
    >
      <View
        style={{
          maxWidth: '82%',
          backgroundColor: theme.bg2,
          borderRadius: radii.lg,
          paddingHorizontal: spacing[4],
          paddingVertical: spacing[3],
        }}
      >
        <Text style={[type.body, { color: theme.textHi }]}>{content}</Text>
      </View>
    </Animated.View>
  );
}
