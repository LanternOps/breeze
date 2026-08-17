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
import { createGuardedHttpAgents } from './urlSafety';

/**
 * Build an `S3Client` that can only ever connect to non-private addresses.
 *
 * Every option the caller passes is preserved except the HTTP agents: a caller
 * may tune `requestHandler` timeouts but must never be able to swap the guarded
 * agents out, so ours are applied last.
 */
export function createGuardedS3Client(config: S3ClientConfig): S3Client {
  const { httpAgent, httpsAgent } = createGuardedHttpAgents();
  const callerHandler =
    config.requestHandler && typeof config.requestHandler === 'object'
      ? (config.requestHandler as Record<string, unknown>)
      : {};

  return new S3Client({
    ...config,
    requestHandler: {
      ...callerHandler,
      httpAgent,
      httpsAgent,
    },
  });
}
