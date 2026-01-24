import { configureStore } from '@reduxjs/toolkit';
import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux';

import authReducer from './authSlice';
import alertsReducer from './alertsSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    alerts: alertsReducer,
  },
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
export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

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
