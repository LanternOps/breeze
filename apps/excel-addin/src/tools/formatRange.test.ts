import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { formatRange } from './formatRange';

describe('format_range — existing fields still work', () => {
  it('applies bold/italic/colors/numberFormat and reports applied keys', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'B2', [[1]]);

    const result = (await formatRange({
      address: 'B2',
      format: { bold: true, italic: true, fontColor: '#111111', fillColor: '#FFF2CC', numberFormat: '$#,##0.00' },
    })) as { address: string; applied: string[] };

    expect(result.address).toBe('Sheet1!B2');
    expect(result.applied).toEqual(expect.arrayContaining(['bold', 'italic', 'fontColor', 'fillColor', 'numberFormat']));
    expect(mock.sheet('Sheet1').formatAt('B2')).toMatchObject({
      bold: true,
      italic: true,
      fontColor: '#111111',
      fillColor: '#FFF2CC',
      numberFormat: '$#,##0.00',
    });
  });

  it('throws when no supported keys are present', async () => {
    await expect(formatRange({ address: 'A1', format: {} })).rejects.toThrow(/no supported keys/);
  });
});

describe('format_range — borders', () => {
  it('applies a bottom border with style and color', async () => {
    const mock = getOfficeMock();
    const result = (await formatRange({
      address: 'A1:B1',
      format: { borders: { edges: ['bottom'], style: 'continuous', color: '#000000' } },
    })) as { applied: string[] };

    expect(result.applied).toContain('borders');
    const fmt = mock.sheet('Sheet1').formatAt('A1') as { borders?: Record<string, { style?: string; color?: string }> };
    expect(fmt.borders!.EdgeBottom).toMatchObject({ style: 'Continuous', color: '#000000' });
  });

  it('expands "all" into every edge', async () => {
    const mock = getOfficeMock();
    await formatRange({ address: 'A1', format: { borders: { edges: ['all'] } } });
    const fmt = mock.sheet('Sheet1').formatAt('A1') as { borders?: Record<string, unknown> };
    expect(Object.keys(fmt.borders!).sort()).toEqual(
      ['EdgeBottom', 'EdgeLeft', 'EdgeRight', 'EdgeTop', 'InsideHorizontal', 'InsideVertical'].sort(),
    );
  });
});

describe('format_range — alignment', () => {
  it('applies horizontal/vertical alignment and wrapText', async () => {
    const mock = getOfficeMock();
    const result = (await formatRange({
      address: 'A1',
      format: { alignment: { horizontal: 'center', vertical: 'middle', wrapText: true } },
    })) as { applied: string[] };

    expect(result.applied).toContain('alignment');
    expect(mock.sheet('Sheet1').formatAt('A1')).toMatchObject({
      horizontalAlignment: 'Center',
      verticalAlignment: 'Center',
      wrapText: true,
    });
  });
});

describe('format_range — conditional formatting', () => {
  it('adds a color-scale rule', async () => {
    const mock = getOfficeMock();
    const result = (await formatRange({
      address: 'A1:A10',
      format: { conditionalFormat: { type: 'colorScale' } },
    })) as { applied: string[] };

    expect(result.applied).toContain('conditionalFormat');
    const cf = mock.sheet('Sheet1').conditionalFormats;
    expect(cf).toHaveLength(1);
    expect(cf[0]!.type).toBe('ColorScale');
  });

  it('adds a cellValue rule with operator and format', async () => {
    const mock = getOfficeMock();
    await formatRange({
      address: 'A1:A10',
      format: {
        conditionalFormat: {
          type: 'cellValue',
          operator: 'greaterThan',
          formula1: '100',
          format: { fillColor: '#FFCCCC', bold: true },
        },
      },
    });
    const cf = mock.sheet('Sheet1').conditionalFormats;
    expect(cf).toHaveLength(1);
    expect(cf[0]!.type).toBe('CellValue');
    expect(cf[0]!.detail).toMatchObject({
      rule: { operator: 'GreaterThan', formula1: '100' },
      format: { fillColor: '#FFCCCC', bold: true },
    });
  });

  it('rejects an unknown conditionalFormat type', async () => {
    await expect(
      formatRange({ address: 'A1', format: { conditionalFormat: { type: 'bogus' } } }),
    ).rejects.toThrow(/conditionalFormat\.type/);
  });
});
