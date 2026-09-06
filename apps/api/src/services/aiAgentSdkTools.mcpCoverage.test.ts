import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import { z } from 'zod';

import { TOOL_TIERS, createBreezeMcpServer } from './aiAgentSdkTools';
import { aiTools } from './aiTools';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';
import { TIER3_ACTIONS } from './aiGuardrails';
import { CONFIG_FEATURE_TYPES } from './configFeatureTypes';

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
 * The step BEFORE the coverage guard at the top of this file. `TOOL_TIERS` is
 * the gate: `createSessionPreToolUse` rejects a tool with no tier as "Unknown
 * tool", and `BREEZE_MCP_TOOL_NAMES` is derived from `TOOL_TIERS`. A tool wired
 * into `aiTools` + `toolInputSchemas` + `TOOL_PERMISSIONS` but NOT into
 * `TOOL_TIERS` is therefore invisible AND uncallable — and the three tests above
 * cannot see it, because they only ever iterate `TOOL_TIERS` itself.
 *
 * That is exactly how the two fleet-hygiene tools shipped: registered, schema'd
 * and permissioned, absent from `TOOL_TIERS`, so the chat model never saw them
 * and every suite stayed green.
 *
 * A blanket `aiTools` -> `TOOL_TIERS` parity assertion is NOT possible today:
 * ~85 registry tools (the backup/MSSQL/Hyper-V/vault/C2C/DR family, the m365
 * and google executors, `get_network_changes` and friends) have no `TOOL_TIERS`
 * entry, which is a real pre-existing gap far wider than this file's scope.
 * Pinning the family end-to-end — the same shape as the `#2605` vulnerability
 * block below — is the assertion that actually holds.
 */
const FLEET_HYGIENE_TOOLS = ['get_fleet_findings', 'analyze_fleet_metrics'] as const;

describe('fleet hygiene tools reach the chat model (registry -> TOOL_TIERS -> tool())', () => {
  it.each(FLEET_HYGIENE_TOOLS)('%s is in the aiTools execution registry', (name) => {
    expect(aiTools.has(name)).toBe(true);
  });

  it.each(FLEET_HYGIENE_TOOLS)('%s has a TOOL_TIERS entry', (name) => {
    expect(
      (TOOL_TIERS as Record<string, number>)[name],
      `${name} is registered but untiered — createSessionPreToolUse rejects it as "Unknown tool"`,
    ).toBeDefined();
  });

  it.each(FLEET_HYGIENE_TOOLS)('%s is declared in createBreezeMcpServer', (name) => {
    expect(declaredToolNames().has(name), `tool('${name}', ...) missing`).toBe(true);
  });

  it.each(FLEET_HYGIENE_TOOLS)('%s advertises exactly the keys it validates', (name) => {
    const advertised = Object.keys(
      aiTools.get(name)!.definition.input_schema.properties as Record<string, unknown>,
    ).sort();
    const enforced = Object.keys(
      (toolInputSchemas[name] as z.ZodObject<z.ZodRawShape>).shape,
    ).sort();
    expect(enforced).toEqual(advertised);
  });
});

/**
 * Registration is necessary but NOT sufficient (#2814). A tool the model can
 * see still fails on every call if the downstream gates don't know it:
 * `validateToolInput` rejects a tool with no `toolInputSchemas` entry, and
 * `checkToolPermission` fails closed with no `TOOL_PERMISSIONS` entry. Both
 * denials reach the model as an ordinary tool error, so the symptom is
 * identical to #2605 — it quietly falls back to a neighbouring tool.
 *
 * Those two gates are asserted registry-wide in `aiToolsRegistryParity.test.ts`
 * (which covers the session-aware tools this file's source regexes would miss),
 * so they are deliberately NOT re-asserted here. What that suite cannot see is
 * whether the shapes AGREE — which is the drift below.
 *
 * `manage_policy_feature_link` is the cautionary case: its `toolInputSchemas`
 * enum sat four values behind the enum its own `input_schema` advertised, so
 * `remote_access` / `pam` / `onedrive_helper` / `vulnerability` were documented
 * and DB-valid yet rejected at the gate. Key-level drift is worse still,
 * because `z.object()` STRIPS unknown keys rather than rejecting: a renamed
 * field vanishes silently, the write lands with defaults, and the tool reports
 * success. This test pins the advertised contract to the enforced one.
 */
