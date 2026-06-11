const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r', '\n']);

export function neutralizeSpreadsheetFormula(value: string): string {
  if (value.length === 0) return value;
  return FORMULA_PREFIXES.has(value[0]!) ? `'${value}` : value;
}

export function escapeCsvCell(value: unknown): string {
  const stringValue = value instanceof Date
    ? value.toISOString()
    : String(value ?? '');
  const safeValue = neutralizeSpreadsheetFormula(stringValue);
  return `"${safeValue.replace(/"/g, '""')}"`;
}

export function csvRow(values: readonly unknown[]): string {
  return values.map(escapeCsvCell).join(',');
}
