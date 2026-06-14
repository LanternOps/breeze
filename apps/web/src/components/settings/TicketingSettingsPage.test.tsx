import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub child components — we test only the shell's tab switching behaviour.
vi.mock('./TicketCategoriesPage', () => ({
  default: () => <div data-testid="stub-ticket-categories-page">CategoriesStub</div>
}));
vi.mock('./BillablesExportCard', () => ({
  default: () => <div data-testid="stub-billables-export-card">ExportStub</div>
}));
vi.mock('./TicketStatusesTab', () => ({
  default: () => <div data-testid="stub-ticket-statuses-tab">StatusesStub</div>
}));
vi.mock('./TicketPrioritiesTab', () => ({
  default: () => <div data-testid="stub-ticket-priorities-tab">PrioritiesStub</div>
}));

import TicketingSettingsPage from './TicketingSettingsPage';

describe('TicketingSettingsPage', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  afterEach(() => {
    window.location.hash = '';
  });

  it('renders the tab bar with all four tabs', () => {
    render(<TicketingSettingsPage />);
    const tabBar = screen.getByTestId('ticketing-settings-tabs');
    expect(tabBar).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-statuses')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-priorities')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-categories')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-export')).toBeInTheDocument();
  });

  it('defaults to the statuses tab when no hash is set', () => {
    render(<TicketingSettingsPage />);
    expect(screen.getByTestId('ticketing-tab-panel-statuses')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-ticket-categories-page')).toBeNull();
    expect(screen.queryByTestId('stub-billables-export-card')).toBeNull();
  });

  it('switching to categories tab renders TicketCategoriesPage', () => {
    render(<TicketingSettingsPage />);
    fireEvent.click(screen.getByTestId('ticketing-tab-categories'));
    expect(screen.getByTestId('stub-ticket-categories-page')).toBeInTheDocument();
    expect(screen.queryByTestId('ticketing-tab-panel-statuses')).toBeNull();
  });

  it('switching to export tab renders BillablesExportCard', () => {
    render(<TicketingSettingsPage />);
    fireEvent.click(screen.getByTestId('ticketing-tab-export'));
    expect(screen.getByTestId('stub-billables-export-card')).toBeInTheDocument();
  });

  it('switching to priorities tab renders TicketPrioritiesTab', () => {
    render(<TicketingSettingsPage />);
    fireEvent.click(screen.getByTestId('ticketing-tab-priorities'));
    expect(screen.getByTestId('ticketing-tab-panel-priorities')).toBeInTheDocument();
    expect(screen.getByTestId('stub-ticket-priorities-tab')).toBeInTheDocument();
  });

  it('tab click updates the URL hash', () => {
    render(<TicketingSettingsPage />);
    fireEvent.click(screen.getByTestId('ticketing-tab-categories'));
    expect(window.location.hash).toBe('#tab=categories');
  });

  it('tab click for statuses sets hash to #tab=statuses', () => {
    render(<TicketingSettingsPage />);
    // Switch away first
    fireEvent.click(screen.getByTestId('ticketing-tab-export'));
    fireEvent.click(screen.getByTestId('ticketing-tab-statuses'));
    expect(window.location.hash).toBe('#tab=statuses');
  });

  it('deep-link #tab=export opens the Export tab', () => {
    window.location.hash = '#tab=export';
    render(<TicketingSettingsPage />);
    expect(screen.getByTestId('stub-billables-export-card')).toBeInTheDocument();
    expect(screen.queryByTestId('ticketing-tab-panel-statuses')).toBeNull();
  });

  it('deep-link #tab=categories opens the Categories tab', () => {
    window.location.hash = '#tab=categories';
    render(<TicketingSettingsPage />);
    expect(screen.getByTestId('stub-ticket-categories-page')).toBeInTheDocument();
  });

  it('deep-link #tab=priorities opens the Priorities tab', () => {
    window.location.hash = '#tab=priorities';
    render(<TicketingSettingsPage />);
    expect(screen.getByTestId('ticketing-tab-panel-priorities')).toBeInTheDocument();
    expect(screen.getByTestId('stub-ticket-priorities-tab')).toBeInTheDocument();
  });

  it('only the active tab mounts (lazy-render)', () => {
    render(<TicketingSettingsPage />);
    // Default tab is statuses — categories and export should NOT be in the DOM
    expect(screen.queryByTestId('stub-ticket-categories-page')).toBeNull();
    expect(screen.queryByTestId('stub-billables-export-card')).toBeNull();
  });

  it('responds to external hashchange event', () => {
    render(<TicketingSettingsPage />);
    // Simulate browser back/forward or external hash change
    window.location.hash = '#tab=export';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.getByTestId('stub-billables-export-card')).toBeInTheDocument();
  });
});
