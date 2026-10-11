/**
 * Signed agent identity sync (#8317).
 *
 * The agent writes its org and site to agent.yaml once, at enrollment, and its
 * identity-bound handlers (peripheral policy v2, PAM lifetime, diagnostic
 * access, signed rollback) compare every server payload against that copy.
 * Moving a device to another org (`POST /devices/:id/move-org`), or to another
 * site (`PATCH /devices/:id`), changes the row but never told the agent, so
 * those handlers rejected every payload for the new org/site as
 * `wrong_identity` until the agent was re-enrolled.
 *
 * Every heartbeat now carries the identity the agent holds and a fresh nonce.
 * When the identity disagrees with the row, the response carries an assertion
 * of the row's org and site that echoes the nonce, signed with the deployment
 * signing key — the same key, pin set and line format that already sign
 * diagnostic authorizations, under its own domain. The agent accepts it only
 * as the answer to its own latest beat and only for its own agentId +
 * deviceId (a device id can never change through this path), persists the
 * new org/site and restarts so every component reloads the identity.
 * Identity is therefore never taken from an unsigned response field, and an
 * assertion cannot be replayed to a later beat.
 *
 * This never creates the deployment key (see getActiveSigningKeyId): on a
 * deployment that has none, no assertion is sent.
 */
import type { IdentityAssertionRejection } from '../routes/agents/schemas';
import { getActiveSigningKeyId, signBytesWithActiveKey } from './manifestSigning';
import { getRedis } from './redis';

export const AGENT_IDENTITY_ASSERTION_DOMAIN = 'breeze-agent-identity-v1';
// Informational: the nonce, not the clock, makes an assertion fresh. The agent
// only checks that the stated window is well formed and at most an hour.
export const AGENT_IDENTITY_ASSERTION_LIFETIME_MS = 15 * 60 * 1000;

export type AgentIdentityAssertionV1 = {
  v: 1;
  agentId: string;
  deviceId: string;
  orgId: string;
  siteId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  keyId: string;
  signature: string;
};

export type UnsignedAgentIdentityAssertionV1 = Omit<AgentIdentityAssertionV1, 'signature'>;

export type ReportedAgentIdentity = {
  deviceId: string;
  orgId: string;
  siteId: string;
  nonce: string;
};

/**
 * Normalize the only identity-sync protocol version implemented here. Absent,
 * malformed or a future version is 0, and no assertion is sent: an agent that
 * cannot verify one would only ignore it.
 */
export function normalizeIdentitySyncProtocolVersion(value: unknown): 0 | 1 {
  return value === 1 ? 1 : 0;
}

/**
 * True when the agent's reported org/site differ from the row it authenticated
 * as. A different deviceId is never "synced": the device id is the identity
 * the credential belongs to, so a mismatch there is not something this path
 * may rewrite.
 */
export function agentIdentityNeedsSync(
  reported: ReportedAgentIdentity | undefined,
  device: { id: string; orgId: string; siteId: string },
): boolean {
  if (!reported) return false;
  if (reported.deviceId !== device.id) return false;
  return reported.orgId !== device.orgId || reported.siteId !== device.siteId;
}