const CONFIG_POLICY_TOOLS = [
  'manage_policy_feature_link',
  'manage_update_rings',
  'manage_software_policies',
  'manage_peripheral_policies',
  'manage_backup_configs',
] as const;

/** The prerequisite policies a feature link points at via `featurePolicyId`. */
const PREREQUISITE_TOOLS = CONFIG_POLICY_TOOLS.filter(
  (name) => name !== 'manage_policy_feature_link',
);

/**
 * `manage_organizations` joins the list for #3258 W02, which added the SAME six
 * contact fields (siteId, phone, mobile, title, roles, isPrimary) BY HAND in
 * three separate places — the Anthropic `input_schema.properties` in
 * aiToolsOrgs.ts, `toolInputSchemas` in aiToolSchemas.ts, and the SDK `tool()`
 * zod shape in aiAgentSdkTools.ts. All three strip rather than reject, so a
 * field missed in any one of them vanishes on the way to `createContact` and
 * the tool still reports success: an `isPrimary: true` the model was told to
 * send would silently create an ordinary contact.
 */
const KEY_PARITY_TOOLS = [...CONFIG_POLICY_TOOLS, 'manage_organizations'] as const;

/** The six fields #3258 W02 added to all three declarations at once. */
const CONTACT_FIELDS = ['siteId', 'phone', 'mobile', 'title', 'roles', 'isPrimary'] as const;

let sdkServer: ReturnType<typeof createBreezeMcpServer> | undefined;

/**
 * The zod shape a tool was actually registered with inside
 * `createBreezeMcpServer`. Unlike the other two sources this one is not an
 * exported object: it only exists on the built MCP server, so the test reaches
 * through the SDK's `_registeredTools` map. That is a private field, but the
 * alternative — regexing the shape literal out of the source, as
 * `declaredDescription` does for the description — cannot see what the SDK
 * ended up registering, which is the thing that governs at runtime.
 */
function sdkDeclaredKeys(name: string): string[] {
  sdkServer ??= createBreezeMcpServer(() => ({}) as never);
  const registered = (sdkServer as unknown as {
    instance?: { _registeredTools?: Record<string, { inputSchema?: z.ZodObject<z.ZodRawShape> }> };
  }).instance?._registeredTools?.[name];
  const shape = registered?.inputSchema?.shape;
  if (!shape) throw new Error(`tool('${name}', ...) registered no zod shape on the SDK server`);
  return Object.keys(shape).sort();
}

describe('advertised input_schema matches the enforced Zod schema (#2814)', () => {
  it.each(KEY_PARITY_TOOLS)('%s advertises exactly the keys it validates', (name) => {
    const advertised = Object.keys(
      aiTools.get(name)!.definition.input_schema.properties as Record<string, unknown>,
    ).sort();
    const enforced = Object.keys(
      (toolInputSchemas[name] as z.ZodObject<z.ZodRawShape>).shape,
    ).sort();
    expect(
      enforced,
      'a key the model is told to send but Zod does not know is stripped silently — the write '
        + 'lands with defaults and the tool still reports success',
    ).toEqual(advertised);
  });

  it('manage_organizations declares the same keys in the SDK tool() shape as in the other two', () => {
    // The third hand-maintained copy. `z.object()` STRIPS unknown keys, so a
    // field present in the registry definition and in toolInputSchemas but
    // missing here is dropped between the model and the handler with no error
    // anywhere — the exact silent-success failure #2814 documents, on a tool
    // that writes customer PII and can replace an organization's billing
    // contact (#3258 W02).
    const declared = sdkDeclaredKeys('manage_organizations');
    const advertised = Object.keys(
      aiTools.get('manage_organizations')!.definition.input_schema.properties as Record<string, unknown>,
    ).sort();
    const enforced = Object.keys(
      (toolInputSchemas.manage_organizations as z.ZodObject<z.ZodRawShape>).shape,
    ).sort();

    expect(declared).toEqual(advertised);
    expect(declared).toEqual(enforced);
    // Named explicitly so a drop reads as "the contact fields went missing"
    // rather than as an opaque array diff.
    for (const field of CONTACT_FIELDS) {
      expect(declared, `SDK tool() shape is missing ${field}`).toContain(field);
      expect(advertised, `input_schema is missing ${field}`).toContain(field);
      expect(enforced, `toolInputSchemas is missing ${field}`).toContain(field);
    }
  });
});

