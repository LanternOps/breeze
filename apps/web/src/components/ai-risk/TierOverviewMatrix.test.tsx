import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { TierOverviewMatrix } from './TierOverviewMatrix';

describe('TierOverviewMatrix — tier names from the catalogue (#10134)', () => {
  it('renders the four tier names from the catalogue', () => {
    const { container } = render(<TierOverviewMatrix />);
    const text = container.textContent ?? '';
    for (const name of ['Tier 1 — Reads', 'Tier 2 — Acts and logs', 'Tier 3 — Asks first', 'Tier 4 — Blocked']) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain('Auto-Execute');
    expect(text).not.toContain('Requires Approval');
  });
});
