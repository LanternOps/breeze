import { Pressable, Text, View } from 'react-native';

import { useApprovalTheme, spacing, radii, type } from '../../../theme';
import { haptic } from '../../../lib/motion';
// Chip copy lives in a pure `.ts` sibling so it is unit-testable — the mobile
// Vitest config includes only `src/**/*.test.ts`, never `.tsx` (#5362).
import { COLD_OPEN_SUGGESTIONS } from './coldOpenSuggestions';

interface Props {
  onPick: (text: string) => void;
}

export function ColdOpenChips({ onPick }: Props) {
  const theme = useApprovalTheme('dark');

  return (
    <View style={{ paddingHorizontal: spacing[6], paddingBottom: spacing[3] }}>
      <Text
        style={[
          type.meta,
          { color: theme.textMd, marginBottom: spacing[3] },
        ]}
      >
        Ask Breeze.
      </Text>
      <View style={{ gap: spacing[2] }}>
        {COLD_OPEN_SUGGESTIONS.map((s) => (
          <Pressable
            key={s}
            onPress={() => {
              haptic.tap();
              onPick(s);
            }}
            style={({ pressed }) => ({
              backgroundColor: theme.bg2,
              borderRadius: radii.lg,
              paddingHorizontal: spacing[4],
              paddingVertical: spacing[3],
              borderWidth: 1,
              borderColor: pressed ? theme.brand : 'transparent',
            })}
          >
            <Text style={[type.bodyMd, { color: theme.textHi }]}>{s}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
