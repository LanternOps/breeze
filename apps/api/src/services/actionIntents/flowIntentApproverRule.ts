/**
 * Who may approve a flow step's intent — shared by the create-time fan-out
 * (createActionIntent) and the decide-time check (intentApprovers.ts
 * isFlowIntentDecideAuthorized) so the two can never disagree. A leaf: the
 * guardrails' RBAC map and the built-in permission table only.
 *
 *  - an external (tool-source) step: the external-tool grant, org-wide target
 *    (Tool catalog W04 #5219);
 *  - a built-in step (W05 #5220, Decision 12 — an http_request write): the
 *    built-in's own permission (FLOW_BUILTIN_PERMISSIONS), org-wide target —
 *    its effect is outside Breeze and it names no device;
 *  - a core step: the tool's RBAC mapping, over the devices its arguments name.
 * `required: null` ⇒ nobody may approve (fail closed).
 */
import { isFlowBuiltin } from '@breeze/shared';
import { requiredPermissionsForTool } from '../aiGuardrails';
import { FLOW_BUILTIN_PERMISSIONS } from '../flows/builtins/permissionTable';

export const FLOW_EXTERNAL_TOOL_APPROVER_PERMISSION = { resource: 'external_tools', action: 'write' } as const;

export function flowIntentApproverRule(intent: {
  actionName: string;
  toolSourceToolId?: string | null;
  arguments?: Record<string, unknown> | null;
}): { required: Array<{ resource: string; action: string }> | null; indirect: boolean } {
  if (intent.toolSourceToolId) return { required: [{ ...FLOW_EXTERNAL_TOOL_APPROVER_PERMISSION }], indirect: true };
  if (isFlowBuiltin(intent.actionName)) {
    const perms = FLOW_BUILTIN_PERMISSIONS[intent.actionName];
    return { required: perms.length > 0 ? perms.map((p) => ({ ...p })) : null, indirect: true };
  }
  return { required: requiredPermissionsForTool(intent.actionName, intent.arguments ?? {}), indirect: false };
}
