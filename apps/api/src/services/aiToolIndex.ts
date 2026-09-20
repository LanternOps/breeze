import { AI_SYSTEM_PROMPT_BASE, AI_SYSTEM_PROMPT_TAIL } from './aiAgentSystemPrompt';
import { AI_TOOL_DOMAINS, AI_TOOL_DOMAIN_LABELS, type AiToolDomain } from '@breeze/shared';
import { aiTools } from './aiToolNames';
import { getToolDomain, getToolSearchHint } from './aiTools';

export interface ToolIndexEntry { name: string; domain: AiToolDomain; searchHint: string; actions: string[] }

/**
 * One short note per domain, rendered under that domain's line. This is the
 * ONE place disambiguation prose lives (spec A-W03: "keep disambiguation once,
 * in the generated index"). ≤ 400 chars each; no tool names the domain does
 * not contain.
 */
export const DOMAIN_NOTES: Readonly<Partial<Record<AiToolDomain, string>>> = {
  patching: 'CVE/vulnerability questions use the vulnerability tools; security posture returns control scores, not CVEs; patch management returns the patch/KB inventory, not a vulnerability answer.',
};

const MAX_INLINE_ACTIONS = 8;

function actionsOf(name: string): string[] {
  const schema = aiTools.get(name)?.definition.input_schema as { properties?: Record<string, { enum?: unknown[] }> } | undefined;
  const values = schema?.properties?.action?.enum;
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : [];
}

export function listToolIndex(names: Iterable<string>): ToolIndexEntry[] {
  const entries: ToolIndexEntry[] = [];
  for (const name of new Set(names)) {
    const domain = getToolDomain(name);
    const searchHint = getToolSearchHint(name);
    if (!domain || !searchHint) continue;
    entries.push({ name, domain, searchHint, actions: actionsOf(name) });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export function renderToolIndexByDomain(names: Iterable<string>): string {
  const entries = listToolIndex(names);
  const lines = ['## Available Tools by Domain'];
  for (const domain of AI_TOOL_DOMAINS) {
    const inDomain = entries.filter((e) => e.domain === domain);
    if (inDomain.length === 0) continue;
    const rendered = inDomain.map((e) => e.actions.length === 0
      ? e.name
      : e.actions.length <= MAX_INLINE_ACTIONS
        ? `${e.name} (${e.actions.join('/')})`
        : `${e.name} (${e.actions.length} actions)`);
    lines.push(`- **${AI_TOOL_DOMAIN_LABELS[domain]}**: ${rendered.join(', ')}`);
    const note = DOMAIN_NOTES[domain];
    if (note) lines.push(`  Note: ${note}`);
  }
  return lines.join('\n');
}

/** Static production chat prompt, before user and page context is appended. */
export function composeStaticSystemPrompt(toolNames: readonly string[]): string {
  return [AI_SYSTEM_PROMPT_BASE, renderToolIndexByDomain(toolNames), AI_SYSTEM_PROMPT_TAIL].join('\n');
}
