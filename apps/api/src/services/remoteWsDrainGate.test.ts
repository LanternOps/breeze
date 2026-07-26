import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HTTP_TUNNEL_COOKIE_CLOCK_TOLERANCE_SECONDS,
  HTTP_TUNNEL_COOKIE_TTL_SECONDS,
} from '../routes/tunnelHttp';
import { VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS } from './jwt';
import {
  HTTP_TUNNEL_TICKET_TTL_SECONDS,
  WS_TICKET_TTL_SECONDS,
} from './remoteSessionAuth';
import {
  assertRemoteWsPreUpgradeDrainComplete,
  getRemoteWsDrainDeadlines,
} from './remoteWsDrainGate';

describe('remote websocket drain gate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives independent 60-second WS, 300-second HTTP, and sequential 7,200+60 viewer deadlines', () => {
    const ticketWriterDrainedAt = Date.parse('2026-07-25T10:00:00.000Z');
    const viewerIssuerDrainedAt = Date.parse('2026-07-25T11:00:00.000Z');

    const deadlines = getRemoteWsDrainDeadlines(
      ticketWriterDrainedAt,
      viewerIssuerDrainedAt,
    );

    expect(WS_TICKET_TTL_SECONDS).toBe(60);
    expect(HTTP_TUNNEL_TICKET_TTL_SECONDS).toBe(300);
    expect(HTTP_TUNNEL_COOKIE_TTL_SECONDS).toBe(300);
    expect(HTTP_TUNNEL_COOKIE_CLOCK_TOLERANCE_SECONDS).toBe(0);
    expect(VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS).toBe(7_200);
    expect(deadlines.legacyV0WsTicketsExpireAtMs).toBe(
      ticketWriterDrainedAt + 60_000,
    );
    expect(deadlines.legacyV0HttpCredentialsExpireAtMs).toBe(
      ticketWriterDrainedAt + 300_000,
    );
    expect(deadlines.admissionReopenNotBeforeMs).toBe(
      ticketWriterDrainedAt + 300_000,
    );
    expect(deadlines.viewerTokensExpireAtMs).toBe(
      viewerIssuerDrainedAt + 7_200_000,
    );
    expect(deadlines.preUpgradeNotBeforeMs).toBe(
      viewerIssuerDrainedAt + 7_260_000,
    );
  });

  it.each([
    {},
    { legacyTicketWriterDrainedAt: 'not-a-date', legacyViewerIssuerDrainedAt: '2026-07-25T11:00:00.000Z' },
    { legacyTicketWriterDrainedAt: '2026-07-25T10:00:00.000Z', legacyViewerIssuerDrainedAt: 'not-a-date' },
    { legacyTicketWriterDrainedAt: '2026-07-26T10:00:00.000Z', legacyViewerIssuerDrainedAt: '2026-07-25T11:00:00.000Z' },
  ])('rejects pre_upgrade for missing, malformed, or future verified drain evidence', (evidence) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T20:00:00.000Z'));

    expect(() => assertRemoteWsPreUpgradeDrainComplete({
      mode: 'pre_upgrade',
      legacyTicketWriterDrainedAt: evidence.legacyTicketWriterDrainedAt,
      legacyViewerIssuerDrainedAt: evidence.legacyViewerIssuerDrainedAt,
    })).toThrow();
  });

  it('keeps post_upgrade accepted before, at, and after every drain deadline', () => {
    for (const now of [
      '2026-07-25T09:00:00.000Z',
      '2026-07-25T10:05:00.000Z',
      '2026-07-25T13:01:00.000Z',
    ]) {
      expect(() => assertRemoteWsPreUpgradeDrainComplete({
        mode: 'post_upgrade',
        legacyTicketWriterDrainedAt: undefined,
        legacyViewerIssuerDrainedAt: undefined,
        nowMs: Date.parse(now),
      })).not.toThrow();
    }
  });

  it('rejects pre_upgrade through the final millisecond of the viewer-token plus V1 ticket lifetime', () => {
    const ticketWriterDrainedAt = '2026-07-25T10:00:00.000Z';
    const viewerIssuerDrainedAt = '2026-07-25T11:00:00.000Z';
    const finalBoundary = Date.parse(viewerIssuerDrainedAt) + 7_260_000;

    expect(() => assertRemoteWsPreUpgradeDrainComplete({
      mode: 'pre_upgrade',
      legacyTicketWriterDrainedAt: ticketWriterDrainedAt,
      legacyViewerIssuerDrainedAt: viewerIssuerDrainedAt,
      nowMs: finalBoundary - 1,
    })).toThrow();

    expect(() => assertRemoteWsPreUpgradeDrainComplete({
      mode: 'pre_upgrade',
      legacyTicketWriterDrainedAt: ticketWriterDrainedAt,
      legacyViewerIssuerDrainedAt: viewerIssuerDrainedAt,
      nowMs: finalBoundary,
    })).not.toThrow();
  });

  it('does not permit admission reopen at the 60-second WS boundary or one millisecond before the 300-second HTTP boundary', () => {
    const writerDrainedAt = Date.parse('2026-07-25T10:00:00.000Z');
    const deadlines = getRemoteWsDrainDeadlines(
      writerDrainedAt,
      Date.parse('2026-07-25T11:00:00.000Z'),
    );

    expect(writerDrainedAt + 60_000).toBeLessThan(
      deadlines.admissionReopenNotBeforeMs,
    );
    expect(writerDrainedAt + 299_999).toBeLessThan(
      deadlines.admissionReopenNotBeforeMs,
    );
    expect(writerDrainedAt + 300_000).toBe(
      deadlines.admissionReopenNotBeforeMs,
    );
  });
});
