// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { FilterChips } from './FilterChips';
import type { WorkspaceFilters } from '../../stores/workspaceStore';

function renderChips(filters: WorkspaceFilters = {}) {
  return render(
    <FilterChips
      rows={[]}
      sources={[]}
      filters={filters}
      onSetFilter={vi.fn()}
      onClearFilter={vi.fn()}
    />,
  );
}

it('does not swallow Tab inside the Date chip custom From/To inputs (regression: Radix Menu.Content preventDefaults Tab)', async () => {
  renderChips();

  // Radix DropdownMenuTrigger opens on pointerdown, not click.
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Date' }), { button: 0 });

  const fromInput = await screen.findByLabelText('From');
  const toInput = screen.getByLabelText('To');

  fromInput.focus();
  expect(document.activeElement).toBe(fromInput);

  // Fire the same Tab keydown a real browser would send while focus is on
  // the From input, inside DropdownMenu.Content. Radix's Menu.Content
  // handler calls event.preventDefault() on Tab for any keydown target
  // nested under [data-radix-menu-content] with no focus-boundary check —
  // our capture-phase stopPropagation on the custom wrapper must stop that
  // handler from ever seeing the event.
  const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  const notPrevented = fromInput.dispatchEvent(event);

  expect(notPrevented).toBe(true); // true means preventDefault() was NOT called
  expect(toInput).toBeInTheDocument();
});
