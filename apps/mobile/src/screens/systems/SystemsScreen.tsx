import { useCallback, useState } from 'react';
import { Clipboard, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Svg, { Circle, Line } from 'react-native-svg';

import { useApprovalTheme, palette, spacing, type } from '../../theme';
import type { Alert, Device } from '../../services/api';
import type { SystemsStackParamList, MainTabParamList } from '../../navigation/MainNavigator';
import { useAppDispatch } from '../../store';
import { acknowledgeAlertAsync } from '../../store/alertsSlice';
import { acknowledgeAlerts } from '../../services/api';
import { loadHistory, setError as setChatError } from '../../store/aiChatSlice';
import { getAiSessionMessages } from '../../services/aiChat';
import { historyToMessages } from '../chat/historyAdapter';
import { Toast } from '../../components/Toast';
import { SearchSheet } from '../search/SearchSheet';
import type { MobileSearchResult } from '../../services/search';
import { haptic } from '../../lib/motion';
import { track } from '../../lib/analytics';
import { reportInternalError } from '../../lib/errorReporting';

import { AlertActionSheet } from './components/AlertActionSheet';
import {
  beginAck,
  bulkActionLabel,
  emptyPendingAcks,
  endAck,
  reconcileSelection,
  toggleSelection,
  visibleAlerts,
} from './pendingAcks';
import { FilterChip } from './components/FilterChip';
import { Hero } from './components/Hero';
import { IssueRow } from './components/IssueRow';
import { OrgRow } from './components/OrgRow';
import { RecentRow } from './components/RecentRow';
import { SectionHeader } from './components/SectionHeader';
import { SkeletonRow } from './components/SkeletonRow';
import { deriveHeroState } from './heroCopy';
import { useSystemsData } from './useSystemsData';

type Nav = NativeStackNavigationProp<SystemsStackParamList, 'Systems'>;

// Inline magnifying glass — see SearchSheet for the input-decorating sibling.
// 16px sizing here matches the right-edge of the Hero copy block.
function HeaderSearchIcon({ color, size = 16 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      <Circle cx={7} cy={7} r={4.5} stroke={color} strokeWidth={1.6} fill="none" />
      <Line x1={10.4} y1={10.4} x2={14} y2={14} stroke={color} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}

// Builds a mobile Alert object out of a search result so AlertDetailScreen
// can render with what we have without re-fetching. Fields the screen does
// not display fall back to safe defaults.
function alertFromSearch(result: Extract<MobileSearchResult, { kind: 'alert' }>): Alert {
  const sev = result.meta.severity as Alert['severity'];
  // The mobile Alert type doesn't include 'info'; map it like services/api does.
  const severity: Alert['severity'] = sev === 'info' ? 'low' : sev;
  const triggered = result.meta.triggeredAt ?? new Date().toISOString();
  return {
    id: result.id,
    title: result.title,
    message: result.meta.message ?? '',
    severity,
    type: 'alert',
    deviceId: result.meta.deviceId ?? undefined,
    deviceName: result.meta.deviceName ?? undefined,
    acknowledged:
      result.meta.status === 'acknowledged' || result.meta.status === 'resolved',
    createdAt: triggered,
    updatedAt: triggered,
    metadata: { orgId: result.meta.orgId, status: result.meta.status },
  };
}

function deviceFromSearch(result: Extract<MobileSearchResult, { kind: 'device' }>): Device {
  const status: Device['status'] =
    result.meta.status === 'online'
      ? 'online'
      : result.meta.status === 'offline' || result.meta.status === 'decommissioned'
        ? 'offline'
        : 'warning';
  const fallbackTime = new Date(0).toISOString();
  return {
    id: result.id,
    name: result.meta.displayName?.trim() || result.meta.hostname || result.id,
    hostname: result.meta.hostname ?? undefined,
    os: result.meta.osType ?? undefined,
    status,
    lastSeen: result.meta.lastSeenAt ?? undefined,
    organizationId: result.meta.orgId,
    siteId: result.meta.siteId ?? undefined,
    siteName: result.meta.siteName ?? undefined,
    createdAt: fallbackTime,
    updatedAt: fallbackTime,
  };
}

export function SystemsScreen() {
  const insets = useSafeAreaInsets();
  const theme = useApprovalTheme('dark');
  const navigation = useNavigation<Nav>();
  const dispatch = useAppDispatch();

  const [sheetAlert, setSheetAlert] = useState<Alert | null>(null);
  const [pendingAcks, setPendingAcks] = useState(emptyPendingAcks);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [toast, setToast] = useState<
    { kind: 'success' | 'error'; text: string } | null
  >(null);

  const {
    summary,
    activeIssues,
    recent,
    orgRollups,
    filterOrgId,
    filterOrgName,
    setFilterOrgId,
    loading,
    refreshing,
    error,
    refresh,
    refreshIfStale,
  } = useSystemsData();

  const onRefresh = useCallback(() => {
    track('systems_pulled_to_refresh');
    refresh();
  }, [refresh]);

  const onApplyOrgFilter = useCallback(
    (orgId: string) => {
      track('systems_org_filter_applied');
      setFilterOrgId(orgId);
    },
    [setFilterOrgId],
  );

  // Hero stays whole-fleet even when filtered, so the user keeps the
  // global context. Filter affects issues + recent + the orgs section
  // visibility only.
  const hero = deriveHeroState(summary, activeIssues);

  useFocusEffect(
    useCallback(() => {
      refreshIfStale();
    }, [refreshIfStale]),
  );

  const onPressIssue = useCallback(
    (alert: Alert) => {
      navigation.navigate('SystemsAlertDetail', { alert });
    },
    [navigation],
  );

  const onLongPressAlert = useCallback((alert: Alert) => {
    setSheetAlert(alert);
  }, []);

  const onCloseSheet = useCallback(() => {
    setSheetAlert(null);
  }, []);

  // Rows mid-acknowledge are hidden immediately; the request runs behind them.
  const visibleIssues = visibleAlerts(activeIssues, pendingAcks);

  /**
   * Acknowledge one or many, optimistically.
   *
   * The rows disappear immediately and the request runs behind them: a single
   * acknowledge has been measured at 13-15s on a real deployment, and a bulk
   * call scales with the batch, so blocking the UI on it makes triage unusable.
   * A failure puts the rows back and says so.
   */
  const acknowledgeIds = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      setPendingAcks((p) => beginAck(p, ids));
      // Restore only what actually failed, so a partial outcome is honest.
      let toRestore = ids;
      try {
        const { acknowledged, failed } = await acknowledgeAlerts(ids);
        toRestore = failed;
        if (failed.length === 0) {
          setToast({
            kind: 'success',
            text: ids.length > 1 ? `Acknowledged ${ids.length} alerts` : 'Acknowledged.',
          });
        } else if (acknowledged.length === 0) {
          setToast({ kind: 'error', text: 'Could not acknowledge. Restored.' });
        } else {
          // Never claim the full count when some were refused.
          setToast({
            kind: 'error',
            text: `Acknowledged ${acknowledged.length}, ${failed.length} failed.`,
          });
        }
        // Successful ids stay hidden until the refetch supplies the new truth,
        // so the list cannot flash the old rows back.
        setPendingAcks((p) => endAck(p, failed));
        await refresh();
        setPendingAcks((p) => endAck(p, acknowledged));
        return;
      } catch (err) {
        reportInternalError(err, 'bulk-acknowledge');
        setToast({ kind: 'error', text: 'Could not acknowledge. Restored.' });
        setPendingAcks((p) => endAck(p, toRestore));
      }
    },
    [refresh]
  );

  const exitSelection = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  const onAcknowledgeSelected = useCallback(async () => {
    // Drop ids whose rows are gone — another operator may have acknowledged
    // one, and submitting it would be silently skipped server-side.
    const ids = [...reconcileSelection(selected, visibleIssues)];
    exitSelection();
    await acknowledgeIds(ids);
  }, [selected, visibleIssues, exitSelection, acknowledgeIds]);

  const onAcknowledgeFromSheet = useCallback(async () => {
    if (!sheetAlert) return;
    const targetId = sheetAlert.id;
    setSheetAlert(null);
    try {
      await dispatch(acknowledgeAlertAsync(targetId)).unwrap();
      setToast({ kind: 'success', text: 'Acknowledged.' });
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : 'Could not acknowledge alert.';
      setToast({ kind: 'error', text: msg });
    }
  }, [dispatch, sheetAlert]);

  const onCopyIdFromSheet = useCallback(() => {
    if (!sheetAlert) return;
    Clipboard.setString(sheetAlert.id);
    setSheetAlert(null);
    setToast({ kind: 'success', text: 'Copied alert ID.' });
  }, [sheetAlert]);

  const onSelectSearchResult = useCallback(
    async (result: MobileSearchResult) => {
      // Dismiss the sheet first so the navigation transition is the next
      // visible thing the user sees.
      setSearchOpen(false);

      if (result.kind === 'device') {
        navigation.navigate('SystemsDeviceDetail', { device: deviceFromSearch(result) });
        return;
      }

      if (result.kind === 'alert') {
        navigation.navigate('SystemsAlertDetail', { alert: alertFromSearch(result) });
        return;
      }

      // Session: load history into the chat slice and jump to HomeTab.
      // Errors are surfaced via a toast — not the chat slice — because the
      // user is still on the Systems screen at this point.
      try {
        const { messages: rows } = await getAiSessionMessages(result.id);
        const messages = historyToMessages(rows);
        dispatch(loadHistory({ sessionId: result.id, messages }));
        const parent = navigation.getParent<NativeStackNavigationProp<MainTabParamList>>();
        if (parent) parent.navigate('HomeTab');
      } catch (err) {
        // The raw message is internal (function name + HTTP status) — report it
        // to Sentry and show the user a static string instead (issue #3141).
        // Distinct tag from the HomeTab history paths: this open comes from
        // Systems search and surfaces as a toast, not the chat error banner.
        reportInternalError(err, 'ai-session-open-from-search');
        const msg = 'Could not load that conversation.';
        dispatch(setChatError(msg));
        setToast({ kind: 'error', text: msg });
      }
    },
    [dispatch, navigation],
  );

  const showOrgs = !filterOrgId && orgRollups.length > 0;
  const showRecent = recent.length > 0;
  const showActiveIssues = visibleIssues.length > 0;
  const showActiveSkeleton = loading && activeIssues.length === 0;
  // Every section can hide independently, and the org filter suppresses the
  // Organizations list outright — so a filtered org with nothing outstanding
  // rendered a completely blank page under the chip, indistinguishable from a
  // failed load. Say what is actually true instead.
  // Gated on error and refreshing too: with all fetches failed the hook sets
  // loading=false with empty slices, and an ungated banner would assert
  // "everything is clear" directly beneath the failure notice.
  const showNothingState =
    !loading
    && !refreshing
    && !error
    && !showOrgs
    && !showRecent
    && !showActiveIssues
    && !showActiveSkeleton;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg0 }}>
      {/* Search trigger floats top-right above the Hero. Sized to match
          the Hero's right-edge padding (spacing[6]) so it lines up with
          the copy block below it. */}
      <View
        style={{
          position: 'absolute',
          top: insets.top + spacing[3],
          right: spacing[4],
          zIndex: 10,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Search devices, alerts, conversations"
          hitSlop={10}
          onPress={() => {
            haptic.tap();
            setSearchOpen(true);
          }}
          style={({ pressed }) => ({
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? theme.bg2 : 'transparent',
          })}
        >
          <HeaderSearchIcon color={theme.textMd} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top,
          paddingBottom: insets.bottom + spacing[8],
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.brand}
          />
        }
      >
        <Hero
          copy={hero.copy}
          segments={hero.segments}
          legend={hero.legend}
          loading={loading}
        />

        <Pressable
          onPress={() =>
            navigation.navigate('SystemsDevices', {
              orgId: filterOrgId,
              orgName: filterOrgName,
            })
          }
          accessibilityRole="button"
          accessibilityLabel="View all devices"
          style={{
            marginHorizontal: spacing[6],
            marginTop: spacing[3],
            paddingVertical: spacing[3],
            paddingHorizontal: spacing[4],
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme.border,
            backgroundColor: theme.bg1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text style={{ ...type.bodyMd, color: theme.textHi }}>
            {filterOrgName ? `${filterOrgName} devices` : 'All devices'}
          </Text>
          <Text style={{ ...type.meta, color: theme.textLo }}>View</Text>
        </Pressable>

        {filterOrgId && filterOrgName ? (
          <FilterChip label={filterOrgName} onClear={() => setFilterOrgId(null)} />
        ) : null}

        {error ? (
          <View
            style={{
              paddingHorizontal: spacing[6],
              paddingTop: spacing[4],
            }}
          >
            <Text style={[type.meta, { color: palette.deny.base }]}>
              Couldn't refresh. Pull to try again.
            </Text>
          </View>
        ) : null}

        {showActiveSkeleton ? (
          <>
            <SectionHeader label="ACTIVE ISSUES" />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </>
        ) : null}

        {showActiveIssues ? (
          <>
            <SectionHeader label="ACTIVE ISSUES" />
            {visibleIssues.map((alert, idx) => (
              <IssueRow
                key={alert.id}
                alert={alert}
                onPress={() =>
                  selecting
                    ? setSelected((prev) => toggleSelection(prev, alert.id))
                    : onPressIssue(alert)
                }
                onLongPress={() => {
                  if (selecting) return;
                  // Long-press is the way in, and it ticks the row you pressed
                  // so the gesture is never a wasted step.
                  setSelecting(true);
                  setSelected(new Set([alert.id]));
                }}
                onSwipeAcknowledge={() => void acknowledgeIds([alert.id])}
                selectable={selecting}
                selected={selected.has(alert.id)}
                showDivider={idx < visibleIssues.length - 1}
                dividerColor={theme.border}
              />
            ))}
          </>
        ) : null}

        {showOrgs ? (
          <>
            <SectionHeader label="ORGANIZATIONS" />
            {orgRollups.map((org, idx) => (
              <OrgRow
                key={org.id}
                org={org}
                onPress={() => onApplyOrgFilter(org.id)}
                showDivider={idx < orgRollups.length - 1}
                dividerColor={theme.border}
              />
            ))}
          </>
        ) : null}

        {showRecent ? (
          <>
            <SectionHeader label="RECENT (24H)" />
            {recent.map((alert, idx) => (
              <RecentRow
                key={alert.id}
                alert={alert}
                onPress={() => onPressIssue(alert)}
                onLongPress={() => onLongPressAlert(alert)}
                showDivider={idx < recent.length - 1}
                dividerColor={theme.border}
              />
            ))}
          </>
        ) : null}

        {showNothingState ? (
          <View style={{ paddingHorizontal: spacing[6], paddingTop: spacing[8] }}>
            <Text
              style={{ ...type.bodyMd, color: theme.textHi, textAlign: 'center' }}
              accessibilityRole="text"
            >
              {filterOrgName ? `${filterOrgName} is all clear` : 'Everything is clear'}
            </Text>
            <Text
              style={{
                ...type.meta,
                color: theme.textLo,
                textAlign: 'center',
                marginTop: spacing[2],
              }}
            >
              {filterOrgName
                ? 'No active issues for this organization. Clear the filter to see the rest of the fleet.'
                : 'No active issues across your fleet.'}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {selecting ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: spacing[4],
            paddingTop: spacing[3],
            paddingBottom: spacing[6],
            borderTopWidth: 1,
            borderTopColor: theme.border,
            backgroundColor: theme.bg1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing[3],
          }}
        >
          <Pressable
            onPress={exitSelection}
            accessibilityRole="button"
            style={{ paddingVertical: spacing[2], paddingHorizontal: spacing[3] }}
          >
            <Text style={{ ...type.meta, color: theme.textMd }}>Cancel</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={() => void onAcknowledgeSelected()}
            disabled={selected.size === 0}
            accessibilityRole="button"
            accessibilityState={{ disabled: selected.size === 0 }}
            style={{
              paddingVertical: spacing[3],
              paddingHorizontal: spacing[4],
              borderRadius: 10,
              backgroundColor: palette.approve.base,
              opacity: selected.size === 0 ? 0.5 : 1,
            }}
          >
            <Text style={{ ...type.bodyMd, color: palette.approve.onBase }}>
              {bulkActionLabel(selected.size)}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <AlertActionSheet
        visible={!!sheetAlert}
        alert={sheetAlert}
        onClose={onCloseSheet}
        onAcknowledge={onAcknowledgeFromSheet}
        onCopyId={onCopyIdFromSheet}
      />

      <SearchSheet
        visible={searchOpen}
        onCancel={() => setSearchOpen(false)}
        onSelect={onSelectSearchResult}
      />

      <Toast
        visible={!!toast}
        text={toast?.text ?? ''}
        kind={toast?.kind ?? 'success'}
        onHidden={() => setToast(null)}
        bottomOffset={insets.bottom + spacing[16]}
      />
    </View>
  );
}
