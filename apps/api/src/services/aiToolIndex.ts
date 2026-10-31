import { AI_SYSTEM_PROMPT_BASE, AI_SYSTEM_PROMPT_TAIL } from './aiAgentSystemPrompt';
import { AI_SYSTEM_PROMPT_DIAGNOSIS } from './aiAgentDiagnosisPrompt';
import { AI_TOOL_DOMAINS, AI_TOOL_DOMAIN_LABELS, type AiPageContext, type AiToolDomain } from '@breeze/shared';
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
  patching: 'CVEs: vulnerability tools; get_security_posture scores controls, manage_patches lists KBs. Empty report: no correlated findings, not no vulnerabilities. Create manage_update_rings; link featurePolicyId via manage_policy_feature_link for schedules/auto-approval. manage_update_rings third-party auto-approval needs third-party patch sources.',
  scripts: 'Compacted output (stdoutTruncation/_chat): page or narrow; don\'t repeat. Listings don\'t page: narrow the path. get_script_execution covers external runs and expired waits; a timeout alone doesn\'t justify edits.',
};

/**
 * W19 (#10065): what each domain covers, in plain words, for the always-on
 * index. Static on purpose: the always-on index must not grow when a wave
 * adds tools (bound B1), so it names subjects, never tools or counts. The
 * words double as ToolSearch keywords. Never use a registered tool name here
 * (some, like Wisp's `recall`, are plain words); aiToolIndex.test.ts checks.
 */
export const DOMAIN_VOCABULARY: Readonly<Record<AiToolDomain, string>> = {
  core: 'organizations, find or resolve a device, device context, Breeze docs',
  devices: 'device details and health, metrics, disks and cleanup, boot, services, startup, files, screenshots, remote control, users, groups, tags, custom fields',
  scripts: 'scripts and commands, script library and proposals, executions, playbooks, automations',
  patching: 'patches and KBs, CVEs and vulnerabilities, deployments, software policies and compliance, update rings, maintenance windows',
  monitoring: 'alerts and alert rules, monitors, incidents, logs, fixes and remediation, alert delivery and escalation, SLA and capacity',
  network: 'network assets and discovery, topology, connectivity diagnostics, links, IP and interface history, DNS filtering',
  security: 'security posture, configuration policies, CIS, compliance, audit and change logs, IOC hunts, scans, user risk, peripherals, elevation',
  backup: 'backups and jobs, snapshots, restores, vaults, Hyper-V, SQL Server, disaster recovery plans, backup SLA',
  tickets: 'tickets, checklists, routing rules, time entries and timers, timesheets, business calendars, end-user messages',
  billing: 'invoices, quotes, contracts, catalog items, distributor products, Pax8 orders',
  accounts: 'organizations and sites, contacts, documents, deliverables, key dates',
  integrations: 'EDR (SentinelOne, Huntress), Microsoft 365, Google Workspace, cloud-to-cloud backup, PSA, webhooks, notification channels',
  admin: 'reports, data export, agent versions and logs, saved filters, invites, tenant deletion',
  ai: 'AI agents and their runs, stored result artifacts, workspace runs',
};

/**
 * W19-D3: the domains whose tool list a page pre-expands into the prompt.
 * Closed and keyed by page type/kind enums only: page context is client-supplied, so a
 * client string (`custom.label`/`data`) never picks a domain. ≤ 2 per page
 * (bound B3). Topology sessions are pinned to the topology read tools and run
 * their own restricted server, so they expand nothing.
 */
export function pageContextToolDomains(ctx: AiPageContext): readonly AiToolDomain[] {
  switch (ctx.type) {
    case 'device': return ['devices', 'scripts'];
    case 'alert': return ['monitoring', 'devices'];
    case 'dashboard':
    case 'custom':
    case 'topology': return [];
    case 'record':
      switch (ctx.kind) {
        case 'ticket': return ['tickets'];
        case 'quote':
        case 'invoice':
        case 'contract': return ['billing'];
        case 'organization':
        case 'site': return ['accounts'];
        default:
          ctx.kind satisfies never;
          return [];
      }
    default:
      ctx satisfies never;
      return [];
  }
}

export const MAX_INLINE_ACTIONS = 7;

import { resolveToolIndexMode, type ToolIndexMode } from './aiToolIndexMode';

export { resolveToolIndexMode, type ToolIndexMode };

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

