import { useCallback, useEffect, useReducer } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { reportInternalError } from '../../lib/errorReporting';
import type { SystemsStackParamList } from '../../navigation/MainNavigator';
import { isFindingNotFound, listFindings } from '../../services/findings';
import { spacing, type, useApprovalTheme } from '../../theme';
import { SeverityPill } from './components/SeverityPill';
import {
  findingRowSubtitle,
  findingsListEmptyCopy,
  findingsListReducer,
  initialFindingsListState,
  toFindingListItem,
  type FindingListItem,
} from './findingsList';

type Nav = NativeStackNavigationProp<SystemsStackParamList, 'SystemsFindings'>;

interface Props {
  route: { params: { orgId: string; orgName: string } };
}

/**
 * The open + acknowledged fleet-hygiene findings for one org (#5365) — the
 * screen behind an ACTIVE ISSUES "N open findings" row, which until now was
 * display-only.
 *
 * All state lives in `findingsList.ts` so the sorting, the
 * keep-rows-on-a-failed-refresh rule and the copy are unit-tested in node;
 * this file is the state-to-JSX mapping.
 */
export function FindingsListScreen({ route }: Props): React.JSX.Element {
  const { orgId, orgName } = route.params;
  const theme = useApprovalTheme('dark');
  const navigation = useNavigation<Nav>();
  const [state, dispatch] = useReducer(findingsListReducer, initialFindingsListState);

  const load = useCallback(async () => {
    dispatch({ type: 'load' });
    try {
      const { findings, total } = await listFindings({ orgId });
      dispatch({ type: 'loaded', findings: findings.map(toFindingListItem), total });
    } catch (err) {
      // A 404 here is "nothing to show for this org", not a fault — the same
      // rule the detail screen applies.
      if (isFindingNotFound(err)) {
        dispatch({ type: 'empty' });
        return;
      }
      reportInternalError(err, 'findings-list');
      dispatch({
        type: 'failed',
        message: err instanceof Error ? err.message : 'Could not load findings',
      });
    }
  }, [orgId]);

  useEffect(() => {
    navigation.setOptions({ title: orgName || 'Findings' });
  }, [navigation, orgName]);

  useEffect(() => {
    void load();
  }, [load]);

  const onPressFinding = useCallback(
    (item: FindingListItem) => {
      navigation.navigate('SystemsFindingDetail', { findingId: item.id });
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

  const empty = findingsListEmptyCopy(orgName);

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingVertical: spacing[4], flexGrow: 1 }}
      refreshControl={
        <RefreshControl
          refreshing={state.refreshing}
          onRefresh={() => void load()}
          tintColor={theme.textMd}
        />
      }
    >
      {/* A refresh that failed while rows are still on screen is a banner, not
          a wipe — the reducer keeps the stale rows deliberately. */}
      {state.errorMessage && state.findings.length > 0 ? (
        <Text
          style={[
            type.meta,
            { color: theme.deny, paddingHorizontal: spacing[6], paddingBottom: spacing[3] },
          ]}
        >
          {state.errorMessage}
        </Text>
      ) : null}

      {state.phase === 'error' ? (
        <View style={{ padding: spacing[6], alignItems: 'center' }}>
          <Text style={[type.bodyMd, { color: theme.textHi, textAlign: 'center' }]}>
            Could not load findings
          </Text>
          <Text
            style={[
              type.meta,
              { color: theme.textMd, marginTop: spacing[2], textAlign: 'center' },
            ]}
          >
            {state.errorMessage}
          </Text>
          <Pressable
            onPress={() => void load()}
            style={{ marginTop: spacing[5], paddingVertical: spacing[3] }}
          >
            <Text style={[type.bodyMd, { color: theme.brand }]}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {state.phase === 'ready' && state.findings.length === 0 ? (
        <View style={{ padding: spacing[6], alignItems: 'center' }}>
          <Text style={[type.bodyMd, { color: theme.textHi }]}>{empty.title}</Text>
          <Text
            style={[
              type.meta,
              { color: theme.textMd, marginTop: spacing[2], textAlign: 'center' },
            ]}
          >
            {empty.body}
          </Text>
        </View>
      ) : null}

      {state.findings.map((item, idx) => (
        <Pressable
          key={item.id}
          testID={`finding-row-${item.id}`}
          accessibilityRole="button"
          accessibilityLabel={`${item.title}. ${findingRowSubtitle(item)}`}
          onPress={() => onPressFinding(item)}
          style={({ pressed }) => ({
            paddingHorizontal: spacing[6],
            paddingVertical: spacing[4],
            backgroundColor: pressed ? theme.bg1 : 'transparent',
          })}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <SeverityPill severity={item.severity} />
            <View style={{ flex: 1, marginLeft: spacing[3] }}>
              <Text style={[type.bodyMd, { color: theme.textHi }]} numberOfLines={2}>
                {item.title}
              </Text>
              <Text
                style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}
                numberOfLines={1}
              >
                {findingRowSubtitle(item)}
              </Text>
            </View>
          </View>
          {idx < state.findings.length - 1 ? (
            <View
              style={{
                height: 1,
                backgroundColor: theme.border,
                marginTop: spacing[4],
                marginBottom: -spacing[4],
              }}
            />
          ) : null}
        </Pressable>
      ))}

      {/* The list is capped at one page; say so rather than implying the org
          has only what fits on screen. */}
      {state.total > state.findings.length ? (
        <Text
          style={[
            type.meta,
            {
              color: theme.textLo,
              paddingHorizontal: spacing[6],
              paddingTop: spacing[5],
            },
          ]}
        >
          Showing {state.findings.length} of {state.total}. Open the web console for the rest.
        </Text>
      ) : null}
    </ScrollView>
  );
}
