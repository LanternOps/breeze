import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData, QuoteBlock } from './quoteTypes';
import { addBlock, updateBlock } from '../../../lib/api/quotes';
import { listContractTemplates, getContractTemplate } from '../../../lib/api/contractTemplates';

vi.mock('../../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
  ),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
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

vi.mock('../../../lib/api/contractTemplates', () => ({
  listContractTemplates: vi.fn(),
  getContractTemplate: vi.fn(),
}));

const okRes = (data: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data }) } as unknown as Response);
const err422 = (body: unknown) =>
  ({ ok: false, status: 422, statusText: 'Unprocessable', json: vi.fn().mockResolvedValue(body) } as unknown as Response);

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
const listMock = vi.mocked(listContractTemplates);
const getMock = vi.mocked(getContractTemplate);

const templateRow = {
  id: 'tpl-1', orgId: null, partnerId: 'p-1', name: 'MSA', description: null, status: 'active',
  createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  latestVersion: {
    id: 'ver-2', templateId: 'tpl-1', orgId: null, partnerId: 'p-1', versionNumber: 2,
    status: 'published', sourceType: 'authored', bodyHtml: '<p>{{client.name}} {{initial_term}}</p>',
    mime: null, byteSize: null, sha256: 'x',
    declaredVariables: [{ name: 'client.name', kind: 'auto' }, { name: 'initial_term', kind: 'manual' }],
    publishedAt: '2026-06-01T00:00:00Z', createdBy: null, createdAt: '2026-06-01T00:00:00Z',
  },
};

const templateDetail = {
  ...templateRow,
  versions: [
    {
      id: 'ver-2', templateId: 'tpl-1', orgId: null, partnerId: 'p-1', versionNumber: 2,
      status: 'published', sourceType: 'authored', bodyHtml: '<p>{{client.name}} {{initial_term}}</p>',
      mime: null, byteSize: null, sha256: 'x',
      declaredVariables: [{ name: 'client.name', kind: 'auto' }, { name: 'initial_term', kind: 'manual' }],
      publishedAt: '2026-06-01T00:00:00Z', createdBy: null, createdAt: '2026-06-01T00:00:00Z',
    },
    {
      id: 'ver-1', templateId: 'tpl-1', orgId: null, partnerId: 'p-1', versionNumber: 1,
      status: 'published', sourceType: 'authored', bodyHtml: '<p>old</p>',
      mime: null, byteSize: null, sha256: 'y',
      declaredVariables: [], publishedAt: '2026-05-01T00:00:00Z', createdBy: null, createdAt: '2026-05-01T00:00:00Z',
    },
  ],
};

async function openContractForm() {
  render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('quote-add-block-type-contract'));
  // Templates load lazily when the contract type is selected.
  await waitFor(() => expect(listMock).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByTestId('quote-block-contract-template')).toBeInTheDocument());
}

async function selectTemplate() {
  fireEvent.change(screen.getByTestId('quote-block-contract-template'), { target: { value: 'tpl-1' } });
  await waitFor(() => expect(getMock).toHaveBeenCalledWith('tpl-1'));
  // Pinned-version indicator + the manual variable input appear once the
  // latest published version is resolved.
  await waitFor(() => expect(screen.getByTestId('quote-block-contract-var-initial_term')).toBeInTheDocument());
}

describe('QuoteEditor — add contract block', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue(okRes([templateRow]));
    getMock.mockResolvedValue(okRes(templateDetail));
  });

  it('pins the latest published version and shows auto (read-only) + manual (editable) variables', async () => {
    await openContractForm();
    await selectTemplate();
    // Pinned version pulled from the latest published version (v2).
    expect(screen.getByTestId('quote-block-contract-version')).toHaveTextContent('2');
    // Auto variable is rendered read-only (no input to type into).
    expect(screen.getByTestId('quote-block-contract-auto-client.name')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-block-contract-var-client.name')).not.toBeInTheDocument();
    // Manual variable is an editable input.
    expect(screen.getByTestId('quote-block-contract-var-initial_term')).toBeInTheDocument();
  });

  it('posts content with templateId, pinned templateVersionId, and manual variableValues', async () => {
    addBlockMock.mockResolvedValue(okRes({}));
    await openContractForm();
    await selectTemplate();

    fireEvent.change(screen.getByTestId('quote-block-contract-var-initial_term'), { target: { value: '12 months' } });
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(addBlockMock).toHaveBeenCalledWith('q-1', {
      blockType: 'contract',
      content: { templateId: 'tpl-1', templateVersionId: 'ver-2', variableValues: { initial_term: '12 months' } },
    }));
  });

  it('blocks submit with an inline error when a manual variable is empty', async () => {
    await openContractForm();
    await selectTemplate();

    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    expect(screen.getByTestId('quote-block-contract-var-error-initial_term')).toBeInTheDocument();
    expect(addBlockMock).not.toHaveBeenCalled();
  });

  it('renders a send-blocked 422 CONTRACT_VARIABLES_UNRESOLVED as inline variable errors', async () => {
    addBlockMock.mockResolvedValue(
      err422({ code: 'CONTRACT_VARIABLES_UNRESOLVED', message: 'Contract variables unresolved: initial_term' }),
    );
    await openContractForm();
    await selectTemplate();

    fireEvent.change(screen.getByTestId('quote-block-contract-var-initial_term'), { target: { value: '12 months' } });
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('quote-block-contract-var-error-initial_term')).toBeInTheDocument(),
    );
  });
});

