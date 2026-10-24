import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listWispConcerns: vi.fn(),
  snoozeWispConcern: vi.fn(),
  dismissWispConcern: vi.fn(),
  resolveWispConcern: vi.fn(),
  feedbackWispConcern: vi.fn(),
}));
vi.mock('../../lib/wispConcernsApi', () => api);
const showToast = vi.fn();
vi.mock('@/components/shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import { ActionError } from '@/lib/runAction';
import { WispConcernsPanel } from './WispConcernsPanel';

const concern = (id: string, severity: string, extra: Record<string, unknown> = {}) => ({
  id, partnerId: 'p', orgId: 'o', subject: { kind: 'ticket', id: 't' + id }, summary: 'Summary ' + id,
  severity, status: 'open', evidence: {}, outcome: null, signature: null, childConcernIds: [],
  approvalIntentId: null, createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  updatedAt: '2026-10-01T00:00:00Z', resolvedAt: null, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '';
  api.listWispConcerns.mockResolvedValue([]);
  api.snoozeWispConcern.mockResolvedValue(undefined);
  api.dismissWispConcern.mockResolvedValue(undefined);
  api.resolveWispConcern.mockResolvedValue(undefined);
});

const mountWith = async (list: unknown[]) => {
  api.listWispConcerns.mockResolvedValue(list);
  render(<WispConcernsPanel grantId="g1" threadId="t1" />);
  await screen.findAllByTestId('wisp-concern-row');
};

describe('WispConcernsPanel', () => {
  it('fetches live concerns and groups rows high to info', async () => {
    await mountWith([concern('a', 'low'), concern('b', 'high'), concern('c', 'info'), concern('d', 'medium')]);
    expect(api.listWispConcerns).toHaveBeenCalledWith('g1', ['open', 'snoozed']);
    const ids = screen.getAllByTestId('wisp-concern-row').map((r) => r.getAttribute('data-concern-id'));
    expect(ids).toEqual(['b', 'd', 'a', 'c']);
  });

  it('shows nudge state', async () => {
    await mountWith([
      concern('a', 'high', { recipient: { snoozedUntil: new Date(Date.now() + 3600_000).toISOString(), digestOnly: false } }),
      concern('b', 'low', { recipient: { snoozedUntil: null, digestOnly: true } }),
    ]);
    const [a, b] = screen.getAllByTestId('wisp-concern-row');
    expect(a!.textContent).toContain('quiet until');
    expect(b!.textContent).toContain('digest only');
  });

  it('#concern=<id> expands that row', async () => {
    window.location.hash = '#concern=b';
    await mountWith([concern('a', 'high'), concern('b', 'low')]);
    await waitFor(() => expect(screen.getByTestId('wisp-concern-select-b').getAttribute('aria-expanded')).toBe('true'));
    expect(screen.getByTestId('wisp-concern-select-a').getAttribute('aria-expanded')).toBe('false');
    act(() => { window.location.hash = '#concern=a'; });
    await waitFor(() => expect(screen.getByTestId('wisp-concern-select-a').getAttribute('aria-expanded')).toBe('true'));
  });

  it('a deep link to a concern that was resolved meanwhile widens to all statuses and shows it (W06 review focus 3)', async () => {
    window.location.hash = '#concern=gone';
    api.listWispConcerns.mockImplementation(async (_g: string, statuses: string[]) =>
      statuses.includes('resolved') ? [concern('a', 'high'), concern('gone', 'low', { status: 'resolved' })] : [concern('a', 'high')]);
    render(<WispConcernsPanel grantId="g1" threadId="t1" />);
    await waitFor(() => expect(screen.getByTestId('wisp-concern-select-gone').getAttribute('aria-expanded')).toBe('true'));
    expect(api.listWispConcerns).toHaveBeenLastCalledWith('g1', ['open', 'snoozed', 'resolved', 'dismissed']);
  });

  it('a deep link to an id that is in no list widens once and does not loop', async () => {
    window.location.hash = '#concern=nope';
    await mountWith([concern('a', 'high')]);
    await waitFor(() => expect(api.listWispConcerns).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(api.listWispConcerns).toHaveBeenCalledTimes(2);
  });

  it('a malformed #concern= hash is ignored, not a crash', async () => {
    window.location.hash = '#concern=%E0%A4%A';
    await mountWith([concern('a', 'high')]);
    expect(screen.getByTestId('wisp-concern-select-a').getAttribute('aria-expanded')).toBe('false');
  });

  it('selecting a row expands it without touching the host page hash', async () => {
    window.location.hash = '#tab=software';
    await mountWith([concern('a', 'high')]);
    fireEvent.click(screen.getByTestId('wisp-concern-select-a'));
    expect(screen.getByTestId('wisp-concern-select-a').getAttribute('aria-expanded')).toBe('true');
    expect(window.location.hash).toBe('#tab=software');
    fireEvent.click(screen.getByTestId('wisp-concern-select-a'));
    expect(screen.getByTestId('wisp-concern-select-a').getAttribute('aria-expanded')).toBe('false');
    expect(window.location.hash).toBe('#tab=software');
  });

  it('snooze 1 hour calls the api with now+1h and refetches', async () => {
    await mountWith([concern('a', 'high')]);
    fireEvent.click(screen.getByTestId('wisp-concern-snooze-a'));
    const before = Date.now();
    fireEvent.click(screen.getByTestId('wisp-concern-snooze-1h-a'));
    await waitFor(() => expect(api.snoozeWispConcern).toHaveBeenCalledTimes(1));
    const [id, grant, until] = api.snoozeWispConcern.mock.calls[0]!;
    expect([id, grant]).toEqual(['a', 'g1']);
    expect(Math.abs((until as Date).getTime() - (before + 3600_000))).toBeLessThan(5000);
    await waitFor(() => expect(api.listWispConcerns).toHaveBeenCalledTimes(2));
  });

  it('resolve submit sends the typed outcome and is disabled when empty', async () => {
    await mountWith([concern('a', 'high')]);
    fireEvent.click(screen.getByTestId('wisp-concern-resolve-a'));
    const submit = screen.getByTestId('wisp-concern-resolve-submit-a') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('wisp-concern-outcome-a'), { target: { value: 'rebooted it' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(api.resolveWispConcern).toHaveBeenCalledWith('a', 'g1', 'rebooted it'));
    await waitFor(() => expect(api.listWispConcerns).toHaveBeenCalledTimes(2));
  });

  it('a 401 ActionError from dismiss adds no toast', async () => {
    api.dismissWispConcern.mockRejectedValue(new ActionError('expired', 401));
    await mountWith([concern('a', 'high')]);
    fireEvent.click(screen.getByTestId('wisp-concern-dismiss-a'));
    await waitFor(() => expect(api.dismissWispConcern).toHaveBeenCalledWith('a', 'g1'));
    await act(async () => { await Promise.resolve(); });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a non-ActionError produces one error toast; an ActionError produces none', async () => {
    api.dismissWispConcern.mockRejectedValueOnce(new Error('boom'));
    await mountWith([concern('a', 'high')]);
    fireEvent.click(screen.getByTestId('wisp-concern-dismiss-a'));
    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(showToast.mock.calls[0]![0].type).toBe('error');
    api.dismissWispConcern.mockRejectedValueOnce(new ActionError('bad', 400));
    fireEvent.click(screen.getByTestId('wisp-concern-dismiss-a'));
    await waitFor(() => expect(api.dismissWispConcern).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('filter toggle requests all statuses', async () => {
    await mountWith([concern('a', 'high')]);
    fireEvent.click(screen.getByTestId('wisp-concerns-filter'));
    await waitFor(() =>
      expect(api.listWispConcerns).toHaveBeenLastCalledWith('g1', ['open', 'snoozed', 'resolved', 'dismissed']));
  });

  it('renders the empty state', async () => {
    render(<WispConcernsPanel grantId="g1" threadId="t1" />);
    expect(await screen.findByTestId('wisp-concerns-empty')).toBeTruthy();
    expect(screen.queryAllByTestId('wisp-concern-row')).toHaveLength(0);
  });

  it('W06 T7: a concern with an approval intent links to its approval card', async () => {
    await mountWith([concern('a', 'high', { approvalIntentId: 'int-1' }), concern('b', 'low')]);
    expect(screen.getByTestId('wisp-concern-approval-a').getAttribute('href')).toBe('/approvals#intent-int-1');
    expect(screen.queryByTestId('wisp-concern-approval-b')).toBeNull();
  });

  describe('W06 T16 nudge feedback (w00 A34)', () => {
    const nudged = (feedback: string | null = null) => ({ nudgeCount: 1, snoozedUntil: null, digestOnly: false, feedback });

    it('offers Useful / Not useful only on a concern that was nudged', async () => {
      await mountWith([concern('a', 'high', { recipient: nudged() }), concern('b', 'low', { recipient: { ...nudged(), nudgeCount: 0 } }), concern('c', 'low')]);
      expect(screen.getByTestId('wisp-concern-useful-a')).toBeTruthy();
      expect(screen.queryByTestId('wisp-concern-useful-b')).toBeNull();
      expect(screen.queryByTestId('wisp-concern-useful-c')).toBeNull();
    });

    it('Useful posts at once and the row shows the choice from the server recipient', async () => {
      api.feedbackWispConcern.mockResolvedValue(nudged('useful'));
      await mountWith([concern('a', 'high', { recipient: nudged() })]);
      api.listWispConcerns.mockImplementation(() => new Promise(() => {})); // the refetch never lands: only the server answer can update the row
      fireEvent.click(screen.getByTestId('wisp-concern-useful-a'));
      await waitFor(() => expect(api.feedbackWispConcern).toHaveBeenCalledWith('a', 'g1', true));
      expect(await screen.findByTestId('wisp-concern-feedback-given-a')).toBeTruthy();
      expect(screen.queryByTestId('wisp-concern-useful-a')).toBeNull();
    });

    it('Not useful opens an optional note and sends it once', async () => {
      api.feedbackWispConcern.mockResolvedValue(nudged('not_useful'));
      await mountWith([concern('a', 'high', { recipient: nudged() })]);
      fireEvent.click(screen.getByTestId('wisp-concern-not-useful-a'));
      expect(api.feedbackWispConcern).not.toHaveBeenCalled();
      const note = screen.getByTestId('wisp-concern-feedback-note-a') as HTMLInputElement;
      expect(note.maxLength).toBe(200);
      fireEvent.change(note, { target: { value: 'not my customer' } });
      fireEvent.click(screen.getByTestId('wisp-concern-feedback-send-a'));
      await waitFor(() => expect(api.feedbackWispConcern).toHaveBeenCalledWith('a', 'g1', false, 'not my customer'));
      expect(api.feedbackWispConcern).toHaveBeenCalledTimes(1);
    });

    it('a 409 (answered elsewhere) closes the note editor and refetches so the recorded choice shows', async () => {
      api.feedbackWispConcern.mockRejectedValue(new ActionError('already recorded', 409));
      await mountWith([concern('a', 'high', { recipient: nudged() })]);
      api.listWispConcerns.mockResolvedValue([concern('a', 'high', { recipient: nudged('useful') })]);
      fireEvent.click(screen.getByTestId('wisp-concern-not-useful-a'));
      fireEvent.click(screen.getByTestId('wisp-concern-feedback-send-a'));
      expect(await screen.findByTestId('wisp-concern-feedback-given-a')).toBeTruthy();
      expect(screen.queryByTestId('wisp-concern-feedback-note-a')).toBeNull();
      expect(showToast).not.toHaveBeenCalled(); // runAction already toasted the server's message
    });

    it('any other failure keeps the buttons enabled and shows no choice', async () => {
      api.feedbackWispConcern.mockRejectedValue(new ActionError('nope', 500));
      await mountWith([concern('a', 'high', { recipient: nudged() })]);
      fireEvent.click(screen.getByTestId('wisp-concern-useful-a'));
      await waitFor(() => expect((screen.getByTestId('wisp-concern-useful-a') as HTMLButtonElement).disabled).toBe(false));
      expect(screen.queryByTestId('wisp-concern-feedback-given-a')).toBeNull();
    });

    it('a recorded choice shows instead of the buttons', async () => {
      await mountWith([concern('a', 'high', { recipient: nudged('not_useful') })]);
      expect(screen.getByTestId('wisp-concern-feedback-given-a')).toBeTruthy();
      expect(screen.queryByTestId('wisp-concern-not-useful-a')).toBeNull();
    });
  });

  it('renders the load failure', async () => {
    api.listWispConcerns.mockRejectedValue(new Error('x'));
    render(<WispConcernsPanel grantId="g1" threadId="t1" />);
    expect((await screen.findByTestId('wisp-concerns-load-error')).textContent).toContain("Couldn't load concerns");
  });
});
