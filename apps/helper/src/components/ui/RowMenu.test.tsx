// @vitest-environment jsdom
import { render, screen, fireEvent, within } from '@testing-library/react';
import { RowMenu, type MenuItem } from './RowMenu';

function items(onOpen: () => void, onCopy: () => void): MenuItem[] {
  return [
    { label: 'Open', onSelect: onOpen },
    { label: 'Copy path', onSelect: onCopy },
  ];
}

it('right-click opens the context menu with the given items; selecting one calls its handler', async () => {
  const onOpen = vi.fn();
  const onCopy = vi.fn();
  render(
    <RowMenu items={items(onOpen, onCopy)}>
      <div>my-file.docx</div>
    </RowMenu>,
  );

  fireEvent.contextMenu(screen.getByText('my-file.docx'));

  const menu = await screen.findByRole('menu');
  const copyItem = within(menu).getByText('Copy path');
  expect(within(menu).getByText('Open')).toBeInTheDocument();

  fireEvent.click(copyItem);
  expect(onCopy).toHaveBeenCalledTimes(1);
  expect(onOpen).not.toHaveBeenCalled();
});

it('the hover ⋯ button opens the same items via a dropdown menu', async () => {
  const onOpen = vi.fn();
  const onCopy = vi.fn();
  render(
    <RowMenu items={items(onOpen, onCopy)}>
      <div>my-file.docx</div>
    </RowMenu>,
  );

  // Radix's DropdownMenuTrigger opens on pointerdown, not click.
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }), { button: 0 });

  const menu = await screen.findByRole('menu');
  expect(within(menu).getByText('Open')).toBeInTheDocument();
  expect(within(menu).getByText('Copy path')).toBeInTheDocument();
});

it('Escape closes the context menu without bubbling to an ancestor handler', async () => {
  const onOuterEscape = vi.fn();
  render(
    <div onKeyDown={(e) => { if (e.key === 'Escape') onOuterEscape(); }}>
      <RowMenu items={items(vi.fn(), vi.fn())}>
        <div>my-file.docx</div>
      </RowMenu>
    </div>,
  );

  fireEvent.contextMenu(screen.getByText('my-file.docx'));
  const menu = await screen.findByRole('menu');

  fireEvent.keyDown(menu, { key: 'Escape' });
  expect(onOuterEscape).not.toHaveBeenCalled();
});

it('Escape closes the ⋯ dropdown menu without bubbling to an ancestor handler', async () => {
  const onOuterEscape = vi.fn();
  render(
    <div onKeyDown={(e) => { if (e.key === 'Escape') onOuterEscape(); }}>
      <RowMenu items={items(vi.fn(), vi.fn())}>
        <div>my-file.docx</div>
      </RowMenu>
    </div>,
  );

  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }), { button: 0 });
  const menu = await screen.findByRole('menu');

  fireEvent.keyDown(menu, { key: 'Escape' });
  expect(onOuterEscape).not.toHaveBeenCalled();
});
