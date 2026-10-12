import { Pressable, Text, View } from 'react-native';

import { spacing, type, useApprovalTheme } from '../../theme';

import { useLocationSuggestionState } from './useLocationSuggestionState';

/**
 * Settings → "Location suggestions". A status readout that doubles as the
 * control when there is one: "Turn on" asks the OS, a blocked or approximate
 * state opens system Settings. Hidden entirely unless the partner enabled the
 * feature.
 */
export function LocationSuggestionsRow({
  theme,
}: {
  theme: ReturnType<typeof useApprovalTheme>;
}): React.JSX.Element | null {
  const { row, turnOn, openSettings } = useLocationSuggestionState();
  if (!row.visible) return null;

  const body = (
    <View style={{ flex: 1, marginRight: spacing[3] }}>
      <Text style={[type.bodyMd, { color: theme.textHi }]}>Location suggestions</Text>
      <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>{row.status}</Text>
      <Text style={[type.meta, { color: theme.textLo, marginTop: spacing[1] }]}>
        {row.description}
      </Text>
    </View>
  );
  const rowStyle = {
    paddingHorizontal: spacing[6],
    paddingVertical: spacing[3],
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
  };

  if (row.action === 'none') return <View style={rowStyle}>{body}</View>;

  return (
    <Pressable
      onPress={() => (row.action === 'request' ? void turnOn() : openSettings())}
      accessibilityRole="button"
      style={({ pressed }) => ({ ...rowStyle, backgroundColor: pressed ? theme.bg2 : 'transparent' })}
    >
      {body}
    </Pressable>
  );
}
