/**
 * Hand-rolled Office.js mock (jsdom). Installed fresh per test by
 * src/__tests__/setup.ts; tests seed and inspect workbook state via
 * getOfficeMock().
 *
 * Faithfulness contract (the parts of the real proxy-object model the tools
 * rely on, deliberately enforced so missing load()/sync() bugs fail tests):
 *  - property reads on a Range THROW until a context.sync() has hydrated them
 *  - property writes (range.values = ...) are queued and applied at sync()
 *  - *OrNullObject lookups expose isNullObject; null objects propagate
 *  - Excel.run() performs one trailing sync after the callback returns
 * Documented leniencies (do NOT rely on these in src/ production code):
 *  - Worksheet.name is always readable without load()
 *  - worksheets.getItem() throws immediately instead of at sync
 */
import { vi } from 'vitest';
import { parseAddress, rangeAddress, stripSheet } from '../lib/address';

export type CellValue = string | number | boolean | null;
type Rect = { startRow: number; startCol: number; rows: number; cols: number };

const key = (row: number, col: number): string => `${row},${col}`;

function rectOf(address: string): Rect {
  const p = parseAddress(stripSheet(address));
  return {
    startRow: p.startRow,
    startCol: p.startCol,
    rows: p.endRow - p.startRow + 1,
    cols: p.endCol - p.startCol + 1,
  };
}

export class MockSheetState {
  cells = new Map<string, CellValue>();
  formulas = new Map<string, string>();
  formats = new Map<string, Record<string, unknown>>();

  constructor(public name: string) {}

  setValues(anchor: string, values: CellValue[][]): void {
    const { startRow, startCol } = parseAddress(stripSheet(anchor));
    values.forEach((row, r) =>
      row.forEach((value, c) => this.cells.set(key(startRow + r, startCol + c), value)),
    );
  }

  getValues(rect: Rect): CellValue[][] {
    return Array.from({ length: rect.rows }, (_, r) =>
      Array.from(
        { length: rect.cols },
        (_, c) => this.cells.get(key(rect.startRow + r, rect.startCol + c)) ?? '',
      ),
    );
  }

  getFormulas(rect: Rect): string[][] {
    return Array.from({ length: rect.rows }, (_, r) =>
      Array.from({ length: rect.cols }, (_, c) => {
        const k = key(rect.startRow + r, rect.startCol + c);
        return this.formulas.get(k) ?? String(this.cells.get(k) ?? '');
      }),
    );
  }

  mergeFormat(rect: Rect, patch: Record<string, unknown>): void {
    for (let r = 0; r < rect.rows; r++) {
      for (let c = 0; c < rect.cols; c++) {
        const k = key(rect.startRow + r, rect.startCol + c);
        this.formats.set(k, { ...this.formats.get(k), ...patch });
      }
    }
  }

  /** Effective format of a single cell, e.g. formatAt('B2'). */
  formatAt(cellAddress: string): Record<string, unknown> | undefined {
    const p = parseAddress(stripSheet(cellAddress));
    return this.formats.get(key(p.startRow, p.startCol));
  }

  usedRect(): Rect | null {
    let minR = Infinity;
    let minC = Infinity;
    let maxR = -1;
    let maxC = -1;
    for (const k of [...this.cells.keys(), ...this.formulas.keys()]) {
      const [r, c] = k.split(',').map(Number) as [number, number];
      if (r < minR) minR = r;
      if (c < minC) minC = c;
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
    }
    if (maxR === -1) return null;
    return { startRow: minR, startCol: minC, rows: maxR - minR + 1, cols: maxC - minC + 1 };
  }
}

export class MockWorkbookState {
  sheets: MockSheetState[] = [new MockSheetState('Sheet1')];
  activeSheetName = 'Sheet1';
  /** Workbook file name, e.g. 'Q3 Budget.xlsx' (readable after load('name')). */
  workbookName = 'Book1';
  /** Sheet-qualified selection, e.g. 'Sheet1!B2:F40'. */
  selectionAddress = 'Sheet1!A1';
  tables: Array<{ name: string; address: string; hasHeaders: boolean }> = [];
  loadCalls: Array<{ target: string; props: unknown }> = [];
  syncCount = 0;
  selectionHandlers: Array<() => void> = [];

