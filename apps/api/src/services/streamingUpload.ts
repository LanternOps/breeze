/**
 * Streaming multipart upload parser.
 *
 * Parses a `multipart/form-data` request body incrementally with busboy,
 * streaming the (single) file part straight to a temp file on disk while it
 * arrives and hashing it as it goes — so peak heap stays *constant* regardless
 * of file size.
 *
 * This is the streaming counterpart to Hono's `c.req.parseBody()`, which fully
 * buffers the parsed `File` (the whole upload) into the Node heap before the
 * route handler runs. For large installer uploads (~500MB) that buffering is a
 * memory-pressure / OOM vector under concurrency (issue #1408).
 *
 * The small text fields (version, architecture, etc.) are still collected into
 * memory — they're tiny and capped by `maxFieldSize`/`maxFields`.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Busboy, type BusboyFileStream } from '@fastify/busboy';

export interface StreamedFile {
  /** The form field name the file arrived under (e.g. `file`). */
  fieldName: string;
  /** The original client-provided filename (may be empty). */
  filename: string;
  /** Absolute path to the temp file the upload was streamed to. */
  tempPath: string;
  /** Lowercase hex sha256 of the file contents. */
  checksum: string;
  /** Number of bytes written to disk. */
  fileSize: number;
}

export interface StreamedMultipart {
  /** Non-file text fields, last value wins on duplicates. */
  fields: Record<string, string>;
  /** The single file part, or `null` if none was sent. */
  file: StreamedFile | null;
}

export class MultipartError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415,
  ) {
    super(message);
    this.name = 'MultipartError';
  }
}

export interface ParseStreamingMultipartOptions {
  /** `content-type` header value (must be `multipart/form-data; boundary=...`). */
  contentType: string | undefined;
  /** Web ReadableStream of the raw request body (`c.req.raw.body`). */
  body: ReadableStream<Uint8Array> | null;
  /** Absolute path to stream the file part to. Caller owns cleanup on success. */
  tempPath: string;
  /** Reject the file as soon as its size exceeds this many bytes. */
  maxFileSize: number;
  /**
   * Optional gate run when the file part first appears (before any bytes are
   * written), e.g. to reject a disallowed extension early. Throw a
   * `MultipartError` to abort. Returning normally accepts the part.
   */
  onFile?: (info: { fieldName: string; filename: string }) => void;
  /** Max size of a single non-file field value, in bytes. Default 1MB. */
  maxFieldSize?: number;
  /** Max number of non-file fields. Default 50. */
  maxFields?: number;
}

/**
 * Parse a streaming multipart body, writing the first file part to `tempPath`.
 *
 * On any error the partially-written temp file is removed before throwing, so
 * the caller never has to clean up after a failed parse. On success the caller
 * owns `tempPath` and must unlink it when done.
 *
 * Error contract: a {@link MultipartError} carries a client-facing HTTP status
 * (400/413/415) the caller should surface directly. Any *other* thrown error
 * (disk write failure, aborted request body, malformed multipart) is an
 * infrastructure failure with no status — the caller must log it and map it to
 * a 500.
 */
