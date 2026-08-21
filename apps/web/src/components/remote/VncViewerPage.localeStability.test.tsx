import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../lib/i18n';

import VncViewerPage from './VncViewerPage';
import { fetchWithAuth } from '../../stores/auth';

// #3632 — `t` from useTranslation gets a NEW identity on `languageChanged`.
// With `t` in this effect's dependency array, a locale change re-ran the
// ticket mint and installed a fresh wsUrl underneath a LIVE session. The
// existing `attemptRef` guard does not catch it: it compares
// `attemptRef.current === attempt`, and a `t`-triggered re-run leaves `attempt`
// unchanged, so the new URL installs.
//
// This is reachable without touching the language picker.
// `scheduleStoredLocaleAfterHydration()` fires `changeLanguage` after mount on
// every page load for any user with a saved non-English locale, so an ordinary
// page load dropped their remote session.
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

// The viewer itself pulls in noVNC; this suite is about the mint effect only.
vi.mock('./VncViewer', () => ({
  default: () => null,
}));

const fetchMock = vi.mocked(fetchWithAuth);

const ticketRes = (): Response =>
  ({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({ ticket: 'ticket-abc' }),
  }) as unknown as Response;

describe('VncViewerPage — a locale change must not re-mint the tunnel ticket', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(ticketRes());
    await act(() => i18n.changeLanguage('en'));
  });

  it('does not POST a second ws-ticket when the language changes', async () => {
    render(<VncViewerPage tunnelId="tunnel-1" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/tunnels/tunnel-1/ws-ticket', { method: 'POST' });

    // Exactly what happens on hydration for a user with a saved locale.
    await act(() => i18n.changeLanguage('fr-FR'));

    // Give any re-triggered effect a chance to fire before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still re-mints for a real retry, so the guard was not simply disabled', async () => {
    // The effect must remain reactive to `attempt`/`tunnelId` — a fix that
    // froze it entirely would pass the test above and break reconnect.
    const { rerender } = render(<VncViewerPage tunnelId="tunnel-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<VncViewerPage tunnelId="tunnel-2" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith('/tunnels/tunnel-2/ws-ticket', { method: 'POST' });
  });
});
