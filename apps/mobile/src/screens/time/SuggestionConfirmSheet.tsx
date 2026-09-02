import { useCallback, useState } from 'react';
import { Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { palette, radii, spacing, type } from '../../theme';
import { useAppDispatch } from '../../store';
import { suggestionConfirmed, suggestionSettled, suggestionsDisabled } from '../../store/timeSuggestionsSlice';
import { confirmSuggestion, type TimeSuggestion } from '../../services/timeSuggestions';
import { classifyDrainOutcome, suggestionDedupeKey } from '../../services/timeSuggestionDrain';
import { enqueue } from '../../services/timeEntryQueue';
import { reportInternalError } from '../../lib/errorReporting';
import { track } from '../../lib/analytics';

import { confirmToast, rowSummary, ticketChipLabel } from './timeSuggestionCopy';

interface Props {
  suggestion: TimeSuggestion;
  timeZone: string;
  onClose: () => void;
  onLogged: (message: string) => void;
}

/**
 * W06 (#3900). Confirms one suggested window into a real time entry.
 *
 * The window's bounds are NOT editable here. They come from remote_session rows
 * the server recorded and the server re-validates the confirm against those
 * same signals, so an edited span is either rejected or bills a window that was
 * never worked. Adjusting time is what the ordinary manual entry is for.
 */
export function SuggestionConfirmSheet({ suggestion, timeZone, onClose, onLogged }: Props): React.JSX.Element {
  const dispatch = useAppDispatch();
  const [description, setDescription] = useState('');
  const [isBillable, setIsBillable] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    const signals = suggestion.signals.map((signal) => ({ kind: signal.kind, id: signal.id }));
    const payload = {
      signals,
      startedAt: suggestion.startedAt,
      ...(suggestion.endedAt === null ? {} : { endedAt: suggestion.endedAt }),
      ...(suggestion.candidateTicket === null ? {} : { ticketId: suggestion.candidateTicket.id }),
      ...(description.trim() === '' ? {} : { description: description.trim() }),
      isBillable,
    };

    // Optimistic: the row leaves the list now and its key is pending, so a
    // refetch cannot re-offer the same window while the write is in flight.
    dispatch(suggestionConfirmed(suggestion.key));
    track('time_suggestion_confirmed', { billable: isBillable });

    try {
      await confirmSuggestion(payload);
      dispatch(suggestionSettled(suggestion.key));
      onLogged(confirmToast(suggestion));
    } catch (err) {
      const outcome = classifyDrainOutcome((err as { status?: number }).status);

      if (outcome === 'retry') {
        // Offline. The queue owns it from here; the key stays pending until a
        // drain settles it, which is what keeps the row from coming back.
        try {
          await enqueue({
            kind: 'suggestion.confirm',
            payload,
            dedupeKey: suggestionDedupeKey('confirm', signals),
          });
          onLogged('Saved — will log when you are back online');
          return;
        } catch (queueError) {
          reportInternalError(queueError, 'timeSuggestions.confirm');
          dispatch(suggestionSettled(suggestion.key));
          setError('Could not save this offline. Try again.');
          setSubmitting(false);
          return;
        }
      }

      dispatch(suggestionSettled(suggestion.key));

      if (outcome === 'dropAndDisable') {
        dispatch(suggestionsDisabled());
        onLogged('Session suggestions have been turned off for your partner');
        return;
      }
      if (outcome === 'drop') {
        // Already logged, or dismissed elsewhere. Not an error worth alarming
        // anyone about — the row is gone either way.
        onLogged('That session was already logged');
        return;
      }

      setError((err as { message?: string }).message ?? 'Could not log this session');
      setSubmitting(false);
    }
  }, [description, dispatch, isBillable, onLogged, submitting, suggestion]);

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <Text style={styles.title}>Log this session</Text>
        <Text style={styles.summary}>{rowSummary(suggestion, timeZone)}</Text>
        <Text style={styles.ticket}>{ticketChipLabel(suggestion)}</Text>

        <TextInput
          style={styles.input}
          placeholder="What did you do?"
          placeholderTextColor={palette.dark.textLo}
          value={description}
          onChangeText={setDescription}
          multiline
        />

        <View style={styles.billableRow}>
          <Text style={styles.billableLabel}>Billable</Text>
          <Switch value={isBillable} onValueChange={setIsBillable} />
        </View>

        {error !== null ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.actions}>
          <Pressable style={styles.cancel} onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.submit, submitting && styles.disabled]}
            onPress={() => void submit()}
            disabled={submitting}
          >
            <Text style={styles.submitText}>{submitting ? 'Logging…' : 'Log it'}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#00000099' },
  sheet: {
    backgroundColor: palette.dark.bg1,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    borderTopWidth: 1,
    borderColor: palette.dark.border,
    padding: spacing['4'],
    gap: spacing['3'],
  },
  title: { ...type.bodyLg, color: palette.dark.textHi },
  summary: { ...type.body, color: palette.dark.textMd },
  ticket: { ...type.meta, color: palette.dark.textLo },
  input: {
    ...type.body,
    color: palette.dark.textHi,
    backgroundColor: palette.dark.bg0,
    borderWidth: 1,
    borderColor: palette.dark.border,
    borderRadius: radii.md,
    padding: spacing['3'],
    minHeight: 72,
  },
  billableRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  billableLabel: { ...type.body, color: palette.dark.textHi },
  error: { ...type.meta, color: palette.deny.base },
  actions: { flexDirection: 'row', gap: spacing['2'], justifyContent: 'flex-end', marginTop: spacing['2'] },
  cancel: {
    borderWidth: 1,
    borderColor: palette.dark.border,
    borderRadius: radii.full,
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['2'],
  },
  cancelText: { ...type.meta, color: palette.dark.textMd },
  submit: {
    backgroundColor: palette.brand.deep,
    borderWidth: 1,
    borderColor: palette.brand.base,
    borderRadius: radii.full,
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['2'],
  },
  submitText: { ...type.meta, color: palette.dark.textHi },
  disabled: { opacity: 0.5 },
});
