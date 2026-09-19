import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
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
import { listOrgContacts } from '../../services/orgContacts';
import { listAssignableUsers } from '../../services/users';
import type { TicketsStackParamList } from '../../navigation/MainNavigator';
import { useToast } from '../../components/toast/ToastHost';
import { reportInternalError } from '../../lib/errorReporting';

import { priorityColor, priorityLabel } from './ticketCopy';
import {
  assigneeOptions,
  buildCreateTicketBody,
  canSubmitTicket,
  contactOptions,
  contactSelectionForOrg,
  defaultAssigneeId,
  DEFAULT_TICKET_PRIORITY,
  isExpectedAssigneeLoadFailure,
  isExpectedContactLoadFailure,
  NO_CONTACT_LABEL,
  preselectOrg,
  SUBJECT_MAX_LENGTH,
  TICKET_PRIORITY_OPTIONS,
  type AssigneeUser,
  type OrgContactOption,
  type OrgOption,
} from './createTicketForm';
import { OrgPickerSheet } from './components/OrgPickerSheet';
import { AssigneePickerSheet } from './components/AssigneePickerSheet';
import { ContactPickerSheet } from './components/ContactPickerSheet';

type Nav = NativeStackNavigationProp<TicketsStackParamList, 'CreateTicket'>;

