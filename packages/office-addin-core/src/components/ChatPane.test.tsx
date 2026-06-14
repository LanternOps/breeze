import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { ChatPane } from './ChatPane';
import type { HostAdapter } from '../host/types';
import type { ClientSession } from '../auth/session';

afterEach(cleanup);

function fakeHost(overrides: Partial<HostAdapter> = {}): HostAdapter {
  return {
    captureContext: async () => undefined,
    captureName: async () => undefined,
    captureSelectionAddress: vi.fn(async () => undefined),
    subscribeSelectionChanged: vi.fn(() => () => {}),
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

const SESSION: ClientSession = {
  sessionToken: 'tok',
  expiresAt: Date.now() + 60_000,
  user: { id: 'u1', email: 'u@x.com', name: 'U' },
  org: null,
  branding: null,
};

describe('ChatPane (core, host-parameterized)', () => {
  it('mounts the pane shell (new-chat button + composer) from the injected host', () => {
    render(<ChatPane session={SESSION} host={fakeHost()} clientHost="word" />);
    expect(screen.getByTestId('new-chat-button')).toBeTruthy();
    expect(screen.getByTestId('composer-input')).toBeTruthy();
  });

  it('drives the live selection chip through host.captureSelectionAddress / subscribeSelectionChanged', async () => {
    const host = fakeHost({
      captureSelectionAddress: vi.fn(async () => 'B2'),
      subscribeSelectionChanged: vi.fn(() => () => {}),
    });
    render(<ChatPane session={SESSION} host={host} clientHost="word" />);
    await waitFor(() => expect(host.captureSelectionAddress).toHaveBeenCalled());
    expect(host.subscribeSelectionChanged).toHaveBeenCalled();
  });
});
