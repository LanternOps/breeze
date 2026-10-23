// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QUOTE_DTO_FIXTURES } from '@breeze/shared/documents';
import type { PublicQuoteDetail } from '@/lib/api';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/replaceLocation', () => ({ replaceLocation: vi.fn() }));

import { PublicQuoteView } from './PublicQuoteView';
import { QuoteDetailView } from './QuoteDetailView';

afterEach(() => cleanup());

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function envelope(name: 'issued' | 'agreements' | 'cover' | 'blocks') {
  const dto = QUOTE_DTO_FIXTURES[name];
  return {
    quote: dto.quote, blocks: dto.blocks, lines: dto.lines, branding: dto.branding,
    presentation: { theme: dto.branding.theme, pageSize: dto.branding.pageSize }, documentLocale: dto.documentLocale,
  } as unknown as PublicQuoteDetail;
}

describe('portal quote host components (real elements, token-scoped routes)', () => {
  it('a line thumbnail resolves the line\'s server-built route', () => {
    render(<PublicQuoteView token="tok" initial={envelope('issued')} />);
    const img = screen.getByTestId(`quote-line-image-${id(101)}`) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`/api/v1/quotes/public/tok/line-image/${id(101)}`);
    expect(img.getAttribute('style')).toBeNull();
  });

  it('block and cover images use the page\'s image route; the author\'s width is an attribute', () => {
    render(<PublicQuoteView token="tok" initial={envelope('blocks')} />);
    const fig = screen.getByTestId(`document-block-${id(27)}`).querySelector('img')!;
    expect(fig.getAttribute('src')).toBe(`/api/v1/quotes/public/tok/images/${id(60)}`);
    expect(fig.getAttribute('width')).toBe('320');
    cleanup();
    render(<QuoteDetailView detail={envelope('cover') as never} />);
    expect(screen.getByTestId('document-cover').querySelector('img')!.getAttribute('src'))
      .toBe(`/api/v1/portal/quotes/${id(1)}/images/${id(50)}`);
  });

  it('an uploaded agreement mounts an iframe plus the download link only once opened', () => {
    render(<PublicQuoteView token="tok" initial={envelope('agreements')} />);
    const row = document.getElementById(`agreement-${id(40)}`) as HTMLDetailsElement;
    expect(row.querySelector('iframe')).toBeNull();
    row.open = true;
    fireEvent(row, new Event('toggle'));
    const iframe = row.querySelector('iframe')!;
    expect(iframe.getAttribute('src')).toBe(`/api/v1/quotes/public/tok/contract-file/${id(40)}`);
    expect(iframe.getAttribute('title')).toBe('MSA (PDF)');
    const link = screen.getByTestId('contract-block-download');
    expect(link.getAttribute('href')).toBe(iframe.getAttribute('src'));
    expect(link.textContent).toBe('Download agreement');
  });

  it('an uploaded agreement with no file shows the unavailable text and no iframe', () => {
    render(<PublicQuoteView token="tok" initial={envelope('agreements')} />);
    const row = document.getElementById(`agreement-${id(43)}`) as HTMLDetailsElement;
    row.open = true;
    fireEvent(row, new Event('toggle'));
    expect(row.querySelector('iframe')).toBeNull();
    expect(row.textContent).toContain('Agreement file unavailable');
  });
});

describe('quote status pill (displayStatus)', () => {
  it('the public page shows the Viewed pill that it used to omit', () => {
    const { container } = render(<PublicQuoteView token="tok" initial={envelope('issued')} />);
    expect(container.querySelector('[data-document-root]')!.textContent).toContain('Viewed');
  });

  it('the page moves the pill with the status it just set (accept → Accepted)', async () => {
    const { portalApi } = await import('@/lib/api');
    vi.spyOn(portalApi, 'acceptPublicQuote').mockResolvedValue({ data: { data: { invoiceUrl: null, payDeferred: false } } } as never);
    render(<PublicQuoteView token="tok" initial={envelope('issued')} />);
    fireEvent.change(screen.getByTestId('public-quote-signer'), { target: { value: 'Jo Customer' } });
    fireEvent.click(screen.getByTestId('public-quote-agree'));
    fireEvent.click(screen.getByTestId('public-quote-accept'));
    await screen.findByTestId('public-quote-accepted');
    expect(screen.getByTestId('document-root').textContent).toContain('Accepted');
  });

  it('a raw "sent" status reads Viewed on the logged-in page too', () => {
    const env = envelope('issued') as unknown as { quote: Record<string, unknown> };
    env.quote = { ...env.quote, status: 'sent', displayStatus: 'viewed' };
    const { container } = render(<QuoteDetailView detail={env as never} />);
    expect(container.querySelector('[data-document-root]')!.textContent).toContain('Viewed');
  });
});
