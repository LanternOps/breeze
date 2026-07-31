import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import { TOOL_TIERS } from './aiAgentSdkTools';
import { aiTools } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS } from './aiGuardrails';

/**
 * MCP registration coverage guard (#2605).
 *
 * The in-product technician chat attaches exactly ONE MCP server — the one
 * built by `createBreezeMcpServer` — and the model only ever sees the tools
 * declared there via `tool(name, description, shape, handler)`. Being present in
 * the `aiTools` execution registry, in `TOOL_PERMISSIONS`, in `toolInputSchemas`
 * and in `TOOL_TIERS` is NOT enough: `BREEZE_MCP_TOOL_NAMES` is derived from
 * `TOOL_TIERS`, so an unregistered tool is silently allowlisted as
 * `mcp__breeze__<name>` while no such tool exists. The model cannot call it and
 * cannot report that it is missing — it just picks a neighbouring tool.
 *
 * That is exactly how #2605 happened: the three BE-16 vulnerability tools were
 * wired everywhere except `createBreezeMcpServer`, so every CVE question got
 * answered out of `get_security_posture` / `manage_patches`. No test failed.
 *
 * These tests read the real source (never a hardcoded copy of the tool list) so
 * the next missed registration fails here instead of shipping as "the model
 * never picks that tool".
 */

const SOURCE = readFileSync(new URL('./aiAgentSdkTools.ts', import.meta.url), 'utf8');

