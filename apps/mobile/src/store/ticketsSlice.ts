import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';

import {
  getTickets,
  type ListTicketsParams,
  type TicketAssigneeFilter,
  type TicketSummary,
} from '../services/tickets';

export type TicketQueueFilter = 'open' | 'closed';

interface TicketsState {
  tickets: TicketSummary[];
  total: number;
  isLoading: boolean;
  error: string | null;
  queue: TicketQueueFilter;
  assignee: TicketAssigneeFilter;
  lastFetched: string | null;
  /**
   * requestId of the most recently STARTED fetch. Only that request may write
   * results or errors: two fetches with identical filters can still land out of
   * order, and a filter check alone cannot tell them apart.
   */
  currentRequestId: string | null;
}

const initialState: TicketsState = {
  tickets: [],
  total: 0,
  isLoading: false,
  error: null,
  queue: 'open',
  assignee: 'me',
  lastFetched: null,
  currentRequestId: null,
};

export const fetchTickets = createAsyncThunk(
  'tickets/fetchTickets',
  async (params: ListTicketsParams, { rejectWithValue }) => {
    try {
      const page = await getTickets(params);
      // Echo the filters back so the reducer can drop a response that lost the
      // race: switching queue/assignee fires a new request while the previous
      // one is in flight, and the slower one must not overwrite the newer.
      return { page, params };
    } catch (error: unknown) {
      const apiError = error as { message?: string };
      return rejectWithValue(apiError.message || 'Failed to load tickets');
    }
  }
);

/** True when a response was produced by the filters currently selected. */
function matchesCurrentFilters(state: TicketsState, params: ListTicketsParams): boolean {
  const forQueue = params.statusGroup ?? state.queue;
  const forAssignee = params.assignee ?? state.assignee;
  return forQueue === state.queue && forAssignee === state.assignee;
}

/** True when this action belongs to the newest in-flight fetch. */
function isCurrentRequest(state: TicketsState, requestId: string | undefined): boolean {
  return state.currentRequestId === requestId;
}

const ticketsSlice = createSlice({
  name: 'tickets',
  initialState,
  reducers: {
    setQueue: (state, action: PayloadAction<TicketQueueFilter>) => {
      state.queue = action.payload;
    },
    setAssignee: (state, action: PayloadAction<TicketAssigneeFilter>) => {
      state.assignee = action.payload;
    },
    clearError: (state) => {
      state.error = null;
    },
    /**
     * Reconcile the cached row with what the detail screen just READ. Updates in
     * place only: a passive refresh must never delete a row or move the total,
     * because merely opening a ticket somebody else resolved would then make it
     * vanish from the queue behind the user with no explanation.
     */
    syncTicketFromDetail: (
      state,
      action: PayloadAction<{
        id: string;
        status: TicketSummary['status'];
        statusName?: string | null;
        statusColor?: string | null;
      }>
    ) => {
      const index = state.tickets.findIndex((t) => t.id === action.payload.id);
      if (index === -1) return;
      state.tickets[index].status = action.payload.status;
      state.tickets[index].statusName = action.payload.statusName ?? null;
      state.tickets[index].statusColor = action.payload.statusColor ?? null;
    },
    /**
     * Fold a status change the USER just made back into the cached list. A
     * ticket that no longer belongs in the visible queue is dropped, which is
     * why this is reserved for deliberate actions — see `syncTicketFromDetail`
     * for the passive read path, which must not delete rows.
     */
    applyStatusChange: (
      state,
      action: PayloadAction<{
        id: string;
        status: TicketSummary['status'];
        statusName?: string | null;
        statusColor?: string | null;
      }>
    ) => {
      const index = state.tickets.findIndex((t) => t.id === action.payload.id);
      if (index === -1) return;
      const isClosed = action.payload.status === 'resolved' || action.payload.status === 'closed';
      const belongsInQueue = state.queue === 'closed' ? isClosed : !isClosed;
      if (belongsInQueue) {
        state.tickets[index].status = action.payload.status;
        // Drop the tenant's custom label: `statusLabel` prefers `statusName`,
        // so keeping the old one shows e.g. "Investigating" on a ticket that
        // has moved to pending. Null falls back to the canonical label until
        // the next list fetch supplies the new custom name.
        state.tickets[index].statusName = action.payload.statusName ?? null;
        state.tickets[index].statusColor = action.payload.statusColor ?? null;
      } else {
        state.tickets.splice(index, 1);
        state.total = Math.max(0, state.total - 1);
      }
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchTickets.pending, (state, action) => {
        state.currentRequestId = action.meta.requestId;
        state.isLoading = true;
        state.error = null;
      })
      .addCase(fetchTickets.fulfilled, (state, action) => {
        // An older request must not touch anything.
        if (!isCurrentRequest(state, action.meta.requestId)) return;
        // The newest request has finished, so the spinner is owned by nobody
        // else — clear it even when the payload is discarded below. Gating this
        // on the filter check too would strand isLoading=true whenever filters
        // changed before the in-flight response landed and no replacement
        // request had started yet.
        state.isLoading = false;
        if (!matchesCurrentFilters(state, action.payload.params)) {
          // Right request, filters the user has since moved off: drop the data
          // rather than rendering the previous queue.
          return;
        }
        state.tickets = action.payload.page.tickets;
        state.total = action.payload.page.total;
        state.lastFetched = new Date().toISOString();
        state.error = null;
      })
      .addCase(fetchTickets.rejected, (state, action) => {
        // An abandoned request must not surface an error over a newer view, nor
        // clear the spinner while the current request is still running.
        if (!isCurrentRequest(state, action.meta.requestId)) return;
        state.isLoading = false;
        state.error = action.payload as string;
      });
  },
});

export const { setQueue, setAssignee, clearError, applyStatusChange, syncTicketFromDetail } =
  ticketsSlice.actions;

export default ticketsSlice.reducer;

// Selectors
export const selectTickets = (state: { tickets: TicketsState }) => state.tickets.tickets;
export const selectTicketsLoading = (state: { tickets: TicketsState }) => state.tickets.isLoading;
export const selectTicketsError = (state: { tickets: TicketsState }) => state.tickets.error;
export const selectTicketQueue = (state: { tickets: TicketsState }) => state.tickets.queue;
export const selectTicketAssignee = (state: { tickets: TicketsState }) => state.tickets.assignee;
export const selectTicketTotal = (state: { tickets: TicketsState }) => state.tickets.total;
