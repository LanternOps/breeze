import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import { TOOL_TIERS } from './aiAgentSdkTools';

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
 * All nine below are reachable only from the script-builder MCP server or not at
 * all; the policy-prerequisite four are a genuine gap of the same family as
 * #2605 (the system prompt tells the model to call manage_policy_feature_link /
 * manage_update_rings) and are tracked separately rather than widened into this
 * PR.
 */
const NOT_IN_BREEZE_MCP_SERVER: Record<string, string> = {
  // Exposed by the separate `script_builder` SDK MCP server (scriptBuilderTools.ts).
  list_scripts: 'script_builder MCP server',
  get_script_details: 'script_builder MCP server',
  list_script_templates: 'script_builder MCP server',
  get_script_execution_history: 'script_builder MCP server',
  // Known gap — same shape as #2605, tracked separately.
  manage_policy_feature_link: 'unregistered (known gap)',
  manage_update_rings: 'unregistered (known gap)',
  manage_software_policies: 'unregistered (known gap)',
  manage_peripheral_policies: 'unregistered (known gap)',
  manage_backup_configs: 'unregistered (known gap)',
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
