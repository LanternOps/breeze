import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../lib/i18n';

import VncViewer from './VncViewer';

// #3632 — this is the assertion that matters for the reported symptom.
//
// The sibling test proves the ticket is minted once. That alone does NOT prove
// the user-visible bug is gone: the disconnect came from THIS component's own
// connection effect, whose cleanup calls `rfb.disconnect()`. With `t` in its
// dependency array, a `languageChanged` event tore the live RFB session down
// directly — no new wsUrl required.
//
// Reachable without touching the language picker:
// `scheduleStoredLocaleAfterHydration()` fires `changeLanguage` after mount on
// every page load for any user with a saved non-English locale.
//
// Rather than mock noVNC, this counts how many times the connect effect BODY
// runs, which is the thing under test: the effect logs exactly once per attempt
// on its way to `new RFB(...)`, so the count is a direct measure of effect
// re-entry, and it holds regardless of how the RFB is constructed.
//
// Mocking `@/lib/novnc` is the obvious alternative and is a trap here: the
// module is pulled in via a dynamic `import()` through the `@` alias, and this
// project sets `clearMocks`/`restoreMocks`, which strips a factory-declared
// implementation before each test. Both failure modes present identically — a
// mock that silently never runs, while `connect().catch()` swallows the fallout
// into an error state.
const CONNECT_LOG = '[VNC] container size at connect:';

// jsdom has no ResizeObserver; the viewer installs one to rescale the canvas.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', StubResizeObserver);

describe('VncViewer — a locale change must not re-run the connection effect', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const connects = () =>
    logSpy.mock.calls.filter((args: unknown[]) => String(args[0]).includes(CONNECT_LOG)).length;

  beforeEach(async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await act(() => i18n.changeLanguage('en'));
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('connects once and does not reconnect when the language changes', async () => {
    render(
      <VncViewer wsUrl="wss://example.test/ws?ticket=abc" tunnelId="tunnel-1" onDisconnect={() => {}} />
    );

    await waitFor(() => expect(connects()).toBe(1));

    // Exactly what hydration does for a user with a saved locale.
    await act(() => i18n.changeLanguage('fr-FR'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Re-running the effect would tear the session down in its cleanup.
    expect(connects()).toBe(1);
  });

  it('still reconnects when wsUrl actually changes, so the effect was not frozen', async () => {
    // A fix that simply stopped the effect reacting would pass the test above
    // and break every genuine reconnect.
    const { rerender } = render(
      <VncViewer wsUrl="wss://example.test/ws?ticket=abc" tunnelId="tunnel-1" onDisconnect={() => {}} />
    );
    await waitFor(() => expect(connects()).toBe(1));

    rerender(
      <VncViewer wsUrl="wss://example.test/ws?ticket=def" tunnelId="tunnel-1" onDisconnect={() => {}} />
    );
    await waitFor(() => expect(connects()).toBe(2));
  });
});
