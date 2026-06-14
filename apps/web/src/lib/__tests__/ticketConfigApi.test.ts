import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from '../../stores/auth';
import {
  fetchTicketConfig,
  invalidateTicketConfig,
  statusLabel,
  priorityLabel,
  activeStatusesByCore,
  __resetTicketConfigCacheForTests,
  type TicketConfig,
} from '../ticketConfigApi';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

// Helper to build a minimal valid API response body.
function makeApiResponse(overrides?: Partial<{ statuses: unknown[]; priorities: unknown }>) {
  return {
    data: {
      statuses: overrides?.statuses ?? [
        { id: 'sys-new', partnerId: 'p1', name: 'New', coreStatus: 'new', color: null, sortOrder: 0, isSystem: true, isActive: true, createdAt: '', updatedAt: '' },
        { id: 'sys-open', partnerId: 'p1', name: 'Open', coreStatus: 'open', color: '#00ff00', sortOrder: 1, isSystem: true, isActive: true, createdAt: '', updatedAt: '' },
        { id: 'custom-pending', partnerId: 'p1', name: 'Waiting', coreStatus: 'pending', color: '#ffcc00', sortOrder: 2, isSystem: false, isActive: true, createdAt: '', updatedAt: '' },
        { id: 'inactive-open', partnerId: 'p1', name: 'OldOpen', coreStatus: 'open', color: null, sortOrder: 10, isSystem: false, isActive: false, createdAt: '', updatedAt: '' },
        { id: 'sys-on-hold', partnerId: 'p1', name: 'On Hold', coreStatus: 'on_hold', color: null, sortOrder: 3, isSystem: true, isActive: true, createdAt: '', updatedAt: '' },
        { id: 'sys-resolved', partnerId: 'p1', name: 'Resolved', coreStatus: 'resolved', color: null, sortOrder: 4, isSystem: true, isActive: true, createdAt: '', updatedAt: '' },
        { id: 'sys-closed', partnerId: 'p1', name: 'Closed', coreStatus: 'closed', color: null, sortOrder: 5, isSystem: true, isActive: true, createdAt: '', updatedAt: '' },
      ],
      priorities: overrides?.priorities ?? {
        low: { label: 'Low', responseSlaMinutes: 120, resolutionSlaMinutes: 480 },
        normal: { label: null, responseSlaMinutes: 60, resolutionSlaMinutes: 240 },
        high: { label: 'High', responseSlaMinutes: 30, resolutionSlaMinutes: 120 },
        urgent: { label: 'Critical', responseSlaMinutes: 15, resolutionSlaMinutes: 60 },
      },
    },
  };
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  __resetTicketConfigCacheForTests();
  fetchWithAuthMock.mockReset();
});

// ─── Caching tests ────────────────────────────────────────────────────────────

describe('fetchTicketConfig — caching', () => {
  it('returns same promise to concurrent callers (single fetch)', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(makeApiResponse()));

    const [p1, p2] = await Promise.all([fetchTicketConfig(), fetchTicketConfig()]);
    // Same object reference — resolved from the same promise.
    expect(p1).toBe(p2);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('returns the cached result on a second sequential call (no refetch)', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(makeApiResponse()));

    const first = await fetchTicketConfig();
    const second = await fetchTicketConfig();
    expect(first).toBe(second);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('invalidateTicketConfig forces a refetch on the next call', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(makeApiResponse()));

    const first = await fetchTicketConfig();
    invalidateTicketConfig();

    const second = await fetchTicketConfig();
    // Was re-fetched.
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    // Both should be structurally equal (same API response).
    expect(second).toEqual(first);
  });
});

// ─── Failure handling tests ───────────────────────────────────────────────────

describe('fetchTicketConfig — failure handling', () => {
  it('returns null when the API responds !ok', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse({}, false, 500));

    const result = await fetchTicketConfig();
    expect(result).toBeNull();
  });

  it('returns null when fetchWithAuth throws (network error)', async () => {
    fetchWithAuthMock.mockRejectedValue(new Error('network down'));

    const result = await fetchTicketConfig();
    expect(result).toBeNull();
  });

  it('clears the cache after a null result so the next call retries', async () => {
    // First call fails.
    fetchWithAuthMock.mockRejectedValueOnce(new Error('down'));
    const first = await fetchTicketConfig();
    expect(first).toBeNull();

    // No invalidate needed — failed fetch must not cache.
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse(makeApiResponse()));
    const second = await fetchTicketConfig();
    expect(second).not.toBeNull();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });
});

// ─── Response shape tests ─────────────────────────────────────────────────────

describe('fetchTicketConfig — response shape', () => {
  it('maps API response to TicketConfig correctly', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(makeApiResponse()));

    const config = await fetchTicketConfig();
    expect(config).not.toBeNull();
    // Statuses are mapped
    expect(config!.statuses.length).toBeGreaterThan(0);
    const newRow = config!.statuses.find((s) => s.coreStatus === 'new');
    expect(newRow).toBeDefined();
    expect(newRow!.id).toBe('sys-new');
    expect(newRow!.isSystem).toBe(true);
    // Priorities are mapped
    expect(config!.priorities.low.label).toBe('Low');
    expect(config!.priorities.normal.label).toBeNull();
    expect(config!.priorities.urgent.label).toBe('Critical');
    expect(config!.priorities.high.responseSlaMinutes).toBe(30);
  });
});