function secondPrecision(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

export function canonicalAgentIdentityAssertionBytes(a: UnsignedAgentIdentityAssertionV1): Buffer {
  if (a.v !== 1) throw new Error('unsupported agent identity assertion version');
  const lines = [
    AGENT_IDENTITY_ASSERTION_DOMAIN,
    a.agentId,
    a.deviceId,
    a.orgId,
    a.siteId,
    a.nonce,
    a.issuedAt,
    a.expiresAt,
    a.keyId,
  ];
  for (const line of lines) {
    if (line.length === 0) throw new Error('agent identity assertion field is empty');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(line)) throw new Error('agent identity assertion field contains a control character');
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

/**
 * Sign the row's identity as the answer to one heartbeat. Returns null when
 * the deployment has no signing key yet; this path never creates one.
 */
export async function signAgentIdentityAssertion(input: {
  agentId: string;
  deviceId: string;
  orgId: string;
  siteId: string;
  nonce: string;
  now?: Date;
}): Promise<AgentIdentityAssertionV1 | null> {
  const keyId = await getActiveSigningKeyId();
  if (!keyId) return null;
  const now = input.now ?? new Date();
  const unsigned: UnsignedAgentIdentityAssertionV1 = {
    v: 1,
    agentId: input.agentId,
    deviceId: input.deviceId,
    orgId: input.orgId,
    siteId: input.siteId,
    nonce: input.nonce,
    issuedAt: secondPrecision(now),
    expiresAt: secondPrecision(new Date(now.getTime() + AGENT_IDENTITY_ASSERTION_LIFETIME_MS)),
    keyId,
  };
  const signed = await signBytesWithActiveKey(canonicalAgentIdentityAssertionBytes(unsigned));
  if (signed.keyId !== keyId) {
    throw new Error('active signing key rotated while signing an agent identity assertion');
  }
  return { ...unsigned, signature: signed.signature };
}

/*
 * #8382 — an agent that refuses the assertion (BREEZE_ORG_ID/BREEZE_SITE_ID
 * override its agent.yaml, it gave up after restarting did not apply the
 * identity, or it never pinned the key that signs) still reports the old
 * identity, so the row keeps disagreeing and every beat would cost two key
 * reads, a decrypt and a signature for an assertion it refuses again. The
 * agent now says so on its next beat, with the org/site the refused assertion
 * named, and the server holds back the assertion for that device and target
 * for a while instead of signing one per beat.
 *
 * Kept in Redis with a TTL rather than on the device row: it is a
 * rate limit on a retry, not device state, and expiring is the point. The
 * server signs again when the TTL lapses (the agent re-checks, e.g. after a
 * key delegation reached it), when the row moves to another target, or when
 * Redis is unavailable (fail open: one assertion per beat, as before).
 */
export const AGENT_IDENTITY_REJECTION_TTL_SECONDS = 60 * 60;
// One structured warning per (device, target, code) per day.
export const AGENT_IDENTITY_REJECTION_LOG_TTL_SECONDS = 24 * 60 * 60;
const IDENTITY_REJECTION_FALLBACK_REPORT_INTERVAL_MS = 10 * 60 * 1000;

const REJECTION_HINTS: Record<IdentityAssertionRejection['code'], string> = {
  env_override:
    'BREEZE_ORG_ID / BREEZE_SITE_ID in the agent service environment override agent.yaml on every start; '
    + 'remove them (or set them to the new org/site) and restart the agent',
  gave_up:
    'restarting the agent did not apply the new org/site, so it stopped trying until its next start; '
    + 'check the agent log',
  unpinned_key:
    'the agent never pinned the deployment key that signs the assertion; it keeps its enrolled org/site '
    + 'until a key delegation reaches it or it is re-enrolled',
  invalid: 'the agent could not verify the assertion; check the agent log',
};

let identityRejectionStoreFailureReportedAt = 0;
let identityRejectionFallbackLoggedAt = 0;

function rejectionKey(deviceId: string): string {
  return `identity-sync:rejected:device:${deviceId}`;
}

function rejectionLogKey(deviceId: string, r: IdentityAssertionRejection): string {
  return `identity-sync:rejection-logged:device:${deviceId}:${r.orgId}:${r.siteId}:${r.code}`;
}

function warnRejectionStoreFailure(op: 'record' | 'read', deviceId: string, err: unknown): void {
  const now = Date.now();
  if (now - identityRejectionStoreFailureReportedAt < IDENTITY_REJECTION_FALLBACK_REPORT_INTERVAL_MS) return;
  identityRejectionStoreFailureReportedAt = now;
  console.warn(`[heartbeat] Failed to ${op} an identity assertion refusal in Redis; signing as before`, {
    deviceId,
    error: err instanceof Error ? err.message : String(err),
  });
}

function logRejection(agentId: string, deviceId: string, r: IdentityAssertionRejection): void {
  console.warn(
    '[heartbeat] Agent refused the signed identity assertion for its moved device; holding back new ones '
    + 'for this org/site until it changes or the refusal expires (#8382)',
    {
      agentId,
      deviceId,
      orgId: r.orgId,
      siteId: r.siteId,
      code: r.code,
      hint: REJECTION_HINTS[r.code],
      retryAfterSeconds: AGENT_IDENTITY_REJECTION_TTL_SECONDS,
    },
  );
}

function parseStoredTarget(raw: string): { orgId: string; siteId: string } | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      value !== null
      && typeof value === 'object'
      && typeof (value as { orgId?: unknown }).orgId === 'string'
      && typeof (value as { siteId?: unknown }).siteId === 'string'
    ) {
      return value as { orgId: string; siteId: string };
    }
  } catch {
    // A value this code did not write: treat as absent.
  }
  return null;
}

/**
 * Whether to hold back this beat's identity assertion because the agent
 * refused one for the row's current org/site. A refusal the beat carries for
 * that target is recorded (and logged once per device, target and code); a
 * refusal of an older target is ignored, so a device moved again is signed
 * for at once. Never throws: any Redis failure means "sign as before".
 */
export async function agentIdentityAssertionRefused(input: {
  agentId: string;
  deviceId: string;
  target: { orgId: string; siteId: string };
  rejection: IdentityAssertionRejection | undefined;
}): Promise<boolean> {
  const { agentId, deviceId, target, rejection } = input;
  const reported = rejection && rejection.orgId === target.orgId && rejection.siteId === target.siteId
    ? rejection
    : undefined;
  const redis = getRedis();

  if (reported) {
    // This beat is itself the agent saying it refuses this target: an
    // assertion now would only be refused again.
    if (!redis) {
      const now = Date.now();
      if (now - identityRejectionFallbackLoggedAt >= IDENTITY_REJECTION_FALLBACK_REPORT_INTERVAL_MS) {
        identityRejectionFallbackLoggedAt = now;
        logRejection(agentId, deviceId, reported);
      }
      return true;
    }
    try {
      await redis.set(rejectionKey(deviceId), JSON.stringify(reported), 'EX', AGENT_IDENTITY_REJECTION_TTL_SECONDS);
      const first = await redis.set(
        rejectionLogKey(deviceId, reported),
        '1',
        'EX',
        AGENT_IDENTITY_REJECTION_LOG_TTL_SECONDS,
        'NX',
      );
      if (first === 'OK') logRejection(agentId, deviceId, reported);
    } catch (err) {
      warnRejectionStoreFailure('record', deviceId, err);
    }
    return true;
  }

  if (!redis) return false;
  try {
    const raw = await redis.get(rejectionKey(deviceId));
    if (!raw) return false;
    const stored = parseStoredTarget(raw);
    return stored !== null && stored.orgId === target.orgId && stored.siteId === target.siteId;
  } catch (err) {
    warnRejectionStoreFailure('read', deviceId, err);
    return false;
  }
}

export function resetAgentIdentityRejectionLogStateForTests(): void {
  identityRejectionStoreFailureReportedAt = 0;
  identityRejectionFallbackLoggedAt = 0;
}
