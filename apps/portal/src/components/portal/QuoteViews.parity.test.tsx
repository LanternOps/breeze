// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { QUOTE_DTO_FIXTURES, type QuoteFixtureName } from '@breeze/shared/documents';
import { STAND_IN_COMPONENTS, normalizeDocumentRoot, quoteSnapshotPath } from '@breeze/document-ui/testing';
import type { PublicQuoteDetail, QuoteDetail } from '@/lib/api';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/replaceLocation', () => ({ replaceLocation: vi.fn() }));

import { PublicQuoteView } from './PublicQuoteView';
import { QuoteDetailView } from './QuoteDetailView';

afterEach(() => cleanup());

const FIXTURES = Object.keys(QUOTE_DTO_FIXTURES) as QuoteFixtureName[];
const snapshot = (name: QuoteFixtureName) => readFileSync(quoteSnapshotPath(name), 'utf8');

// The route envelopes the assembler produces, rebuilt from the same DTO fixtures the
// shared snapshots were generated from.
function envelope(name: QuoteFixtureName) {
  const dto = QUOTE_DTO_FIXTURES[name];
  return {
    quote: dto.quote,
    blocks: dto.blocks,
    lines: dto.lines,
    branding: dto.branding,
    presentation: { theme: dto.branding.theme, pageSize: dto.branding.pageSize },
    documentLocale: dto.documentLocale,
  };
}

describe('portal quote pages DOM parity with the shared snapshot set', () => {
  // A draft never reaches a customer surface (the assembler refuses it outside staff mode).
  it.each(FIXTURES.filter((n) => n !== 'draft'))('public %s equals the committed snapshot', (name) => {
    const { container } = render(
      <PublicQuoteView token="t" initial={envelope(name) as unknown as PublicQuoteDetail} components={STAND_IN_COMPONENTS} />,
    );
    expect(normalizeDocumentRoot(container)).toBe(snapshot(name));
  });

  it.each(FIXTURES.filter((n) => n !== 'draft'))('logged-in %s equals the committed snapshot', (name) => {
    const { container } = render(
      <QuoteDetailView detail={envelope(name) as unknown as QuoteDetail} components={STAND_IN_COMPONENTS} />,
    );
    expect(normalizeDocumentRoot(container)).toBe(snapshot(name));
  });
});
