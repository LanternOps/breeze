import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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

  return (
    <>
      {children}
      {error ? (
        <ApprovalErrorBanner message={error} onDismiss={() => dispatch(clearApprovalsError())} />
      ) : null}
      {/* One banner at a time — they share the same absolute slot. Push failure
          outranks approver failure: an approval that never arrives is worse
          than one that arrives unsigned. */}
      {!error && pushRegistration === 'failed' ? <PushFailedBanner /> : null}
      {!error && pushRegistration !== 'failed' && approverRegistration === 'failed' ? (
        <ApproverFailedBanner />
      ) : null}
      {!error && pushRegistration !== 'failed' && approverRegistration === 'deferred' ? (
        <ApproverDeferredBanner />
      ) : null}
    </>
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
        top: insets.top + spacing[2],
        left: spacing[4],
        right: spacing[4],
      }}
    >
      <Pressable
        onPress={onDismiss}
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
 * hardware key. Approvals still work — they are just recorded at the lowest
 * assurance level (L1, session tap) instead of being hardware-signed. Without
 * this banner that downgrade is completely invisible to the technician.
 */
function ApproverFailedBanner() {
  const insets = useSafeAreaInsets();
  const theme = useApprovalTheme('dark');
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: insets.top + spacing[2],
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
          borderColor: theme.deny,
          borderWidth: 1,
        }}
      >
        <Text style={[type.meta, { color: theme.textHi }]}>
          This device isn't set up for biometric approval — your approvals will be
          recorded at the lowest assurance level.
        </Text>
      </View>
    </View>
  );
}

/**
 * Shown when {@link ensureApproverDevice} deferred registration because there
 * was no login-minted grant available to use — either it was already taken
 * out of the Redux store (read-and-clear) by an earlier attempt this session,
 * or none was ever minted at all (a restored/cold-start session rather than a
 * fresh interactive login). This is informational, not an error — approvals
 * still work at L1 — so it uses the neutral/brand border rather than the
 * `deny` styling {@link ApproverFailedBanner} uses. A grant that WAS minted
 * but got consumed server-side (Redis) surfaces as `failed`/`http_403`
 * instead, not `deferred`.
 */
function ApproverDeferredBanner() {
  const insets = useSafeAreaInsets();
  const theme = useApprovalTheme('dark');
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: insets.top + spacing[2],
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
          borderColor: theme.border,
          borderWidth: 1,
        }}
      >
        <Text style={[type.bodyMd, { color: theme.textHi }]}>Finish approver setup</Text>
        <Text style={[type.meta, { color: theme.textHi, marginTop: spacing[1] }]}>
          Sign out and back in to let this phone approve requests with Face ID.
        </Text>
      </View>
    </View>
  );
}

function PushFailedBanner() {
  const insets = useSafeAreaInsets();
  const theme = useApprovalTheme('dark');
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: insets.top + spacing[2],
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
          borderColor: theme.deny,
          borderWidth: 1,
        }}
      >
        <Text style={[type.meta, { color: theme.textHi }]}>
          Push notifications failed to register — approvals won't reach this device.
        </Text>
      </View>
    </View>
  );
}
