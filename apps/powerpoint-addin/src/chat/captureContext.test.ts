import { describe, expect, it } from 'vitest';
import { getOfficeMock, MockShapeState } from '../__tests__/officeMock';
import { capturePptContext, capturePptName } from './captureContext';

describe('capturePptContext', () => {
  it("'none' sends kind only", async () => {
    await expect(capturePptContext('none')).resolves.toEqual({ kind: 'none' });
  });

  it("'selection' captures the selected shapes text under text", async () => {
    const mock = getOfficeMock();
    mock.selectShapes([new MockShapeState('alpha'), new MockShapeState('beta')]);
    await expect(capturePptContext('selection')).resolves.toEqual({
      kind: 'selection',
      text: 'alpha\nbeta',
    });
  });

  it("'sheet' captures the WHOLE deck text", async () => {
    const mock = getOfficeMock();
    mock.setSlides([['Title One', 'body one'], ['Title Two']]);
    const ctx = (await capturePptContext('sheet')) as { kind: string; text: string };
    expect(ctx.kind).toBe('sheet');
    expect(ctx.text).toContain('Title One');
    expect(ctx.text).toContain('body one');
    expect(ctx.text).toContain('Title Two');
  });
});

describe('capturePptName', () => {
  it('reads the open presentation file name', async () => {
    getOfficeMock().presentationTitle = 'Deck.pptx';
    await expect(capturePptName()).resolves.toBe('Deck.pptx');
  });
});
