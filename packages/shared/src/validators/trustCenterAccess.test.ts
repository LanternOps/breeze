import { describe, expect, it } from 'vitest';
import {
  TRUST_ACCESS_GRANT_TTL_DAYS, TRUST_ACCESS_VERIFY_TTL_HOURS, trustAccessDecisionSchema, trustAccessDownloadSchema,
  trustAccessRequestCreateSchema, trustAccessTokenBodySchema,
} from './trustCenterAccess';

const valid = {
  partnerSlug: 'acme-msp', orgSlug: 'contoso', email: '  Jane.Doe@Example.COM ', name: 'Jane Doe',
  company: 'Example Insurance', purpose: 'Underwriting review for our cyber policy renewal.', ndaAccepted: true,
};
const TOKEN = 'a'.repeat(48);

describe('trustAccessRequestCreateSchema', () => {
  it('trims and lowercases the email', () => {
    const r = trustAccessRequestCreateSchema.parse(valid);
    expect(r.email).toBe('jane.doe@example.com');
  });
  it('accepts a partner-home request (orgSlug null)', () => {
    expect(trustAccessRequestCreateSchema.safeParse({ ...valid, orgSlug: null }).success).toBe(true);
  });
  it('rejects unknown keys, a short purpose, a bad slug and a non-email', () => {
    expect(trustAccessRequestCreateSchema.safeParse({ ...valid, ndaText: 'mine' }).success).toBe(false);
    expect(trustAccessRequestCreateSchema.safeParse({ ...valid, purpose: 'short' }).success).toBe(false);
    expect(trustAccessRequestCreateSchema.safeParse({ ...valid, partnerSlug: 'Bad Slug' }).success).toBe(false);
    expect(trustAccessRequestCreateSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false);
  });
});

describe('token bodies', () => {
  it('accepts a 48-char token and rejects short, long and extra keys', () => {
    expect(trustAccessTokenBodySchema.safeParse({ token: TOKEN }).success).toBe(true);
    expect(trustAccessTokenBodySchema.safeParse({ token: 'a'.repeat(39) }).success).toBe(false);
    expect(trustAccessTokenBodySchema.safeParse({ token: 'a'.repeat(65) }).success).toBe(false);
    expect(trustAccessTokenBodySchema.safeParse({ token: TOKEN, extra: 1 }).success).toBe(false);
  });
  it('download needs a guid documentId', () => {
    expect(trustAccessDownloadSchema.safeParse({ token: TOKEN, documentId: '0b9a4f4e-3b8e-4f2a-9c51-7d1f2c0e9a11' }).success).toBe(true);
    expect(trustAccessDownloadSchema.safeParse({ token: TOKEN, documentId: 'nope' }).success).toBe(false);
  });
  it('decision note is optional, nullable and ≤500', () => {
    expect(trustAccessDecisionSchema.safeParse({}).success).toBe(true);
    expect(trustAccessDecisionSchema.safeParse({ note: null }).success).toBe(true);
    expect(trustAccessDecisionSchema.safeParse({ note: 'x'.repeat(501) }).success).toBe(false);
  });
  it('TTLs: 24 h to verify, 7 days for a grant', () => {
    expect(TRUST_ACCESS_VERIFY_TTL_HOURS).toBe(24);
    expect(TRUST_ACCESS_GRANT_TTL_DAYS).toBe(7);
  });
});
