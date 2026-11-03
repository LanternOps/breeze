/**
 * Tool Catalog W06 (#5221) Task B3, plan Decision 14 — a legacy
 * `execute_command` action becomes an owner-scoped library script, created in
 * the switch transaction BY THE SWITCHING USER through the normal
 * script-create path, then run by `run_script_on_targets`.
 *
 * The converter names each such script in the draft by a placeholder id
 * (`generatedScriptPlaceholderId`, stable per Job + action). At the switch:
 *
 *  - only placeholders the current draft still names get a script (a step the
 *    user removed from the draft during shadow creates nothing);
 *  - each script is checked as `POST /scripts` checks a create: `scripts.write`
 *    in the owner scope (the user's live membership), the tenancy resolution
 *    and partner-wide gate of `resolveScriptCreateScope`, which must land on
 *    exactly the Job's owner axis, and the save-time secret-variable refusal;
 *    then `insertScriptRow` (the single script-insert chokepoint) in the
 *    caller's transaction;
 *  - the body is the legacy command, byte for byte; name
 *    `Moved from Job "<name>" — command <n>`; language from the legacy shell
 *    (or the converter's single-OS default); `runAs: system` and a 300 s
 *    timeout, exactly what legacy dispatched (`executeCommandAction`); every
 *    OS, because legacy never filtered a command by OS;
 *  - the ids are rewritten into the draft's `input.scriptId`.
 *
 * Nothing here commits: a refusal anywhere later in the switch rolls these
 * scripts back with it.
 */
import type { FlowDocumentV1 } from '@breeze/shared';
import type { AuthContext } from '../../../middleware/auth';
import { hasPermission, type UserPermissions } from '../../permissions';
import { findSecretVariableReferences } from '../../scriptBundle';
import { insertScriptRow, isScriptScopeError, resolveScriptCreateScope } from '../../scriptWrite';
import type { ToolOwnerRef } from '../../toolSources/resolver';
import { generatedScriptPlaceholderId, type GeneratedScriptSpec } from './convertAutomation';

/** What legacy `executeCommandAction` dispatched with. */
const LEGACY_COMMAND_TIMEOUT_SECONDS = 300;
const ALL_OS_TYPES = ['windows', 'macos', 'linux'];
const COMMAND_STEP_RE = /^a(\d+)_command$/;

export interface PlannedGeneratedScript {
  placeholderId: string;
  spec: GeneratedScriptSpec;
}

export interface CreatedGeneratedScript {
  placeholderId: string;
  stepId: string;
  scriptId: string;
  name: string;
}

export type GeneratedScriptsResult =
  | { ok: true; created: CreatedGeneratedScript[] }
  | { ok: false; error: 'permission_missing'; missing: Array<{ stepId: string; permission: string }> }
  | { ok: false; error: 'generated_script_rejected'; stepId: string; reason: 'scope' | 'owner_mismatch' | 'secret_variable_reference' };

/** The converter's generated scripts for this Job, keyed by the placeholder id the draft names. */
export function plannedGeneratedScripts(automationId: string, specs: readonly GeneratedScriptSpec[]): Map<string, PlannedGeneratedScript> {
  const out = new Map<string, PlannedGeneratedScript>();
  for (const spec of specs) {
    const m = COMMAND_STEP_RE.exec(spec.stepId);
    if (!m) continue;
    const placeholderId = generatedScriptPlaceholderId(automationId, Number(m[1]));
    out.set(placeholderId, { placeholderId, spec });
  }
  return out;
}

type Step = FlowDocumentV1['steps'][number];
const literalScriptId = (step: Step): string | null =>
  typeof step.input.scriptId === 'string' ? step.input.scriptId : null;

/** The planned scripts the draft still names, in step order (each once). */
export function placeholdersNamedBy(doc: FlowDocumentV1, planned: ReadonlyMap<string, PlannedGeneratedScript>): PlannedGeneratedScript[] {
  const seen = new Set<string>();
  const out: PlannedGeneratedScript[] = [];
  for (const step of doc.steps) {
    const id = literalScriptId(step);
    const plan = id ? planned.get(id) : undefined;
    if (!plan || seen.has(plan.placeholderId)) continue;
    seen.add(plan.placeholderId);
    out.push(plan);
  }
  return out;
}

/** The draft with every placeholder `input.scriptId` replaced by its generated script's id. */
export function rewriteScriptIds(doc: FlowDocumentV1, idByPlaceholder: ReadonlyMap<string, string>): FlowDocumentV1 {
  return {
    ...doc,
    steps: doc.steps.map((step) => {
      const id = literalScriptId(step);
      const real = id ? idByPlaceholder.get(id) : undefined;
      return real ? { ...step, input: { ...step.input, scriptId: real } } : step;
    }),
  };
}

/**
 * Create the generated scripts as `auth`'s user, in the caller's transaction.
 * `perms` is the user's live membership in the owner scope (the switch reads
 * it once for the delegation ceiling).
 */
export async function createGeneratedScripts(
  auth: AuthContext,
  owner: ToolOwnerRef,
  perms: UserPermissions,
  plans: readonly PlannedGeneratedScript[],
): Promise<GeneratedScriptsResult> {
  if (plans.length === 0) return { ok: true, created: [] };
  if (!hasPermission(perms, 'scripts', 'write')) {
    return { ok: false, error: 'permission_missing', missing: plans.map((p) => ({ stepId: p.spec.stepId, permission: 'scripts.write' })) };
  }
  const scope = resolveScriptCreateScope(
    { ...auth, partnerOrgAccess: auth.partnerOrgAccess },
    owner.orgId ? 'org' : 'partner',
    owner.orgId,
  );
  const first = plans[0]!.spec.stepId;
  if (isScriptScopeError(scope)) return { ok: false, error: 'generated_script_rejected', stepId: first, reason: 'scope' };
  if (scope.orgId !== owner.orgId || scope.partnerId !== owner.partnerId) {
    return { ok: false, error: 'generated_script_rejected', stepId: first, reason: 'owner_mismatch' };
  }

  const created: CreatedGeneratedScript[] = [];
  for (const plan of plans) {
    if ((await findSecretVariableReferences(scope, plan.spec.body)).length > 0) {
      return { ok: false, error: 'generated_script_rejected', stepId: plan.spec.stepId, reason: 'secret_variable_reference' };
    }
    const script = await insertScriptRow(auth, scope, {
      name: plan.spec.name,
      osTypes: ALL_OS_TYPES,
      language: plan.spec.language,
      content: plan.spec.body,
      timeoutSeconds: LEGACY_COMMAND_TIMEOUT_SECONDS,
      runAs: 'system',
    });
    created.push({ placeholderId: plan.placeholderId, stepId: plan.spec.stepId, scriptId: script.id, name: script.name });
  }
  return { ok: true, created };
}
