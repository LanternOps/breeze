import { createHash } from 'node:crypto';
import type { devices } from '../db/schema';

/**
 * Every credential column of a `devices` row set to "none": agent, watchdog
 * and helper, current/previous/pending, with their issued/expiry stamps. The
 * ONE set every path that replaces or retires a row's credentials spreads
 * (F3 re-enroll, the admin token reset, the reattach confirm for the target
 * and the source), so a credential column added later cannot survive any of
 * them: agentCredentialHashes.test.ts fails until it joins this set.
 * (Type-only import: this module stays a dependency-free leaf at runtime.)
 */
export const CLEARED_AGENT_CREDENTIALS = {
  agentTokenHash: null,
  tokenIssuedAt: null,
  previousTokenHash: null,
  previousTokenExpiresAt: null,
  pendingTokenHash: null,
  pendingTokenExpiresAt: null,
  watchdogTokenHash: null,
  watchdogTokenIssuedAt: null,
  previousWatchdogTokenHash: null,
  previousWatchdogTokenExpiresAt: null,
  pendingWatchdogTokenHash: null,
  helperTokenHash: null,
  helperTokenIssuedAt: null,
  previousHelperTokenHash: null,
  previousHelperTokenExpiresAt: null,
  pendingHelperTokenHash: null,
} as const satisfies Partial<typeof devices.$inferInsert>;

/** The stored form of every agent-side secret: lowercase hex SHA-256 of the whole token string. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A value in that stored form: 64 lowercase hex characters. */
export const SHA256_HEX_DIGEST = /^[0-9a-f]{64}$/;

/**
 * Every credential hash a `devices` row can carry: agent, watchdog and helper,
 * each current, previous and pending (#8318 §6.4, full-hash revocation).
 *
 * Re-enroll (routes/agents/enrollment.ts) used to publish revocation for the
 * agent hashes only, so a stale watchdog or helper session survived the agent
 * socket's eviction. Everything that replaces a row's credential set should
 * revoke this whole list.
 */
export interface AgentCredentialHashRow {
  agentTokenHash?: string | null;
  previousTokenHash?: string | null;
  pendingTokenHash?: string | null;
  watchdogTokenHash?: string | null;
  previousWatchdogTokenHash?: string | null;
  pendingWatchdogTokenHash?: string | null;
  helperTokenHash?: string | null;
  previousHelperTokenHash?: string | null;
  pendingHelperTokenHash?: string | null;
}

export function collectAgentCredentialHashes(row: AgentCredentialHashRow): string[] {
  const hashes = [
    row.agentTokenHash,
    row.previousTokenHash,
    row.pendingTokenHash,
    row.watchdogTokenHash,
    row.previousWatchdogTokenHash,
    row.pendingWatchdogTokenHash,
    row.helperTokenHash,
    row.previousHelperTokenHash,
    row.pendingHelperTokenHash,
  ];
  return [...new Set(hashes.filter((hash): hash is string => typeof hash === 'string' && hash.length > 0))];
}
