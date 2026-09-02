import { configureStore, combineReducers } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';

import authReducer from './authSlice';
import alertsReducer from './alertsSlice';
import approvalsReducer from './approvalsSlice';
import aiChatReducer from './aiChatSlice';
import ticketsReducer from './ticketsSlice';
import timeReducer from './timeSlice';
import timeSuggestionsReducer from './timeSuggestionsSlice';
import notificationPrefsReducer from './notificationPrefsSlice';
import lifecycleReducer from './lifecycleSlice';
import { withLogoutReset } from './resettable';
import { loadServerClock } from '../services/serverClock';

const appReducer = combineReducers({
  auth: authReducer,
  alerts: alertsReducer,
  approvals: approvalsReducer,
  aiChat: aiChatReducer,
  tickets: ticketsReducer,
  time: timeReducer,
  timeSuggestions: timeSuggestionsReducer,
  notificationPrefs: notificationPrefsReducer,
  lifecycle: lifecycleReducer,
});

// Wipe every slice on sign-out so no prior server/account data leaks into the
// next session (chat history, alerts, pending approvals). See ./resettable.
const rootReducer = withLogoutReset(appReducer);

export const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        // Ignore these action types for serializable check
        ignoredActions: ['auth/setCredentials'],
      },
    }),
});

// Hydrate the server-clock anchor persisted by a previous launch, so the first
// offline time entry of a session is already corrected for a device clock that
// drifted (services/serverClock.ts). Fire-and-forget: it never throws, and an
// un-hydrated anchor only means the first API response re-establishes it.
void loadServerClock();

// Infer the `RootState` and `AppDispatch` types from the store itself
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// Use throughout your app instead of plain `useDispatch` and `useSelector`
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();

// Re-export actions and selectors for convenience
// Note: Both slices export clearError, so we need to be explicit
export {
  loginAsync,
  logoutAsync,
  setCredentials,
  logout,
  clearError as clearAuthError,
  setLoading,
} from './authSlice';

export {
  fetchAlerts,
  acknowledgeAlertAsync,
  setFilter,
  clearError as clearAlertsError,
  addAlert,
  updateAlert,
  removeAlert,
  markAlertAsAcknowledged,
  selectAlerts,
  selectAlertsLoading,
  selectAlertsError,
  selectAlertsFilter,
  selectFilteredAlerts,
  selectUnacknowledgedAlertsCount,
  selectCriticalAlertsCount,
} from './alertsSlice';

export {
  fetchTickets,
  setQueue,
  setAssignee,
  applyStatusChange,
  syncTicketFromDetail,
  clearError as clearTicketsError,
  selectTickets,
  selectTicketsLoading,
  selectTicketsError,
  selectTicketQueue,
  selectTicketAssignee,
  selectTicketTotal,
} from './ticketsSlice';

export {
  loadTicketPushPrefs,
  saveTicketPushPrefs,
  clearError as clearNotificationPrefsError,
  selectTicketPushPrefs,
  selectTicketPushPrefsSaving,
  selectTicketPushPrefsError,
  selectTicketPushPrefsErrorKind,
} from './notificationPrefsSlice';

export {
  runningTimerAdopted,
  startedTimer,
  stoppedTimer,
  pendingWritesChanged,
  needsAttentionChanged,
  timeErrorRaised,
  timeAccessDenied,
  elapsedSeconds,
} from './timeSlice';
