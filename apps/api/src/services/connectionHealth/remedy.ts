// Conditions with no repair page in Breeze: the only remedy happens in another
// product, so the panel and the digest show guidance instead of a "Fix" link.
// Derived from the condition (not stored), so existing incident rows pick it up
// without a migration. fix_href stays NOT NULL in the ledger and is only the
// link for in-app notifications.

export type Remedy = { kind: 'reconnect' };

const REMEDIES: Readonly<Record<string, Remedy>> = {
  grant_revoked_reuse: { kind: 'reconnect' },
};

export function remedyFor(condition: string): Remedy | null {
  return Object.prototype.hasOwnProperty.call(REMEDIES, condition) ? REMEDIES[condition]! : null;
}

/** English guidance for the digest; the web panel carries its own localized copy. */
export const RECONNECT_GUIDANCE =
  'Reconnect from the client app (e.g. re-add the MCP server). No action in Breeze.';
