import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSequence,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScrollView } from 'react-native-gesture-handler';

import { useAppDispatch, useAppSelector } from '../../store';
import { approve, deny, markExpired } from '../../store/approvalsSlice';
import { useApprovalTheme, type, spacing, palette } from '../../theme';
import { duration, ease, haptic } from '../../lib/motion';

import { CountdownRing } from './components/CountdownRing';
import { RequesterRow } from './components/RequesterRow';
import { ActionHeadline } from './components/ActionHeadline';
import { DetailsCollapse } from './components/DetailsCollapse';
import { RiskBand } from './components/RiskBand';
import { ApprovalButtons } from './components/ApprovalButtons';
import { Toast } from '../../components/Toast';

export function ApprovalScreen() {
  const insets = useSafeAreaInsets();
  const theme = useApprovalTheme('dark');
  const dispatch = useAppDispatch();

  const focused = useAppSelector((s) =>
    s.approvals.pending.find((a) => a.id === s.approvals.focusId && a.status === 'pending')
  );
  const inFlight = useAppSelector((s) =>
    focused ? (s.approvals.decisionInFlight[focused.id] ?? null) : null
  );

  const enter = useSharedValue(0);
  const successWash = useSharedValue(0);
  const denyShake = useSharedValue(0);

  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const expiredHandledRef = useRef<string | null>(null);

  // Data lifecycle lives in ApprovalGate; this mount owns entrance animation + arrival haptic.
  useEffect(() => {
    enter.value = withTiming(1, { duration: duration.enter, easing: ease });
    haptic.arrive();
  }, []);

  // Wall-clock expiry backup — Reanimated timing may not fire after background→resume.
  useEffect(() => {
    if (!focused) return;
    expiredHandledRef.current = null;
    const expiresMs = new Date(focused.expiresAt).getTime();
    const id = setInterval(() => {
      if (Date.now() < expiresMs) return;
      if (expiredHandledRef.current === focused.id) return;
      if (focused.status !== 'pending') return;
      expiredHandledRef.current = focused.id;
      dispatch(markExpired(focused.id));
      setToast({ kind: 'error', text: 'This request expired before you could respond.' });
    }, 1000);
    return () => clearInterval(id);
  }, [focused?.id, focused?.expiresAt, focused?.status]);

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
        setToast({ kind: 'success', text: `Approved · ${focused.actionLabel}` });
      })
      .catch((err: Error) => {
        setToast({ kind: 'error', text: messageForDecisionError(err.message, 'Approve') });
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
        setToast({ kind: 'error', text: 'Denied · logged' });
      })
      .catch((err: Error) => {
        setToast({ kind: 'error', text: messageForDecisionError(err.message, 'Deny') });
      });
  }

  function messageForDecisionError(code: string, verb: 'Approve' | 'Deny'): string {
    if (code === 'ALREADY_DECIDED') return 'Already decided elsewhere.';
    if (code === 'EXPIRED') return 'This request expired.';
    return `${verb} failed. Try again.`;
  }

  function handleExpire() {
    if (!focused) return;
    if (expiredHandledRef.current === focused.id) return;
    expiredHandledRef.current = focused.id;
    dispatch(markExpired(focused.id));
  }

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

  // Heuristic: client label prefix identifies our own mobile app to avoid self-approval loops.
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
            onPress={() => {
              // TODO: report-as-suspicious sheet (phase 2)
            }}
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

      <Toast
        visible={!!toast}
        text={toast?.text ?? ''}
        kind={toast?.kind ?? 'success'}
        onHidden={() => setToast(null)}
      />
    </View>
  );
}
