import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  // Stub the child so tests can drive the page's own callbacks directly: an
  // "Open details" button (recording-URL safe-href tests) and an "Export"
  // button that fires the page's real handleExport (CSV export test).
  default: ({
    onViewDetails,
    onExport,
  }: {
    onViewDetails?: (session: RemoteSession) => void;
    onExport?: () => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => onViewDetails?.({ ...sessionState.session, recordingUrl: sessionState.recordingUrl })}
      >
        Open details
      </button>
      <button type="button" onClick={() => onExport?.()}>
        Export
      </button>
    </div>
  ),
  // Identity so the raw API session shape flows straight into handleExport's
  // CSV row builder.
  normalizeRemoteSession: vi.fn((value: RemoteSession) => value),
}));

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

import SessionHistoryPage from './SessionHistoryPage';
import { fetchWithAuth } from '@/stores/auth';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeJsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

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

// Regression guard: the CSV export was changed from genuinely-broken hand-rolled
// quoting (no quote-doubling, no formula neutralization) to the shared
// `toCsv(...)`. Prove an attacker-influenced session field (deviceHostname /
// userName are agent-reported) is BOTH formula-neutralized (leading ') and
// RFC-4180 quoted in the exported blob.
describe('SessionHistoryPage CSV export', () => {
  let capturedBlob: Blob | null;

  beforeEach(() => {
    capturedBlob = null;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        capturedBlob = blob;
        return 'blob:mock';
      }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('neutralizes and RFC-4180-quotes formula injection from agent-supplied fields', async () => {
    // One page with total=1 so handleExport's pagination loop terminates after
    // a single fetch. normalizeRemoteSession is the identity stub, so these raw
    // fields flow straight into the CSV row builder.
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: [
          {
            id: 'sess-1',
            deviceId: 'dev-1',
            deviceHostname: '=cmd()|/C calc', // formula-injection payload
            deviceOsType: 'windows',
            userId: 'user-1',
            userName: 'evil "quote"', // embedded double-quote → must be doubled
            userEmail: 'evil@example.com',
            type: 'terminal',
            status: 'disconnected',
            startedAt: '2026-06-01T00:00:00.000Z',
            endedAt: '2026-06-01T00:05:00.000Z',
            durationSeconds: 300,
            bytesTransferred: 2048,
            createdAt: '2026-06-01T00:00:00.000Z',
          },
        ],
        pagination: { total: 1 },
      }),
    );

    render(<SessionHistoryPage />);

    fireEvent.click(screen.getByText('Export'));

    await waitFor(() => {
      expect(capturedBlob).not.toBeNull();
    });

    const csv = await capturedBlob!.text();

    // Formula char neutralized with a leading single quote AND the cell is quoted.
    expect(csv).toContain('"\'=cmd()|/C calc"');
    // Embedded double-quote doubled inside the quoted cell.
    expect(csv).toContain('"evil ""quote"""');
    // Header row still present.
    expect(csv.split('\n')[0]).toContain('Device');
  });
});
