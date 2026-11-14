// A one-page PDF carrying extra compressed streams of the kinds pdf-lib
// decompresses while it loads a document (object streams and cross-reference
// streams), each inflating to a chosen number of bytes. Their contents are
// blank, so they add no objects: the only effect of loading them is the
// decompression itself.

import zlib from 'node:zlib';

export interface ExpandingStream {
  /** Bytes the stream inflates to. */
  inflatesTo: number;
  /** The stream's /Type as written in the file (a name may use #xx escapes). */
  type?: string;
}

export function pdfWithExpandingStreams(streams: ExpandingStream[]): Buffer {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (b: Buffer) => { parts.push(b); length += b.length; };
  const object = (body: Buffer[]) => {
    offsets.push(length);
    push(Buffer.from(`${offsets.length} 0 obj\n`, 'latin1'));
    for (const b of body) push(b);
    push(Buffer.from('\nendobj\n', 'latin1'));
  };

  push(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'));
  object([Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1')]);
  object([Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1')]);
  object([Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>', 'latin1')]);
  for (const { inflatesTo, type = 'ObjStm' } of streams) {
    const data = zlib.deflateSync(Buffer.alloc(inflatesTo, 0x20));
    const name = type.replace(/#([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    const fields = name === 'XRef'
      ? '/W [1 1 1] /Size 0 /Index []'
      : '/N 0 /First 0';
    object([
      Buffer.from(`<< /Type /${type} ${fields} /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      data,
      Buffer.from('\nendstream', 'latin1'),
    ]);
  }
  const xref = length;
  const size = offsets.length + 1;
  const rows = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  push(Buffer.from(`xref\n0 ${size}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
