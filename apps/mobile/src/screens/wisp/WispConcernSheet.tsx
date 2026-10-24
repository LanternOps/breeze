import { useMemo } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import { radii, spacing, type, useApprovalTheme } from '../../theme';
import type { WispConcern } from '../../services/wisp';
import { severityLabel, snoozeOptions, statusLabel } from './wispConcernCopy';
import { approvalOpenTarget } from './wispThreadState';

interface Props {
  concern: WispConcern | null;
  busy: boolean;
  onClose: () => void;
  onSnooze: (until: string) => void;
  onDismiss: () => void;
  /** Opens the approval takeover over the thread; only offered for an open concern with a card. */
  onReviewApproval: (intentId: string) => void;
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
export function WispConcernSheet({ concern, busy, onClose, onSnooze, onDismiss, onReviewApproval }: Props) {
  const theme = useApprovalTheme('dark');
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
