/**
 * Fleet Design step 4 helpers (Fleet Designer W04, #5654; spec §4.8 step 4).
 *
 * Approved scripts are created through the bundle importer — the same
 * tenancy chokepoint (`resolveScriptCreateScope`), secret-variable rejection,
 * parameter validation, tag linking and version cut (`insertScriptRow` →
 * `cutScriptVersion`) every other library intake uses — never through a
 * second create path. What differs is only the provenance the caller states:
 * the content is AI-authored and a person approved it item by item, so the
 * row and its v1 version carry `origin = 'ai_proposal'` with the approver and
 * no proposal/review ids (no model review ran). Nothing here executes a
 * script, and nothing acknowledges a STRICT pattern: the importer stores the
 * acknowledgement set empty, so the agent refuses a risky body until a human
 * acknowledges it in the script editor.
 */
import type { FleetDesignAutomationEntry, FleetDesignOutcome, FleetDesignRule } from '@breeze/shared';
import { SCRIPT_BUNDLE_VERSION, type ScriptBundleEnvelope } from '../scriptBundle/schema';

export const FLEET_DESIGN_SCRIPT_TAG = 'fleet-design';
export const FLEET_DESIGN_SCRIPT_CATEGORY = 'Fleet Design';
export const FLEET_DESIGN_SCRIPT_TIMEOUT_SECONDS = 300;

export type FleetDesignProposedScript = FleetDesignAutomationEntry['scripts'][number];

export interface FleetDesignScriptToCreate {
  itemRef: string;
  functionKey: string;
  script: FleetDesignProposedScript;
}

export function automationScriptRef(functionKey: string, index: number): string {
  return `automation:${functionKey}:script:${index}`;
}

export function parseAutomationRef(ref: string): { functionKey: string; index: number } | null {
  const m = /^automation:(.+):script:(\d+)$/.exec(ref);
  if (!m) return null;
  return { functionKey: m[1]!, index: Number(m[2]) };
}

/** One bundle entry per proposal — org-owned SYSTEM-context script, default timeout, tagged. */
export function toBundleEntry(script: FleetDesignProposedScript) {
  return {
    name: script.name,
    description: script.purpose,
    category: FLEET_DESIGN_SCRIPT_CATEGORY,
    tags: [FLEET_DESIGN_SCRIPT_TAG],
    osTypes: script.osTypes,
    language: script.language,
    content: script.content,
    timeoutSeconds: FLEET_DESIGN_SCRIPT_TIMEOUT_SECONDS,
    runAs: 'system' as const,
  };
}

export function buildScriptEnvelope(scripts: FleetDesignProposedScript[]): ScriptBundleEnvelope {
  return { bundleVersion: SCRIPT_BUNDLE_VERSION, scripts: scripts.map(toBundleEntry) };
}

/**
 * The automation proposal a rule's `action: { kind: 'script', ref }` names.
 * The model may cite a proposal by its item ref (exact) or by its name. Two
 * functions can propose the same name, so a name resolves within the rule's
 * own function first, then the first match in section order. Null when the
 * rule names no proposed script (`none`, a playbook, or an existing library
 * script id).
 */
export function proposalRefForRule(
  outcome: FleetDesignOutcome,
  action: FleetDesignRule['action'],
  ruleFunctionKey: string,
): string | null {
  if (action === 'none' || action.kind !== 'script') return null;
  let ownFunction: string | null = null;
  let anyFunction: string | null = null;
  for (const entry of outcome.sections.automation) {
    for (const [index, script] of entry.scripts.entries()) {
      const itemRef = automationScriptRef(entry.functionKey, index);
      if (action.ref === itemRef) return itemRef;
      if (action.ref !== script.name) continue;
      if (entry.functionKey === ruleFunctionKey) ownFunction ??= itemRef;
      anyFunction ??= itemRef;
    }
  }
  return ownFunction ?? anyFunction;
}

const CREATED_MARKER = '[script created:';

/**
 * Append the created script's id to a stored rule rationale, once. Alert
 * rules have no binding column for an action (spec §4.3) — this is text for
 * the technician, it wires nothing to run.
 */
export function withScriptCreated(rationale: string, scriptId: string): string {
  if (rationale.includes(CREATED_MARKER)) return rationale;
  return `${rationale} ${CREATED_MARKER} ${scriptId}]`;
}
