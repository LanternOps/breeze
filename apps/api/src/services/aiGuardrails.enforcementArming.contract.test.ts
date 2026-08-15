/**
 * Contract test: an AI tool operation that can ARM unattended enforcement or
 * remediation must require human approval (Tier 3). Issue #3552.
 *
 * The bug this exists to prevent: `manage_software_policies` was registered
 * base Tier 1 with its create/update escalated only to Tier 2 — auto-execute
 * plus an audit row, no approval — while its input schema accepted
 * `enforceMode` and `remediationOptions.autoUninstall`. The AI agent could
 * therefore flip a detect-only software allowlist into fleet-wide
 * auto-uninstall with no human in the loop (the #3381 mass-uninstall failure
 * mode), even though the singular-named sibling writing the SAME table
 * (`manage_software_policy`, aiToolsCompliance.ts) was already Tier 3.
 *
 * The guard is STRUCTURAL rather than a fixed list of tool names, so a future
 * tool cannot reintroduce the gap: any registered tool whose input schema
 * exposes an arming field is swept, on BOTH schema surfaces (the Anthropic
 * definition the model sees and the Zod schema validateToolInput enforces),
 * and every non-read action it accepts must resolve to Tier 3.
 *
 * It fails CLOSED on action naming: only names on the explicit read allowlist
 * are exempt. A new action called `arm`, `apply`, or `enforce` is treated as a
 * mutation and must be gated — the test does not try to guess.
 *
 * No vi.mock: like the sibling guardrail contract suites this needs the REAL
 * aiTools registry, because base tiers are half the answer.
 */
import { describe, it, expect } from 'vitest';
import { checkGuardrails } from './aiGuardrails';
import { getToolTier, getAllRegisteredToolNames, getToolDefinitions } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';

/**
 * Input properties that arm unattended action on real endpoints — the agent
 * subsequently uninstalls, blocks, installs, or reboots WITHOUT a further tool
 * call, so gating the later action is not an option; the arming call is the
 * only chokepoint.
 *
 * Matched case-insensitively against top-level schema property names AND
 * against the documented sub-keys of object-typed properties (the description
 * text is where `remediationOptions.autoUninstall` and `autoApprove.enabled`
 * are actually specified — those properties are free-form objects with no
 * nested JSON Schema to walk).
 *
 * Add to this list when a new "arm it and walk away" input is introduced.
 */
const ARMING_FIELDS = [
  'enforceMode',
  'remediationOptions',
  'autoUninstall',
  'autoApprove',
] as const;

/**
 * Action names that are pure reads and therefore may stay auto-execute even on
 * an arming-capable tool: the field is inert on them. Deliberately short and
 * explicit — anything not listed counts as a mutation.
 */
const READ_ACTIONS = new Set([
  'list', 'get', 'search', 'query', 'status', 'describe', 'preview', 'history',
]);

/** Top-level property names a tool accepts, unioned across both schema surfaces. */
function schemaPropertyNames(toolName: string): string[] {
  const names = new Set<string>();

  const definition = getToolDefinitions().find((d) => d.name === toolName);
  const properties = (definition?.input_schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (properties) for (const key of Object.keys(properties)) names.add(key);

  const shape = (toolInputSchemas[toolName] as { shape?: Record<string, unknown> } | undefined)?.shape;
  if (shape) for (const key of Object.keys(shape)) names.add(key);

  return [...names];
}

/** `{ propertyName: description }` for a tool's JSON-schema properties. */
function schemaPropertyDescriptions(toolName: string): Record<string, string> {
  const definition = getToolDefinitions().find((d) => d.name === toolName);
  const properties = (definition?.input_schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!properties) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    const description = (value as { description?: unknown } | undefined)?.description;
    if (typeof description === 'string') out[key] = description;
  }
  return out;
}

