import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ActionMenu } from './ActionMenu';

function renderMenu(overrides?: { second?: boolean }) {
  const onArchive = vi.fn();
  const onMerge = vi.fn();
  render(
    <div>
      <button type="button">outside</button>
      <ActionMenu
        label="More actions"
        testId="menu-trigger"
        items={[
          { id: 'archive', label: 'Archive organization', onSelect: onArchive, testId: 'item-archive' },
          ...(overrides?.second === false
            ? []
            : [{ id: 'merge', label: 'Merge organization', onSelect: onMerge, testId: 'item-merge', tone: 'destructive' as const }]),
        ]}
      />
    </div>,
  );
  return { onArchive, onMerge };
}

describe('ActionMenu', () => {
  it('is closed by default and opens a role=menu of menuitems on click', () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'More actions' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const items = screen.getAllByRole('menuitem');
    expect(items.map((el) => el.textContent)).toEqual(['Archive organization', 'Merge organization']);
    // First item takes focus on open; items are out of the Tab order.
    expect(document.activeElement).toBe(items[0]);
    expect(items[1]).toHaveAttribute('tabindex', '-1');
  });

  it('selecting an item calls its handler and closes the menu', () => {
    const { onMerge } = renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByTestId('item-merge'));

    expect(onMerge).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('hands focus back to the trigger BEFORE the handler runs, so a dialog it opens can restore to it', () => {
    let activeWhenSelected: Element | null = null;
    render(
      <ActionMenu
        label="More actions"
        items={[{ id: 'a', label: 'Archive', onSelect: () => { activeWhenSelected = document.activeElement; } }]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));

    expect(activeWhenSelected).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
  });

  it('arrow keys cycle the items; Escape closes and returns focus to the trigger', () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(trigger);
    const [archive, merge] = screen.getAllByRole('menuitem');

    fireEvent.keyDown(archive, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(merge);
    fireEvent.keyDown(merge, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(archive);

    fireEvent.keyDown(archive, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('a click outside closes the menu', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('renders nothing at all when there are no items', () => {
    render(<ActionMenu label="More actions" items={[]} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
