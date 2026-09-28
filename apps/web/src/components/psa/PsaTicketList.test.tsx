import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PsaTicketList from './PsaTicketList';

describe('PsaTicketList status filter select accessible name (#7156)', () => {
  it('gives the status filter select a real accessible name', () => {
    render(<PsaTicketList tickets={[]} />);
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
  });
});