/**
 * MCP discovery consequence of #3258 W02, pinned deliberately.
 *
 * `isToolWhollyGatedOverMcp` (routes/mcpServer.ts) suppresses a tool from
 * `tools/list` when EVERY value of its `action` enum is in `TIER3_ACTIONS`:
 * MCP has no interactive approval channel, so such a tool could only ever
 * answer MCP_APPROVAL_REQUIRED, and advertising it would be the
 * "advertised-but-dead" pattern that suppression exists to eliminate. Adding
 * `add_contact` to TIER3_ACTIONS made all four manage_organizations actions
 * Tier 3, so the whole tool is now hidden from MCP clients and every MCP call
 * to it is refused — correct, and a deliberate loss of MCP reach that should
 * be re-decided (not silently reversed) the day a sub-Tier-3 action is added.
 *
 * The behaviour itself is asserted through the real listing path in
 * routes/mcpServer.approvalGate.test.ts. THIS assertion is the half that suite
 * cannot make: it mocks the tool registry, so only here — against the real
 * definition — can the advertised enum be compared with TIER3_ACTIONS.
 */
describe('manage_organizations is wholly gated over MCP (#3258 W02)', () => {
  it('every advertised action is Tier 3, which is what removes it from tools/list', () => {
    const advertisedActions = (
      aiTools.get('manage_organizations')!.definition.input_schema.properties as {
        action?: { enum?: string[] };
      }
    ).action?.enum;
    expect(advertisedActions, 'manage_organizations must stay action-multiplexed').toBeDefined();

    const tier3 = TIER3_ACTIONS.manage_organizations ?? [];
    expect(advertisedActions).toContain('add_contact');
    for (const action of advertisedActions!) {
      expect(
        tier3,
        `"${action}" is not in TIER3_ACTIONS, so manage_organizations is NO LONGER wholly gated `
          + 'over MCP: it returns to tools/list and that action becomes callable without approval. '
          + 'That may be the intent — update this test and the MCP listing test together if so.',
      ).toContain(action);
    }
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
  it('createBreezeMcpServer constructs — registryDescription throws at build time', () => {
    // Nothing else in the suite ever BUILDS the server (the only other
    // reference is a vi.fn() mock in streamingSessionManager.clientLoop.test.ts),
    // so this is the sole direct cover for the throw path — which would fail
    // every chat request, not one tool call. Also cheap cover for the other
    // ~120 declarations against a malformed shape.
    expect(() => createBreezeMcpServer(() => ({}) as never)).not.toThrow();
  });

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
    for (const name of PREREQUISITE_TOOLS) {
      expect(
        aiTools.get(name)!.definition.description,
        `${name} should point back at manage_policy_feature_link`,
      ).toContain('manage_policy_feature_link');
    }
  });
});

/**
 * Bounds the model cannot infer from the advertised schema. Each of these
 * previously passed Zod and died in Postgres, surfacing to the model as a
 * sanitized driver error it has no way to act on.
 */
