import { AI_SYSTEM_PROMPT_BASE, AI_SYSTEM_PROMPT_TAIL } from './aiAgentSystemPrompt';
import { AI_TOOL_DOMAINS, AI_TOOL_DOMAIN_LABELS, type AiToolDomain } from '@breeze/shared';
import { aiTools } from './aiToolNames';
import { getToolDomain, getToolSearchHint } from './aiTools';

export interface ToolIndexEntry { name: string; domain: AiToolDomain; searchHint: string; actions: string[] }

/**
 * One short note per domain, rendered under that domain's line. This is the
 * ONE place disambiguation prose lives (spec A-W03: "keep disambiguation once,
 * in the generated index"). ≤ 400 chars each. Keep sentences self-contained: rendering omits any
 * sentence that names a tool absent from the rendered subset.
 */
export const DOMAIN_NOTES: Readonly<Partial<Record<AiToolDomain, string>>> = {
  patching: 'CVEs need vulnerability tools; get_security_posture scores controls, manage_patches lists KBs. Empty reports: no correlated findings, not no vulnerabilities (coverage incomplete). Create manage_update_rings; link featurePolicyId via manage_policy_feature_link for schedules/auto-approval. manage_update_rings third-party auto-approval needs third-party patch sources. Approve patches before install.',
  scripts: 'For compacted command output (stdoutTruncation/_chat), page or narrow filters instead of repeating the call. File listings have no paging: narrow the path. get_script_execution covers external runs (such as editor Test Run or execution history) and expired run waits; a timeout alone does not justify changing a script.',
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
  const available = new Set(entries.map((entry) => entry.name));
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
    const note = DOMAIN_NOTES[domain]?.split(/(?<=[.!?])\s+/)
      .filter((sentence) => {
        const tokens = sentence.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
        return tokens.every((token) => !aiTools.has(token) || available.has(token));
      })
      .join(' ');
    if (note) lines.push(`  Note: ${note}`);
  }
  return lines.join('\n');
}

/** Static production chat prompt, before user and page context is appended. */
export function composeStaticSystemPrompt(toolNames: readonly string[]): string {
  return [AI_SYSTEM_PROMPT_BASE, renderToolIndexByDomain(toolNames), AI_SYSTEM_PROMPT_TAIL].join('\n');
}
