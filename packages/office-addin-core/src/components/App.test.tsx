import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { __resetSessionForTests, type TechPersonaSession } from '../auth/session';
import type { HostAdapter } from '../host/types';

beforeEach(() => {
  __resetSessionForTests();
  sessionStorage.clear();
});
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

  function seedClientSession() {
    sessionStorage.setItem(
      'breeze-office-addin-session-v2',
      JSON.stringify({
        v: 2,
        persona: 'client',
        sessionToken: 'tok',
        expiresAt: Date.now() + 60_000,
        user: { id: 'u-1', email: 'a@b.com', name: 'A B' },
        org: null,
        branding: null,
      }),
    );
  }

  function seedTechSession() {
    sessionStorage.setItem(
      'breeze-office-addin-session-v2',
      JSON.stringify({
        v: 2,
        persona: 'tech',
        sessionToken: 'tech-tok',
        expiresAt: Date.now() + 60_000,
        user: { id: 'u-2', email: 'tech@partner.example', name: 'Tech User' },
        partner: { id: 'p-1' },
      }),
    );
  }

  it('persona client renders ChatPane exactly as before', async () => {
    seedClientSession();
    render(<App host={fakeHost()} clientHost="word" />);
    await waitFor(() => expect(screen.getByTestId('new-chat-button')).toBeTruthy());
  });

  it('persona tech with a techPane prop renders techPane, not ChatPane', async () => {
    seedTechSession();
    function TechPane({ session }: { session: TechPersonaSession }) {
      return <div data-testid="tech-pane">{session.partner.id}</div>;
    }
    render(<App host={fakeHost()} clientHost="outlook" techPane={TechPane} />);
    await waitFor(() => expect(screen.getByTestId('tech-pane')).toBeTruthy());
    expect(screen.getByTestId('tech-pane').textContent).toBe('p-1');
    expect(screen.queryByTestId('new-chat-button')).toBeNull();
  });

  it('persona tech with NO techPane falls back to BlockedScreen (defensive)', async () => {
    seedTechSession();
    render(<App host={fakeHost()} clientHost="word" />);
    await waitFor(() => expect(screen.getByTestId('blocked-unsupported_persona')).toBeTruthy());
    expect(screen.queryByTestId('new-chat-button')).toBeNull();
  });
});
