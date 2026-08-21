import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData, QuoteBlock } from './quoteTypes';
import { addBlock, updateBlock } from '../../../lib/api/quotes';

// Mutable grant set so the edit-affordance gating (writer vs read-only) can be
// exercised in this file; defaults to the wildcard the create tests assume.
const auth = vi.hoisted(() => ({ permissions: [{ resource: '*', action: '*' }] as { resource: string; action: string }[] }));

// This test targets the table-grid authoring UI (add/remove row+column, align,
// zebra/headerStyle, submit wiring) — not TipTap internals, which
// InlineRichTextEditor.test.tsx already covers on its own. Replacing it with a
// plain textarea mirrors the established house pattern for RichTextEditor
// (see TemplateEditor.test.tsx) and makes cell edits trivially simulatable via
// fireEvent.change.
vi.mock('../../common/InlineRichTextEditor', () => ({
  default: ({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId: string }) => (
    <textarea data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock('../../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
  ),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: auth.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

vi.mock('../../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: [] }) } as unknown as Response,
  ),
  createCatalogItem: vi.fn(),
  polishTextRequest: vi.fn(),
}));

vi.mock('../../../lib/api/quotes', () => ({
  addBlock: vi.fn(),
  deleteBlock: vi.fn(),
  updateBlock: vi.fn(),
  updateQuote: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  moveLine: vi.fn(),
  uploadQuoteImage: vi.fn(),
  addQuoteImageFromUrl: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const okRes = (data: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data }) } as unknown as Response);
const errRes = () =>
  ({ ok: false, status: 502, statusText: 'Bad Gateway', json: vi.fn().mockResolvedValue({ error: 'x' }) } as unknown as Response);

const detail: QuoteDetailData = {
  quote: {
    id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
    taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
    termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
    convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
    createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [],
  lines: [],
};

const addBlockMock = vi.mocked(addBlock);
const updateBlockMock = vi.mocked(updateBlock);

async function openTableForm() {
  render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('quote-add-block-type-table'));
  await waitFor(() => expect(screen.getByTestId('quote-block-table')).toBeInTheDocument());
}

describe('QuoteEditor — add table block', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a "Table" chip in the add-block picker', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    expect(screen.getByTestId('quote-add-block-type-table')).toBeInTheDocument();
  });

  it('starts with a 2x2 grid', async () => {
    await openTableForm();
    expect(screen.getByTestId('quote-block-table-column-label-0')).toBeInTheDocument();
    expect(screen.getByTestId('quote-block-table-column-label-1')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-block-table-column-label-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-block-table-cell-0-0')).toBeInTheDocument();
    expect(screen.getByTestId('quote-block-table-cell-1-1')).toBeInTheDocument();
  });

  it('adding a column pads every existing row with an empty cell (cells.length === columns.length)', async () => {
    await openTableForm();
    fireEvent.change(screen.getByTestId('quote-block-table-cell-0-0'), { target: { value: 'A0' } });
    fireEvent.change(screen.getByTestId('quote-block-table-cell-1-1'), { target: { value: 'B1' } });

    fireEvent.click(screen.getByTestId('quote-block-table-add-column'));

    expect(screen.getByTestId('quote-block-table-column-label-2')).toBeInTheDocument();
    // Every row now has a 3rd (padded, empty) cell — existing content untouched.
    expect(screen.getByTestId('quote-block-table-cell-0-2')).toHaveValue('');
    expect(screen.getByTestId('quote-block-table-cell-1-2')).toHaveValue('');
    expect(screen.getByTestId('quote-block-table-cell-0-0')).toHaveValue('A0');
    expect(screen.getByTestId('quote-block-table-cell-1-1')).toHaveValue('B1');
  });

  it('removing a column removes that cell from every row', async () => {
    await openTableForm();
    fireEvent.click(screen.getByTestId('quote-block-table-remove-column-0'));
    expect(screen.queryByTestId('quote-block-table-column-label-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-block-table-column-label-0')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-block-table-cell-0-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-block-table-cell-1-1')).not.toBeInTheDocument();
  });

  it('cannot remove the last remaining column', async () => {
    await openTableForm();
    fireEvent.click(screen.getByTestId('quote-block-table-remove-column-0'));
    expect(screen.getByTestId('quote-block-table-remove-column-0')).toBeDisabled();
  });

  it('adding then removing a row works and cannot go below one row', async () => {
    await openTableForm();
    fireEvent.click(screen.getByTestId('quote-block-table-add-row'));
    expect(screen.getByTestId('quote-block-table-cell-2-0')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('quote-block-table-remove-row-2'));
    fireEvent.click(screen.getByTestId('quote-block-table-remove-row-1'));
    expect(screen.queryByTestId('quote-block-table-cell-1-0')).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-block-table-remove-row-0')).toBeDisabled();
  });

  it('per-column align select and zebra/headerStyle toggles are present and changeable', async () => {
    await openTableForm();
    fireEvent.change(screen.getByTestId('quote-block-table-column-align-0'), { target: { value: 'right' } });
    expect(screen.getByTestId('quote-block-table-column-align-0')).toHaveValue('right');

    fireEvent.click(screen.getByTestId('quote-block-table-zebra'));
    expect(screen.getByTestId('quote-block-table-zebra')).toBeChecked();

    fireEvent.change(screen.getByTestId('quote-block-table-header-style'), { target: { value: 'accent' } });
    expect(screen.getByTestId('quote-block-table-header-style')).toHaveValue('accent');
  });

  it('creating a table POSTs blockType "table" with the current grid content', async () => {
    addBlockMock.mockResolvedValue(okRes({ id: 'blk-t' }));
    await openTableForm();

    fireEvent.change(screen.getByTestId('quote-block-table-column-label-0'), { target: { value: 'Item' } });
    fireEvent.change(screen.getByTestId('quote-block-table-column-label-1'), { target: { value: 'Notes' } });
    fireEvent.change(screen.getByTestId('quote-block-table-column-align-1'), { target: { value: 'right' } });
    fireEvent.change(screen.getByTestId('quote-block-table-cell-0-0'), { target: { value: 'Router' } });
    fireEvent.change(screen.getByTestId('quote-block-table-cell-0-1'), { target: { value: 'Optional' } });
    fireEvent.change(screen.getByTestId('quote-block-table-caption'), { target: { value: 'Hardware' } });
    fireEvent.click(screen.getByTestId('quote-block-table-zebra'));

    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(addBlockMock).toHaveBeenCalledWith('q-1', {
      blockType: 'table',
      content: {
        columns: [{ label: 'Item' }, { label: 'Notes', align: 'right' }],
        rows: [{ cells: ['Router', 'Optional'] }, { cells: ['', ''] }],
        caption: 'Hardware',
        zebra: true,
        headerStyle: 'plain',
      },
    }));
  });

  it('disables submit while add-block is in flight and re-enables with an error surfaced on failure', async () => {
    addBlockMock.mockResolvedValue(errRes());
    await openTableForm();

    const submit = screen.getByTestId('quote-add-block-submit');
    fireEvent.click(submit);

    // Rejected request: the pending guard must unlatch (not leave submit
    // permanently disabled) and the failure must be visible — the #3519
    // regression class this brief calls out explicitly.
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    await waitFor(() => expect(submit).not.toBeDisabled());
  });
});

