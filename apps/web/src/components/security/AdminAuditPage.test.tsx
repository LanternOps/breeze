import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue({ data: [] }),
  }),
}));

import AdminAuditPage from './AdminAuditPage';

describe('AdminAuditPage filter selects accessible name (#7156)', () => {
  it('gives the issue and OS filter selects a real accessible name', async () => {
    render(<AdminAuditPage />);
    expect(await screen.findByRole('combobox', { name: 'Issue filter' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Operating system' })).toBeInTheDocument();
  });
});
