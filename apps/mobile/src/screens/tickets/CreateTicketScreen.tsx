import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { palette, radii, spacing, type } from '../../theme';
import { useAppSelector } from '../../store';
import { createTicket, type TicketPriority } from '../../services/tickets';
import { listOrganizations } from '../../services/organizations';
import type { TicketsStackParamList } from '../../navigation/MainNavigator';
import { Toast } from '../../components/Toast';
import { reportInternalError } from '../../lib/errorReporting';

import { priorityColor, priorityLabel } from './ticketCopy';
import {
  buildCreateTicketBody,
  canSubmitTicket,
  DEFAULT_TICKET_PRIORITY,
  preselectOrg,
  SUBJECT_MAX_LENGTH,
  TICKET_PRIORITY_OPTIONS,
  type OrgOption,
} from './createTicketForm';

type Nav = NativeStackNavigationProp<TicketsStackParamList, 'CreateTicket'>;

/** Above this many orgs the picker gets a search box (server-side search). */
const SEARCH_THRESHOLD = 8;

export function CreateTicketScreen() {
  const navigation = useNavigation<Nav>();
  const user = useAppSelector((state) => state.auth.user);

  const [orgs, setOrgs] = useState<OrgOption[] | null>(null);
  const [orgTotal, setOrgTotal] = useState(0);
  const [orgSearch, setOrgSearch] = useState('');
  const [orgError, setOrgError] = useState<string | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>(DEFAULT_TICKET_PRIORITY);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const loadOrgs = useCallback(
    async (search: string) => {
      setOrgError(null);
      try {
        const result = await listOrganizations(search);
        setOrgs(result.orgs);
        setOrgTotal(result.total);
        // Only preselect on the unfiltered load: a search result of one org is
        // the user narrowing, not the app choosing for them.
        if (!search) setOrgId((current) => current ?? preselectOrg(result.orgs, user?.organizationId));
      } catch (err) {
        reportInternalError(err, 'CreateTicketScreen.loadOrgs');
        setOrgs([]);
        setOrgError('Could not load organisations. Pull to retry.');
      }
    },
    [user?.organizationId]
  );

  useEffect(() => {
    void loadOrgs('');
  }, [loadOrgs]);

  const submit = async () => {
    const built = buildCreateTicketBody({ orgId, subject, description, priority });
    if (!built.ok) return;
    setBusy(true);
    try {
      const created = await createTicket(built.body);
      // Land on the ticket itself. `replace` keeps Back from returning to a
      // half-filled form; the list refetches on focus (TicketsScreen's
      // useFocusEffect), so the new ticket is there when the user gets back.
      navigation.replace('TicketDetail', { ticketId: created.id });
    } catch (err) {
      reportInternalError(err, 'CreateTicketScreen.submit');
      setToast({ kind: 'error', text: 'Could not create the ticket. Check the connection and try again.' });
      setBusy(false);
    }
  };

  const sendable = canSubmitTicket({ orgId, subject, busy });
  const showSearch = orgTotal > SEARCH_THRESHOLD || orgSearch.length > 0;
  const selectedOrg = orgs?.find((o) => o.id === orgId) ?? null;
  // The user's own org is the only one an org-scoped technician can see, so
  // the picker is noise for them; show the name and move on.
  const lockedOrg = orgs !== null && orgs.length === 1 && orgId === orgs[0].id;

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>ORGANISATION</Text>
        {orgs === null ? (
          <ActivityIndicator color={palette.dark.textLo} style={styles.spinner} />
        ) : lockedOrg ? (
          <Text style={styles.lockedOrg}>{orgs[0].name}</Text>
        ) : (
          <>
            {showSearch ? (
              <TextInput
                style={styles.input}
                placeholder="Search organisations"
                placeholderTextColor={palette.dark.textLo}
                value={orgSearch}
                onChangeText={(text) => {
                  setOrgSearch(text);
                  void loadOrgs(text);
                }}
                autoCorrect={false}
                autoCapitalize="none"
                accessibilityLabel="Search organisations"
              />
            ) : null}
            {orgError ? (
              <Pressable onPress={() => void loadOrgs(orgSearch)} accessibilityRole="button">
                <Text style={styles.error}>{orgError}</Text>
              </Pressable>
            ) : null}
            {orgs.length === 0 && !orgError ? (
              <Text style={styles.hint}>No organisations match.</Text>
            ) : null}
            <View style={styles.orgList}>
              {orgs.map((org) => {
                const active = org.id === orgId;
                return (
                  <Pressable
                    key={org.id}
                    onPress={() => setOrgId(org.id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={[styles.orgRow, active && styles.orgRowActive]}
                  >
                    <Text style={[styles.orgName, active && styles.orgNameActive]} numberOfLines={1}>
                      {org.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {selectedOrg === null && orgSearch.length > 0 && orgId ? (
              // The chosen org is filtered out of the current search results;
              // say so rather than let the selection look lost.
              <Text style={styles.hint}>Selected organisation is not in these results.</Text>
            ) : null}
          </>
        )}

        <Text style={styles.label}>SUBJECT</Text>
        <TextInput
          style={styles.input}
          placeholder="What is wrong?"
          placeholderTextColor={palette.dark.textLo}
          value={subject}
          onChangeText={setSubject}
          maxLength={SUBJECT_MAX_LENGTH}
          returnKeyType="next"
          accessibilityLabel="Subject"
        />

        <Text style={styles.label}>DESCRIPTION</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          placeholder="Optional details, steps tried, who reported it"
          placeholderTextColor={palette.dark.textLo}
          value={description}
          onChangeText={setDescription}
          multiline
          accessibilityLabel="Description"
        />

        <Text style={styles.label}>PRIORITY</Text>
        <View style={styles.priorityRow}>
          {TICKET_PRIORITY_OPTIONS.map((option) => {
            const active = option === priority;
            return (
              <Pressable
                key={option}
                onPress={() => setPriority(option)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={[styles.chip, active && styles.chipActive]}
              >
                <View style={[styles.priorityDot, { backgroundColor: priorityColor(option) }]} />
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{priorityLabel(option)}</Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable
          onPress={() => void submit()}
          disabled={!sendable}
          accessibilityRole="button"
          accessibilityState={{ disabled: !sendable }}
          style={[styles.submit, !sendable && styles.submitDisabled]}
        >
          {busy ? (
            <ActivityIndicator color={palette.dark.textHi} />
          ) : (
            <Text style={styles.submitText}>Create ticket</Text>
          )}
        </Pressable>
      </ScrollView>
      <Toast
        visible={toast !== null}
        text={toast?.text ?? ''}
        kind={toast?.kind ?? 'error'}
        onHidden={() => setToast(null)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.dark.bg0 },
  content: { padding: spacing['4'], paddingBottom: spacing['8'] },
  label: {
    ...type.metaCaps,
    color: palette.dark.textLo,
    marginTop: spacing['4'],
  },
  spinner: { marginTop: spacing['3'], alignSelf: 'flex-start' },
  lockedOrg: { ...type.body, color: palette.dark.textHi, marginTop: spacing['2'] },
  input: {
    ...type.body,
    color: palette.dark.textHi,
    backgroundColor: palette.dark.bg1,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dark.border,
    padding: spacing['3'],
    marginTop: spacing['2'],
  },
  multiline: { minHeight: 112, textAlignVertical: 'top' },
  orgList: { marginTop: spacing['2'], gap: spacing['1'] },
  orgRow: {
    paddingHorizontal: spacing['3'],
    paddingVertical: spacing['3'],
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dark.border,
    backgroundColor: palette.dark.bg1,
  },
  orgRowActive: { borderColor: palette.brand.base, backgroundColor: palette.dark.bg2 },
  orgName: { ...type.body, color: palette.dark.textMd },
  orgNameActive: { color: palette.dark.textHi },
  hint: { ...type.meta, color: palette.dark.textLo, marginTop: spacing['2'] },
  error: { ...type.meta, color: palette.deny.base, marginTop: spacing['2'] },
  priorityRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing['2'], marginTop: spacing['2'] },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['2'],
    paddingHorizontal: spacing['3'],
    paddingVertical: spacing['2'],
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: palette.dark.border,
    backgroundColor: palette.dark.bg1,
  },
  chipActive: { borderColor: palette.brand.base, backgroundColor: palette.dark.bg2 },
  chipText: { ...type.meta, color: palette.dark.textMd },
  chipTextActive: { color: palette.dark.textHi },
  priorityDot: { width: 8, height: 8, borderRadius: 4 },
  submit: {
    marginTop: spacing['6'],
    paddingVertical: spacing['3'],
    borderRadius: radii.md,
    backgroundColor: palette.brand.base,
    alignItems: 'center',
  },
  submitDisabled: { opacity: 0.4 },
  submitText: { ...type.bodyMd, color: palette.dark.textHi },
});
