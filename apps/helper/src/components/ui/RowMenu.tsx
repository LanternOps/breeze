import type { ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/**
 * Right-click AND the hover ⋯ button open the same `items` — a context menu
 * (Radix ContextMenu, triggered by the whole row) and an overflow dropdown
 * (Radix DropdownMenu, triggered by a small button revealed on row hover),
 * both rendering the same menu list.
 */
/**
 * Radix's DismissableLayer closes an open menu on Escape via its own
 * document-level capture listener (it only calls `preventDefault()`, never
 * `stopPropagation()`), so the same keydown still bubbles through React's
 * synthetic tree to whatever's listening above this row (FileTable, then
 * WorkspacePanel's Back handler) — collapsing "close menu" and "go Back"
 * into a single keystroke. Stop it here, on the portalled content itself,
 * so Escape's first job is only ever to close *this* menu; the walk-back
 * to selection-clear / Back resumes on the next Escape once the content
 * (and this handler) has unmounted.
 */
function stopEscapePropagation(e: React.KeyboardEvent) {
  if (e.key === 'Escape') e.stopPropagation();
}

export function RowMenu({ items, children }: { items: MenuItem[]; children: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className="ws-row-menu">
          {children}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="ws-row-menu-overflow" aria-label="More actions">
                &#8943;
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="ws-row-menu-content"
                align="end"
                sideOffset={4}
                onKeyDown={stopEscapePropagation}
              >
                {items.map((item) => (
                  <DropdownMenu.Item
                    key={item.label}
                    className="ws-row-menu-item"
                    disabled={item.disabled}
                    onSelect={item.onSelect}
                  >
                    {item.label}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="ws-row-menu-content" onKeyDown={stopEscapePropagation}>
          {items.map((item) => (
            <ContextMenu.Item
              key={item.label}
              className="ws-row-menu-item"
              disabled={item.disabled}
              onSelect={item.onSelect}
            >
              {item.label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
