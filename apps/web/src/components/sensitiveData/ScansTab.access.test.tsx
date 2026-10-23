import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ScansTab from './ScansTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('./CreateScanModal', () => ({ default: () => null }));

describe('ScansTab access state (#9697)', () => {
  it('shows the no-access state on a 403', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      { ok: false, status: 403, json: async () => ({ error: 'denied' }) } as unknown as Response
    );
    render(<ScansTab />);
    expect(await screen.findByText(/You don't have access to this organization/i)).toBeInTheDocument();
    expect(screen.queryByText('Failed to fetch scans')).not.toBeInTheDocument();
  });
});
