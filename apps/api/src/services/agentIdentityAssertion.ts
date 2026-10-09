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
import { getActiveSigningKeyId, signBytesWithActiveKey } from './manifestSigning';

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
