import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSession } from './SessionHistory';

const sessionState = vi.hoisted(() => ({
  recordingUrl: 'javascript:alert(1)',
  session: {
    id: 'session-1',
    deviceId: 'device-1',
    deviceHostname: 'host-1',
    deviceOsType: 'linux',
    userId: 'user-1',
    userName: 'Alex',
    userEmail: 'alex@example.com',
    type: 'desktop',
    status: 'disconnected',
    durationSeconds: 60,
    bytesTransferred: 1024,
    createdAt: '2026-05-02T10:00:00.000Z',
  } as RemoteSession,
}));

vi.mock('./SessionHistory', () => ({
  default: ({ onViewDetails }: { onViewDetails?: (session: RemoteSession) => void }) => (
    <button
      type="button"
      onClick={() => onViewDetails?.({ ...sessionState.session, recordingUrl: sessionState.recordingUrl })}
    >
      Open details
    </button>
  ),
  normalizeRemoteSession: vi.fn((value: RemoteSession) => value),
}));

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

import SessionHistoryPage from './SessionHistoryPage';

describe('SessionHistoryPage', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/remote/sessions');
    sessionState.recordingUrl = 'javascript:alert(1)';
  });

  it('does not render unsafe recording URLs as links', () => {
    render(<SessionHistoryPage />);

    fireEvent.click(screen.getByText('Open details'));

    expect(screen.queryByRole('link', { name: 'View Recording' })).toBeNull();
  });

  it('renders safe same-origin recording URLs', () => {
    sessionState.recordingUrl = '/recording.mp4';

    render(<SessionHistoryPage />);
    fireEvent.click(screen.getByText('Open details'));

    expect(screen.getByRole('link', { name: 'View Recording' })).toHaveAttribute(
      'href',
      `${window.location.origin}/recording.mp4`,
    );
  });
});