/**
 * The arming fields a tool exposes, each with the actions it applies to.
 *
 * A field is detected either as a top-level property name or as a nested key
 * named in some property's description — `remediationOptions.autoUninstall`
 * and `autoApprove.enabled` live inside free-form `type: 'object'` properties
 * with no nested JSON Schema to walk, so the prose is the only machine-readable
 * record of them.
 *
 * `actions` narrows the field to the operations that can actually carry it,
 * using the repo's "(for <action>)" description convention — e.g.
 * manage_patches' `autoApprove` is documented "(for setup_auto_approval)" and
 * is inert on approve/decline/defer. Narrowing only happens on action names
 * that are REAL enum members of that tool, so a stale or misspelled name in a
 * description cannot silently shrink the sweep; with no recognised name the
 * field applies to every non-read action.
 */
function armingFieldsOf(toolName: string): Array<{ field: string; actions: Set<string> | null }> {
  const propertyNames = new Set(schemaPropertyNames(toolName).map((n) => n.toLowerCase()));
  const descriptions = schemaPropertyDescriptions(toolName);
  const enumActions = new Set(realActionEnum(toolName) ?? []);

  const found: Array<{ field: string; actions: Set<string> | null }> = [];
  for (const field of ARMING_FIELDS) {
    const lower = field.toLowerCase();
    const carriers = Object.entries(descriptions).filter(
      ([key, description]) => key.toLowerCase() === lower || description.toLowerCase().includes(lower),
    );
    if (!propertyNames.has(lower) && carriers.length === 0) continue;

    // Union of real action names named by every property that carries the field.
    const named = new Set<string>();
    for (const [, description] of carriers) {
      for (const action of enumActions) {
        if (new RegExp(`\\b${action}\\b`).test(description)) named.add(action);
      }
    }
    found.push({ field, actions: named.size > 0 ? named : null });
  }
  return found;
}

