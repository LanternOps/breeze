import { describe, expect, it } from 'vitest';
import {
  SELF_REGISTER_DOMAIN_RATE_LIMIT,
  SELF_REGISTER_EMAIL_RATE_LIMIT,
  SELF_REGISTER_IP_RATE_LIMIT,
  SELF_REGISTER_VERIFY_RATE_LIMIT,
  selfRegisterSchema,
  selfRegisterVerifySchema,
} from './schemas';

// Portal registration W6 (plan Task 1, D4).

describe('selfRegisterSchema', () => {
  it('accepts an email and a name, trimming the name', () => {
    expect(selfRegisterSchema.parse({ email: 'pat@contoso.example.com', name: '  Pat Doe ' }))
      .toEqual({ email: 'pat@contoso.example.com', name: 'Pat Doe' });
  });

  it('selfRegisterSchema refuses orgId, control characters in name, and names over 120 chars', () => {
    expect(selfRegisterSchema.safeParse({ email: 'pat@contoso.example.com', name: 'Pat', orgId: '7c0a1f7e-1111-4222-8333-444455556666' }).success).toBe(false);
    expect(selfRegisterSchema.safeParse({ email: 'pat@contoso.example.com', name: 'Pat\nInjected: header' }).success).toBe(false);
    expect(selfRegisterSchema.safeParse({ email: 'pat@contoso.example.com', name: 'Pat\u0000' }).success).toBe(false);
    expect(selfRegisterSchema.safeParse({ email: 'pat@contoso.example.com', name: 'Pat\u202eDoe' }).success).toBe(false);
    expect(selfRegisterSchema.safeParse({ email: 'pat@contoso.example.com', name: 'Pat\u2028Doe' }).success).toBe(false);
    expect(selfRegisterSchema.safeParse({ email: 'pat@contoso.example.com', name: 'x'.repeat(121) }).success).toBe(false);
    expect(selfRegisterSchema.safeParse({ email: 'pat@contoso.example.com', name: 'x'.repeat(120) }).success).toBe(true);
    expect(selfRegisterSchema.safeParse({ email: 'pat@contoso.example.com', name: '   ' }).success).toBe(false);
  });

  it('refuses a malformed or over-long email', () => {
    expect(selfRegisterSchema.safeParse({ email: 'not-an-email', name: 'Pat' }).success).toBe(false);
    expect(selfRegisterSchema.safeParse({ email: `${'a'.repeat(250)}@x.example.com`, name: 'Pat' }).success).toBe(false);
    expect(selfRegisterSchema.safeParse({ name: 'Pat' }).success).toBe(false);
  });
});

describe('selfRegisterVerifySchema', () => {
  it('accepts a token of 1–512 chars and nothing else', () => {
    expect(selfRegisterVerifySchema.safeParse({ token: 'abc' }).success).toBe(true);
    expect(selfRegisterVerifySchema.safeParse({ token: '' }).success).toBe(false);
    expect(selfRegisterVerifySchema.safeParse({ token: 'x'.repeat(513) }).success).toBe(false);
    expect(selfRegisterVerifySchema.safeParse({ token: 'abc', orgId: 'x' }).success).toBe(false);
  });
});

describe('self-registration rate limits (D4, OD3)', () => {
  it('match the plan numbers', () => {
    expect(SELF_REGISTER_IP_RATE_LIMIT).toEqual({ windowMs: 15 * 60_000, maxAttempts: 5, blockMs: 30 * 60_000 });
    expect(SELF_REGISTER_EMAIL_RATE_LIMIT).toEqual({ windowMs: 24 * 3_600_000, maxAttempts: 3, blockMs: 24 * 3_600_000 });
    expect(SELF_REGISTER_DOMAIN_RATE_LIMIT).toEqual({ windowMs: 24 * 3_600_000, maxAttempts: 50, blockMs: 24 * 3_600_000 });
    expect(SELF_REGISTER_VERIFY_RATE_LIMIT).toEqual({ windowMs: 15 * 60_000, maxAttempts: 10, blockMs: 30 * 60_000 });
  });
});
