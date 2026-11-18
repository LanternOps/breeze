/**
 * Tool Catalog W05 (#5220), plan Task B2 / Decision 12 — rule 7 for built-in
 * steps. W04's `missingPermissionsFor` skipped `source === 'builtin'` pins,
 * which was harmless for `wait`/`set` and wrong for effectful built-ins: an
 * enabler could delegate an outbound HTTP call or a channel send they could
 * not make themselves. Each built-in now names the permission its effect
 * needs, checked by rule 7 at enable, for a manual run's triggerer and by
 * `assertDelegatorAuthority` at every slice and dispatch claim.
 *
 *  - `notify` ⇒ `alerts.write` (what `manage_notification_channels`' test send requires);
 *  - `http_request` ⇒ `external_tools.write` (the tenant Tier-2/3 requirement —
 *    the explicit egress grant; there is no owner-managed origin allowlist);
 *  - `ai` ⇒ `ai_sessions.use` (what opening a chat session requires) plus, for
 *    every allowlisted tool, that tool's own requirement.
 */
import type { FlowBuiltinName } from '@breeze/shared';
import { checkToolPermissionForResolvedUser, resolveToolPermissionRequirements } from '../../aiGuardrails';
import { hasPermission, type UserPermissions } from '../../permissions';
import { tenantToolPermissionRequirement } from '../../toolSources/guardrails';
import { FLOW_BUILTIN_PERMISSIONS } from './permissionTable';

export { FLOW_BUILTIN_PERMISSIONS };

type Requirement = { resource: string; action: string };

const label = (r: Requirement) => `${r.resource}.${r.action}`;

/**
 * Every permission a core tool needs for `input` that `perms` lacks (W04
 * rule 7 for core steps, moved here so built-in `ai` tools share it). When
 * the tool cannot be resolved at all, its denial text is the one entry.
 */
export function corePermissionMisses(tool: string, input: Record<string, unknown>, perms: UserPermissions): string[] {
  const denial = checkToolPermissionForResolvedUser(tool, input, perms);
  if (!denial) return [];
  const resolution = resolveToolPermissionRequirements(tool, input);
  const unmet = resolution.ok
    ? resolution.requirements.filter((r) => !hasPermission(perms, r.resource, r.action)).map(label)
    : [];
  return unmet.length > 0 ? unmet : [denial];
}

/** Every permission a built-in step needs that `perms` lacks (deduplicated, in order). */
export function builtinPermissionMisses(step: { tool: string; input: Record<string, unknown> }, perms: UserPermissions): string[] {
  const name = step.tool as FlowBuiltinName;
  const out = new Set<string>();
  for (const r of FLOW_BUILTIN_PERMISSIONS[name] ?? []) {
    if (!hasPermission(perms, r.resource, r.action)) out.add(label(r));
  }
  if (name === 'ai' && Array.isArray(step.input.tools)) {
    for (const tool of step.input.tools) {
      if (typeof tool !== 'string') continue;
      if (tool.includes('__')) {
        // An ai step's tools are Tier 1 (validateBuiltins): the tenant Tier-1 grant.
        const r = tenantToolPermissionRequirement(1);
        if (!hasPermission(perms, r.resource, r.action)) out.add(label(r));
      } else {
        for (const miss of corePermissionMisses(tool, {}, perms)) out.add(miss);
      }
    }
  }
  return [...out];
}
