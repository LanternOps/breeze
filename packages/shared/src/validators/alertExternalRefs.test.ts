import { describe, expect, it } from 'vitest';
import { alertExternalTicketPutSchema, alertExternalTicketUrlSchema } from './alertExternalRefs';

describe('alert external ticket refs', () => {
  it('accepts https and keeps the ticket URL length limit', () => {
    expect(alertExternalTicketUrlSchema.safeParse('https://psa.example/ticket/1').success).toBe(true);
    expect(alertExternalTicketUrlSchema.safeParse(`https://psa.example/${'x'.repeat(2048)}`).success).toBe(false);
  });
  it.each(['http://psa.example/1', 'javascript:alert(1)', 'ftp://psa.example/1'])('rejects %s', (url) => {
    expect(alertExternalTicketUrlSchema.safeParse(url).success).toBe(false);
  });
  it('is strict and trims ids and numbers', () => {
    expect(alertExternalTicketPutSchema.parse({ externalId: ' A ', externalNumber: ' 42 ', externalUrl: null })).toEqual({ externalId: 'A', externalNumber: '42', externalUrl: null });
    expect(alertExternalTicketPutSchema.parse({ externalId: 'A' })).toEqual({ externalId: 'A' });
    expect(alertExternalTicketPutSchema.safeParse({ externalId: 'A', unknown: true }).success).toBe(false);
  });
  it.each(['externalId', 'externalNumber'])('rejects empty, long and control characters in %s', (field) => {
    for (const value of ['', ' ', 'x'.repeat(256), 'a\u0007b', '\u000Bvalue', 'value\u000C']) {
      expect(alertExternalTicketPutSchema.safeParse({ externalId: 'A', [field]: value }).success).toBe(false);
    }
  });
});
