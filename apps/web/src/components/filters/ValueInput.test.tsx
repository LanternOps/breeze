import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FilterFieldDefinition } from '@breeze/shared';

import { ValueInput } from './ValueInput';

const statusField: FilterFieldDefinition = {
  key: 'status',
  label: 'Status',
  category: 'core',
  type: 'enum',
  operators: ['equals', 'notEquals', 'in', 'notIn'],
  enumValues: ['online', 'offline', 'maintenance', 'decommissioned', 'quarantined', 'updating', 'pending']
};

describe('ValueInput', () => {
  it('labels the decommissioned status enum as Removed in the filter builder', () => {
    render(<ValueInput field={statusField} operator="equals" value="" onChange={vi.fn()} />);

    expect(screen.getByRole('option', { name: 'Removed' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Decommissioned' })).not.toBeInTheDocument();
  });
});
