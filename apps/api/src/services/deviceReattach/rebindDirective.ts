/**
 * The signed `rebind` directive (#8318 wave 1b, spec §6.2).
 *
 * While a reattach intent is `requested` or `staged`, every heartbeat of its
 * SOURCE (main beat and parked beat alike) carries
 *
 *   rebind: { intentId, nonce, targetDeviceId, targetOrgId, targetSiteId,
 *             expiresAt, keyId, signature }
 *
 * so an agent that crashed between beats picks it up again. It is signed with
 * the deployment key — the key, pin set and line format of the #8320 identity
 * assertion (services/agentIdentityAssertion.ts) — under its own domain, and
 * the agent verifies it against its pinned keys before acting. The signature
 * binds the SOURCE agent id too, which is not on the wire: a directive copied
 * to another install never verifies there.
 *
 * Only a device that declared `rebind_protocol_version >= 1` on this beat is
 * looked up at all, so the hot path of every other device costs nothing. The
 * lookup is one indexed system-scope read (the partial unique index on open
 * intents by source); agent contexts have no partner access, so the
 * partner-axis policies would hide every intent from them.
 *
 * Nonce: a fresh 128-bit random value per response. The agent never sees it
 * twice; it ties the signature to one response, and the agent can log it.
 * Never creates the deployment key (getActiveSigningKeyId): without one, no
 * directive is sent and the reattach simply waits.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceReattachIntents, devices } from '../../db/schema';
import { getActiveSigningKeyId, signBytesWithActiveKey } from '../manifestSigning';
import { OPEN_REATTACH_INTENT_STATES, REBIND_DIRECTIVE_MAX_LIFETIME_MS } from './protocol';

export const REBIND_DIRECTIVE_DOMAIN = 'breeze-agent-rebind-v1';

/** What the heartbeat response carries. The source agent id is signed, not sent. */
export interface RebindDirective {
  intentId: string;
  nonce: string;
  targetDeviceId: string;
  targetOrgId: string;
  targetSiteId: string;
  /** Second precision, `YYYY-MM-DDTHH:MM:SSZ`. */
  expiresAt: string;
  keyId: string;
  /** Base64 Ed25519 signature over canonicalRebindDirectiveBytes. */
  signature: string;
}

export interface UnsignedRebindDirective {
  intentId: string;
  sourceAgentId: string;
  targetDeviceId: string;
  targetOrgId: string;
  targetSiteId: string;
  nonce: string;
  expiresAt: string;
  keyId: string;
}

