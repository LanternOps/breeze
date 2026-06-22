import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

type AlertSettingsSeed = {
  enabled?: boolean;
  alertOnNew?: boolean;
  alertOnChanged?: boolean;
  alertOnDisappeared?: boolean;
};

type ProfileSeed = {
  id: string;
  name: string;
  siteId?: string;
  alertSettings?: AlertSettingsSeed | null;
};

// A profile that actually records changes: master switch on + a recording toggle.
const RECORDING: AlertSettingsSeed = { enabled: true, alertOnNew: true };

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
  siteOptions: [
    { id: 'site-1', name: 'Site One' },
    { id: 'site-2', name: 'Site Two' }
  ],
  timezone: 'UTC'
};

// ResponsiveTable renders both the desktop table and the mobile cards in jsdom,
// so each empty-state element appears twice — scope assertions to the desktop
// surface to avoid ambiguous multi-element matches.
function desktop() {
  return within(screen.getByTestId('responsive-table-desktop'));
}

async function selectProfile(profileId: string) {
  const select = screen.getByLabelText('Profile') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: profileId } });
}

async function selectSite(siteId: string) {
  const select = screen.getByLabelText('Site') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: siteId } });
}

describe('NetworkChangesPanel empty state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the prerequisite hint when no loaded profile records changes', async () => {
    mockEndpoints({
      profiles: [{ id: 'p1', name: 'HQ sweep', alertSettings: { enabled: false } }],
      changes: []
    });

    render(<NetworkChangesPanel {...baseProps} />);

    await waitFor(() => {
      expect(desktop().getByTestId('changes-alerting-hint')).toBeInTheDocument();
    });
    expect(
      desktop().queryByText('No change events match the selected filters.')
    ).not.toBeInTheDocument();
  });

  it('treats a missing alertSettings object as not recording', async () => {
    mockEndpoints({
      profiles: [{ id: 'p1', name: 'HQ sweep' }],
      changes: []
    });

    render(<NetworkChangesPanel {...baseProps} />);

    await waitFor(() => {
      expect(desktop().getByTestId('changes-alerting-hint')).toBeInTheDocument();
    });
  });

  it('treats master-enabled-but-all-sub-toggles-off as not recording', async () => {
    mockEndpoints({
      profiles: [{
        id: 'p1',
        name: 'HQ sweep',
        alertSettings: {
          enabled: true,
          alertOnNew: false,
          alertOnChanged: false,
          alertOnDisappeared: false
        }
      }],
      changes: []
    });

    render(<NetworkChangesPanel {...baseProps} />);

    await waitFor(() => {
      expect(desktop().getByTestId('changes-alerting-hint')).toBeInTheDocument();
    });
  });

  it('shows the generic empty state when at least one profile records changes', async () => {
    mockEndpoints({
      profiles: [
        { id: 'p1', name: 'HQ sweep', alertSettings: { enabled: false } },
        { id: 'p2', name: 'Branch sweep', alertSettings: RECORDING }
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

  it('shows the profile-named hint when a selected profile does not record changes', async () => {
    mockEndpoints({
      profiles: [
        { id: 'p1', name: 'HQ sweep', alertSettings: { enabled: false } },
        { id: 'p2', name: 'Branch sweep', alertSettings: RECORDING }
      ],
      changes: []
    });

    render(<NetworkChangesPanel {...baseProps} />);

    // With p2 recording, the default 'all' view shows the generic message.
    await waitFor(() => {
      expect(
        desktop().getByText('No change events match the selected filters.')
      ).toBeInTheDocument();
    });

    await selectProfile('p1');

    await waitFor(() => {
      expect(desktop().getByTestId('changes-alerting-hint')).toBeInTheDocument();
    });
    // Names the specific profile, not the generic copy.
    expect(desktop().getByText(/HQ sweep/)).toBeInTheDocument();
  });

  it('shows the generic empty state when a selected profile records changes', async () => {
    mockEndpoints({
      profiles: [
        { id: 'p1', name: 'HQ sweep', alertSettings: { enabled: false } },
        { id: 'p2', name: 'Branch sweep', alertSettings: RECORDING }
      ],
      changes: []
    });

    render(<NetworkChangesPanel {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByLabelText('Profile')).toBeInTheDocument();
    });

    await selectProfile('p2');

    await waitFor(() => {
      expect(
        desktop().getByText('No change events match the selected filters.')
      ).toBeInTheDocument();
    });
    expect(desktop().queryByTestId('changes-alerting-hint')).not.toBeInTheDocument();
  });

  it('scopes the all-disabled hint to the active site filter', async () => {
    mockEndpoints({
      profiles: [
        { id: 'p1', name: 'Site1 sweep', siteId: 'site-1', alertSettings: { enabled: false } },
        { id: 'p2', name: 'Site2 sweep', siteId: 'site-2', alertSettings: RECORDING }
      ],
      changes: []
    });

    render(<NetworkChangesPanel {...baseProps} />);

    // 'all' sites + one recording profile → generic message.
    await waitFor(() => {
      expect(
        desktop().getByText('No change events match the selected filters.')
      ).toBeInTheDocument();
    });

    // Narrow to site-1, whose only profile is disabled → hint appears.
    await selectSite('site-1');

    await waitFor(() => {
      expect(desktop().getByTestId('changes-alerting-hint')).toBeInTheDocument();
    });
  });

  it('shows no hint when profiles fail to load (empty list)', async () => {
    mockEndpoints({ profiles: [], changes: [] });

    render(<NetworkChangesPanel {...baseProps} />);

    await waitFor(() => {
      expect(
        desktop().getByText('No change events match the selected filters.')
      ).toBeInTheDocument();
    });
    expect(desktop().queryByTestId('changes-alerting-hint')).not.toBeInTheDocument();
  });
});
