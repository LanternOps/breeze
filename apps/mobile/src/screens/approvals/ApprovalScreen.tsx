import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSequence,
  runOnJS,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScrollView } from 'react-native-gesture-handler';

import { useAppDispatch, useAppSelector } from '../../store';
import { approve, deny, hydrateFromCache, markExpired, refreshPending } from '../../store/approvalsSlice';
import { useApprovalTheme, type, spacing, palette } from '../../theme';
import { duration, ease, haptic } from '../../lib/motion';

import { CountdownRing } from './components/CountdownRing';
import { RequesterRow } from './components/RequesterRow';
import { ActionHeadline } from './components/ActionHeadline';
import { DetailsCollapse } from './components/DetailsCollapse';
import { RiskBand } from './components/RiskBand';
import { ApprovalButtons } from './components/ApprovalButtons';
import { ApprovalToast } from './components/ApprovalToast';

export function ApprovalScreen() {
  const insets = useSafeAreaInsets();
  const theme = useApprovalTheme('dark');
  const dispatch = useAppDispatch();

  const focused = useAppSelector((s) => s.approvals.pending.find((a) => a.id === s.approvals.focusId));
  const inFlight = useAppSelector((s) =>
    focused ? (s.approvals.decisionInFlight[focused.id] ?? null) : null
  );

  const enter = useSharedValue(0);
  const successWash = useSharedValue(0);
  const denyShake = useSharedValue(0);

  const [toast, setToast] = useState<{ kind: 'approve' | 'deny'; text: string } | null>(null);

  // Mount: hydrate cache, then refresh from server, then play entrance.
  useEffect(() => {
    dispatch(hydrateFromCache());
    dispatch(refreshPending());
    enter.value = withTiming(1, { duration: duration.enter, easing: ease });
    haptic.arrive();
  }, []);

  const enterStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ translateY: (1 - enter.value) * 24 }],
  }));

  const washStyle = useAnimatedStyle(() => ({
    opacity: successWash.value,
    transform: [{ translateY: (1 - successWash.value) * 200 }],
  }));

  const shakeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: denyShake.value }],
  }));

  function handleApprove() {
    if (!focused) return;
    successWash.value = withSequence(
      withTiming(1, { duration: 200, easing: ease }),
      withTiming(0, { duration: 600, easing: ease })
    );
    haptic.approve();
    dispatch(approve(focused.id))
      .unwrap()
      .then(() => {
        setToast({ kind: 'approve', text: `Approved · ${focused.actionLabel}` });
      })
      .catch(() => {
        setToast({ kind: 'deny', text: 'Approve failed. Try again.' });
      });
  }

  function handleDeny(reason?: string) {
    if (!focused) return;
    denyShake.value = withSequence(
      withTiming(-4, { duration: 40 }),
      withTiming(4, { duration: 40 }),
      withTiming(0, { duration: 40 })
    );
    haptic.deny();
    dispatch(deny({ id: focused.id, reason }))
      .unwrap()
      .then(() => {
        setToast({ kind: 'deny', text: 'Denied · logged' });
      })
      .catch(() => {
        setToast({ kind: 'deny', text: 'Deny failed. Try again.' });
      });
  }

  function handleExpire() {
    if (!focused) return;
    dispatch(markExpired(focused.id));
  }

  // Empty state — only shown if user opened the app expecting a pending
  // approval and there isn't one (race with expiry, or already actioned).
  if (!focused) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg0, paddingTop: insets.top + spacing[10], paddingHorizontal: spacing[6] }}>
        <Text style={[type.title, { color: theme.textHi }]}>No pending approvals</Text>
        <Text style={[type.body, { color: theme.textMd, marginTop: spacing[2] }]}>
          You're all caught up.
        </Text>
      </View>
    );
  }

  // Recursive case: requesting client is THIS phone. v1 heuristic — match on
  // a known label prefix. Replace with a server-issued `isRecursive` flag in
  // a follow-up.
  const isRecursive = focused.requestingClientLabel.startsWith('Breeze Mobile');

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg0 }}>
      <Animated.View style={[{ flex: 1 }, enterStyle, shakeStyle]}>
        <View
          style={{
            paddingTop: insets.top + spacing[3],
            paddingHorizontal: spacing[6],
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <CountdownRing
            expiresAt={focused.expiresAt}
            onExpire={handleExpire}
          />
          <Pressable
            onPress={() => { /* report-as-suspicious sheet stub for v1 */ }}
            hitSlop={12}
          >
            <Text style={[type.meta, { color: theme.textMd }]}>Report</Text>
          </Pressable>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: spacing[16] }}>
          <RequesterRow
            clientLabel={focused.requestingClientLabel}
            machineLabel={focused.requestingMachineLabel}
            createdAt={focused.createdAt}
          />
          <ActionHeadline action={focused.actionLabel} />
          <RiskBand tier={focused.riskTier} summary={focused.riskSummary} />
          <DetailsCollapse toolName={focused.actionToolName} args={focused.actionArguments} />
        </ScrollView>

        <View style={{ paddingBottom: insets.bottom + spacing[5] }}>
          <ApprovalButtons
            isRecursive={isRecursive}
            inFlight={inFlight}
            onApprove={handleApprove}
            onDeny={handleDeny}
          />
        </View>
      </Animated.View>

      {/* Success wash — sweeps up from the bottom on approve */}
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            top: 0,
            backgroundColor: palette.approve.wash,
          },
          washStyle,
        ]}
      />

      <ApprovalToast
        visible={!!toast}
        text={toast?.text ?? ''}
        kind={toast?.kind ?? 'approve'}
        onHidden={() => setToast(null)}
      />
    </View>
  );
}
