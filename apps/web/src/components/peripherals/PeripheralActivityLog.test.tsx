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

import PeripheralActivityLog from './PeripheralActivityLog';

describe('PeripheralActivityLog event-filter select accessible name (#7156)', () => {
  it('gives the event-type filter select a real accessible name', async () => {
    render(<PeripheralActivityLog />);
    expect(await screen.findByRole('combobox', { name: 'Event type' })).toBeInTheDocument();
  });
});
