import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PsaConnectionList from './PsaConnectionList';

describe('PsaConnectionList status filter select accessible name (#7156)', () => {
  it('gives the status filter select a real accessible name', () => {
    render(<PsaConnectionList connections={[]} />);
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
  });
});
