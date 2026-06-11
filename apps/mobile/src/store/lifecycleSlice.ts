import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';

import {
  listMobileDevices,
  blockMobileDevice,
  type PairedMobileDevice,
} from '../services/mobileDevices';
import {
  listConnectedApps,
  revokeConnectedApp,
  type ConnectedApp,
} from '../services/connectedApps';
import { track } from '../lib/analytics';

interface LifecycleState {
  devices: PairedMobileDevice[];
  apps: ConnectedApp[];
  devicesLoading: boolean;
  appsLoading: boolean;
  devicesError: string | null;
  appsError: string | null;
  pendingDeviceId: string | null;
  pendingAppId: string | null;
}

const initialState: LifecycleState = {
  devices: [],
  apps: [],
  devicesLoading: false,
  appsLoading: false,
  devicesError: null,
  appsError: null,
  pendingDeviceId: null,
  pendingAppId: null,
};

export const fetchPairedDevices = createAsyncThunk<PairedMobileDevice[], void, { rejectValue: string }>(
  'lifecycle/fetchPairedDevices',
  async (_, { rejectWithValue }) => {
    try {
      return await listMobileDevices();
    } catch (err) {
      const e = err as { message?: string };
      return rejectWithValue(e.message ?? 'Failed to load devices');
    }
  }
);

export const blockPairedDevice = createAsyncThunk<
  string,
  { id: string; reason?: string },
  { rejectValue: string }
>('lifecycle/blockPairedDevice', async ({ id, reason }, { rejectWithValue }) => {
  try {
    await blockMobileDevice(id, reason);
    return id;
  } catch (err) {
    const e = err as { message?: string };
    return rejectWithValue(e.message ?? 'Failed to revoke device');
  }
});

export const fetchConnectedApps = createAsyncThunk<ConnectedApp[], void, { rejectValue: string }>(
  'lifecycle/fetchConnectedApps',
  async (_, { rejectWithValue }) => {
    try {
      return await listConnectedApps();
    } catch (err) {
      const e = err as { message?: string };
      return rejectWithValue(e.message ?? 'Failed to load apps');
    }
  }
);

export const revokeConnectedAppAsync = createAsyncThunk<
  string,
  { clientId: string; reason?: string },
  { rejectValue: string }
>('lifecycle/revokeConnectedApp', async ({ clientId, reason }, { rejectWithValue }) => {
  try {
    await revokeConnectedApp(clientId, reason);
    return clientId;
  } catch (err) {
    const e = err as { message?: string };
    return rejectWithValue(e.message ?? 'Failed to revoke app');
  }
});

const lifecycleSlice = createSlice({
  name: 'lifecycle',
  initialState,
  reducers: {
    clearLifecycleErrors(state) {
      state.devicesError = null;
      state.appsError = null;
    },
    resetLifecycle(state) {
      state.devices = [];
      state.apps = [];
      state.devicesError = null;
      state.appsError = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchPairedDevices.pending, (state) => {
        state.devicesLoading = true;
        state.devicesError = null;
      })
      .addCase(fetchPairedDevices.fulfilled, (state, action: PayloadAction<PairedMobileDevice[]>) => {
        state.devicesLoading = false;
        state.devices = action.payload;
      })
      .addCase(fetchPairedDevices.rejected, (state, action) => {
        state.devicesLoading = false;
        state.devicesError = action.payload ?? 'Failed to load devices';
      })
      .addCase(blockPairedDevice.pending, (state, action) => {
        state.pendingDeviceId = action.meta.arg.id;
      })
      .addCase(blockPairedDevice.fulfilled, (state, action: PayloadAction<string>) => {
        state.pendingDeviceId = null;
        const i = state.devices.findIndex((d) => d.id === action.payload);
        if (i !== -1) {
          const existing = state.devices[i];
          if (existing) {
            // was_current_device tells us whether the user revoked the
            // phone in their hand vs. another paired device. We don't
            // emit the device id or hostname.
            track('device_revoked', { was_current_device: existing.isCurrent === true });
            state.devices[i] = {
              ...existing,
              status: 'blocked',
              blockedAt: new Date().toISOString(),
            };
          }
        }
      })
      .addCase(blockPairedDevice.rejected, (state, action) => {
        state.pendingDeviceId = null;
        state.devicesError = action.payload ?? 'Failed to revoke device';
      })
      .addCase(fetchConnectedApps.pending, (state) => {
        state.appsLoading = true;
        state.appsError = null;
      })
      .addCase(fetchConnectedApps.fulfilled, (state, action: PayloadAction<ConnectedApp[]>) => {
        state.appsLoading = false;
        state.apps = action.payload;
      })
      .addCase(fetchConnectedApps.rejected, (state, action) => {
        state.appsLoading = false;
        state.appsError = action.payload ?? 'Failed to load apps';
      })
      .addCase(revokeConnectedAppAsync.pending, (state, action) => {
        state.pendingAppId = action.meta.arg.clientId;
      })
      .addCase(revokeConnectedAppAsync.fulfilled, (state, action: PayloadAction<string>) => {
        state.pendingAppId = null;
        const i = state.apps.findIndex((a) => a.clientId === action.payload);
        if (i !== -1) {
          const existing = state.apps[i];
          if (existing) {
            track('oauth_client_revoked');
            state.apps[i] = { ...existing, revokedAt: new Date().toISOString() };
          }
        }
      })
      .addCase(revokeConnectedAppAsync.rejected, (state, action) => {
        state.pendingAppId = null;
        state.appsError = action.payload ?? 'Failed to revoke app';
      });
  },
});

export const { clearLifecycleErrors, resetLifecycle } = lifecycleSlice.actions;
export default lifecycleSlice.reducer;

// ============================================================
// Selectors
// ============================================================

import type { RootState } from './index';

export const selectPairedDevices = (s: RootState) => s.lifecycle.devices;
export const selectActivePairedDevicesCount = (s: RootState) =>
  s.lifecycle.devices.filter((d) => d.status === 'active').length;
export const selectConnectedApps = (s: RootState) => s.lifecycle.apps;
export const selectActiveConnectedAppsCount = (s: RootState) =>
  s.lifecycle.apps.filter((a) => a.revokedAt === null).length;
