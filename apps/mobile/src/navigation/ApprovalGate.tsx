import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
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
import { useApprovalQueueSync } from '../screens/approvals/useApprovalQueueSync';
import { useApprovalTheme, type, spacing, radii } from '../theme';

interface Props {
  children: React.ReactNode;
}

// Renders ApprovalScreen as a global takeover whenever there is a focused pending approval.
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

  useEffect(() => {
    dispatch(hydrateFromCache());
    dispatch(refreshPending());

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

  if (focused) {
    return <ApprovalScreen />;
  }

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
