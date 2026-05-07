import { useCallback, useState } from 'react';
import { Clipboard, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { useApprovalTheme, palette, spacing, type } from '../../theme';
import type { Alert } from '../../services/api';
import type { SystemsStackParamList } from '../../navigation/MainNavigator';
import { useAppDispatch } from '../../store';
import { acknowledgeAlertAsync } from '../../store/alertsSlice';
import { Toast } from '../../components/Toast';

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

function Divider({ color }: { color: string }) {
  return (
    <View
      style={{
        height: 1,
        backgroundColor: color,
        marginLeft: spacing[6],
      }}
    />
  );
}

export function SystemsScreen() {
  const insets = useSafeAreaInsets();
  const theme = useApprovalTheme('dark');
  const navigation = useNavigation<Nav>();
  const dispatch = useAppDispatch();

  const [sheetAlert, setSheetAlert] = useState<Alert | null>(null);
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

  const showOrgs = !filterOrgId && orgRollups.length > 0;
  const showRecent = recent.length > 0;
  const showActiveIssues = activeIssues.length > 0;
  const showActiveSkeleton = loading && activeIssues.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg0 }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top,
          paddingBottom: insets.bottom + spacing[8],
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
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
              <View key={alert.id}>
                <IssueRow
                  alert={alert}
                  onPress={() => onPressIssue(alert)}
                  onLongPress={() => onLongPressAlert(alert)}
                />
                {idx < activeIssues.length - 1 ? <Divider color={theme.border} /> : null}
              </View>
            ))}
          </>
        ) : null}

        {showOrgs ? (
          <>
            <SectionHeader label="ORGANIZATIONS" />
            {orgRollups.map((org, idx) => (
              <View key={org.id}>
                <OrgRow org={org} onPress={() => setFilterOrgId(org.id)} />
                {idx < orgRollups.length - 1 ? <Divider color={theme.border} /> : null}
              </View>
            ))}
          </>
        ) : null}

        {showRecent ? (
          <>
            <SectionHeader label="RECENT (24H)" />
            {recent.map((alert, idx) => (
              <View key={alert.id}>
                <RecentRow
                  alert={alert}
                  onPress={() => onPressIssue(alert)}
                  onLongPress={() => onLongPressAlert(alert)}
                />
                {idx < recent.length - 1 ? <Divider color={theme.border} /> : null}
              </View>
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
