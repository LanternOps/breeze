import { BREEZE_AI_GUARDRAILS_CORE } from './aiAgentSystemPrompt';

// Approximate tool count stated in the instructions below. Kept as a rounded
// literal (not derived from the aiTools registry at runtime) so this string
// module stays decoupled from the heavy tool registry — mcpGuidancePromptTools
// .test.ts asserts it stays within tolerance of the live count and fails loudly
// if the two drift apart.
export const MCP_TOOL_COUNT_APPROX = 190;

export const MCP_SERVER_INSTRUCTIONS = `You are connected to Breeze RMM — a multi-tenant Remote Monitoring and Management platform for MSPs. This server exposes ~${MCP_TOOL_COUNT_APPROX} tools for managing devices, alerts, patches, backups, security, tickets, and configuration policies.

## Tenant hierarchy
Partner (MSP) → Organization (customer) → Site (location) → Device Group → Device. You can only see and act within the organizations your API key/token grants access to.

## How to choose among the tools
1. Resolve context first: use resolve_device_context or query_devices to find the exact device/org before acting.
2. Read before write: prefer query_* and get_* tools to understand state before any manage_* or execute_* call.
3. One target at a time unless the user explicitly asks for a fleet-wide operation.

${BREEZE_AI_GUARDRAILS_CORE}

## Common workflows
For frequent MSP tasks, use the guided prompts: breeze-fleet-triage, breeze-device-investigate, breeze-patch-remediate, breeze-incident-kickoff, breeze-turnkey-setup.`;

export interface McpPromptDefinition {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  referencedTools: string[];
  render: (args: Record<string, string>) => string;
}

const scopeSuffix = (scope?: string) => (scope ? ` scoped to ${scope}` : ' across all organizations you can access');

