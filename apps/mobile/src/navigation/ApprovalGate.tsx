import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { fetchOne, refreshPending, setFocus, hydrateFromCache } from '../store/approvalsSlice';
import {
  addNotificationReceivedListener,
  addNotificationResponseReceivedListener,
  parseApprovalNotification,
  removeNotificationSubscription,
} from '../services/notifications';
import { ApprovalScreen } from '../screens/approvals/ApprovalScreen';

interface Props {
  children: React.ReactNode;
}

// Renders ApprovalScreen as a global takeover whenever there is a focused
// pending approval. Otherwise renders the regular nav tree.
export function ApprovalGate({ children }: Props) {
  const dispatch = useAppDispatch();
  const focused = useAppSelector((s) =>
    s.approvals.pending.find((a) => a.id === s.approvals.focusId && a.status === 'pending')
  );

  useEffect(() => {
    dispatch(hydrateFromCache());
    dispatch(refreshPending());

    const recv = addNotificationReceivedListener((n) => {
      const parsed = parseApprovalNotification(n);
      if (parsed) {
        dispatch(fetchOne(parsed.approvalId));
        dispatch(setFocus(parsed.approvalId));
      }
    });
    const tap = addNotificationResponseReceivedListener((r) => {
      const parsed = parseApprovalNotification(r.notification);
      if (parsed) {
        dispatch(fetchOne(parsed.approvalId));
        dispatch(setFocus(parsed.approvalId));
      }
    });

    return () => {
      removeNotificationSubscription(recv);
      removeNotificationSubscription(tap);
    };
  }, []);

  if (focused) {
    return <ApprovalScreen />;
  }
  return <>{children}</>;
}
