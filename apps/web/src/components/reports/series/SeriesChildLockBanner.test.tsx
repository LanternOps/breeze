import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ canChoose: true }));
vi.mock('../ReportOwnerScopeField', () => ({ useDefaultReportOwnerScope: () => ({ canChoose: gate.canChoose }) }));
const claims = vi.hoisted(() => ({ value: { status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } } as unknown }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => claims.value }));
const api = vi.hoisted(() => ({
  fetchSeriesDetail: vi.fn(),
  detachSeriesChild: vi.fn(() => Promise.resolve()),
  fetchOrgContacts: vi.fn(() => Promise.resolve([])),
  fetchChildOverrides: vi.fn(() => Promise.resolve([])),
  setChildRecipientOverride: vi.fn(),
}));
vi.mock('./seriesApi', () => api);

import { SeriesChildView } from './SeriesChildLockBanner';
import type { Report } from '../ReportsList';

const CHILD = {
  id: 'rep-child', name: 'Monthly health', type: 'device_inventory', schedule: 'monthly', format: 'pdf', config: {},
  orgId: 'org-1', partnerId: null, portalSelfService: false, lastGeneratedAt: null, createdAt: '', updatedAt: '',
  seriesId: 's-1', seriesName: 'Monthly health', archivedAt: null,
} as Report;

describe('SeriesChildView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gate.canChoose = true;
    claims.value = { status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } };
    api.fetchSeriesDetail.mockResolvedValue({ series: { recipientRule: { primaryContact: true, roles: [] } }, targets: [], orgs: [] });
  });

  it('an MSP user sees the series name, Edit multi-org report and Detach, plus recipients', async () => {
    render(<SeriesChildView report={CHILD} onChanged={vi.fn()} />);
    const banner = screen.getByTestId('series-child-lock-banner');
    expect(banner).toHaveAttribute('data-variant', 'msp');
    expect(banner).toHaveTextContent('Part of the multi-org report “Monthly health”');
    expect(screen.getByTestId('series-child-edit-series')).toHaveAttribute('href', '/reports/series/s-1');
    expect(screen.getByTestId('series-child-detach')).toBeInTheDocument();
    expect(screen.getByTestId('series-child-summary')).toBeInTheDocument();
    expect(await screen.findByTestId('series-child-recipients')).toBeInTheDocument();
    await waitFor(() => expect(api.fetchSeriesDetail).toHaveBeenCalledWith('s-1'));
  });

  // Review Focus 5.
  it('an organization user sees Managed by your MSP and never asks for the series', async () => {
    gate.canChoose = false;
    claims.value = { status: 'resolved', claims: { scope: 'organization', partnerId: 'p-1', orgId: 'org-1' } };
    render(<SeriesChildView report={CHILD} onChanged={vi.fn()} />);
    expect(screen.getByTestId('series-child-lock-banner')).toHaveAttribute('data-variant', 'managed');
    expect(screen.getByTestId('series-child-managed-badge')).toHaveTextContent('Managed by your MSP');
    expect(screen.queryByTestId('series-child-edit-series')).toBeNull();
    expect(screen.queryByTestId('series-child-detach')).toBeNull();
    expect(await screen.findByTestId('series-child-recipients')).toBeInTheDocument();
    expect(api.fetchSeriesDetail).not.toHaveBeenCalled();
  });

  it('Detach confirms, detaches, and reloads the page state', async () => {
    const onChanged = vi.fn();
    render(<SeriesChildView report={CHILD} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('series-child-detach'));
    fireEvent.click(screen.getByTestId('series-confirm-child-detach'));
    await waitFor(() => expect(api.detachSeriesChild).toHaveBeenCalledWith('rep-child', expect.anything()));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('an archived copy says so and offers no recipient editing or Detach', () => {
    render(<SeriesChildView report={{ ...CHILD, archivedAt: '2026-10-02T00:00:00Z' }} onChanged={vi.fn()} />);
    expect(screen.getByTestId('series-child-archived')).toBeInTheDocument();
    expect(screen.queryByTestId('series-child-detach')).toBeNull();
    expect(screen.queryByTestId('series-child-recipients')).toBeNull();
  });
});
