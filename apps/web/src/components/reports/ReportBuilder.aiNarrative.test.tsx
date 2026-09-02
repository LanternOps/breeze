import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import ReportBuilder from './ReportBuilder';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn()
}));

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

describe('ReportBuilder — ai_org_narrative is not authorable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: { rows: [] } })
    } as unknown as Response);
  });

  it('never offers the AI narrative as a create-flow report type', async () => {
    render(<ReportBuilder mode="create" />);

    // The type tiles are rendered eagerly; wait for one known tile so the
    // assertion below can't pass against an unmounted tree.
    expect(await screen.findByRole('button', { name: /devices/i })).toBeInTheDocument();
    expect(screen.queryByText('Weekly AI Operations Narrative')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /narrative/i })).not.toBeInTheDocument();
  });
});
