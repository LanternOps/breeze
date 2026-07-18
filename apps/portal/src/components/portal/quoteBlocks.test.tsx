// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { QuoteBlock } from '@/lib/api';
import { QuoteBlocks } from './quoteBlocks';

afterEach(() => cleanup());

const buildUrl = (path: string) => `https://portal.example.test${path}`;

function renderBlocks(blocks: QuoteBlock[]) {
  return render(
    <QuoteBlocks
      blocks={blocks}
      lines={[]}
      currency="USD"
      imageUrl={(imageId) => `https://portal.example.test/images/${imageId}`}
      buildUrl={buildUrl}
    />
  );
}

describe('QuoteBlocks — contract block rendering', () => {
  it('renders an authored contract block via dangerouslySetInnerHTML with a template name + version footer', () => {
    const blocks: QuoteBlock[] = [
      {
        id: 'block-1',
        blockType: 'contract',
        sortOrder: 0,
        content: {
          label: 'Master Services Agreement',
          templateName: 'MSA',
          versionNumber: 3,
          sourceType: 'authored',
          renderedHtml: '<p>Acme Co agrees to Texas law.</p>',
          fileUrl: null,
        },
      },
    ];
    renderBlocks(blocks);

    const el = screen.getByTestId('contract-block');
    expect(el.innerHTML).toContain('Acme Co agrees to Texas law.');
    expect(el.textContent).toContain('Master Services Agreement');
    expect(el.textContent).toContain('MSA');
    expect(el.textContent).toContain('3');
    // Never render the raw authoring shape — no template ids/tokens leak to markup.
    expect(el.innerHTML).not.toContain('{{');
  });

  it('renders an uploaded contract block as an iframe (built from fileUrl) plus a download link', () => {
    const blocks: QuoteBlock[] = [
      {
        id: 'block-2',
        blockType: 'contract',
        sortOrder: 0,
        content: {
          templateName: 'Vendor MSA (uploaded)',
          versionNumber: 1,
          sourceType: 'uploaded',
          renderedHtml: null,
          fileUrl: '/portal/quotes/quote-1/contract-file/block-2',
        },
      },
    ];
    renderBlocks(blocks);

    const el = screen.getByTestId('contract-block');
    const iframe = el.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('src')).toBe('https://portal.example.test/portal/quotes/quote-1/contract-file/block-2');
    expect(iframe?.getAttribute('title')).toBe('Vendor MSA (uploaded)');

    const download = screen.getByTestId('contract-block-download');
    expect(download.getAttribute('href')).toBe('https://portal.example.test/portal/quotes/quote-1/contract-file/block-2');
  });

  it('shows an unavailable fallback for an uploaded block with no fileUrl', () => {
    const blocks: QuoteBlock[] = [
      {
        id: 'block-3',
        blockType: 'contract',
        sortOrder: 0,
        content: { templateName: 'MSA', versionNumber: 1, sourceType: 'uploaded', renderedHtml: null, fileUrl: null },
      },
    ];
    renderBlocks(blocks);
    const el = screen.getByTestId('contract-block');
    expect(el.textContent).toContain('Contract file unavailable');
    expect(el.querySelector('iframe')).toBeNull();
  });
});
