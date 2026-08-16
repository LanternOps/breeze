// Content-stream text-run operator extraction for the classic-PDF regression
// harness (Task 6). Shared by quotePdf.classicRegression.test.ts (compare)
// and scripts/regen-classic-pdf-baseline.ts (generate) — same rationale as
// pdfRaster.ts alongside it: one implementation, not two that can drift.
//
// pdfkit flate-compresses its content streams, so the drawn operators aren't
// greppable in the raw bytes. Inflate every stream, then pull out each
// BT...ET text object verbatim (font selection + positioning + show-text
// operators, still hex/octal-encoded — NOT decoded to visible text). Because
// renderQuotePdf is a pure function of its inputs (no timestamps or other
// nondeterminism reach the content stream — only the file Info dict does),
// two renders of the same fixture produce byte-identical operator sequences,
// so a plain array-equality snapshot is a valid regression oracle.

import zlib from 'node:zlib';

function inflatePdfStreams(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const headerRe = /\/Length\s+(\d+)[\s\S]{0,120}?\/Filter\s+\/FlateDecode[\s\S]{0,40}?stream\r?\n/g;
  const streams: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(raw))) {
    const length = Number(match[1]);
    const compressed = Buffer.from(raw.slice(headerRe.lastIndex, headerRe.lastIndex + length), 'latin1');
    try { streams.push(zlib.inflateSync(compressed).toString('latin1')); } catch { /* Skip non-text/corrupt streams. */ }
  }
  return streams;
}

/** Returns one entry per BT...ET text object across all pages, in document
 *  order, with the raw (still-encoded) operator text trimmed. */
export function extractTextRunOperators(pdf: Buffer): string[] {
  const ops: string[] = [];
  for (const body of inflatePdfStreams(pdf)) {
    const textObjectRe = /BT\s+([\s\S]*?)\s+ET/g;
    let m: RegExpExecArray | null;
    while ((m = textObjectRe.exec(body))) ops.push(m[1]!.trim());
  }
  return ops;
}
