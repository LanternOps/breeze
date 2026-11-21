/**
 * guardedS3Client — the ONLY sanctioned way to build an `S3Client` whose
 * endpoint comes from a TENANT-supplied backup storage configuration.
 *
 * Why this file exists: a backup destination lets a tenant name an arbitrary
 * S3-compatible host, and the API then dials it from inside our own network.
 * That is a textbook SSRF primitive — cloud metadata (169.254.169.254),
 * link-local, loopback and RFC1918 services are all reachable from the API
 * container. The "test connection" route makes it directly and repeatedly
 * triggerable.
 *
 * `services/urlSafety.ts` already solves this for plain HTTP (`safeFetch`:
 * resolve, filter, pin, no redirects). The AWS SDK builds its own HTTP client,
 * so it cannot call `safeFetch`. Instead we hand the SDK agents whose `lookup`
 * is the same connect-time SSRF guard — the socket only ever resolves to an
 * address that passed the policy, which closes DNS rebinding by construction
 * rather than by a validate-then-connect window.
 *
 * The finding this addresses was *incomplete adoption*, not absent defense, so
 * the durable half of the fix is the contract test in
 * `backupSsrfAdoption.test.ts`: it fails if the backup surface ever grows
 * another raw outbound client built from a config-derived endpoint.
 */
import { Readable } from 'node:stream';
import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { selfHostAllowsPrivateNetwork } from '../config/env';
import { createGuardedHttpAgents } from './urlSafety';

/**
 * Build an `S3Client` that can only ever connect to addresses the SSRF policy
 * permits for this deployment.
 *
 * The policy is resolved HERE rather than passed in by the caller. A self-hosted
 * install routinely backs up to MinIO or a NAS on its own LAN
 * (`http://10.0.0.5:9000`), so a blanket RFC1918 block would break saving a
 * backup config, the test-connection probe and recovery downloads alike. The
 * escape hatch already exists — `selfHostAllowsPrivateNetwork()` opens only when
 * `IS_HOSTED` is an AFFIRMATIVE self-host signal (#570 fail-closed lesson), and
 * even then `isAlwaysBlockedIp` still blocks cloud metadata, link-local,
 * loopback and CGNAT. On hosted, nothing changes: private endpoints stay blocked.
 *
 * Deliberately NOT a parameter: three call sites (the test-connection route,
 * recoveryDownloadService, recoveryMediaService) all want the same answer, and a
 * per-caller flag is exactly how the original incomplete-adoption finding
 * happened. Resolving it in the chokepoint means a fourth call site inherits the
 * correct behaviour for free and cannot weaken it.
 *
 * Every option the caller passes is preserved except the HTTP agents: a caller
 * may tune `requestHandler` timeouts but must never be able to swap the guarded
 * agents out, so ours are applied last.
 */
export function createGuardedS3Client(config: S3ClientConfig): S3Client {
  const { httpAgent, httpsAgent } = createGuardedHttpAgents({
    allowPrivateNetwork: selfHostAllowsPrivateNetwork(),
  });
  const callerHandler =
    config.requestHandler && typeof config.requestHandler === 'object'
      ? (config.requestHandler as Record<string, unknown>)
      : {};

  const client = new S3Client({
    ...config,
    requestHandler: {
      ...callerHandler,
      httpAgent,
      httpsAgent,
    },
  });
  tolerateUnparseableAbortDate(client);
  return client;
}

/**
 * `x-amz-abort-date` is informational: the time a bucket lifecycle rule will
 * abort an incomplete multipart upload. The SDK binds it to `AbortDate`
 * (CreateMultipartUpload, ListParts) as an HTTP-date and throws on any value
 * its parser rejects, failing a request the store already carried out. Some
 * S3-compatible stores (Wasabi, #11764) send it as a Go `time.Time.String()`
 * rendering, which made every multipart backup write fail. Nothing in Breeze
 * reads `AbortDate`, so a value that is not an IMF-fixdate is dropped before
 * deserialization. A well-formed value is left alone.
 */
const ABORT_DATE_HEADER = 'x-amz-abort-date';
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)? GMT$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * True for an IMF-fixdate (RFC 7231 §7.1.1.1, the only form a sender may
 * generate) naming a real calendar time. Deliberately stricter than the SDK:
 * the obsolete RFC 850 and asctime forms are treated as unparseable, since
 * dropping a header nothing reads costs nothing and keeping one the SDK
 * rejects fails the request.
 */
