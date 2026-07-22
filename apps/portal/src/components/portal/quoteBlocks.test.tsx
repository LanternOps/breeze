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

describe('QuoteBlocks — line rendering (title/blurb + thumbnail)', () => {
  const lineItemsBlock: QuoteBlock = {
    id: 'blk-lines', blockType: 'line_items', sortOrder: 0, content: { label: 'Hardware' },
  };
  function renderLines(lines: import('@/lib/api').QuoteLine[]) {
    return render(
      <QuoteBlocks
        blocks={[lineItemsBlock]}
        lines={lines}
        currency="USD"
        imageUrl={(imageId) => `https://portal.example.test/images/${imageId}`}
        buildUrl={buildUrl}
      />
    );
  }
  const base = {
    blockId: 'blk-lines', quantity: '1', unitPrice: '10', lineTotal: '10',
    recurrence: 'one_time', customerVisible: true, sortOrder: 0,
  };

  it('renders a bold name title with the description as a separate blurb', () => {
    renderLines([{ id: 'l1', name: 'Lenovo TIO 24 G5', description: '24 inch FHD display • IPS panel', ...base }]);
    const row = screen.getByTestId('quote-line-l1');
    expect(row.textContent).toContain('Lenovo TIO 24 G5');
    expect(row.textContent).toContain('24 inch FHD display');
    // Title is emphasized; the blurb is a distinct muted paragraph.
    expect(row.querySelector('.font-medium')?.textContent).toContain('Lenovo TIO 24 G5');
    expect(row.querySelector('p')?.textContent).toContain('24 inch FHD display');
  });

  it('falls back to description as the title for legacy lines with no name', () => {
    renderLines([{ id: 'l2', name: null, description: 'Legacy line', ...base }]);
    const row = screen.getByTestId('quote-line-l2');
    expect(row.querySelector('.font-medium')?.textContent).toContain('Legacy line');
    // No separate blurb paragraph when there's no distinct name.
    expect(row.querySelector('p')).toBeNull();
  });

  it('renders a product thumbnail resolved through buildUrl when imageUrl is present', () => {
    renderLines([{ id: 'l3', name: 'Widget', description: 'x', imageUrl: '/portal/quotes/q1/line-image/l3', ...base }]);
    const img = screen.getByTestId('quote-line-image-l3') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://portal.example.test/portal/quotes/q1/line-image/l3');
  });

  it('renders no thumbnail when imageUrl is null', () => {
    renderLines([{ id: 'l4', name: 'Widget', description: 'x', imageUrl: null, ...base }]);
    expect(screen.queryByTestId('quote-line-image-l4')).toBeNull();
  });
});
