import { Pressable, Text, View } from 'react-native';

import { useApprovalTheme, palette, radii, spacing, type } from '../../../theme';
import { continuationCopy, type AiContinuationRequired } from '../modelPicker';

interface Props {
  required: AiContinuationRequired;
  busy: boolean;
  /** False when the refusal named no target offering and nothing is picked. */
  canContinue: boolean;
  onContinue: () => void;
  onKeep: () => void;
}

/**
 * W05 (spec §9.2): a model switch that cannot resume this chat. The message
 * is parked, not lost; the technician either continues in a new chat seeded
 * with a summary, or keeps the current model and sends it here. Mirrors the
 * web's AiContinuationPrompt.
 */
export function ContinuationPrompt({ required, busy, canContinue, onContinue, onKeep }: Props) {
  const theme = useApprovalTheme('dark');
  const copy = continuationCopy(required);
  return (
    <View
      accessibilityRole="alert"
      testID="ai-continuation-prompt"
      style={{
        marginHorizontal: spacing[4],
        marginBottom: spacing[2],
        padding: spacing[3],
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: theme.warning,
        backgroundColor: theme.bg2,
      }}
    >
      <Text style={[type.meta, { color: theme.textHi }]}>{copy.reason}</Text>
      <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>{copy.kept}</Text>
      <View style={{ marginTop: spacing[3], gap: spacing[2] }}>
        {canContinue ? (
          <Pressable
            onPress={onContinue}
            disabled={busy}
            accessibilityRole="button"
            testID="ai-continuation-continue"
            style={{
              minHeight: 44,
              justifyContent: 'center',
              paddingHorizontal: spacing[3],
              borderRadius: radii.md,
              backgroundColor: theme.brand,
              opacity: busy ? 0.5 : 1,
            }}
          >
            <Text style={[type.bodyMd, { color: palette.approve.onBase }]}>{copy.continueLabel}</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onKeep}
          disabled={busy}
          accessibilityRole="button"
          testID="ai-continuation-keep"
          style={{
            minHeight: 44,
            justifyContent: 'center',
            paddingHorizontal: spacing[3],
            borderRadius: radii.md,
            borderWidth: 1,
            borderColor: theme.border,
            opacity: busy ? 0.5 : 1,
          }}
        >
          <Text style={[type.bodyMd, { color: theme.textHi }]}>{copy.keepLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}