function isImfFixdate(value: string): boolean {
  const m = IMF_FIXDATE.exec(value);
  if (!m) return false;
  const [day, year, hour, minute, second] = [m[1], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number];
  const month = MONTHS.indexOf(m[2]!);
  if (hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day;
}

// Once per process: a store that sends a malformed value sends it on every
// multipart create, so a per-response line would be noise, but the first one
// keeps the store's non-conformance visible after the symptom is gone.
let abortDateWarned = false;

/** Test seam: re-arms the once-per-process warnings (header and body). */
export function __resetAbortDateWarningForTests(): void {
  abortDateWarned = false;
  abortDateBodyWarned = false;
}

/** Removes an `x-amz-abort-date` header (any case) whose value is not an IMF-fixdate. Mutates `headers`. */
export function dropUnparseableAbortDate(headers: Record<string, string | undefined>): void {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== ABORT_DATE_HEADER) continue;
    const value = headers[name];
    if (typeof value === 'string' && isImfFixdate(value)) continue;
    delete headers[name];
    if (!abortDateWarned) {
      abortDateWarned = true;
      console.warn('[guardedS3Client] dropped an x-amz-abort-date response header that is not an HTTP-date (logged once per process)', {
        value: String(value).slice(0, 120),
      });
    }
  }
}

/*
 * The same value can arrive as an `<AbortDate>` element in the XML BODY of
 * CreateMultipartUpload / ListParts instead of (or as well as) the header. The
 * SDK reads every body member, AbortDate included, before it applies header
 * bindings, so dropping the header alone does not help: the parser throws on
 * the body member first.
 *
 * For those two commands only, a 2xx body is buffered (bounded by
 * `abortDateBodyCapBytes`), an `<AbortDate>` element whose text is not an
 * IMF-fixdate is removed, and the body is handed back as a fresh stream. Every
 * other command, GetObject above all, never has its body touched.
 */
const ABORT_DATE_BODY_COMMANDS: ReadonlySet<string> = new Set(['CreateMultipartUploadCommand', 'ListPartsCommand']);

// Both commands answer with small documents: an InitiateMultipartUploadResult
// is a few hundred bytes and a ListPartsResult tops out at 1,000 parts of a
// few hundred bytes each. A body over this is passed through untouched.
const DEFAULT_ABORT_DATE_BODY_CAP_BYTES = 4 * 1024 * 1024;
let abortDateBodyCapBytes = DEFAULT_ABORT_DATE_BODY_CAP_BYTES;

/** Test seam: sets the body buffering cap, returning the previous value. */
export function __setAbortDateBodyCapForTests(bytes: number): number {
  const previous = abortDateBodyCapBytes;
  abortDateBodyCapBytes = bytes;
  return previous;
}

// Linear: `[^>]*` and `[^<]*` cannot cross the delimiters that end them, and
// a match can only start at a literal `<AbortDate`. The body comes from a
// tenant-chosen endpoint, so no pattern here may backtrack super-linearly.
const ABORT_DATE_ELEMENT = /<AbortDate(?:\s[^>]*)?>([^<]*)<\/AbortDate>|<AbortDate\s*\/>/g;

let abortDateBodyWarned = false;

/**
 * Removes every `<AbortDate>` element whose text (trimmed) is not an
 * IMF-fixdate, including empty and self-closing ones. Everything else in the
 * document is returned unchanged. Pure; exported for tests.
 */
export function stripUnparseableAbortDateElements(xml: string): { xml: string; dropped: string[] } {
  const dropped: string[] = [];
  const out = xml.replace(ABORT_DATE_ELEMENT, (element: string, text: string | undefined) => {
    if (text !== undefined && isImfFixdate(text.trim())) return element;
    dropped.push(text ?? '');
    return '';
  });
  return { xml: dropped.length > 0 ? out : xml, dropped };
}

function chunkToBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  // A Readable only yields strings when an encoding was set on it, which the
  // SDK's Node handler never does; re-encode as UTF-8 rather than lose bytes.
  return Buffer.from(String(chunk), 'utf8');
}

/** Replays `head`, then whatever is left of `rest`, as one byte stream. */
function replayStream(head: Buffer[], rest: AsyncIterator<unknown>): Readable {
  async function* replay(): AsyncGenerator<Buffer> {
    try {
      yield* head;
      for (;;) {
        const next = await rest.next();
        if (next.done) return;
        yield chunkToBuffer(next.value);
      }
    } finally {
      await rest.return?.();
    }
  }
  return Readable.from(replay(), { objectMode: false });
}

/**
 * Reads `body` fully if it fits in `cap` bytes. Over the cap, returns a stream
 * that replays what was read followed by the unread remainder, so the caller
 * can pass it on byte-identical. Read errors propagate.
 */