// ─── statusLabel tests ────────────────────────────────────────────────────────

describe('statusLabel', () => {
  it('returns the system row name from config when available', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(makeApiResponse()));
    const config = await fetchTicketConfig();

    // 'new' system row is named 'New'
    expect(statusLabel(config, 'new')).toBe('New');
  });

  it('prefers explicit statusName over system row name', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(makeApiResponse()));
    const config = await fetchTicketConfig();

    expect(statusLabel(config, 'new', 'Custom Label')).toBe('Custom Label');
  });

  it('falls back to static statusConfig label when config is null', () => {
    expect(statusLabel(null, 'new')).toBe('New');
    expect(statusLabel(null, 'on_hold')).toBe('On hold');
    expect(statusLabel(null, 'resolved')).toBe('Resolved');
  });

  it('falls back to static statusConfig label when no system row exists for that coreStatus', async () => {
    // Config with no system row for 'resolved'.
    const response = makeApiResponse({
      statuses: [
        { id: 'sys-new', partnerId: 'p1', name: 'New', coreStatus: 'new', color: null, sortOrder: 0, isSystem: true, isActive: true, createdAt: '', updatedAt: '' },
      ],
    });
    fetchWithAuthMock.mockResolvedValue(jsonResponse(response));
    const config = await fetchTicketConfig();

    // Falls back to static config label for 'resolved'
    expect(statusLabel(config, 'resolved')).toBe('Resolved');
  });

  it('prefers statusName over config and static fallback', () => {
    expect(statusLabel(null, 'pending', 'Waiting on customer')).toBe('Waiting on customer');
  });
});

// ─── priorityLabel tests ──────────────────────────────────────────────────────

describe('priorityLabel', () => {
  it('returns config label when available and non-null', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(makeApiResponse()));
    const config = await fetchTicketConfig();

    expect(priorityLabel(config, 'urgent')).toBe('Critical');
    expect(priorityLabel(config, 'low')).toBe('Low');
  });

  it('falls back to static priorityConfig label when config label is null', async () => {
    // normal.label is null in makeApiResponse
    fetchWithAuthMock.mockResolvedValue(jsonResponse(makeApiResponse()));
    const config = await fetchTicketConfig();

    expect(priorityLabel(config, 'normal')).toBe('Normal');
  });

  it('falls back to static priorityConfig label when config is null', () => {
    expect(priorityLabel(null, 'urgent')).toBe('Urgent');
    expect(priorityLabel(null, 'high')).toBe('High');
    expect(priorityLabel(null, 'normal')).toBe('Normal');
    expect(priorityLabel(null, 'low')).toBe('Low');
  });
});

// ─── activeStatusesByCore tests ───────────────────────────────────────────────

describe('activeStatusesByCore', () => {
  it('groups active statuses by coreStatus in new→closed order', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(makeApiResponse()));
    const config = await fetchTicketConfig();

    const groups = activeStatusesByCore(config!);
    const coreOrder = groups.map((g) => g.coreStatus);
    expect(coreOrder).toEqual(['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']);
  });

  it('excludes inactive statuses', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(makeApiResponse()));
    const config = await fetchTicketConfig();

    const groups = activeStatusesByCore(config!);
    const openGroup = groups.find((g) => g.coreStatus === 'open');
    expect(openGroup).toBeDefined();
    // The inactive 'OldOpen' row should not appear.
    expect(openGroup!.statuses.every((s) => s.isActive)).toBe(true);
    expect(openGroup!.statuses.find((s) => s.id === 'inactive-open')).toBeUndefined();
  });

  it('returns all six core groups even when some have no active statuses', async () => {
    // Only 'new' has any statuses.
    const response = makeApiResponse({
      statuses: [
        { id: 'sys-new', partnerId: 'p1', name: 'New', coreStatus: 'new', color: null, sortOrder: 0, isSystem: true, isActive: true, createdAt: '', updatedAt: '' },
      ],
    });
    fetchWithAuthMock.mockResolvedValue(jsonResponse(response));
    const config = await fetchTicketConfig();

    const groups = activeStatusesByCore(config!);
    expect(groups).toHaveLength(6);
    expect(groups.find((g) => g.coreStatus === 'new')!.statuses).toHaveLength(1);
    expect(groups.find((g) => g.coreStatus === 'open')!.statuses).toHaveLength(0);
  });

  it('sorts statuses within a group by sortOrder', async () => {
    const response = makeApiResponse({
      statuses: [
        { id: 'open-b', partnerId: 'p1', name: 'OpenB', coreStatus: 'open', color: null, sortOrder: 5, isSystem: false, isActive: true, createdAt: '', updatedAt: '' },
        { id: 'open-a', partnerId: 'p1', name: 'OpenA', coreStatus: 'open', color: null, sortOrder: 1, isSystem: true, isActive: true, createdAt: '', updatedAt: '' },
      ],
    });
    fetchWithAuthMock.mockResolvedValue(jsonResponse(response));
    const config = await fetchTicketConfig();

    const groups = activeStatusesByCore(config!);
    const openGroup = groups.find((g) => g.coreStatus === 'open');
    expect(openGroup!.statuses[0].id).toBe('open-a');
    expect(openGroup!.statuses[1].id).toBe('open-b');
  });
});
