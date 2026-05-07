import { Pressable, Text, View } from 'react-native';

import { palette, radii, type } from '../../../theme';
import { haptic } from '../../../lib/motion';

interface Props {
  name: string | null | undefined;
  onPress?: () => void;
  size?: number;
}

function initials(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '·';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({ name, onPress, size = 32 }: Props) {
  // Brand-tinted text on brand-deep ground. Reads as "this is you, anchored
  // to the brand identity" without competing with status colors.
  const visible = (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radii.full,
        backgroundColor: palette.brand.deep,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={[
          type.metaCaps,
          {
            color: palette.dark.textHi,
            letterSpacing: 0.4,
            fontSize: 12,
            lineHeight: 14,
          },
        ]}
      >
        {initials(name)}
      </Text>
    </View>
  );

  if (!onPress) return visible;
  return (
    <Pressable
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      hitSlop={8}
      style={{
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {visible}
    </Pressable>
  );
}