async function bufferUpTo(body: Readable, cap: number): Promise<{ bytes: Buffer } | { passthrough: Readable }> {
  // Pulled by hand: `for await` + `break` would destroy the stream, and the
  // over-cap path still needs the rest of it.
  const it = body[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const next = await it.next();
    if (next.done) return { bytes: Buffer.concat(chunks, size) };
    const chunk = chunkToBuffer(next.value);
    chunks.push(chunk);
    size += chunk.length;
    if (size > cap) return { passthrough: replayStream(chunks, it) };
  }
}

function headerValue(headers: Record<string, string | undefined>, name: string): string | undefined {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key];
  }
  return undefined;
}

function setHeader(headers: Record<string, string | undefined>, name: string, value: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) headers[key] = value;
  }
}

interface RawResponse {
  statusCode?: number;
  headers?: Record<string, string | undefined>;
  body?: unknown;
}

/**
 * Rewrites a CreateMultipartUpload / ListParts 2xx body in place so it no
 * longer carries an `<AbortDate>` the SDK cannot parse. Leaves the response
 * untouched when the status is not 2xx, the body is not a Node stream or byte
 * array, it is over the cap, or there is nothing to remove.
 */
async function dropUnparseableAbortDateFromBody(response: RawResponse, commandName: string): Promise<void> {
  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300) return;
  const headers = response.headers ?? {};
  const cap = abortDateBodyCapBytes;
  const declared = Number(headerValue(headers, 'content-length'));
  if (Number.isFinite(declared) && declared > cap) return;

  let bytes: Buffer;
  if (response.body instanceof Uint8Array) {
    bytes = chunkToBuffer(response.body);
    if (bytes.length > cap) return;
  } else if (response.body instanceof Readable) {
    const read = await bufferUpTo(response.body, cap);
    if ('passthrough' in read) {
      response.body = read.passthrough;
      return;
    }
    bytes = read.bytes;
  } else {
    return;
  }

  // latin1 maps every byte to one code unit and back, so the rest of the
  // document (a UTF-8 <Key>, say) survives byte-for-byte; the tag and an
  // IMF-fixdate are ASCII, so matching them this way is exact.
  const { xml, dropped } = stripUnparseableAbortDateElements(bytes.toString('latin1'));
  if (dropped.length === 0) {
    response.body = Readable.from(bytes, { objectMode: false });
    return;
  }
  const rewritten = Buffer.from(xml, 'latin1');
  response.body = Readable.from(rewritten, { objectMode: false });
  setHeader(headers, 'content-length', String(rewritten.length));
  if (!abortDateBodyWarned) {
    abortDateBodyWarned = true;
    console.warn('[guardedS3Client] dropped an <AbortDate> element from a multipart response body that is not an HTTP-date (logged once per process)', {
      command: commandName,
      value: Buffer.from(dropped[0] ?? '', 'latin1').toString('utf8').slice(0, 120),
    });
  }
}

// A deserialize-step middleware, typed structurally: @smithy/types is not a
// direct dependency, and the stack's own parameter type is a union of every
// step's middleware shape.
type DeserializeHandler = (args: unknown) => Promise<{ response: unknown }>;

const tolerateAbortDateMiddleware = ((next: DeserializeHandler, context: { commandName?: string } | undefined) => async (args: unknown) => {
  const result = await next(args);
  const response = result.response as RawResponse | undefined;
  const headers = response?.headers;
  if (headers && typeof headers === 'object') {
    dropUnparseableAbortDate(headers);
  }
  const commandName = context?.commandName;
  if (response && commandName && ABORT_DATE_BODY_COMMANDS.has(commandName)) {
    await dropUnparseableAbortDateFromBody(response, commandName);
  }
  return result;
}) as unknown as Parameters<S3Client['middlewareStack']['addRelativeTo']>[0];

/**
 * Registers the abort-date tolerance on `client`. The single registration
 * point for every S3 client in the API: the guarded customer-store client
 * (above) and the platform env-configured clients (`s3Storage.ts`,
 * `artifacts/blobStorage.ts`) all call this, so they cannot drift. Returns the
 * client for inline use. Idempotent (`override: true` on a fixed name).
 */
export function tolerateUnparseableAbortDate<T extends S3Client>(client: T): T {
  client.middlewareStack.addRelativeTo(tolerateAbortDateMiddleware, {
    // "after" the deserializer runs inside it, so this sees the raw response
    // before the SDK parses it (the S3 client's own throw-200-exceptions
    // middleware is registered the same way).
    relation: 'after',
    toMiddleware: 'deserializerMiddleware',
    name: 'breezeTolerateAbortDateMiddleware',
    override: true,
  });
  return client;
}
