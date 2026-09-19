import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RemoteTerminal from './RemoteTerminal';
import { fetchWithAuth } from '@/stores/auth';

// Cold-mount init failures for RemoteTerminal (#4152), in a file of their own
// for two reasons that RemoteTerminal.test.tsx cannot satisfy:
//
//  1. A factory-mocked module is evaluated exactly ONCE per test file and the
//     result is cached for the rest of it — `vi.resetModules()` does not re-run
//     the factory (verified). Guaranteeing that the component's very first
//     `await import('@xterm/xterm/css/xterm.css')` is the one that rejects
//     therefore requires a file where no earlier test has imported it.
//  2. The layout cases in RemoteTerminal.test.tsx render without awaiting init,
//     so their `new Terminal(...)` lands during a later test. Sharing that file
//     would let a leaked construction consume this file's injected failure.
//
// What is reproduced: before the fix the component did a bare
// `await import('@xterm/xterm/css/xterm.css')`, which Vite compiles into a
// `<link rel=stylesheet>` injection that resolves on `load` and REJECTS on
// `error`. After an upgrade a stale hashed asset URL comes back as the SPA's
// index.html, which `nosniff` refuses to treat as a stylesheet, so the promise
// rejected on a cold mount. That single rejection unwound the whole of
// initTerminal: no terminal instance, no `terminalReady`, therefore no
// auto-connect and — because the retry overlay is gated on
// `autoConnectAttempted`, which only the auto-connect sets — nothing to click.
// The pane sat on "Disconnected" until a tab round-trip remounted it.
//
// The stylesheet is now inlined into the component's own chunk (`?inline`), so
// that `<link>` no longer exists. These cases hold the line behind that: the
// module still has to be unable to take the session down with it.
const cssImport = { evaluations: 0, threw: false };

vi.mock('@xterm/xterm/css/xterm.css?inline', () => {
  cssImport.evaluations += 1;
  // Only the first evaluation fails, so the stylesheet-specific case below can
  // prove the rejection reached the component. Vitest caches the outcome
  // anyway; the counter is what the assertions actually rely on.
  if (cssImport.evaluations === 1) {
    cssImport.threw = true;
    throw new Error(
      "Unable to preload CSS for /assets/xterm-abc123.css (MIME type 'text/html' is not a supported stylesheet MIME type)",
    );
  }
  return { default: '.xterm { position: relative; }' };
});

const terminalLifecycle = {
  constructCount: 0,
  /**
   * Number of upcoming `new Terminal(...)` calls that must throw — a stand-in
   * for any init failure other than the stylesheet (a rejected xterm chunk, a
   * constructor blowing up), all of which land in the same catch.
   */
  failNextConstructs: 0,
};

vi.mock('@xterm/xterm', () => ({
  Terminal: function () {
    terminalLifecycle.constructCount += 1;
    if (terminalLifecycle.failNextConstructs > 0) {
      terminalLifecycle.failNextConstructs -= 1;
      throw new Error('xterm construction failed');
    }
    return {
      loadAddon() {},
      open() {},
      write() {},
      writeln() {},
      onData() {
        return { dispose() {} };
      },
      onResize() {
        return { dispose() {} };
      },
      dispose() {},
      focus() {},
      clear() {},
      rows: 24,
      cols: 80,
    };
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: function () {
    return {
      fit() {},
      proposeDimensions() {
        return { cols: 80, rows: 24 };
      },
    };
  },
}));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: function () {
    return {};
  },
}));

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeResponse = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response);

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.({});
    });
  }

  send() {}

  close(code?: number) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000 });
  }
}

const sessionPostCount = () =>
  fetchMock.mock.calls.filter(
    ([url, opts]) => url === '/remote/sessions' && (opts as RequestInit | undefined)?.method === 'POST',
  ).length;