export async function parseStreamingMultipart(
  opts: ParseStreamingMultipartOptions,
): Promise<StreamedMultipart> {
  const {
    contentType,
    body,
    tempPath,
    maxFileSize,
    onFile,
    maxFieldSize = 1024 * 1024,
    maxFields = 50,
  } = opts;

  if (!contentType || !contentType.toLowerCase().includes('multipart/form-data')) {
    throw new MultipartError('Expected multipart/form-data request', 400);
  }
  if (!body) {
    throw new MultipartError('Request body is empty', 400);
  }
  if (maxFileSize <= 0 || maxFieldSize <= 0 || maxFields <= 0) {
    throw new Error('parseStreamingMultipart: size/count limits must be positive');
  }

  const fields: Record<string, string> = {};
  let file: StreamedFile | null = null;
  let wroteTempFile = false;

  try {
    await new Promise<void>((resolve, reject) => {
      const bb = Busboy({
        headers: { 'content-type': contentType },
        limits: {
          fieldSize: maxFieldSize,
          fields: maxFields,
          files: 1,
          fileSize: maxFileSize,
        },
      });

      // Drive the web ReadableStream into busboy.
      const nodeStream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);

      // A single rejection wins; later events after the first failure are ignored.
      // `finish` (parsing done) and the file's disk-write pipeline settle
      // independently, so only resolve once *both* have finished — otherwise
      // `finish` could fire before the temp file finished writing.
      let settled = false;
      let parsingDone = false;
      let filePending = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        // Tear down the source + parser so no stream outlives the rejected
        // promise (otherwise the request body keeps draining into a discarded
        // busboy, and a later stream 'error' would have no live listener).
        nodeStream.unpipe(bb);
        nodeStream.destroy();
        bb.destroy();
        reject(err);
      };
      const maybeSucceed = () => {
        if (settled || !parsingDone || filePending) return;
        settled = true;
        resolve();
      };

      bb.on('field', (name, value, _fieldnameTruncated, valueTruncated) => {
        if (settled) return;
        // busboy silently truncates an over-`fieldSize` value rather than
        // erroring. Surface it as 413 instead of persisting a half-value —
        // the route reads pre/post-install scripts from these fields, and a
        // silently-cut script is worse than a rejected upload.
        if (valueTruncated) {
          fail(new MultipartError(`Field "${name}" too large`, 413));
          return;
        }
        fields[name] = value;
      });

      bb.on('file', (fieldName, stream: BusboyFileStream, filename) => {
        if (settled) {
          stream.resume();
          return;
        }
        // Only the first file part is accepted; busboy is capped to files:1, but
        // guard defensively in case that changes.
        if (file || filePending) {
          stream.resume();
          return;
        }

        try {
          onFile?.({ fieldName, filename });
        } catch (err) {
          stream.resume();
          fail(err instanceof Error ? err : new MultipartError('File rejected', 400));
          return;
        }

        const hash = createHash('sha256');
        let fileSize = 0;
        let truncated = false;

        stream.on('data', (chunk: Buffer) => {
          fileSize += chunk.length;
          hash.update(chunk);
        });
        stream.on('limit', () => {
          truncated = true;
        });

        wroteTempFile = true;
        filePending = true;
        const dest = createWriteStream(tempPath);
        pipeline(stream, dest)
          .then(() => {
            filePending = false;
            // Oversize detection must not rely solely on busboy's soft `limit`
            // flag: when the cap is hit busboy stops feeding and `pipeline`
            // resolves *normally* with a partial file on disk. Independently
            // treat reaching the byte cap as oversize, so a truncated installer
            // can never slip through as a "success" with a hash over partial
            // bytes. (busboy's fileSize limit means it stops AT maxFileSize.)
            if (truncated || stream.truncated || fileSize >= maxFileSize) {
              fail(
                new MultipartError(
                  `File too large (max ${Math.floor(maxFileSize / 1024 / 1024)}MB)`,
                  413,
                ),
              );
              return;
            }
            file = {
              fieldName,
              filename: filename ?? '',
              tempPath,
              checksum: hash.digest('hex'),
              fileSize,
            };
            maybeSucceed();
          })
          .catch((err) => {
            filePending = false;
            fail(err instanceof Error ? err : new Error(String(err)));
          });
      });

      bb.on('filesLimit', () => {
        // Extra files beyond the cap are discarded by busboy; not an error.
      });
      bb.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      // @fastify/busboy signals end-of-parse with the Writable 'finish' event
      // (not 'close'). The file's disk-write pipeline settles independently, so
      // `maybeSucceed` only resolves once both have completed.
      bb.on('finish', () => {
        parsingDone = true;
        maybeSucceed();
      });

      nodeStream.on('error', (err) => fail(err));
      nodeStream.pipe(bb);
    });

    return { fields, file };
  } catch (err) {
    if (wroteTempFile) {
      await unlink(tempPath).catch(() => {});
    }
    throw err;
  }
}
