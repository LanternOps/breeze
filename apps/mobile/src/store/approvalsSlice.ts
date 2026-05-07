import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  type ApprovalRequest,
  approveRequest as apiApprove,
  denyRequest as apiDeny,
  fetchApproval as apiFetchOne,
  fetchPendingApprovals as apiFetchPending,
} from '../services/approvals';
import { readCachedApprovals, writeCachedApprovals, clearCachedApproval } from '../services/approvalCache';

interface ApprovalsState {
  pending: ApprovalRequest[];
  focusId: string | null;
  loading: boolean;
  error: string | null;
  decisionInFlight: Record<string, 'approve' | 'deny' | undefined>;
}

const initialState: ApprovalsState = {
  pending: [],
  focusId: null,
  loading: false,
  error: null,
  decisionInFlight: {},
};

export const hydrateFromCache = createAsyncThunk('approvals/hydrate', async () => {
  return await readCachedApprovals();
});

export const refreshPending = createAsyncThunk('approvals/refresh', async () => {
  const list = await apiFetchPending();
  await writeCachedApprovals(list);
  return list;
});

export const fetchOne = createAsyncThunk('approvals/fetchOne', async (id: string) => {
  return await apiFetchOne(id);
});

export const approve = createAsyncThunk('approvals/approve', async (id: string) => {
  const updated = await apiApprove(id);
  await clearCachedApproval(id);
  return updated;
});

export const deny = createAsyncThunk(
  'approvals/deny',
  async (args: { id: string; reason?: string }) => {
    const updated = await apiDeny(args.id, args.reason);
    await clearCachedApproval(args.id);
    return updated;
  }
);

const slice = createSlice({
  name: 'approvals',
  initialState,
  reducers: {
    setFocus(state, action: PayloadAction<string | null>) {
      state.focusId = action.payload;
    },
    markExpired(state, action: PayloadAction<string>) {
      const i = state.pending.findIndex((a) => a.id === action.payload);
      if (i >= 0) state.pending[i].status = 'expired';
    },
    upsert(state, action: PayloadAction<ApprovalRequest>) {
      const i = state.pending.findIndex((a) => a.id === action.payload.id);
      if (i >= 0) state.pending[i] = action.payload;
      else state.pending.unshift(action.payload);
      if (!state.focusId) state.focusId = action.payload.id;
    },
    clearApprovalsError(state) {
      state.error = null;
    },
  },
  extraReducers: (b) => {
    b.addCase(hydrateFromCache.fulfilled, (s, a) => {
      // If a server refresh is already in flight or has populated pending,
      // don't let stale cache overwrite fresh data. Only seed an empty list.
      if (s.loading || s.pending.length > 0) return;
      s.pending = a.payload;
      if (a.payload.length > 0 && !s.focusId) s.focusId = a.payload[0].id;
    });

    b.addCase(refreshPending.pending, (s) => {
      s.loading = true;
      s.error = null;
    });
    b.addCase(refreshPending.fulfilled, (s, a) => {
      s.loading = false;
      s.pending = a.payload;
      if (a.payload.length > 0 && !s.focusId) s.focusId = a.payload[0].id;
      if (a.payload.length === 0) s.focusId = null;
    });
    b.addCase(refreshPending.rejected, (s, a) => {
      s.loading = false;
      s.error = a.error.message ?? 'Failed to load approvals';
    });

    b.addCase(fetchOne.fulfilled, (s, a) => {
      const i = s.pending.findIndex((x) => x.id === a.payload.id);
      if (i >= 0) s.pending[i] = a.payload;
      else s.pending.unshift(a.payload);
    });
    b.addCase(fetchOne.rejected, (s, a) => {
      const requestedId = a.meta.arg;
      if (s.focusId === requestedId) s.focusId = null;
      const msg = a.error.message;
      if (msg === 'NOT_FOUND') {
        s.error = 'That approval is no longer available.';
      } else {
        s.error = msg ?? "Couldn't load approval. Try again.";
      }
    });

    b.addCase(approve.pending, (s, a) => {
      s.decisionInFlight[a.meta.arg] = 'approve';
    });
    b.addCase(approve.fulfilled, (s, a) => {
      delete s.decisionInFlight[a.meta.arg];
      s.pending = s.pending.filter((x) => x.id !== a.payload.id);
      if (s.focusId === a.payload.id) s.focusId = s.pending[0]?.id ?? null;
    });
    b.addCase(approve.rejected, (s, a) => {
      delete s.decisionInFlight[a.meta.arg];
      s.error = a.error.message ?? 'Approve failed';
    });

    b.addCase(deny.pending, (s, a) => {
      s.decisionInFlight[a.meta.arg.id] = 'deny';
    });
    b.addCase(deny.fulfilled, (s, a) => {
      delete s.decisionInFlight[a.meta.arg.id];
      s.pending = s.pending.filter((x) => x.id !== a.payload.id);
      if (s.focusId === a.payload.id) s.focusId = s.pending[0]?.id ?? null;
    });
    b.addCase(deny.rejected, (s, a) => {
      delete s.decisionInFlight[a.meta.arg.id];
      s.error = a.error.message ?? 'Deny failed';
    });
  },
});

export const { setFocus, markExpired, upsert, clearApprovalsError } = slice.actions;
export default slice.reducer;
