import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PolicyList from './PolicyList';

describe('PolicyList filter selects accessible name (#7156)', () => {
  it('gives the enforcement and status filter selects a real accessible name', () => {
    render(<PolicyList policies={[]} />);

    expect(screen.getByRole('combobox', { name: 'Enforcement' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
  });
});
