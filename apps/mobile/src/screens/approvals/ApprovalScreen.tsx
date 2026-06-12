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
import { approve, deny, markExpired, reportSuspicious } from '../../store/approvalsSlice';
import { useApprovalTheme, type, spacing, palette } from '../../theme';
import { duration, ease, haptic } from '../../lib/motion';
import { track } from '../../lib/analytics';

import { CountdownRing } from './components/CountdownRing';
import { RequesterRow } from './components/RequesterRow';
import { ActionHeadline } from './components/ActionHeadline';
import { DetailsCollapse } from './components/DetailsCollapse';
import { UacInterceptDetails } from './components/UacInterceptDetails';
import { RiskBand } from './components/RiskBand';
import { CustomerTenantBadge } from './components/CustomerTenantBadge';
import { ApprovalButtons } from './components/ApprovalButtons';
import { resolveApprovalFlowType } from './approvalFlow';
import { getApprovalCopy } from './approvalCopy';
import { decisionTarget, type CapturedRequestId } from './decisionTarget';
import { SuspiciousReportSheet } from './components/SuspiciousReportSheet';
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
  const [reportSheetOpen, setReportSheetOpen] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const expiredHandledRef = useRef<string | null>(null);

  // When does the user "see" the approval? When ApprovalScreen mounts onto a
  // focused approval — that's the takeover moment. We stamp it per approval
  // id so the seconds_to_decide reading on approve/deny is keyed to the
  // takeover mount, not to a re-render.
  const focusedAtRef = useRef<{ id: string; ts: number } | null>(null);
  useEffect(() => {
    if (!focused) {
      focusedAtRef.current = null;
      return;
    }
    if (focusedAtRef.current?.id !== focused.id) {
      focusedAtRef.current = { id: focused.id, ts: Date.now() };
      // Approval is now visible to the user. risk_tier is the only
      // property — we deliberately exclude actionLabel/arguments/host.
      track('approval_received', { risk_tier: focused.riskTier });
    }
  }, [focused]);

  function secondsToDecide(approvalId: string): number | undefined {
    const stamp = focusedAtRef.current;
    if (!stamp || stamp.id !== approvalId) return undefined;
    return Math.round((Date.now() - stamp.ts) / 1000);
  }

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

  function handleApprove(id: CapturedRequestId) {
    // Consent is bound to the request the user saw at press time. If focus
    // swapped during the biometric prompt, abort instead of approving a
    // different action. See PR #696 Critical #3 / decisionTarget.ts.
    const target = decisionTarget(id, focused);
    if (!target) {
      setToast({ kind: 'error', text: 'This request changed before you confirmed — review it again.' });
      return;
    }
    successWash.value = withSequence(
      withTiming(1, { duration: 200, easing: ease }),
      withTiming(0, { duration: 600, easing: ease })
    );
    haptic.approve();
    const approvalSnap = target;
    const decideSeconds = secondsToDecide(approvalSnap.id);
    dispatch(approve(approvalSnap.id))
      .unwrap()
      .then(() => {
        track('approval_decided', {
          decision: 'approve',
          risk_tier: approvalSnap.riskTier,
          is_recursive: approvalSnap.isRecursive,
          seconds_to_decide: decideSeconds,
        });
        setToast({ kind: 'success', text: `Approved · ${approvalSnap.actionLabel}` });
      })
      .catch((err: Error) => {
        setToast({ kind: 'error', text: messageForDecisionError(err.message, 'Approve') });
      });
  }

  function handleDeny(id: CapturedRequestId, reason?: string) {
    const target = decisionTarget(id, focused);
    if (!target) {
      setToast({ kind: 'error', text: 'This request changed before you confirmed — review it again.' });
      return;
    }
    denyShake.value = withSequence(
      withTiming(-4, { duration: 40 }),
      withTiming(4, { duration: 40 }),
      withTiming(0, { duration: 40 })
    );
    haptic.deny();
    const approvalSnap = target;
    const decideSeconds = secondsToDecide(approvalSnap.id);
    dispatch(deny({ id: approvalSnap.id, reason }))
      .unwrap()
      .then(() => {
        track('approval_decided', {
          decision: 'deny',
          risk_tier: approvalSnap.riskTier,
          is_recursive: approvalSnap.isRecursive,
          seconds_to_decide: decideSeconds,
        });
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

  function handleReportConfirm() {
    if (!focused || reportBusy) return;
    setReportBusy(true);
    haptic.deny();
    dispatch(reportSuspicious(focused.id))
      .unwrap()
      .then(() => {
        track('approval_reported_suspicious');
        setReportSheetOpen(false);
        setReportBusy(false);
        setToast({ kind: 'success', text: 'Reported. Session revoked.' });
      })
      .catch(() => {
        setReportBusy(false);
        setToast({ kind: 'error', text: "Couldn't revoke. Try again." });
      });
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

  // Server-issued: the API derives this from the requesting OAuth client +
  // target user (see apps/api/src/services/approvalRecursion.ts). Gates the
  // 5s hold-to-confirm self-approval UX.
  const isRecursive = focused.isRecursive;

  // Flow-type-aware copy + details (#1154). uac_intercept (PAM elevation) gets
  // an "Allow {exe} to run as admin" headline + a structured detail card; every
  // other flow keeps the existing actionLabel + generic JSON details.
  const flowType = resolveApprovalFlowType(focused);
  const copy = getApprovalCopy(focused);

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
            onPress={() => setReportSheetOpen(true)}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Report this approval as suspicious"
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
          <ActionHeadline action={copy.headline} />
          {focused.customerTenant ? (
            <CustomerTenantBadge tenant={focused.customerTenant} />
          ) : null}
          <RiskBand tier={focused.riskTier} summary={focused.riskSummary} />
          {flowType === 'uac_intercept' ? (
            <UacInterceptDetails args={focused.actionArguments} />
          ) : (
            <DetailsCollapse toolName={focused.actionToolName} args={focused.actionArguments} />
          )}
        </ScrollView>

        <View style={{ paddingBottom: insets.bottom + spacing[5] }}>
          <ApprovalButtons
            requestId={focused.id}
            isRecursive={isRecursive}
            inFlight={inFlight}
            approveLabel={copy.approveLabel}
            holdLabel={copy.holdLabel}
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

      <SuspiciousReportSheet
        visible={reportSheetOpen}
        busy={reportBusy}
        onCancel={() => {
          if (reportBusy) return;
          setReportSheetOpen(false);
        }}
        onConfirm={handleReportConfirm}
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
