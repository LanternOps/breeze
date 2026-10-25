import { AI_SYSTEM_PROMPT_BASE, AI_SYSTEM_PROMPT_TAIL } from './aiAgentSystemPrompt';
import { AI_SYSTEM_PROMPT_DIAGNOSIS } from './aiAgentDiagnosisPrompt';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { AI_TOOL_DOMAINS, AI_TOOL_DOMAIN_LABELS } from '@breeze/shared';
import './aiTools'; // populates the registry
import { getAllRegisteredToolNames } from './aiTools';
import { buildBreezeSdkTools, listChatSurfaceToolNames } from './aiAgentSdkTools';
import { composeStaticSystemPrompt, DOMAIN_NOTES, listToolIndex, MAX_INLINE_ACTIONS, renderToolIndexByDomain } from './aiToolIndex';

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

  it('lists every chat-callable tool exactly once and mentions nothing unavailable', () => {
    const mentioned = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
    const set = new Set(names);
    const unknown = mentioned.filter((m) => !set.has(m) && !isActionToken(text, m));
    expect(unknown).toEqual([]);
    const listed = text.split('\n').filter((line) => line.startsWith('- **')).join('\n')
      .match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
    for (const n of names) expect(listed.filter((token) => token === n).length, n).toBe(1);
  });

  it('keeps the vulnerability tools findable with CVE vocabulary (#2605 pin moves here)', () => {
    expect(text).toContain('get_vulnerability_report');
    expect(text).toContain('get_device_vulnerabilities');
    expect(text).toContain('remediate_vulnerability');
    expect(text).toMatch(/CVE/);
  });

  it('carries vulnerability disambiguation and the empty-report caveat', () => {
    expect(DOMAIN_NOTES.patching).toContain('get_security_posture');
    expect(DOMAIN_NOTES.patching).toContain('manage_patches');
    expect(DOMAIN_NOTES.patching).toMatch(/no (?:correlated findings|findings are currently correlated)/);
    expect(DOMAIN_NOTES.patching).toContain('no vulnerabilities');
    expect(text).toContain(DOMAIN_NOTES.patching);
  });

  it.each([
    ['get_vulnerability_report'],
    ['manage_patches'],
    ['get_vulnerability_report', 'manage_patches'],
    ['get_vulnerability_report', 'get_security_posture'],
  ])('only mentions available tools in restricted indexes: %j', (...subset) => {
    const restricted = renderToolIndexByDomain(subset);
    const registered = new Set(getAllRegisteredToolNames());
    const mentioned = restricted.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
    expect(mentioned.filter((token) => registered.has(token) && !subset.includes(token))).toEqual([]);
    expect(restricted).toContain('no vulnerabilities');
    expect(restricted).toMatch(/no (?:correlated findings|findings are currently correlated)/);
  });

  it('places named patch prerequisites in the patching domain', () => {
    expect(DOMAIN_NOTES.patching).toContain('manage_update_rings');
    expect(DOMAIN_NOTES.patching).toContain('manage_policy_feature_link');
    expect(DOMAIN_NOTES.patching).toContain('featurePolicyId');
    expect(DOMAIN_NOTES.patching).toContain('third-party patch sources');
    expect(DOMAIN_NOTES.security ?? '').not.toContain('update ring');
  });

  it('filters patch prerequisites when either named tool is absent', () => {
    const both = renderToolIndexByDomain(['manage_update_rings', 'manage_policy_feature_link']);
    expect(both).toContain('featurePolicyId');
    expect(both).toContain('third-party patch sources');
    const rings = renderToolIndexByDomain(['manage_update_rings']);
    expect(rings).not.toContain('featurePolicyId');
    expect(rings).toContain('third-party patch sources');
    const links = renderToolIndexByDomain(['manage_policy_feature_link', 'manage_patches']);
    expect(links).not.toContain('featurePolicyId');
    expect(links).not.toContain('third-party patch sources');
  });

  it('filters execution lookup guidance when get_script_execution is absent', () => {
    expect(DOMAIN_NOTES.scripts).toContain('get_script_execution');
    expect(renderToolIndexByDomain(['get_script_execution'])).toContain('external runs');
    expect(renderToolIndexByDomain(['run_script'])).not.toContain('external runs');
  });

  // Full-control W02 (#6756), Todd 2026-10-22 option 2: action lists collapse
  // to "(N actions)" at 8+ actions so the 7 PSA/billing write tools fit the
  // index ceiling. Renderer only — the names stay in each tool's schema.
  it('inlines up to 7 action names and collapses 8+ to a count', () => {
    expect(MAX_INLINE_ACTIONS).toBe(7);
    const all = listToolIndex(getAllRegisteredToolNames());
    // No registered tool has exactly 7 actions today, so pin the largest one
    // that still inlines; the constant assertion above covers the boundary.
    const inline = all.filter((e) => e.actions.length > 0 && e.actions.length <= 7)
      .sort((a, b) => b.actions.length - a.actions.length)[0];
    const eight = all.find((e) => e.actions.length === 8);
    expect(inline, 'need a registered tool with 1-7 actions').toBeDefined();
    expect(eight, 'need a registered tool with exactly 8 actions').toBeDefined();
    expect(inline!.actions.length).toBeGreaterThanOrEqual(5);
    expect(eight!.actions).toHaveLength(8);
    expect(renderToolIndexByDomain([inline!.name])).toContain(`${inline!.name} (${inline!.actions.join('/')})`);
    const collapsed = renderToolIndexByDomain([eight!.name]);
    expect(collapsed).toContain(`${eight!.name} (8 actions)`);
    expect(collapsed).not.toContain(eight!.actions.join('/'));
  });

  it('skips names that have no domain instead of throwing', () => {
    expect(listToolIndex(['query_devices', 'propose_action_plan', 'not_a_tool']).map((e) => e.name)).toEqual(['query_devices']);
  });

  // Budget history: A-W02 set 5 KB; topology M4's chat tools
  // (diagnose_connectivity, get_diagnostic_run, get_link_evidence,
  // get_topology) took it to 5.5 KB (5188 bytes) after the DOMAIN_NOTES prose
  // had already been tightened once.
  it('stays small: the whole index is under 6.875 KB and every note under 400 chars', () => {
    // Ceiling raised to 6.5 KB (#6755; raised again to 6.75 KB for W02, below): W01 wired 32 more chat-callable tools
    // (measured 119280 -> 140468 registry bytes, see
    // docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-baseline.md
    // "Full-control W01 (#6755) delta"), which legitimately grows this
    // by-domain index text; W01 records prompt-size growth rather than gating
    // on it (spec D5), so the budget moves with it instead of masking a real,
    // intended addition. Topology M4 + W01 together measure 6310 bytes (the two
    // growths are additive: each tool adds its name to its domain line).
    // Any further raise needs a prompt-size review, not a bump.
    // #8167 W03: `edr_endpoint_action (isolate/unisolate/scan)` on the
    // Integrations line adds 46 bytes (6677 vs the 6656 limit). Paid for by
    // dropping the patching note's "Approve patches before install." (names no
    // tool), not by raising the ceiling. W03 PR-B's `sync_edr_data` (+15 bytes)
    // was absorbed by further tightening the scripts note.
    // #8742 W02: `send_endpoint_message (send/list/get)` on the Tickets line
    // took it to 6684. Paid for by tightening the scripts note's wording (same
    // guidance), not by raising the ceiling.
    // Trust Center W02i (`get_trust_page_status`) and #8584 (`list_device_restore_point_attempts`, Automations line)
    // are paid for by tightening the patching/scripts notes' wording (same guidance, same tools), not by raising the ceiling.
    // Tool Catalog W3 (#5218): +49 B flag-on (6576 -> 6625), 0 B default —
    // recorded in docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-baseline.md
    // ("Tool Catalog W3 delta"). Both fit under the existing ceiling, so the
    // 6.75 KB raise signed off for W3 was not taken; the flag-on prompt is
    // gated too (below).
    // Full-control W02 (#6756): 7 PSA/billing write tools (+343 B) paid for in
    // part by MAX_INLINE_ACTIONS 8 -> 7 (Todd 2026-10-22, option 2; -245 B):
    // main 6576 / 6625 -> 6674 default / 6723 flag-on, still over 6656. So the
    // 6.75 KB raise (6912 B) was taken 2026-10-22 for W02 (Todd, option 1);
    // the W3 sign-off was re-used. Headroom ~238 B default / ~189 B flag-on;
    // the manage_billing_catalog rename (D3) makes it 6682 / 6731 (~230 / ~181).
    // Any further raise needs a prompt-size review, not a bump.
    expect(INDEX_BUDGET_BYTES).toBe(7040);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(INDEX_BUDGET_BYTES);
    for (const note of Object.values(DOMAIN_NOTES)) expect(note!.length).toBeLessThanOrEqual(400);
  });

  it('with FLOWS_ENABLED=true the index stays under the ceiling and lists the flow tools', () => {
    vi.stubEnv('FLOWS_ENABLED', 'true');
    try {
      const flagOn = renderToolIndexByDomain(listChatSurfaceToolNames());
      for (const name of ['draft_flow', 'get_flow', 'list_flows', 'validate_flow']) expect(flagOn).toContain(name);
      expect(Buffer.byteLength(flagOn, 'utf8')).toBeLessThan(INDEX_BUDGET_BYTES);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('with FLOWS_ENABLED unset the index never mentions the flow tools', () => {
    expect(text).not.toMatch(/\b(draft_flow|validate_flow|get_flow|list_flows)\b/);
  });
});

// #8883 W5: +128 B (6656 -> 6784) for the three ticket routing tools on the
// Tickets line (+112 B: list_ticket_routing_rules, test_ticket_routing_rule,
// manage_ticket_routing_rules (create/update/reorder/delete)); measured 6714
// default / 6763 flag-on. Every SDK tool must carry a searchHint, so a new
// tool cannot stay out of the index, and paying 112 B by rewriting other
// domains' notes would change unrelated guidance. Flagged for prompt-size
// review in the PR.
// #6263 W05 PR B (#6268): +128 B (6784 -> 6912) for `ioc_hunt
// (list_rule_sets/preview_sweep/list_sweeps/sweep_status/sweep/cancel_sweep/import_iocs)`
// on the Security line (+97 B); measured 6811 default / 6860 flag-on (6714 /
// 6763 before). Pre-authorized by Todd 2026-10-24 (Gate B 5); action names and
// other domains' notes left unchanged.
// Merge of #6756 W02 (+~7 tools) with main's 6912 B ceiling: measured 6917 default /
// 6966 flag-on; reconciled to 6.875 KB (7040 B), pre-authorized by Todd 2026-10-24/25.
const INDEX_BUDGET_BYTES = 6.875 * 1024;

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

  it('flags ON (M365 + Google Workspace + AI script authoring + Flows): advertised set matches what buildBreezeSdkTools declares', () => {
    vi.stubEnv('M365_ENABLED', 'true');
    vi.stubEnv('GOOGLE_WORKSPACE_ENABLED', 'true');
    vi.stubEnv('BREEZE_AI_SCRIPT_AUTHORING_ENABLED', 'true');
    vi.stubEnv('FLOWS_ENABLED', 'true');
    try {
      assertNoDrift();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// Preserve the exact static prefix previously assembled inline by buildSystemPrompt.
it('composes byte-identically to the original production static prompt', () => {
  const names = listChatSurfaceToolNames();
  // #7582 appended the diagnosis + agent ground-truth block after the tail.
  const original = [AI_SYSTEM_PROMPT_BASE, renderToolIndexByDomain(names), AI_SYSTEM_PROMPT_TAIL, AI_SYSTEM_PROMPT_DIAGNOSIS].join('\n');
  expect(Buffer.from(composeStaticSystemPrompt(names))).toEqual(Buffer.from(original));
});