beforeEach(() => {
  MockWebSocket.instances = [];
  terminalLifecycle.constructCount = 0;
  terminalLifecycle.failNextConstructs = 0;
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (/\/ws-ticket$/.test(url)) return makeResponse({ ticket: 'TKT-1' });
    return makeResponse({ id: 'session-1' });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RemoteTerminal cold mount with a broken xterm stylesheet (#4152)', () => {
  it('treats the failed stylesheet preload as cosmetic and still connects', async () => {
    render(<RemoteTerminal deviceId="device-1" deviceHostname="host-1" />);

    // Losing the stylesheet must cost styling, never the session: the terminal
    // is still constructed and the ordinary auto-connect path runs.
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1), { timeout: 3000 });
    expect(sessionPostCount()).toBe(1);
    expect(terminalLifecycle.constructCount).toBe(1);
    expect(screen.queryByTestId('terminal-disconnect-overlay')).not.toBeInTheDocument();

    // Prove the control actually fired — without this the test passes for the
    // trivial reason that the stylesheet loaded fine.
    expect(cssImport.evaluations).toBe(1);
    expect(cssImport.threw).toBe(true);
  });
});

describe('RemoteTerminal init failure is visible and retryable in place (#4152)', () => {
  it('renders the retry overlay instead of an inert empty pane', async () => {
    terminalLifecycle.failNextConstructs = 1;

    render(<RemoteTerminal deviceId="device-1" deviceHostname="host-1" />);

    // Before the fix nothing rendered here: status stayed 'disconnected' with
    // `autoConnectAttempted` false, so the overlay's condition was never met.
    expect(
      await screen.findByTestId('terminal-disconnect-overlay', undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(terminalLifecycle.constructCount).toBe(1);
    // Nothing was ever asked of the API for a terminal that does not exist —
    // this is the reporter's "Disconnected, no session" state.
    expect(sessionPostCount()).toBe(0);
  });

  it('re-runs init when the retry button is clicked, then connects', async () => {
    terminalLifecycle.failNextConstructs = 1;

    render(<RemoteTerminal deviceId="device-1" deviceHostname="host-1" />);
    await screen.findByTestId('terminal-disconnect-overlay', undefined, { timeout: 3000 });

    await userEvent.click(screen.getByTestId('terminal-overlay-reconnect'));

    // The retry has to re-run init: there is no terminal yet, and connect()
    // alone early-returns on the null terminalRef, so the button was a no-op.
    await waitFor(() => expect(terminalLifecycle.constructCount).toBe(2), { timeout: 3000 });
    // Init succeeding hands off to the ordinary auto-connect path.
    await waitFor(() => expect(sessionPostCount()).toBe(1), { timeout: 3000 });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1), { timeout: 3000 });
    // And the 'failed' status set by the dead init must not outlive it —
    // otherwise the overlay would sit on top of a live session.
    await waitFor(
      () => expect(screen.queryByTestId('terminal-disconnect-overlay')).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it('stays retryable when the retry itself fails', async () => {
    // The guard that makes a retry possible at all is `initStartedRef` being
    // released in the catch. It has to be released on EVERY failure, not just
    // the first, or a second bad attempt wedges the pane exactly as #4152 did.
    terminalLifecycle.failNextConstructs = 2;

    render(<RemoteTerminal deviceId="device-1" deviceHostname="host-1" />);
    await screen.findByTestId('terminal-disconnect-overlay', undefined, { timeout: 3000 });

    await userEvent.click(screen.getByTestId('terminal-overlay-reconnect'));
    await waitFor(() => expect(terminalLifecycle.constructCount).toBe(2), { timeout: 3000 });

    // Still offering a way out, and still no session for a terminal that does
    // not exist.
    expect(await screen.findByTestId('terminal-disconnect-overlay', undefined, { timeout: 3000 })).
      toBeInTheDocument();
    expect(sessionPostCount()).toBe(0);

    // Third attempt succeeds, proving the guard never latched.
    await userEvent.click(screen.getByTestId('terminal-overlay-reconnect'));
    await waitFor(() => expect(terminalLifecycle.constructCount).toBe(3), { timeout: 3000 });
    await waitFor(() => expect(sessionPostCount()).toBe(1), { timeout: 3000 });
  });

  // NOT new coverage for #4152 — the catch has always called onError. This
  // pins that contract because RemoteToolsPage now depends on it to raise a
  // toast (see RemoteToolsPage.test.tsx); before, the one caller that mattered
  // passed no handler, so the call had no observable effect and could have
  // been dropped by a refactor without anything failing.
  it('reports the failure to the caller through onError (pre-existing contract)', async () => {
    terminalLifecycle.failNextConstructs = 1;
    const onError = vi.fn();

    render(<RemoteTerminal deviceId="device-1" deviceHostname="host-1" onError={onError} />);

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(onError.mock.calls[0]![0]).toBeTruthy();
  });
});
