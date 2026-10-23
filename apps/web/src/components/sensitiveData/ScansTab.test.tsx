import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ScansTab from './ScansTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('./CreateScanModal', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);

const makeScan = (id: string, summary: Record<string, unknown>) => ({
  id,
  orgId: 'org-1',
  deviceId: 'dev-1',
  deviceName: `host-${id}`,
  policyId: null,
  status: 'completed',
  startedAt: '2026-05-21T00:00:00Z',
  completedAt: '2026-05-21T00:05:00Z',
  summary,
  createdAt: '2026-05-21T00:00:00Z',
});

describe('ScansTab findings column (#9682)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('renders summary.findings.total and falls back to "-" when absent', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [makeScan('a', { findings: { total: 42 } }), makeScan('b', {})],
      }),
    } as Response);

    render(<ScansTab />);

    await waitFor(() => expect(screen.getByText('host-a')).toBeTruthy());
    const cellsA = screen.getByText('host-a').closest('tr')!.querySelectorAll('td');
    const cellsB = screen.getByText('host-b').closest('tr')!.querySelectorAll('td');
    const findingsText = (cells: NodeListOf<Element>) =>
      Array.from(cells).map((c) => c.textContent?.trim());
    expect(findingsText(cellsA)).toContain('42');
    expect(findingsText(cellsB)).toContain('-');
    expect(findingsText(cellsB)).not.toContain('42');
  });
});
