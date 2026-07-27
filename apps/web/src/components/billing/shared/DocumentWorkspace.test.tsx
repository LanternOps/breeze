import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DocumentWorkspace } from './DocumentWorkspace';

const TABS = [
  { id: 'editor', label: 'Editor' },
  { id: 'preview', label: 'Preview' },
  { id: 'detail', label: 'Detail' },
];

function renderWs(over: Partial<React.ComponentProps<typeof DocumentWorkspace>> = {}) {
  const onTabChange = vi.fn();
  render(
    <DocumentWorkspace
      idPrefix="doc"
      backHref="/billing/things"
      backLabel="Things"
      title="THING-1"
      tabs={TABS}
      activeTab="editor"
      onTabChange={onTabChange}
      {...over}
    >
      <div data-testid="panel-body">body for {over.activeTab ?? 'editor'}</div>
    </DocumentWorkspace>,
  );
  return { onTabChange };
}

describe('DocumentWorkspace', () => {
  it('renders the title, back link, and a WAI-ARIA tablist with the active tab selected', () => {
    renderWs();
    expect(screen.getByTestId('doc-workspace-title')).toHaveTextContent('THING-1');
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByTestId('doc-tab-editor')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('doc-tab-preview')).toHaveAttribute('aria-selected', 'false');
    // Roving tabindex: only the active tab is in the tab order.
    expect(screen.getByTestId('doc-tab-editor')).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('doc-tab-preview')).toHaveAttribute('tabindex', '-1');
  });

  it('renders the status pill and actions slots when provided', () => {
    renderWs({
      statusPill: <span data-testid="doc-status">Draft</span>,
      actions: <button data-testid="doc-action">Do it</button>,
    });
    expect(screen.getByTestId('doc-status')).toBeInTheDocument();
    expect(screen.getByTestId('doc-action')).toBeInTheDocument();
  });

  it('omits hidden tabs from the tablist', () => {
    renderWs({ tabs: [{ id: 'editor', label: 'Editor', hidden: true }, ...TABS.slice(1)], activeTab: 'detail' });
    expect(screen.queryByTestId('doc-tab-editor')).not.toBeInTheDocument();
    expect(screen.getByTestId('doc-tab-preview')).toBeInTheDocument();
  });

  it('moves selection with ArrowRight (roving tabindex) and calls onTabChange', () => {
    const { onTabChange } = renderWs();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(onTabChange).toHaveBeenCalledWith('preview');
  });

  it('jumps to the last tab on End and the first on Home', () => {
    const { onTabChange } = renderWs();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' });
    expect(onTabChange).toHaveBeenCalledWith('detail');
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Home' });
    expect(onTabChange).toHaveBeenCalledWith('editor');
  });

  it('activates a tab on click', () => {
    const { onTabChange } = renderWs();
    fireEvent.click(screen.getByTestId('doc-tab-detail'));
    expect(onTabChange).toHaveBeenCalledWith('detail');
  });

  it('renders the active panel with tabpanel semantics', () => {
    renderWs();
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', 'doc-tabpanel-editor');
    expect(panel).toHaveAttribute('aria-labelledby', 'doc-tab-editor');
    expect(screen.getByTestId('panel-body')).toBeInTheDocument();
  });

  it('a titleSlot replaces the visible h1 but the document keeps an sr-only one', () => {
    // The slot is an editable input. Wrapping that in an <h1> announces
    // "heading level 1, edit text", which is neither — so the visible heading
    // steps aside and an sr-only h1 preserves the document structure. Losing
    // that leaves the page with no h1 at all.
    renderWs({ titleSlot: <input data-testid="title-input" defaultValue="THING-1" /> });

    expect(screen.getByTestId('title-input')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-workspace-title')).not.toBeInTheDocument();

    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('THING-1');
    expect(h1).toHaveClass('sr-only');
  });

  it('renders metaSlot below the title row', () => {
    renderWs({
      titleSlot: <input data-testid="title-input" defaultValue="THING-1" />,
      metaSlot: <span data-testid="meta-slot">Customer: Acme</span>,
    });
    const meta = screen.getByTestId('meta-slot');
    expect(meta).toBeInTheDocument();
    // Below the title row, not inside it — the switcher used to sit inline and
    // squeeze the title.
    expect(screen.getByTestId('title-input').compareDocumentPosition(meta))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('keeps the visible h1 when no titleSlot is given', () => {
    renderWs({ metaSlot: <span data-testid="meta-slot">meta</span> });
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveAttribute('data-testid', 'doc-workspace-title');
    expect(h1).not.toHaveClass('sr-only');
  });
});