export const MCP_PROMPTS: McpPromptDefinition[] = [
  {
    name: 'breeze-fleet-triage',
    description: 'Read-only health sweep of the fleet — what needs attention right now.',
    arguments: [{ name: 'scope', description: 'Optional org or site to scope the sweep', required: false }],
    referencedTools: ['get_fleet_status', 'get_fleet_health', 'manage_alerts', 'query_devices', 'manage_patches', 'get_sla_breaches'],
    render: (a) => `Triage the Breeze RMM fleet${scopeSuffix(a.scope)}. Perform a READ-ONLY sweep and produce ONE prioritized "what needs attention now" summary. Steps:
1. Overall posture: get_fleet_status and get_fleet_health.
2. Active alerts: manage_alerts (action=list).
3. Offline devices: query_devices (status=offline).
4. Failed/pending patches: manage_patches (action=list).
5. SLA breaches: get_sla_breaches.
Do NOT perform any mutation. Rank findings by severity and lead with the most urgent.`,
  },
  {
    name: 'breeze-device-investigate',
    description: 'Deep-dive one device and summarize likely root cause (read-only).',
    arguments: [{ name: 'device', description: 'Device name, hostname, or id', required: true }],
    referencedTools: ['resolve_device_context', 'query_devices', 'get_device_details', 'analyze_metrics', 'search_agent_logs', 'get_device_vulnerabilities'],
    render: (a) => `Investigate the device "${a.device ?? '(unspecified)'}" in Breeze RMM. Steps:
1. Resolve it with resolve_device_context (or query_devices to search by name); ECHO the resolved device + organization back to the user.
2. Pull get_device_details, analyze_metrics, and recent logs via search_agent_logs.
3. Check get_device_vulnerabilities.
4. Summarize the likely root cause and recommended next actions.
This is a read-only investigation — do not run commands or mutations without explicit user confirmation.`,
  },
  {
    name: 'breeze-patch-remediate',
    description: 'Safely patch a target — scan, confirm, apply (touches Tier-3 tools).',
    arguments: [{ name: 'target', description: 'Device, site, or org to patch', required: true }],
    referencedTools: ['resolve_device_context', 'query_devices', 'manage_patches'],
    render: (a) => `Help the technician safely patch "${a.target ?? '(unspecified)'}". Steps:
1. Resolve the target (device, site, or org) and ECHO the resolved target + organization back to the user.
2. Scan for missing patches: manage_patches (action=scan). Present the gaps.
3. STOP and ask the user to explicitly CONFIRM before applying — installing patches is a destructive, approval-gated (Tier-3) operation.
4. Only after explicit confirmation, apply: manage_patches (action=install). Never patch beyond the confirmed target.
If the server rejects a call, surface the rejection rather than retrying.`,
  },
  {
    name: 'breeze-incident-kickoff',
    description: 'Open and structure an incident with timeline, evidence, and report.',
    arguments: [
      { name: 'summary', description: 'Short description of what is wrong', required: true },
      { name: 'scope', description: 'Affected org/site/device', required: false },
    ],
    referencedTools: ['create_incident', 'get_incident_timeline', 'collect_evidence', 'generate_incident_report', 'manage_tickets'],
    render: (a) => `Open and structure a Breeze RMM incident. Summary: "${a.summary ?? '(unspecified)'}"${a.scope ? `; scope: ${a.scope}` : ''}. Steps:
1. ECHO the resolved organization/scope, then create the incident with create_incident.
2. Build a timeline with get_incident_timeline.
3. Collect supporting evidence with collect_evidence.
4. Generate an incident report with generate_incident_report.
If the user wants customer-facing tracking, open or link a ticket with manage_tickets.`,
  },
  {
    name: 'breeze-turnkey-setup',
    description: 'Opinionated baseline configuration wizard — partner-wide by default.',
    arguments: [{ name: 'scope', description: 'partner (all orgs) or a specific org; defaults to partner-wide', required: false }],
    referencedTools: ['manage_configuration_policy', 'manage_update_rings', 'manage_backup_configs', 'manage_peripheral_policies', 'manage_dns_policy', 'manage_policy_feature_link', 'apply_configuration_policy'],
    render: (a) => `Set up a recommended baseline configuration in Breeze RMM${a.scope ? ` for ${a.scope}` : ''}. DEFAULT to partner-wide ownership (ownerScope=partner) so one policy applies to all of the MSP's organizations — ECHO the resolved organization/partner scope back to the user, CONFIRM the ownerScope=partner default, and PREVIEW each policy before applying it.

Walk through these categories, creating each via a Configuration Policy (manage_configuration_policy) with the appropriate prerequisite policy + feature link (manage_policy_feature_link), then assign with apply_configuration_policy:
1. Patch rings/cadence (manage_update_rings): pilot ring patches on release; production ring 7-day deferral; security/critical auto-approve at 3-day deferral; feature updates deferred 30 days; reboots in an off-hours maintenance window.
2. Backup SLA (manage_backup_configs): daily backup, RPO 24h, retention 30 days, alert if no successful backup in 48h.
3. DNS security (manage_dns_policy): enable filtering; block malware/phishing/C2/newly-registered-domain categories.
4. Peripheral policy (manage_peripheral_policies): block unauthorized USB mass-storage by default; allow HID.
5. Config/CIS baseline: apply CIS Level 1 baseline for the device OS via the policy's security/compliance feature (inlineSettings).
6. Core alert rules via the policy's alert_rule feature (inlineSettings): device offline > 15 min; disk > 90%; sustained CPU > 95% for 10 min; failed backup; critical patch missing > 7 days; reliability-score drop.

These are recommended defaults — let the user adjust values before applying. Never assign a policy without confirming the target scope.`,
  },
];

export function listMcpPrompts() {
  return MCP_PROMPTS.map((p) => ({ name: p.name, description: p.description, arguments: p.arguments }));
}

export function hasMcpPrompt(name: string): boolean {
  return MCP_PROMPTS.some((p) => p.name === name);
}

export function getMcpPrompt(name: string, args: Record<string, string> = {}) {
  const prompt = MCP_PROMPTS.find((p) => p.name === name);
  if (!prompt) throw new Error(`Unknown prompt: ${name}`);
  return {
    description: prompt.description,
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: prompt.render(args) } }],
  };
}