function renderDomainLine(domain: AiToolDomain, inDomain: readonly ToolIndexEntry[]): string {
  const rendered = inDomain.map((e) => e.actions.length === 0
    ? e.name
    : e.actions.length <= MAX_INLINE_ACTIONS
      ? `${e.name} (${e.actions.join('/')})`
      : `${e.name} (${e.actions.length} actions)`);
  return `- **${AI_TOOL_DOMAIN_LABELS[domain]}**: ${rendered.join(', ')}`;
}

/** The domain's note minus any sentence naming a tool outside `available`; '' when none is left. */
function renderDomainNote(domain: AiToolDomain, available: ReadonlySet<string>): string {
  const note = DOMAIN_NOTES[domain]?.split(/(?<=[.!?])\s+/)
    .filter((sentence) => {
      const tokens = sentence.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
      return tokens.every((token) => !aiTools.has(token) || available.has(token));
    })
    .join(' ');
  return note ? `  Note: ${note}` : '';
}

/** Legacy whole index (`AI_TOOL_INDEX=full`): every domain's tool line plus its note. */
export function renderToolIndexByDomain(names: Iterable<string>): string {
  const entries = listToolIndex(names);
  const available = new Set(entries.map((entry) => entry.name));
  const lines = ['## Available Tools by Domain'];
  for (const domain of AI_TOOL_DOMAINS) {
    const inDomain = entries.filter((e) => e.domain === domain);
    if (inDomain.length === 0) continue;
    lines.push(renderDomainLine(domain, inDomain));
    const note = renderDomainNote(domain, available);
    if (note) lines.push(note);
  }
  return lines.join('\n');
}

/**
 * W19-D2: one domain's tool line, byte-identical to its line in the legacy
 * index (no heading, no note: the note is always-on). '' when the domain has
 * no tool in `names`. Bounded by B2 (< 2 KB per domain).
 */
export function renderDomainBlock(domain: AiToolDomain, names: Iterable<string>): string {
  const inDomain = listToolIndex(names).filter((e) => e.domain === domain);
  return inDomain.length === 0 ? '' : renderDomainLine(domain, inDomain);
}

/**
 * Always-on sentence. True on every host: tool search on (deferred names come
 * in the CLI's deferred-tool list), off or low on turns (every schema inline).
 */
const ALWAYS_ON_GUIDANCE = 'Tool names appear in the tool list or deferred-tool list; call loaded tools directly, or, when ToolSearch is available, load deferred tools by keywords or select:<exact-listed-name>.';

/**
 * W19-D1: the always-on index — one line per domain present in `names`
 * (label + static vocabulary) and that domain's note, no tool lists. Bound
 * B1: < 2.5 KB and byte-identical whatever tools a wave adds to a domain
 * that already has some.
 */
export function renderAlwaysOnIndex(names: Iterable<string>): string {
  const entries = listToolIndex(names);
  const available = new Set(entries.map((entry) => entry.name));
  const present = new Set(entries.map((entry) => entry.domain));
  const lines = ['## Available Tools by Domain', ALWAYS_ON_GUIDANCE];
  for (const domain of AI_TOOL_DOMAINS) {
    if (!present.has(domain)) continue;
    lines.push(`- **${AI_TOOL_DOMAIN_LABELS[domain]}**: ${DOMAIN_VOCABULARY[domain]}`);
    const note = renderDomainNote(domain, available);
    if (note) lines.push(note);
  }
  return lines.join('\n');
}

/**
 * W19-D3: the tool lists a page pre-expands, for the `## Current Page Context`
 * section. '' when the page maps to no domain or none of its domains has a
 * tool in `names`.
 */
export function renderPageContextToolBlocks(ctx: AiPageContext, names: readonly string[]): string {
  const domains = pageContextToolDomains(ctx);
  const blocks = domains
    .map((domain) => renderDomainBlock(domain, names))
    .filter((block) => block.length > 0);
  return blocks.length === 0 ? '' : ['### Tools for this page', ...blocks].join('\n');
}

/** Static production chat prompt, before user and page context is appended. */
export function composeStaticSystemPrompt(toolNames: readonly string[], mode: ToolIndexMode = resolveToolIndexMode()): string {
  const index = mode === 'full' ? renderToolIndexByDomain(toolNames) : renderAlwaysOnIndex(toolNames);
  return [AI_SYSTEM_PROMPT_BASE, index, AI_SYSTEM_PROMPT_TAIL, AI_SYSTEM_PROMPT_DIAGNOSIS].join('\n');
}
