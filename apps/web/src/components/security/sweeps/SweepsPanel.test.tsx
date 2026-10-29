import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { SweepSummary } from '@breeze/shared';

const { fetchWithAuth, showToast } = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), showToast: vi.fn() }));

vi.mock('@/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/auth')>()),
  fetchWithAuth,
}));
vi.mock('../../shared/Toast', () => ({ showToast }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../filters/DeviceTargetSelector', () => ({ DeviceTargetSelector: () => null }));

import SweepsPanel from './SweepsPanel';

const json = (status: number, payload: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 403 ? 'Forbidden' : String(status),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

const progress = (over: Record<string, number> = {}) => ({
  queued: 0, running: 0, completed: 0, timedOut: 0, failed: 0, cancelled: 0, expired: 0, degraded: 0, threatsFound: 0,
  ...over,
});

function sweep(over: Partial<SweepSummary> = {}): SweepSummary {
  return {
    id: 'sw-1',
    groupId: 'grp-1',
    orgId: 'org-1',
    orgName: 'Acme',
    ruleSets: [{ id: 'set-1', name: 'EICAR set', version: 1 }],
    scanType: 'quick',
    state: 'active',
    targeted: 10,
    skipped: { agent_too_old: 2 },
    progress: progress({ queued: 6, completed: 4, threatsFound: 1 }),
    origin: 'web',
    createdBy: { id: 'u1', name: 'Pat Admin' },
    createdAt: '2026-10-24T10:00:00.000Z',
    expiresAt: '2026-10-25T10:00:00.000Z',
    completedAt: null,
    ...over,
  };
}

let listRows: SweepSummary[];
let groupRows: SweepSummary[];
let publishedVersions: Record<string, number>;
let cancelResponse: Response;

function route() {
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST' && u.endsWith('/cancel')) return cancelResponse;
    if (u.startsWith('/security/sweeps/groups/')) {
      return json(200, { data: { groupId: 'grp-1', sweeps: groupRows, targeted: 10, progress: progress() } });
    }
    if (u.startsWith('/security/sweeps')) {
      return json(200, { data: listRows, pagination: { page: 1, limit: 50, total: listRows.length } });
    }
    if (u === '/security/yara/rule-sets') {
      return json(200, {
        data: Object.entries(publishedVersions).map(([id, publishedVersion]) => ({ id, publishedVersion, name: id })),
      });
    }
    return json(200, { data: [] });
  });
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

const renderPanel = async (group: string | null = null, onSelectGroup = vi.fn()) => {
  const view = render(<SweepsPanel group={group} onSelectGroup={onSelectGroup} />);
  await settle();
  return { ...view, onSelectGroup };
};

describe('SweepsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listRows = [sweep()];
    groupRows = [sweep()];
    publishedVersions = { 'set-1': 1 };
    cancelResponse = json(200, {
      data: { sweeps: [], cancelledQueued: 6, cancelledUndelivered: 0, stillRunning: 2 },
    });
    route();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists sweeps with sets and versions, progress, threats, creator and state', async () => {
    await renderPanel();
    const row = screen.getByTestId('sweep-row-sw-1');
    expect(row.textContent).toContain('EICAR set');
    expect(row.textContent).toContain('Version 1');
    expect(row.textContent).toContain('Pat Admin');
    expect(screen.getByTestId('sweep-state-sw-1').textContent).toBe('Active');
    expect(screen.getByTestId('sweep-progress-sw-1').getAttribute('aria-valuenow')).toBe('40');
    expect(screen.queryByTestId('sweep-rules-changed-sw-1')).toBeNull();
  });

  it('an active sweep shows running devices beside queued ones (#10078)', async () => {
    listRows = [sweep({ targeted: 2, progress: progress({ queued: 1, running: 1 }) })];
    await renderPanel();
    const cell = screen.getByTestId('sweep-progress-sw-1');
    expect(cell.textContent).toContain('0 of 2 devices finished');
    expect(cell.textContent).toContain('Queued: 1');
    expect(cell.textContent).toContain('Running: 1');
  });

  it('a cancelled sweep reads as cancelled, not "100% … devices done" (#10078)', async () => {
    listRows = [sweep({ state: 'cancelled', targeted: 2, progress: progress({ completed: 1, cancelled: 1 }) })];
    await renderPanel();
    const cell = screen.getByTestId('sweep-progress-sw-1');
    expect(cell.getAttribute('aria-valuenow')).toBe('100');
    expect(cell.textContent).toContain('2 of 2 devices finished · 1 completed · 1 cancelled');
    expect(cell.textContent).not.toMatch(/100%|done/);
    expect(cell.textContent).not.toContain('Running');
  });

  it('shows an empty state', async () => {
    listRows = [];
    await renderPanel();
    expect(screen.getByTestId('sweeps-empty')).toBeInTheDocument();
  });

  it('renders — for skipped when the caller is restricted (empty skipped), never zeros', async () => {
    listRows = [sweep({ skipped: {} })];
    await renderPanel();
    const row = screen.getByTestId('sweep-row-sw-1');
    const cells = row.querySelectorAll('td');
    expect(cells[3].textContent).toBe('—');
  });

  it('cancel goes through runAction, toasts the still-running count and refreshes the list', async () => {
    await renderPanel();
    listRows = [sweep({ state: 'cancelled', progress: progress({ cancelled: 6, completed: 4 }) })];
    fireEvent.click(screen.getByTestId('sweep-cancel-sw-1'));
    await settle();

    const post = fetchWithAuth.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(post?.[0]).toBe('/security/sweeps/sw-1/cancel');
    const toast = showToast.mock.calls.find(([t]) => t.type === 'success');
    expect(toast?.[0].message).toMatch(/6/);
    expect(toast?.[0].message).toMatch(/2/);
    expect(screen.getByTestId('sweep-state-sw-1').textContent).toBe('Cancelled');
    expect(screen.queryByTestId('sweep-cancel-sw-1')).toBeNull();
  });

  it('a failed cancel leaves the row unchanged', async () => {
    cancelResponse = json(403, { error: 'Permission denied' });
    await renderPanel();
    fireEvent.click(screen.getByTestId('sweep-cancel-sw-1'));
    await settle();
    expect(screen.getByTestId('sweep-state-sw-1').textContent).toBe('Active');
    expect(showToast.mock.calls.some(([t]) => t.type === 'error')).toBe(true);
  });

  it('offers a re-sweep when a pinned set was republished, and opens the dialog with the set', async () => {
    publishedVersions = { 'set-1': 2 };
    await renderPanel();
    expect(screen.getByTestId('sweep-rules-changed-sw-1').textContent).toMatch(/rules changed/i);
    fireEvent.click(screen.getByTestId('sweep-resweep-sw-1'));
    expect(screen.getByTestId('sweep-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('sweep-dialog-rescope-note')).toBeInTheDocument();
    expect(screen.getByTestId('sweep-dialog').textContent).toContain('EICAR set');
  });

  it('reads the current versions once per list, not once per row', async () => {
    listRows = [sweep(), sweep({ id: 'sw-2' }), sweep({ id: 'sw-3' })];
    await renderPanel();
    const reads = fetchWithAuth.mock.calls.filter(([u]) => u === '/security/yara/rule-sets');
    expect(reads).toHaveLength(1);
  });

  it('a finished clean sweep with a republished set shows the hint but no re-sweep action', async () => {
    publishedVersions = { 'set-1': 3 };
    listRows = [sweep({ state: 'completed', progress: progress({ completed: 10 }) })];
    await renderPanel();
    expect(screen.getByTestId('sweep-rules-changed-sw-1')).toBeInTheDocument();
    expect(screen.queryByTestId('sweep-resweep-sw-1')).toBeNull();
  });

  it('a finished sweep with failed children still offers the re-sweep', async () => {
    publishedVersions = { 'set-1': 3 };
    listRows = [sweep({ state: 'completed', progress: progress({ completed: 6, failed: 4 }) })];
    await renderPanel();
    expect(screen.getByTestId('sweep-resweep-sw-1')).toBeInTheDocument();
  });

  it('shows the group detail with Cancel all, which cancels the group and refreshes', async () => {
    groupRows = [sweep(), sweep({ id: 'sw-2', orgId: 'org-2', orgName: 'Globex' })];
    await renderPanel('grp-1');
    expect(screen.getByTestId('sweep-group-detail')).toBeInTheDocument();
    expect(screen.getByTestId('sweep-row-sw-2').textContent).toContain('Globex');
    fireEvent.click(screen.getByTestId('sweep-group-cancel-all'));
    await settle();
    const post = fetchWithAuth.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(post?.[0]).toBe('/security/sweeps/groups/grp-1/cancel');
  });

  it('the group back button clears the selection', async () => {
    const { onSelectGroup } = await renderPanel('grp-1');
    fireEvent.click(screen.getByTestId('sweep-group-back'));
    expect(onSelectGroup).toHaveBeenCalledWith(null);
  });

  it('a row opens its group from the list', async () => {
    const { onSelectGroup } = await renderPanel();
    fireEvent.click(screen.getByTestId('sweep-open-group-sw-1'));
    expect(onSelectGroup).toHaveBeenCalledWith('grp-1');
  });

  it('a 403 renders AccessDenied with no retry', async () => {
    fetchWithAuth.mockImplementation(async () => json(403, { error: 'forbidden' }));
    await renderPanel();
    expect(screen.getByTestId('sweeps-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('sweeps-retry')).toBeNull();
  });

  it('a transient failure renders an error with retry', async () => {
    fetchWithAuth.mockImplementation(async () => json(500, { error: 'boom' }));
    await renderPanel();
    expect(screen.getByTestId('sweeps-retry')).toBeInTheDocument();
  });

  it('polls every 10 s while a visible sweep is active, and stops when none is', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderPanel();
    const lists = () => fetchWithAuth.mock.calls.filter(([u]) => String(u).startsWith('/security/sweeps?')).length;
    expect(lists()).toBe(1);
    listRows = [sweep({ state: 'completed', progress: progress({ completed: 10 }) })];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(lists()).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(lists()).toBe(2);
  });
});
