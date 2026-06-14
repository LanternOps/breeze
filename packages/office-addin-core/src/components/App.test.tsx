import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import type { HostAdapter } from '../host/types';

afterEach(cleanup);

/**
 * A neutral fake host so the App test never touches the Excel path. App itself
 * has zero host coupling — it only forwards `host`/`clientHost` to ChatPane once
 * a session exists — so the boot path (no stored session → silent SSO fails in
 * jsdom → sign-in screen) renders without ever calling into the adapter.
 */
function fakeHost(overrides: Partial<HostAdapter> = {}): HostAdapter {
  return {
    captureContext: async () => undefined,
    captureName: async () => undefined,
    captureSelectionAddress: async () => undefined,
    subscribeSelectionChanged: () => () => {},
    toolExecutors: {},
    mutatingTools: new Set<string>(),
    buildPreview: async (toolName: string) => ({
      kind: 'summary' as const,
      toolName,
      target: 'x',
      description: 'x',
    }),
    ...overrides,
  };
}

describe('App (core, host-parameterized)', () => {
  it('falls through to the sign-in screen when no session is stored and silent SSO is unavailable', async () => {
    // jsdom has no OfficeRuntime, so the silent signIn rejects with a plain
    // Error (not AuthBlockedError) → the phase machine lands on `signin`.
    render(<App host={fakeHost()} clientHost="word" />);
    await waitFor(() => expect(screen.getByTestId('signin-button')).toBeTruthy());
  });

  it('re-reads the active context label when the subscribed selection/item-change callback fires', async () => {
    // A pinned Outlook pane survives item switches: mailbox.item is replaced per
    // selection, so the App must re-read the context (NOT start a fresh session)
    // when host.subscribeSelectionChanged fires. Reuses the same subscription the
    // Excel selection chip already wires.
    let fire: (() => void) | undefined;
    const captureName = vi.fn(async () => 'first message');
    const subscribeSelectionChanged = vi.fn((cb: () => void) => {
      fire = cb;
      return () => {};
    });
    render(
      <App
        host={fakeHost({ captureName, subscribeSelectionChanged })}
        clientHost="outlook"
      />,
    );
    // App subscribes on mount and reads the context label once.
    await waitFor(() => expect(subscribeSelectionChanged).toHaveBeenCalled());
    await waitFor(() => expect(captureName).toHaveBeenCalledTimes(1));
    // Simulate an item switch — the subscribed callback fires and the App
    // re-reads the context label rather than binding the stale one.
    fire?.();
    await waitFor(() => expect(captureName).toHaveBeenCalledTimes(2));
  });
});
