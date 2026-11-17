import { PDFDocument, PDFName, PDFParser, PDFRawStream, ParseSpeeds, decodePDFRawStream, type PDFObject } from 'pdf-lib';

/**
 * How far a PDF may expand while pdf-lib reads it. Loading a document
 * decompresses its object streams and cross-reference streams in full (pages,
 * images and fonts stay compressed until something draws them, which nothing
 * here does), and then parses the objects inside. A compressed stream can
 * inflate about a thousand times, so a small file could otherwise make one
 * load hold gigabytes.
 */

/** Most bytes the object and cross-reference streams of one document may
 *  inflate to, all together: about three times the 10 MB upload limit, far
 *  above what ordinary PDFs of that size carry in these streams. */
export const MAX_PDF_LOAD_DECODED_BYTES = 32 * 1024 * 1024;

/** A PDF whose object or cross-reference streams inflate past the limit. */
export class PdfLoadLimitError extends Error {
  constructor(public readonly maxDecodedBytes: number) {
    super(`The PDF's compressed object data inflates past the ${maxDecodedBytes}-byte limit`);
    this.name = 'PdfLoadLimitError';
  }
}

export interface LoadPdfDocumentOptions {
  /** As PDFDocument.load: false leaves the Producer and dates as they are. */
  updateMetadata?: boolean;
  maxDecodedBytes?: number;
}

const TYPE = PDFName.of('Type');
const OBJECT_STREAM = PDFName.of('ObjStm');
const XREF_STREAM = PDFName.of('XRef');
/** Decoded bytes read per step while counting: the most the count can run past
 *  the limit before it stops. */
const COUNT_STEP_BYTES = 64 * 1024;

/**
 * pdf-lib's own parser, counting what it decompresses. pdf-lib exposes no
 * size limit or decode hook, so this overrides `parseObject`, which returns
 * every indirect object just before pdf-lib's parser checks its /Type and
 * hands an object stream or cross-reference stream to the parser that
 * decompresses it. The check here is the same `dict.lookup(Type)` in the same
 * state, so it sees exactly the streams pdf-lib will decompress, however
 * their names are written.
 *
 * Each such stream is first decoded here with pdf-lib's own decoders (the
 * same filters and quirks), counting and stopping one step past the limit.
 * Within the limit, the stream goes on to pdf-lib unchanged and is decoded a
 * second time there, bounded by the same count. Past it, the parser gets an
 * empty stream in its place (an error pdf-lib's parser absorbs: it would also
 * absorb one thrown here), the rest of the file is parsed without
 * decompressing anything further, and the load is refused once it ends.
 */
class CountingPdfParser extends PDFParser {
  private decodedBytes = 0;
  exceeded = false;

  constructor(bytes: Uint8Array, private readonly maxDecodedBytes: number) {
    // PDFDocument.load's defaults: ParseSpeeds.Slow, invalid objects tolerated, numbers uncapped.
    super(bytes, ParseSpeeds.Slow, false, false);
  }

  override parseObject(): PDFObject {
    const object = super.parseObject();
    if (!(object instanceof PDFRawStream)) return object;
    const type = object.dict.lookup(TYPE);
    if (type !== OBJECT_STREAM && type !== XREF_STREAM) return object;
    if (!this.exceeded && this.withinLimitAfter(object)) return object;
    this.exceeded = true;
    return PDFRawStream.of(object.dict, new Uint8Array(0));
  }

  /** Adds the stream's decoded size to the count; false once it passes the limit. */
  private withinLimitAfter(stream: PDFRawStream): boolean {
    let decoded;
    try {
      decoded = decodePDFRawStream(stream);
    } catch {
      return true; // pdf-lib's own decode fails the same way and absorbs it
    }
    try {
      for (;;) {
        const step = decoded.getBytes(COUNT_STEP_BYTES).length;
        if (step === 0) return true;
        this.decodedBytes += step;
        if (this.decodedBytes > this.maxDecodedBytes) return false;
      }
    } catch {
      return true; // damaged data: counted up to the damage, where pdf-lib stops too
    }
  }
}

/**
 * PDFDocument.load, refusing (PdfLoadLimitError) a document whose object and
 * cross-reference streams inflate past `maxDecodedBytes` in total. Everything
 * else is PDFDocument.load's own behaviour, with its defaults: the same parser
 * and the same PDFDocument construction (encrypted documents are refused, and
 * `updateMetadata` applies as there).
 */
export async function loadPdfDocument(pdf: Uint8Array | ArrayBuffer, options: LoadPdfDocumentOptions = {}): Promise<PDFDocument> {
  const { updateMetadata = true, maxDecodedBytes = MAX_PDF_LOAD_DECODED_BYTES } = options;
  const bytes = pdf instanceof Uint8Array ? pdf : new Uint8Array(pdf);
  const parser = new CountingPdfParser(bytes, maxDecodedBytes);
  const context = await parser.parseDocument();
  if (parser.exceeded) throw new PdfLoadLimitError(maxDecodedBytes);
  // PDFDocument.load ends with `new PDFDocument(context, ignoreEncryption,
  // updateMetadata)`; the constructor is private in pdf-lib's types only.
  return Reflect.construct(PDFDocument, [context, false, updateMetadata]) as PDFDocument;
}
