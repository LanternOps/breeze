import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { palette, radii, spacing, type } from '../theme';
import type { WorkType } from '../services/workTypes';
import { isWorkTypeOptionSelected, workTypePickerOptions } from './workTypePickerOptions';

interface Props {
  workTypes: readonly WorkType[];
  /** `undefined` = Default (the server applies the ticket category's default). */
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  disabled?: boolean;
  testID?: string;
}

/**
 * A row of chips: "Default" plus one per active work type (#4628 W04). Labels
 * only — the server resolves the rate card row and stamps the money.
 *
 * Renders nothing when the partner has no work types or the list could not be
 * fetched: an empty control is noise, and time can always be logged without
 * one.
 */
export function WorkTypePicker({ workTypes, value, onChange, disabled, testID }: Props) {
  const options = workTypePickerOptions(workTypes);
  if (options.length === 0) return null;

  return (
    <View testID={testID} style={styles.wrap}>
      <Text style={styles.label}>Work type</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {options.map((option) => {
          const selected = isWorkTypeOptionSelected(option, value);
          return (
            <Pressable
              key={option.key}
              testID={testID ? `${testID}-option-${option.key}` : undefined}
              onPress={() => onChange(option.value)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={`Work type: ${option.label}`}
              accessibilityState={{ selected, disabled: Boolean(disabled) }}
              style={[styles.chip, selected && styles.chipSelected]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing['3'] },
  label: { ...type.meta, color: palette.dark.textLo, marginBottom: spacing['2'] },
  row: { flexDirection: 'row', gap: spacing['2'] },
  chip: {
    paddingHorizontal: spacing['3'],
    paddingVertical: spacing['2'],
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: palette.dark.textLo,
  },
  chipSelected: { backgroundColor: palette.brand.deep, borderColor: palette.brand.base },
  chipText: { ...type.meta, color: palette.dark.textMd },
  chipTextSelected: { color: palette.dark.textHi },
});
