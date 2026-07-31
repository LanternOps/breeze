import { describe, expect, it } from 'vitest';
import {
  m365CommsRequestSchema,
  m365CommsResultSchema,
  commsCompleteConsentRequestSchema,
  commsRetestRequestSchema,
  commsRevokeConnectionRequestSchema,
} from './commsExecutorContracts';
import { buildCommsSendEffect } from './commsEffect';

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const G3 = '33333333-3333-4333-8333-333333333333';
const G4 = '44444444-4444-4444-8444-444444444444';

const base = {
  correlationId: G1,
  connectionId: G2,
  tenantId: G3,
  expectedUserObjectId: G4,
  consentGeneration: 1,
};

function envelope(overrides: Record<string, unknown> = {}) {
  return buildCommsSendEffect({
    actionVersion: 1,
    connectionId: G2,
    tenantId: G3,
    senderObjectId: G4,
    consentGeneration: 1,
    to: ['a@example.com'],
    subject: 's',
    bodyText: 'b',
    ...overrides,
  });
}

describe('m365CommsRequestSchema', () => {
  it('accepts a read request carrying an inline action', () => {
    const parsed = m365CommsRequestSchema.safeParse({
      ...base,
      action: { type: 'm365.comms.mail.list', folder: 'inbox' },
    });
    expect(parsed.success).toBe(true);
  });

  it('REFUSES a send ride along the action field', () => {
    // The send action variant is tool-input shape only. A send must arrive as
    // the stored envelope, or the executor would have to rebuild it — the
    // mapping design §5.3 forbids.
    const parsed = m365CommsRequestSchema.safeParse({
      ...base,
      action: {
        type: 'm365.comms.mail.send',
        to: ['a@example.com'], subject: 's', bodyText: 'b',
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a send request whose envelope agrees with the outer binding', () => {
    const parsed = m365CommsRequestSchema.safeParse({ ...base, envelope: envelope() });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['connectionId', { connectionId: G1 }],
    ['tenantId', { tenantId: G1 }],
    ['senderObjectId', { senderObjectId: G1 }],
    ['consentGeneration', { consentGeneration: 2 }],
  ])('refuses a send whose envelope disagrees with the outer %s', (_field, override) => {
    const parsed = m365CommsRequestSchema.safeParse({ ...base, envelope: envelope(override) });
    expect(parsed.success).toBe(false);
  });

  it('refuses a request carrying both action and envelope, or neither', () => {
    expect(m365CommsRequestSchema.safeParse({
      ...base,
      action: { type: 'm365.comms.mail.get', messageId: 'abc' },
      envelope: envelope(),
    }).success).toBe(false);
    expect(m365CommsRequestSchema.safeParse(base).success).toBe(false);
  });

  it('rejects an unknown key — including a body-level effectDigest', () => {
    // Design §5.2: the digest arrives as a signed JWT claim and nowhere else. A body field
    // would let an implementer verify an envelope against a digest derived from that same
    // envelope — a check that always passes.
    expect(m365CommsRequestSchema.safeParse({
      ...base,
      action: { type: 'm365.comms.mail.get', messageId: 'AAMkAA==' },
      effectDigest: 'a'.repeat(64),
    }).success).toBe(false);
  });

  it('requires the pinned identity fields', () => {
    for (const key of ['connectionId', 'tenantId', 'expectedUserObjectId', 'consentGeneration']) {
      const body: Record<string, unknown> = {
        ...base,
        action: { type: 'm365.comms.mail.get', messageId: 'AAMkAA==' },
      };
      delete body[key];
      expect(m365CommsRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('refuses list requests combining search and sinceHours', () => {
    // Graph rejects $search combined with $filter at runtime; refuse it at the
    // schema so the failure is a 400 here, not a graph_provider_rejected there.
    expect(m365CommsRequestSchema.safeParse({
      ...base,
      action: { type: 'm365.comms.mail.list', folder: 'inbox', search: 'invoice', sinceHours: 24 },
    }).success).toBe(false);
  });
});

describe('m365CommsResultSchema cache-generation metadata', () => {
  it('accepts usedCacheGeneration and rotated on success variants', () => {
    expect(m365CommsResultSchema.safeParse({
      success: true, kind: 'sent', sentAt: '2026-07-29T00:00:00.000Z',
      usedCacheGeneration: 4, rotated: true,
    }).success).toBe(true);
  });
});

describe('consent / retest / revoke contracts', () => {
  it('accepts a first-consent request with a null expectedTenantId', () => {
    expect(commsCompleteConsentRequestSchema.safeParse({
      correlationId: G1, connectionId: G2, consentAttemptId: G3,
      claimedConsentGeneration: 1,
      authorizationCode: 'code', codeVerifier: 'v'.repeat(43),
      nonce: 'n', redirectUri: 'https://app.example.com/api/v1/m365/comms-consent/callback',
      expectedTenantId: null,
    }).success).toBe(true);
  });

  it('retest binds connection, tenant, user, and generation', () => {
    expect(commsRetestRequestSchema.safeParse({
      correlationId: G1, connectionId: G2, tenantId: G3,
      expectedUserObjectId: G4, consentGeneration: 1,
    }).success).toBe(true);
  });

  it('revoke takes an optional attempt condition', () => {
    expect(commsRevokeConnectionRequestSchema.safeParse({
      correlationId: G1, connectionId: G2, consentAttemptId: null,
    }).success).toBe(true);
    expect(commsRevokeConnectionRequestSchema.safeParse({
      correlationId: G1, connectionId: G2, consentAttemptId: G3,
    }).success).toBe(true);
  });
});
