import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CoversCell } from './CoversCell';

describe('CoversCell (multi-org report series W01)', () => {
  it('names the org of an org-owned report', () => {
    render(<CoversCell testId="c" orgId="org-a" orgName="Acme Dental" />);
    const cell = screen.getByTestId('c');
    expect(cell).toHaveAttribute('data-covers-kind', 'org');
    expect(cell).toHaveTextContent('Acme Dental');
  });

  it('falls back to "Unknown organization" when an org-owned row carries no name', () => {
    render(<CoversCell testId="c" orgId="org-a" orgName={null} />);
    expect(screen.getByTestId('c')).toHaveTextContent('Unknown organization');
  });

  it('renders Combined for a partner-owned row, never Unknown organization', () => {
    render(<CoversCell testId="c" orgId={null} orgName={null} />);
    const cell = screen.getByTestId('c');
    expect(cell).toHaveAttribute('data-covers-kind', 'combined');
    expect(cell).toHaveTextContent('All organizations · Combined');
    expect(cell).not.toHaveTextContent('Unknown organization');
  });

  it('renders a dash when the API sent no owner at all', () => {
    render(<CoversCell testId="c" orgId={undefined} />);
    expect(screen.getByTestId('c')).toHaveAttribute('data-covers-kind', 'unknown');
  });

  it('renders the series kind only when a series summary with an id is passed', () => {
    const { rerender } = render(
      <CoversCell testId="c" orgId={null} series={{ seriesId: 's-1', targetMode: 'all', orgCount: 18 }} />,
    );
    expect(screen.getByTestId('c')).toHaveAttribute('data-covers-kind', 'series');
    expect(screen.getByTestId('c')).toHaveTextContent('All orgs · 18 · One per organization');

    rerender(<CoversCell testId="c" orgId={null} series={{ seriesId: 's-1', targetMode: 'selected', orgCount: 1 }} />);
    expect(screen.getByTestId('c')).toHaveTextContent('1 org · One per organization');

    rerender(<CoversCell testId="c" orgId={null} series={{ seriesId: 's-1', targetMode: 'selected', orgCount: 3 }} />);
    expect(screen.getByTestId('c')).toHaveTextContent('3 orgs · One per organization');

    // A W02 child row (seriesId on the report, org set) is an ordinary org row here.
    rerender(<CoversCell testId="c" orgId="org-a" orgName="Acme Dental" series={null} />);
    expect(screen.getByTestId('c')).toHaveAttribute('data-covers-kind', 'org');
  });
});
