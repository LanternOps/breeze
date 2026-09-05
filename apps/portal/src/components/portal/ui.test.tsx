// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './ui';

/**
 * The shared vocabulary's own contracts. Everything else in the portal composes
 * from these, so a heading level or a tone chosen here is chosen for every list
 * at once.
 */
describe('EmptyState', () => {
  it('sits one level under the page title instead of skipping a heading level', () => {
    // Every page opens with PageHeader's single <h1>; an <h3> directly beneath
    // it skips <h2> and reads to a screen reader as a missing section.
    render(<EmptyState title="No devices" />);

    const heading = screen.getByRole('heading', { name: 'No devices' });
    expect(heading.tagName).toBe('H2');
    // Still the serif Title, unchanged (apps/portal/DESIGN.md).
    expect(heading.className).toContain('font-display');
    expect(heading.className).toContain('text-lg');
  });
});
