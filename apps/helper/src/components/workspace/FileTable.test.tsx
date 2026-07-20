// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { FileTable } from './FileTable';
import type { FinderFile } from '../../stores/workspaceStore';

function file(overrides: Partial<FinderFile> = {}): FinderFile {
  return {
    id: overrides.id ?? 'f1',
    sourceId: 's1',
    deviceKey: '__shared__',
    relPath: `clients/${overrides.name ?? 'a.pdf'}`,
    parentPath: 'clients',
    name: 'a.pdf',
    isDir: false,
    ext: 'pdf',
    size: 1024,
    mtime: '2026-07-01T00:00:00.000Z',
    openPath: '\\\\srv\\share\\clients\\a.pdf',
    ...overrides,
  };
}

const rows = [file({ id: 'f1', name: 'a.pdf' }), file({ id: 'f2', name: 'b.pdf' })];

it('ArrowDown selects the first row (aria-selected + .ws-row-selected)', () => {
  render(<FileTable view="search" rows={rows} onOpen={vi.fn()} onCopy={vi.fn()} />);
  fireEvent.keyDown(screen.getByRole('table'), { key: 'ArrowDown' });
  const firstRow = screen.getByText('a.pdf').closest('[role="row"]')!;
  expect(firstRow).toHaveAttribute('aria-selected', 'true');
  expect(firstRow).toHaveClass('ws-row-selected');
});

it('Enter opens the selected row', () => {
  const onOpen = vi.fn();
  render(<FileTable view="search" rows={rows} onOpen={onOpen} onCopy={vi.fn()} />);
  const table = screen.getByRole('table');
  fireEvent.keyDown(table, { key: 'ArrowDown' });
  fireEvent.keyDown(table, { key: 'Enter' });
  expect(onOpen).toHaveBeenCalledWith(rows[0]);
});

it('double-click on a file row opens it (mouse path — same handler as Enter/menu Open)', () => {
  const onOpen = vi.fn();
  render(<FileTable view="search" rows={rows} onOpen={onOpen} onCopy={vi.fn()} />);
  const secondRow = screen.getByText('b.pdf').closest('[role="row"]')!;
  fireEvent.doubleClick(secondRow);
  expect(onOpen).toHaveBeenCalledWith(rows[1]);
});

it('double-click on a directory row drills in (Browse) via onOpen', () => {
  const onOpen = vi.fn();
  const dirRows = [file({ id: 'd1', name: 'clients', isDir: true, openPath: undefined })];
  render(<FileTable view="browse" rows={dirRows} onOpen={onOpen} onCopy={vi.fn()} />);
  const dirRow = screen.getByText('clients/').closest('[role="row"]')!;
  fireEvent.doubleClick(dirRow);
  expect(onOpen).toHaveBeenCalledWith(dirRows[0]);
});

it('Cmd+C copies the selected row', () => {
  const onCopy = vi.fn();
  render(<FileTable view="search" rows={rows} onOpen={vi.fn()} onCopy={onCopy} />);
  const table = screen.getByRole('table');
  fireEvent.keyDown(table, { key: 'ArrowDown' });
  fireEvent.keyDown(table, { key: 'c', metaKey: true });
  expect(onCopy).toHaveBeenCalledWith(rows[0]);
});

it('Escape clears the selection and does not bubble past the table; a second Escape bubbles (WorkspacePanel walk-back)', () => {
  const onOpen = vi.fn();
  // Mirrors WorkspacePanel's own panel-level Escape handler, which only
  // reacts to Escape — matching the real bubble-vs-consume contract.
  const onOuterEscape = vi.fn();
  const onOuterKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onOuterEscape();
  };
  render(
    <div onKeyDown={onOuterKeyDown}>
      <FileTable view="search" rows={rows} onOpen={onOpen} onCopy={vi.fn()} />
    </div>,
  );
  const table = screen.getByRole('table');
  fireEvent.keyDown(table, { key: 'ArrowDown' });
  const firstRow = screen.getByText('a.pdf').closest('[role="row"]')!;
  expect(firstRow).toHaveAttribute('aria-selected', 'true');

  fireEvent.keyDown(table, { key: 'Escape' });
  expect(firstRow).toHaveAttribute('aria-selected', 'false');
  expect(onOuterEscape).not.toHaveBeenCalled();

  // With no selection left, Escape bubbles up (WorkspacePanel walks back).
  fireEvent.keyDown(table, { key: 'Escape' });
  expect(onOuterEscape).toHaveBeenCalledTimes(1);
});

it('Escape closes a mouse-opened row context menu without also walking the panel back — RowMenu never sets `selected`, so this is not covered by the selection guard above', async () => {
  const onOuterEscape = vi.fn();
  const onOuterKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onOuterEscape();
  };
  render(
    <div onKeyDown={onOuterKeyDown}>
      <FileTable view="search" rows={rows} onOpen={vi.fn()} onCopy={vi.fn()} />
    </div>,
  );

  // Right-click opens the row's context menu via the mouse — this never
  // calls setSelected, so `selected` stays null throughout.
  fireEvent.contextMenu(screen.getByText('a.pdf'));
  const menu = await screen.findByRole('menu');
  const firstRow = screen.getByText('a.pdf').closest('[role="row"]')!;
  expect(firstRow).toHaveAttribute('aria-selected', 'false');

  fireEvent.keyDown(menu, { key: 'Escape' });
  expect(onOuterEscape).not.toHaveBeenCalled();
});
