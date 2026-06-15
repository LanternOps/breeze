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

  it('returns a clean error (no slide added) when PowerPointApi 1.4 is unsupported', async () => {
    const mock = getOfficeMock();
    mock.supportedApiSets.delete('1.4');
    const before = mock.slides.length;
    const result = (await addSlide({})) as { error?: string; added?: boolean };
    expect(result.error).toMatch(/PowerPointApi 1\.4/);
    expect(result.added).toBeUndefined();
    expect(mock.slides.length).toBe(before); // no slide added on the unsupported path
  });
});
