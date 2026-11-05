/**
 * Wisp delegation W1 (#11084) — what a user may change on the built-in
 * troubleshoot agent: enable/disable and its name. Its mode (shadow), stored
 * allowlist (the proposable set intent minting and release re-check) and
 * instructions belong to the system. Kept free of db imports so agentService
 * and the route can use it without pulling in the provisioner.
 */
export class TroubleshootAgentEditError extends Error {
  readonly code = 'troubleshoot_agent_edit_restricted' as const;
  constructor(readonly fields: string[]) {
    super(fields.length === 1 && fields[0] === 'kind'
      ? 'The troubleshoot agent is provisioned by the system and cannot be created'
      : `The built-in troubleshoot agent only allows changes to enabled and name; refused: ${fields.join(', ')}`);
    this.name = 'TroubleshootAgentEditError';
  }
}

const ALLOWED_TOP = new Set(['enabled', 'name']);

/** PATCH-shaped input only: an absent (undefined) key is "leave alone". */
export function assertTroubleshootAgentEdit(input: Record<string, unknown>): void {
  const refused = Object.keys(input).filter((key) => input[key] !== undefined && !ALLOWED_TOP.has(key));
  if (refused.length > 0) throw new TroubleshootAgentEditError(refused);
}
