/**
 * A1-notation helpers. Rows/columns are 0-based internally; printed addresses
 * are 1-based like Excel. Only rectangular A1 references are supported (no
 * R1C1, no whole-column "A:A" shorthand) — that is all the tool protocol uses.
 */

export type ParsedAddress = {
  sheet: string | null;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function parseColumn(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
}

const CELL_RE = /^\$?([A-Za-z]{1,3})\$?(\d+)$/;

export function parseAddress(address: string): ParsedAddress {
  let sheet: string | null = null;
  let ref = address;
  const bang = address.lastIndexOf('!');
  if (bang !== -1) {
    sheet = address.slice(0, bang).replace(/^'(.*)'$/, '$1');
    ref = address.slice(bang + 1);
  }
  const [first, second, extra] = ref.split(':');
  if (extra !== undefined) throw new Error(`Unsupported address: ${address}`);
  const m1 = first !== undefined ? CELL_RE.exec(first) : null;
  if (!m1) throw new Error(`Unsupported address: ${address}`);
  const startCol = parseColumn(m1[1]!);
  const startRow = parseInt(m1[2]!, 10) - 1;
  if (second === undefined) return { sheet, startRow, startCol, endRow: startRow, endCol: startCol };
  const m2 = CELL_RE.exec(second);
  if (!m2) throw new Error(`Unsupported address: ${address}`);
  const endCol = parseColumn(m2[1]!);
  const endRow = parseInt(m2[2]!, 10) - 1;
  return {
    sheet,
    startRow: Math.min(startRow, endRow),
    startCol: Math.min(startCol, endCol),
    endRow: Math.max(startRow, endRow),
    endCol: Math.max(startCol, endCol),
  };
}

/** 0-based start row/col + extent → "B2" or "B2:F40". */
export function rangeAddress(startRow: number, startCol: number, rows: number, cols: number): string {
  const start = `${columnLetter(startCol)}${startRow + 1}`;
  if (rows === 1 && cols === 1) return start;
  return `${start}:${columnLetter(startCol + cols - 1)}${startRow + rows}`;
}

export function stripSheet(address: string): string {
  const bang = address.lastIndexOf('!');
  return bang === -1 ? address : address.slice(bang + 1);
}
