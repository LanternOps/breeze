import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RingSelector from './RingSelector';

describe('RingSelector accessible name (#7156)', () => {
  it('ties the "Update Ring:" label to the select via htmlFor/id', () => {
    render(<RingSelector rings={[]} selectedRingId={null} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Update Ring:' })).toBeInTheDocument();
  });
});
