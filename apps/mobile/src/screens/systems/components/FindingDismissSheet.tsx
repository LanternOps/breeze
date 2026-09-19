import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useApprovalTheme, type, spacing, radii, palette } from '../../../theme';
import { DISMISS_NOTES_MAX_LENGTH, validateDismissNote } from '../findingActions';

interface Props {
  visible: boolean;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (notes: string) => void;
}

const ERROR_COPY: Record<'required' | 'too_long', string> = {
  required: 'A note is required to dismiss a finding.',
  too_long: `Keep the note under ${DISMISS_NOTES_MAX_LENGTH} characters.`,
};

/**
 * The dismiss sheet for a fleet finding (#5365). Follows the approval-mode
 * `DenyReasonSheet` pattern, with one deliberate difference: the note is
 * REQUIRED, not optional. `PATCH /fleet/findings/:id` rejects a dismiss with
 * no notes, so the submit button validates locally rather than letting the
 * tech watch a round-trip end in a 400.
 */
export function FindingDismissSheet({ visible, busy, onCancel, onSubmit }: Props) {
  const theme = useApprovalTheme('dark');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Reopening the sheet after a cancel must not resurrect the previous draft
  // or a stale validation message.
  useEffect(() => {
    if (!visible) {
      setNotes('');
      setError(null);
    }
  }, [visible]);

  function handleCancel() {
    if (busy) return;
    onCancel();
  }

  function handleSubmit() {
    if (busy) return;
    const result = validateDismissNote(notes);
    if (!result.ok) {
      setError(ERROR_COPY[result.reason]);
      return;
    }
    setError(null);
    onSubmit(result.notes);
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleCancel}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
          onPress={handleCancel}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: theme.bg1,
              borderTopLeftRadius: radii.xl,
              borderTopRightRadius: radii.xl,
              padding: spacing[6],
              paddingBottom: spacing[10],
            }}
          >
            <Text style={[type.title, { color: theme.textHi }]}>Why dismiss?</Text>
            <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>
              Required. Recorded on the finding so the rest of the team can see why.
            </Text>
            <TextInput
              testID="finding-dismiss-notes"
              value={notes}
              onChangeText={(next) => {
                setNotes(next);
                if (error) setError(null);
              }}
              placeholder="Reason"
              placeholderTextColor={theme.textLo}
              editable={!busy}
              multiline
              maxLength={DISMISS_NOTES_MAX_LENGTH}
              style={[
                type.body,
                {
                  color: theme.textHi,
                  backgroundColor: theme.bg2,
                  borderRadius: radii.md,
                  padding: spacing[4],
                  marginTop: spacing[4],
                  minHeight: 88,
                  textAlignVertical: 'top',
                },
              ]}
            />
            {error ? (
              <Text style={[type.meta, { color: theme.deny, marginTop: spacing[2] }]}>{error}</Text>
            ) : null}
            <View style={{ flexDirection: 'row', marginTop: spacing[5], gap: spacing[3] }}>
              <Pressable
                onPress={handleCancel}
                disabled={busy}
                style={{
                  flex: 1,
                  paddingVertical: spacing[4],
                  alignItems: 'center',
                  borderRadius: radii.md,
                  backgroundColor: theme.bg2,
                  opacity: busy ? 0.5 : 1,
                }}
              >
                <Text style={[type.bodyMd, { color: theme.textHi }]}>Cancel</Text>
              </Pressable>
              <Pressable
                testID="finding-dismiss-submit"
                onPress={handleSubmit}
                disabled={busy}
                style={{
                  flex: 1,
                  paddingVertical: spacing[4],
                  alignItems: 'center',
                  borderRadius: radii.md,
                  backgroundColor: theme.deny,
                  opacity: busy ? 0.5 : 1,
                }}
              >
                <Text style={[type.bodyMd, { color: palette.deny.onBase }]}>
                  {busy ? 'Dismissing…' : 'Dismiss'}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