  sheet(name: string): MockSheetState {
    const found = this.sheets.find((s) => s.name === name);
    if (!found) throw new Error(`ItemNotFound: ${name}`);
    return found;
  }

  hasSheet(name: string): boolean {
    return this.sheets.some((s) => s.name === name);
  }

  addSheet(name: string): MockSheetState {
    if (this.hasSheet(name)) throw new Error(`InvalidArgument: sheet "${name}" already exists`);
    const sheet = new MockSheetState(name);
    this.sheets.push(sheet);
    return sheet;
  }

  setValues(sheetName: string, anchor: string, values: CellValue[][]): void {
    this.sheet(sheetName).setValues(anchor, values);
  }

  getValues(sheetName: string, address: string): CellValue[][] {
    return this.sheet(sheetName).getValues(rectOf(address));
  }

  select(address: string): void {
    this.selectionAddress = address.includes('!')
      ? address
      : `${this.activeSheetName}!${address}`;
    this.fireSelectionChanged();
  }

  fireSelectionChanged(): void {
    for (const handler of [...this.selectionHandlers]) handler();
  }
}

type Syncable = { _sync(): void };

class MockContext {
  private tracked: Syncable[] = [];
  readonly workbook: MockWorkbook;

  constructor(readonly state: MockWorkbookState) {
    this.workbook = new MockWorkbook(this);
  }

  track<T extends Syncable>(obj: T): T {
    this.tracked.push(obj);
    return obj;
  }

  sync = async (): Promise<void> => {
    this.state.syncCount += 1;
    for (const obj of [...this.tracked]) obj._sync();
  };
}

class MockRange implements Syncable {
  isNullObject: boolean;
  readonly format: { fill: { color: string }; font: { bold: boolean; italic: boolean; color: string } };
  private hydrated = false;
  private pendingValues: CellValue[][] | null = null;
  private pendingFormulas: string[][] | null = null;
  private pendingNumberFormat: string[][] | null = null;
  private pendingFormat: Record<string, unknown> = {};
  private _values: CellValue[][] = [];
  private _formulas: string[][] = [];
  private _address = '';

  constructor(
    private ctx: MockContext,
    private sheetState: MockSheetState | null,
    private rect: Rect | null,
  ) {
    this.isNullObject = sheetState === null || rect === null;
    const setterObj = <T extends object>(map: Record<string, string>): T => {
      const obj = {} as T;
      for (const [prop, formatKey] of Object.entries(map)) {
        Object.defineProperty(obj, prop, {
          set: (v: unknown) => {
            this.pendingFormat[formatKey] = v;
          },
        });
      }
      return obj;
    };
    this.format = {
      fill: setterObj<{ color: string }>({ color: 'fillColor' }),
      font: setterObj<{ bold: boolean; italic: boolean; color: string }>({
        bold: 'bold',
        italic: 'italic',
        color: 'fontColor',
      }),
    };
    ctx.track(this);
  }

  load(props: unknown): this {
    const target = this.isNullObject
      ? 'range:null'
      : `range:${this.sheetState!.name}!${rangeAddress(this.rect!.startRow, this.rect!.startCol, this.rect!.rows, this.rect!.cols)}`;
    this.ctx.state.loadCalls.push({ target, props });
    return this;
  }

  getRow(index: number): MockRange {
    if (this.isNullObject) return new MockRange(this.ctx, null, null);
    const r = this.rect!;
    if (index < 0 || index >= r.rows) throw new Error('InvalidArgument: row index out of range');
    return new MockRange(this.ctx, this.sheetState, {
      startRow: r.startRow + index,
      startCol: r.startCol,
      rows: 1,
      cols: r.cols,
    });
  }

