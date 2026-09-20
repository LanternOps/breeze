import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { AI_TOOL_DOMAINS, AI_TOOL_DOMAIN_LABELS } from '@breeze/shared';
import './aiTools'; // populates the registry
import { getAllRegisteredToolNames } from './aiTools';
import { buildBreezeSdkTools, listChatSurfaceToolNames } from './aiAgentSdkTools';
import { DOMAIN_NOTES, listToolIndex, renderToolIndexByDomain } from './aiToolIndex';

const COVERAGE_BURNDOWN_TOOLS = [
  ['Tickets & time', 'list_time_entries'],
  ['Tickets & time', 'get_running_timer'],
  ['Tickets & time', 'get_timesheet'],
  ['Accounts', 'list_org_contacts'],
  ['Accounts', 'list_sites'],
  ['Accounts', 'get_site'],
  ['Monitoring & alerts', 'list_incidents'],
  ['Monitoring & alerts', 'list_remediation_suggestions'],
  ['Network', 'list_network_assets'],
  ['Network', 'get_network_asset'],
  ['AI agents', 'list_ai_agents'],
  ['AI agents', 'list_ai_agent_runs'],
  ['AI agents', 'get_ai_agent_run'],
] as const;

describe('A-W06 tool discoverability', () => {
  it.each(COVERAGE_BURNDOWN_TOOLS)('renders %s tool %s under its domain', (label, name) => {
    const text = renderToolIndexByDomain(listChatSurfaceToolNames());
    const line = text.split('\n').find((entry) => entry.startsWith(`- **${label}**: `));
    expect(line?.slice(`- **${label}**: `.length).split(', ')).toContain(name);
  });

  it('documents all 13 tools exactly once as Tier 1 table rows', () => {
    const docs = readFileSync(new URL('../../../docs/src/content/docs/features/mcp-server.mdx', import.meta.url), 'utf8');
    const rows = docs.split('\n').filter((line) => line.startsWith('| `'));
    const missingOrIncorrect = COVERAGE_BURNDOWN_TOOLS.map(([, name]) => name).filter((name) => {
      const matches = rows.filter((row) => row.startsWith(`| \`${name}\` |`));
      return matches.length !== 1 || !matches[0]?.startsWith(`| \`${name}\` | 1 | `);
    });
    expect(missingOrIncorrect, 'missing, duplicate, or incorrectly tiered A-W06 documentation rows').toEqual([]);
  });
});

describe('renderToolIndexByDomain (A-W02)', () => {
  const names = listChatSurfaceToolNames();
  const text = renderToolIndexByDomain(names);

  it('renders domains in spec order under the standing heading', () => {
    expect(text.startsWith('## Available Tools by Domain\n')).toBe(true);
    const labelsInOrder = text.match(/^- \*\*([^*]+)\*\*: /gm)!.map((l) => l.replace(/^- \*\*|\*\*: $/g, ''));
    const expected = AI_TOOL_DOMAINS
      .filter((d) => listToolIndex(names).some((e) => e.domain === d))
      .map((d) => AI_TOOL_DOMAIN_LABELS[d]);
    expect(labelsInOrder).toEqual(expected);
  });

  it('names every chat-callable tool exactly once and nothing else', () => {
    const mentioned = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
    const set = new Set(names);
    const unknown = mentioned.filter((m) => !set.has(m) && !isActionToken(text, m));
    expect(unknown).toEqual([]);
    for (const n of names) expect(mentioned.filter((token) => token === n).length, n).toBe(1);
  });

  it('keeps the vulnerability tools findable with CVE vocabulary (#2605 pin moves here)', () => {
    expect(text).toContain('get_vulnerability_report');
    expect(text).toContain('get_device_vulnerabilities');
    expect(text).toContain('remediate_vulnerability');
    expect(text).toMatch(/CVE/);
  });

  it('skips names that have no domain instead of throwing', () => {
    expect(listToolIndex(['query_devices', 'propose_action_plan', 'not_a_tool']).map((e) => e.name)).toEqual(['query_devices']);
  });

  it('stays small: the whole index is under 5 KB and every note under 400 chars', () => {
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(5 * 1024);
    for (const note of Object.values(DOMAIN_NOTES)) expect(note!.length).toBeLessThanOrEqual(400);
  });
});

/** Action tokens are rendered inside parentheses after a tool name; ignore those in the unknown-name check. */
function isActionToken(text: string, token: string): boolean {
  return new RegExp(`\\(([a-z0-9_]+/)*${token}(/[a-z0-9_]+)*\\)`).test(text);
}

/**
 * Guard for the A-W02 review finding: the generated index used to be
 * `TOOL_TIERS ∩ registry`, blind to the env gates `buildBreezeSdkTools`
 * applies for M365, Google Workspace and AI script authoring (and to the
 * script_builder-only tools never declared in this server at all). Checked
 * both with the flags OFF (default install) and ON, since the drift only
 * shows up on the OFF side.
 */
describe('the generated index tracks env-gated tool declarations (A-W02 review fix)', () => {
  const registered = new Set(getAllRegisteredToolNames());
  const fakeAuth = () => { throw new Error('must not invoke tool handlers'); };

  function declaredNames(): Set<string> {
    return new Set(
      buildBreezeSdkTools(fakeAuth as never)
        .map((t) => t.name)
        .filter((n) => registered.has(n)),
    );
  }

  /** Tool tokens actually mentioned in the rendered index, intersected with
   *  the registry so action-enum tokens (rendered in parens) are ignored. */
  function advertisedNames(): Set<string> {
    const names = listChatSurfaceToolNames();
    const text = renderToolIndexByDomain(names);
    const tokens = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
    return new Set(tokens.filter((t) => registered.has(t)));
  }

  function assertNoDrift() {
    const declared = declaredNames();
    const advertised = advertisedNames();
    const advertisedButMute = [...advertised].filter((n) => !declared.has(n)).sort();
    const declaredButNotAdvertised = [...declared].filter((n) => !advertised.has(n)).sort();
    expect(advertisedButMute, 'advertised but not actually declared to the SDK').toEqual([]);
    expect(declaredButNotAdvertised, 'declared to the SDK but missing from the index').toEqual([]);
  }

  it('flags OFF (default install): advertised set matches what buildBreezeSdkTools declares', () => {
    assertNoDrift();
  });

  it('flags ON (M365 + Google Workspace + AI script authoring): advertised set matches what buildBreezeSdkTools declares', () => {
    vi.stubEnv('M365_ENABLED', 'true');
    vi.stubEnv('GOOGLE_WORKSPACE_ENABLED', 'true');
    vi.stubEnv('BREEZE_AI_SCRIPT_AUTHORING_ENABLED', 'true');
    try {
      assertNoDrift();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
