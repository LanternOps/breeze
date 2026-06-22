import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import OrganizationList, { type Organization } from './OrganizationList';

// The row (desktop) and the card (mobile) are both clickable (-> onSelect), with
// inner Edit/Delete buttons that must stopPropagation so an action click does NOT
// also fire the row's onSelect. That wiring is the one genuinely-new behavior the
// ResponsiveTable conversion introduced here — this guards it. Both surfaces render
// in jsdom (the sm: breakpoint is CSS-only), so scope to the desktop surface.
const desktop = () => within(screen.getByTestId('responsive-table-desktop'));

const orgs: Organization[] = [
  { id: 'org-1', name: 'Acme Corp', status: 'active', deviceCount: 12, createdAt: '2026-01-01T00:00:00.000Z' },
];

describe('OrganizationList row/action click isolation', () => {
  it('selects the org when the row body is clicked', () => {
    const onSelect = vi.fn();
    render(<OrganizationList organizations={orgs} onSelect={onSelect} onEdit={vi.fn()} onDelete={vi.fn()} />);

    fireEvent.click(desktop().getByText('Acme Corp'));

    expect(onSelect).toHaveBeenCalledWith(orgs[0]);
  });

  it('fires Edit without selecting the row (stopPropagation holds)', () => {
    const onSelect = vi.fn();
    const onEdit = vi.fn();
    render(<OrganizationList organizations={orgs} onSelect={onSelect} onEdit={onEdit} onDelete={vi.fn()} />);

    fireEvent.click(desktop().getByRole('button', { name: 'Edit' }));

    expect(onEdit).toHaveBeenCalledWith(orgs[0]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('fires Delete without selecting the row (stopPropagation holds)', () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    render(<OrganizationList organizations={orgs} onSelect={onSelect} onEdit={vi.fn()} onDelete={onDelete} />);

    fireEvent.click(desktop().getByRole('button', { name: 'Delete' }));

    expect(onDelete).toHaveBeenCalledWith(orgs[0]);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
