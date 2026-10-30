import '@/lib/i18n';
import { render, screen, within } from '@testing-library/react';
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

const row = (id: string, status: string, approvalStatus: string) => ({
  id,
  checkId: `1.1.${id}`,
  deviceId: 'dev-1',
  baselineId: null,
  action: 'apply',
  status,
  approvalStatus,
  requestedBy: 'u1',
  approvedBy: null,
  approverName: null,
  approvedAt: null,
  approvalNote: null,
  beforeState: null,
  afterState: null,
  rollbackHint: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  executedAt: null,
  deviceHostname: `host-${id}`,
  deviceDisplayName: null,
  baselineName: null,
});

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockResolvedValue({
    ok: true, status: 200, statusText: 'OK',
    json: async () => ({
      data: [
        row('1', 'pending_approval', 'pending'),
        row('2', 'in_progress', 'approved'),
        row('3', 'queued', 'rejected'),
      ],
    }),
  });
});

// #9929: the filter used camelCase keys ("Pending Approval", "In Progress")
// while the other options and the row badges used lowercase snake-case keys,
// so the dropdown mixed title-case and lowercase labels and disagreed with the
// badges for the same status value.
describe('CisRemediationsTab status labels (#9929)', () => {
  it('renders every status filter option in one consistent sentence case', async () => {
    render(<CisRemediationsTab refreshKey={0} />);
    const select = await screen.findByRole('combobox', { name: 'Status' });
    const labels = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(labels).toEqual([
      'All statuses',
      'Pending approval',
      'Queued',
      'In progress',
      'Completed',
      'Failed',
      'Cancelled',
    ]);
  });

  it('labels row badges with the same text as the matching filter option', async () => {
    render(<CisRemediationsTab refreshKey={0} />);
    await screen.findByText('host-1');
    const select = screen.getByRole('combobox', { name: 'Status' });
    const optionText = (value: string) =>
      within(select).getAllByRole('option').find((o) => (o as HTMLOptionElement).value === value)?.textContent;

    const rowOf = (host: string) => screen.getByText(host).closest('tr') as HTMLElement;
    expect(within(rowOf('host-1')).getByText(optionText('pending_approval')!)).toBeInTheDocument();
    expect(within(rowOf('host-2')).getByText(optionText('in_progress')!)).toBeInTheDocument();
    expect(within(rowOf('host-3')).getByText(optionText('queued')!)).toBeInTheDocument();

    // Approval badges are humanized too, not raw lowercase enum values.
    expect(within(rowOf('host-1')).getByText('Pending')).toBeInTheDocument();
    expect(within(rowOf('host-2')).getByText('Approved')).toBeInTheDocument();
    expect(within(rowOf('host-3')).getByText('Rejected')).toBeInTheDocument();
  });
});
