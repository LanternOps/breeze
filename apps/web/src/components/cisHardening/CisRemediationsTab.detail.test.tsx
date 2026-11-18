import '@/lib/i18n';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: (selector: (s: { user: null }) => unknown) => selector({ user: null }),
  registerOrgIdProvider: vi.fn(),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => false }),
}));

import CisRemediationsTab from './CisRemediationsTab';

// #9606: the API stores approver, approval time, before/after state and a
// rollback hint; the table showed none of it.
const DONE = {
  id: 'rem-done',
  checkId: '1.1.1',
  deviceId: 'dev-1',
  baselineId: null,
  action: 'apply',
  status: 'completed',
  approvalStatus: 'approved',
  requestedBy: 'u1',
  approvedBy: 'u2',
  approverName: 'Dana Approver',
  approvedAt: '2026-10-01T01:00:00.000Z',
  approvalNote: 'Change window agreed',
  beforeState: { MinimumPasswordLength: 8 },
  afterState: { MinimumPasswordLength: 14 },
  rollbackHint: 'Set MinimumPasswordLength back to 8',
  createdAt: '2026-10-01T00:00:00.000Z',
  executedAt: '2026-10-01T02:00:00.000Z',
  deviceHostname: 'host.corp.example.internal',
  deviceDisplayName: 'Reception PC',
  baselineName: null,
};
const BARE = {
  ...DONE,
  id: 'rem-bare',
  approvedBy: null,
  approverName: null,
  approvedAt: null,
  approvalNote: null,
  beforeState: null,
  afterState: null,
  rollbackHint: null,
  deviceDisplayName: null,
  deviceHostname: 'bare-host',
};

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockResolvedValue({
    ok: true, status: 200, statusText: 'OK',
    json: async () => ({ data: [DONE, BARE] }),
  });
});

describe('CisRemediationsTab evidence detail row (#9606)', () => {
  it('shows the display name (hostname fallback) in the table', async () => {
    render(<CisRemediationsTab refreshKey={0} />);
    expect(await screen.findByText('Reception PC')).toBeInTheDocument();
    expect(screen.getByText('bare-host')).toBeInTheDocument();
  });

  it('expands to approver, approval time, before/after and rollback hint', async () => {
    render(<CisRemediationsTab refreshKey={0} />);
    await screen.findByTestId('cis-remediation-row-rem-done');
    expect(screen.queryByTestId('cis-remediation-detail-rem-done')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('cis-remediation-toggle-rem-done'));
    const detail = screen.getByTestId('cis-remediation-detail-rem-done');
    expect(within(detail).getByText('Dana Approver')).toBeInTheDocument();
    expect(within(detail).getByText('Change window agreed')).toBeInTheDocument();
    expect(detail).toHaveTextContent('"MinimumPasswordLength": 8');
    expect(detail).toHaveTextContent('"MinimumPasswordLength": 14');
    expect(within(detail).getByText('Set MinimumPasswordLength back to 8')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('cis-remediation-toggle-rem-done'));
    expect(screen.queryByTestId('cis-remediation-detail-rem-done')).not.toBeInTheDocument();
  });

  it('says so when no evidence was recorded instead of rendering blanks', async () => {
    render(<CisRemediationsTab refreshKey={0} />);
    await screen.findByTestId('cis-remediation-row-rem-bare');
    fireEvent.click(screen.getByTestId('cis-remediation-toggle-rem-bare'));
    expect(screen.getByTestId('cis-remediation-detail-rem-bare')).toHaveTextContent(/no evidence recorded/i);
  });
});
