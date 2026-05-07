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
      {!error && pushRegistration === 'failed' ? <PushFailedBanner /> : null}
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
