import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@/lib/i18n';
import AgreementsShell from './AgreementsShell';

describe('AgreementsShell', () => {
  it('renders both tabs as real links to their own routes', () => {
    render(<AgreementsShell tab="templates"><div data-testid="child" /></AgreementsShell>);
    expect(screen.getByTestId('agreements-shell')).toBeInTheDocument();
    expect(screen.getByTestId('agreements-tab-templates')).toHaveAttribute('href', '/agreements/templates');
    expect(screen.getByTestId('agreements-tab-signed')).toHaveAttribute('href', '/agreements/signed');
    // Anchors, not buttons — a template must be linkable/bookmarkable (spec §1).
    expect(screen.getByTestId('agreements-tab-templates').tagName).toBe('A');
    expect(screen.getByTestId('agreements-tab-signed').tagName).toBe('A');
  });

  it('marks only the active tab as the current page', () => {
    const { rerender } = render(<AgreementsShell tab="templates"><div /></AgreementsShell>);
    expect(screen.getByTestId('agreements-tab-templates')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('agreements-tab-signed')).not.toHaveAttribute('aria-current');
    rerender(<AgreementsShell tab="signed"><div /></AgreementsShell>);
    expect(screen.getByTestId('agreements-tab-signed')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('agreements-tab-templates')).not.toHaveAttribute('aria-current');
  });

  // The one-line relationship sentence is the whole point of the shell (spec §3):
  // it is the only place the UI states how the three objects relate.
  it('renders the relationship sentence from the shared templatesTab description key', () => {
    render(<AgreementsShell tab="signed"><div /></AgreementsShell>);
    expect(screen.getByTestId('agreements-shell-description')).toHaveTextContent(
      /the signed copy is filed against the contract that quote creates/i,
    );
  });

  it('renders its children', () => {
    render(<AgreementsShell tab="templates"><div data-testid="child" /></AgreementsShell>);
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });
});
