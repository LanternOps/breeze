import { describe, it, expect, afterEach } from 'vitest';
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

  // Item-changed rebinding (mail) is intentionally NOT an App-level concern: the
  // ChatController reads context + name FRESH at send time (covered in
  // chatController.test.ts) and the Outlook adapter's switchItem re-read is
  // covered in apps/outlook-addin. App only forwards host/clientHost to ChatPane.
});
