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
import { selectFocusedApproval } from '../../navigation/approvalTakeover';
import { useApprovalTheme, type, spacing, palette } from '../../theme';
import { duration, ease, haptic } from '../../lib/motion';
import { track } from '../../lib/analytics';

import {
  APPROVAL_TOAST_OWNER,
  decisionToastFor,
  isDecisionToastVisible,
  shouldShowEmptyApprovalState,
} from './approvalDecidedTransition';
import { CountdownRing } from './components/CountdownRing';
import { RequesterAvatar } from './components/RequesterAvatar';
import { RequesterRow } from './components/RequesterRow';
import { ActionHeadline } from './components/ActionHeadline';
import { DetailsCollapse } from './components/DetailsCollapse';
import { UacInterceptDetails } from './components/UacInterceptDetails';
import { ScriptProposalDetails } from './components/ScriptProposalDetails';
import { RiskBand } from './components/RiskBand';
import { CustomerTenantBadge } from './components/CustomerTenantBadge';
import { ApprovalButtons } from './components/ApprovalButtons';
import { resolveApprovalFlowType, extractProposalId } from './approvalFlow';
import { getApprovalCopy } from './approvalCopy';
import { decisionTarget, type CapturedRequestId } from './decisionTarget';
import { SuspiciousReportSheet } from './components/SuspiciousReportSheet';
import { ToastOutlet, useToast } from '../../components/toast/ToastHost';

