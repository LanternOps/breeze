/**
 * Contract test for the tier-3 supervised/four_eyes approval-scope split
 * (2026-08-05 tier3-supervised-four-eyes design, §3.1).
 *
 * Modeled on aiGuardrails.readonly.contract.test.ts: no vi.mock — this suite
 * needs the REAL aiTools registry, because base tiers are half the answer.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { ExtensionManifestV1 } from '@breeze/extension-sdk';
import {
  TIER1_ACTIONS, TIER2_ACTIONS,
  TIER3_ACTIONS, TIER3_FOUR_EYES_ACTIONS, TIER3_FOUR_EYES_TOOLS,
  TIER3_SUPERVISED_ACTIONS, TIER3_SUPERVISED_TOOLS,
  TIER3_INPUT_AWARE_ACTIONS, TIER3_INPUT_AWARE_TOOLS,
  TOOL_ACTION_INPUT_KEYS,
  checkGuardrails, resolveApprovalScope,
} from './aiGuardrails';
import { getToolTier, getAllRegisteredToolNames, getToolDefinitions } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { ExtensionContributionRegistry } from '../extensions/contributionRegistry';

/** (tool, action) pairs from a scope table, flattened with their expected scope. */
function scopeTablePairs(): Array<{ tool: string; action: string; scope: 'four_eyes' | 'supervised' }> {
  const pairs: Array<{ tool: string; action: string; scope: 'four_eyes' | 'supervised' }> = [];
  for (const [tool, actions] of Object.entries(TIER3_FOUR_EYES_ACTIONS)) {
    for (const action of actions) pairs.push({ tool, action, scope: 'four_eyes' });
  }
  for (const [tool, actions] of Object.entries(TIER3_SUPERVISED_ACTIONS)) {
    for (const action of actions) pairs.push({ tool, action, scope: 'supervised' });
  }
  return pairs;
}

/**
 * A tool's REAL action enum, from the two places an action string can enter the
 * system: the Anthropic tool definition the model is shown, and the Zod schema
 * validateToolInput enforces. Unioned, so a new member added to EITHER source
 * is caught. Returns null for a tool that is not action-multiplexed.
 */
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

/** Every action of `tool` that any tier table classifies explicitly. */
function explicitlyClassifiedActions(tool: string): Set<string> {
  return new Set([
    ...(TIER1_ACTIONS[tool] ?? []),
    ...(TIER2_ACTIONS[tool] ?? []),
    ...(TIER3_FOUR_EYES_ACTIONS[tool] ?? []),
    ...(TIER3_SUPERVISED_ACTIONS[tool] ?? []),
  ]);
}

/**
 * Tools that are BOTH per-action classified and members of a whole-tool scope
 * set. For these the whole-tool set is a backstop, not the classifier: an
 * unlisted action falls past both *_ACTIONS lookups onto the whole-tool line —
 * which for TIER3_SUPERVISED_TOOLS members yields the WEAKER scope, not the
 * four_eyes fail-safe. Computed, not hard-coded, so a future tool that grows a
 * per-action table is picked up automatically.
 */
function multiplexedBackstopTools(): string[] {
  return [...TIER3_FOUR_EYES_TOOLS, ...TIER3_SUPERVISED_TOOLS].filter(
    (tool) =>
      (TIER3_FOUR_EYES_ACTIONS[tool]?.length ?? 0) > 0 ||
      (TIER3_SUPERVISED_ACTIONS[tool]?.length ?? 0) > 0,
  );
}