export function secondPrecision(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

/**
 * The exact bytes signed: the domain and one field per line, joined by "\n",
 * no trailing newline:
 *
 *   breeze-agent-rebind-v1
 *   intentId
 *   sourceAgentId
 *   targetDeviceId
 *   targetOrgId
 *   targetSiteId
 *   nonce
 *   expiresAt
 *   keyId
 *
 * An empty field or one containing a control character is refused. Pinned
 * byte-for-byte by a golden test here and (wave 1b-3) in the agent.
 */
export function canonicalRebindDirectiveBytes(d: UnsignedRebindDirective): Buffer {
  const lines = [
    REBIND_DIRECTIVE_DOMAIN,
    d.intentId,
    d.sourceAgentId,
    d.targetDeviceId,
    d.targetOrgId,
    d.targetSiteId,
    d.nonce,
    d.expiresAt,
    d.keyId,
  ];
  for (const line of lines) {
    if (typeof line !== 'string' || line.length === 0) throw new Error('rebind directive field is empty');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(line)) throw new Error('rebind directive field contains a control character');
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface SignRebindDirectiveInput {
  intentId: string;
  sourceAgentId: string;
  targetDeviceId: string;
  targetOrgId: string;
  targetSiteId: string;
  nonce: string;
  expiresAt: Date;
}

/**
 * Sign one directive. Returns null when the deployment has no signing key
 * (never creates one); throws if the key rotated mid-sign.
 */
export async function signRebindDirective(input: SignRebindDirectiveInput): Promise<RebindDirective | null> {
  const keyId = await getActiveSigningKeyId();
  if (!keyId) return null;
  const unsigned: UnsignedRebindDirective = {
    intentId: input.intentId,
    sourceAgentId: input.sourceAgentId,
    targetDeviceId: input.targetDeviceId,
    targetOrgId: input.targetOrgId,
    targetSiteId: input.targetSiteId,
    nonce: input.nonce,
    expiresAt: secondPrecision(input.expiresAt),
    keyId,
  };
  const signed = await signBytesWithActiveKey(canonicalRebindDirectiveBytes(unsigned));
  if (signed.keyId !== keyId) {
    throw new Error('active signing key rotated while signing a rebind directive');
  }
  const { sourceAgentId: _signedOnly, ...wire } = unsigned;
  return { ...wire, signature: signed.signature };
}

export interface OpenIntentForSource {
  intentId: string;
  targetDeviceId: string;
  targetOrgId: string;
  targetSiteId: string;
  expiresAt: Date;
}

/**
 * The open (`requested`/`staged`), unexpired intent whose source is this
 * device AND this install. Caller owns the DB context (system scope).
 */
export async function findOpenIntentForSource(
  source: { deviceId: string; agentId: string },
  now: Date = new Date(),
): Promise<OpenIntentForSource | null> {
  const [row] = await db
    .select({
      intentId: deviceReattachIntents.id,
      targetDeviceId: deviceReattachIntents.targetDeviceId,
      // The org the human authorized (confirm refuses if the target moved);
      // the site is the target's current one.
      targetOrgId: deviceReattachIntents.targetOrgId,
      targetSiteId: devices.siteId,
      expiresAt: deviceReattachIntents.expiresAt,
    })
    .from(deviceReattachIntents)
    .innerJoin(devices, eq(devices.id, deviceReattachIntents.targetDeviceId))
    .where(and(
      eq(deviceReattachIntents.sourceDeviceId, source.deviceId),
      eq(deviceReattachIntents.sourceAgentId, source.agentId),
      inArray(deviceReattachIntents.state, [...OPEN_REATTACH_INTENT_STATES]),
      gt(deviceReattachIntents.expiresAt, now),
    ))
    .limit(1);
  return row ?? null;
}

/** The directive's lifetime: never past the intent, never more than 15 minutes. */
export function rebindDirectiveExpiry(intentExpiresAt: Date, now: Date): Date {
  return new Date(Math.min(intentExpiresAt.getTime(), now.getTime() + REBIND_DIRECTIVE_MAX_LIFETIME_MS));
}

/**
 * The directive for one heartbeat, or undefined. Non-fatal by design: a
 * failed lookup or signature costs this beat its directive and the agent
 * gets one on the next. Runs in its own short system context — call it with
 * no DB context held (the heartbeat calls it after its org transaction, like
 * the identity assertion and the trust keyset, #1105).
 */
export async function rebindDirectiveForBeat(input: {
  deviceId: string;
  agentId: string;
  /** This beat's declared capability (already normalized). */
  rebindProtocolVersion: number;
  now?: Date;
}): Promise<RebindDirective | undefined> {
  if (input.rebindProtocolVersion < 1) return undefined;
  const now = input.now ?? new Date();
  try {
    const intent = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => findOpenIntentForSource({ deviceId: input.deviceId, agentId: input.agentId }, now)),
    );
    if (!intent) return undefined;
    const signed = await signRebindDirective({
      intentId: intent.intentId,
      sourceAgentId: input.agentId,
      targetDeviceId: intent.targetDeviceId,
      targetOrgId: intent.targetOrgId,
      targetSiteId: intent.targetSiteId,
      nonce: randomBytes(16).toString('hex'),
      expiresAt: rebindDirectiveExpiry(intent.expiresAt, now),
    });
    if (!signed) {
      console.warn('[rebind] an open reattach intent exists but the deployment has no signing key; no directive sent', {
        deviceId: input.deviceId,
        intentId: intent.intentId,
      });
      return undefined;
    }
    return signed;
  } catch (err) {
    console.error('[rebind] failed to build the rebind directive for a heartbeat:', {
      deviceId: input.deviceId,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return undefined;
  }
}
