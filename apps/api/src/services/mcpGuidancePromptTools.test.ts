// apps/api/src/services/mcpGuidancePromptTools.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AI_TOOL_DOMAINS, AI_TOOL_DOMAIN_LABELS } from '@breeze/shared';
import { POLICY_FEATURE_INLINE_SETTINGS_REFERENCE } from './aiToolsConfigPolicy';
import { MCP_PROMPTS, MCP_SERVER_INSTRUCTIONS, MCP_TOOL_COUNT_APPROX } from './mcpGuidance';
import { aiTools } from './aiTools';

// Matches snake_case identifiers (`get_invite_funnel`, `resolve_device_context`).
// Glob patterns like `query_*` / `manage_*` don't match — the trailing `_*` has
// no alphanumeric segment — and camelCase (`ownerScope`) / hyphenated
// (`newly-registered-domain`) prose is ignored too, so we only ever catch
// tokens that are shaped like real tool names.
const TOOL_TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const extractToolTokens = (text: string): string[] => text.match(TOOL_TOKEN) ?? [];

describe('prompt guidance references only real tools', () => {
  const registered = new Set(aiTools.keys());

  it('every referencedTools entry exists in the aiTools registry', () => {
    const unknown: string[] = [];
    for (const p of MCP_PROMPTS) {
      for (const t of p.referencedTools) if (!registered.has(t)) unknown.push(`${p.name}:${t}`);
    }
    expect(unknown, `Prompt guidance references non-existent tools: ${unknown.join(', ')}`).toEqual([]);
  });

  // The referencedTools guard above only covers the declared arrays. The tool
  // names actually spelled out in each render() body can drift independently —
  // a rename that updates the registry but not the prose would slip through. By
  // intersecting the rendered prose with the live registry we flag any REAL
  // tool named in the prose that isn't declared in referencedTools; non-tool
  // snake_case terms (e.g. the `alert_rule` feature type) aren't in the registry
  // and are harmlessly skipped, so this can't false-positive.
  it('every registry tool named in a rendered prompt is declared in referencedTools', () => {
    const violations: string[] = [];
    for (const p of MCP_PROMPTS) {
      const declared = new Set(p.referencedTools);
      const text = p.render({});
      for (const token of extractToolTokens(text)) {
        if (registered.has(token) && !declared.has(token)) violations.push(`${p.name}:${token}`);
      }
    }
    expect(
      violations,
      `Rendered prompt prose names registry tools missing from referencedTools: ${violations.join(', ')}`,
    ).toEqual([]);
  });

  // MCP_SERVER_INSTRUCTIONS names a couple of tools directly (resolve_device_context,
  // query_devices). Guard those against renames too. Glob patterns are excluded by
  // the token regex; if you add a genuinely non-tool snake_case term here, either
  // rephrase it or register the tool.
  it('every tool-shaped token in MCP_SERVER_INSTRUCTIONS is a real registry tool', () => {
    const unknown = extractToolTokens(MCP_SERVER_INSTRUCTIONS).filter((t) => !registered.has(t));
    expect(
      unknown,
      `MCP_SERVER_INSTRUCTIONS names tool-shaped tokens missing from the registry: ${unknown.join(', ')}`,
    ).toEqual([]);
  });

  // The instructions advertise an approximate tool count as a literal. Keep it
  // honest: if the real registry drifts more than a rounding-bucket away, bump
  // MCP_TOOL_COUNT_APPROX to the nearest ten.
  it('the advertised approximate tool count stays within tolerance of the registry', () => {
    expect(Math.abs(registered.size - MCP_TOOL_COUNT_APPROX)).toBeLessThanOrEqual(10);
  });

  it('tells the model how to continue a paged result and how to read a handle (A-W05)', () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain('hasMore');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('nextCursor');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('read_artifact');
  });
});


describe('moved workflow guidance (A-W03)', () => {
  it('confirms the patch scope, approves patches, then installs them', () => {
    const text = MCP_PROMPTS.find(p => p.name === 'breeze-patch-remediate')!.render({ target: 'pilot' });
    expect(text).toMatch(/CONFIRM[\s\S]*action=approve[\s\S]*action=install/);
    expect(text).toContain('patchIds and deviceIds');
  });

  it('describes settings before creating standalone prerequisites and linking their IDs', () => {
    const text = MCP_PROMPTS.find(p => p.name === 'breeze-turnkey-setup')!.render({});
    expect(text).toMatch(/action=describe[\s\S]*featurePolicyId/);
    expect(text).toContain('manage_backup_profiles');
    expect(text).toContain('inlineSettings.destinationConfigId');
    expect(text).toMatch(/create the standalone policy[\s\S]*then link/);
  });

  it('documents the monitor check interval in the live feature reference', () => {
    expect(POLICY_FEATURE_INLINE_SETTINGS_REFERENCE.monitors).toContain('checkIntervalSeconds: 60');
    expect(POLICY_FEATURE_INLINE_SETTINGS_REFERENCE.monitors).toContain('10–3600');
    expect(POLICY_FEATURE_INLINE_SETTINGS_REFERENCE).not.toHaveProperty('alert_rule');
    expect(POLICY_FEATURE_INLINE_SETTINGS_REFERENCE).not.toHaveProperty('monitoring');
  });

  it('publishes every domain and the full per-feature settings reference', () => {
    const page = readFileSync(new URL('../../../docs/src/content/docs/features/ai-tools.mdx', import.meta.url), 'utf8');
    expect(page).toContain('title: AI tools reference');
    expect(page.match(/^## .+$/gm)).toEqual(AI_TOOL_DOMAINS.map(domain => `## ${AI_TOOL_DOMAIN_LABELS[domain]}`));
    for (const [feature, reference] of Object.entries(POLICY_FEATURE_INLINE_SETTINGS_REFERENCE)) {
      expect(page).toContain(`| \`${feature}\` |`);
      expect(page).toContain(reference.replaceAll('|', '\\|'));
    }
    const index = JSON.parse(readFileSync(new URL('../data/docsIndex.json', import.meta.url), 'utf8'));
    expect(index).toContainEqual(expect.objectContaining({ path: '/features/ai-tools/', title: 'AI tools reference' }));
  });
});
