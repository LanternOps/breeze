import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import CollapsibleSection from './CollapsibleSection';

// axe (aria-hidden-focus): the collapsed content wrapper carried aria-hidden
// while a focusable control inside it remained reachable by Tab — jsdom has
// no layout engine to catch the visual collapse, but it does model `inert`,
// which is the fix: an inert subtree is programmatically removed from the
// focus order and the accessibility tree, not just visually hidden.
describe('CollapsibleSection', () => {
  it('marks the collapsed content inert so focusable children are not reachable', () => {
    render(
      <CollapsibleSection title="Section" open={false} onToggle={vi.fn()}>
        <button type="button" data-testid="inner-control">Click me</button>
      </CollapsibleSection>
    );
    const control = screen.getByTestId('inner-control');
    // `inert` is set on an ancestor; HTMLElement.inert reports the element's
    // OWN attribute, so walk up to find where it's applied.
    const inertAncestor = control.closest('[inert]');
    expect(inertAncestor).not.toBeNull();
  });

  it('is not inert when open', () => {
    render(
      <CollapsibleSection title="Section" open={true} onToggle={vi.fn()}>
        <button type="button" data-testid="inner-control">Click me</button>
      </CollapsibleSection>
    );
    const control = screen.getByTestId('inner-control');
    expect(control.closest('[inert]')).toBeNull();
  });
});
