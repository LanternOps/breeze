import { render } from '@testing-library/react';
import type { DocumentBranding, QuoteCoverModel } from '@breeze/shared/documents';
import { DocumentCover } from '../DocumentCover';
import { DocumentCoverCrop } from '../DocumentCoverCrop';
import { STAND_IN_COMPONENTS } from '../__fixtures__/testing';

const COVER: QuoteCoverModel = {
  title: 'Network refresh proposal',
  image: { kind: 'cover', id: '00000000-0000-4000-8000-000000000050' },
  preparedFor: 'Acme Dental',
  preparedBy: 'Example MSP',
  eyebrow: 'Proposal',
  preparedForLabel: 'Prepared for',
  preparedByLabel: 'Prepared by',
};

const BRANDING: DocumentBranding = {
  logo: null, logoAlt: 'Example MSP', wordmark: 'Example MSP', theme: 'classic', pageSize: 'a4', seller: null,
};

const renderCover = (cover: QuoteCoverModel, pageSize: 'a4' | 'letter', branding: Partial<DocumentBranding> = {}) =>
  render(<DocumentCover cover={cover} branding={{ ...BRANDING, ...branding, pageSize }} components={STAND_IN_COMPONENTS} />);

describe('DocumentCover — OD-5 geometry (the PDF page, as classes)', () => {
  it.each([['a4', 'doc-cover-a4', 'doc-cover-letter'], ['letter', 'doc-cover-letter', 'doc-cover-a4']] as const)(
    '%s image cover is a page-aspect frame with a centre-cropped image',
    (size, has, hasNot) => {
      const { getByTestId } = renderCover(COVER, size);
      const frame = getByTestId('document-cover-frame');
      expect(frame.className).toContain('doc-cover-frame');
      expect(frame.className).toContain(has);
      expect(frame.className).not.toContain(hasNot);
      expect(frame.querySelector('img')!.className).toContain('doc-cover-image');
    },
  );

  it('title, prepared for/by sit in the band that starts at 62% (a class, not a style)', () => {
    const { getByTestId } = renderCover(COVER, 'a4');
    const band = getByTestId('document-cover-band');
    expect(band.className).toContain('doc-cover-band');
    expect(band.querySelector('h1')!.textContent).toBe('Network refresh proposal');
    expect(band.textContent).toContain('Acme Dental');
    expect(band.textContent).toContain('Example MSP');
    expect(getByTestId('document-cover').querySelectorAll('[style]')).toHaveLength(0);
  });

  it('a cover without an image keeps the flowing text layout (no page frame)', () => {
    const { queryByTestId, getByTestId } = renderCover({ ...COVER, image: null }, 'a4');
    expect(queryByTestId('document-cover-frame')).toBeNull();
    expect(getByTestId('document-cover').querySelector('h1')!.textContent).toBe('Network refresh proposal');
  });
});

// #9957: the PDF cover draws the partner logo (or name) top-left, on a white pill
// over artwork; the screen cover drew neither, so the two did not match.
describe('DocumentCover — brand mark (PDF parity)', () => {
  it('an image cover carries the wordmark on a pill inside the page frame, above the band', () => {
    const { getByTestId } = renderCover(COVER, 'letter');
    const mark = getByTestId('document-cover-brand');
    expect(mark.textContent).toBe('Example MSP');
    expect(mark.className).toContain('doc-cover-brand');
    expect(getByTestId('document-cover-frame').contains(mark)).toBe(true);
    expect(getByTestId('document-cover-band').contains(mark)).toBe(false);
  });

  it('an uploaded logo replaces the wordmark', () => {
    const { getByTestId } = renderCover(COVER, 'a4', { logo: { kind: 'url', url: 'https://example.test/logo.png' } });
    const img = getByTestId('document-cover-brand').querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://example.test/logo.png');
    expect(img.getAttribute('alt')).toBe('Example MSP');
    expect(getByTestId('document-cover-brand').textContent).toBe('');
  });

  it('an uploaded (asset) logo renders through the host Image component', () => {
    const ref = { kind: 'logo', id: '00000000-0000-4000-8000-000000000060' } as const;
    const { getByTestId } = renderCover(COVER, 'a4', { logo: { kind: 'asset', ref } as DocumentBranding['logo'] });
    const img = getByTestId('document-cover-brand').querySelector('img')!;
    expect(img.getAttribute('data-asset')).toBe(`logo:${ref.id}`);
    expect(img.getAttribute('alt')).toBe('Example MSP');
    expect(img.className).toContain('h-11');
  });

  it('a cover without an image still leads with the brand mark, and no pill', () => {
    const { getByTestId } = renderCover({ ...COVER, image: null }, 'a4');
    const mark = getByTestId('document-cover-brand');
    expect(mark.textContent).toBe('Example MSP');
    expect(mark.className).not.toContain('doc-cover-brand');
  });

  it('no logo and no wordmark renders no brand slot', () => {
    const { queryByTestId } = renderCover(COVER, 'a4', { wordmark: null, logoAlt: '' });
    expect(queryByTestId('document-cover-brand')).toBeNull();
    const empty = renderCover(COVER, 'letter', { wordmark: '', logoAlt: '' });
    expect(empty.queryByTestId('document-cover-brand')).toBeNull();
  });
});

describe('DocumentCoverCrop — the one crop the editor preview reuses', () => {
  it('renders the same frame classes around any image child', () => {
    const { getByTestId } = render(<DocumentCoverCrop pageSize="letter" testId="x"><img alt="" className="doc-cover-image" /></DocumentCoverCrop>);
    const frame = getByTestId('x');
    expect(frame.className).toContain('doc-cover-frame');
    expect(frame.className).toContain('doc-cover-letter');
  });
});
