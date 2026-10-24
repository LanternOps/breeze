import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { radii, spacing, type, useApprovalTheme } from '../../theme';
import type { WispConcern } from '../../services/wisp';
import { concernFeedbackState, severityLabel, snoozeOptions, statusLabel } from './wispConcernCopy';

/** Server cap on the feedback note (CONCERN_FEEDBACK_NOTE_MAX). */
const FEEDBACK_NOTE_MAX = 200;
import { approvalOpenTarget } from './wispThreadState';

interface Props {
  concern: WispConcern | null;
  busy: boolean;
  onClose: () => void;
  onSnooze: (until: string) => void;
  onDismiss: () => void;
  /** Opens the approval takeover over the thread; only offered for an open concern with a card. */
  onReviewApproval: (intentId: string) => void;
  /** w00 A34: one-tap "useful / not useful" on a concern Wisp nudged this user about. */
  onFeedback: (useful: boolean, note?: string) => void;
}

/**
 * Wisp W06 (w00 "Nudges (W06)"). One concern's actions: snooze, dismiss and —
 * when the concern carries a live approval card — "Review approval", which
 * hands off to the existing ApprovalScreen takeover (ApprovalGate renders it
 * in a Modal over whatever is on screen, so the thread is the back target).
 *
 * Every decision lives in `wispConcernCopy.ts` / `wispThreadState.ts`
 * (node-tested); this file is layout. Resolved and dismissed concerns show
 * their terminal status and no actions (Review Focus 3).
 */
export function WispConcernSheet({
  concern,
  busy,
  onClose,
  onSnooze,
  onDismiss,
  onReviewApproval,
  onFeedback,
}: Props) {
  const theme = useApprovalTheme('dark');
  const feedback = concern ? concernFeedbackState(concern) : null;
  // "Not useful" asks for an optional one-line note before sending.
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    setNoteOpen(false);
    setNote('');
  }, [concern?.id]);
  // Recomputed per open so "1 hour" is an hour from when the sheet appeared.
  const options = useMemo(() => (concern ? snoozeOptions(new Date()) : []), [concern?.id]);
  const live = concern?.status === 'open' || concern?.status === 'snoozed';
  const approvalTarget = concern ? approvalOpenTarget(concern) : null;

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Modal visible={concern !== null} transparent animationType="slide" onRequestClose={close}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
        onPress={close}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: theme.bg1,
            borderTopLeftRadius: radii.xl,
            borderTopRightRadius: radii.xl,
            padding: spacing[6],
            paddingBottom: spacing[10],
            maxHeight: '85%',
          }}
        >
          {concern ? (
            <ScrollView>
              <Text style={[type.metaCaps, { color: theme.textLo }]}>
                {severityLabel(concern.severity).toUpperCase()} · {statusLabel(concern.status).toUpperCase()}
              </Text>
              <Text style={[type.bodyLg, { color: theme.textHi, marginTop: spacing[2] }]}>
                {concern.summary}
              </Text>

              {approvalTarget ? (
                <SheetButton
                  testID="wisp-concern-review-approval"
                  label="Review approval"
                  tone="brand"
                  disabled={busy}
                  onPress={() => onReviewApproval(approvalTarget)}
                />
              ) : null}

              {feedback?.show ? (
                <View style={{ marginTop: spacing[5] }}>
                  <Text style={[type.metaCaps, { color: theme.textLo }]}>WAS THIS NUDGE USEFUL?</Text>
                  {feedback.chosen ? (
                    <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[2] }]}>
                      {feedback.chosen === 'useful'
                        ? 'You marked this useful.'
                        : 'You marked this not useful. Wisp will nudge less like this.'}
                    </Text>
                  ) : noteOpen ? (
                    <>
                      <TextInput
                        testID="wisp-concern-feedback-note"
                        value={note}
                        onChangeText={setNote}
                        placeholder="What would have been better? (optional)"
                        placeholderTextColor={theme.textLo}
                        editable={!busy}
                        maxLength={FEEDBACK_NOTE_MAX}
                        style={[
                          type.body,
                          {
                            color: theme.textHi,
                            backgroundColor: theme.bg2,
                            borderRadius: radii.md,
                            padding: spacing[3],
                            marginTop: spacing[3],
                          },
                        ]}
                      />
                      <SheetButton
                        testID="wisp-concern-feedback-send"
                        label="Send"
                        disabled={busy}
                        onPress={() => onFeedback(false, note.trim() || undefined)}
                      />
                    </>
                  ) : (
                    <View style={{ flexDirection: 'row', gap: spacing[3] }}>
                      <View style={{ flex: 1 }}>
                        <SheetButton
                          testID="wisp-concern-feedback-useful"
                          label="👍 Useful"
                          disabled={busy || !feedback.canChange}
                          onPress={() => onFeedback(true)}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <SheetButton
                          testID="wisp-concern-feedback-not-useful"
                          label="👎 Not useful"
                          disabled={busy || !feedback.canChange}
                          onPress={() => setNoteOpen(true)}
                        />
                      </View>
                    </View>
                  )}
                </View>
              ) : null}

              {live ? (
                <>
                  <Text style={[type.metaCaps, { color: theme.textLo, marginTop: spacing[6] }]}>
                    SNOOZE
                  </Text>
                  {options.map((o) => (
                    <SheetButton
                      key={o.label}
                      testID={`wisp-concern-snooze-${o.label}`}
                      label={o.label}
                      disabled={busy}
                      onPress={() => onSnooze(o.until)}
                    />
                  ))}
                  <SheetButton
                    testID="wisp-concern-dismiss"
                    label="Dismiss"
                    tone="deny"
                    disabled={busy}
                    onPress={onDismiss}
                  />
                </>
              ) : (
                <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[5] }]}>
                  {concern.status === 'resolved' ? 'Wisp marked this resolved.' : 'You dismissed this.'}
                </Text>
              )}

              <SheetButton label="Close" disabled={busy} onPress={close} />
            </ScrollView>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function SheetButton({
  label,
  onPress,
  disabled,
  tone,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'brand' | 'deny';
  testID?: string;
}) {
  const theme = useApprovalTheme('dark');
  const color = tone === 'brand' ? theme.brand : tone === 'deny' ? theme.deny : theme.textHi;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={{
        marginTop: spacing[3],
        paddingVertical: spacing[4],
        alignItems: 'center',
        borderRadius: radii.md,
        backgroundColor: theme.bg2,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={[type.bodyMd, { color }]}>{label}</Text>
    </Pressable>
  );
}
