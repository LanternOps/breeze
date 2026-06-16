import { describe, expect, it } from 'vitest';
import { getOfficeMock, MockShapeState } from '../__tests__/officeMock';
import { formatSelection } from './formatSelection';

describe('format_selection', () => {
  it('maps bold/italic/fontColor/fontSize onto each selected shape font', async () => {
    const mock = getOfficeMock();
    const shape = new MockShapeState('styled');
    mock.selectShapes([shape]);
    const result = (await formatSelection({
      format: { bold: true, italic: false, fontColor: '#FF0000', fontSize: 14 },
    })) as { applied: string[] };
    expect(result.applied).toEqual(['bold', 'italic', 'fontColor', 'fontSize']);
    expect(shape.fontPatches).toHaveLength(1);
    expect(shape.fontPatches[0]).toEqual({
      bold: true,
      italic: false,
      color: '#FF0000',
      size: 14,
    });
  });

  it('maps underline:true to the Single underline style (NOT a boolean)', async () => {
    const mock = getOfficeMock();
    const shape = new MockShapeState('u');
    mock.selectShapes([shape]);
    await formatSelection({ format: { underline: true } });
    expect(shape.fontPatches[0]).toEqual({ underline: 'Single' });
  });

  it('maps underline:false to the None underline style', async () => {
    const mock = getOfficeMock();
    const shape = new MockShapeState('u');
    mock.selectShapes([shape]);
    await formatSelection({ format: { underline: false } });
    expect(shape.fontPatches[0]).toEqual({ underline: 'None' });
  });

  it('guards a selected shape with no text frame (skips it)', async () => {
    const mock = getOfficeMock();
    const textShape = new MockShapeState('has text');
    const pictureShape = new MockShapeState('', false);
    mock.selectShapes([textShape, pictureShape]);
    const result = (await formatSelection({ format: { bold: true } })) as { applied: string[] };
    expect(result.applied).toEqual(['bold']);
    expect(textShape.fontPatches).toHaveLength(1);
    expect(pictureShape.fontPatches).toHaveLength(0);
  });

  it('returns {error} (does NOT throw) when PowerPointApi 1.4 is unsupported', async () => {
    const mock = getOfficeMock();
    mock.selectShapes([new MockShapeState('x')]);
    mock.supportedApiSets.delete('1.4');
    const result = (await formatSelection({ format: { bold: true } })) as { error?: string };
    expect(typeof result.error).toBe('string');
    expect(result.error).toMatch(/1\.4/);
  });

  it('throws when format is not an object', async () => {
    await expect(formatSelection({ format: 'bold' })).rejects.toThrow(/format/);
  });

  it('throws when format contains no supported keys', async () => {
    getOfficeMock().selectShapes([new MockShapeState('x')]);
    await expect(formatSelection({ format: { strikethrough: true } })).rejects.toThrow(
      /no supported keys/,
    );
  });
});
