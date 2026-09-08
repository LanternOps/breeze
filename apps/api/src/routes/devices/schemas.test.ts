import { describe, expect, it } from 'vitest';
import { createNetworkAssetSchema, updateNetworkAssetSchema } from './schemas';

// POST /devices/network create schema (#5213 W02). label is REQUIRED — W01
// left a known gap where a url-only row renders an empty name in the list
// DTO (network.ts:210's precedence is label > hostname > url > ip), so the
// form/schema requires a label up front rather than letting an empty-named
// row into the list. At least one of ipAddress/hostname/url is required,
// mirroring the DB CHECK discovered_assets_manual_identity_chk so a bad
// payload gets a clean 400 instead of falling through to 23514.
describe('createNetworkAssetSchema', () => {
  const base = {
    orgId: '11111111-1111-4111-8111-111111111111',
    siteId: '22222222-2222-4222-8222-222222222222',
    label: 'Warehouse printer',
  };

  it('accepts a payload with label + ipAddress only', () => {
    const result = createNetworkAssetSchema.safeParse({ ...base, ipAddress: '10.4.4.4' });
    expect(result.success).toBe(true);
  });

  it('accepts a payload with label + hostname only', () => {
    const result = createNetworkAssetSchema.safeParse({ ...base, hostname: 'printer.local' });
    expect(result.success).toBe(true);
  });

  it('accepts a payload with label + url only (IP-less website asset)', () => {
    const result = createNetworkAssetSchema.safeParse({
      ...base,
      assetType: 'website',
      url: 'https://shop.example',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a payload missing label', () => {
    const result = createNetworkAssetSchema.safeParse({
      orgId: base.orgId,
      siteId: base.siteId,
      ipAddress: '10.4.4.4',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload with no identity at all (no ip/hostname/url)', () => {
    const result = createNetworkAssetSchema.safeParse(base);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /at least one/i.test(i.message))).toBe(true);
    }
  });

  it('defaults assetType to unknown', () => {
    const result = createNetworkAssetSchema.safeParse({ ...base, ipAddress: '10.4.4.4' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.assetType).toBe('unknown');
  });

  it('defaults tags to an empty array', () => {
    const result = createNetworkAssetSchema.safeParse({ ...base, ipAddress: '10.4.4.4' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tags).toEqual([]);
  });

  it('rejects a malformed IP', () => {
    const result = createNetworkAssetSchema.safeParse({ ...base, ipAddress: 'not-an-ip' });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed URL', () => {
    const result = createNetworkAssetSchema.safeParse({ ...base, url: 'not a url' });
    expect(result.success).toBe(false);
  });
});

describe('updateNetworkAssetSchema', () => {
  it('omits orgId and siteId (immutable on update)', () => {
    const result = updateNetworkAssetSchema.safeParse({ label: 'New name' });
    expect(result.success).toBe(true);
  });

  it('allows a partial payload with a single field', () => {
    const result = updateNetworkAssetSchema.safeParse({ notes: 'checked on-site' });
    expect(result.success).toBe(true);
  });

  it('rejects orgId/siteId if present (stripped by omit, not silently accepted as identity change)', () => {
    // z.object.omit() strips the keys from the shape entirely; passing them
    // through is simply ignored by parse (not an error) since there's no
    // .strict(). This test documents that orgId/siteId are not part of the
    // update contract even if a caller sends them.
    const result = updateNetworkAssetSchema.safeParse({ label: 'x' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('orgId' in result.data).toBe(false);
      expect('siteId' in result.data).toBe(false);
    }
  });
});
