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
import { parseAddress, rangeAddress, stripSheet } from '@breeze/office-addin-core';

export type CellValue = string | number | boolean | null;
type Rect = { startRow: number; startCol: number; rows: number; cols: number };

const key = (row: number, col: number): string => `${row},${col}`;

function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.startRow >= outer.startRow &&
    inner.startCol >= outer.startCol &&
    inner.startRow + inner.rows <= outer.startRow + outer.rows &&
    inner.startCol + inner.cols <= outer.startCol + outer.cols
  );
}

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
  /** Office.js Range.valueTypes, keyed like cells (e.g. 'Error', 'Double'). */
  valueTypes = new Map<string, string>();
  /** Conditional-format rules applied to sub-rects of this sheet. */
  conditionalFormats: Array<{ rect: Rect; type: string; detail: Record<string, unknown> }> = [];

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

  /** Per-cell number-format strings (mirror of Range.numberFormat reads). */
  getNumberFormats(rect: Rect): string[][] {
    return Array.from({ length: rect.rows }, (_, r) =>
      Array.from({ length: rect.cols }, (_, c) => {
        const fmt = this.formats.get(key(rect.startRow + r, rect.startCol + c));
        const nf = fmt?.numberFormat;
        return typeof nf === 'string' ? nf : 'General';
      }),
    );
  }

  /** Per-cell Office.js value types (mirror of Range.valueTypes reads). */
  getValueTypes(rect: Rect): string[][] {
    return Array.from({ length: rect.rows }, (_, r) =>
      Array.from(
        { length: rect.cols },
        (_, c) => this.valueTypes.get(key(rect.startRow + r, rect.startCol + c)) ?? 'Empty',
      ),
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

  /** Header-row values of a source range (first row), used by the pivot mock. */
  pivotHeadersFor(qualifiedSource: string): string[] {
    const rect = rectOf(qualifiedSource);
    return Array.from({ length: rect.cols }, (_, c) => {
      const v = this.cells.get(key(rect.startRow, rect.startCol + c));
      return typeof v === 'string' ? v : v == null ? '' : String(v);
    });
  }

  /** Mirror of Office.js Range.clear(applyTo): contents | formats | all. */
  clear(rect: Rect, applyTo: 'contents' | 'formats' | 'all'): void {
    for (let r = 0; r < rect.rows; r++) {
      for (let c = 0; c < rect.cols; c++) {
        const k = key(rect.startRow + r, rect.startCol + c);
        if (applyTo === 'contents' || applyTo === 'all') {
          this.cells.delete(k);
          this.formulas.delete(k);
        }
        if (applyTo === 'formats' || applyTo === 'all') {
          this.formats.delete(k);
          this.conditionalFormats = this.conditionalFormats.filter((cf) => !rectContains(rect, cf.rect));
        }
      }
    }
  }

  /** Rows of the rect sorted by sort keys (mirror of Range.sort.apply). */
  sortRows(
    rect: Rect,
    fields: Array<{ key: number; ascending: boolean }>,
    hasHeaders: boolean,
  ): void {
    const headerRows = hasHeaders ? 1 : 0;
    const bodyStart = rect.startRow + headerRows;
    const bodyRows = rect.rows - headerRows;
    if (bodyRows <= 1) return;
    type Row = { values: CellValue[]; formulas: (string | undefined)[]; formats: (Record<string, unknown> | undefined)[] };
    const rows: Row[] = [];
    for (let r = 0; r < bodyRows; r++) {
      const values: CellValue[] = [];
      const formulas: (string | undefined)[] = [];
      const formats: (Record<string, unknown> | undefined)[] = [];
      for (let c = 0; c < rect.cols; c++) {
        const k = key(bodyStart + r, rect.startCol + c);
        values.push(this.cells.get(k) ?? '');
        formulas.push(this.formulas.get(k));
        formats.push(this.formats.get(k));
      }
      rows.push({ values, formulas, formats });
    }
    const compare = (a: Row, b: Row): number => {
      for (const f of fields) {
        const av = a.values[f.key];
        const bv = b.values[f.key];
        let cmp = 0;
        if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
        else cmp = String(av ?? '').localeCompare(String(bv ?? ''));
        if (cmp !== 0) return f.ascending ? cmp : -cmp;
      }
      return 0;
    };
    rows.sort(compare);
    rows.forEach((row, r) => {
      for (let c = 0; c < rect.cols; c++) {
        const k = key(bodyStart + r, rect.startCol + c);
        if (row.values[c] === '' || row.values[c] === undefined) this.cells.delete(k);
        else this.cells.set(k, row.values[c]!);
        if (row.formulas[c] === undefined) this.formulas.delete(k);
        else this.formulas.set(k, row.formulas[c]!);
        if (row.formats[c] === undefined) this.formats.delete(k);
        else this.formats.set(k, row.formats[c]!);
      }
    });
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

export type MockChart = {
  name: string;
  type: string;
  seriesBy: string;
  sourceAddress: string;
  sheetName: string;
  title: string | null;
};
export type MockPivotDataHierarchy = { field: string; summarizeBy: string };
export type MockPivotTable = {
  name: string;
  source: string;
  destination: string;
  sheetName: string;
  rowHierarchies: string[];
  columnHierarchies: string[];
  dataHierarchies: MockPivotDataHierarchy[];
};

export class MockWorkbookState {
  sheets: MockSheetState[] = [new MockSheetState('Sheet1')];
  activeSheetName = 'Sheet1';
  /** Workbook file name, e.g. 'Q3 Budget.xlsx' (readable after load('name')). */
  workbookName = 'Book1';
  /** Sheet-qualified selection, e.g. 'Sheet1!B2:F40'. */
  selectionAddress = 'Sheet1!A1';
  tables: Array<{ name: string; address: string; hasHeaders: boolean }> = [];
  charts: MockChart[] = [];
  pivotTables: MockPivotTable[] = [];
  /** ExcelApi requirement-set versions reported as supported (feature detect). */
  supportedApiSets = new Set(['1.1', '1.4', '1.7', '1.8', '1.9']);
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

/**
 * Minimal stand-in for the Office.js ConditionalFormat proxy. The tool only
 * reaches into `.colorScale.criteria` / `.cellValue.rule` / `.cellValue.format.*`,
 * so we expose just-enough chainable setters and record the final shape.
 */
class MockConditionalFormat {
  detail: Record<string, unknown> = {};
  readonly colorScale: { criteria: unknown };
  readonly cellValue: { rule: unknown; format: { font: { color: string; bold: boolean }; fill: { color: string } } };

  constructor(public type: string) {
    const self = this;
    this.colorScale = {
      set criteria(v: unknown) {
        self.detail.criteria = v;
      },
    };
    const ruleHolder: { rule?: unknown } = {};
    this.cellValue = {
      set rule(v: unknown) {
        ruleHolder.rule = v;
        self.detail.rule = v;
      },
      get rule() {
        return ruleHolder.rule;
      },
      format: {
        font: {
          set color(v: string) {
            ((self.detail.format ??= {}) as Record<string, unknown>).fontColor = v;
          },
          set bold(v: boolean) {
            ((self.detail.format ??= {}) as Record<string, unknown>).bold = v;
          },
        } as { color: string; bold: boolean },
        fill: {
          set color(v: string) {
            ((self.detail.format ??= {}) as Record<string, unknown>).fillColor = v;
          },
        } as { color: string },
      },
    };
  }
}

interface MockBorder {
  style: string;
  color: string;
}
interface MockRangeFormat {
  fill: { color: string };
  font: { bold: boolean; italic: boolean; color: string; size: number };
  horizontalAlignment: string;
  verticalAlignment: string;
  wrapText: boolean;
  borders: { getItem(edge: string): MockBorder };
}

class MockRange implements Syncable {
  isNullObject: boolean;
  readonly format: MockRangeFormat;
  readonly sort: { apply(fields: unknown, matchCase?: boolean, hasHeaders?: boolean): void };
  readonly conditionalFormats: { add(type: string): MockConditionalFormat };
  private hydrated = false;
  private pendingValues: CellValue[][] | null = null;
  private pendingFormulas: string[][] | null = null;
  private pendingNumberFormat: string[][] | null = null;
  private pendingFormat: Record<string, unknown> = {};
  private pendingBorders: Record<string, Partial<MockBorder>> = {};
  private pendingClear: 'contents' | 'formats' | 'all' | null = null;
  private pendingSort: { fields: Array<{ key: number; ascending: boolean }>; hasHeaders: boolean } | null = null;
  private pendingConditional: MockConditionalFormat[] = [];
  private _values: CellValue[][] = [];
  private _formulas: string[][] = [];
  private _numberFormat: string[][] = [];
  private _valueTypes: string[][] = [];
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
    const formatObj = {
      fill: setterObj<{ color: string }>({ color: 'fillColor' }),
      font: setterObj<{ bold: boolean; italic: boolean; color: string; size: number }>({
        bold: 'bold',
        italic: 'italic',
        color: 'fontColor',
        size: 'fontSize',
      }),
      borders: {
        getItem: (edge: string): MockBorder => {
          const pending = (this.pendingBorders[edge] ??= {});
          return {
            set style(v: string) {
              pending.style = v;
            },
            get style() {
              return pending.style ?? '';
            },
            set color(v: string) {
              pending.color = v;
            },
            get color() {
              return pending.color ?? '';
            },
          };
        },
      },
    } as MockRangeFormat;
    Object.defineProperty(formatObj, 'horizontalAlignment', {
      set: (v: string) => {
        this.pendingFormat.horizontalAlignment = v;
      },
    });
    Object.defineProperty(formatObj, 'verticalAlignment', {
      set: (v: string) => {
        this.pendingFormat.verticalAlignment = v;
      },
    });
    Object.defineProperty(formatObj, 'wrapText', {
      set: (v: boolean) => {
        this.pendingFormat.wrapText = v;
      },
    });
    this.format = formatObj;
    this.sort = {
      apply: (fields: unknown, _matchCase?: boolean, hasHeaders?: boolean) => {
        const arr = (fields as Array<{ key: number; ascending?: boolean }>).map((f) => ({
          key: f.key,
          ascending: f.ascending !== false,
        }));
        this.pendingSort = { fields: arr, hasHeaders: hasHeaders === true };
      },
    };
    this.conditionalFormats = {
      add: (type: string): MockConditionalFormat => {
        const cf = new MockConditionalFormat(type);
        this.pendingConditional.push(cf);
        return cf;
      },
    };
    ctx.track(this);
  }

  clear(applyTo?: string): void {
    const map: Record<string, 'contents' | 'formats' | 'all'> = {
      Contents: 'contents',
      Formats: 'formats',
      All: 'all',
    };
    this.pendingClear = (applyTo !== undefined ? map[applyTo] : undefined) ?? 'contents';
  }

  load(props: unknown): this {
    const target = this.isNullObject
      ? 'range:null'
      : `range:${this.sheetState!.name}!${rangeAddress(this.rect!.startRow, this.rect!.startCol, this.rect!.rows, this.rect!.cols)}`;
    this.ctx.state.loadCalls.push({ target, props });
    return this;
  }

  /** Sheet-qualified A1 address without requiring a prior sync (mock helper for
   *  chart/pivot collections that consume a Range object directly). */
  qualifiedAddress(): string {
    if (this.isNullObject) return '';
    return `${this.sheetState!.name}!${rangeAddress(this.rect!.startRow, this.rect!.startCol, this.rect!.rows, this.rect!.cols)}`;
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

  get numberFormat(): string[][] {
    return this.read('numberFormat', this._numberFormat);
  }
  set numberFormat(v: string[][]) {
    this.pendingNumberFormat = v;
  }

  get valueTypes(): string[][] {
    return this.read('valueTypes', this._valueTypes);
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
    if (Object.keys(this.pendingBorders).length > 0) {
      sheet.mergeFormat(rect, { borders: { ...this.pendingBorders } });
      this.pendingBorders = {};
    }
    if (this.pendingConditional.length > 0) {
      for (const cf of this.pendingConditional) {
        sheet.conditionalFormats.push({ rect, type: cf.type, detail: cf.detail });
      }
      this.pendingConditional = [];
    }
    if (this.pendingSort) {
      sheet.sortRows(rect, this.pendingSort.fields, this.pendingSort.hasHeaders);
      this.pendingSort = null;
    }
    if (this.pendingClear) {
      sheet.clear(rect, this.pendingClear);
      this.pendingClear = null;
    }
    this._values = sheet.getValues(rect);
    this._formulas = sheet.getFormulas(rect);
    this._numberFormat = sheet.getNumberFormats(rect);
    this._valueTypes = sheet.getValueTypes(rect);
    this._address = `${sheet.name}!${rangeAddress(rect.startRow, rect.startCol, rect.rows, rect.cols)}`;
    this.hydrated = true;
  }
}

class MockChartObject {
  constructor(private record: MockChart) {}
  load(_props: unknown): this {
    return this;
  }
  get name(): string {
    return this.record.name;
  }
  get title(): { set text(v: string) } {
    const record = this.record;
    return {
      set text(v: string) {
        record.title = v;
      },
    };
  }
}

class MockChartCollection {
  constructor(
    private ctx: MockContext,
    private sheetName: string,
  ) {}
  add(type: string, sourceData: MockRange, seriesBy?: string): MockChartObject {
    const record: MockChart = {
      name: `Chart ${this.ctx.state.charts.length + 1}`,
      type,
      seriesBy: seriesBy ?? 'Auto',
      sourceAddress: sourceData.qualifiedAddress(),
      sheetName: this.sheetName,
      title: null,
    };
    this.ctx.state.charts.push(record);
    return new MockChartObject(record);
  }
}

class MockPivotHierarchy {
  constructor(
    public name: string,
    public isNullObject: boolean,
  ) {}
  load(_props: unknown): this {
    return this;
  }
}

class MockRowColumnHierarchyCollection {
  constructor(private target: string[]) {}
  add(hierarchy: MockPivotHierarchy): void {
    this.target.push(hierarchy.name);
  }
}

class MockDataPivotHierarchy {
  constructor(private record: MockPivotDataHierarchy) {}
  set summarizeBy(v: string) {
    this.record.summarizeBy = v;
  }
}

class MockDataHierarchyCollection {
  constructor(private target: MockPivotDataHierarchy[]) {}
  add(hierarchy: MockPivotHierarchy): MockDataPivotHierarchy {
    const record: MockPivotDataHierarchy = { field: hierarchy.name, summarizeBy: 'Sum' };
    this.target.push(record);
    return new MockDataPivotHierarchy(record);
  }
}

class MockPivotTableObject {
  constructor(
    private ctx: MockContext,
    private record: MockPivotTable,
  ) {}
  load(_props: unknown): this {
    return this;
  }
  get name(): string {
    return this.record.name;
  }
  get hierarchies(): { getItemOrNullObject(name: string): MockPivotHierarchy } {
    const headers = this.ctx.state.sheet(this.record.sheetName).pivotHeadersFor(this.record.source);
    return {
      getItemOrNullObject: (name: string) =>
        new MockPivotHierarchy(name, !headers.includes(name)),
    };
  }
  get rowHierarchies(): MockRowColumnHierarchyCollection {
    return new MockRowColumnHierarchyCollection(this.record.rowHierarchies);
  }
  get columnHierarchies(): MockRowColumnHierarchyCollection {
    return new MockRowColumnHierarchyCollection(this.record.columnHierarchies);
  }
  get dataHierarchies(): MockDataHierarchyCollection {
    return new MockDataHierarchyCollection(this.record.dataHierarchies);
  }
}

class MockPivotTableCollection {
  constructor(
    private ctx: MockContext,
    private sheetName: string,
  ) {}
  add(name: string, source: MockRange, destination: MockRange): MockPivotTableObject {
    const record: MockPivotTable = {
      name,
      source: source.qualifiedAddress(),
      destination: destination.qualifiedAddress(),
      sheetName: this.sheetName,
      rowHierarchies: [],
      columnHierarchies: [],
      dataHierarchies: [],
    };
    this.ctx.state.pivotTables.push(record);
    return new MockPivotTableObject(this.ctx, record);
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

  get charts(): MockChartCollection {
    if (!this.sheetState) throw new Error('ItemNotFound: charts on a null worksheet');
    return new MockChartCollection(this.ctx, this.sheetState.name);
  }

  get pivotTables(): MockPivotTableCollection {
    if (!this.sheetState) throw new Error('ItemNotFound: pivotTables on a null worksheet');
    return new MockPivotTableCollection(this.ctx, this.sheetState.name);
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
    ClearApplyTo: { contents: 'Contents', formats: 'Formats', all: 'All' },
    ConditionalFormatType: { colorScale: 'ColorScale', cellValue: 'CellValue' },
    ConditionalCellValueOperator: {
      greaterThan: 'GreaterThan',
      lessThan: 'LessThan',
      equalTo: 'EqualTo',
      between: 'Between',
      greaterThanOrEqual: 'GreaterThanOrEqual',
      lessThanOrEqual: 'LessThanOrEqual',
    },
    BorderLineStyle: { continuous: 'Continuous', none: 'None' },
  };
  g.Office = {
    onReady: (cb?: (info: { host: string; platform: string }) => void) => {
      const info = { host: 'Excel', platform: 'Mock' };
      cb?.(info);
      return Promise.resolve(info);
    },
    EventType: { DocumentSelectionChanged: 'documentSelectionChanged' },
    context: {
      requirements: {
        isSetSupported: (name: string, minVersion?: string): boolean => {
          if (name !== 'ExcelApi') return false;
          if (!minVersion) return true;
          return state.supportedApiSets.has(minVersion);
        },
      },
      document: {
        addHandlerAsync: (
          type: string,
          handler: () => void,
          done?: (result: { status: string }) => void,
        ) => {
          // Real Office only invokes a handler for the event it was registered
          // under, so only retain DocumentSelectionChanged handlers — a wrong
          // EventType wiring then registers nothing and its callback never fires.
          if (type === 'documentSelectionChanged') {
            state.selectionHandlers.push(handler);
          }
          done?.({ status: 'succeeded' });
        },
        removeHandlerAsync: (
          _type: string,
          options?: { handler?: () => void } | (() => void),
          done?: (result: { status: string }) => void,
        ) => {
          // The Excel adapter never removes its handler (the no-op unsubscribe),
          // but model the real API so a host that DOES unsubscribe is testable.
          const handler =
            typeof options === 'function' ? undefined : options?.handler;
          if (handler) {
            const i = state.selectionHandlers.indexOf(handler);
            if (i >= 0) state.selectionHandlers.splice(i, 1);
          } else {
            state.selectionHandlers = [];
          }
          const cb = typeof options === 'function' ? options : done;
          cb?.({ status: 'succeeded' });
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
