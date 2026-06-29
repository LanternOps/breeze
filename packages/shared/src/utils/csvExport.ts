/**
 * Shared CSV/TSV cell helpers + row serializers, with spreadsheet-formula-injection
 * neutralization. Kept free of heavy deps (no jsPDF) so both the API (server-side
 * report download) and the web app can import them. `apps/web/src/lib/csvExport.ts`
 * re-exports these for back-compat.
 */

const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r', '\n']);

/**
 * Neutralize a value a spreadsheet would interpret as a formula by prefixing a
 * single quote when it starts with a dangerous character. Standard CSV-injection
 * mitigation for attacker-influenced content (e.g. agent-supplied event-log text).
 */
export function neutralizeSpreadsheetFormula(value: string): string {
  if (value.length === 0) return value;
  return FORMULA_PREFIXES.has(value[0]!) ? `'${value}` : value;
}

/** Neutralize then RFC-4180-quote a CSV cell. */
export function escapeCsvCell(value: string): string {
  const safe = neutralizeSpreadsheetFormula(value);
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Neutralize then quote a TSV cell only when it contains tab/quote/newline. */
export function escapeTsvCell(value: string): string {
  const safe = neutralizeSpreadsheetFormula(value);
  return /[\t\r\n"]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Serialize a header row + body rows to a CSV string, neutralizing every cell.
 * Cells are coerced to strings first.
 */
export function toCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  return [header, ...rows]
    .map((line) => line.map((value) => escapeCsvCell(String(value ?? ''))).join(','))
    .join('\n');
}

/** Convert a cell value to its display string. */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Derive headers from the first row's keys and a string[][] body. */
function extractTable(rows: unknown[]): { headers: string[]; body: string[][] } {
  const headers = Object.keys(rows[0] as Record<string, unknown>);
  const body = rows.map((row) => {
    const record = row as Record<string, unknown>;
    return headers.map((h) => cellToString(record[h]));
  });
  return { headers, body };
}

/** Serialize report rows to CSV (header from first row's keys). Empty input → ''. */
export function rowsToCsv(rows: unknown[]): string {
  if (rows.length === 0) return '';
  const { headers, body } = extractTable(rows);
  return [headers.join(','), ...body.map((row) => row.map(escapeCsvCell).join(','))].join('\n');
}

/** Serialize report rows to TSV (Excel-compatible). Empty input → ''. */
export function rowsToTsv(rows: unknown[]): string {
  if (rows.length === 0) return '';
  const { headers, body } = extractTable(rows);
  return [headers.join('\t'), ...body.map((row) => row.map(escapeTsvCell).join('\t'))].join('\n');
}