describe('tier-3 approval scope classification', () => {
  it('classifies every per-action tier-3 pair in exactly one scope', () => {
    for (const [tool, actions] of Object.entries(TIER3_ACTIONS)) {
      for (const action of actions) {
        // Input-aware pairs (e.g. manage_organizations:update_org) are
        // resolved dynamically by resolveApprovalScope's override hooks, not
        // these static tables — covered by their own both-branches tests below.
        if (TIER3_INPUT_AWARE_ACTIONS.has(`${tool}:${action}`)) continue;
        const inFourEyes = TIER3_FOUR_EYES_ACTIONS[tool]?.includes(action) ?? false;
        const inSupervised = TIER3_SUPERVISED_ACTIONS[tool]?.includes(action) ?? false;
        expect(inFourEyes !== inSupervised, `${tool}:${action} must be in exactly one scope table`).toBe(true);
      }
    }
  });

  it('classifies every base-tier-3 tool in exactly one whole-tool scope set', () => {
    for (const tool of getAllRegisteredToolNames()) {
      if (getToolTier(tool) !== 3) continue;
      // Input-aware tools (e.g. s1_isolate_device) are resolved dynamically —
      // covered by their own both-branches tests below.
      if (TIER3_INPUT_AWARE_TOOLS.has(tool)) continue;
      const inFourEyes = TIER3_FOUR_EYES_TOOLS.has(tool);
      const inSupervised = TIER3_SUPERVISED_TOOLS.has(tool);
      expect(inFourEyes !== inSupervised, `${tool} must be in exactly one whole-tool scope set`).toBe(true);
    }
  });

  it('scope tables reference only real tier-3 surfaces', () => {
    // Applied to BOTH tables. A (tool, action) pair is a real tier-3 surface if
    // it escalates via TIER3_ACTIONS, or if the tool's BASE tier is already 3
    // (security_scan's scan/status need no escalation but must still be
    // classified — see the TIER3_SUPERVISED_ACTIONS comment).
    for (const { tool, action, scope } of scopeTablePairs()) {
      const escalated = TIER3_ACTIONS[tool]?.includes(action) ?? false;
      expect(
        escalated || getToolTier(tool) === 3,
        `${scope} entry ${tool}:${action} is not a tier-3 surface`,
      ).toBe(true);
    }
    // ...and to both whole-tool sets: a typo'd or stale entry names a tool that
    // is not registered at tier 3, and nothing else would flag it.
    for (const tool of TIER3_FOUR_EYES_TOOLS) expect(getToolTier(tool), tool).toBe(3);
    for (const tool of TIER3_SUPERVISED_TOOLS) expect(getToolTier(tool), tool).toBe(3);
  });

  it('every scope-table entry actually resolves to that scope at tier 3', () => {
    // End-to-end: proves the entry takes effect, not merely that it is spelled
    // like a real surface. Catches an entry shadowed by a TIER1/TIER2
    // downgrade, or one on a tool whose action discriminator is not `action`.
    for (const { tool, action, scope } of scopeTablePairs()) {
      const actionKey = TOOL_ACTION_INPUT_KEYS[tool] ?? 'action';
      const check = checkGuardrails(tool, { [actionKey]: action });
      expect(check.tier, `${tool}:${action}`).toBe(3);
      expect(check.approvalScope, `${tool}:${action}`).toBe(scope);
    }
  });

  it('action-multiplexed tools in a whole-tool scope set enumerate every action', () => {
    // FAIL-OPEN GUARD. The four_eyes fail-safe is per-TOOL: resolveApprovalScope
    // returns four_eyes only for a tool in neither whole-tool set. A tool in
    // TIER3_SUPERVISED_TOOLS short-circuits there, so any action of it that no
    // *_ACTIONS table lists lands on `supervised` — the weaker scope. Adding
    // e.g. security_scan:'wipe_quarantine' to the handler enum without
    // classifying it would silently self-approve; this test is what stops that.
    const covered = multiplexedBackstopTools();
    // Pin the discovery itself: if the enum reflection silently stops working,
    // this suite would go vacuously green.
    expect(covered.length, 'no multiplexed whole-tool members discovered').toBeGreaterThan(0);

    const enumerated: string[] = [];
    for (const tool of covered) {
      const actions = realActionEnum(tool);
      if (!actions) continue; // whole-tool surface with no `action` enum
      enumerated.push(tool);
      const classified = explicitlyClassifiedActions(tool);
      const inputAware = TIER3_INPUT_AWARE_ACTIONS;
      for (const action of actions) {
        if (inputAware.has(`${tool}:${action}`)) continue;
        expect(
          classified.has(action),
          `${tool}:${action} is in the tool's real action enum but is classified by no tier table — ` +
          `it would fall through to the whole-tool ${TIER3_SUPERVISED_TOOLS.has(tool) ? 'SUPERVISED' : 'four_eyes'} ` +
          `default instead of a decision. Add it to TIER1_ACTIONS, TIER2_ACTIONS, ` +
          `TIER3_SUPERVISED_ACTIONS or TIER3_FOUR_EYES_ACTIONS.`,
        ).toBe(true);
      }
      // Reverse direction — a typo'd table entry for a base-tier-3 tool still
      // "resolves to tier 3" and so escapes every other check here.
      for (const action of classified) {
        expect(
          actions.includes(action),
          `${tool}:${action} is classified in a tier table but is not in the tool's real action enum`,
        ).toBe(true);
      }
    }
    expect(enumerated.sort()).toEqual([
      'manage_ai_agents', 'manage_services', 'manage_startup_items', 's1_threat_action', 'security_scan',
    ]);
  });

  it('exposes both enum sources for every enumerated tool', () => {
    // The union in realActionEnum() is only a real guard while BOTH sources
    // still reflect. If one silently returns nothing, the union quietly shrinks
    // and a new action in that source stops failing CI.
    for (const tool of ['manage_ai_agents', 'manage_services', 'manage_startup_items', 's1_threat_action', 'security_scan']) {
      const definition = getToolDefinitions().find((d) => d.name === tool);
      const properties = (definition?.input_schema as { properties?: Record<string, unknown> } | undefined)?.properties;
      expect((properties?.action as { enum?: unknown[] } | undefined)?.enum, `${tool} tool-definition enum`).toBeInstanceOf(Array);
      const zodAction = (toolInputSchemas[tool] as { shape?: Record<string, unknown> } | undefined)?.shape?.action;
      expect((zodAction as { options?: unknown[] } | undefined)?.options, `${tool} zod enum`).toBeInstanceOf(Array);
    }
  });

  it('defaults unclassified to four_eyes (fail-safe)', () => {
    expect(resolveApprovalScope('some_future_unclassified_tool', undefined, {})).toBe('four_eyes');
  });

  it('an extension tool at tier 3 resolves four_eyes via the fail-safe', () => {
    // Extension tools are per-tenant/dynamic and deliberately excluded from
    // getAllRegisteredToolNames(), so the "classified in exactly one whole-tool
    // set" contract above can never see them — they rely entirely on the
    // fail-safe. Nothing pinned that before.
    const toolName = 'demo_ext_tier3_tool';
    const manifest: ExtensionManifestV1 = {
      apiVersion: 'breeze.extensions/v1',
      name: 'demo',
      version: '1.0.0',
      routeNamespace: 'demo',
      requires: { breeze: '>=1.0.0', serverSdk: '^1.0.0', capabilities: [] },
      server: { entry: 'dist/server.js' },
      migrationsDir: 'migrations',
      schemaCompatibilityFloor: '1.0.0',
      jobs: [],
      aiTools: [{ name: toolName }],
      tenancy: { orgCascadeDeleteTables: [], deviceCascadeDeleteTables: [], deviceOrgDenormalizedTables: [] },
    };
    const registry = new ExtensionContributionRegistry();
    const session = registry.begin(manifest);
    session.registrar.mountRoute(new Hono());
    session.registrar.registerAiTool(toolName, {
      definition: { name: toolName, description: 'demo', input_schema: { type: 'object' } },
      tier: 3,
      handler: async () => 'ok',
    });
    registry.activate(session.finish());

    expect(getToolTier(toolName, registry)).toBe(3);
    expect(getAllRegisteredToolNames()).not.toContain(toolName);
    expect(TIER3_FOUR_EYES_TOOLS.has(toolName)).toBe(false);
    expect(TIER3_SUPERVISED_TOOLS.has(toolName)).toBe(false);
    expect(resolveApprovalScope(toolName, undefined, {})).toBe('four_eyes');
  });

  it('update_org is input-aware: exempt from the static per-action tables', () => {
    expect(TIER3_INPUT_AWARE_ACTIONS.has('manage_organizations:update_org')).toBe(true);
    expect(TIER3_FOUR_EYES_ACTIONS.manage_organizations ?? []).not.toContain('update_org');
    expect(TIER3_SUPERVISED_ACTIONS.manage_organizations ?? []).not.toContain('update_org');
  });

  it('update_org escalates to four_eyes only when a status change is present', () => {
    expect(
      resolveApprovalScope('manage_organizations', 'update_org', { orgId: 'o1', status: 'suspended' }),
    ).toBe('four_eyes');
    expect(
      resolveApprovalScope('manage_organizations', 'update_org', { orgId: 'o1', name: 'Renamed' }),
    ).toBe('supervised');
  });

  it('checkGuardrails surfaces update_org\'s input-aware scope', () => {
    const withStatus = checkGuardrails('manage_organizations', { action: 'update_org', orgId: 'o1', status: 'suspended' });
    expect(withStatus.tier).toBe(3);
    expect(withStatus.approvalScope).toBe('four_eyes');
    const withoutStatus = checkGuardrails('manage_organizations', { action: 'update_org', orgId: 'o1', name: 'Renamed' });
    expect(withoutStatus.tier).toBe(3);
    expect(withoutStatus.approvalScope).toBe('supervised');
  });

  // Task 7 (#3258 wave W02): add_contact went from a stub ("returns guidance
  // only") to a real write of customer PII, so it must escalate to Tier 3 and
  // land on `supervised` — not stay Tier 2 (auto-execute with no approval) and
  // not fall through to `four_eyes` (which would demand a second approver for
  // routine contact creation, same as create_site). Two assertions, one per
  // failure mode described in spec §5:
  //   - membership in BOTH TIER3_ACTIONS and TIER3_SUPERVISED_ACTIONS is
  //     required — pulling either one out fails a DIFFERENT assertion below,
  //     so this test cannot go green with just one of the two edits in place.
  it('add_contact is classified supervised in both required tables, never four_eyes', () => {
    expect(TIER3_ACTIONS.manage_organizations ?? []).toContain('add_contact');
    expect(TIER3_SUPERVISED_ACTIONS.manage_organizations ?? []).toContain('add_contact');
    expect(TIER3_FOUR_EYES_ACTIONS.manage_organizations ?? []).not.toContain('add_contact');
  });

  it('add_contact resolves to supervised at tier 3 end-to-end — not tier 2, not four_eyes', () => {
    const check = checkGuardrails('manage_organizations', {
      action: 'add_contact', orgId: 'o1', name: 'Jane Doe', email: 'jane@customer.example',
    });
    expect(check.tier).toBe(3);
    expect(check.approvalScope).toBe('supervised');
  });

  // Review finding (fix round 1): the add_contact approval description had no
  // fallback for `name` — a phone/mobile-only contact rendered literally as
  // `Add contact "undefined"`, showing the human approver nothing identifying
  // for exactly the input shape this task's own no-identifier fix enabled.
  // These pin BOTH a name-bearing contact and a name-less one so the fallback
  // chain (name ?? email ?? phone ?? mobile) can't regress silently.
  it('add_contact approval description shows the contact name and email when both are present', () => {
    const check = checkGuardrails('manage_organizations', {
      action: 'add_contact', orgId: '11112222-1111-4111-8111-111111111111',
      name: 'Jane Doe', email: 'jane@customer.example',
    });
    expect(check.description).toContain('Jane Doe');
    expect(check.description).toContain('jane@customer.example');
    expect(check.description).not.toContain('undefined');
  });

  it('add_contact approval description identifies a phone-only contact by phone, never "undefined"', () => {
    const check = checkGuardrails('manage_organizations', {
      action: 'add_contact', orgId: '11112222-1111-4111-8111-111111111111', phone: '555-0100',
    });
    expect(check.description).toContain('555-0100');
    expect(check.description).not.toContain('undefined');
  });

  // Review finding (fix round 2): the description named only the contact and
  // the organization. `isPrimary` and `siteId` are the ONLY two add_contact
  // inputs with an effect beyond inserting a row — `isPrimary: true` demotes
  // whoever currently holds the scope's primary slot and REPLACES
  // `organizations.billing_contact` (or `sites.contact` when a site is named),
  // which is a public partner-API DTO. An approver shown neither could not
  // tell "file a new contact" apart from "overwrite this customer's billing
  // contact". These pin the exact rendering of all four combinations.
  const CONTACT_ORG = '11112222-1111-4111-8111-111111111111';
  const CONTACT_SITE = '22223333-2222-4222-8222-222222222222';

  it('add_contact approval description names the primary takeover at the ORG level', () => {
    const check = checkGuardrails('manage_organizations', {
      action: 'add_contact', orgId: CONTACT_ORG, name: 'Jane Doe', isPrimary: true,
    });
    expect(check.description).toBe(
      'Add contact "Jane Doe" to organization 11112222... '
      + 'as PRIMARY contact (replaces the current billing contact)',
    );
  });

  it('add_contact approval description names the SITE and the site-contact takeover together', () => {
    const check = checkGuardrails('manage_organizations', {
      action: 'add_contact', orgId: CONTACT_ORG, siteId: CONTACT_SITE,
      name: 'Jane Doe', isPrimary: true,
    });
    expect(check.description).toBe(
      'Add contact "Jane Doe" to organization 11112222... on site 22223333... '
      + "as PRIMARY contact (replaces the site's current contact)",
    );
  });

  it('add_contact approval description names the site pin on its own', () => {
    const check = checkGuardrails('manage_organizations', {
      action: 'add_contact', orgId: CONTACT_ORG, siteId: CONTACT_SITE, name: 'Jane Doe',
    });
    expect(check.description).toBe(
      'Add contact "Jane Doe" to organization 11112222... on site 22223333...',
    );
  });

  it('add_contact approval description is unchanged for a plain org-level contact', () => {
    const check = checkGuardrails('manage_organizations', {
      action: 'add_contact', orgId: CONTACT_ORG, name: 'Jane Doe', email: 'jane@customer.example',
    });
    expect(check.description).toBe(
      'Add contact "Jane Doe" (email: jane@customer.example) to organization 11112222...',
    );
  });

  it('s1_isolate_device is input-aware: exempt from the static whole-tool sets', () => {
    expect(TIER3_INPUT_AWARE_TOOLS.has('s1_isolate_device')).toBe(true);
    expect(TIER3_FOUR_EYES_TOOLS.has('s1_isolate_device')).toBe(false);
    expect(TIER3_SUPERVISED_TOOLS.has('s1_isolate_device')).toBe(false);
  });

  it('s1_isolate_device escalates to four_eyes only on isolate:false (containment release)', () => {
    // isolate:false — release, reverses a prior mitigation.
    expect(resolveApprovalScope('s1_isolate_device', undefined, { deviceId: 'd1', isolate: false })).toBe('four_eyes');
    // isolate:true — urgent protective containment, must not wait.
    expect(resolveApprovalScope('s1_isolate_device', undefined, { deviceId: 'd1', isolate: true })).toBe('supervised');
    // isolate missing — fail toward the urgent-containment default, not the stricter one.
    expect(resolveApprovalScope('s1_isolate_device', undefined, { deviceId: 'd1' })).toBe('supervised');
  });

  it('manage_policy_feature_link add+update are input-aware: exempt from the static per-action tables', () => {
    expect(TIER3_INPUT_AWARE_ACTIONS.has('manage_policy_feature_link:add')).toBe(true);
    expect(TIER3_INPUT_AWARE_ACTIONS.has('manage_policy_feature_link:update')).toBe(true);
    // They escalate through the input-aware hook, NOT the static table — so
    // they must not appear in TIER3_ACTIONS either, or `remove`'s entry would
    // stop being the only static escalation for this tool.
    expect(TIER3_ACTIONS.manage_policy_feature_link ?? []).toEqual(['remove']);
    expect(TIER3_FOUR_EYES_ACTIONS.manage_policy_feature_link ?? []).not.toContain('add');
    expect(TIER3_SUPERVISED_ACTIONS.manage_policy_feature_link ?? []).not.toContain('add');
  });

  it('the resolveApprovalScope override is MANDATORY for this tool, not stylistic', () => {
    // RMM-QA-176 D9. manage_policy_feature_link is in NEITHER whole-tool set,
    // and add/update are in neither *_ACTIONS scope table. Every static lookup
    // in resolveApprovalScope therefore misses for them, and the function's
    // last line is the per-TOOL `four_eyes` fail-safe. Without the input-aware
    // override an escalated `add` would resolve to four_eyes — a scope spec
    // §3.2 reserves for externally-binding/identity/destroy acts, and one the
    // in-app approval UI would surface as needing a second approver. This test
    // pins the three facts the override's necessity rests on, so that removing
    // the override becomes a visible change rather than a silent re-scoping.
    expect(TIER3_FOUR_EYES_TOOLS.has('manage_policy_feature_link')).toBe(false);
    expect(TIER3_SUPERVISED_TOOLS.has('manage_policy_feature_link')).toBe(false);
    expect(TIER3_FOUR_EYES_ACTIONS.manage_policy_feature_link).toBeUndefined();
    // ...and the fail-safe really is what an unclassified (tool, action) pair
    // on this tool reaches, demonstrated on an action the override does not
    // cover at all.
    expect(resolveApprovalScope('manage_policy_feature_link', 'not_a_real_action', {})).toBe('four_eyes');
  });

  it('manage_policy_feature_link resolves supervised for maintenance on both add and update', () => {
    expect(resolveApprovalScope('manage_policy_feature_link', 'add', { featureType: 'maintenance' })).toBe('supervised');
    expect(resolveApprovalScope('manage_policy_feature_link', 'update', { featureType: 'maintenance' })).toBe('supervised');
    // remove keeps reaching supervised via the STATIC table, unchanged.
    expect(resolveApprovalScope('manage_policy_feature_link', 'remove', {})).toBe('supervised');
  });

  it('checkGuardrails surfaces the input-aware escalation on both branches', () => {
    const maintenance = checkGuardrails('manage_policy_feature_link', { action: 'add', featureType: 'maintenance' });
    expect(maintenance.tier).toBe(3);
    expect(maintenance.approvalScope).toBe('supervised');
    const patch = checkGuardrails('manage_policy_feature_link', { action: 'add', featureType: 'patch' });
    expect(patch.tier).toBe(2);
    expect(patch.approvalScope).toBeUndefined();
  });

  it('checkGuardrails surfaces the scope on tier-3 results', () => {
    const fourEyes = checkGuardrails('manage_invoices', { action: 'issue' });
    expect(fourEyes.tier).toBe(3);
    expect(fourEyes.approvalScope).toBe('four_eyes');
    const supervised = checkGuardrails('manage_services', { action: 'restart' });
    expect(supervised.tier).toBe(3);
    expect(supervised.approvalScope).toBe('supervised');
    const tier2 = checkGuardrails('manage_patches', { action: 'approve' });
    expect(tier2.approvalScope).toBeUndefined();
  });
});
