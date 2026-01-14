import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';

import { getAlerts, acknowledgeAlert as apiAcknowledgeAlert, Alert } from '../services/api';

type SeverityFilter = 'all' | 'critical' | 'high' | 'medium' | 'low';

interface AlertsState {
  alerts: Alert[];
  isLoading: boolean;
  error: string | null;
  filter: SeverityFilter;
  lastFetched: string | null;
}

const initialState: AlertsState = {
  alerts: [],
  isLoading: false,
  error: null,
  filter: 'all',
  lastFetched: null,
};

export const fetchAlerts = createAsyncThunk(
  'alerts/fetchAlerts',
  async (_, { rejectWithValue }) => {
    try {
      const alerts = await getAlerts();
      return alerts;
    } catch (error: unknown) {
      const apiError = error as { message?: string };
      return rejectWithValue(apiError.message || 'Failed to fetch alerts');
    }
  }
);

export const acknowledgeAlertAsync = createAsyncThunk(
  'alerts/acknowledge',
  async (alertId: string, { rejectWithValue }) => {
    try {
      const alert = await apiAcknowledgeAlert(alertId);
      return alert;
    } catch (error: unknown) {
      const apiError = error as { message?: string };
      return rejectWithValue(apiError.message || 'Failed to acknowledge alert');
    }
  }
);

const alertsSlice = createSlice({
  name: 'alerts',
  initialState,
  reducers: {
    setFilter: (state, action: PayloadAction<SeverityFilter>) => {
      state.filter = action.payload;
    },
    clearError: (state) => {
      state.error = null;
    },
    addAlert: (state, action: PayloadAction<Alert>) => {
      // Add new alert to the beginning of the list
      const existingIndex = state.alerts.findIndex((a) => a.id === action.payload.id);
      if (existingIndex === -1) {
        state.alerts.unshift(action.payload);
      } else {
        state.alerts[existingIndex] = action.payload;
      }
    },
    updateAlert: (state, action: PayloadAction<Alert>) => {
      const index = state.alerts.findIndex((a) => a.id === action.payload.id);
      if (index !== -1) {
        state.alerts[index] = action.payload;
      }
    },
    removeAlert: (state, action: PayloadAction<string>) => {
      state.alerts = state.alerts.filter((a) => a.id !== action.payload);
    },
    markAlertAsAcknowledged: (state, action: PayloadAction<string>) => {
      const index = state.alerts.findIndex((a) => a.id === action.payload);
      if (index !== -1) {
        state.alerts[index].acknowledged = true;
        state.alerts[index].acknowledgedAt = new Date().toISOString();
      }
    },
  },
  extraReducers: (builder) => {
    builder
      // Fetch alerts
      .addCase(fetchAlerts.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(fetchAlerts.fulfilled, (state, action) => {
        state.isLoading = false;
        state.alerts = action.payload;
        state.lastFetched = new Date().toISOString();
        state.error = null;
      })
      .addCase(fetchAlerts.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      })
      // Acknowledge alert
      .addCase(acknowledgeAlertAsync.pending, (state) => {
        state.error = null;
      })
      .addCase(acknowledgeAlertAsync.fulfilled, (state, action) => {
        const index = state.alerts.findIndex((a) => a.id === action.payload.id);
        if (index !== -1) {
          state.alerts[index] = action.payload;
        }
      })
      .addCase(acknowledgeAlertAsync.rejected, (state, action) => {
        state.error = action.payload as string;
      });
  },
});

export const {
  setFilter,
  clearError,
  addAlert,
  updateAlert,
  removeAlert,
  markAlertAsAcknowledged,
} = alertsSlice.actions;

export default alertsSlice.reducer;

// Selectors
export const selectAlerts = (state: { alerts: AlertsState }) => state.alerts.alerts;
export const selectAlertsLoading = (state: { alerts: AlertsState }) => state.alerts.isLoading;
export const selectAlertsError = (state: { alerts: AlertsState }) => state.alerts.error;
export const selectAlertsFilter = (state: { alerts: AlertsState }) => state.alerts.filter;

export const selectFilteredAlerts = (state: { alerts: AlertsState }) => {
  const { alerts, filter } = state.alerts;
  if (filter === 'all') {
    return alerts;
  }
  return alerts.filter((alert) => alert.severity === filter);
};

export const selectUnacknowledgedAlertsCount = (state: { alerts: AlertsState }) => {
  return state.alerts.alerts.filter((alert) => !alert.acknowledged).length;
};

export const selectCriticalAlertsCount = (state: { alerts: AlertsState }) => {
  return state.alerts.alerts.filter(
    (alert) => alert.severity === 'critical' && !alert.acknowledged
  ).length;
};
