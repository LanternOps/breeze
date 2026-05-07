import { Pressable, Text, View } from 'react-native';

import { useApprovalTheme, spacing, radii, type } from '../../../theme';
import { haptic } from '../../../lib/motion';

interface Props {
  onPick: (text: string) => void;
}

const SUGGESTIONS = [
  'What broke last night?',
  'Show fleet status',
  'What ran via MCP today?',
] as const;

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
        {SUGGESTIONS.map((s) => (
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
