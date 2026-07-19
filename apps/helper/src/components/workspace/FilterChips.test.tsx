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

it('renders only the requested chips (Browse tab: Project/Doc type only, no Date/Source/Kind)', () => {
  render(
    <FilterChips
      rows={[]}
      sources={[{ id: 's1', displayName: 'Firm Share', kind: 'smb_share' }]}
      filters={{}}
      onSetFilter={vi.fn()}
      onClearFilter={vi.fn()}
      chips={['project', 'docType']}
    />,
  );
  expect(screen.getByRole('button', { name: 'Project' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Doc type' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Date' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Source' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Kind' })).not.toBeInTheDocument();
});

it('defaults to all five chips when `chips` is omitted (Search tab)', () => {
  renderChips();
  expect(screen.getByRole('button', { name: 'Project' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Doc type' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Date' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Kind' })).toBeInTheDocument();
});

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