  private read<T>(prop: string, value: T): T {
    if (!this.hydrated)
      throw new Error(`PropertyNotLoaded: Range.${prop} read before context.sync()`);
    return value;
  }

  get values(): CellValue[][] {
    return this.read('values', this._values);
  }
  set values(v: CellValue[][]) {
    this.pendingValues = v;
  }

  get formulas(): string[][] {
    return this.read('formulas', this._formulas);
  }
  set formulas(v: string[][]) {
    this.pendingFormulas = v;
  }

  set numberFormat(v: string[][]) {
    this.pendingNumberFormat = v;
  }

  get address(): string {
    return this.read('address', this._address);
  }
  get rowCount(): number {
    return this.read('rowCount', this.rect?.rows ?? 0);
  }
  get columnCount(): number {
    return this.read('columnCount', this.rect?.cols ?? 0);
  }

  _sync(): void {
    if (this.isNullObject) {
      this.hydrated = true;
      return;
    }
    const sheet = this.sheetState!;
    const rect = this.rect!;
    if (this.pendingValues) {
      if (
        this.pendingValues.length !== rect.rows ||
        (this.pendingValues[0]?.length ?? 0) !== rect.cols
      ) {
        throw new Error(
          `InvalidArgument: values is ${this.pendingValues.length}x${this.pendingValues[0]?.length ?? 0} but the range is ${rect.rows}x${rect.cols}`,
        );
      }
      this.pendingValues.forEach((row, r) =>
        row.forEach((v, c) => {
          const k = key(rect.startRow + r, rect.startCol + c);
          sheet.cells.set(k, v);
          sheet.formulas.delete(k);
        }),
      );
      this.pendingValues = null;
    }
    if (this.pendingFormulas) {
      this.pendingFormulas.forEach((row, r) =>
        row.forEach((f, c) => {
          const k = key(rect.startRow + r, rect.startCol + c);
          sheet.formulas.set(k, f);
          sheet.cells.set(k, f); // mock: the "calculated value" mirrors the formula text
        }),
      );
      this.pendingFormulas = null;
    }
    if (this.pendingNumberFormat) {
      sheet.mergeFormat(rect, { numberFormat: this.pendingNumberFormat[0]?.[0] ?? '' });
      this.pendingNumberFormat = null;
    }
    if (Object.keys(this.pendingFormat).length > 0) {
      sheet.mergeFormat(rect, this.pendingFormat);
      this.pendingFormat = {};
    }
    this._values = sheet.getValues(rect);
    this._formulas = sheet.getFormulas(rect);
    this._address = `${sheet.name}!${rangeAddress(rect.startRow, rect.startCol, rect.rows, rect.cols)}`;
    this.hydrated = true;
  }
}

class MockWorksheet implements Syncable {
  isNullObject: boolean;

  constructor(
    private ctx: MockContext,
    private sheetState: MockSheetState | null,
  ) {
    this.isNullObject = sheetState === null;
    ctx.track(this);
  }

  /** Leniency: readable without load(). */
  get name(): string {
    return this.sheetState?.name ?? '';
  }

  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: `worksheet:${this.name || 'null'}`, props });
    return this;
  }

  getRange(address: string): MockRange {
    if (!this.sheetState) throw new Error('ItemNotFound: getRange on a null worksheet');
    return new MockRange(this.ctx, this.sheetState, rectOf(address));
  }

  getUsedRange(): MockRange {
    return this.getUsedRangeOrNullObject();
  }

  getUsedRangeOrNullObject(): MockRange {
    if (!this.sheetState) return new MockRange(this.ctx, null, null);
    const rect = this.sheetState.usedRect();
    return rect
      ? new MockRange(this.ctx, this.sheetState, rect)
      : new MockRange(this.ctx, null, null);
  }

  _sync(): void {
    /* name is always readable; nothing to hydrate */
  }
}

class MockWorksheetCollection implements Syncable {
  private _items: MockWorksheet[] | null = null;

