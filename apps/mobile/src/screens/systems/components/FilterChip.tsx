import { Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { useApprovalTheme, radii, spacing, type } from '../../../theme';
import { haptic } from '../../../lib/motion';

interface Props {
  label: string;
  onClear: () => void;
}

function CloseGlyph({ color }: { color: string }) {
  return (
    <Svg width={12} height={12} viewBox="0 0 24 24">
      <Path
        d="M6 6 L18 18 M6 18 L18 6"
        stroke={color}
        strokeWidth={2.25}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

export function FilterChip({ label, onClear }: Props) {
  const theme = useApprovalTheme('dark');
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(180)}
      style={{
        paddingHorizontal: spacing[6],
        paddingTop: spacing[4],
      }}
    >
      <Pressable
        onPress={() => {
          haptic.tap();
          onClear();
        }}
        hitSlop={6}
        style={({ pressed }) => ({
          alignSelf: 'flex-start',
          paddingHorizontal: spacing[4],
          paddingVertical: spacing[3],
          minHeight: 44,
          borderRadius: radii.full,
          backgroundColor: pressed ? theme.bg3 : theme.bg2,
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing[2],
        })}
      >
        <Text
          style={[type.metaCaps, { color: theme.textHi }]}
          numberOfLines={1}
        >
          {label}
        </Text>
        <View style={{ width: 12, height: 12, alignItems: 'center', justifyContent: 'center' }}>
          <CloseGlyph color={theme.brand} />
        </View>
      </Pressable>
    </Animated.View>
  );
}
