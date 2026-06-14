import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { addSlide } from './addSlide';

describe('add_slide', () => {
  it('adds a slide natively when PowerPointApi 1.4 is supported', async () => {
    const mock = getOfficeMock();
    const before = mock.slides.length;
    const result = (await addSlide({})) as { added: boolean; via: string };
    expect(result).toEqual({ added: true, via: 'native' });
    expect(mock.slides.length).toBe(before + 1);
    expect(mock.slides[mock.slides.length - 1].createdVia).toBe('native');
  });

  it('resolves a layout by name when layoutName is given', async () => {
    const mock = getOfficeMock();
    const result = (await addSlide({ layoutName: 'Title Slide' })) as { added: boolean; via: string };
    expect(result.via).toBe('native');
    expect(mock.slides[mock.slides.length - 1].createdVia).toBe('native');
  });

  it('falls back to OOXML insertSlidesFromBase64 when native add is unsupported', async () => {
    const mock = getOfficeMock();
    // Flip the 1.4 capability off — native presentation.slides.add throws.
    mock.supportedApiSets.delete('1.4');
    const before = mock.slides.length;
    const result = (await addSlide({})) as { added: boolean; via: string };
    expect(result).toEqual({ added: true, via: 'ooxml' });
    expect(mock.slides.length).toBe(before + 1);
    expect(mock.slides[mock.slides.length - 1].createdVia).toBe('ooxml');
  });
});
