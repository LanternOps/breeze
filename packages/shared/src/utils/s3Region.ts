/**
 * Derive an S3 signing region from an S3-compatible endpoint hostname.
 *
 * Several S3-compatible providers embed the region in the endpoint host
 * (and some, like Backblaze B2, reject requests signed with a mismatched
 * region), so when a user supplies an endpoint but no region we can — and
 * should — derive it instead of falling back to a generic default.
 */
const ENDPOINT_REGION_PATTERNS: RegExp[] = [
  // AWS dualstack: s3.dualstack.us-east-1.amazonaws.com
  /^s3\.dualstack\.([a-z0-9-]+)\.amazonaws\.com$/,
  // AWS: s3.us-west-2.amazonaws.com / legacy s3-us-west-2.amazonaws.com
  /^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/,
  // Backblaze B2: s3.us-west-004.backblazeb2.com
  /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/,
  // Wasabi: s3.eu-central-1.wasabisys.com
  /^s3\.([a-z0-9-]+)\.wasabisys\.com$/,
  // DigitalOcean Spaces: nyc3.digitaloceanspaces.com
  /^([a-z0-9]+)\.digitaloceanspaces\.com$/,
];

/**
 * Returns the region embedded in an S3-compatible endpoint, or null when the
 * endpoint is absent, unparseable, or from a provider whose endpoints do not
 * encode a region (e.g. MinIO on a custom domain).
 */
export function deriveS3RegionFromEndpoint(
  endpoint: string | null | undefined,
): string | null {
  const raw = endpoint?.trim();
  if (!raw) return null;

  let hostname: string;
  try {
    hostname = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }

  const host = hostname.toLowerCase();
  for (const pattern of ENDPOINT_REGION_PATTERNS) {
    const match = host.match(pattern);
    // AWS's regionless legacy endpoint (s3.amazonaws.com) never matches, but
    // guard against captures that are obviously not regions.
    if (match?.[1] && match[1] !== 's3') {
      return match[1];
    }
  }
  return null;
}
