import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub child components — we test only the sub-tab group's switching behaviour.
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

import TicketingSettingsTabs from './TicketingSettingsTabs';
import { applyLocale, i18n } from '@/lib/i18n';

describe('TicketingSettingsTabs', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    window.location.hash = '';
  });

  afterEach(async () => {
    window.location.hash = '';
    await i18n.changeLanguage('en');
  });

  it('renders all four sub-tabs and defaults to statuses', () => {
    render(<TicketingSettingsTabs />);
    expect(screen.getByTestId('ticketing-tab-statuses')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-priorities')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-categories')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-export')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-panel-statuses')).toBeInTheDocument();
  });

  it('switches tabs and (by default) syncs the URL hash', () => {
    render(<TicketingSettingsTabs />);
    fireEvent.click(screen.getByTestId('ticketing-tab-categories'));
    expect(screen.getByTestId('stub-ticket-categories-page')).toBeInTheDocument();
    expect(window.location.hash).toBe('#tab=categories');
  });

  it('honors a #tab= deep link on mount', () => {
    window.location.hash = '#tab=export';
    render(<TicketingSettingsTabs />);
    expect(screen.getByTestId('stub-billables-export-card')).toBeInTheDocument();
  });

  it('does NOT touch the URL hash when syncHash is false (embedded mode)', () => {
    window.location.hash = '#ticketing';
    render(<TicketingSettingsTabs syncHash={false} />);
    fireEvent.click(screen.getByTestId('ticketing-tab-export'));
    // Tab still switches locally...
    expect(screen.getByTestId('stub-billables-export-card')).toBeInTheDocument();
    // ...but the owning hub's top-level hash is left untouched.
    expect(window.location.hash).toBe('#ticketing');
  });

  it('seeds the initial sub-tab from the initialTab prop (deterministic deep-link)', () => {
    // The M365 consent deep-link relies on the parent passing initialTab so the group
    // opens on the right sub-tab regardless of remounts — independent of any URL param
    // the mailbox card may have already stripped.
    render(<TicketingSettingsTabs syncHash={false} initialTab="export" />);
    expect(screen.getByTestId('stub-billables-export-card')).toBeInTheDocument();
    expect(screen.queryByTestId('ticketing-tab-panel-statuses')).toBeNull();
  });

  it('ignores #tab= deep links when syncHash is false', () => {
    window.location.hash = '#tab=export';
    render(<TicketingSettingsTabs syncHash={false} />);
    // Embedded mode starts on the default statuses tab regardless of #tab=.
    expect(screen.getByTestId('ticketing-tab-panel-statuses')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-billables-export-card')).toBeNull();
  });

  it('updates already-mounted tab labels when the locale changes', async () => {
    render(<TicketingSettingsTabs />);
    expect(screen.getByTestId('ticketing-tab-categories')).toHaveTextContent('Categories');

    await act(async () => {
      await applyLocale('pt-BR');
    });

    expect(screen.getByTestId('ticketing-tab-categories')).toHaveTextContent('Categorias');
  });
});
