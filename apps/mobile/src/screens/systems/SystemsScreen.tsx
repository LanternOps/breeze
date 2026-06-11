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
import { loadHistory, setError as setChatError } from '../../store/aiChatSlice';
import { getAiSessionMessages } from '../../services/aiChat';
import { historyToMessages } from '../chat/historyAdapter';
import { Toast } from '../../components/Toast';
import { SearchSheet } from '../search/SearchSheet';
import type { MobileSearchResult } from '../../services/search';
import { haptic } from '../../lib/motion';
import { track } from '../../lib/analytics';

import { AlertActionSheet } from './components/AlertActionSheet';
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
        const msg = err instanceof Error ? err.message : 'Could not load conversation.';
        dispatch(setChatError(msg));
        setToast({ kind: 'error', text: msg });
      }
    },
    [dispatch, navigation],
  );

  const showOrgs = !filterOrgId && orgRollups.length > 0;
  const showRecent = recent.length > 0;
  const showActiveIssues = activeIssues.length > 0;
  const showActiveSkeleton = loading && activeIssues.length === 0;

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
            {activeIssues.map((alert, idx) => (
              <IssueRow
                key={alert.id}
                alert={alert}
                onPress={() => onPressIssue(alert)}
                onLongPress={() => onLongPressAlert(alert)}
                showDivider={idx < activeIssues.length - 1}
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
      </ScrollView>

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
