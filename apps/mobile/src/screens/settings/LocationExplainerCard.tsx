import { Pressable, StyleSheet, Text, View } from 'react-native';

import { palette, radii, spacing, type } from '../../theme';

import { useLocationSuggestionState } from './useLocationSuggestionState';

/**
 * First-run card on the Time tab. Shown only when the partner enabled the
 * feature and the OS has never been asked; "Turn on" is what raises the system
 * dialog. "Not now" is remembered for 30 days.
 */
export function LocationExplainerCard(): React.JSX.Element | null {
  const { explainerShown, explainer, turnOn, dismissExplainer } = useLocationSuggestionState();
  if (!explainerShown) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{explainer.title}</Text>
      <Text style={styles.body}>{explainer.body}</Text>
      <View style={styles.actions}>
        <Pressable style={styles.secondary} onPress={() => void dismissExplainer()} accessibilityRole="button">
          <Text style={styles.secondaryText}>{explainer.secondary}</Text>
        </Pressable>
        <Pressable style={styles.primary} onPress={() => void turnOn()} accessibilityRole="button">
          <Text style={styles.primaryText}>{explainer.primary}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.dark.bg1,
    borderWidth: 1,
    borderColor: palette.dark.border,
    borderRadius: radii.md,
    padding: spacing['4'],
    gap: spacing['2'],
    marginBottom: spacing['3'],
  },
  title: { ...type.bodyLg, color: palette.dark.textHi },
  body: { ...type.body, color: palette.dark.textMd },
  actions: { flexDirection: 'row', gap: spacing['2'], justifyContent: 'flex-end' },
  secondary: {
    borderWidth: 1,
    borderColor: palette.dark.border,
    borderRadius: radii.full,
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['2'],
  },
  secondaryText: { ...type.meta, color: palette.dark.textMd },
  primary: {
    backgroundColor: palette.brand.deep,
    borderWidth: 1,
    borderColor: palette.brand.base,
    borderRadius: radii.full,
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['2'],
  },
  primaryText: { ...type.meta, color: palette.dark.textHi },
});