  constructor(private ctx: MockContext) {
    ctx.track(this);
  }

  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: 'worksheets', props });
    return this;
  }

  get items(): MockWorksheet[] {
    if (!this._items)
      throw new Error('PropertyNotLoaded: WorksheetCollection.items read before context.sync()');
    return this._items;
  }

  getActiveWorksheet(): MockWorksheet {
    return new MockWorksheet(this.ctx, this.ctx.state.sheet(this.ctx.state.activeSheetName));
  }

  /** Leniency: throws immediately instead of at sync. */
  getItem(name: string): MockWorksheet {
    return new MockWorksheet(this.ctx, this.ctx.state.sheet(name));
  }

  getItemOrNullObject(name: string): MockWorksheet {
    const found = this.ctx.state.sheets.find((s) => s.name === name) ?? null;
    return new MockWorksheet(this.ctx, found);
  }

  add(name: string): MockWorksheet {
    return new MockWorksheet(this.ctx, this.ctx.state.addSheet(name));
  }

  _sync(): void {
    this._items = this.ctx.state.sheets.map((s) => new MockWorksheet(this.ctx, s));
  }
}

class MockTable {
  constructor(public name: string) {}
  load(_props: unknown): this {
    return this;
  }
  set style(_v: string) {
    /* accepted, not modelled */
  }
}

class MockTableCollection {
  constructor(private ctx: MockContext) {}

  add(address: string, hasHeaders: boolean): MockTable {
    const state = this.ctx.state;
    const sheetName = parseAddress(address).sheet ?? state.activeSheetName;
    state.sheet(sheetName); // validates the sheet exists
    const name = `Table${state.tables.length + 1}`;
    state.tables.push({ name, address, hasHeaders });
    return new MockTable(name);
  }
}

class MockWorkbook implements Syncable {
  readonly worksheets: MockWorksheetCollection;
  readonly tables: MockTableCollection;
  private nameHydrated = false;

  constructor(private ctx: MockContext) {
    this.worksheets = new MockWorksheetCollection(ctx);
    this.tables = new MockTableCollection(ctx);
    ctx.track(this);
  }

  load(props: unknown): this {
    this.ctx.state.loadCalls.push({ target: 'workbook', props });
    return this;
  }

  _sync(): void {
    this.nameHydrated = true;
  }

  get name(): string {
    if (!this.nameHydrated)
      throw new Error('PropertyNotLoaded: Workbook.name read before context.sync()');
    return this.ctx.state.workbookName;
  }

  getSelectedRange(): MockRange {
    const address = this.ctx.state.selectionAddress;
    const sheetName = parseAddress(address).sheet ?? this.ctx.state.activeSheetName;
    return new MockRange(this.ctx, this.ctx.state.sheet(sheetName), rectOf(address));
  }
}

let current: MockWorkbookState | null = null;

export function installOfficeMock(): MockWorkbookState {
  const state = new MockWorkbookState();
  current = state;
  const g = globalThis as Record<string, unknown>;
  g.Excel = {
    run: async <T>(callback: (context: unknown) => Promise<T>): Promise<T> => {
      const context = new MockContext(state);
      const result = await callback(context);
      await context.sync(); // Excel.run always performs a trailing sync
      return result;
    },
  };
  g.Office = {
    onReady: (cb?: (info: { host: string; platform: string }) => void) => {
      const info = { host: 'Excel', platform: 'Mock' };
      cb?.(info);
      return Promise.resolve(info);
    },
    EventType: { DocumentSelectionChanged: 'documentSelectionChanged' },
    context: {
      document: {
        addHandlerAsync: (
          _type: string,
          handler: () => void,
          done?: (result: { status: string }) => void,
        ) => {
          state.selectionHandlers.push(handler);
          done?.({ status: 'succeeded' });
        },
      },
    },
  };
  g.OfficeRuntime = { auth: { getAccessToken: vi.fn(async () => 'mock-entra-access-token') } };
  return state;
}

export function getOfficeMock(): MockWorkbookState {
  if (!current)
    throw new Error('installOfficeMock() has not run — is src/__tests__/setup.ts configured?');
  return current;
}
