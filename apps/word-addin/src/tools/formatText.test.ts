import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { formatText } from './formatText';

describe('format_text', () => {
  it('maps bold/italic/fontColor/fontSize onto the selection font', async () => {
    const mock = getOfficeMock();
    mock.setBody('styled');
    mock.select(0, 6);
    const result = (await formatText({
      format: { bold: true, italic: false, fontColor: '#FF0000', fontSize: 14 },
    })) as { applied: string[] };
    expect(result.applied).toEqual(['bold', 'italic', 'fontColor', 'fontSize']);
    expect(mock.fontPatches).toHaveLength(1);
    expect(mock.fontPatches[0]).toEqual({
      bold: true,
      italic: false,
      color: '#FF0000',
      size: 14,
    });
  });

  it('maps underline:true to the Single UnderlineType (NOT a boolean)', async () => {
    const mock = getOfficeMock();
    mock.setBody('u');
    mock.select(0, 1);
    await formatText({ format: { underline: true } });
    expect(mock.fontPatches[0]).toEqual({ underline: 'Single' });
  });

  it('maps underline:false to the None UnderlineType', async () => {
    const mock = getOfficeMock();
    mock.setBody('u');
    mock.select(0, 1);
    await formatText({ format: { underline: false } });
    expect(mock.fontPatches[0]).toEqual({ underline: 'None' });
  });

  it('throws when format is not an object', async () => {
    await expect(formatText({ format: 'bold' })).rejects.toThrow(/format/);
  });

  it('throws when format contains no supported keys', async () => {
    await expect(formatText({ format: { strikethrough: true } })).rejects.toThrow(/no supported keys/);
  });
});