/** Tool names declared via `tool('<name>', ...)` anywhere in the SDK tool file. */
function declaredToolNames(): Set<string> {
  // `m[1]` is typed `string | undefined` because capture groups are optional in
  // general; group 1 is non-optional in this pattern, so a match always has it.
  return new Set(Array.from(SOURCE.matchAll(/\btool\(\s*'([a-z0-9_]+)'/g), (m) => m[1]!));
}

/** The description literal passed as the second argument of `tool('<name>', '<description>')`. */
function declaredDescription(name: string): string {
  const pattern = new RegExp(
    `\\btool\\(\\s*'${name}',\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`,
  );
  const match = pattern.exec(SOURCE);
  if (!match) throw new Error(`tool('${name}', ...) is not declared in aiAgentSdkTools.ts`);
  return (match[1] ?? match[2] ?? '').replace(/\\(['"\\])/g, '$1');
}

/**
 * Tools that are in `TOOL_TIERS` but intentionally NOT declared in
 * `createBreezeMcpServer`, with the reason. Anything not listed here must be
 * declared. Remove an entry when the tool gets registered — the last test in
 * this file fails on stale entries so the list cannot rot.
 *
 * The four below are reachable only from the script-builder MCP server. The
 * five configuration-policy tools that used to sit here (#2814 — the same
 * family as #2605) are now declared in `createBreezeMcpServer`, so their
 * entries are gone: the third test in this describe fails on a stale entry, so
 * this list cannot silently outlive the gap it documents.
 */
const NOT_IN_BREEZE_MCP_SERVER: Record<string, string> = {
  // Exposed by the separate `script_builder` SDK MCP server (scriptBuilderTools.ts).
  list_scripts: 'script_builder MCP server',
  get_script_details: 'script_builder MCP server',
  list_script_templates: 'script_builder MCP server',
  get_script_execution_history: 'script_builder MCP server',
};

describe('createBreezeMcpServer tool coverage vs TOOL_TIERS', () => {
  it('declares every TOOL_TIERS tool except the documented exceptions', () => {
    const declared = declaredToolNames();
    const missing = Object.keys(TOOL_TIERS).filter(
      (name) => !declared.has(name) && !(name in NOT_IN_BREEZE_MCP_SERVER),
    );
    expect(
      missing,
      'these tools are allowlisted via TOOL_TIERS/BREEZE_MCP_TOOL_NAMES but have no tool() '
        + 'declaration, so the chat model can never call them (see #2605)',
    ).toEqual([]);
  });

  it('declares no tool that is missing from TOOL_TIERS (would be rejected by the tier gate)', () => {
    const unknown = Array.from(declaredToolNames()).filter(
      (name) => !(name in (TOOL_TIERS as Record<string, number>)),
    );
    expect(unknown).toEqual([]);
  });

  it('keeps the exception list honest — every entry is still undeclared', () => {
    const declared = declaredToolNames();
    const stale = Object.keys(NOT_IN_BREEZE_MCP_SERVER).filter((name) => declared.has(name));
    expect(
      stale,
      'these tools are now declared in createBreezeMcpServer — drop them from NOT_IN_BREEZE_MCP_SERVER',
    ).toEqual([]);
  });
});

/**
 * Registration is necessary but NOT sufficient (#2814). A tool the model can
 * see still fails on every call if the downstream gates don't know it:
 *
 *  - `executeTool` runs `validateToolInput`, which REJECTS a tool with no entry
 *    in `toolInputSchemas` ("No input schema registered for tool ...").
 *  - `checkToolPermission` fails closed with "No RBAC permission mapping for
 *    tool ..." when `TOOL_PERMISSIONS` has no entry.
 *
 * Both denials come back to the model as an ordinary tool error, so the symptom
 * is identical to #2605: the model quietly falls back to a neighbouring tool.
 * All four of `manage_update_rings` / `manage_software_policies` /
 * `manage_peripheral_policies` / `manage_backup_configs` were missing BOTH
 * while sitting in `TOOL_TIERS`, which also made them dead on the external
 * `/api/v1/mcp` server, where they have always been advertised.
 *
 * Scoped to `makeHandler(...)`-routed declarations: that is the wrapper that
 * runs onPreToolUse (RBAC) and dispatches into `executeTool` (Zod). The
 * directly-handled m365_* / google_* declarations bypass both by design and
 * carry their own validation, so neither gate applies to them.
 */

/** Tool names dispatched through `makeHandler('<name>', ...)`. */
function makeHandlerToolNames(): string[] {
  return Array.from(
    new Set(Array.from(SOURCE.matchAll(/\bmakeHandler\(\s*'([a-z0-9_]+)'/g), (m) => m[1]!)),
  );
}

/**
 * Pre-existing RBAC-mapping gaps, unrelated to the configuration-policy family
 * this guard was extended for. Each is a live instance of the same defect —
 * `checkToolPermission` denies every call for any caller with a role — but
 * picking the right `{ resource, action }` for each is a judgement call that
 * belongs in its own change. Recorded here so the guard stays green on today's
 * state while failing on any NEW offender; the stale check below removes an
 * entry's cover the moment it gets mapped.
 */
const KNOWN_MISSING_TOOL_PERMISSIONS = [
  'get_active_users',
  'get_user_experience_metrics',
  'get_dns_security',
  'manage_dns_policy',
];

describe('declared tools are wired end to end, not just visible', () => {
  it('every makeHandler-routed tool has a toolInputSchemas entry', () => {
    const missing = makeHandlerToolNames().filter((name) => !toolInputSchemas[name]);
    expect(
      missing,
      'validateToolInput rejects these with "No input schema registered", so the model sees an '
        + 'error on every call and silently substitutes another tool',
    ).toEqual([]);
  });

  it('every makeHandler-routed tool has a TOOL_PERMISSIONS entry', () => {
    const missing = makeHandlerToolNames().filter(
      (name) => !TOOL_PERMISSIONS[name] && !KNOWN_MISSING_TOOL_PERMISSIONS.includes(name),
    );
    expect(
      missing,
      'checkToolPermission fails closed with "No RBAC permission mapping" for these',
    ).toEqual([]);
  });

  it('keeps KNOWN_MISSING_TOOL_PERMISSIONS honest — every entry is still unmapped', () => {
    const stale = KNOWN_MISSING_TOOL_PERMISSIONS.filter((name) => TOOL_PERMISSIONS[name]);
    expect(
      stale,
      'these now have a TOOL_PERMISSIONS mapping — drop them from KNOWN_MISSING_TOOL_PERMISSIONS',
    ).toEqual([]);
  });
});

/**
 * The configuration-policy family takes its `tool()` description from the
 * `aiTools` registry (`registryDescription`) instead of a second inline literal,
 * because `manage_policy_feature_link`'s description IS the reference for every
 * feature type's `inlineSettings` shape. `registryDescription` throws when a
 * name is absent from the registry, which is the single way that indirection
 * can fail — so assert the registry actually answers for all five.
 */
describe('registry-sourced tool descriptions resolve (#2814)', () => {
  const CONFIG_POLICY_TOOLS = [
    'manage_policy_feature_link',
    'manage_update_rings',
    'manage_software_policies',
    'manage_peripheral_policies',
    'manage_backup_configs',
  ];

  it('every registry-sourced description resolves to non-empty text', () => {
    for (const name of CONFIG_POLICY_TOOLS) {
      const description = aiTools.get(name)?.definition.description;
      expect(description, `aiTools registry has no description for "${name}"`).toBeTruthy();
    }
  });

  it('the feature-link tool advertises featurePolicyId and the prerequisite workflow', () => {
    // The three-step workflow in aiAgentSystemPrompt.ts (:60-64) is only
    // followable if the model is told how a prerequisite policy attaches.
    const description = aiTools.get('manage_policy_feature_link')!.definition.description;
    expect(description).toContain('featurePolicyId');
    expect(description).toContain('inlineSettings');
    for (const name of CONFIG_POLICY_TOOLS.slice(1)) {
      expect(
        aiTools.get(name)!.definition.description,
        `${name} should point back at manage_policy_feature_link`,
      ).toContain('manage_policy_feature_link');
    }
  });
});

describe('vulnerability tools reach the chat model (#2605)', () => {
  const VULN_TOOLS = ['get_vulnerability_report', 'get_device_vulnerabilities', 'remediate_vulnerability'];

  it('all three BE-16 vulnerability tools are declared in the breeze MCP server', () => {
    const declared = declaredToolNames();
    for (const name of VULN_TOOLS) {
      expect(declared.has(name), `tool('${name}', ...) missing from createBreezeMcpServer`).toBe(true);
    }
  });

  it('none of them is on the exception list', () => {
    for (const name of VULN_TOOLS) {
      expect(name in NOT_IN_BREEZE_MCP_SERVER).toBe(false);
    }
  });

  it('the read tools claim CVE vocabulary and disclaim the posture/patch tools', () => {
    for (const name of ['get_vulnerability_report', 'get_device_vulnerabilities']) {
      const description = declaredDescription(name);
      expect(description).toContain('CVE');
      expect(description.toLowerCase()).toContain('vulnerabilit');
      expect(description).toContain('get_security_posture');
      expect(description).toContain('manage_patches');
    }
  });

  it('get_security_posture points CVE questions at the vulnerability tools', () => {
    const description = declaredDescription('get_security_posture');
    expect(description).toContain('get_vulnerability_report');
    expect(description).toContain('get_device_vulnerabilities');
  });
});
