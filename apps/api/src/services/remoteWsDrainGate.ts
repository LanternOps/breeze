import {
  HTTP_TUNNEL_COOKIE_CLOCK_TOLERANCE_SECONDS,
  HTTP_TUNNEL_COOKIE_TTL_SECONDS,
} from '../routes/tunnelHttp';
import { VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS } from './jwt';
import {
  HTTP_TUNNEL_TICKET_TTL_SECONDS,
  WS_TICKET_TTL_SECONDS,
} from './remoteSessionAuth';
import type { RemoteWsAuthMode } from './remoteWsAuthorization';

export interface RemoteWsDrainDeadlines {
  legacyV0WsTicketsExpireAtMs: number;
  legacyV0HttpCredentialsExpireAtMs: number;
  admissionReopenNotBeforeMs: number;
  viewerTokensExpireAtMs: number;
  preUpgradeNotBeforeMs: number;
}

function requireFiniteTimestamp(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a valid timestamp`);
  }
  return value;
}

function parseVerifiedDrainTimestamp(
  value: string | undefined,
  name: string,
  nowMs: number,
): number {
  const trimmed = value?.trim();
  if (
    !trimmed
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(trimmed)
  ) {
    throw new Error(`${name} must be a verified UTC timestamp`);
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== (
    trimmed.includes('.') ? trimmed : trimmed.replace('Z', '.000Z')
  )) {
    throw new Error(`${name} must be a valid UTC timestamp`);
  }
  if (parsed > nowMs) {
    throw new Error(`${name} cannot be in the future`);
  }
  return parsed;
}

export function getRemoteWsDrainDeadlines(
  legacyTicketWriterDrainedAtMs: number,
  legacyViewerIssuerDrainedAtMs: number,
): RemoteWsDrainDeadlines {
  const ticketWriter = requireFiniteTimestamp(
    legacyTicketWriterDrainedAtMs,
    'legacyTicketWriterDrainedAtMs',
  );
  const viewerIssuer = requireFiniteTimestamp(
    legacyViewerIssuerDrainedAtMs,
    'legacyViewerIssuerDrainedAtMs',
  );
  const legacyV0WsTicketsExpireAtMs =
    ticketWriter + WS_TICKET_TTL_SECONDS * 1_000;
  const legacyV0HttpCredentialsExpireAtMs =
    ticketWriter
    + Math.max(
      HTTP_TUNNEL_TICKET_TTL_SECONDS,
      HTTP_TUNNEL_COOKIE_TTL_SECONDS
        + HTTP_TUNNEL_COOKIE_CLOCK_TOLERANCE_SECONDS,
    ) * 1_000;
  const viewerTokensExpireAtMs =
    viewerIssuer + VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS * 1_000;

  return {
    legacyV0WsTicketsExpireAtMs,
    legacyV0HttpCredentialsExpireAtMs,
    admissionReopenNotBeforeMs: Math.max(
      legacyV0WsTicketsExpireAtMs,
      legacyV0HttpCredentialsExpireAtMs,
    ),
    viewerTokensExpireAtMs,
    preUpgradeNotBeforeMs:
      viewerTokensExpireAtMs + WS_TICKET_TTL_SECONDS * 1_000,
  };
}

export function assertRemoteWsPreUpgradeDrainComplete(input: {
  mode: RemoteWsAuthMode;
  legacyTicketWriterDrainedAt: string | undefined;
  legacyViewerIssuerDrainedAt: string | undefined;
  nowMs?: number;
}): void {
  if (input.mode === 'post_upgrade') return;

  const nowMs = input.nowMs ?? Date.now();
  const ticketWriter = parseVerifiedDrainTimestamp(
    input.legacyTicketWriterDrainedAt,
    'REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT',
    nowMs,
  );
  const viewerIssuer = parseVerifiedDrainTimestamp(
    input.legacyViewerIssuerDrainedAt,
    'REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT',
    nowMs,
  );
  const deadlines = getRemoteWsDrainDeadlines(ticketWriter, viewerIssuer);
  if (nowMs < deadlines.admissionReopenNotBeforeMs) {
    throw new Error('legacy V0 remote credentials have not fully drained');
  }
  if (nowMs < deadlines.preUpgradeNotBeforeMs) {
    throw new Error('legacy viewer and compatibility tickets have not fully drained');
  }
}
