/**
 * Minimal Office Open XML (.xlsx) writer for report row exports (#9956).
 *
 * The "Excel" report format used to be tab-separated text saved as `.xls`,
 * which Excel opens only after a "file format and extension don't match"
 * warning. This writes a real single-sheet workbook instead. It is used by both
 * the API (`GET /reports/runs/:id/download?format=excel`) and the web client
 * export, so the two paths produce the same file.
 *
 * Scope is deliberately small: one worksheet, inline strings (no shared-string
 * table), no styles part. The zip container comes from `fflate`, which already
 * ships in both runtimes as a dependency of jsPDF.
 *
 * Columns match `rowsToCsv` / `rowsToTsv`: the header row is the first row's
 * keys, verbatim, so scripts that parse the export by column name keep working.
 *
 * Unlike CSV/TSV, cells are NOT formula-neutralized (no leading `'`): every
 * text cell is written as an inline string (`t="inlineStr"`), which Excel never
 * evaluates, and this writer never emits a `<f>` element. Prefixing a quote
 * would only show up as a stray character in the cell.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';
import { csvCellToString } from './csvExport';

export const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Excel worksheet limits; a file past them opens only through "repair". */
export const XLSX_MAX_ROWS = 1_048_576;
export const XLSX_MAX_COLUMNS = 16_384;
export const XLSX_MAX_CELL_CHARS = 32_767;

const SHEET_NAME = 'Report';

/** Zero-based column index → spreadsheet column letters (0 → A, 26 → AA). */
export function xlsxColumnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

// Characters XML 1.0 cannot carry: C0 controls other than tab/LF/CR, lone
// surrogates, and the U+FFFE/U+FFFF non-characters. Leaving any of them in
// makes Excel refuse the file.
const XML_INVALID_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function escapeXml(value: string): string {
  return value
    .replace(XML_INVALID_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncateCellText(value: string): string {
  if (value.length <= XLSX_MAX_CELL_CHARS) return value;
  // A cut between a high and low surrogate leaves a lone high surrogate, which
  // escapeXml then drops; the rest of the text is kept intact.
  return value.slice(0, XLSX_MAX_CELL_CHARS);
}

function cellXml(ref: string, value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  const text = escapeXml(truncateCellText(csvCellToString(value)));
  if (text === '') return '';
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

function rowXml(rowNumber: number, values: readonly unknown[]): string {
  const cells = values.map((value, col) => cellXml(`${xlsxColumnName(col)}${rowNumber}`, value)).join('');
  return cells === '' ? '' : `<row r="${rowNumber}">${cells}</row>`;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const CONTENT_TYPES = XML_DECL
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  + '</Types>';

const ROOT_RELS = XML_DECL
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '</Relationships>';

const WORKBOOK = XML_DECL
  + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
  + `<sheets><sheet name="${SHEET_NAME}" sheetId="1" r:id="rId1"/></sheets>`
  + '</workbook>';

const WORKBOOK_RELS = XML_DECL
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
  + '</Relationships>';

/**
 * Serialize report rows to a single-sheet .xlsx workbook. Header row = the
 * first row's keys (same columns as `rowsToCsv`). Empty input yields a valid
 * workbook with an empty sheet. Throws `RangeError` when the rows or columns
 * exceed what an Excel worksheet can hold.
 */
export function rowsToXlsx(rows: readonly unknown[]): Uint8Array<ArrayBuffer> {
  const headers = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];
  if (rows.length + 1 > XLSX_MAX_ROWS) {
    throw new RangeError(`Report has ${rows.length} rows; an Excel worksheet holds at most ${XLSX_MAX_ROWS - 1} plus a header row`);
  }
  if (headers.length > XLSX_MAX_COLUMNS) {
    throw new RangeError(`Report has ${headers.length} columns; an Excel worksheet holds at most ${XLSX_MAX_COLUMNS}`);
  }

  const sheetRows: string[] = [];
  if (headers.length > 0) {
    sheetRows.push(rowXml(1, headers));
    rows.forEach((row, i) => {
      const record = row as Record<string, unknown>;
      sheetRows.push(rowXml(i + 2, headers.map((h) => record[h])));
    });
  }

  const sheetXml = XML_DECL
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + (headers.length > 0
      ? '<sheetViews><sheetView workbookViewId="0">'
        + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        + '</sheetView></sheetViews>'
      : '')
    + `<sheetData>${sheetRows.join('')}</sheetData>`
    + '</worksheet>';

  const files: Zippable = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'xl/workbook.xml': strToU8(WORKBOOK),
    'xl/_rels/workbook.xml.rels': strToU8(WORKBOOK_RELS),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml),
  };
  // fflate allocates a plain (non-shared) ArrayBuffer; narrowing the type lets
  // callers hand it straight to `new Blob([...])` and Hono's `c.body()`.
  return zipSync(files) as Uint8Array<ArrayBuffer>;
}
