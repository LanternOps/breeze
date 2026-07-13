import { describe, expect, it } from 'vitest';
import { deriveS3RegionFromEndpoint } from './s3Region';

describe('deriveS3RegionFromEndpoint', () => {
  it('derives Backblaze B2 regions', () => {
    expect(deriveS3RegionFromEndpoint('s3.us-west-004.backblazeb2.com')).toBe('us-west-004');
    expect(deriveS3RegionFromEndpoint('https://s3.eu-central-003.backblazeb2.com')).toBe('eu-central-003');
  });

  it('derives AWS regions from regional endpoints', () => {
    expect(deriveS3RegionFromEndpoint('s3.us-west-2.amazonaws.com')).toBe('us-west-2');
    expect(deriveS3RegionFromEndpoint('s3-eu-west-1.amazonaws.com')).toBe('eu-west-1');
    expect(deriveS3RegionFromEndpoint('s3.dualstack.us-east-1.amazonaws.com')).toBe('us-east-1');
  });

  it('derives Wasabi and DigitalOcean Spaces regions', () => {
    expect(deriveS3RegionFromEndpoint('s3.eu-central-1.wasabisys.com')).toBe('eu-central-1');
    expect(deriveS3RegionFromEndpoint('nyc3.digitaloceanspaces.com')).toBe('nyc3');
  });

  it('tolerates schemes, ports, paths, and casing', () => {
    expect(deriveS3RegionFromEndpoint('https://s3.us-west-004.backblazeb2.com/')).toBe('us-west-004');
    expect(deriveS3RegionFromEndpoint('https://S3.US-WEST-004.BACKBLAZEB2.COM:443/bucket')).toBe('us-west-004');
    expect(deriveS3RegionFromEndpoint('  s3.us-west-004.backblazeb2.com  ')).toBe('us-west-004');
  });

  it('returns null when no region is encoded', () => {
    expect(deriveS3RegionFromEndpoint('s3.amazonaws.com')).toBeNull();
    expect(deriveS3RegionFromEndpoint('minio.internal.example.com')).toBeNull();
    expect(deriveS3RegionFromEndpoint('')).toBeNull();
    expect(deriveS3RegionFromEndpoint(null)).toBeNull();
    expect(deriveS3RegionFromEndpoint(undefined)).toBeNull();
    expect(deriveS3RegionFromEndpoint('http://')).toBeNull();
  });
});
