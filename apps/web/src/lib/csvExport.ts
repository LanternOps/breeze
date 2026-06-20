/**
 * Shared CSV/TSV cell helpers with spreadsheet-formula-injection neutralization.
 *
 * Kept free of heavy deps (no jsPDF) so any component that exports a CSV can
 * import these without pulling a PDF bundle into its chunk. `reportExport.ts`
 * re-exports these for back-compat.
 */

const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r', '\n']);

/**
 * Neutralize a value that a spreadsheet would otherwise interpret as a formula
 * by prefixing a single quote when it starts with a dangerous character. This
 * is the standard CSV-injection mitigation for fields that may carry
 * attacker-influenced content (e.g. agent-supplied event-log text).
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
