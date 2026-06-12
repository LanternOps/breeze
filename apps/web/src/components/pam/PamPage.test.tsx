import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PamPage from './PamPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

const subscribeMock = vi.fn();
const unsubscribeMock = vi.fn();
vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: vi.fn(() => ({
    connected: true,
    subscribe: subscribeMock,
    unsubscribe: unsubscribeMock,
  })),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function emptyListResponse(): Response {
  return makeJsonResponse({
    success: true,
    requests: [],
    active: [],
    rules: [],
    pagination: { page: 1, limit: 50, total: 0 },
  });
}

describe('PamPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    fetchWithAuthMock.mockImplementation(async () => emptyListResponse());
  });

  it('renders the heading, live indicator, and overview tab by default', async () => {
    render(<PamPage />);
    expect(screen.getByTestId('pam-heading')).toBeInTheDocument();
    expect(screen.getByTestId('pam-live-indicator')).toHaveTextContent('Live');
    await waitFor(() => {
      expect(screen.getByTestId('pam-stat-active')).toBeInTheDocument();
    });
  });

  it('subscribes to elevation events on mount', () => {
    render(<PamPage />);
    expect(subscribeMock).toHaveBeenCalledWith(
      expect.arrayContaining(['elevation.requested', 'elevation.approved', 'elevation.revoked']),
    );
  });

  it('switches tabs via the tab bar and updates the hash', async () => {
    render(<PamPage />);
    fireEvent.click(screen.getByTestId('pam-tab-rules'));
    expect(window.location.hash).toBe('#rules');
    await waitFor(() => {
      expect(screen.getByTestId('pam-add-rule-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('pam-tab-requests'));
    expect(window.location.hash).toBe('#requests');
    await waitFor(() => {
      expect(screen.getByTestId('pam-filter-status')).toBeInTheDocument();
    });
  });

  it('honors a deep-link hash on first render', async () => {
    window.location.hash = '#audit';
    render(<PamPage />);
    await waitFor(() => {
      expect(screen.getByTestId('pam-audit-export-btn')).toBeInTheDocument();
    });
  });
});
