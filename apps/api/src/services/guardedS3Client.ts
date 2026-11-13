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

/** Test seam: re-arms the once-per-process warning. */
export function __resetAbortDateWarningForTests(): void {
  abortDateWarned = false;
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

// A deserialize-step middleware, typed structurally: @smithy/types is not a
// direct dependency, and the stack's own parameter type is a union of every
// step's middleware shape.
type DeserializeHandler = (args: unknown) => Promise<{ response: unknown }>;

const tolerateAbortDateMiddleware = ((next: DeserializeHandler) => async (args: unknown) => {
  const result = await next(args);
  const headers = (result.response as { headers?: unknown } | undefined)?.headers;
  if (headers && typeof headers === 'object') {
    dropUnparseableAbortDate(headers as Record<string, string | undefined>);
  }
  return result;
}) as unknown as Parameters<S3Client['middlewareStack']['addRelativeTo']>[0];
