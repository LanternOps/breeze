/**
 * #11181 contract: every approval-class (Tier-3) AI tool that takes an org argument says
 * which org its intent is filed in. A new tool with an `orgId` (or `org_id`) argument must
 * be added to `INTENT_ORG_ARGUMENT` (the argument names the org it changes), to
 * `ORG_ARGUMENT_NOT_TARGET` with the reason it does not, or be a row-resolved design tool.
 * Otherwise its intent silently lands in the session org while it changes another.
 */
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { aiTools } from '../aiTools';
import { TIER3_ACTIONS, TIER3_FOUR_EYES_ACTIONS, TIER3_INPUT_AWARE_ACTIONS, TIER3_INPUT_AWARE_TOOLS, TIER3_SUPERVISED_ACTIONS } from '../aiGuardrails';
import { AI_DESIGN_INTENT_TOOLS } from './aiDesignIntentTarget';
import { DEVICE_TARGETED, INTENT_ROW_LEFT, INTENT_ROW_PARTNER_WIDE, INTENT_ROW_TARGET } from './intentRowTarget';
import { INTENT_ORG_ARGUMENT, ORG_ARGUMENT_NOT_TARGET } from './intentTargetOrg';

const ORG_ARGS = ['orgId', 'org_id'] as const;

function schemaProps(toolName: string): Record<string, unknown> {
  const schema = aiTools.get(toolName)?.definition.input_schema as { properties?: Record<string, unknown> } | undefined;
  return schema?.properties ?? {};
}

/** Input-aware pairs are `tool:action`: Tier 3 on some inputs (a public comment), so they file intents too. */
function inputAwareActions(toolName: string): string[] {
  return [...TIER3_INPUT_AWARE_ACTIONS].filter((pair) => pair.startsWith(`${toolName}:`)).map((pair) => pair.slice(toolName.length + 1));
}

function tier3Actions(toolName: string): Set<string> {
  return new Set([
    ...(TIER3_ACTIONS[toolName] ?? []), ...(TIER3_SUPERVISED_ACTIONS[toolName] ?? []), ...(TIER3_FOUR_EYES_ACTIONS[toolName] ?? []),
    ...inputAwareActions(toolName),
  ]);
}

function hasTier3(toolName: string): boolean {
  return aiTools.get(toolName)?.tier === 3 || tier3Actions(toolName).size > 0 || TIER3_INPUT_AWARE_TOOLS.has(toolName);
}

describe('intent target org contract (#11181)', () => {
  it('every Tier-3 tool with an org argument is classified', () => {
    const unclassified = [...aiTools.keys()].filter((name) => hasTier3(name)
      && ORG_ARGS.some((arg) => arg in schemaProps(name))
      && !(name in INTENT_ORG_ARGUMENT) && !(name in ORG_ARGUMENT_NOT_TARGET) && !AI_DESIGN_INTENT_TOOLS.has(name));
    expect(unclassified).toEqual([]);
  });

  it.each(Object.entries(INTENT_ORG_ARGUMENT))('%s: the argument exists and every listed action files an intent', (toolName, entry) => {
    expect(aiTools.has(toolName)).toBe(true);
    expect(schemaProps(toolName)).toHaveProperty(entry.arg);
    expect(hasTier3(toolName)).toBe(true);
    if (entry.actions !== 'all' && aiTools.get(toolName)?.tier !== 3) {
      const tier3 = tier3Actions(toolName);
      expect(entry.actions.filter((action) => !tier3.has(action))).toEqual([]);
    }
  });

  it('every not-target entry is a real tool with an org argument and a reason', () => {
    for (const [toolName, reason] of Object.entries(ORG_ARGUMENT_NOT_TARGET)) {
      expect(aiTools.has(toolName), toolName).toBe(true);
      expect(ORG_ARGS.some((arg) => arg in schemaProps(toolName)), toolName).toBe(true);
      expect(reason.length, toolName).toBeGreaterThan(10);
    }
  });

  it('the design tools are row-resolved, not argument-resolved', () => {
    for (const name of AI_DESIGN_INTENT_TOOLS) expect(INTENT_ORG_ARGUMENT).not.toHaveProperty(name);
  });
});

/**
 * #11222 contract: every approval-class action of a Tier-3 tool that takes an id says where
 * its intent goes: its row (`INTENT_ROW_TARGET`), its org argument (`INTENT_ORG_ARGUMENT`), a
 * design tool's row, a row with no org (`INTENT_ROW_PARTNER_WIDE`), or a stated reason it
 * stays (`INTENT_ROW_LEFT`). A new action that is none of these would file in the session org
 * while it changes a row of another.
 */
const ID_ARG = /(^id$|^ids$|Id$|_id$|Ids$|_ids$)/;

function actionEnum(toolName: string): string[] | null {
  return (schemaProps(toolName).action as { enum?: string[] } | undefined)?.enum ?? null;
}

/** What a call can actually ask for: a tier table can still list an action the schema no longer offers. */
function approvalActions(toolName: string): string[] {
  const offered = actionEnum(toolName);
  const listed = [...tier3Actions(toolName)];
  if (listed.length > 0) return offered ? listed.filter((action) => offered.includes(action)) : listed;
  return offered ?? ['*'];
}

const matchesAction = (actions: readonly string[] | 'all', action: string): boolean => actions === 'all' || actions.includes(action);

