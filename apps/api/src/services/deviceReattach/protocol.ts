/**
 * The bounded rebind (#8318 wave 1b, spec
 * docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
 * §6) — shared vocabulary. A dependency-free leaf: the agent routes, the
 * heartbeats, enrollment and the services all import it without pulling in
 * the database or each other.
 */

/** The only rebind protocol version this server speaks. */
export const REBIND_PROTOCOL_VERSION = 1 as const;

/**
 * Normalize the agent's declared rebind capability (`securityCapabilities.
 * rebindProtocolVersion`, at enroll and on both heartbeats). Exactly 1 only:
 * absent, malformed or a future version is 0, and such a device can neither
 * be the source of a reattach nor receive a directive.
 */
export function normalizeRebindProtocolVersion(value: unknown): 0 | 1 {
  return value === REBIND_PROTOCOL_VERSION ? 1 : 0;
}

/** `requested` lives 60 minutes if phase 1 never comes (§6.5, decision 11). */
export const REATTACH_REQUESTED_TTL_MS = 60 * 60 * 1000;
/** `staged` lives 15 minutes from `staged_at` (§6.5, decision 11). */
export const REATTACH_STAGED_TTL_MS = 15 * 60 * 1000;
/** A directive is never valid past the intent, and never more than 15 minutes. */
export const REBIND_DIRECTIVE_MAX_LIFETIME_MS = 15 * 60 * 1000;
/** The target counts as silent only when every credential signal is older than this (§6.5). */
export const REATTACH_TARGET_QUIET_PERIOD_MS = 10 * 60 * 1000;
/** Terminal intents are pruned after 30 days (§4.3); the ledger keeps confirm replay working. */
export const REATTACH_INTENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** The source's previous certificate is revoked 24 h after confirm (§6.4 "After commit"). */
export const REATTACH_SOURCE_CERT_GRACE_MS = 24 * 60 * 60 * 1000;

/** Prefix of the confirm-only token the agent generates (§6.3). */
export const REBIND_CONFIRMATION_TOKEN_PREFIX = 'brz_rbc_';

export const OPEN_REATTACH_INTENT_STATES = ['requested', 'staged'] as const;
export const TERMINAL_REATTACH_INTENT_STATES = ['confirmed', 'expired', 'cancelled'] as const;

/** Why an intent was cancelled (`device_reattach_intents.cancel_reason`). */
export type ReattachCancelReason =
  | 'admin'
  | 'source_changed'
  | 'target_changed'
  | 'target_alive'
  | 'liveness_unknown'
  | 'partner_mismatch'
  | 'requester_revoked'
  | 'restage_refused'
  | 'key_revoked'
  | 'device_limit_reached';

/** A SHA-256 hex digest, as every hash on the wire and in the intent is. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;
