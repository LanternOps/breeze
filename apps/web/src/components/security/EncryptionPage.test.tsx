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

import EncryptionPage from './EncryptionPage';

describe('EncryptionPage filter selects accessible name (#7156)', () => {
  it('gives the status/OS/escrow filter selects a real accessible name', async () => {
    render(<EncryptionPage />);
    expect(await screen.findByRole('combobox', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Operating system' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Key escrow' })).toBeInTheDocument();
  });
});
