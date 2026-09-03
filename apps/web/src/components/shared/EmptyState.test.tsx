import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders the title and description', () => {
    render(<EmptyState title="No runs yet" description="Runs will show up here once triggered." />);
    expect(screen.getByText('No runs yet')).toBeInTheDocument();
    expect(screen.getByText('Runs will show up here once triggered.')).toBeInTheDocument();
  });

  it('renders without a description', () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('renders the title as an h3 heading by default', () => {
    render(<EmptyState title="No runs yet" />);
    const heading = screen.getByRole('heading', { name: 'No runs yet' });
    expect(heading.tagName).toBe('H3');
  });

  it('renders the title at the requested heading level', () => {
    render(<EmptyState title="Page-level empty" headingLevel={2} />);
    const heading = screen.getByRole('heading', { name: 'Page-level empty' });
    expect(heading.tagName).toBe('H2');
  });

  it('renders the action slot', () => {
    render(<EmptyState title="No runs yet" action={<button type="button">Create run</button>} />);
    expect(screen.getByRole('button', { name: 'Create run' })).toBeInTheDocument();
  });

  it('renders the secondary slot', () => {
    render(<EmptyState title="No runs yet" secondary={<a href="/docs">Learn more</a>} />);
    expect(screen.getByRole('link', { name: 'Learn more' })).toBeInTheDocument();
  });

  it('passes through data-testid', () => {
    render(<EmptyState title="No runs yet" testId="runs-empty" />);
    expect(screen.getByTestId('runs-empty')).toBeInTheDocument();
  });

  it('renders a default icon when none is provided', () => {
    render(<EmptyState title="No runs yet" testId="runs-empty" />);
    const container = screen.getByTestId('runs-empty');
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('renders a custom icon when provided', () => {
    render(
      <EmptyState
        title="No runs yet"
        testId="runs-empty"
        icon={<svg data-testid="custom-icon" />}
      />,
    );
    expect(screen.getByTestId('custom-icon')).toBeInTheDocument();
  });

  it('uses a dashed border for the framed card', () => {
    render(<EmptyState title="No runs yet" testId="runs-empty" />);
    expect(screen.getByTestId('runs-empty').className).toContain('border-dashed');
  });

  it('applies a distinct className for the sm size vs md', () => {
    const { container: smContainer } = render(<EmptyState title="Compact" size="sm" testId="sm-empty" />);
    const { container: mdContainer } = render(<EmptyState title="Full" size="md" testId="md-empty" />);
    const sm = smContainer.querySelector('[data-testid="sm-empty"]');
    const md = mdContainer.querySelector('[data-testid="md-empty"]');
    expect(sm?.className).not.toEqual(md?.className);
  });

  it('merges a passed-through className', () => {
    render(<EmptyState title="No runs yet" testId="runs-empty" className="custom-extra" />);
    expect(screen.getByTestId('runs-empty').className).toContain('custom-extra');
  });
});