function classifications(toolName: string, action: string): string[] {
  const argument = INTENT_ORG_ARGUMENT[toolName];
  return [
    ...(argument && matchesAction(argument.actions, action) ? ['argument'] : []),
    ...((INTENT_ROW_TARGET[toolName] ?? []).some((entry) => matchesAction(entry.actions, action)) ? ['row'] : []),
    ...(AI_DESIGN_INTENT_TOOLS.has(toolName) ? ['design'] : []),
    ...(toolName in INTENT_ROW_PARTNER_WIDE || `${toolName}:${action}` in INTENT_ROW_PARTNER_WIDE ? ['partner-wide'] : []),
    ...(toolName in INTENT_ROW_LEFT || `${toolName}:${action}` in INTENT_ROW_LEFT ? ['left'] : []),
  ];
}

describe('intent target row contract (#11222)', () => {
  const idTaking = [...aiTools.keys()].filter((name) => hasTier3(name) && Object.keys(schemaProps(name)).some((arg) => ID_ARG.test(arg)));

  it('finds the id-taking Tier-3 tools (a broken filter would pass everything below)', () => {
    expect(idTaking.length).toBeGreaterThan(100);
    expect(idTaking).toEqual(expect.arrayContaining(['manage_invoices', 'manage_tickets', 'execute_command']));
  });

  it('every approval-class action of an id-taking Tier-3 tool is classified', () => {
    const unclassified = idTaking.flatMap((name) => approvalActions(name)
      .filter((action) => classifications(name, action).length === 0)
      .map((action) => `${name}:${action}`));
    expect(unclassified).toEqual([]);
  });

  it('a row target is never also partner-wide or left, so no action has two answers', () => {
    const both = idTaking.flatMap((name) => approvalActions(name)
      .filter((action) => {
        const classes = classifications(name, action);
        return classes.includes('row') && (classes.includes('partner-wide') || classes.includes('left') || classes.includes('design'));
      })
      .map((action) => `${name}:${action}`));
    expect(both).toEqual([]);
  });

  it('a row target and an argument target never claim the same action of a tool, except a `when` split', () => {
    const overlap = Object.entries(INTENT_ROW_TARGET).flatMap(([name, entries]) => {
      const argument = INTENT_ORG_ARGUMENT[name];
      if (!argument || argument.when) return [];
      return entries.flatMap((entry) => (entry.actions === 'all' ? ['all'] : entry.actions).filter((action) => matchesAction(argument.actions, action)));
    });
    expect(overlap).toEqual([]);
  });

  describe.each(Object.entries(INTENT_ROW_TARGET))('%s', (toolName, entries) => {
    it.each(entries.map((entry) => [entry.arg, entry] as const))('%s names a uuid row with an org column, for Tier-3 actions only', (arg, entry) => {
      expect(aiTools.has(toolName)).toBe(true);
      expect(schemaProps(toolName)).toHaveProperty(arg);
      if (entry.actions !== 'all') {
        const offered = actionEnum(toolName);
        expect(offered, 'a listed action needs a tool with an action enum').not.toBeNull();
        expect(entry.actions.filter((action) => !offered!.includes(action))).toEqual([]);
      }
      if (entry.actions !== 'all' && aiTools.get(toolName)?.tier !== 3) {
        const tier3 = tier3Actions(toolName);
        expect(entry.actions.filter((action) => !tier3.has(action))).toEqual([]);
      }
      const { table, id, org, partner } = entry.row();
      const columns = Object.values(getTableColumns(table));
      // resolveIntentRowTarget treats a non-uuid id as no row, so a text key would always refuse.
      expect(id.columnType).toBe('PgUUID');
      expect(id.primary).toBe(true);
      expect(columns).toContain(org);
      if (partner) expect(columns).toContain(partner);
    });
  });

  it('a table with no partner column cannot hold an org-less row, so its row always has an org', () => {
    const noPartnerNullableOrg = Object.entries(INTENT_ROW_TARGET).flatMap(([name, entries]) => entries.flatMap((entry) => {
      const { partner, org } = entry.row();
      return !partner && !org.notNull ? [`${name}:${entry.arg}`] : [];
    }));
    expect(noPartnerNullableOrg).toEqual([]);
  });

  it('a device-targeted entry really names a device, and every reason says something', () => {
    for (const [key, reason] of Object.entries({ ...INTENT_ROW_PARTNER_WIDE, ...INTENT_ROW_LEFT })) {
      const toolName = key.split(':')[0]!;
      expect(aiTools.has(toolName), key).toBe(true);
      expect(hasTier3(toolName), key).toBe(true);
      expect(reason.length, key).toBeGreaterThan(5);
      if (reason === DEVICE_TARGETED) expect(aiTools.get(toolName)?.deviceArgs?.length ?? 0, key).toBeGreaterThan(0);
    }
  });

  it('a `tool:action` key names an action the tool offers, so a key cannot outlive its action', () => {
    const stale = Object.keys({ ...INTENT_ROW_PARTNER_WIDE, ...INTENT_ROW_LEFT }).filter((key) => {
      const [toolName, action] = key.split(':');
      return action !== undefined && !(actionEnum(toolName!) ?? []).includes(action);
    });
    expect(stale).toEqual([]);
  });

  it('a whole-tool key is only for a tool with no action, or a device tool: a new action must not be covered by accident', () => {
    const tooCoarse = Object.entries({ ...INTENT_ROW_PARTNER_WIDE, ...INTENT_ROW_LEFT })
      .filter(([key, reason]) => !key.includes(':') && actionEnum(key) !== null && reason !== DEVICE_TARGETED)
      .map(([key]) => key);
    expect(tooCoarse).toEqual([]);
  });
});
