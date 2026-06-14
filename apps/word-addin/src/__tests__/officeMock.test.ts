import { describe, expect, it } from 'vitest';
import { getOfficeMock } from './officeMock';

describe('officeMock — Word.run lifecycle', () => {
  it('throws when reading body.text before context.sync()', async () => {
    getOfficeMock().setBody('hello');
    await Word.run(async (context) => {
      const body = context.document.body;
      body.load('text');
      expect(() => body.text).toThrow(/PropertyNotLoaded/);
      await context.sync();
      expect(body.text).toBe('hello');
    });
  });

  it('throws when reading paragraph items before sync()', async () => {
    getOfficeMock().setBody('a\nb');
    await Word.run(async (context) => {
      const paras = context.document.body.paragraphs;
      paras.load('items/text');
      expect(() => paras.items).toThrow(/PropertyNotLoaded/);
      await context.sync();
      expect(paras.items.map((p) => p.text)).toEqual(['a', 'b']);
    });
  });

  it('queues insertText until sync', async () => {
    const mock = getOfficeMock();
    mock.setBody('start');
    mock.select(5, 5);
    await Word.run(async (context) => {
      const sel = context.document.getSelection();
      sel.insertText('!', 'End');
      // Not applied until the trailing Word.run sync.
      expect(mock.bodyText).toBe('start');
    });
    expect(mock.bodyText).toBe('start!');
  });

  it('records font patches at sync (underline as a UnderlineType string)', async () => {
    const mock = getOfficeMock();
    mock.setBody('x');
    mock.select(0, 1);
    await Word.run(async (context) => {
      const sel = context.document.getSelection();
      sel.font.bold = true;
      sel.font.underline = 'Single';
    });
    expect(mock.fontPatches).toEqual([{ bold: true, underline: 'Single' }]);
  });

  it('search + insertText("replace") performs search-and-replace at sync', async () => {
    const mock = getOfficeMock();
    mock.setBody('foo foo');
    await Word.run(async (context) => {
      const results = context.document.body.search('foo');
      results.load('items');
      await context.sync();
      for (const match of results.items) match.insertText('bar', 'Replace');
    });
    expect(mock.bodyText).toBe('bar bar');
  });

  it('increments syncCount on each sync (Word.run does one trailing sync)', async () => {
    const mock = getOfficeMock();
    await Word.run(async (context) => {
      await context.sync();
    });
    expect(mock.syncCount).toBe(2); // one explicit + one trailing
  });

  it('Office.onReady reports the Word host', async () => {
    const info = await Office.onReady();
    expect(info.host).toBe('Word');
  });
});
