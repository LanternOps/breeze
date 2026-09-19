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

  it('uses the dashed frame by default (variant="framed")', () => {
    render(<EmptyState title="No runs yet" testId="runs-empty" />);
    const container = screen.getByTestId('runs-empty');
    expect(container.className).toContain('border-dashed');
    expect(container.className).toContain('border');
  });

  it('drops the dashed border and background for variant="plain"', () => {
    render(<EmptyState title="No runs yet" testId="runs-empty" variant="plain" />);
    const container = screen.getByTestId('runs-empty');
    expect(container.className).not.toContain('border-dashed');
    expect(container.className).not.toContain('border-border');
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

  // Review finding #3 (detector): the `action` slot on /settings/ai-agents
  // rendered with 0px vertical padding — the slot passes through whatever the
  // caller renders, so the frame itself must enforce a minimum tap target
  // regardless of what markup the caller ships in the slot.
  it('wraps the action slot so a padding-less caller button still gets a minimum height and padding', () => {
    render(<EmptyState title="No runs yet" action={<button type="button">Create run</button>} />);
    const button = screen.getByRole('button', { name: 'Create run' });
    expect(button.parentElement?.className).toContain('min-h-10');
    expect(button.parentElement?.className).toContain('py-2');
  });

  it('applies the same minimum-target wrapper when the action slot is a link', () => {
    render(<EmptyState title="No runs yet" action={<a href="/docs">Learn more</a>} />);
    const link = screen.getByRole('link', { name: 'Learn more' });
    expect(link.parentElement?.className).toContain('min-h-10');
    expect(link.parentElement?.className).toContain('py-2');
  });

  // Review finding #3: the dashed border is near-invisible in dark mode
  // against the default `--border` token; use a stronger dark override since
  // globals.css has no `--border-strong` token.
  it('uses a stronger dark-mode border token so the dashed frame stays visible in dark mode', () => {
    render(<EmptyState title="No runs yet" testId="runs-empty" />);
    expect(screen.getByTestId('runs-empty').className).toContain('dark:border-zinc-600');
  });

  // Review finding #3: an optional `intro` slot, rendered between the
  // description and the action, for content (e.g. a glossary) that must
  // precede the CTA.
  it('renders the intro slot between the description and the action', () => {
    render(
      <EmptyState
        title="No runs yet"
        description="Runs will appear here."
        intro={<p data-testid="intro-slot">Glossary</p>}
        action={<button type="button">Create run</button>}
      />,
    );
    const description = screen.getByText('Runs will appear here.');
    const intro = screen.getByTestId('intro-slot');
    const action = screen.getByRole('button', { name: 'Create run' });

    expect(
      description.compareDocumentPosition(intro) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      intro.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('omits the intro slot entirely when not provided', () => {
    render(<EmptyState title="No runs yet" testId="runs-empty" description="Desc" />);
    expect(screen.queryByTestId('intro-slot')).not.toBeInTheDocument();
  });
});
