import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyLocale, i18n } from '@/lib/i18n';

import QuickSupportPage from './QuickSupportPage';
import { fetchWithAuth } from '@/stores/auth';

// #3632: `loadSessions` listed `t` in its useCallback deps and the poll effect
// listed both `loadSessions` and `t`, so a `languageChanged` (fired after
// hydration for every saved non-English locale) re-ran the list GET and
// restarted the selected-session poll.
vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/stores/orgStore', () => ({
  useOrgStore: () => ({ organizations: [] }),
}));

vi.mock('@/components/shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('./ConnectDesktopButton', () => ({
  default: () => null,
}));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

const callsTo = (fragment: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes(fragment)).length;

describe('QuickSupportPage: a locale change must not refetch', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url) =>
      String(url).startsWith('/remote/support-sessions?')
        ? jsonRes({ sessions: [] })
        : jsonRes({
            id: 'ss-1',
            status: 'pending',
            createdAt: '2026-08-04T12:00:00.000Z',
            codeExpiresAt: '2026-08-04T12:10:00.000Z',
            hardExpiresAt: '2026-08-04T14:00:00.000Z',
            deviceId: null,
            deviceOnline: false,
            attributedOrgId: null,
            attributionLabel: null,
            endedAt: null,
            endedReason: null,
            createdByUserId: 'user-1',
          }),
    );
    window.history.replaceState(null, '', '/remote/quick-support');
    await act(() => i18n.changeLanguage('en'));
  });

  afterEach(async () => {
    window.history.replaceState(null, '', '/');
    await act(() => i18n.changeLanguage('en'));
  });

  it('loads the session list once across a language change', async () => {
    render(<QuickSupportPage />);
    await waitFor(() => expect(callsTo('/remote/support-sessions?')).toBe(1));

    await act(async () => {
      await applyLocale('fr-FR');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(callsTo('/remote/support-sessions?')).toBe(1);
  });

  it('does not restart the selected-session poll when the language changes', async () => {
    window.history.replaceState(null, '', '/remote/quick-support#ss-1');
    render(<QuickSupportPage />);
    await waitFor(() => expect(callsTo('/remote/support-sessions/ss-1')).toBe(1));

    await act(async () => {
      await applyLocale('fr-FR');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The next scheduled poll is POLL_INTERVAL_MS away, so any extra call here
    // can only be the effect re-running.
    expect(callsTo('/remote/support-sessions/ss-1')).toBe(1);
  });
});
