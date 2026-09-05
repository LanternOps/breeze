import { useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { logoutAsync } from '../store/authSlice';
import { approverBannerCopy, type ApproverBannerSeverity } from './approverBannerCopy';
import { useAppDispatch, useAppSelector } from '../store';
import {
  clearApprovalsError,
  fetchOne,
  refreshPending,
  setFocus,
  hydrateFromCache,
} from '../store/approvalsSlice';
import {
  addNotificationReceivedListener,
  addNotificationResponseReceivedListener,
  parseApprovalNotification,
  removeNotificationSubscription,
} from '../services/notifications';
import { ApprovalScreen } from '../screens/approvals/ApprovalScreen';
import { shouldHandleTap } from './pushRouting';
import { useApprovalQueueSync } from '../screens/approvals/useApprovalQueueSync';
import { useApprovalTheme, type, spacing, radii } from '../theme';

interface Props {
  children: React.ReactNode;
}

/**
 * AsyncStorage key holding the identifier of the last approval push tap we
 * acted on. Separate from PushTapRouter's ticket key: the two listeners run
 * independently and must not clobber each other's dedupe state.
 */
export const LAST_HANDLED_APPROVAL_RESPONSE_KEY = 'notif:lastHandledApprovalResponseId';

/**
 * Renders ApprovalScreen as a global takeover OVER `children` whenever there is
 * a focused pending approval.
 *
 * Over, not instead of: this used to `return <ApprovalScreen />` and unmount
 * the whole MainNavigator. HomeScreen aborts its SSE stream on unmount, so an
 * `approval_required` event arriving mid-turn tore down the very chat that was
 * waiting on the decision — the server kept running the tool after approval,
 * but the phone was left on "RUNNING …" forever. Keeping the navigator mounted
 * underneath keeps the stream open, exactly like the web chat's inline card.
 */
export function ApprovalGate({ children }: Props) {
  const dispatch = useAppDispatch();
  const focused = useAppSelector((s) =>
    s.approvals.pending.find((a) => a.id === s.approvals.focusId && a.status === 'pending')
  );
  const error = useAppSelector((s) => s.approvals.error);
  const pushRegistration = useAppSelector((s) => s.auth.pushRegistration);
  const approverRegistration = useAppSelector((s) => s.auth.approverRegistration);
  const approverReason = useAppSelector((s) => s.auth.approverRegistrationReason);

  // Dismissals are per-session and per-kind. These banners describe a standing
  // condition, not a transient event, so without a dismiss the user is stuck
  // with a permanent overlay they cannot act on until their next sign-in.
  const [dismissedPush, setDismissedPush] = useState(false);
  const [dismissedApprover, setDismissedApprover] = useState(false);

  // Keeps `pending` in step with decisions made off this phone (browser, second
  // device, server-side expiry). Without it the queue only ever shrank when
  // THIS phone decided something.
  useApprovalQueueSync();

  // The takeover covers whatever was on screen; a keyboard left up from the
  // chat composer or a ticket form would otherwise sit over the Approve/Deny
  // buttons.
  useEffect(() => {
    if (focused) Keyboard.dismiss();
  }, [focused?.id]);

  /**
   * Identifier of the last approval push tap acted on in this process. expo
   * delivers the response that LAUNCHED the app to the response listener as
   * well, and a JS relaunch (iOS reclaiming memory during the Face ID prompt
   * or the approve round-trip) re-registers this listener and replays that
   * same tap — which re-focused an approval the user had just decided, and
   * showed the takeover a second time. Same guard PushTapRouter uses for
   * ticket pushes.
   */
  const lastHandledTap = useRef<string | null>(null);

  useEffect(() => {
    dispatch(hydrateFromCache());
    dispatch(refreshPending());

    void AsyncStorage.getItem(LAST_HANDLED_APPROVAL_RESPONSE_KEY)
      .then((stored) => {
        // Do not clobber a live tap that landed while storage was being read.
        if (lastHandledTap.current === null) lastHandledTap.current = stored;
      })
      .catch(() => {
        // Storage failure costs at most one redundant takeover.
      });

    const recv = addNotificationReceivedListener((n) => {
      const parsed = parseApprovalNotification(n);
      if (!parsed) return;
      dispatch(setFocus(parsed.approvalId));
      dispatch(fetchOne(parsed.approvalId))
        .unwrap()
        .catch(() => {
          // rejected reducer surfaces the error; nothing else to do.
        });
    });
    const tap = addNotificationResponseReceivedListener((r) => {
      const parsed = parseApprovalNotification(r.notification);
      if (!parsed) return;
      const identifier = r.notification.request.identifier;
      if (!shouldHandleTap(identifier, lastHandledTap.current)) return;
      if (identifier) {
        lastHandledTap.current = identifier;
        AsyncStorage.setItem(LAST_HANDLED_APPROVAL_RESPONSE_KEY, identifier).catch(() => {
          // Storage failure costs at most one redundant takeover.
        });
      }
      dispatch(setFocus(parsed.approvalId));
      dispatch(fetchOne(parsed.approvalId))
        .unwrap()
        .catch(() => {
          // rejected reducer surfaces the error; nothing else to do.
        });
    });

    return () => {
      removeNotificationSubscription(recv);
      removeNotificationSubscription(tap);
    };
  }, []);

  // One banner at a time — they share the same absolute slot. Push failure
  // outranks approver failure: an approval that never arrives is worse than one
  // that arrives unsigned.
  const showPush = !error && pushRegistration === 'failed' && !dismissedPush;
  const approverSeverity: ApproverBannerSeverity | null =
    approverRegistration === 'failed'
      ? 'failed'
      : approverRegistration === 'deferred'
        ? 'deferred'
        : null;
  const showApprover =
    !error && pushRegistration !== 'failed' && approverSeverity !== null && !dismissedApprover;

  if (focused) {
    return (
      <>
        {children}
        <View
          style={StyleSheet.absoluteFill}
          accessibilityViewIsModal
          testID="approval-takeover"
        >
          <ApprovalScreen />
        </View>
      </>
    );
  }

  return (
    <>
      {children}
      {error ? (
        <ApprovalErrorBanner message={error} onDismiss={() => dispatch(clearApprovalsError())} />
      ) : null}
      {showPush ? <PushFailedBanner onDismiss={() => setDismissedPush(true)} /> : null}
      {showApprover && approverSeverity ? (
        <ApproverSetupBanner
          severity={approverSeverity}
          reason={approverReason}
          onDismiss={() => setDismissedApprover(true)}
          onSignOut={() => {
            setDismissedApprover(true);
            void dispatch(logoutAsync({ deliberate: true }));
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Shared shell for the status banners.
 *
 * Anchored to the BOTTOM, above the tab bar. These used to sit at
 * `insets.top`, directly on top of ChatHeader's avatar — the profile button
 * was unreachable for as long as the banner was up, and since nothing could
 * dismiss it, that was the whole session.
 */
function BannerShell({
  borderColor,
  children,
}: {
  borderColor: string;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const theme = useApprovalTheme('dark');
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        bottom: insets.bottom + TAB_BAR_HEIGHT + spacing[2],
        left: spacing[4],
        right: spacing[4],
      }}
    >
      <View
        style={{
          backgroundColor: theme.bg2,
          borderRadius: radii.md,
          paddingVertical: spacing[3],
          paddingHorizontal: spacing[4],
          borderColor,
          borderWidth: 1,
        }}
      >
        {children}
      </View>
    </View>
  );
}

/**
 * Height of the bottom tab bar the banners must clear. React Navigation does
 * not expose this outside a screen (`useBottomTabBarHeight` throws here, since
 * ApprovalGate renders ABOVE the navigator), so it is pinned to the iOS default
 * compact tab bar height. Changing `tabBarStyle.height` in MainNavigator means
 * changing this too.
 */
const TAB_BAR_HEIGHT = 49;

function DismissRow({ onDismiss, label = 'Dismiss' }: { onDismiss: () => void; label?: string }) {
  const theme = useApprovalTheme('dark');
  return (
    <Pressable onPress={onDismiss} hitSlop={8} accessibilityRole="button">
      <Text style={[type.meta, { color: theme.textLo }]}>{label}</Text>
    </Pressable>
  );
}

function ApprovalErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const insets = useSafeAreaInsets();
  const theme = useApprovalTheme('dark');
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        bottom: insets.bottom + TAB_BAR_HEIGHT + spacing[2],
        left: spacing[4],
        right: spacing[4],
      }}
    >
      <Pressable
        onPress={onDismiss}
        accessibilityRole="button"
        style={{
          backgroundColor: theme.deny,
          borderRadius: radii.md,
          paddingVertical: spacing[3],
          paddingHorizontal: spacing[4],
        }}
      >
        <Text style={[type.bodyMd, { color: '#fff' }]}>{message}</Text>
        <Text style={[type.meta, { color: '#fff', opacity: 0.8, marginTop: spacing[1] }]}>Tap to dismiss</Text>
      </Pressable>
    </View>
  );
}

/**
 * Shown when {@link ensureApproverDevice} could not register this phone's
 * hardware key, or deferred because no login-minted grant was available.
 * Approvals still work — they are just recorded at the lowest assurance level
 * (L1, session tap) instead of being hardware-signed. Without this banner that
 * downgrade is completely invisible to the technician.
 *
 * Copy lives in `approverBannerCopy.ts` so the "this is not about Face ID"
 * distinction is unit-tested rather than re-litigated in JSX.
 */
function ApproverSetupBanner({
  severity,
  reason,
  onDismiss,
  onSignOut,
}: {
  severity: ApproverBannerSeverity;
  reason: string | null;
  onDismiss: () => void;
  onSignOut: () => void;
}) {
  const theme = useApprovalTheme('dark');
  const copy = approverBannerCopy(severity, reason);
  return (
    <BannerShell borderColor={severity === 'failed' ? theme.deny : theme.border}>
      <Text style={[type.bodyMd, { color: theme.textHi }]}>{copy.title}</Text>
      <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>{copy.body}</Text>
      {copy.detail ? (
        <Text style={[type.meta, { color: theme.textLo, marginTop: spacing[2] }]}>
          {copy.detail}
        </Text>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: spacing[3],
        }}
      >
        <Pressable onPress={onSignOut} hitSlop={8} accessibilityRole="button">
          <Text style={[type.meta, { color: theme.brand }]}>{copy.actionLabel}</Text>
        </Pressable>
        <DismissRow onDismiss={onDismiss} />
      </View>
    </BannerShell>
  );
}

function PushFailedBanner({ onDismiss }: { onDismiss: () => void }) {
  const theme = useApprovalTheme('dark');
  return (
    <BannerShell borderColor={theme.deny}>
      <Text style={[type.bodyMd, { color: theme.textHi }]}>Push notifications aren’t registered</Text>
      <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>
        Approval requests won’t reach this device. Check that notifications are
        allowed for Breeze in iOS Settings, then sign in again.
      </Text>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: spacing[3] }}>
        <DismissRow onDismiss={onDismiss} />
      </View>
    </BannerShell>
  );
}