describe('prerequisite tool bounds match the columns behind them (#2814)', () => {
  const overLength = 'x'.repeat(201);

  it.each([
    ['manage_software_policies', { action: 'create', mode: 'blocklist' }],
    ['manage_peripheral_policies', { action: 'create', deviceClass: 'storage', action_type: 'block' }],
    ['manage_backup_configs', { action: 'create', type: 'file', provider: 'local' }],
  ] as const)('%s rejects a name longer than its varchar(200) column', (name, base) => {
    const result = validateToolInput(name, { ...base, name: overLength });
    expect(result.success, 'a 201-char name reaches Postgres as 22001').toBe(false);
    expect(validateToolInput(name, { ...base, name: 'x'.repeat(200) }).success).toBe(true);
  });

  it('manage_update_rings neither advertises nor validates the deprecated sources column', () => {
    // `patch_policies.sources` is deprecated (#3150): the handler never writes
    // it and `get` strips it from responses. The tool definition must not
    // re-advertise it (the model would send values the DB rejects as 22P02,
    // which safeHandler reports as "Invalid ID format — expected a valid
    // UUID"), and the Zod gate must not fail a legacy caller that still sends
    // it — the unknown key is stripped, never forwarded.
    const def = aiTools.get('manage_update_rings')?.definition;
    expect(def).toBeDefined();
    const properties = (def!.input_schema as { properties: Record<string, unknown> }).properties;
    expect(properties).not.toHaveProperty('sources');
    expect(toolInputSchemas['manage_update_rings']).toBeDefined();
    expect(validateToolInput('manage_update_rings', {
      action: 'create', name: 'Ring', sources: ['os'],
    }).success).toBe(true);
  });

  it('manage_policy_feature_link accepts every DB-valid feature type', () => {
    for (const featureType of CONFIG_FEATURE_TYPES) {
      expect(
        validateToolInput('manage_policy_feature_link', {
          action: 'add',
          configPolicyId: '00000000-0000-4000-8000-000000000000',
          featureType,
        }).success,
        `featureType "${featureType}" is in config_feature_type but rejected at the gate`,
      ).toBe(true);
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

/**
 * #3485: get_quote gained block-pagination params, but the model only sees the
 * shape declared in `tool('get_quote', ...)` inside createBreezeMcpServer. If
 * that shape drifts from the canonical `toolInputSchemas` entry, the SDK strips
 * the new params before the handler runs — the exact gap that shipped here.
 */
describe("get_quote's MCP declaration matches its canonical schema (#3485)", () => {
  it('declares exactly the params the canonical get_quote schema validates', () => {
    // Extract just the shape object — the 3rd argument to tool() — between the
    // description and makeHandler, so comments/description text can't be mistaken
    // for a declared key.
    const shape = SOURCE.match(
      /tool\(\s*'get_quote',[\s\S]*?registryDescription\('get_quote'\),[\s\S]*?\{([\s\S]*?)\},\s*makeHandler\('get_quote'/,
    );
    expect(shape, "tool('get_quote', registryDescription(...), { ... }) not found").not.toBeNull();
    const shapeBody = (shape![1] ?? '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    const declaredKeys = [...shapeBody.matchAll(/^\s*(\w+):/gm)]
      .map((m) => m[1])
      .filter((k): k is string => k !== undefined)
      .sort();

    const canonicalKeys = Object.keys(
      (toolInputSchemas['get_quote'] as z.ZodObject<z.ZodRawShape>).shape,
    );
    // Sanity: the canonical schema really did gain the pagination params (#3485).
    expect(canonicalKeys).toEqual(
      expect.arrayContaining(['quoteId', 'blocksOffset', 'blocksLimit', 'includeBlockContent']),
    );
    // Exact, bidirectional parity: the MCP declaration must not drift from the
    // canonical schema in EITHER direction (a param the SDK strips, or one it
    // advertises that nothing validates).
    expect(declaredKeys).toEqual([...canonicalKeys].sort());
  });
});
