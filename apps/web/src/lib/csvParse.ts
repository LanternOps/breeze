/**
 * Minimal RFC-4180 CSV parser for the bulk org/site import (#3242).
 *
 * Hand-rolled on purpose: this is the only CSV *import* surface in the app,
 * and a dependency-free ~60-line state machine keeps the parser in web only
 * without touching the lockfile. Supports quoted fields, escaped quotes
 * (`""`), embedded commas and newlines inside quotes, CRLF/LF line endings,
 * and skips fully blank lines. The first record is treated as the header row.
 */

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export function parseCsv(text: string): ParsedCsv {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    // A fully blank line parses as a single empty field — skip it.
    if (record.length === 1 && record[0] === '') {
      record = [];
      return;
    }
    records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n') {
      endRecord();
    } else if (ch === '\r') {
      // CRLF: consume silently; the following \n ends the record. A bare \r
      // (classic Mac) also ends the record.
      if (text[i + 1] !== '\n') endRecord();
    } else {
      field += ch;
    }
  }
  // Final record without a trailing newline.
  if (field !== '' || record.length > 0) endRecord();

  const [headers = [], ...rows] = records;
  return { headers: headers.map((h) => h.trim()), rows };
}
