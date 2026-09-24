import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyLocale, i18n } from '@/lib/i18n';

import SessionPickerModal from './SessionPickerModal';
import { fetchWithAuth } from '../../stores/auth';

// #3632: with `t` in the load effect's deps, a `languageChanged` (fired after
// hydration for every saved non-English locale) re-queried the device's live
// sessions while the picker was open.
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const sessionsRes = (): Response =>
  ({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      data: {
        deviceId: 'dev-1',
        sessions: [{ sessionId: 3, username: 'alice', state: 'active', type: 'rdp', helperConnected: true, idleMinutes: null }],
      },
    }),
  }) as unknown as Response;

const liveCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/sessions/live')).length;

describe('SessionPickerModal: a locale change must not re-query live sessions', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => sessionsRes());
    await act(() => i18n.changeLanguage('en'));
  });

  afterEach(async () => {
    await act(() => i18n.changeLanguage('en'));
  });

  it('fetches once across a language change', async () => {
    render(<SessionPickerModal isOpen deviceId="dev-1" purpose="desktop" onSelect={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('session-picker-row-3')).toBeDefined());
    expect(liveCalls()).toBe(1);

    await act(async () => {
      await applyLocale('fr-FR');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(liveCalls()).toBe(1);
  });

  it('still refetches when the device changes', async () => {
    const { rerender } = render(
      <SessionPickerModal isOpen deviceId="dev-1" purpose="desktop" onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(liveCalls()).toBe(1));
    rerender(<SessionPickerModal isOpen deviceId="dev-2" purpose="desktop" onSelect={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(liveCalls()).toBe(2));
    expect(fetchMock).toHaveBeenLastCalledWith('/devices/dev-2/sessions/live');
  });
});