export function ApprovalScreen() {
  const insets = useSafeAreaInsets();
  const theme = useApprovalTheme('dark');
  const dispatch = useAppDispatch();

  // #5172: shared with ApprovalGate so the takeover Modal's visibility and
  // this screen's content branch can never drift apart — see approvalTakeover.ts.
  const focused = useAppSelector((s) => selectFocusedApproval(s.approvals));
  const inFlight = useAppSelector((s) =>
    focused ? (s.approvals.decisionInFlight[focused.id] ?? null) : null
  );

  const enter = useSharedValue(0);
  const successWash = useSharedValue(0);
  const denyShake = useSharedValue(0);

  // Scoped by approval id: ApprovalGate keeps this ONE instance mounted while
  // focus rolls from request A to request B, and `approve.fulfilled` moves
  // focus in the same tick the "Approved · …" toast is posted — so without the
  // scoping, A's success toast is still on screen over B's Approve/Deny
  // buttons. The success/deny confirmations are therefore deliberately dropped
  // once focus rolls onto a DIFFERENT pending request (the wash/shake
  // animation is the feedback that survives that case). When focus instead
  // rolls to NOTHING (A was the last pending row), the toast is exactly what
  // rescues the takeover from flashing "No pending approvals" before it — see
  // `isDecisionToastVisible` (#5172). Outcome ERRORS post no `sourceId` and
  // stay visible regardless of focus either way.
  //
  // The toast itself lives in the app-wide host (#5368); `current` is read back
  // here because this screen's empty-state branch waits on the confirmation it
  // just posted. The host owns expiry, so the JS backstop that used to sit here
  // (against an exit animation whose callback never fires) now covers every
  // screen — see TOAST_BACKSTOP_MS.
  const { current: toast, show: showToast, dismiss: dismissToast } = useToast();
  const [reportSheetOpen, setReportSheetOpen] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const expiredHandledRef = useRef<string | null>(null);
  // W03 (#5612): STRICT patterns the approver has ticked on a script_proposal's
  // checklist, threaded into the approve POST body. ScriptProposalDetails
  // reports its own reset (to []) whenever the focused proposal changes, so
  // this doesn't need its own focus-tracking effect.
  const [acknowledgedPatterns, setAcknowledgedPatterns] = useState<string[]>([]);
  const [proposalApproveBlocked, setProposalApproveBlocked] = useState<'acknowledge' | 'permission' | null>(null);

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
      // Screen-global: markExpired rolls focus to the next request in the
      // same tick, and the user still needs to hear that this one lapsed.
      showToast({ owner: APPROVAL_TOAST_OWNER, kind: 'error', text: 'This request expired before you could respond.' });
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
      showToast({ owner: APPROVAL_TOAST_OWNER, kind: 'error', text: 'This request changed before you confirmed — review it again.' });
      return;
    }
    successWash.value = withSequence(
      withTiming(1, { duration: 200, easing: ease }),
      withTiming(0, { duration: 600, easing: ease })
    );
    haptic.approve();
    const approvalSnap = target;
    const decideSeconds = secondsToDecide(approvalSnap.id);
    // Recomputed from the captured snapshot (not the outer `flowType`) so the
    // decision matches exactly what the user consented to at press time.
    const isScriptProposal = resolveApprovalFlowType(approvalSnap) === 'script_proposal';
    dispatch(
      approve(
        isScriptProposal && acknowledgedPatterns.length > 0
          ? { id: approvalSnap.id, acknowledgedPatterns }
          : approvalSnap.id
      )
    )
      .unwrap()
      .then(() => {
        track('approval_decided', {
          decision: 'approve',
          risk_tier: approvalSnap.riskTier,
          is_recursive: approvalSnap.isRecursive,
          seconds_to_decide: decideSeconds,
        });
        showToast({ owner: APPROVAL_TOAST_OWNER, sourceId: approvalSnap.id, kind: 'success', text: `Approved · ${approvalSnap.actionLabel}` });
      })
      .catch((err: Error) => {
        showToast({ owner: APPROVAL_TOAST_OWNER, kind: 'error', text: messageForDecisionError(err.message, 'Approve') });
      });
  }

  function handleDeny(id: CapturedRequestId, reason?: string) {
    const target = decisionTarget(id, focused);
    if (!target) {
      showToast({ owner: APPROVAL_TOAST_OWNER, kind: 'error', text: 'This request changed before you confirmed — review it again.' });
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
        showToast({ owner: APPROVAL_TOAST_OWNER, sourceId: approvalSnap.id, kind: 'error', text: 'Denied · logged' });
      })
      .catch((err: Error) => {
        showToast({ owner: APPROVAL_TOAST_OWNER, kind: 'error', text: messageForDecisionError(err.message, 'Deny') });
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
        showToast({ owner: APPROVAL_TOAST_OWNER, kind: 'success', text: 'Reported. Session revoked.' });
      })
      .catch(() => {
        setReportBusy(false);
        showToast({ owner: APPROVAL_TOAST_OWNER, kind: 'error', text: "Couldn't revoke. Try again." });
      });
  }

  function handleExpire() {
    if (!focused) return;
    if (expiredHandledRef.current === focused.id) return;
    expiredHandledRef.current = focused.id;
    dispatch(markExpired(focused.id));
  }

  // `decisionToastFor` first drops anything this screen did not post — the
  // host is app-wide and the navigator keeps running underneath the takeover,
  // so background toasts arrive here too (#5368). Of what remains, a toast
  // bound to a request that is no longer on screen is stale; one with no
  // approval id (report outcome, focus-swap guard) is screen-global.
  // Computed before the `!focused` branch below (#5172): the decision that
  // just cleared `focused` is exactly what queues this toast, so the toast's
  // liveness has to be known before deciding what "no focused row" renders.
  const toastVisible = isDecisionToastVisible(decisionToastFor(toast), focused?.id);

  // A confirmation whose row is no longer focused used to be merely un-rendered
  // by this screen's own <Toast>. The host is shared, so it has to be taken
  // DOWN instead — otherwise the dropped confirmation would ride along and
  // paint over whatever surface comes next.
  useEffect(() => {
    if (toast !== null && toast.owner === APPROVAL_TOAST_OWNER && !toastVisible) {
      dismissToast(toast.id);
    }
  }, [toast, toastVisible, dismissToast]);

  if (!focused) {
    if (shouldShowEmptyApprovalState({ focused: false, decisionToastPending: toastVisible })) {
      return (
        <View style={{ flex: 1, backgroundColor: theme.bg0, paddingTop: insets.top + spacing[10], paddingHorizontal: spacing[6] }}>
          <Text style={[type.title, { color: theme.textHi }]}>No pending approvals</Text>
          <Text style={[type.body, { color: theme.textMd, marginTop: spacing[2] }]}>
            You're all caught up.
          </Text>
        </View>
      );
    }
    // A decision (approve/deny/report) was just confirmed on the last
    // pending row and its outcome toast is still owed. Hold on a neutral
    // background instead of flashing "No pending approvals" while the
    // takeover Modal's native dismiss transition is still in flight (#5172)
    // — the toast clears this itself via `onHidden`, at which point
    // `shouldShowEmptyApprovalState` above takes the branch that renders
    // the genuine empty state (or ApprovalGate has finished dismissing the
    // Modal and this has already stopped being visible to the user).
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg0 }}>
        {/* ApprovalGate presents this screen in an RN Modal, which paints
            above the app-wide toast host, so the takeover mounts its own
            outlet (topmost outlet wins — see toastState.topOutletId). */}
        {toastVisible ? <ToastOutlet /> : null}
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
          >
            <RequesterAvatar clientLabel={focused.requestingClientLabel} />
          </CountdownRing>
          <Pressable
            onPress={() => setReportSheetOpen(true)}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Report this approval as suspicious"
            accessibilityHint="Flags this request as malicious and revokes the requesting app's access"
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
          ) : flowType === 'script_proposal' ? (
            <ScriptProposalDetails
              proposalId={extractProposalId(focused.actionArguments)!}
              onAcknowledgementsChange={setAcknowledgedPatterns}
              onApproveBlockedChange={setProposalApproveBlocked}
            />
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
            approveDisabled={flowType === 'script_proposal' && proposalApproveBlocked !== null}
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

      {toastVisible ? <ToastOutlet /> : null}
    </View>
  );
}
