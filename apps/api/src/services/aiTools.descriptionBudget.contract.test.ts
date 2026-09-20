/**
 * A-W03 contract: tool descriptions ≤ 300 chars, parameter descriptions ≤ 160,
 * no workflow prose, every declared action still named. Offenders that predate
 * this wave sit in DESCRIPTION_BUDGET_BASELINE, which is FROZEN and shrink-only:
 * an entry may only get shorter or disappear. A new tool must fit the budget.
 *
 * No vi.mock — real registry.
 */
import { describe, expect, it, vi } from 'vitest';
import { aiTools } from './aiToolNames';
import { getToolDomain } from './aiTools';
import { z } from 'zod';
import { buildBreezeSdkTools } from './aiAgentSdkTools';
import { m365ToolTiers } from './aiToolsM365';
import { googleToolTiers } from './aiToolsGoogle';

export const TOOL_DESCRIPTION_MAX = 300;
export const PARAM_DESCRIPTION_MAX = 160;
const WORKFLOW_PROSE = [/\b(step \d|first call|then call|after that|workflow:)\b/i, /(^|\s)\d\)\s/, /\{\s*"[a-zA-Z]+"\s*:/];

/**
 * Frozen under Vitest on 2026-09-20, after the mandatory action-name fixes:
 * 223 registry entries; 130/162/135 emitted tools (off/on/Delegant fallback).
 * 51 tool names exceed a length budget: 44 descriptions, 20 parameter sets.
 * Each ceiling is the maximum across registry and emitted descriptors. Session
 * tools use their actual factory descriptors, with no permanent exemptions.
 * Never add or increase an entry; later diet tasks must delete fixed entries.
 */
const DESCRIPTION_BUDGET_BASELINE: ReadonlyMap<string, { description?: number; params?: number }> = new Map([]);

interface Offence { tool: string; description?: number; params?: number; prose?: string; missingActions?: string[] }

interface Descriptor { name: string; description?: string; input_schema: unknown }

// Inspect the actual declarations, including factories outside the main literal list.
const configurations = [
  { M365_ENABLED: 'false', GOOGLE_WORKSPACE_ENABLED: 'false', BREEZE_AI_SCRIPT_AUTHORING_ENABLED: 'false', DELEGANT_BASE_URL: '' },
  { M365_ENABLED: 'true', GOOGLE_WORKSPACE_ENABLED: 'true', BREEZE_AI_SCRIPT_AUTHORING_ENABLED: 'true', DELEGANT_BASE_URL: '' },
  { M365_ENABLED: 'false', GOOGLE_WORKSPACE_ENABLED: 'false', BREEZE_AI_SCRIPT_AUTHORING_ENABLED: 'false', DELEGANT_BASE_URL: 'https://delegant.example.com' },
];
const registry: Descriptor[] = [...aiTools.values()].map(t => t.definition);
const emitted = configurations.map(config => {
  for (const [key, value] of Object.entries(config)) vi.stubEnv(key, value);
  try {
    return buildBreezeSdkTools(() => { throw new Error('handlers must not run'); }).map(t => ({
      name: t.name, description: t.description,
      input_schema: z.toJSONSchema(z.object(t.inputSchema), { io: 'input', unrepresentable: 'any' }),
    }));
  } finally { vi.unstubAllEnvs(); }
});
const descriptors = [...registry, ...emitted.flat()];

function walkParamDescriptions(schema: unknown, out: number[] = []): number[] {
  if (!schema || typeof schema !== 'object') return out;
  if (Array.isArray(schema)) {
    for (const child of schema) walkParamDescriptions(child, out);
    return out;
  }
  const s = schema as Record<string, unknown>;
  if (typeof s.description === 'string') out.push(s.description.length);
  // Also covers union branches, additionalProperties and $defs in emitted schemas.
  for (const [key, value] of Object.entries(s)) {
    if (key !== 'description') walkParamDescriptions(value, out);
  }
  return out;
}

function offenceForDescriptor(t: Descriptor): Offence | null {
  const d = t.description ?? '';
  const params = walkParamDescriptions(t.input_schema).filter(n => n > PARAM_DESCRIPTION_MAX);
  const enumValues = ((t.input_schema as { properties?: { action?: { enum?: unknown[] } } }).properties?.action?.enum ?? [])
    .filter((v): v is string => typeof v === 'string');
  const missingActions = enumValues.filter(a => !d.includes(a));
  const prose = WORKFLOW_PROSE.find(re => re.test(d))?.source;
  const o: Offence = { tool: t.name };
  if (d.length > TOOL_DESCRIPTION_MAX) o.description = d.length;
  if (params.length) o.params = Math.max(...params);
  if (prose) o.prose = prose;
  if (missingActions.length) o.missingActions = missingActions;
  return Object.keys(o).length > 1 ? o : null;
}

function offenceFor(name: string): Offence | null {
  const found = descriptors.filter(t => t.name === name).map(offenceForDescriptor).filter((o): o is Offence => o !== null);
  if (!found.length) return null;
  return {
    tool: name,
    description: Math.max(...found.map(o => o.description ?? 0)) || undefined,
    params: Math.max(...found.map(o => o.params ?? 0)) || undefined,
    prose: found.find(o => o.prose)?.prose,
    missingActions: found.some(o => o.missingActions) ? [...new Set(found.flatMap(o => o.missingActions ?? []))] : undefined,
  };
}

