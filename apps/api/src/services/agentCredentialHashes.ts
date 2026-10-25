import { createHash } from 'node:crypto';

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
