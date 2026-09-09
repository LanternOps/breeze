import { useCallback, useEffect, useReducer, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { Toast } from '../../components/Toast';
import { reportInternalError } from '../../lib/errorReporting';
import type { SystemsStackParamList } from '../../navigation/MainNavigator';
import { getDevice } from '../../services/api';
import { getFinding, isFindingNotFound, patchFinding } from '../../services/findings';
import { radii, spacing, type, useApprovalTheme } from '../../theme';
import { FindingDismissSheet } from './components/FindingDismissSheet';
import { SeverityPill } from './components/SeverityPill';
import { findingActionLabel, type FleetFindingAction } from './findingActions';
import {
  detailActions,
  findingActionSuccessMessage,
  findingDetailMeta,
  findingDetailNotFoundCopy,
  findingDetailReducer,
  initialFindingDetailState,
  isActionBusy,
  memberPrimaryLabel,
  memberSecondaryLabel,
  type FindingMember,
} from './findingDetail';
import { markFindingsChanged } from './findingsRefreshSignal';

type Nav = NativeStackNavigationProp<SystemsStackParamList, 'SystemsFindingDetail'>;

interface Props {
  route: { params: { findingId: string } };
}

/**
 * One fleet-hygiene finding with its member devices and the acknowledge /
 * dismiss / reopen actions (#5365), gated exactly as the web drawer
 * (`apps/web/src/components/fleet/FindingDrawer.tsx`). Remediation is
 * deliberately out of scope here — it needs an MFA'd session and a script
 * picker.
 *
 * The state machine lives in `findingDetail.ts` (node-tested); this file maps
 * it to JSX and owns the two side effects that cannot: fetching a member
 * device before pushing the existing device detail screen, and telling the
 * Systems tab its counts went stale.
 */
export function FindingDetailScreen({ route }: Props): React.JSX.Element {
  const { findingId } = route.params;
  const theme = useApprovalTheme('dark');
  const navigation = useNavigation<Nav>();
  const [state, dispatch] = useReducer(findingDetailReducer, initialFindingDetailState);
  const [dismissing, setDismissing] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const [openingDeviceId, setOpeningDeviceId] = useState<string | null>(null);

  const load = useCallback(async () => {
    dispatch({ type: 'load' });
    try {
      dispatch({ type: 'loaded', finding: await getFinding(findingId) });
    } catch (err) {
      if (isFindingNotFound(err)) {
        dispatch({ type: 'notFound' });
        return;
      }
      reportInternalError(err, 'finding-detail');
      dispatch({
        type: 'failed',
        message: err instanceof Error ? err.message : 'Could not load this finding',
      });
    }
  }, [findingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = useCallback(
    async (action: FleetFindingAction, notes?: string) => {
      dispatch({ type: 'actionStarted', action });
      try {
        await patchFinding(findingId, action, notes);
        // PATCH answers with the finding row only — no members — so re-read
        // the detail rather than rendering a device list of zero.
        dispatch({ type: 'actionSucceeded', finding: await getFinding(findingId) });
      } catch (err) {
        // A 404 from either the PATCH or the re-read means the finding is no
        // longer there — most often the reconciler resolved it mid-action.
        // The counts are stale either way, and the honest answer is the empty
        // state, not a red "could not acknowledge".
        if (isFindingNotFound(err)) {
          dispatch({ type: 'notFound' });
          markFindingsChanged();
          return;
        }
        reportInternalError(err, 'finding-action');
        dispatch({
          type: 'actionFailed',
          message: err instanceof Error ? err.message : `Could not ${action} this finding`,
        });
        setToast({ text: `Could not ${action} this finding`, kind: 'error' });
        return;
      }
      // The Systems hero and Home strip both read the counts endpoint, whose
      // focus refresh is debounced to 60s — without this the tab would keep
      // claiming "1 open finding" for up to a minute after it was cleared.
      markFindingsChanged();
      setToast({ text: findingActionSuccessMessage(action), kind: 'success' });
    },
    [findingId],
  );

  const onPressAction = useCallback(
    (action: FleetFindingAction) => {
      if (action === 'dismiss') {
        setDismissing(true);
        return;
      }
      void runAction(action);
    },
    [runAction],
  );

  const onOpenDevice = useCallback(
    async (member: FindingMember) => {
      // `SystemsDeviceDetail` takes a whole Device, not an id, so the row has
      // to resolve one first. A device that is gone (or invisible to this
      // account) surfaces as a toast rather than a dead tap.
      setOpeningDeviceId(member.deviceId);
      try {
        const device = await getDevice(member.deviceId);
        navigation.navigate('SystemsDeviceDetail', { device });
      } catch (err) {
        reportInternalError(err, 'finding-member-open');
        setToast({ text: 'That device is no longer available', kind: 'error' });
      } finally {
        setOpeningDeviceId(null);
      }
    },
    [navigation],
  );

  if (state.phase === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.textMd} />
      </View>
    );
  }

  if (state.phase === 'notFound') {
    const copy = findingDetailNotFoundCopy();
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[6] }}>
        <Text style={[type.bodyMd, { color: theme.textHi }]}>{copy.title}</Text>
        <Text
          style={[type.meta, { color: theme.textMd, marginTop: spacing[2], textAlign: 'center' }]}
        >
          {copy.body}
        </Text>
      </View>
    );
  }

  if (state.phase === 'error' && !state.finding) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[6] }}>
        <Text style={[type.bodyMd, { color: theme.textHi }]}>Could not load this finding</Text>
        <Text
          style={[type.meta, { color: theme.textMd, marginTop: spacing[2], textAlign: 'center' }]}
        >
          {state.errorMessage}
        </Text>
        <Pressable onPress={() => void load()} style={{ marginTop: spacing[5] }}>
          <Text style={[type.bodyMd, { color: theme.brand }]}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const finding = state.finding;
  if (!finding) {
    return <View style={{ flex: 1 }} />;
  }

  const actions = detailActions(state);
  const busy = isActionBusy(state);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ padding: spacing[6], paddingBottom: spacing[10] }}
        refreshControl={
          <RefreshControl
            refreshing={state.refreshing}
            onRefresh={() => void load()}
            tintColor={theme.textMd}
          />
        }
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <SeverityPill severity={finding.severity} />
        </View>
        <Text style={[type.title, { color: theme.textHi, marginTop: spacing[3] }]}>
          {finding.title}
        </Text>
        {finding.summary ? (
          <Text style={[type.body, { color: theme.textMd, marginTop: spacing[3] }]}>
            {finding.summary}
          </Text>
        ) : null}

        <View style={{ marginTop: spacing[6] }}>
          {findingDetailMeta(finding).map((row) => (
            <View
              key={row.label}
              style={{ flexDirection: 'row', paddingVertical: spacing[2], alignItems: 'flex-start' }}
            >
              <Text style={[type.meta, { color: theme.textLo, width: 110 }]}>{row.label}</Text>
              <Text style={[type.meta, { color: theme.textHi, flex: 1 }]}>{row.value}</Text>
            </View>
          ))}
        </View>

        {state.actionErrorMessage ? (
          <Text style={[type.meta, { color: theme.deny, marginTop: spacing[4] }]}>
            {state.actionErrorMessage}
          </Text>
        ) : null}

        {actions.length > 0 ? (
          <View style={{ flexDirection: 'row', gap: spacing[3], marginTop: spacing[5] }}>
            {actions.map((action) => (
              <Pressable
                key={action}
                testID={`finding-action-${action}`}
                accessibilityRole="button"
                onPress={() => onPressAction(action)}
                disabled={busy}
                style={{
                  flex: 1,
                  paddingVertical: spacing[4],
                  alignItems: 'center',
                  borderRadius: radii.md,
                  backgroundColor: action === 'dismiss' ? theme.bg2 : theme.brand,
                  opacity: busy ? 0.5 : 1,
                }}
              >
                <Text style={[type.bodyMd, { color: theme.textHi }]}>
                  {state.pendingAction === action ? '…' : findingActionLabel(action)}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <Text style={[type.metaCaps, { color: theme.textLo, marginTop: spacing[8] }]}>
          AFFECTED DEVICES
        </Text>
        {finding.members.length === 0 ? (
          <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[3] }]}>
            No devices are currently attached to this finding.
          </Text>
        ) : (
          finding.members.map((member) => (
            <Pressable
              key={member.deviceId}
              testID={`finding-member-${member.deviceId}`}
              accessibilityRole="button"
              onPress={() => void onOpenDevice(member)}
              disabled={openingDeviceId !== null}
              style={({ pressed }) => ({
                paddingVertical: spacing[3],
                opacity: pressed || openingDeviceId === member.deviceId ? 0.6 : 1,
              })}
            >
              <Text style={[type.bodyMd, { color: theme.textHi }]} numberOfLines={1}>
                {memberPrimaryLabel(member)}
              </Text>
              <Text
                style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}
                numberOfLines={1}
              >
                {memberSecondaryLabel(member)}
              </Text>
            </Pressable>
          ))
        )}
      </ScrollView>

      <FindingDismissSheet
        visible={dismissing}
        busy={state.pendingAction === 'dismiss'}
        onCancel={() => setDismissing(false)}
        onSubmit={(notes) => {
          setDismissing(false);
          void runAction('dismiss', notes);
        }}
      />

      <Toast
        visible={toast !== null}
        text={toast?.text ?? ''}
        kind={toast?.kind ?? 'success'}
        onHidden={() => setToast(null)}
      />
    </View>
  );
}