describe('QuoteEditor — existing contract block', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue(okRes([templateRow]));
    getMock.mockResolvedValue(okRes(templateDetail));
  });

  it('renders a read-only contract card when no admin authoring fields are present', async () => {
    const contractBlock: QuoteBlock = {
      id: 'blk-c', quoteId: 'q-1', orgId: 'org-1', blockType: 'contract',
      // Server-rendered client shape without `authoring` (legacy / non-admin).
      content: { templateName: 'MSA', versionNumber: 2, sourceType: 'authored', renderedHtml: '<p>Acme 12 months</p>', fileUrl: null },
      sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    };
    render(<QuoteEditor detail={{ ...detail, blocks: [contractBlock] }} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-block-contract-content-blk-c')).toBeInTheDocument());
    expect(screen.getByTestId('quote-block-contract-content-blk-c')).toHaveTextContent('MSA');
  });
});

const updateBlockMock = vi.mocked(updateBlock);

function persistedContractBlock(over: Partial<Record<string, unknown>> = {}): QuoteBlock {
  return {
    id: 'blk-c', quoteId: 'q-1', orgId: 'org-1', blockType: 'contract',
    content: {
      templateName: 'MSA', versionNumber: 1, sourceType: 'authored',
      renderedHtml: '<p>Acme 12 months</p>', fileUrl: null, label: 'Master Agreement',
      authoring: {
        templateId: 'tpl-1', templateVersionId: 'ver-1',
        variableValues: { initial_term: '12 months' },
        declaredVariables: [{ name: 'client.name', kind: 'auto' }, { name: 'initial_term', kind: 'manual' }],
        latestPublishedVersionId: 'ver-2', latestPublishedVersionNumber: 2,
        ...over,
      },
    },
    sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
  };
}

describe('QuoteEditor — edit persisted contract block', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue(okRes([templateRow]));
    getMock.mockResolvedValue(okRes(templateDetail));
  });

  async function renderWithBlock(block: QuoteBlock) {
    render(<QuoteEditor detail={{ ...detail, blocks: [block] }} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
  }

  it('renders auto read-only + manual editable variables seeded from authoring, and PATCHes on save', async () => {
    updateBlockMock.mockResolvedValue(okRes({}));
    await renderWithBlock(persistedContractBlock());

    expect(screen.getByTestId('quote-block-contract-auto-blk-c-client.name')).toBeInTheDocument();
    const input = screen.getByTestId('quote-block-contract-var-blk-c-initial_term');
    expect(input).toHaveValue('12 months');

    fireEvent.change(input, { target: { value: '24 months' } });
    fireEvent.click(screen.getByTestId('quote-block-contract-save-blk-c'));

    await waitFor(() => expect(updateBlockMock).toHaveBeenCalledWith('q-1', 'blk-c', {
      blockType: 'contract',
      content: { templateId: 'tpl-1', templateVersionId: 'ver-1', variableValues: { initial_term: '24 months' }, label: 'Master Agreement' },
    }));
  });

  it('shows an "Update to vN" button when the pinned version is behind latest, and re-pins preserving values', async () => {
    updateBlockMock.mockResolvedValue(okRes({}));
    await renderWithBlock(persistedContractBlock());

    const update = screen.getByTestId('quote-block-contract-update-blk-c');
    expect(update).toHaveTextContent('2');
    fireEvent.click(update);

    await waitFor(() => expect(updateBlockMock).toHaveBeenCalledWith('q-1', 'blk-c', {
      blockType: 'contract',
      content: { templateId: 'tpl-1', templateVersionId: 'ver-2', variableValues: { initial_term: '12 months' }, label: 'Master Agreement' },
    }));
  });

  it('does not show the update button when the pinned version is already the latest published', async () => {
    await renderWithBlock(persistedContractBlock({ latestPublishedVersionId: 'ver-1', latestPublishedVersionNumber: 1 }));
    expect(screen.queryByTestId('quote-block-contract-update-blk-c')).not.toBeInTheDocument();
  });

  it('names unresolved (empty) manual variables inline and blocks save with a required error', async () => {
    await renderWithBlock(persistedContractBlock({ variableValues: {} }));

    // The empty manual variable is named in a visible inline warning (the
    // send-time CONTRACT_VARIABLES_UNRESOLVED equivalent on the block card).
    expect(screen.getByTestId('quote-block-contract-unresolved-blk-c')).toHaveTextContent('initial_term');

    fireEvent.click(screen.getByTestId('quote-block-contract-save-blk-c'));

    expect(screen.getByTestId('quote-block-contract-var-error-blk-c-initial_term')).toBeInTheDocument();
    expect(updateBlockMock).not.toHaveBeenCalled();
  });
});
