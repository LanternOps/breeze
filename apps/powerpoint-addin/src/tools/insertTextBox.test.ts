import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { insertTextBox } from './insertTextBox';

describe('insert_text_box', () => {
  it('adds a text box to the targeted slide and reports its index', async () => {
    const mock = getOfficeMock();
    mock.setSlides([['Slide 1'], ['Slide 2']]);
    const before = mock.slides[1].shapes.length;
    const result = (await insertTextBox({ text: 'New caption', slideIndex: 1 })) as {
      inserted: boolean;
      slideIndex: number;
    };
    expect(result).toEqual({ inserted: true, slideIndex: 1 });
    expect(mock.slides[1].shapes.length).toBe(before + 1);
    expect(mock.slides[1].shapes[mock.slides[1].shapes.length - 1].text).toBe('New caption');
  });

  it('defaults to the selected slide when slideIndex is omitted', async () => {
    const mock = getOfficeMock();
    mock.setSlides([['Slide 1'], ['Slide 2']]);
    mock.selectSlides([1]);
    const result = (await insertTextBox({ text: 'On selected' })) as { slideIndex: number };
    expect(result.slideIndex).toBe(1);
    expect(mock.slides[1].shapes[mock.slides[1].shapes.length - 1].text).toBe('On selected');
  });

  it('returns {error} (does NOT throw) when PowerPointApi 1.4 is unsupported', async () => {
    const mock = getOfficeMock();
    mock.supportedApiSets.delete('1.4');
    const result = (await insertTextBox({ text: 'x', slideIndex: 0 })) as { error?: string };
    expect(typeof result.error).toBe('string');
    expect(result.error).toMatch(/1\.4/);
  });

  it('rejects a missing/empty text', async () => {
    await expect(insertTextBox({ slideIndex: 0 })).rejects.toThrow(/text/);
  });

  it('rejects a negative slideIndex', async () => {
    await expect(insertTextBox({ text: 'x', slideIndex: -1 })).rejects.toThrow(/slideIndex/);
  });
});
