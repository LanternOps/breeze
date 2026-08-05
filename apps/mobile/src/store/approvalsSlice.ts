import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  type ApprovalRequest,
  approveRequest as apiApprove,
  denyRequest as apiDeny,
  fetchApproval as apiFetchOne,
  fetchPendingApprovals as apiFetchPending,
  reportSuspicious as apiReportSuspicious,
} from '../services/approvals';
import { readCachedApprovals, writeCachedApprovals, clearCachedApproval } from '../services/approvalCache';
import { gatherApprovalProof } from '../services/approverDevice';

interface ApprovalsState {
  pending: ApprovalRequest[];
  focusId: string | null;
  loading: boolean;
  error: string | null;
  decisionInFlight: Record<string, 'approve' | 'deny' | undefined>;
  /**
   * True once `/pending` has answered at least once this session.
   *
   * Before that, an empty `pending` means "haven't asked yet", not "nothing is
   * awaiting a decision" — and the two are not interchangeable. The
   * notification sweep keys off this so a cold start cannot clear the banner
   * for a request that is in fact still live.
   */
  hasSynced: boolean;
}

const initialState: ApprovalsState = {
  pending: [],
  focusId: null,
  loading: false,
  error: null,
  decisionInFlight: {},
  hasSynced: false,
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
  // Breeze Authenticator (Phase 3) — opt-in hardware step-up. Best-effort: a
  // signed proof upgrades the recorded decision to L2 (mobile_hw_key); a device
  // without a registered key yields null and approves at L1 (Phase 3 never
  // blocks — enforcement is Phase 4). A cancelled biometric prompt DOES throw,
  // aborting the approve rather than silently downgrading a deliberate cancel.
  const proof = await gatherApprovalProof(id);
  const updated = await apiApprove(id, proof ? { proof } : undefined);
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

// Server-side: denies the row, revokes the requesting OAuth client, writes
// audit. Locally: removes the approval from `pending`, clears in-flight,
// rolls focus forward. Mirrors the deny.fulfilled reducer shape so the
// takeover screen unmounts cleanly.
export const reportSuspicious = createAsyncThunk(
  'approvals/reportSuspicious',
  async (id: string) => {
    await apiReportSuspicious(id);
    await clearCachedApproval(id);
    return { id };
  }
);

/**
 * Drop `id` from the queue and roll focus onto the next still-pending request.
 *
 * Every removal path must go through here. Filtering `pending` without moving
 * `focusId` strands the rest of the queue: the takeover selector requires
 * `focusId` to name a row whose status is still `'pending'`, so a `focusId`
 * left pointing at a removed/decided row renders "No pending approvals" while
 * real requests sit behind it (#3026).
 */
function dropAndRefocus(state: ApprovalsState, id: string): void {
  state.pending = state.pending.filter((a) => a.id !== id);
  if (state.focusId === id) {
    state.focusId = state.pending.find((a) => a.status === 'pending')?.id ?? null;
  }
}

/**
 * Decision-error codes that mean the request is settled server-side and will
 * never become actionable again. Surfaced by services/approvals.ts from the
 * 409/410 responses. On these the local row MUST go — leaving it pending is
 * what pinned the takeover screen open with a request the user could not
 * clear by any means (the classic "approved it in the browser, phone still
 * nags me" report).
 */
const TERMINAL_DECISION_ERRORS = new Set(['ALREADY_DECIDED', 'EXPIRED']);

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
      if (state.focusId === action.payload) {
        state.focusId = state.pending.find((a) => a.status === 'pending')?.id ?? null;
      }
    },
    /**
     * Wall-clock sweep over the WHOLE queue.
     *
     * ApprovalScreen only ever ran an expiry timer against the focused
     * request, so anything queued behind it aged past `expiresAt` and stayed
     * `pending` forever. Callers pass `now` explicitly so this stays
     * deterministic under test.
     */
    pruneExpired(state, action: PayloadAction<number>) {
      const now = action.payload;
      for (const a of state.pending) {
        if (a.status === 'pending' && new Date(a.expiresAt).getTime() <= now) {
          a.status = 'expired';
        }
      }
      if (state.focusId) {
        const focusStillPending = state.pending.some(
          (a) => a.id === state.focusId && a.status === 'pending'
        );
        if (!focusStillPending) {
          state.focusId = state.pending.find((a) => a.status === 'pending')?.id ?? null;
        }
      }
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
      s.hasSynced = true;
      s.pending = a.payload;
      // The server list is authoritative. A request decided elsewhere (browser,
      // another approver device, server-side expiry) simply stops appearing
      // here, so focus must be re-derived from the new list rather than left
      // pointing at a row that no longer exists.
      const focusStillPending = a.payload.some(
        (x) => x.id === s.focusId && x.status === 'pending'
      );
      if (!focusStillPending) {
        s.focusId = a.payload.find((x) => x.status === 'pending')?.id ?? null;
      }
    });
    b.addCase(refreshPending.rejected, (s, a) => {
      s.loading = false;
      s.error = a.error.message ?? 'Failed to load approvals';
    });

    b.addCase(fetchOne.fulfilled, (s, a) => {
      // A push can land for a request that was already decided in the browser
      // between dispatch and delivery. Re-adding it to `pending` leaves a dead
      // row in the queue (and in the on-device cache) forever, so settle it.
      if (a.payload.status !== 'pending') {
        dropAndRefocus(s, a.payload.id);
        return;
      }
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
      dropAndRefocus(s, a.payload.id);
    });
    b.addCase(approve.rejected, (s, a) => {
      delete s.decisionInFlight[a.meta.arg];
      if (TERMINAL_DECISION_ERRORS.has(a.error.message ?? '')) {
        dropAndRefocus(s, a.meta.arg);
        // ApprovalScreen already toasts "Already decided elsewhere." / "This
        // request expired." — no banner needed for an outcome the user caused.
        return;
      }
      s.error = a.error.message ?? 'Approve failed';
    });

    b.addCase(deny.pending, (s, a) => {
      s.decisionInFlight[a.meta.arg.id] = 'deny';
    });
    b.addCase(deny.fulfilled, (s, a) => {
      delete s.decisionInFlight[a.meta.arg.id];
      dropAndRefocus(s, a.payload.id);
    });
    b.addCase(deny.rejected, (s, a) => {
      delete s.decisionInFlight[a.meta.arg.id];
      if (TERMINAL_DECISION_ERRORS.has(a.error.message ?? '')) {
        dropAndRefocus(s, a.meta.arg.id);
        return;
      }
      s.error = a.error.message ?? 'Deny failed';
    });

    b.addCase(reportSuspicious.pending, (s, a) => {
      s.decisionInFlight[a.meta.arg] = 'deny';
    });
    b.addCase(reportSuspicious.fulfilled, (s, a) => {
      delete s.decisionInFlight[a.meta.arg];
      dropAndRefocus(s, a.payload.id);
    });
    b.addCase(reportSuspicious.rejected, (s, a) => {
      delete s.decisionInFlight[a.meta.arg];
      s.error = a.error.message ?? 'Report failed';
    });
  },
});

export const { setFocus, markExpired, pruneExpired, upsert, clearApprovalsError } = slice.actions;
export default slice.reducer;
