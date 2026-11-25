import { describe, expect, it } from 'vitest';
import {
  DEPLOY_KEY_MAX_SOURCE_CIDRS,
  deployKeyImageLabelSchema,
  isValidSourceCidr,
  mintDeployKeyBodySchema,
  rotateDeployKeyBodySchema,
} from './schemas';
import {
  DEPLOY_KEY_MAX_PARKED,
  DEPLOY_KEY_MAX_TTL_DAYS,
  DEPLOY_KEY_MAX_USAGE,
} from '../unassignedPool/limits';

const mint = { name: 'Front desk', imageLabel: 'win11-2026q4', expiresInDays: 30, maxUsage: 100, maxParked: 10 };

describe('mintDeployKeyBodySchema', () => {
  it('accepts a body at every ceiling', () => {
    const parsed = mintDeployKeyBodySchema.parse({
      ...mint,
      expiresInDays: DEPLOY_KEY_MAX_TTL_DAYS,
      maxUsage: DEPLOY_KEY_MAX_USAGE,
      maxParked: DEPLOY_KEY_MAX_PARKED,
      sourceCidrs: ['10.0.0.0/8'],
    });
    expect(parsed.expiresInDays).toBe(365);
    expect(parsed.maxUsage).toBe(1000);
    expect(parsed.maxParked).toBe(20);
  });

  it.each([
    ['expiresInDays above 365', { expiresInDays: 366 }],
    ['expiresInDays 0', { expiresInDays: 0 }],
    ['fractional expiresInDays', { expiresInDays: 1.5 }],
    ['maxUsage above 1000', { maxUsage: 1001 }],
    ['maxUsage 0', { maxUsage: 0 }],
    ['maxParked above 20', { maxParked: 21 }],
    ['maxParked 0', { maxParked: 0 }],
    ['blank name', { name: '   ' }],
    ['blank image label', { imageLabel: '  ' }],
    ['image label over 100', { imageLabel: 'x'.repeat(101) }],
    ['control characters in the label', { imageLabel: 'win\n11' }],
    ['an empty source list', { sourceCidrs: [] }],
    ['an invalid source', { sourceCidrs: ['10.0.0.0/33'] }],
    ['too many sources', { sourceCidrs: Array.from({ length: DEPLOY_KEY_MAX_SOURCE_CIDRS + 1 }, (_, i) => `10.0.${i}.0/24`) }],
    ['an unknown field', { usageCount: 5 }],
    ['a non-uuid grant', { stepUpGrant: 'grant' }],
  ])('rejects %s', (_label, patch) => {
    expect(mintDeployKeyBodySchema.safeParse({ ...mint, ...patch }).success).toBe(false);
  });

  it.each(['name', 'imageLabel', 'expiresInDays', 'maxUsage', 'maxParked'])('requires %s', (field) => {
    const body: Record<string, unknown> = { ...mint };
    delete body[field];
    expect(mintDeployKeyBodySchema.safeParse(body).success).toBe(false);
  });

  it('trims the name and label; null sources mean any source', () => {
    const parsed = mintDeployKeyBodySchema.parse({ ...mint, name: '  Desk ', imageLabel: ' win11 ', sourceCidrs: null });
    expect(parsed.name).toBe('Desk');
    expect(parsed.imageLabel).toBe('win11');
    expect(parsed.sourceCidrs).toBeNull();
  });
});

describe('rotateDeployKeyBodySchema', () => {
  it('needs only a lifetime; it cannot change the image label', () => {
    expect(rotateDeployKeyBodySchema.parse({ expiresInDays: 90 })).toEqual({ expiresInDays: 90 });
    expect(rotateDeployKeyBodySchema.safeParse({}).success).toBe(false);
    expect(rotateDeployKeyBodySchema.safeParse({ expiresInDays: 90, imageLabel: 'other' }).success).toBe(false);
    expect(rotateDeployKeyBodySchema.safeParse({ expiresInDays: 366 }).success).toBe(false);
    expect(rotateDeployKeyBodySchema.safeParse({ expiresInDays: 90, maxParked: 21 }).success).toBe(false);
    expect(rotateDeployKeyBodySchema.parse({ expiresInDays: 90, sourceCidrs: null }).sourceCidrs).toBeNull();
  });
});

describe('deployKeyImageLabelSchema', () => {
  it('is the trimmed label the step-up grant binds', () => {
    expect(deployKeyImageLabelSchema.parse('  Win11 Q4  ')).toBe('Win11 Q4');
  });
});

describe('isValidSourceCidr', () => {
  it.each([
    '10.0.0.0/8', '192.168.1.5', '192.168.1.5/24', '0.0.0.0/0', '2001:db8::/32', '::1', '::ffff:10.0.0.1', 'fe80::/10',
  ])('accepts %s', (entry) => {
    expect(isValidSourceCidr(entry)).toBe(true);
  });

  it.each([
    '10.0.0.0/33', '2001:db8::/129', '010.0.0.1', '10.0.0', 'fe80::1%eth0', '10.0.0.0/', '10.0.0.0/08', '10.0.0.0/-1', 'example.com', '',
  ])('rejects %s', (entry) => {
    expect(isValidSourceCidr(entry)).toBe(false);
  });
});
