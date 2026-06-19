import { configureStore, combineReducers } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';

import authReducer from './authSlice';
import alertsReducer from './alertsSlice';
import approvalsReducer from './approvalsSlice';
import aiChatReducer from './aiChatSlice';
import lifecycleReducer from './lifecycleSlice';
import { withLogoutReset } from './resettable';

const appReducer = combineReducers({
  auth: authReducer,
  alerts: alertsReducer,
  approvals: approvalsReducer,
  aiChat: aiChatReducer,
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