describe('QuoteEditor — persisted table block', () => {
  beforeEach(() => vi.clearAllMocks());

  // Regression: after Task 13's initial cut, QuoteBlockCard had no branch for
  // `table`/`callout`, so a just-created (or reloaded) table block rendered
  // as an empty block — invisible on the canvas even though it existed
  // server-side. This proves the read-only display branch renders content.
  it('renders the persisted table content visibly (not blank) on the canvas', async () => {
    const tableBlock: QuoteBlock = {
      id: 'blk-t', quoteId: 'q-1', orgId: 'org-1', blockType: 'table',
      content: {
        columns: [{ label: 'Item' }, { label: 'Notes', align: 'right' }],
        rows: [{ cells: ['Router', 'Optional'] }],
        caption: 'Hardware',
      },
      sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    };
    render(<QuoteEditor detail={{ ...detail, blocks: [tableBlock] }} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-block-table-content-blk-t')).toBeInTheDocument());
    const content = screen.getByTestId('quote-block-table-content-blk-t');
    expect(content).toHaveTextContent('Item');
    expect(content).toHaveTextContent('Router');
    expect(content).toHaveTextContent('Hardware');
  });
});

// #3547: editing a persisted table used to mean delete-and-recreate. The edit
// affordance reuses the create-form fields, prefilled from block.content, and
// saves through the same updateBlock path the contract block established.
describe('QuoteEditor — edit persisted table block', () => {
  const tableBlock: QuoteBlock = {
    id: 'blk-t', quoteId: 'q-1', orgId: 'org-1', blockType: 'table',
    content: {
      columns: [{ label: 'Item' }, { label: 'Notes', align: 'right' }],
      rows: [{ cells: ['Router', 'Optional'] }],
      caption: 'Hardware',
    },
    sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    auth.permissions = [{ resource: '*', action: '*' }];
  });

  async function openEditor() {
    render(<QuoteEditor detail={{ ...detail, blocks: [tableBlock] }} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
  }

  it('hides the edit affordance from a read-only viewer but still renders the table', async () => {
    auth.permissions = [{ resource: 'quotes', action: 'read' }];
    await openEditor();
    expect(screen.getByTestId('quote-block-table-content-blk-t')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-block-table-blk-t-edit')).not.toBeInTheDocument();
  });

  it('prefills the grid from the persisted content when edit is opened', async () => {
    await openEditor();
    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit'));

    expect(screen.getByTestId('quote-block-table-blk-t-edit-form-column-label-0')).toHaveValue('Item');
    expect(screen.getByTestId('quote-block-table-blk-t-edit-form-column-label-1')).toHaveValue('Notes');
    expect(screen.getByTestId('quote-block-table-blk-t-edit-form-column-align-1')).toHaveValue('right');
    expect(screen.getByTestId('quote-block-table-blk-t-edit-form-cell-0-0')).toHaveValue('Router');
    expect(screen.getByTestId('quote-block-table-blk-t-edit-form-cell-0-1')).toHaveValue('Optional');
    expect(screen.getByTestId('quote-block-table-blk-t-edit-form-caption')).toHaveValue('Hardware');
    // The read-only render is replaced by the form while editing.
    expect(screen.queryByTestId('quote-block-table-content-blk-t')).not.toBeInTheDocument();
  });

  it('saving PATCHes the edited grid through updateBlock and closes the form', async () => {
    updateBlockMock.mockResolvedValue(okRes({ id: 'blk-t' }));
    await openEditor();
    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit'));

    fireEvent.change(screen.getByTestId('quote-block-table-blk-t-edit-form-cell-0-0'), { target: { value: 'Switch' } });
    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit-save'));

    await waitFor(() => expect(updateBlockMock).toHaveBeenCalledWith('q-1', 'blk-t', {
      blockType: 'table',
      content: {
        columns: [{ label: 'Item' }, { label: 'Notes', align: 'right' }],
        rows: [{ cells: ['Switch', 'Optional'] }],
        caption: 'Hardware',
        zebra: false,
        headerStyle: 'plain',
      },
    }));
    // Form closes on success, returning the canvas to the rendered table.
    await waitFor(() => expect(screen.queryByTestId('quote-block-table-blk-t-edit-form')).not.toBeInTheDocument());
  });

  it('keeps grid mutations shape-valid: adding a column pads the persisted row', async () => {
    updateBlockMock.mockResolvedValue(okRes({ id: 'blk-t' }));
    await openEditor();
    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit'));
    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit-form-add-column'));
    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit-save'));

    await waitFor(() => expect(updateBlockMock).toHaveBeenCalledWith('q-1', 'blk-t', expect.objectContaining({
      content: expect.objectContaining({
        columns: [{ label: 'Item' }, { label: 'Notes', align: 'right' }, { label: '' }],
        rows: [{ cells: ['Router', 'Optional', ''] }],
      }),
    })));
  });

  it('cancel discards the draft without PATCHing, and reopening shows the persisted content again', async () => {
    await openEditor();
    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit'));
    fireEvent.change(screen.getByTestId('quote-block-table-blk-t-edit-form-cell-0-0'), { target: { value: 'Discarded' } });
    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit-cancel'));

    expect(updateBlockMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('quote-block-table-content-blk-t')).toHaveTextContent('Router');

    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit'));
    expect(screen.getByTestId('quote-block-table-blk-t-edit-form-cell-0-0')).toHaveValue('Router');
  });

  it('a failed save surfaces the error and leaves the form open with the draft intact', async () => {
    updateBlockMock.mockResolvedValue(errRes());
    await openEditor();
    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit'));
    fireEvent.change(screen.getByTestId('quote-block-table-blk-t-edit-form-cell-0-0'), { target: { value: 'Switch' } });
    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit-save'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(screen.getByTestId('quote-block-table-blk-t-edit-form-cell-0-0')).toHaveValue('Switch');
  });
});

// Review follow-up (#3631): the defensive reshape in tableFormFromContent
// DISCARDS content, so it must not be silent — and the paths it exists for
// (out-of-cap / ragged legacy content) need real coverage.
describe('QuoteEditor — persisted table needing reshape on edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.permissions = [{ resource: '*', action: '*' }];
  });

  function renderWith(content: Record<string, unknown>) {
    const block: QuoteBlock = {
      id: 'blk-t', quoteId: 'q-1', orgId: 'org-1', blockType: 'table',
      content, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    };
    render(<QuoteEditor detail={{ ...detail, blocks: [block] }} onChanged={vi.fn()} />);
    return waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
  }

  it('pads a ragged row to columns.length and warns that saving replaces the stored table', async () => {
    updateBlockMock.mockResolvedValue(okRes({ id: 'blk-t' }));
    // Row has ONE cell for TWO columns — the shape the server schema rejects.
    await renderWith({ columns: [{ label: 'Item' }, { label: 'Notes' }], rows: [{ cells: ['Router'] }] });
    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit'));

    expect(screen.getByTestId('quote-block-table-blk-t-edit-reshaped')).toBeInTheDocument();
    expect(screen.getByTestId('quote-block-table-blk-t-edit-form-cell-0-1')).toHaveValue('');

    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit-save'));
    await waitFor(() => expect(updateBlockMock).toHaveBeenCalledWith('q-1', 'blk-t', expect.objectContaining({
      content: expect.objectContaining({ rows: [{ cells: ['Router', ''] }] }),
    })));
  });

  it('does not warn when the stored content already fits', async () => {
    await renderWith({ columns: [{ label: 'Item' }], rows: [{ cells: ['Router'] }] });
    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit'));
    expect(screen.queryByTestId('quote-block-table-blk-t-edit-reshaped')).not.toBeInTheDocument();
  });

  it('truncates a table past the 8-column cap, warns, and disables add-column at the cap', async () => {
    const columns = Array.from({ length: 10 }, (_, i) => ({ label: `C${i}` }));
    await renderWith({ columns, rows: [{ cells: columns.map((_, i) => `v${i}`) }] });
    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit'));

    expect(screen.getByTestId('quote-block-table-blk-t-edit-reshaped')).toBeInTheDocument();
    expect(screen.getByTestId('quote-block-table-blk-t-edit-form-column-label-7')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-block-table-blk-t-edit-form-column-label-8')).not.toBeInTheDocument();
    // Already at the cap, so the grid cannot grow further.
    expect(screen.getByTestId('quote-block-table-blk-t-edit-form-add-column')).toBeDisabled();
  });

  it('flashes the saved cue after a successful edit', async () => {
    updateBlockMock.mockResolvedValue(okRes({ id: 'blk-t' }));
    await renderWith({ columns: [{ label: 'Item' }], rows: [{ cells: ['Router'] }] });
    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit'));
    fireEvent.change(screen.getByTestId('quote-block-table-blk-t-edit-form-cell-0-0'), { target: { value: 'Switch' } });
    fireEvent.click(screen.getByTestId('quote-block-table-blk-t-edit-save'));

    // The live region is always mounted — only its TEXT changes — so assert the
    // announcement, not the element's presence (which would pass regardless).
    expect(screen.getByTestId('quote-block-table-blk-t-saved')).toHaveTextContent('');
    await waitFor(() => expect(screen.getByTestId('quote-block-table-blk-t-saved')).toHaveTextContent('Saved'));
  });
});
