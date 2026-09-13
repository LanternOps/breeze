import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import MonitoringTabStrip from './MonitoringTabStrip';

describe('MonitoringTabStrip (#5288, #5289)', () => {
  it('renders all four tabs with the right hrefs', () => {
    render(<MonitoringTabStrip currentPath="/monitoring/delivery" />);
    expect(screen.getByRole('link', { name: 'Network' })).toHaveAttribute('href', '/monitoring');
    expect(screen.getByRole('link', { name: 'Monitors' })).toHaveAttribute('href', '/monitoring/monitors');
    expect(screen.getByRole('link', { name: 'Delivery' })).toHaveAttribute('href', '/monitoring/delivery');
    expect(screen.getByRole('link', { name: 'Legacy rules' })).toHaveAttribute('href', '/monitoring/rules');
  });

  it('marks the current path active and leaves the others unmarked', () => {
    render(<MonitoringTabStrip currentPath="/monitoring/delivery" />);
    expect(screen.getByRole('link', { name: 'Delivery' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Monitors' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Network' })).not.toHaveAttribute('aria-current');
  });

  it('marks Monitors active for the monitors list and for a monitor editor path', () => {
    render(<MonitoringTabStrip currentPath="/monitoring/monitors/abc" />);
    expect(screen.getByRole('link', { name: 'Monitors' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Network' })).not.toHaveAttribute('aria-current');
  });

  it('marks Network active for the hub root (network monitoring is the default tab)', () => {
    render(<MonitoringTabStrip currentPath="/monitoring" />);
    expect(screen.getByRole('link', { name: 'Network' })).toHaveAttribute('aria-current', 'page');
  });

  it('marks Legacy rules active for the rules page', () => {
    render(<MonitoringTabStrip currentPath="/monitoring/rules" />);
    expect(screen.getByRole('link', { name: 'Legacy rules' })).toHaveAttribute('aria-current', 'page');
  });
});
