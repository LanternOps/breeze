import { describe, it, expect } from 'vitest';
import {
  COMMS_SEND_EFFECT_ACTION,
  COMMS_SEND_EFFECT_ENVELOPE_VERSION,
  buildCommsSendEffect,
  commsSendEffectSchema,
  normalizeRecipients,
} from './commsEffect';
import { M365_COMMS_MAX_RECIPIENTS } from './commsActions';

const base = {
  actionVersion: 1,
  connectionId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  senderObjectId: '33333333-3333-4333-8333-333333333333',
  consentGeneration: 0,
};

describe('normalizeRecipients', () => {
  it('lowercases, deduplicates, and sorts', () => {
    expect(normalizeRecipients(['B@Example.COM', 'a@example.com', 'b@example.com'])).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
  });

  it('treats undefined as empty', () => {
    expect(normalizeRecipients(undefined)).toEqual([]);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeRecipients([' a@example.com '])).toEqual(['a@example.com']);
  });

  it('is idempotent', () => {
    const once = normalizeRecipients(['B@x.com', 'a@x.com']);
    expect(normalizeRecipients(once)).toEqual(once);
  });
});

describe('buildCommsSendEffect', () => {
  it('stamps the version and action literals', () => {
    const e = buildCommsSendEffect({ ...base, to: ['a@example.com'], subject: 's', bodyText: 'b' });
    expect(e.envelopeVersion).toBe(COMMS_SEND_EFFECT_ENVELOPE_VERSION);
    expect(e.action).toBe(COMMS_SEND_EFFECT_ACTION);
  });

  it('always materializes cc and bcc as arrays', () => {
    // An omitted key and an empty array must not digest differently.
    const e = buildCommsSendEffect({ ...base, to: ['a@example.com'], subject: 's', bodyText: 'b' });
    expect(e.cc).toEqual([]);
    expect(e.bcc).toEqual([]);
  });

  it('carries subject and body verbatim', () => {
    // No trimming, no line-ending rewriting, no Unicode normalization: the approver reads
    // these bytes and the recipient must receive these bytes.
    const subject = '  Résumé  ';
    const bodyText = 'one\r\ntwo\r\n';
    const e = buildCommsSendEffect({ ...base, to: ['a@example.com'], subject, bodyText });
    expect(e.subject).toBe(subject);
    expect(e.bodyText).toBe(bodyText);
  });

  it('is deterministic — same input, identical output', () => {
    const input = { ...base, to: ['B@x.com', 'a@x.com'], subject: 's', bodyText: 'b' };
    expect(buildCommsSendEffect(input)).toEqual(buildCommsSendEffect(input));
  });

  it('produces an envelope that validates', () => {
    const e = buildCommsSendEffect({
      ...base,
      to: ['B@Example.com', 'a@example.com'],
      cc: ['c@example.com'],
      bcc: ['d@example.com'],
      subject: 's',
      bodyText: 'b',
    });
    expect(commsSendEffectSchema.safeParse(e).success).toBe(true);
  });

  it('keeps an address present in both to and bcc', () => {
    // Dropping the bcc copy would change who is blind-copied — a silent modification of an
    // approved effect.
    const e = buildCommsSendEffect({
      ...base,
      to: ['both@example.com'],
      bcc: ['both@example.com'],
      subject: 's',
      bodyText: 'b',
    });
    expect(e.to).toEqual(['both@example.com']);
    expect(e.bcc).toEqual(['both@example.com']);
  });
});

describe('commsSendEffectSchema', () => {
  const valid = buildCommsSendEffect({ ...base, to: ['a@example.com'], subject: 's', bodyText: 'b' });

  it('rejects unknown keys', () => {
    expect(commsSendEffectSchema.safeParse({ ...valid, saveToSentItems: false }).success).toBe(false);
  });

  it('rejects a wrong envelope version', () => {
    expect(commsSendEffectSchema.safeParse({ ...valid, envelopeVersion: 2 }).success).toBe(false);
  });

  it('rejects an empty to list', () => {
    expect(commsSendEffectSchema.safeParse({ ...valid, to: [] }).success).toBe(false);
  });

  it('rejects more than the recipient cap in total', () => {
    const many = (n: number, p: string) =>
      Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(2, '0')}@example.com`);
    const atCap = { ...valid, to: many(M365_COMMS_MAX_RECIPIENTS, 't') };
    expect(commsSendEffectSchema.safeParse(atCap).success).toBe(true);
    const overCap = { ...valid, to: many(M365_COMMS_MAX_RECIPIENTS, 't'), cc: ['x@example.com'] };
    expect(commsSendEffectSchema.safeParse(overCap).success).toBe(false);
  });

  it('rejects a stored envelope whose recipients are not normalized', () => {
    // This schema runs against content loaded from the database, so "it was normalized at
    // creation" is a claim about the past, not a property of the bytes in hand.
    expect(commsSendEffectSchema.safeParse({ ...valid, to: ['B@example.com'] }).success).toBe(false);
    expect(commsSendEffectSchema.safeParse({ ...valid, to: ['b@example.com', 'a@example.com'] }).success).toBe(false);
    expect(commsSendEffectSchema.safeParse({ ...valid, to: ['a@example.com', 'a@example.com'] }).success).toBe(false);
  });

  it('rejects a non-guid connection or sender', () => {
    expect(commsSendEffectSchema.safeParse({ ...valid, connectionId: 'not-a-guid' }).success).toBe(false);
    expect(commsSendEffectSchema.safeParse({ ...valid, senderObjectId: 'not-a-guid' }).success).toBe(false);
  });

  it('rejects a negative consent generation', () => {
    expect(commsSendEffectSchema.safeParse({ ...valid, consentGeneration: -1 }).success).toBe(false);
  });
});
