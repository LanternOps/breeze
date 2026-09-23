import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import SystemDeprecationsPage from './SystemDeprecationsPage';

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const ENTRY = {
  id: 'ticket-labour-pricing-fields',
  title: 'Labour-pricing fields retired',
  kind: 'api-request-field',
  surfaces: [
    { endpoint: 'PATCH /api/v1/ticket-categories/:id', fields: ['defaultBillable', 'defaultHourlyRate'] },
    { endpoint: 'GET /api/v1/legacy', fields: [] },
  ],
  replacement: 'Billing profiles.',
  deprecatedIn: '0.115.0',
  deprecationBehaviour: 'Ignored.',
  earliestRemovalDate: '2026-09-22',
  removedIn: '0.116.0',
  removalBehaviour: 'Rejected with HTTP 400.',
  references: ['#4628'],
};

const UPCOMING = {
  ...ENTRY,
  id: 'future-thing',
  title: 'Future thing',
  surfaces: [{ endpoint: 'GET /api/v1/things', fields: ['old'] }],
  replacement: 'Use new.',
  deprecatedIn: '0.117.0',
  earliestRemovalDate: '2027-01-01',
  removedIn: null,
};

function report(overrides: Record<string, unknown> = {}) {
  return {
    currentVersion: '0.116.0',
    rawCurrentVersion: '0.116.0',
    lastRecordedVersion: '0.116.0',
    historyKnown: true,
    historyNote: null,
    manifestError: null,
    ledger: { status: 'ok', appliedCount: 612, pendingCount: 0 },
    history: {
      status: 'ok',
      versions: [
        { version: '0.116.0', firstSeenAt: '2026-09-23T00:00:00.000Z' },
        { version: '0.115.0', firstSeenAt: '2026-09-01T00:00:00.000Z' },
      ],
    },
    entries: [
      { ...ENTRY, status: 'in_effect', milestone: 'removal' },
      { ...UPCOMING, status: 'upcoming', milestone: null },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('SystemDeprecationsPage', () => {
  it('reads the report from the platform-admin route', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: report() }));
    render(<SystemDeprecationsPage />);
    await screen.findByTestId('deprecations-table');
    expect(fetchWithAuth).toHaveBeenCalledWith('/admin/deprecations');
  });

  it('renders one row per retirement with surfaces, replacement, versions and status', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: report() }));
    render(<SystemDeprecationsPage />);
    const row = await screen.findByTestId('deprecation-row-ticket-labour-pricing-fields');
    expect(row.textContent).toContain('Labour-pricing fields retired');
    expect(row.textContent).toContain('PATCH /api/v1/ticket-categories/:id');
    expect(row.textContent).toContain('defaultHourlyRate');
    expect(row.textContent).toContain('GET /api/v1/legacy');
    expect(row.textContent).toContain('Billing profiles.');
    expect(row.textContent).toContain('0.115.0');
    expect(row.textContent).toContain('0.116.0');
    expect(within(row).getByTestId('deprecation-status').textContent).toMatch(/in effect/i);

    const upcoming = screen.getByTestId('deprecation-row-future-thing');
    // No removal version yet: the earliest removal date stands in.
    expect(upcoming.textContent).toContain('2027-01-01');
    expect(within(upcoming).getByTestId('deprecation-status').textContent).toMatch(/upcoming/i);
  });

  it('lists the recorded version history and migration counts', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: report() }));
    render(<SystemDeprecationsPage />);
    const history = await screen.findByTestId('deprecations-version-history');
    const items = within(history).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining('0.116.0'), expect.stringContaining('0.115.0')]);
    expect(screen.getByTestId('deprecations-ledger').textContent).toMatch(/612/);
    expect(screen.queryByTestId('deprecations-history-missing')).toBeNull();
  });

  it('shows the missing-history banner and "possibly crossed" status when history is unknown', async () => {
    fetchWithAuth.mockResolvedValue(
      jsonRes({
        data: report({
          historyKnown: false,
          lastRecordedVersion: null,
          historyNote: 'could not read breeze_version_history: permission denied',
          history: { status: 'missing', reason: 'could not read breeze_version_history: permission denied' },
          entries: [{ ...ENTRY, status: 'possibly_crossed', milestone: 'removal' }],
        }),
      }),
    );
    render(<SystemDeprecationsPage />);
    const banner = await screen.findByTestId('deprecations-history-missing');
    expect(banner.textContent).toMatch(/could not determine which versions this deployment ran/i);
    expect(banner.textContent).toMatch(/showing every retirement in effect/i);
    expect(banner.textContent).toContain('permission denied');
    const row = screen.getByTestId('deprecation-row-ticket-labour-pricing-fields');
    expect(within(row).getByTestId('deprecation-status').textContent).toMatch(/possibly crossed/i);
  });

  it('shows the missing-history banner for an empty history as well', async () => {
    fetchWithAuth.mockResolvedValue(
      jsonRes({
        data: report({
          historyKnown: false,
          lastRecordedVersion: null,
          historyNote: 'the version history is empty',
          history: { status: 'ok', versions: [] },
        }),
      }),
    );
    render(<SystemDeprecationsPage />);
    await screen.findByTestId('deprecations-history-missing');
  });

  it('shows a platform-admin-required panel on a 403', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: 'platform admin access required' }, 403));
    render(<SystemDeprecationsPage />);
    await screen.findByTestId('deprecations-requires-platform-admin');
    expect(screen.queryByTestId('deprecations-table')).toBeNull();
  });

  it('shows an error, not an empty "no issues" table, when the request fails', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: 'boom' }, 500));
    render(<SystemDeprecationsPage />);
    await screen.findByTestId('deprecations-error');
    expect(screen.queryByTestId('deprecations-table')).toBeNull();
  });

  it('offers no edit controls: it is a report, not a setting', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: report() }));
    render(<SystemDeprecationsPage />);
    await screen.findByTestId('deprecations-table');
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });
});
