import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PolicyForm from './PolicyForm';

describe('PolicyForm remove-rule button (#7158 a11y)', () => {
  it('gives the icon-only remove-rule button an accessible name', () => {
    render(<PolicyForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

    // Default rules seed with exactly one row (`required_software`), which
    // renders one Remove Rule button.
    expect(screen.getByRole('button', { name: 'Remove Rule' })).toBeInTheDocument();
  });
});

describe('PolicyForm filter selects accessible name (#7156)', () => {
  it('gives the target type select a real accessible name', () => {
    render(<PolicyForm />);
    expect(screen.getByRole('combobox', { name: 'Target Type' })).toBeInTheDocument();
  });

  it('gives every default rule row a named rule-type and version-check select', () => {
    render(<PolicyForm />);

    // The form starts with one default rule (required_software), which shows
    // the version-check select.
    expect(screen.getAllByRole('combobox', { name: 'Rule type' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('combobox', { name: 'Version Check' }).length).toBeGreaterThan(0);
  });
});
