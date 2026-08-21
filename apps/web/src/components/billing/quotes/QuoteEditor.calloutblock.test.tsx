import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData, QuoteBlock } from './quoteTypes';
import { addBlock, updateBlock } from '../../../lib/api/quotes';

// Mutable grant set so the edit-affordance gating (writer vs read-only) can be
// exercised in this file; defaults to the wildcard the create tests assume.
const auth = vi.hoisted(() => ({ permissions: [{ resource: '*', action: '*' }] as { resource: string; action: string }[] }));

// Same house pattern as TemplateEditor.test.tsx: swap the tiptap-backed
// RichTextEditor for a plain textarea so this test targets the callout form
// (variant/title/body wiring, submit), not rich-text editing internals.
vi.mock('../../common/RichTextEditor', () => ({
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

async function openCalloutForm() {
  render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('quote-add-block-type-callout'));
  await waitFor(() => expect(screen.getByTestId('quote-block-callout')).toBeInTheDocument());
}

describe('QuoteEditor — add callout block', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a "Callout" chip in the add-block picker', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    expect(screen.getByTestId('quote-add-block-type-callout')).toBeInTheDocument();
  });

  it('defaults the variant to "info" and offers info/accent/warn', async () => {
    await openCalloutForm();
    const select = screen.getByTestId('quote-block-callout-variant');
    expect(select).toHaveValue('info');
    const options = Array.from((select as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(['info', 'accent', 'warn']);
  });

  it('submit is disabled until body text is entered', async () => {
    await openCalloutForm();
    expect(screen.getByTestId('quote-add-block-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('quote-block-callout-body'), { target: { value: '<p>Note</p>' } });
    expect(screen.getByTestId('quote-add-block-submit')).not.toBeDisabled();
  });

  it('creating a callout POSTs blockType "callout" with variant/title/html', async () => {
    addBlockMock.mockResolvedValue(okRes({ id: 'blk-c' }));
    await openCalloutForm();

    fireEvent.change(screen.getByTestId('quote-block-callout-variant'), { target: { value: 'warn' } });
    fireEvent.change(screen.getByTestId('quote-block-callout-title'), { target: { value: 'Heads up' } });
    fireEvent.change(screen.getByTestId('quote-block-callout-body'), { target: { value: '<p>Read carefully</p>' } });

    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(addBlockMock).toHaveBeenCalledWith('q-1', {
      blockType: 'callout',
      content: { variant: 'warn', title: 'Heads up', html: '<p>Read carefully</p>' },
    }));
  });

  it('omits an empty title from the submitted content', async () => {
    addBlockMock.mockResolvedValue(okRes({ id: 'blk-c' }));
    await openCalloutForm();

    fireEvent.change(screen.getByTestId('quote-block-callout-body'), { target: { value: '<p>Note</p>' } });
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(addBlockMock).toHaveBeenCalledWith('q-1', {
      blockType: 'callout',
      content: { variant: 'info', html: '<p>Note</p>' },
    }));
  });

  it('disables submit while add-block is in flight and re-enables with an error surfaced on failure', async () => {
    addBlockMock.mockResolvedValue(errRes());
    await openCalloutForm();
    fireEvent.change(screen.getByTestId('quote-block-callout-body'), { target: { value: '<p>Note</p>' } });

    const submit = screen.getByTestId('quote-add-block-submit');
    fireEvent.click(submit);

    // Rejected request: the pending guard must unlatch (not leave submit
    // permanently disabled) and the failure must be visible — the #3519
    // regression class this brief calls out explicitly.
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    await waitFor(() => expect(submit).not.toBeDisabled());
  });
});

describe('QuoteEditor — persisted callout block', () => {
  beforeEach(() => vi.clearAllMocks());

  // Regression: after Task 13's initial cut, QuoteBlockCard had no branch for
  // `table`/`callout`, so a just-created (or reloaded) callout block rendered
  // as an empty block — invisible on the canvas even though it existed
  // server-side. This proves the read-only display branch renders content.
  it('renders the persisted callout content visibly (not blank) on the canvas', async () => {
    const calloutBlock: QuoteBlock = {
      id: 'blk-c', quoteId: 'q-1', orgId: 'org-1', blockType: 'callout',
      content: { variant: 'warn', title: 'Heads up', html: '<p>Read carefully</p>' },
      sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    };
    render(<QuoteEditor detail={{ ...detail, blocks: [calloutBlock] }} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-block-callout-content-blk-c')).toBeInTheDocument());
    const content = screen.getByTestId('quote-block-callout-content-blk-c');
    expect(content).toHaveTextContent('Heads up');
    expect(content).toHaveTextContent('Read carefully');
  });
});

// #3547: same edit-in-place contract as the table block — the create-form
// fields, prefilled from block.content, saved through updateBlock.
describe('QuoteEditor — edit persisted callout block', () => {
  const calloutBlock: QuoteBlock = {
    id: 'blk-c', quoteId: 'q-1', orgId: 'org-1', blockType: 'callout',
    content: { variant: 'warn', title: 'Heads up', html: '<p>Read carefully</p>' },
    sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    auth.permissions = [{ resource: '*', action: '*' }];
  });

  async function openEditor() {
    render(<QuoteEditor detail={{ ...detail, blocks: [calloutBlock] }} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
  }

  it('hides the edit affordance from a read-only viewer but still renders the callout', async () => {
    auth.permissions = [{ resource: 'quotes', action: 'read' }];
    await openEditor();
    expect(screen.getByTestId('quote-block-callout-content-blk-c')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-block-callout-blk-c-edit')).not.toBeInTheDocument();
  });

  it('prefills variant, title and body when edit is opened', async () => {
    await openEditor();
    fireEvent.click(screen.getByTestId('quote-block-callout-blk-c-edit'));

    expect(screen.getByTestId('quote-block-callout-blk-c-edit-form-variant')).toHaveValue('warn');
    expect(screen.getByTestId('quote-block-callout-blk-c-edit-form-title')).toHaveValue('Heads up');
    expect(screen.getByTestId('quote-block-callout-blk-c-edit-form-body')).toHaveValue('<p>Read carefully</p>');
    expect(screen.queryByTestId('quote-block-callout-content-blk-c')).not.toBeInTheDocument();
  });

  it('saving PATCHes the edited content through updateBlock and closes the form', async () => {
    updateBlockMock.mockResolvedValue(okRes({ id: 'blk-c' }));
    await openEditor();
    fireEvent.click(screen.getByTestId('quote-block-callout-blk-c-edit'));

    fireEvent.change(screen.getByTestId('quote-block-callout-blk-c-edit-form-variant'), { target: { value: 'accent' } });
    fireEvent.change(screen.getByTestId('quote-block-callout-blk-c-edit-form-body'), { target: { value: '<p>Revised</p>' } });
    fireEvent.click(screen.getByTestId('quote-block-callout-blk-c-edit-save'));

    await waitFor(() => expect(updateBlockMock).toHaveBeenCalledWith('q-1', 'blk-c', {
      blockType: 'callout',
      content: { variant: 'accent', title: 'Heads up', html: '<p>Revised</p>' },
    }));
    await waitFor(() => expect(screen.queryByTestId('quote-block-callout-blk-c-edit-form')).not.toBeInTheDocument());
  });

  it('clearing the title drops it from the PATCHed content (never sent as an empty string)', async () => {
    updateBlockMock.mockResolvedValue(okRes({ id: 'blk-c' }));
    await openEditor();
    fireEvent.click(screen.getByTestId('quote-block-callout-blk-c-edit'));
    fireEvent.change(screen.getByTestId('quote-block-callout-blk-c-edit-form-title'), { target: { value: '  ' } });
    fireEvent.click(screen.getByTestId('quote-block-callout-blk-c-edit-save'));

    await waitFor(() => expect(updateBlockMock).toHaveBeenCalledWith('q-1', 'blk-c', {
      blockType: 'callout',
      content: { variant: 'warn', html: '<p>Read carefully</p>' },
    }));
  });

  it('an emptied body disables save (an empty callout renders as nothing)', async () => {
    await openEditor();
    fireEvent.click(screen.getByTestId('quote-block-callout-blk-c-edit'));
    fireEvent.change(screen.getByTestId('quote-block-callout-blk-c-edit-form-body'), { target: { value: '' } });

    expect(screen.getByTestId('quote-block-callout-blk-c-edit-save')).toBeDisabled();
    expect(updateBlockMock).not.toHaveBeenCalled();
  });

  it('cancel discards the draft without PATCHing', async () => {
    await openEditor();
    fireEvent.click(screen.getByTestId('quote-block-callout-blk-c-edit'));
    fireEvent.change(screen.getByTestId('quote-block-callout-blk-c-edit-form-body'), { target: { value: '<p>Discarded</p>' } });
    fireEvent.click(screen.getByTestId('quote-block-callout-blk-c-edit-cancel'));

    expect(updateBlockMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('quote-block-callout-content-blk-c')).toHaveTextContent('Read carefully');

    fireEvent.click(screen.getByTestId('quote-block-callout-blk-c-edit'));
    expect(screen.getByTestId('quote-block-callout-blk-c-edit-form-body')).toHaveValue('<p>Read carefully</p>');
  });

  it('a failed save surfaces the error and leaves the form open with the draft intact', async () => {
    updateBlockMock.mockResolvedValue(errRes());
    await openEditor();
    fireEvent.click(screen.getByTestId('quote-block-callout-blk-c-edit'));
    fireEvent.change(screen.getByTestId('quote-block-callout-blk-c-edit-form-body'), { target: { value: '<p>Revised</p>' } });
    fireEvent.click(screen.getByTestId('quote-block-callout-blk-c-edit-save'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(screen.getByTestId('quote-block-callout-blk-c-edit-form-body')).toHaveValue('<p>Revised</p>');
  });
});