export function CreateTicketScreen() {
  const navigation = useNavigation<Nav>();
  const user = useAppSelector((state) => state.auth.user);

  const [orgs, setOrgs] = useState<OrgOption[] | null>(null);
  const [orgTotal, setOrgTotal] = useState(0);
  const [orgSearch, setOrgSearch] = useState('');
  const [orgError, setOrgError] = useState<string | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [orgSheetVisible, setOrgSheetVisible] = useState(false);

  const [staff, setStaff] = useState<AssigneeUser[]>([]);
  const [assigneeId, setAssigneeId] = useState<string | null>(() => defaultAssigneeId(user));
  const [assigneeSheetVisible, setAssigneeSheetVisible] = useState(false);

  // #5367: the requester contact. `null` contacts = still loading for the
  // current org; `contactsForbidden` hides the row outright for a technician
  // without `organizations:read` (see isExpectedContactLoadFailure).
  const [contacts, setContacts] = useState<OrgContactOption[] | null>(null);
  const [contactsForbidden, setContactsForbidden] = useState(false);
  const [contactId, setContactId] = useState<string | null>(null);
  const [contactSearch, setContactSearch] = useState('');
  const [contactSheetVisible, setContactSheetVisible] = useState(false);

  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>(DEFAULT_TICKET_PRIORITY);
  const [busy, setBusy] = useState(false);
  const { show: showToast } = useToast();

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
        setOrgError('Could not load organizations. Pull to retry.');
      }
    },
    [user?.organizationId]
  );

  useEffect(() => {
    void loadOrgs('');
  }, [loadOrgs]);

  // #5188: assignable staff for the picker. Degrades silently to
  // Unassigned + "(you)" on failure — `assigneeOptions` already handles an
  // empty list, so there is no error state or toast here. A 403 (tech without
  // `users:read`) is the permission model working and is not reported at all;
  // anything else goes to Sentry via reportInternalError.
  useEffect(() => {
    let cancelled = false;
    listAssignableUsers()
      .then((users) => {
        if (!cancelled) setStaff(users);
      })
      .catch((err) => {
        if (isExpectedAssigneeLoadFailure(err)) return;
        reportInternalError(err, 'CreateTicketScreen.loadAssignableUsers');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // #5367: contacts are ORG-SCOPED, so this refetches on every org change and
  // the in-flight result of the previous org is discarded rather than shown
  // against the new one. A failure leaves the row visible but empty ("No
  // contact" only) — the field is optional, so it must never block the form.
  useEffect(() => {
    if (!orgId) {
      setContacts(null);
      return;
    }
    let cancelled = false;
    setContacts(null);
    listOrgContacts(orgId)
      .then((rows) => {
        if (!cancelled) setContacts(rows);
      })
      .catch((err) => {
        if (cancelled) return;
        setContacts([]);
        if (isExpectedContactLoadFailure(err)) {
          setContactsForbidden(true);
          return;
        }
        reportInternalError(err, 'CreateTicketScreen.loadOrgContacts');
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const contactChoices = useMemo(
    () => (contacts === null ? null : contactOptions(contacts, contactSearch)),
    [contacts, contactSearch]
  );
  const contactLabel =
    (contacts === null ? null : contactOptions(contacts).find((o) => o.id === contactId)?.label) ??
    NO_CONTACT_LABEL;

  const me: AssigneeUser | null = user ? { id: user.id, name: user.name, email: user.email } : null;
  const assigneeChoices = useMemo(() => assigneeOptions(staff, me), [staff, me]);
  const assigneeLabel = assigneeChoices.find((o) => o.id === assigneeId)?.label ?? 'Unassigned';

  const submit = async () => {
    const built = buildCreateTicketBody({
      orgId,
      subject,
      description,
      priority,
      assigneeId,
      requesterContactId: contactId,
    });
    if (!built.ok) return;
    // #5171: without this, the spinner ran with the keyboard still up, and
    // `navigation.replace('TicketDetail', …)` below swapped in the next
    // screen with the keyboard still floating over it and the note field
    // eligible to inherit focus — same class as the MFA fix (#5104).
    Keyboard.dismiss();
    setBusy(true);
    try {
      const created = await createTicket(built.body);
      // Land on the ticket itself. `replace` keeps Back from returning to a
      // half-filled form; the list refetches on focus (TicketsScreen's
      // useFocusEffect), so the new ticket is there when the user gets back.
      navigation.replace('TicketDetail', { ticketId: created.id });
    } catch (err) {
      reportInternalError(err, 'CreateTicketScreen.submit');
      showToast({ kind: 'error', text: 'Could not create the ticket. Check the connection and try again.' });
      setBusy(false);
    }
  };

  const sendable = canSubmitTicket({ orgId, subject, busy });
  const selectedOrg = orgs?.find((o) => o.id === orgId) ?? null;
  // The user's own org is the only one an org-scoped technician can see, so
  // the picker is noise for them; show the name and move on.
  const lockedOrg = orgs !== null && orgs.length === 1 && orgId === orgs[0].id;

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      // iOS is handled by `automaticallyAdjustKeyboardInsets` on the
      // ScrollView below; leaving this enabled too would double-count the
      // keyboard height and open a blank band above it.
      enabled={Platform.OS !== 'ios'}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        // Drag the list down to dismiss the keyboard (the chat list already
        // does this); there is no Done button on a multiline iOS keyboard.
        keyboardDismissMode="interactive"
        // iOS: UIScrollView adds the keyboard's height to the bottom content
        // inset natively, so the composer / submit button — which live at the
        // END of this scroll content — can always be scrolled clear of it.
        // KeyboardAvoidingView's padding never gave scroll room, only a
        // shorter viewport, and with a 32pt bottom pad the last field sat
        // under a ~300pt keyboard with nowhere to go.
        automaticallyAdjustKeyboardInsets
      >
        <Text style={styles.label}>ORGANIZATION</Text>
        {orgs === null ? (
          <ActivityIndicator color={palette.dark.textLo} style={styles.spinner} />
        ) : lockedOrg ? (
          <Text style={styles.lockedOrg}>{orgs[0].name}</Text>
        ) : (
          <>
            {/*
              #5188: was every org rendered as a full-width row (15+ on a
              5-org MSP plus test orgs), pushing Subject/Description off the
              fold — now a single row that opens the search + list in a sheet.
            */}
            <Pressable
              onPress={() => setOrgSheetVisible(true)}
              accessibilityRole="button"
              style={styles.selectorRow}
            >
              <Text
                style={[styles.selectorText, !selectedOrg && styles.selectorPlaceholder]}
                numberOfLines={1}
              >
                {selectedOrg ? selectedOrg.name : 'Choose organization'}
              </Text>
              <Text style={styles.chevron}>{'›'}</Text>
            </Pressable>
            {orgError ? (
              <Pressable onPress={() => void loadOrgs(orgSearch)} accessibilityRole="button">
                <Text style={styles.error}>{orgError}</Text>
              </Pressable>
            ) : null}
          </>
        )}

        {contactsForbidden ? null : (
          <>
            <Text style={styles.label}>CONTACT</Text>
            <Pressable
              onPress={() => setContactSheetVisible(true)}
              accessibilityRole="button"
              accessibilityState={{ disabled: !orgId }}
              disabled={!orgId}
              style={[styles.selectorRow, !orgId && styles.selectorDisabled]}
            >
              <Text
                style={[styles.selectorText, contactId === null && styles.selectorPlaceholder]}
                numberOfLines={1}
              >
                {contactLabel}
              </Text>
              <Text style={styles.chevron}>{'\u203a'}</Text>
            </Pressable>
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

        <Text style={styles.label}>ASSIGNEE</Text>
        <Pressable
          onPress={() => setAssigneeSheetVisible(true)}
          accessibilityRole="button"
          style={styles.selectorRow}
        >
          <Text style={styles.selectorText} numberOfLines={1}>
            {assigneeLabel}
          </Text>
          <Text style={styles.chevron}>{'›'}</Text>
        </Pressable>

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
      <OrgPickerSheet
        visible={orgSheetVisible}
        orgs={orgs}
        orgTotal={orgTotal}
        orgSearch={orgSearch}
        orgError={orgError}
        selectedOrgId={orgId}
        onSearchChange={(text) => {
          setOrgSearch(text);
          void loadOrgs(text);
        }}
        onRetry={() => void loadOrgs(orgSearch)}
        onSelect={(id) => {
          // #5367: contacts belong to the org, so a different org invalidates
          // the pick. Guarded by the pure helper so "reselected the same org"
          // does not silently drop a deliberate choice.
          setContactId((current) => contactSelectionForOrg({ orgId, contactId: current }, id));
          setContactSearch('');
          // Only a REAL org change re-opens the question of whether contacts
          // are readable. Reselecting the same org changes no state the effect
          // below keys on, so clearing the flag unconditionally would unhide
          // the row without ever refetching it.
          if (id !== orgId) setContactsForbidden(false);
          setOrgId(id);
          setOrgSheetVisible(false);
        }}
        onCancel={() => setOrgSheetVisible(false)}
      />
      <ContactPickerSheet
        visible={contactSheetVisible}
        options={contactChoices}
        totalOptions={contacts?.length ?? 0}
        search={contactSearch}
        selectedId={contactId}
        onSearchChange={setContactSearch}
        onSelect={(id) => {
          setContactId(id);
          setContactSearch('');
          setContactSheetVisible(false);
        }}
        onCancel={() => setContactSheetVisible(false)}
      />
      <AssigneePickerSheet
        visible={assigneeSheetVisible}
        options={assigneeChoices}
        selectedId={assigneeId}
        onSelect={(id) => {
          setAssigneeId(id);
          setAssigneeSheetVisible(false);
        }}
        onCancel={() => setAssigneeSheetVisible(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.dark.bg0 },
  content: { padding: spacing['4'], paddingBottom: spacing['16'] },
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
  selectorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing['3'],
    paddingVertical: spacing['3'],
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dark.border,
    backgroundColor: palette.dark.bg1,
    marginTop: spacing['2'],
  },
  selectorText: { ...type.body, color: palette.dark.textHi, flex: 1, marginRight: spacing['2'] },
  selectorPlaceholder: { color: palette.dark.textLo },
  selectorDisabled: { opacity: 0.5 },
  chevron: { ...type.body, color: palette.dark.textLo },
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
