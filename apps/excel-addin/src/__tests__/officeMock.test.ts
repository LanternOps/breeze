import { describe, expect, it } from 'vitest';
import { getOfficeMock } from './officeMock';

describe('officeMock — Excel.run lifecycle', () => {
  it('queues writes until sync and reads values back after load+sync', async () => {
    await Excel.run(async (context) => {
      const range = context.workbook.worksheets.getActiveWorksheet().getRange('B2:C3');
      range.values = [
        ['Region', 'Q1'],
        ['EMEA', 1200],
      ];
      range.load(['values', 'address']);
      await context.sync();
      expect(range.address).toBe('Sheet1!B2:C3');
      expect(range.values).toEqual([
        ['Region', 'Q1'],
        ['EMEA', 1200],
      ]);
    });
    expect(getOfficeMock().getValues('Sheet1', 'B2:C3')).toEqual([
      ['Region', 'Q1'],
      ['EMEA', 1200],
    ]);
  });

  it('throws when reading a property before context.sync()', async () => {
    await Excel.run(async (context) => {
      const range = context.workbook.worksheets.getActiveWorksheet().getRange('A1');
      range.load('values');
      expect(() => range.values).toThrow(/PropertyNotLoaded/);
      await context.sync();
      expect(range.values).toEqual([['']]);
    });
  });

  it('computes the used range with sheet-qualified addresses', async () => {
    getOfficeMock().setValues('Sheet1', 'B2', [
      ['a', 'b'],
      ['c', 'd'],
    ]);
    await Excel.run(async (context) => {
      const used = context.workbook.worksheets.getActiveWorksheet().getUsedRangeOrNullObject();
      used.load(['address', 'values']);
      await context.sync();
      expect(used.isNullObject).toBe(false);
      expect(used.address).toBe('Sheet1!B2:C3');
    });
  });

  it('returns a null object for the used range of an empty sheet', async () => {
    getOfficeMock().addSheet('Empty');
    await Excel.run(async (context) => {
      const used = context.workbook.worksheets.getItemOrNullObject('Empty').getUsedRangeOrNullObject();
      used.load('address');
      await context.sync();
      expect(used.isNullObject).toBe(true);
    });
  });

  it('getRow(0) of a used range exposes the header row', async () => {
    getOfficeMock().setValues('Sheet1', 'A1', [
      ['Name', 'Total'],
      ['x', 1],
    ]);
    await Excel.run(async (context) => {
      const used = context.workbook.worksheets.getActiveWorksheet().getUsedRangeOrNullObject();
      const header = used.getRow(0);
      header.load('values');
      await context.sync();
      expect(header.values).toEqual([['Name', 'Total']]);
    });
  });

  it('worksheet collection: items, add, getItemOrNullObject', async () => {
    getOfficeMock().addSheet('Data');
    await Excel.run(async (context) => {
      const worksheets = context.workbook.worksheets;
      worksheets.load('items/name');
      await context.sync();
      expect(worksheets.items.map((s) => s.name)).toEqual(['Sheet1', 'Data']);
      const missing = worksheets.getItemOrNullObject('Nope');
      await context.sync();
      expect(missing.isNullObject).toBe(true);
      const added = worksheets.add('Report');
      await context.sync();
      expect(added.name).toBe('Report');
      expect(getOfficeMock().hasSheet('Report')).toBe(true);
    });
  });

  it('selection: getSelectedRange reflects state and select() fires handlers', async () => {
    const mock = getOfficeMock();
    const seen: string[] = [];
    Office.context.document.addHandlerAsync(
      Office.EventType.DocumentSelectionChanged,
      () => seen.push('changed'),
      () => undefined,
    );
    mock.select('Sheet1!B2:F40');
    expect(seen).toEqual(['changed']);
    await Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      range.load(['address', 'rowCount', 'columnCount']);
      await context.sync();
      expect(range.address).toBe('Sheet1!B2:F40');
      expect(range.rowCount).toBe(39);
      expect(range.columnCount).toBe(5);
    });
  });

  it('records load and sync calls for assertions', async () => {
    const mock = getOfficeMock();
    await Excel.run(async (context) => {
      const range = context.workbook.worksheets.getActiveWorksheet().getRange('A1:B2');
      range.load('values');
      await context.sync();
    });
    expect(mock.loadCalls.length).toBeGreaterThan(0);
    expect(mock.syncCount).toBeGreaterThan(0);
  });
});
