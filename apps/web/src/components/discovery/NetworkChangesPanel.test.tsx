import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import NetworkChangesPanel from './NetworkChangesPanel';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

vi.mock('./NetworkChangeDetailModal', () => ({
  default: () => null
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body
  } as unknown as Response;
}

type ProfileSeed = {
  id: string;
  name: string;
  alertSettings?: { enabled: boolean } | null;
};

function mockEndpoints(options: { profiles: ProfileSeed[]; changes?: unknown[] }) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url.startsWith('/discovery/profiles')) {
      return Promise.resolve(jsonResponse({ data: options.profiles }));
    }
    if (url.startsWith('/devices')) {
      return Promise.resolve(jsonResponse({ data: [] }));
    }
    if (url.startsWith('/network/changes')) {
      return Promise.resolve(jsonResponse({ data: options.changes ?? [] }));
    }
    return Promise.resolve(jsonResponse({ data: [] }));
  });
}

const baseProps = {
  currentOrgId: 'org-1',
  currentSiteId: null,
  siteOptions: [],
  timezone: 'UTC'
};

// ResponsiveTable renders both the desktop table and the mobile cards in jsdom,
// so each empty-state element appears twice — scope assertions to the desktop
// surface to avoid ambiguous multi-element matches.
function desktop() {
  return within(screen.getByTestId('responsive-table-desktop'));
}

describe('NetworkChangesPanel empty state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the Alerting prerequisite hint when no loaded profile has Alerting enabled', async () => {
    mockEndpoints({
      profiles: [{ id: 'p1', name: 'HQ sweep', alertSettings: { enabled: false } }],
      changes: []
    });

    render(<NetworkChangesPanel {...baseProps} />);

    await waitFor(() => {
      expect(desktop().getByTestId('changes-alerting-hint')).toBeInTheDocument();
    });
    expect(desktop().getByText(/Enable/)).toBeInTheDocument();
    expect(
      desktop().queryByText('No change events match the selected filters.')
    ).not.toBeInTheDocument();
  });

  it('treats a missing alertSettings object as Alerting disabled', async () => {
    mockEndpoints({
      profiles: [{ id: 'p1', name: 'HQ sweep' }],
      changes: []
    });

    render(<NetworkChangesPanel {...baseProps} />);

    await waitFor(() => {
      expect(desktop().getByTestId('changes-alerting-hint')).toBeInTheDocument();
    });
  });

  it('shows the generic "no match" empty state when at least one profile has Alerting enabled', async () => {
    mockEndpoints({
      profiles: [
        { id: 'p1', name: 'HQ sweep', alertSettings: { enabled: false } },
        { id: 'p2', name: 'Branch sweep', alertSettings: { enabled: true } }
      ],
      changes: []
    });

    render(<NetworkChangesPanel {...baseProps} />);

    await waitFor(() => {
      expect(
        desktop().getByText('No change events match the selected filters.')
      ).toBeInTheDocument();
    });
    expect(desktop().queryByTestId('changes-alerting-hint')).not.toBeInTheDocument();
  });
});
