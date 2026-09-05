import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RemoteToolsPage from './RemoteToolsPage';
import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '@/components/shared/Toast';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

// The real button drives desktop-session launch/deep-link flows unrelated to
// tab/hash behavior; only its presence matters for this suite.
vi.mock('./ConnectDesktopButton', () => ({
  default: () => <button type="button">connect</button>,
}));

// RemoteTerminal lazy-imports xterm.js and opens a WebSocket on mount — that
// machinery is covered by RemoteTerminal.test.tsx / RemoteTerminal.initFailure
// .test.tsx. Here we only need proof that RemoteToolsPage mounted the Terminal
// tab's content, so stub it out with a marker element. The stub also captures
// the props it was handed, which is how the onError wiring below is asserted.
const terminalStubProps: { onError?: (message: string) => void } = {};

vi.mock('./RemoteTerminal', () => ({
  default: (props: { onError?: (message: string) => void }) => {
    terminalStubProps.onError = props.onError;
    return <div data-testid="remote-terminal-stub" />;
  },
}));

vi.mock('@/components/shared/Toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shared/Toast')>()),
  showToast: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeResponse = (payload: unknown = {}, ok = false): Response =>
  ({
    ok,
    status: ok ? 200 : 404,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response);

beforeEach(() => {
  vi.mocked(showToast).mockClear();
  terminalStubProps.onError = undefined;
  fetchMock.mockReset();
  // Nothing under test here depends on real device/process/service data —
  // every fetch resolves not-ok so effects bail out quietly.
  fetchMock.mockResolvedValue(makeResponse());
  window.location.hash = '';
});

afterEach(() => {
  window.location.hash = '';
  cleanup();
});

const renderPage = () =>
  render(<RemoteToolsPage deviceId="device-1" deviceName="host-1" deviceOs="windows" />);

describe('RemoteToolsPage tab hash persistence (#4512)', () => {
  it('activates the Terminal tab on mount when the URL hash is #terminal', async () => {
    window.location.hash = '#terminal';

    renderPage();

    expect(await screen.findByTestId('remote-terminal-stub')).toBeInTheDocument();
  });

  it('defaults to the Processes tab when there is no hash', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.queryByTestId('remote-terminal-stub')).not.toBeInTheDocument();
    });
  });

  it('falls back to the default tab when the hash names an unknown tab', async () => {
    window.location.hash = '#not-a-real-tab';

    renderPage();

    await waitFor(() => {
      expect(screen.queryByTestId('remote-terminal-stub')).not.toBeInTheDocument();
    });
  });

  it('writes the clicked tab id to the URL hash and renders that tab', async () => {
    const user = userEvent.setup();
    renderPage();

    const terminalTabButton = await screen.findByRole('button', { name: 'Terminal' });
    await user.click(terminalTabButton);

    expect(window.location.hash).toBe('#terminal');
    expect(await screen.findByTestId('remote-terminal-stub')).toBeInTheDocument();
  });

  it('re-syncs the active tab on a hashchange event (back/forward navigation)', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.queryByTestId('remote-terminal-stub')).not.toBeInTheDocument();
    });

    act(() => {
      window.location.hash = '#terminal';
      window.dispatchEvent(new Event('hashchange'));
    });

    expect(await screen.findByTestId('remote-terminal-stub')).toBeInTheDocument();
  });

  it('falls back to the Processes tab when the hash names a windows-only tab on a non-Windows device (regression: hash bypasses OS gating)', async () => {
    window.location.hash = '#services';

    render(<RemoteToolsPage deviceId="device-1" deviceName="host-1" deviceOs="linux" />);

    // 'services' is windows-only and this device is linux, so the page must
    // not get stuck on a tab whose button/content never render.
    await waitFor(() => {
      expect(window.location.hash).toBe('#processes');
    });
    const processesButton = await screen.findByRole('button', { name: 'Processes' });
    expect(processesButton.className).toMatch(/border-primary/);
  });
});

// The terminal's only channel for reporting a failed initialisation is the
// onError prop. RemoteToolsPage never passed one, so a terminal that died on
// mount was completely silent — the defect behind #4152 was invisible to the
// user and to support.
describe('RemoteToolsPage surfaces terminal errors (#4152)', () => {
  it('passes an onError handler that raises a toast', async () => {
    window.location.hash = '#terminal';

    renderPage();
    await screen.findByTestId('remote-terminal-stub');

    expect(terminalStubProps.onError).toBeTypeOf('function');

    act(() => {
      terminalStubProps.onError!('Failed to initialize terminal');
    });

    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Failed to initialize terminal' }),
    );
  });
});
