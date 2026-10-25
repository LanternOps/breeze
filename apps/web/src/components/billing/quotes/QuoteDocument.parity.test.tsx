import { readFileSync } from 'node:fs';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUOTE_DTO_FIXTURES, type QuoteFixtureName } from '@breeze/shared/documents';
import { STAND_IN_COMPONENTS, quoteSnapshotPath, normalizeDocumentRoot } from '@breeze/document-ui/testing';

import QuoteDocumentPreview from './QuoteDocument';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const FIXTURES = Object.keys(QUOTE_DTO_FIXTURES) as QuoteFixtureName[];

// The Preview refetches from the staff detail's id only; the body is the customer DTO.
const staffDetail = { quote: { id: 'q-parity', quoteNumber: 'X', status: 'sent' }, blocks: [], lines: [] } as unknown as QuoteDetailData;

describe('web Preview DOM parity with the shared snapshot set', () => {
  beforeEach(() => fetchWithAuth.mockReset());

  it.each(FIXTURES)('%s equals the committed snapshot', async (name) => {
    fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: QUOTE_DTO_FIXTURES[name] }) });
    const { container } = render(<QuoteDocumentPreview detail={staffDetail} components={STAND_IN_COMPONENTS} />);
    await waitFor(() => expect(container.querySelector('[data-document-root]')).not.toBeNull());
    expect(normalizeDocumentRoot(container)).toBe(readFileSync(quoteSnapshotPath(name), 'utf8'));
  });
});
