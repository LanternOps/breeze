import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

import PolicyForm from './PolicyForm';

describe('PolicyForm remove-rule button (#7158 a11y)', () => {
  it('gives the icon-only remove-rule button an accessible name', () => {
    render(<PolicyForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

    // Default rules seed with exactly one row (`required_software`), which
    // renders one Remove Rule button.
    expect(screen.getByRole('button', { name: 'Remove Rule' })).toBeInTheDocument();
  });
});
