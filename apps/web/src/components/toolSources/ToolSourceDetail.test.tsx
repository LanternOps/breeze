/**
 * Tool catalog W01 PR C (#5216) — the detail page's lifecycle actions.
 *
 * The one behaviour that cannot be inferred from the components below it:
 * discovery is an async BullMQ job, so queuing it and stopping there would
 * leave a stale tool list under a button that looks like it worked. The page
 * polls the source row until `lastDiscoveredAt` moves, bounded.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const api = vi.hoisted(() => ({
  getToolSource: vi.fn(),
  listSourceTools: vi.fn(),
  discoverToolSource: vi.fn(),
  deleteToolSource: vi.fn(),
  patchSourceTool: vi.fn(),
  bulkTools: vi.fn(),
  testSourceTool: vi.fn(),
  createToolSource: vi.fn(),
  updateToolSource: vi.fn(),
}));
vi.mock('./api', () => api);
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: { user: { canManagePartnerWide: boolean } }) => unknown) =>
    selector({ user: { canManagePartnerWide: true } }),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null }) => unknown) => selector({ currentOrgId: 'org-1' }),
}));
vi.mock('../../hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({ isPartnerScope: true, defaultOwnerScope: 'partner' }),
}));

import { showToast } from '../shared/Toast';
import ToolSourceDetail from './ToolSourceDetail';

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    orgId: null,
    partnerId: 'p-1',
    slug: 'hudu',
    name: 'Hudu',
    kind: 'mcp',
    endpointUrl: 'https://hudu.example.test/mcp',
    credentialOrigin: 'https://hudu.example.test',
    authKind: 'bearer',
    hasCredential: true,
    status: 'active',
    lastDiscoveredAt: '2026-10-16T00:00:00.000Z',
    lastError: null,
    rateLimitPerMinute: 120,
    toolCount: 1,
    enabledToolCount: 0,
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getToolSource.mockResolvedValue(source());
  api.listSourceTools.mockResolvedValue([]);
  api.discoverToolSource.mockResolvedValue(undefined);
  api.deleteToolSource.mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());

describe('ToolSourceDetail', () => {
  it('warns without polling when re-discovery was not queued', async () => {
    api.discoverToolSource.mockResolvedValueOnce({ warning: 'discovery_not_queued' });
    render(<ToolSourceDetail sourceId="s-1" />);
    await screen.findByTestId('tool-source-detail');
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('tool-source-rediscover'));
    await vi.advanceTimersByTimeAsync(0);
    expect(showToast).toHaveBeenCalledExactlyOnceWith({
      type: 'warning', message: 'Tool source saved, but discovery could not be queued. Try re-discovering tools.',
    });
    await vi.advanceTimersByTimeAsync(61000);
    expect(api.getToolSource).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId('tool-source-rediscover') as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders the source facts and its partner-wide badge', async () => {
    render(<ToolSourceDetail sourceId="s-1" />);
    await screen.findByTestId('tool-source-detail');
    expect(screen.getByTestId('scope-badge')).toBeTruthy();
    expect(screen.getByTestId('tool-source-status-active')).toBeTruthy();
  });

  it('surfaces the discovery failure reason when the source is in error', async () => {
    api.getToolSource.mockResolvedValue(source({ status: 'error', lastError: 'connect ECONNREFUSED' }));
    render(<ToolSourceDetail sourceId="s-1" />);
    expect((await screen.findByTestId('tool-source-last-error')).textContent).toContain('ECONNREFUSED');
  });

  it('re-discover queues the job and then POLLS until lastDiscoveredAt moves', async () => {
    // fireEvent + manual timer advances, not userEvent: userEvent's own
    // waiting interacts badly with fake timers here, and the thing under test
    // IS the timer loop.
    api.getToolSource
      .mockResolvedValueOnce(source())
      .mockResolvedValueOnce(source())
      .mockResolvedValue(source({ lastDiscoveredAt: '2026-10-16T02:00:00.000Z' }));

    render(<ToolSourceDetail sourceId="s-1" />);
    await screen.findByTestId('tool-source-detail');

    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('tool-source-rediscover'));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.discoverToolSource).toHaveBeenCalledWith(expect.anything(), 's-1');

    const callsAfterQueue = api.getToolSource.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3100);
    await vi.advanceTimersByTimeAsync(3100);
    // It kept asking rather than leaving a stale list under a button that
    // looked like it worked.
    expect(api.getToolSource.mock.calls.length).toBeGreaterThan(callsAfterQueue);
    // …and it STOPS once the timestamp moves (bounded, not a forever-spin).
    const callsAfterMove = api.getToolSource.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9300);
    expect(api.getToolSource.mock.calls.length).toBe(callsAfterMove);
  });

  it('stops polling when the page is unmounted mid-loop', async () => {
    api.getToolSource.mockResolvedValue(source()); // never moves
    const { unmount } = render(<ToolSourceDetail sourceId="s-1" />);
    await screen.findByTestId('tool-source-detail');

    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('tool-source-rediscover'));
    await vi.advanceTimersByTimeAsync(3100);
    const callsBeforeUnmount = api.getToolSource.mock.calls.length;

    unmount();
    await vi.advanceTimersByTimeAsync(12000);

    expect(api.getToolSource.mock.calls.length).toBe(callsBeforeUnmount);
  });

  it('delete asks for confirmation first, and only then calls the API', async () => {
    const user = userEvent.setup();
    render(<ToolSourceDetail sourceId="s-1" />);
    await screen.findByTestId('tool-source-detail');

    await user.click(screen.getByTestId('tool-source-delete'));
    expect(api.deleteToolSource).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('tool-source-delete-confirm'));
    await waitFor(() => expect(api.deleteToolSource).toHaveBeenCalledWith(expect.anything(), 's-1'));
  });

  it('shows a load failure instead of an empty page', async () => {
    api.getToolSource.mockRejectedValue(new Error('boom'));
    render(<ToolSourceDetail sourceId="s-1" />);
    expect(await screen.findByTestId('tool-source-detail-error')).toBeTruthy();
  });
});
