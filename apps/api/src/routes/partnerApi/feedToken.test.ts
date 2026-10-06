import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env', () => ({
  PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
}));

import { createPartnerFeedTokens, orgSetHash, sha256Hex } from './feedToken';
import {
  decodeCheckpointToken as decodeAlertsCheckpoint,
  encodeCheckpointToken as encodeAlertsCheckpoint,
  PartnerAlertsFeedTokenError,
} from './alertsFeedToken';
import { PartnerTicketsFeedTokenError, ticketsFeedTokens } from './tickets';

const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const binding = {
  partnerId: PARTNER_ID,
  epoch: '7688900532099108902:1:16384:24601',
  filtersHash: sha256Hex('{}'),
  orgSetHash: orgSetHash(['11111111-1111-4111-8111-111111111111']),
};

describe('partner feed tokens — one HMAC domain per feed', () => {
  it('an alerts checkpoint is rejected by the tickets decoder, and vice versa', () => {
    const alertsToken = encodeAlertsCheckpoint({ ...binding, horizon: '1000' });
    expect(() => ticketsFeedTokens.decodeCheckpointToken(alertsToken, binding)).toThrow(PartnerTicketsFeedTokenError);

    const ticketsToken = ticketsFeedTokens.encodeCheckpointToken({ ...binding, horizon: '1000' });
    expect(() => decodeAlertsCheckpoint(ticketsToken, binding)).toThrow(PartnerAlertsFeedTokenError);
    // Round trip in its own domain still works.
    expect(ticketsFeedTokens.decodeCheckpointToken(ticketsToken, binding).horizon).toBe('1000');
    expect(decodeAlertsCheckpoint(alertsToken, binding).horizon).toBe('1000');
  });

  it('each factory gets its own error classes and codes', () => {
    const a = createPartnerFeedTokens({
      hmacDomain: 'a', tokenErrorCode: 'a_token', tokenErrorMessage: 'a', resyncCode: 'a_resync', resyncMessage: 'a',
    });
    const b = createPartnerFeedTokens({
      hmacDomain: 'b', tokenErrorCode: 'b_token', tokenErrorMessage: 'b', resyncCode: 'b_resync', resyncMessage: 'b',
    });
    expect(new a.TokenError().code).toBe('a_token');
    expect(new b.ResyncRequiredError().code).toBe('b_resync');
    expect(new a.TokenError()).not.toBeInstanceOf(b.TokenError);
  });

  it('keyset tokens are bound to the partner and scope hash and expire', () => {
    const keyset = { partnerId: PARTNER_ID, scopeHash: sha256Hex('ticket-1') };
    const token = ticketsFeedTokens.encodeKeysetToken({
      ...keyset, lastKey: '2026-09-26T10:00:00.000Z', lastId: '11111111-1111-4111-8111-111111111111',
    });
    expect(ticketsFeedTokens.decodeKeysetToken(token, keyset).lastId).toBe('11111111-1111-4111-8111-111111111111');
    expect(() => ticketsFeedTokens.decodeKeysetToken(token, { ...keyset, scopeHash: sha256Hex('ticket-2') }))
      .toThrow(PartnerTicketsFeedTokenError);
    expect(() => ticketsFeedTokens.decodeKeysetToken(token, keyset, new Date(Date.now() + 2 * 24 * 3600 * 1000)))
      .toThrow(PartnerTicketsFeedTokenError);
    // A page/checkpoint token is not a keyset token.
    const page = ticketsFeedTokens.encodeCheckpointToken({ ...binding, horizon: '5' });
    expect(() => ticketsFeedTokens.decodeKeysetToken(page, keyset)).toThrow(PartnerTicketsFeedTokenError);
  });
});