/** A tool's real action enum, unioned across both schema surfaces; null if not multiplexed. */
function realActionEnum(toolName: string): string[] | null {
  const values = new Set<string>();

  const definition = getToolDefinitions().find((d) => d.name === toolName);
  const properties = (definition?.input_schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const jsonEnum = (properties?.action as { enum?: unknown[] } | undefined)?.enum;
  if (Array.isArray(jsonEnum)) for (const v of jsonEnum) if (typeof v === 'string') values.add(v);

  const zodAction = (toolInputSchemas[toolName] as { shape?: Record<string, unknown> } | undefined)?.shape?.action;
  const zodEnum = (zodAction as { options?: unknown[] } | undefined)?.options;
  if (Array.isArray(zodEnum)) for (const v of zodEnum) if (typeof v === 'string') values.add(v);

  return values.size > 0 ? [...values] : null;
}

/** Tools that expose at least one arming field. */
function armingTools(): Array<{ tool: string; fields: Array<{ field: string; actions: Set<string> | null }> }> {
  return getAllRegisteredToolNames()
    .map((tool) => ({ tool, fields: armingFieldsOf(tool) }))
    .filter((entry) => entry.fields.length > 0);
}

/** The arming fields that action can actually carry. */
function armingFieldsForAction(
  fields: Array<{ field: string; actions: Set<string> | null }>,
  action: string,
): string[] {
  return fields.filter((f) => f.actions === null || f.actions.has(action)).map((f) => f.field);
}

describe('enforcement-arming tools require approval (#3552)', () => {
  it('finds arming tools at all — the sweep is not vacuously empty', () => {
    const tools = armingTools().map((t) => t.tool);
    // The two software-policy tools are the known members; if a refactor
    // renames the arming fields out from under ARMING_FIELDS this trips
    // instead of the whole suite silently passing over an empty set.
    expect(tools).toContain('manage_software_policies');
    expect(tools).toContain('manage_software_policy');
    expect(tools.length).toBeGreaterThanOrEqual(2);
  });

  it('nested arming keys are detected through free-form object properties', () => {
    // remediationOptions.autoUninstall has no nested JSON Schema — it is only
    // named in the property description. If that detection path breaks, the
    // #3552 field itself stops being swept.
    const fields = armingFieldsOf('manage_software_policies').map((f) => f.field);
    expect(fields).toContain('enforceMode');
    expect(fields).toContain('autoUninstall');
  });

  it('action narrowing uses only real enum members', () => {
    // manage_patches' autoApprove is documented "(for setup_auto_approval)" —
    // it must narrow to that action and not fan out over approve/decline/defer.
    const autoApprove = armingFieldsOf('manage_patches').find((f) => f.field === 'autoApprove');
    expect(autoApprove, 'manage_patches must still be detected as arming-capable').toBeDefined();
    expect([...(autoApprove!.actions ?? [])]).toEqual(['setup_auto_approval']);
  });

  it('no arming-capable mutation is auto-executable — every one resolves to Tier 3', () => {
    const violations: string[] = [];

    for (const { tool, fields } of armingTools()) {
      const actions = realActionEnum(tool);

      if (actions === null) {
        // Not action-multiplexed: the whole tool must be base Tier 3 (or 4).
        const tier = getToolTier(tool);
        if (tier === undefined || tier < 3) {
          const names = fields.map((f) => f.field).join('/');
          violations.push(`${tool} (no action enum, arms ${names}) → base tier ${tier}, expected >= 3`);
        }
        continue;
      }

      for (const action of actions) {
        if (READ_ACTIONS.has(action)) continue;
        const carried = armingFieldsForAction(fields, action);
        if (carried.length === 0) continue;
        // Pass the arming fields in the input: a tool whose scope/tier is
        // input-aware must see the same payload a real arming call carries.
        const input: Record<string, unknown> = { action };
        for (const field of carried) input[field] = true;

        const check = checkGuardrails(tool, input);
        if (check.tier !== 3 || !check.requiresApproval) {
          violations.push(
            `${tool}:${action} (arms ${carried.join('/')}) → tier ${check.tier}, ` +
            `requiresApproval=${check.requiresApproval}; expected tier 3 + approval`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('reads on arming-capable tools still auto-execute (no approval fatigue)', () => {
    for (const { tool } of armingTools()) {
      for (const action of realActionEnum(tool) ?? []) {
        if (!READ_ACTIONS.has(action)) continue;
        if ((getToolTier(tool) ?? 1) >= 3) continue; // base-Tier-3 tools gate reads by design
        const check = checkGuardrails(tool, { action });
        expect(
          { tool, action, requiresApproval: check.requiresApproval },
          `${tool}:${action} is a read and must not prompt`,
        ).toMatchObject({ requiresApproval: false });
      }
    }
  });
});

describe('policy-prerequisite mutators are Tier 3 supervised (#3552)', () => {
  const RETIERED = [
    'manage_software_policies',
    'manage_update_rings',
    'manage_peripheral_policies',
  ] as const;

  it.each(RETIERED)('%s create/update requires supervised approval', (tool) => {
    for (const action of ['create', 'update']) {
      const check = checkGuardrails(tool, { action, name: 'p' });
      expect(check.tier, `${tool}:${action}`).toBe(3);
      expect(check.requiresApproval, `${tool}:${action}`).toBe(true);
      expect(check.tier === 3 ? check.approvalScope : undefined, `${tool}:${action}`).toBe('supervised');
    }
  });

  it.each(RETIERED)('%s list/get still auto-execute at Tier 1', (tool) => {
    for (const action of ['list', 'get']) {
      const check = checkGuardrails(tool, { action });
      expect(check.tier, `${tool}:${action}`).toBe(1);
      expect(check.requiresApproval, `${tool}:${action}`).toBe(false);
    }
  });

  it('the specific #3552 payload — enforceMode + autoUninstall — is gated', () => {
    const check = checkGuardrails('manage_software_policies', {
      action: 'update',
      policyId: '00000000-0000-4000-8000-000000000000',
      enforceMode: true,
      remediationOptions: { autoUninstall: true },
    });
    expect(check.tier).toBe(3);
    expect(check.requiresApproval).toBe(true);
  });

  it('backup prereq tools are deliberately left at Tier 2 — change this consciously', () => {
    // Documented judgment call in TIER3_ACTIONS: backup config/profile writes
    // are protective scheduling, not enforcement. Pinned so a later decision to
    // escalate them is an explicit edit here, not a silent drift.
    for (const tool of ['manage_backup_configs', 'manage_backup_profiles']) {
      const check = checkGuardrails(tool, { action: 'update' });
      expect(check.tier, tool).toBe(2);
      expect(check.requiresApproval, tool).toBe(false);
    }
  });
});
