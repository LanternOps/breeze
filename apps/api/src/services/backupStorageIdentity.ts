/**
 * Backup storage identity: provider + endpoint + bucket (S3-compatible) or
 * provider + resolved root path (local). The unit backup storage GC sweeps by,
 * denormalised onto backup_snapshots / backup_jobs / retirements at write
 * time. Lives here (not in jobs/backupRetention.ts) so services that must
 * compute the same string — org-erasure fence capture — do not import the GC
 * job module.
 */
import { resolve as resolveLocalPath } from 'node:path';
import { getStringValue } from './recoveryBootstrap';

// AWS's own default S3 endpoints. An endpoint that's EXPLICITLY the default
// AWS endpoint must canonicalize to the same identity as a blank/omitted
// endpoint (both mean "use AWS's default").
const DEFAULT_AWS_S3_ENDPOINT_PATTERN = /^s3(\.dualstack)?([.-][a-z0-9-]+)?\.amazonaws\.com$/;

/**
 * Normalizes an S3-compatible endpoint for identity comparison: strips
 * scheme/path/trailing-slash (only host+port matter), lowercases the host,
 * and canonicalizes a blank endpoint and an explicit default-AWS endpoint to
 * the SAME value. A genuinely unparseable endpoint falls back to a
 * trimmed+lowercased raw string rather than being treated as blank — fail
 * toward "different identity" (safe), never toward "same identity".
 */
function normalizeS3Endpoint(endpoint: string | null | undefined): string {
  const raw = endpoint?.trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    if (DEFAULT_AWS_S3_ENDPOINT_PATTERN.test(host)) return '';
    return url.port ? `${host}:${url.port}` : host;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Identity = provider + endpoint + bucket (S3) or provider + resolved root
 * path (local) — deliberately EXCLUDING providerConfig.prefix (the agent
 * ignores prefix when writing, so two configs differing only by prefix are
 * the same physical namespace).
 */
export function normalizeStorageIdentity(provider: string, providerConfig: Record<string, unknown>): string {
  if (provider === 'local') {
    const rawPath = getStringValue(providerConfig, 'path') || getStringValue(providerConfig, 'basePath') || '';
    const normalizedPath = rawPath ? resolveLocalPath(rawPath) : '';
    return `local::${normalizedPath}`;
  }
  const endpoint = normalizeS3Endpoint(getStringValue(providerConfig, 'endpoint'));
  // Bucket names are case-sensitive per the S3 spec — trim whitespace only,
  // never lowercase.
  const bucket = (getStringValue(providerConfig, 'bucket') || getStringValue(providerConfig, 'bucketName') || '').trim();
  return `${provider}::${endpoint}::${bucket}`;
}
