import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@/lib/i18n';

import ScriptList, { type Script } from './ScriptList';

// pageSize defaults to 10 — 12 scripts guarantees a second page so the
// pagination controls (and their icon-only prev/next buttons) render.
const scripts: Script[] = Array.from({ length: 12 }, (_, i) => ({
  id: `script-${i + 1}`,
  name: `Script ${i + 1}`,
  language: 'bash',
  category: 'maintenance',
  osTypes: ['linux'],
  createdAt: '2026-02-09T10:00:00.000Z',
  updatedAt: '2026-02-09T10:00:00.000Z',
}));

describe('ScriptList pagination', () => {
  it('exposes the prev/next icon buttons by an accessible name (#3452)', () => {
    render(<ScriptList scripts={scripts} />);

    // The buttons are icon-only, so their accessible name must come from
    // aria-label/title rather than visible text.
    const previousButton = screen.getByRole('button', { name: 'Previous page' });
    const nextButton = screen.getByRole('button', { name: 'Next page' });

    expect(previousButton).toBeInTheDocument();
    expect(nextButton).toBeInTheDocument();
    expect(previousButton).toHaveAttribute('title', 'Previous page');
    expect(nextButton).toHaveAttribute('title', 'Next page');
    expect(previousButton).toBeDisabled();
    expect(nextButton).not.toBeDisabled();
  });
});
