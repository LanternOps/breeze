import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { palette, radii, spacing, type } from '../../theme';

import {
  SITE_VISIT_LABEL,
  arrivalCopy,
  candidateRowLabel,
  stillHereCopy,
  type SheetStep,
} from './arrivalSheetLogic';
import type { SiteCandidate } from '../../services/arrivalMatch';

export type ArrivalSheetState =
  | { kind: 'arrival'; step: SheetStep }
  | { kind: 'stop'; placeName: string; runningMinutes: number };

interface Props {
  state: ArrivalSheetState;
  busy: boolean;
  onPickSite: (site: SiteCandidate) => void;
  onStart: (site: SiteCandidate, ticketId: string | null) => void;
  onDismiss: () => void;
  onStop: () => void;
  onKeepRunning: () => void;
}

/**
 * The arrival suggestion, and the "still here?" stop prompt. A plain RN `Modal`
 * like SuggestionConfirmSheet. Nothing here writes anything: every button is a
 * deliberate tap, and the host decides what a tap does.
 */
export function ArrivalSheet(props: Props): React.JSX.Element {
  const { state, busy } = props;

  if (state.kind === 'stop') {
    const copy = stillHereCopy(state);
    return (
      <Modal transparent animationType="slide" visible onRequestClose={props.onKeepRunning}>
        <Pressable style={styles.backdrop} onPress={props.onKeepRunning} />
        <View style={styles.sheet}>
          <Text style={styles.title}>{copy.title}</Text>
          <View style={styles.actions}>
            <Pressable
              style={styles.secondary}
              onPress={props.onKeepRunning}
              disabled={busy}
              accessibilityRole="button"
            >
              <Text style={styles.secondaryText}>{copy.secondary}</Text>
            </Pressable>
            <Pressable
              style={[styles.primary, busy && styles.disabled]}
              onPress={props.onStop}
              disabled={busy}
              accessibilityRole="button"
            >
              <Text style={styles.primaryText}>{busy ? 'Stopping…' : copy.primary}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    );
  }

  return <ArrivalStep key={stepKey(state.step)} {...props} step={state.step} />;
}

function stepKey(step: SheetStep): string {
  return step.step === 'pick-site' ? 'pick-site' : `${step.step}:${step.site.siteId}`;
}

function ArrivalStep({
  step,
  busy,
  onPickSite,
  onStart,
  onDismiss,
}: Props & { step: SheetStep }): React.JSX.Element {
  const copy = arrivalCopy(step);
  const [ticketId, setTicketId] = useState<string | null>(
    step.step === 'pick-ticket' ? step.preselectedTicketId : null
  );
  const [pickedSite, setPickedSite] = useState<string | null>(
    step.step === 'pick-site' ? step.highlighted : null
  );

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onDismiss}>
      <Pressable style={styles.backdrop} onPress={onDismiss} />
      <View style={styles.sheet}>
        <Text style={styles.title}>{copy.title}</Text>

        {step.step === 'pick-site' ? (
          <ScrollView style={styles.list}>
            {step.candidates.map((c) => (
              <Pressable
                key={c.siteId}
                style={[styles.row, pickedSite === c.siteId && styles.rowSelected]}
                onPress={() => setPickedSite(c.siteId)}
                accessibilityRole="radio"
                accessibilityState={{ selected: pickedSite === c.siteId }}
              >
                <Text style={styles.rowText}>{candidateRowLabel(c)}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        {step.step === 'pick-ticket' ? (
          <ScrollView style={styles.list}>
            {step.tickets.map((t) => (
              <Pressable
                key={t.id}
                style={[styles.row, ticketId === t.id && styles.rowSelected]}
                onPress={() => setTicketId(t.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected: ticketId === t.id }}
              >
                <Text style={styles.rowText} numberOfLines={2}>
                  {t.label}
                </Text>
              </Pressable>
            ))}
            <Pressable
              style={[styles.row, ticketId === null && styles.rowSelected]}
              onPress={() => setTicketId(null)}
              accessibilityRole="radio"
              accessibilityState={{ selected: ticketId === null }}
            >
              <Text style={styles.rowText}>{SITE_VISIT_LABEL}</Text>
            </Pressable>
          </ScrollView>
        ) : null}

        <View style={styles.actions}>
          <Pressable
            style={styles.secondary}
            onPress={onDismiss}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryText}>{copy.secondary}</Text>
          </Pressable>
          <Pressable
            style={[
              styles.primary,
              (busy || (step.step === 'pick-site' && pickedSite === null)) && styles.disabled,
            ]}
            disabled={busy || (step.step === 'pick-site' && pickedSite === null)}
            accessibilityRole="button"
            onPress={() => {
              if (step.step === 'pick-site') {
                const site = step.candidates.find((c) => c.siteId === pickedSite);
                if (site) onPickSite(site);
              } else {
                onStart(step.site, step.step === 'pick-ticket' ? ticketId : null);
              }
            }}
          >
            <Text style={styles.primaryText}>{busy ? 'Starting…' : copy.primary}</Text>
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
  list: { maxHeight: 240 },
  row: {
    borderWidth: 1,
    borderColor: palette.dark.border,
    borderRadius: radii.md,
    padding: spacing['3'],
    marginBottom: spacing['2'],
  },
  rowSelected: { borderColor: palette.brand.base, backgroundColor: palette.dark.bg0 },
  rowText: { ...type.body, color: palette.dark.textHi },
  actions: {
    flexDirection: 'row',
    gap: spacing['2'],
    justifyContent: 'flex-end',
    marginTop: spacing['2'],
  },
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
  disabled: { opacity: 0.5 },
});
