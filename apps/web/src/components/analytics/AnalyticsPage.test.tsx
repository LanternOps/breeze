import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue({ data: [] }),
  }),
}));

import AnalyticsPage from './AnalyticsPage';

describe('AnalyticsPage date-range select accessible name (#7156)', () => {
  it('gives the date-range select a real accessible name', async () => {
    render(<AnalyticsPage />);
    expect(await screen.findByRole('combobox', { name: 'Date range' })).toBeInTheDocument();
  });
});
