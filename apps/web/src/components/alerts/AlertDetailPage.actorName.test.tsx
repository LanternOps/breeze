import { render, screen, waitFor } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The page renders a remediation panel that fetches on mount; stub it so this
// suite stays focused on the "Acknowledged by / Resolved by" rendering.
vi.mock('../remediation/RemediationSuggestionsPanel', () => ({
  default: () => null,
}));

const fetchWithAuth = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

import AlertDetailPage from './AlertDetailPage';

const ACK_USER_ID = '9cea2f85-2da1-445d-88cc-7c404d7504c4';
const RESOLVE_USER_ID = '1f0e3f2c-9a2b-4c7d-9f10-8f6a2b3c4d5e';

type RawAlert = {
  id: string;
  title: string;
  message: string;
  severity: string;
  status: string;
  deviceId: string;
  deviceName: string;
  triggeredAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  acknowledgedByName?: string | null;
  resolvedAt?: string;
  resolvedBy?: string;
  resolvedByName?: string | null;
};

const baseAlert: RawAlert = {
  id: 'a-1',
  title: 'CPU high',
  message: 'CPU over 90%',
  severity: 'critical',
  status: 'acknowledged',
  deviceId: 'd-1',
  deviceName: 'web-01',
  triggeredAt: '2026-08-24T16:00:00Z',
  acknowledgedAt: '2026-08-24T17:00:19Z',
};

function mockFetch(alert: RawAlert) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url.endsWith('/tickets')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [] }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(alert),
    });
  });
}

function renderPage(alert: RawAlert) {
  mockFetch(alert);
  return render(<AlertDetailPage alertId={alert.id} />);
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('AlertDetailPage — acknowledged/resolved actor (#3966)', () => {
  it('shows the technician’s name instead of the raw user id', async () => {
    const { container } = renderPage({
      ...baseAlert,
      acknowledgedBy: ACK_USER_ID,
      acknowledgedByName: 'Breeze Admin',
    });

    await screen.findByText(/Breeze Admin/);
    expect(container.textContent).not.toContain(ACK_USER_ID);
  });

  it('keeps the raw id available as a tooltip for tooling', async () => {
    const { container } = renderPage({
      ...baseAlert,
      acknowledgedBy: ACK_USER_ID,
      acknowledgedByName: 'Breeze Admin',
    });

    await screen.findByText(/Breeze Admin/);
    expect(container.querySelector(`[title="${ACK_USER_ID}"]`)).toBeTruthy();
  });

  it('falls back to a generic label — never the UUID — when the name is unknown', async () => {
    const { container } = renderPage({
      ...baseAlert,
      acknowledgedBy: ACK_USER_ID,
      acknowledgedByName: null,
    });

    await screen.findByText(/Unknown user/);
    expect(container.textContent).not.toContain(ACK_USER_ID);
  });

  it('resolves the resolvedBy actor the same way', async () => {
    const { container } = renderPage({
      ...baseAlert,
      status: 'resolved',
      resolvedAt: '2026-08-24T18:00:00Z',
      resolvedBy: RESOLVE_USER_ID,
      resolvedByName: 'Dana Tech',
    });

    await screen.findByText(/Dana Tech/);
    await waitFor(() => expect(container.textContent).not.toContain(RESOLVE_USER_ID));
  });
});
