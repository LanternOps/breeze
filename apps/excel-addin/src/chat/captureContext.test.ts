import { describe, expect, it } from 'vitest';
import { captureWorkbookContext, captureWorkbookName } from './captureContext';
import { getOfficeMock } from '../__tests__/officeMock';
import type { WorkbookContext } from '@breeze/office-addin-core';

const SELECTION_CONTEXT: WorkbookContext = {
  kind: 'selection',
  address: 'Sheet1!B2:C3',
  sheetName: 'Sheet1',
  cells: [
    ['Region', 'Q1'],
    ['EMEA', 1200],
  ],
};

describe('captureWorkbookContext', () => {
  it("'selection' captures the pinned payload shape from the live selection", async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'B2', [
      ['Region', 'Q1'],
      ['EMEA', 1200],
    ]);
    mock.select('Sheet1!B2:C3');
    await expect(captureWorkbookContext('selection')).resolves.toEqual(SELECTION_CONTEXT);
  });

  it("'sheet' captures the used range of the active sheet; 'none' sends kind only", async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'A1', [['x', 'y']]);
    await expect(captureWorkbookContext('sheet')).resolves.toEqual({
      kind: 'sheet',
      sheetName: 'Sheet1',
      address: 'Sheet1!A1:B1',
      cells: [['x', 'y']],
    });
    await expect(captureWorkbookContext('none')).resolves.toEqual({ kind: 'none' });
  });
});

describe('captureWorkbookName', () => {
  it('reads the open workbook file name', async () => {
    const mock = getOfficeMock();
    mock.workbookName = 'Q3 Budget.xlsx';
    await expect(captureWorkbookName()).resolves.toBe('Q3 Budget.xlsx');
  });
});
