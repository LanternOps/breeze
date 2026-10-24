import { render } from '@testing-library/react';
import type { QuoteCoverModel } from '@breeze/shared/documents';
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

const renderCover = (cover: QuoteCoverModel, pageSize: 'a4' | 'letter') =>
  render(<DocumentCover cover={cover} pageSize={pageSize} components={STAND_IN_COMPONENTS} />);

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

describe('DocumentCoverCrop — the one crop the editor preview reuses', () => {
  it('renders the same frame classes around any image child', () => {
    const { getByTestId } = render(<DocumentCoverCrop pageSize="letter" testId="x"><img alt="" className="doc-cover-image" /></DocumentCoverCrop>);
    const frame = getByTestId('x');
    expect(frame.className).toContain('doc-cover-frame');
    expect(frame.className).toContain('doc-cover-letter');
  });
});
