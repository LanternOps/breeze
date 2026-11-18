import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('renders an item with `href` as a real link menuitem with a second line, and still closes on activation', () => {
    const onSelect = vi.fn();
    render(
      <ActionMenu
        label="Row actions"
        items={[
          { id: 'open', label: 'Open record', href: '/organizations/abc' },
          { id: 'contact', label: 'Contact Jane Doe', description: 'jane@alpha.test · +1 555', href: 'mailto:jane@alpha.test', onSelect },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Row actions' }));
    const link = screen.getByRole('menuitem', { name: /Contact Jane Doe/ });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'mailto:jane@alpha.test');
    expect(link).toHaveTextContent('jane@alpha.test · +1 555');
    expect(screen.getByRole('menuitem', { name: 'Open record' })).toHaveAttribute('href', '/organizations/abc');
    fireEvent.click(link);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('draws a separator above items that ask for one, and the arrow keys skip it', () => {
    render(
      <ActionMenu
        label="Row actions"
        items={[
          { id: 'a', label: 'First', onSelect: () => undefined },
          { id: 'b', label: 'Second', onSelect: () => undefined, separatorBefore: true },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Row actions' }));
    expect(screen.getAllByRole('separator')).toHaveLength(1);
    const first = screen.getByRole('menuitem', { name: 'First' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Second' }));
  });

  it('puts the trigger on the tabindex the caller asks for (roving rows)', () => {
    render(<ActionMenu label="Row actions" triggerTabIndex={-1} items={[{ id: 'a', label: 'First', onSelect: () => undefined }]} />);
    expect(screen.getByRole('button', { name: 'Row actions' })).toHaveAttribute('tabindex', '-1');
  });

  it('renders the open menu outside any clipping ancestor (portal to body, fixed position)', () => {
    render(
      <div data-testid="clipper" style={{ overflow: 'auto', height: 40 }}>
        <ActionMenu label="Row actions" items={[{ id: 'a', label: 'First', onSelect: () => undefined }]} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Row actions' }));
    const menu = screen.getByRole('menu');
    expect(screen.getByTestId('clipper').contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe('fixed');
  });

  it('a mousedown inside the portalled menu is not an outside click', () => {
    const { onArchive } = renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const item = screen.getByTestId('item-archive');
    fireEvent.mouseDown(item);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.click(item);
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it('Tab closes the menu and leaves focus on the trigger, so tabbing continues from the row', () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  // #9840 W4 (additive): a disabled item is still announced and reachable, but does nothing.
  it('a disabled item renders aria-disabled, stays in the arrow-key order, and neither click nor Enter/Space activates it', async () => {
    const user = userEvent.setup();
    const onOff = vi.fn();
    const onOn = vi.fn();
    render(
      <ActionMenu
        label="Add"
        testId="menu-trigger"
        items={[
          { id: 'off', label: 'Off item', description: 'Why it is off', onSelect: onOff, testId: 'item-off', disabled: true },
          { id: 'on', label: 'On item', onSelect: onOn, testId: 'item-on' },
        ]}
      />,
    );
    await user.click(screen.getByTestId('menu-trigger'));
    const off = screen.getByTestId('item-off');
    expect(off).toHaveAttribute('aria-disabled', 'true');
    expect(off).toHaveTextContent('Why it is off');
    expect(screen.getByTestId('item-on')).not.toHaveAttribute('aria-disabled');
    // First item takes focus even when disabled, so it is announced.
    expect(document.activeElement).toBe(off);

    await user.click(off);
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onOff).not.toHaveBeenCalled();
    // The menu stays open: nothing happened.
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('item-on'));
    await user.keyboard('{Enter}');
    expect(onOn).toHaveBeenCalledTimes(1);
  });

  it('a disabled link item does not navigate', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ActionMenu label="Add" testId="menu-trigger" items={[{ id: 'l', label: 'Link', href: '#x', onSelect, testId: 'item-l', disabled: true }]} />);
    await user.click(screen.getByTestId('menu-trigger'));
    const link = screen.getByTestId('item-l');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a trigger override replaces the icon; without one the trigger is unchanged', () => {
    const { unmount } = render(
      <ActionMenu label="New tab" testId="custom" trigger={<span data-testid="custom-content">New</span>} items={[{ id: 'a', label: 'A', onSelect: vi.fn() }]} />,
    );
    const custom = screen.getByTestId('custom');
    expect(custom).toContainElement(screen.getByTestId('custom-content'));
    expect(custom.querySelector('svg')).toBeNull();
    expect(custom).toHaveAttribute('aria-label', 'New tab');
    unmount();

    render(<ActionMenu label="More" testId="default" items={[{ id: 'a', label: 'A', onSelect: vi.fn() }]} />);
    const def = screen.getByTestId('default');
    expect(def.children).toHaveLength(1);
    expect(def.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(def.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});
