import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { readCellDetails } from './readCellDetails';
import { ToolInputError } from './helpers';

describe('read_cell_details', () => {
  it('returns value, formula, number format and no errors for a clean cell', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'B2', [[42]]);
    mock.sheet('Sheet1').formulas.set('1,1', '=6*7');
    mock.sheet('Sheet1').mergeFormat({ startRow: 1, startCol: 1, rows: 1, cols: 1 }, {
      numberFormat: '$#,##0.00',
    });

    await expect(readCellDetails({ address: 'B2' })).resolves.toEqual({
      address: 'Sheet1!B2',
      cells: [[42]],
      formulas: [['=6*7']],
      numberFormats: [['$#,##0.00']],
      errors: [],
    });
  });

  it('uses the wire-contract key "cells" (not "values") so DLP can scan it', async () => {
    getOfficeMock().setValues('Sheet1', 'A1', [['ok']]);
    const result = (await readCellDetails({ address: 'A1' })) as Record<string, unknown>;
    expect(result).toHaveProperty('cells');
    expect(result).not.toHaveProperty('values');
  });

  it('flags cells whose valueType is Error', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'A1', [
      ['#DIV/0!', 10],
      [5, '#REF!'],
    ]);
    mock.sheet('Sheet1').valueTypes.set('0,0', 'Error');
    mock.sheet('Sheet1').valueTypes.set('1,1', 'Error');

    const result = (await readCellDetails({ address: 'A1:B2' })) as {
      errors: Array<{ address: string; value: unknown }>;
    };
    expect(result.errors).toEqual([
      { address: 'Sheet1!A1', value: '#DIV/0!' },
      { address: 'Sheet1!B2', value: '#REF!' },
    ]);
  });

  it('detects Excel error text even without an Error valueType', async () => {
    getOfficeMock().setValues('Sheet1', 'A1', [['#NAME?']]);
    const result = (await readCellDetails({ address: 'A1' })) as {
      errors: Array<{ address: string; value: unknown }>;
    };
    expect(result.errors).toEqual([{ address: 'Sheet1!A1', value: '#NAME?' }]);
  });

  it('rejects an unknown sheet with a model-readable error', async () => {
    await expect(readCellDetails({ address: 'A1', sheetName: 'Nope' })).rejects.toThrow(
      /No worksheet named "Nope"/,
    );
  });

  it('rejects ranges over the cell cap before touching Office.js', async () => {
    await expect(readCellDetails({ address: 'A1:ZZ10000' })).rejects.toBeInstanceOf(ToolInputError);
  });
});
