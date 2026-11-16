import '@/lib/i18n';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type StreamEvent = { type: string };
const stream = vi.hoisted(() => ({ onEvent: undefined as ((event: StreamEvent) => void) | undefined }));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));
vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: (options: { onEvent: (event: StreamEvent) => void }) => {
    stream.onEvent = options.onEvent;
    return { subscribe: vi.fn(), unsubscribe: vi.fn() };
  }
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/notificationChime', () => ({ playNotificationChime: vi.fn() }));

import NotificationCenter from './NotificationCenter';
import { fetchWithAuth } from '../../stores/auth';
import { playNotificationChime } from '@/lib/notificationChime';

const fetchMock = vi.mocked(fetchWithAuth);
const chimeMock = vi.mocked(playNotificationChime);

const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const row = (id: string, type: string, read = false, metadata?: Record<string, unknown>) => ({
  id,
  type,
  ...(metadata ? { metadata } : {}),
  title: `Title ${id}`,
  message: 'Message',
  createdAt: '2026-11-15T00:00:00.000Z',
  read
});

const bell = () => screen.findByRole('button', { name: /notifications/i });

// Serve `first` on mount, then `second` on the live-nudge refetch.
const arrive = async (first: unknown[], second: unknown[]) => {
  fetchMock.mockResolvedValueOnce(json({ notifications: first }));
  fetchMock.mockResolvedValue(json({ notifications: second }));
  render(<NotificationCenter />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await bell();
  act(() => stream.onEvent?.({ type: 'notification.created' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 3000 });
};

beforeEach(() => {
  fetchMock.mockReset();
  chimeMock.mockReset();
  window.localStorage.clear();
});

describe('NotificationCenter ring on new notifications', () => {
  it('stays quiet for unread rows that were already there on first load', async () => {
    fetchMock.mockResolvedValue(json({ notifications: [row('a1', 'approval')] }));
    render(<NotificationCenter />);

    const trigger = await bell();
    await screen.findByText('1');

    expect(trigger).not.toHaveAttribute('data-ringing');
    expect(chimeMock).not.toHaveBeenCalled();
  });

  it('rings the bell and chimes when a new unread approval arrives', async () => {
    await arrive([row('a1', 'approval')], [row('a2', 'approval'), row('a1', 'approval')]);

    await waitFor(async () => expect(await bell()).toHaveAttribute('data-ringing', 'true'));
    expect(chimeMock).toHaveBeenCalledTimes(1);
  });

  // "Approval granted", "denied", "expired" share the approval type, but nobody
  // is waiting on this person: the bell swings, the chime stays for requests.
  it('rings without a chime for an approval OUTCOME notice', async () => {
    await arrive([], [row('o1', 'approval', false, { intentId: 'i-1', outcome: 'ai.intent.completed', status: 'completed' })]);

    await waitFor(async () => expect(await bell()).toHaveAttribute('data-ringing', 'true'));
    expect(chimeMock).not.toHaveBeenCalled();
  });

  it('stays muted after a reload when the sound was switched off earlier', async () => {
    window.localStorage.setItem('breeze-notification-sound', 'off');
    await arrive([], [row('a1', 'approval')]);

    await waitFor(async () => expect(await bell()).toHaveAttribute('data-ringing', 'true'));
    expect(chimeMock).not.toHaveBeenCalled();
  });

  it('rings without a chime for a new unread non-approval row', async () => {
    await arrive([], [row('d1', 'device')]);

    await waitFor(async () => expect(await bell()).toHaveAttribute('data-ringing', 'true'));
    expect(chimeMock).not.toHaveBeenCalled();
  });

  it('does not ring for a new row that is already read', async () => {
    await arrive([], [row('a1', 'approval', true)]);

    expect(await bell()).not.toHaveAttribute('data-ringing');
    expect(chimeMock).not.toHaveBeenCalled();
  });

  it('does not chime once the sound is switched off, and remembers the choice', async () => {
    fetchMock.mockResolvedValueOnce(json({ notifications: [] }));
    fetchMock.mockResolvedValue(json({ notifications: [row('a1', 'approval')] }));
    render(<NotificationCenter />);

    const user = userEvent.setup();
    await user.click(await bell());
    const toggle = await screen.findByRole('button', { name: /mute approval sound/i });
    await user.click(toggle);
    expect(window.localStorage.getItem('breeze-notification-sound')).toBe('off');

    act(() => stream.onEvent?.({ type: 'notification.created' }));
    await waitFor(async () => expect(await bell()).toHaveAttribute('data-ringing', 'true'), {
      timeout: 3000
    });
    expect(chimeMock).not.toHaveBeenCalled();
  });
});
