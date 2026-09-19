import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PageHeader } from './PageHeader';

describe('PageHeader', () => {
  it('renders the title as an h1', () => {
    render(<PageHeader title="AI impact" />);
    const heading = screen.getByRole('heading', { name: 'AI impact', level: 1 });
    expect(heading).toBeInTheDocument();
  });

  it('renders the description when provided', () => {
    render(<PageHeader title="AI impact" description="What your AI agents handled." />);
    expect(screen.getByText('What your AI agents handled.')).toBeInTheDocument();
  });

  it('omits the description block entirely when not provided', () => {
    render(<PageHeader title="AI impact" testId="header" />);
    // No stray empty <p> left behind for a missing description.
    const header = screen.getByTestId('header');
    expect(header.querySelector('p')).not.toBeInTheDocument();
  });

  it('constrains the description to a readable measure', () => {
    render(<PageHeader title="AI impact" description="What your AI agents handled." />);
    expect(screen.getByText('What your AI agents handled.').className).toContain('max-w-prose');
  });

  it('renders the icon inside a muted rounded tile when provided', () => {
    render(<PageHeader title="AI impact" icon={<svg data-testid="page-header-icon" />} testId="header" />);
    const icon = screen.getByTestId('page-header-icon');
    expect(icon).toBeInTheDocument();
    const tile = icon.parentElement;
    expect(tile?.className).toContain('bg-muted');
    expect(tile?.className).toContain('rounded');
  });

  it('renders no icon tile when icon is omitted', () => {
    render(<PageHeader title="AI impact" testId="header" />);
    const header = screen.getByTestId('header');
    expect(header.querySelector('.bg-muted')).not.toBeInTheDocument();
  });

  it('renders the actions slot', () => {
    render(<PageHeader title="AI impact" actions={<button type="button">Refresh</button>} />);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('renders no actions container when actions is omitted', () => {
    render(<PageHeader title="AI impact" testId="header" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('lets actions wrap onto their own line below md', () => {
    render(<PageHeader title="AI impact" actions={<button type="button">Refresh</button>} testId="header" />);
    const button = screen.getByRole('button', { name: 'Refresh' });
    // Walk up to the actions container (parent of the button).
    const actionsContainer = button.parentElement;
    expect(actionsContainer?.className).toContain('flex-wrap');
  });

  it('passes through data-testid on the outer element', () => {
    render(<PageHeader title="AI impact" testId="ai-impact-header" />);
    expect(screen.getByTestId('ai-impact-header')).toBeInTheDocument();
  });
});