describe('AI tool description budget (A-W03)', () => {
  const names = [...new Set(descriptors.map(t => t.name))].sort();
  const offences = names.map(offenceFor).filter((o): o is Offence => o !== null);

  it('advertises patch configuration through the supported policy tool', () => {
    const d = aiTools.get('manage_patches')!.definition.description;
    expect(d).not.toContain('setup_auto_approval');
    expect(d).toContain('manage_policy_feature_link');
    expect(d).toContain('featureType "patch"');
  });

  it('explains inbox-only delivery and where channel CRUD lives', () => {
    const d = aiTools.get('manage_delivery')!.definition.description;
    expect(d).toMatch(/channelIds: \[\] means inbox-only/);
    expect(d).toContain('manage_notification_channels');
  });

  it('has a populated registry', () => { expect(registry.length).toBeGreaterThan(150); });

  it('covers disabled and enabled factories, including the Delegant fallback', () => {
    const [disabled, enabled, fallback] = emitted.map(tools => tools.map(t => t.name));
    const gated = [...Object.keys(m365ToolTiers), ...Object.keys(googleToolTiers), 'propose_script', 'get_script_proposal'];
    for (const name of gated) {
      expect(disabled).not.toContain(name);
      expect(enabled).toContain(name);
    }
    for (const name of Object.keys(m365ToolTiers)) expect(fallback).toContain(name);
    for (const name of Object.keys(googleToolTiers)) expect(fallback).not.toContain(name);
  });

  it('checks nested parameter descriptions and actions even when lengths fit', () => {
    expect(offenceForDescriptor({ name: 'fixture', description: 'Manage items. Actions: list.', input_schema: {
      properties: { action: { enum: ['list', 'delete'] }, entries: {
        items: { anyOf: [{ properties: { nested: { description: 'x'.repeat(161) } } }] },
      } },
    } })).toEqual({ tool: 'fixture', params: 161, missingActions: ['delete'] });
    expect(offenceForDescriptor({ name: 'fixture', description: 'First call another tool.', input_schema: {} })?.prose).toBeTruthy();
  });

  it('Task 4a domains fit the budget across registry and emitted schemas', () => {
    const taskDomains = new Set(['devices', 'scripts', 'patching', 'core']);
    const remaining = offences.filter(o => taskDomains.has(getToolDomain(o.tool) ?? ''));
    expect(remaining, JSON.stringify({ registry: registry.length, emitted: emitted.map(d => d.length), offenders: offences.length })).toEqual([]);
  });

  it('Task 4b domains fit the budget across registry and emitted schemas', () => {
    const taskDomains = new Set(['monitoring', 'network', 'security', 'backup']);
    const remaining = offences.filter(o => taskDomains.has(getToolDomain(o.tool) ?? ''));
    console.log('Task 4b budget measurement', JSON.stringify({ registry: registry.length, emitted: emitted.map(d => d.length), offenders: offences.length, domainOffenders: remaining.length }));
    expect(remaining).toEqual([]);
  });

  it('Task 4c leaves no budget offenders or baseline entries on any surface', () => {
    console.log('Task 4c budget measurement', JSON.stringify({ registry: registry.length, emitted: emitted.map(d => d.length), offenders: offences.length }));
    expect(offences).toEqual([]);
    expect(DESCRIPTION_BUDGET_BASELINE.size).toBe(0);
  });

  it('every tool outside the baseline fits the budget', () => {
    const fresh = offences.filter((o) => !DESCRIPTION_BUDGET_BASELINE.has(o.tool) && (o.description || o.params));
    expect(fresh, 'new offenders — shorten, do not add to the baseline').toEqual([]);
  });

  it('no description carries workflow prose or drops a declared action (no baseline for these)', () => {
    expect(offences.filter((o) => o.prose).map((o) => `${o.tool}: /${o.prose}/`)).toEqual([]);
    expect(offences.filter((o) => o.missingActions).map((o) => `${o.tool}: ${o.missingActions!.join(',')}`)).toEqual([]);
  });

  it('baseline entries only shrink (ratchet) and disappear once fixed', () => {
    const grew: string[] = []; const stale: string[] = [];
    for (const [tool, frozen] of DESCRIPTION_BUDGET_BASELINE) {
      const now = offenceFor(tool);
      if (!now || (!now.description && !now.params)) { stale.push(tool); continue; }
      if ((now.description ?? 0) > (frozen.description ?? TOOL_DESCRIPTION_MAX)) grew.push(`${tool} description`);
      if ((now.params ?? 0) > (frozen.params ?? PARAM_DESCRIPTION_MAX)) grew.push(`${tool} params`);
    }
    expect(grew, 'a baselined description got LONGER').toEqual([]);
    expect(stale, 'fixed — delete from DESCRIPTION_BUDGET_BASELINE').toEqual([]);
  });
});
