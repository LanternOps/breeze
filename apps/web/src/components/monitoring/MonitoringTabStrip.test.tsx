import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import MonitoringTabStrip from './MonitoringTabStrip';

describe('MonitoringTabStrip (#5288)', () => {
  it('renders Network and Delivery and marks the current path active', () => {
    render(<MonitoringTabStrip currentPath="/monitoring/delivery" />);
    const network = screen.getByRole('link', { name: 'Network' });
    const delivery = screen.getByRole('link', { name: 'Delivery' });
    expect(network).toHaveAttribute('href', '/monitoring');
    expect(delivery).toHaveAttribute('href', '/monitoring/delivery');
    expect(delivery).toHaveAttribute('aria-current', 'page');
    expect(network).not.toHaveAttribute('aria-current');
  });
});
