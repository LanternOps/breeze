import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { aiTools } from '../services/aiTools';
import { listFlowEligibleCoreTools } from '../services/flows/catalog';

// ============================================================================
// Tool catalog W04 (#5219), Open Decision 7 / quorum Q6 — every site that
// branches on the `ai_agent` principal is CLASSIFIED, not blanket-converted.
//
//  - `automation`: the rule means "no human present / no RBAC token / no
//    interactive approval surface / no secret reveal / no real users row". A
//    flow run is all of those too, so the site must use
//    `isAutomationPrincipal()` (ai_agent || flow) — never the raw comparison.
//  - `agent_only`: the rule needs the agent's identity or run state (agentId,
//    the agent run that owns an artifact/workspace/proposal, the agent-intent
//    lane). It stays agent-specific, and when a flow can reach it (one of the
//    tools that lead there is in `listFlowEligibleCoreTools()`), the file must
//    ALSO handle the flow principal explicitly (`flowGuard`). A flow run id is
//    never substituted for an agent id.
//
// Keys are `<path under apps/api/src>:<the trimmed source line>` — a snippet,
// never a line number (line-keyed contracts are a known trap in this repo,
// see ai_tools_contract_tests_line_keyed_trap). Identical lines in one file
// share one classification.
//
// The scan is the plan's inventory grep:
//   rg -n "kind === 'ai_agent'|kind !== 'ai_agent'|isAiAgentPrincipal\(|case 'ai_agent'|'ai_agent'[,\]]" apps/api/src --glob '!*.test.ts'
// plus `isAutomationPrincipal(` (so a converted site stays inventoried), minus
// comment lines. String uses that are not a principal branch (audit actor
// types, intent sources, ticket author kinds, AiInitiatorKind) are filtered
// DETERMINISTICALLY: by OUT_OF_SCOPE_SHAPES (a value tagged ai_agent) or by an
// explicit OUT_OF_SCOPE_SITES entry. Anything else fails as unclassified.
// ============================================================================

type Classification = 'automation' | 'agent_only';

export const REVIEWED_AI_AGENT_SITES: Record<string, Classification> = {
  // --- middleware/auth.ts --------------------------------------------------
  // The synthetic attribution id (agent id / flow id) must never reach
  // breeze.user_id or satisfy Shape-6 user-scoped RLS.
  'middleware/auth.ts:userId: isAutomationPrincipal(auth) || isPartnerServicePrincipal(auth)': 'automation',
  // requireScope / requirePermission / requireMfa / requireOrgAccess /
  // requireSiteAccess (identical lines) and requirePartner / requireOrg: a
  // machine principal never calls an HTTP route.
  'middleware/auth.ts:if (isAutomationPrincipal(auth)) {': 'automation',
  'middleware/auth.ts:if (auth && isAutomationPrincipal(auth)) {': 'automation',

  // --- RBAC / human-only / MFA gates ---------------------------------------
  // No role: the token-less fallbacks would grant everything.
  'services/aiGuardrails.ts:if (isAutomationPrincipal(auth)) {': 'automation',
  // MFA gate: like an agent, a flow has no session MFA claim; its Tier-3
  // authorization is the upstream approval (released intent / pre-approval).
  'services/aiToolMfaGate.ts:if (isAutomationPrincipal(auth)) return false;': 'automation',
  // Ticket W06 writes (#10160): a machine principal's user id is not a users
  // row, so uploaded_by_user_id / author FKs have no human to attribute.
  'services/aiToolsTicketAttachments.ts:if (isAutomationPrincipal(auth)) return agentRefusal(action);': 'automation',
  // Full-control W11 (#6781, W11-D8): audit-baseline writes and PAM writes store a users FK and are
  // human-only; neither an agent nor a flow is a person who can own the row.
  'services/aiToolsAuditBaselines.ts:if (isAutomationPrincipal(auth)) return automationRefusal(action);': 'automation',
  "services/aiToolsPamRules.ts:if (isAutomationPrincipal(auth)) return jsonError('PAM policy is changed by a person, not an automated run', 'AGENT_REFUSED');": 'automation',
  'services/aiToolsTicketOpsShared.ts:return isAutomationPrincipal(auth);': 'automation',
  // Same upstream-approval-instead-of-MFA rule for delivery-rail writes.
  "services/aiToolsDelivery.ts:if (!isAutomationPrincipal(auth) && !hasSatisfiedMfa(auth)) fail(403, 'MFA required');": 'automation',
  "services/topology/monitoringAuthority.ts:if (!isInteractiveUserSession(ctx.auth) || isAutomationPrincipal(ctx.auth)) {": 'automation',
  'services/topology/configurationObjects.ts:if (isAutomationPrincipal(ctx.auth) || !hasSatisfiedMfa(ctx.auth))': 'automation',
  'services/topology/diagnosticRuns.ts:if (!hasSatisfiedMfa(ctx.auth) || isAutomationPrincipal(ctx.auth)) {': 'automation',
  "services/topology/diagnosticRuns.ts:if (isAutomationPrincipal(ctx.auth)) throw new TopologyOperationError('human_approval_required', 403);": 'automation',
  'services/topology/templateLibrary.ts:if (isAutomationPrincipal(auth))': 'automation',
  "services/topology/aiDiagnosticApproval.ts:if (isAutomationPrincipal(current.auth)) throw new TopologyOperationError('human_approval_required', 403);": 'automation',
  'services/topology/siteConfiguration.ts:if (isAutomationPrincipal(ctx.auth) || !hasSatisfiedMfa(ctx.auth))': 'automation',
  'routes/alerts/alerts.ts:if (isAutomationPrincipal(auth)) {': 'automation',
  'services/aiToolsCompliance.ts:if (isAutomationPrincipal(auth)) return EXECUTABLE_RULES_MANAGE_POLICY_DENIED_MESSAGE;': 'automation',
  'services/aiToolsRestoreAuthorization.ts:if (isAutomationPrincipal(auth)) return fallback;': 'automation',
  'services/securityScanSweepTargets.ts:if (isAutomationPrincipal(auth)) return Promise.resolve(null);': 'automation',
  'services/aiAgents/access.ts:if (isAutomationPrincipal(auth)) {': 'automation',
  // A secret-bearing / end-user-visible / users-FK write needs a real person.
  "services/aiToolsDiagnosticAccess.ts:if (isAutomationPrincipal(auth)) return refuseAgentPrincipal('request_diagnostic_access');": 'automation',
  "services/aiToolsDiagnosticAccess.ts:if (isAutomationPrincipal(auth)) return refuseAgentPrincipal('revoke_diagnostic_access');": 'automation',
  "services/aiToolsMessaging.ts:if (isAutomationPrincipal(auth)) return jsonError('send_endpoint_message is not available to autonomous agents or flows');": 'automation',
  'services/aiToolsNetwork.ts:return isAutomationPrincipal(auth);': 'automation',
  'services/aiToolsUI.ts:return isAutomationPrincipal(auth);': 'automation',
  'services/aiToolsDns.ts:return isAutomationPrincipal(auth);': 'automation',
  'services/aiToolsPam.ts:return isAutomationPrincipal(auth);': 'automation',
  'services/aiToolsFleet.ts:return isAutomationPrincipal(auth);': 'automation',
  'services/edrProviders/actions.ts:if (isAutomationPrincipal(auth)) {': 'automation',
  // Unattended run_script dispatch ignores a caller-chosen runAs /
  // targetSessionId (falls back to the saved script's own).
  'services/aiToolsScripts.ts:const isUnattendedAgentDispatch = isAutomationPrincipal(auth);': 'automation',
  // No RBAC: the run-scoped (device-frame) pager, never the user-RBAC one.
  'services/aiToolsExportDatasets.ts:if (isAutomationPrincipal(req.auth)) return agentInventoryPager(req, false);': 'automation',
  'services/aiToolsExportDatasets.ts:if (isAutomationPrincipal(req.auth)) return agentInventoryPager(req, true);': 'automation',
  // Plan approval and a verified caller authorize a HUMAN, never a machine.
  'services/actionIntents/intentService.ts:if (!taskContext || isAutomationPrincipal(auth)) {': 'automation',
  "services/actionIntents/intentService.ts:if (agentRun || isAutomationPrincipal(auth)) await refuseCaller('technician_mismatch');": 'automation',
  // SITE_RESTRICTED_PRINCIPAL_KINDS: an org-bounded machine principal whose
  // site ceiling is its own `allowedSiteIds` (undefined for a flow — the
  // delegation ceiling is enforced at enable). Checked via AUTOMATION_KIND_SETS.
  "services/resilienceSiteAuthorization.ts:'ai_agent',": 'automation',
  // Task A9: starting a run uses the flow's delegation; only a person (or an
  // API key acting as its creator) may, never an agent or another flow.
  "services/flows/runService.ts:if (isAutomationPrincipal(auth) || !auth.user?.id) return { ok: false, error: 'interactive_user_required' };": 'automation',
  // W5 PR C (#5220): a HUMAN-lane tool run (chat / MCP) needs a person behind
  // the credential; the agent lane is the separate `agent_tier1` triggerer.
  "services/flows/toolRuns.ts:if (isAutomationPrincipal(auth) || !auth.user?.id) return false;": 'automation',

  // --- agent_only: needs the agent identity / agent run state --------------
  // Ticket actor attribution (agentId) and the agent-run triage lane.
  "services/aiToolsTicketing.ts:if (principal?.kind === 'ai_agent') {": 'agent_only',
  "services/aiToolsTicketing.ts:return isAiAgentPrincipal(auth) && auth.principal.kind === 'ai_agent' ? auth.principal.runId : null;": 'agent_only',
  "services/aiToolsTicketing.ts:return isAiAgentPrincipal(auth) && auth.principal.kind === 'ai_agent' ? auth.principal.agentId : null;": 'agent_only',
  // Workspace resources are owned by the agent run.
  "services/workspace/workspaceTools.ts:const runId = principal?.kind === 'ai_agent' ? principal.runId : undefined;": 'agent_only',
  // export_dataset artifacts are owned by the agent run.
  "services/aiToolsExport.ts:runId = auth.principal?.kind === 'ai_agent' ? auth.principal.runId : null;": 'agent_only',
  // Captured tool results are owned by an agent run or a chat session.
  "services/artifacts/toolResultCapture.ts:const runId = principal?.kind === 'ai_agent' ? principal.runId : null;": 'agent_only',
  // A script proposal's author record is the agent run.
  "services/aiToolsScriptProposals.ts:const author = auth.principal.kind === 'ai_agent'": 'agent_only',
  // Audit actor: an agent is audited as ai_agent with its agent id.
  "routes/remote/screenAccessConsentGate.ts:const actorType = kind === 'ai_agent'": 'agent_only',
  // Recovery authorization subjects rehydrate an AGENT RUN; the persisted
  // vocabulary deliberately has no flow kind.
  "services/recoveryAuthorizationSubject.ts:'ai_agent',": 'agent_only',
  "services/recoveryAuthorizationSubject.ts:case 'ai_agent': {": 'agent_only',
  "services/recoveryAuthorizationSubject.ts:case 'ai_agent':": 'agent_only',
  // The agent-intent lane of createActionIntent (source pairing, task
  // context, sweep scope, external-tool refusal, the human-lane site ceiling
  // that flows stay ON, agent Tier-2 intents, the agent-run load). Flow-origin
  // intents are Task A5; until then createActionIntent refuses them outright.
  "services/actionIntents/intentService.ts:const isAgentIntent = auth.principal.kind === 'ai_agent';": 'agent_only',
  "services/actionIntents/intentService.ts:if (auth.principal.kind !== 'ai_agent' && !input.planApproval) {": 'agent_only',
  "services/actionIntents/intentService.ts:if (input.scope && auth.principal.kind !== 'ai_agent') {": 'agent_only',
  "services/actionIntents/intentService.ts:if (auth.principal.kind === 'ai_agent') {": 'agent_only',
  "services/actionIntents/intentService.ts:auth.principal?.kind !== 'ai_agent'": 'agent_only',
  "services/actionIntents/intentService.ts:const agentTier2 = auth.principal.kind === 'ai_agent' && guardrail.tier === 2;": 'agent_only',
};

/**
 * How each agent_only site treats a flow principal. `reachableVia` names the
 * core tools that lead to the site; when any of them is flow-eligible the
 * site is reachable and `flowGuard` (a line in the same file that handles the
 * flow principal explicitly — a refusal, or for a pure audit-label site an
 * explicit non-agent label) is required. An unreachable site states why.
 */
const AGENT_ONLY_FLOW_HANDLING: Record<string, { reachableVia: readonly string[]; flowGuard?: string; unreachableBecause?: string }> = {
  "services/aiToolsTicketing.ts:if (principal?.kind === 'ai_agent') {": {
    reachableVia: ['manage_tickets'],
    flowGuard: 'if (isFlowPrincipal(auth) && !FLOW_TICKET_READ_ACTIONS.has(action)) return refuseFlowPrincipal(action);',
  },
  "services/aiToolsTicketing.ts:return isAiAgentPrincipal(auth) && auth.principal.kind === 'ai_agent' ? auth.principal.runId : null;": {
    reachableVia: ['manage_tickets', 'manage_ticket_checklist'],
    flowGuard: 'if (!reads.has(action) && isFlowPrincipal(auth)) return refuseFlowPrincipal(action);',
  },
  "services/aiToolsTicketing.ts:return isAiAgentPrincipal(auth) && auth.principal.kind === 'ai_agent' ? auth.principal.agentId : null;": {
    reachableVia: ['manage_tickets'],
    flowGuard: 'if (isFlowPrincipal(auth) && !FLOW_TICKET_READ_ACTIONS.has(action)) return refuseFlowPrincipal(action);',
  },
  "services/workspace/workspaceTools.ts:const runId = principal?.kind === 'ai_agent' ? principal.runId : undefined;": {
    reachableVia: ['workspace_run', 'workspace_stage', 'workspace_collect', 'workspace_cancel'],
    flowGuard: 'if (isFlowPrincipal(auth)) throw requiresRun();',
  },
  "services/aiToolsExport.ts:runId = auth.principal?.kind === 'ai_agent' ? auth.principal.runId : null;": {
    reachableVia: ['export_dataset'],
    flowGuard: 'if (isFlowPrincipal(auth)) return refuseFlowExport();',
  },
  "services/artifacts/toolResultCapture.ts:const runId = principal?.kind === 'ai_agent' ? principal.runId : null;": {
    // Every tool call passes through capture.
    reachableVia: ['get_device_details'],
    flowGuard: 'if (isFlowPrincipal(auth)) return null;',
  },
  "services/aiToolsScriptProposals.ts:const author = auth.principal.kind === 'ai_agent'": {
    reachableVia: ['propose_script'],
    flowGuard: "if (isFlowPrincipal(auth)) return JSON.stringify({ error: 'flow_principal_unsupported', action: 'propose_script' });",
  },
  "routes/remote/screenAccessConsentGate.ts:const actorType = kind === 'ai_agent'": {
    reachableVia: ['take_screenshot', 'analyze_screen', 'computer_control'],
    flowGuard: "if (isFlowPrincipal(actor)) return { actorType: 'system', actorId };",
  },
  "services/recoveryAuthorizationSubject.ts:'ai_agent',": {
    reachableVia: ['restore_c2c_items'],
    flowGuard: "case 'flow':",
  },
  "services/recoveryAuthorizationSubject.ts:case 'ai_agent': {": {
    reachableVia: ['restore_c2c_items'],
    flowGuard: "case 'flow':",
  },
  "services/recoveryAuthorizationSubject.ts:case 'ai_agent':": {
    reachableVia: ['restore_c2c_items'],
    flowGuard: "case 'flow':",
  },
  ...Object.fromEntries(
    [
      "services/actionIntents/intentService.ts:const isAgentIntent = auth.principal.kind === 'ai_agent';",
      "services/actionIntents/intentService.ts:if (auth.principal.kind !== 'ai_agent' && !input.planApproval) {",
      "services/actionIntents/intentService.ts:if (input.scope && auth.principal.kind !== 'ai_agent') {",
      "services/actionIntents/intentService.ts:if (auth.principal.kind === 'ai_agent') {",
      "services/actionIntents/intentService.ts:auth.principal?.kind !== 'ai_agent'",
      "services/actionIntents/intentService.ts:const agentTier2 = auth.principal.kind === 'ai_agent' && guardrail.tier === 2;",
    ].map((key) => [
      key,
      {
        // Any Tier-3 flow step parks an intent through createActionIntent.
        // Task A5: the flow principal has its own lane there (source 'flow',
        // flow_source_mismatch pairing, server-loaded run facts); every
        // agent-only site below stays agent-only.
        reachableVia: ['run_script'],
        flowGuard: "const flowPrincipal = auth.principal.kind === 'flow' ? auth.principal : null;",
      },
    ]),
  ),
};

/** Automation sites that are kind-set MEMBERS: the set must also hold 'flow'. */
const AUTOMATION_KIND_SETS: Record<string, string> = {
  "services/resilienceSiteAuthorization.ts:'ai_agent',": 'SITE_RESTRICTED_PRINCIPAL_KINDS',
};

/** Lines that are not a principal branch at all. Explicit, reviewed. */
const OUT_OF_SCOPE_SITES: Record<string, string> = {
  "services/flows/toolRuns.ts:agent_tier1: 'ai_agent',": 'W5 PR C: triggerer kind → flow_runs.triggered_via value, not a principal branch',
  "services/flows/agentFlowTools.ts:return startToolRun(gated, args, 'ai_agent', { kind: 'agent_tier1', agentRunId: run.id, orgId: run.orgId }, { parentAgentRunId: run.id });":
    'W5 PR C: the flow_runs.triggered_via lane value of an agent-started run, not a principal branch',
  "middleware/principalKind.ts:export function isAiAgentPrincipal(auth: Pick<AuthContext, 'principal'>): boolean {": 'the helper definition',
  "middleware/principalKind.ts:return auth.principal?.kind === 'ai_agent';": 'the helper definition',
  "middleware/principalKind.ts:export function isAutomationPrincipal(auth: Pick<AuthContext, 'principal'>): boolean {": 'the helper definition',
  'middleware/principalKind.ts:return isAiAgentPrincipal(auth) || isFlowPrincipal(auth);': 'the helper definition',
  "db/schema/aiInitiator.ts:export const aiInitiatorKindEnum = pgEnum('ai_initiator_kind', ['ai_assistant', 'ai_agent', 'flow']);": 'AiInitiatorKind pg enum',
  "db/schema/recoveryAuthorizationSubject.ts:sql`${table.authorizationPrincipalKind} IN ('user_session', 'client_user', 'api_key', 'oauth_grant', 'ai_agent', 'system', 'unknown')`,": 'persisted-kind CHECK',
  "db/schema/actionIntents.ts:export const actionIntentSourceEnum = ['chat', 'mcp_api', 'ai_agent', 'flow'] as const;": 'action_intents.source vocabulary',
  "db/schema/actionIntents.ts:'ai_agent',": 'origin_principal_kind vocabulary',
  "routes/partnerApi/schemas.ts:export const PARTNER_TICKET_ORIGIN_PRINCIPAL_KINDS = ['user', 'ai_agent', 'system', 'service_principal', 'unknown'] as const;": 'ticket origin vocabulary',
  "services/auditEvents.ts:case 'ai_agent': initiatedBy = 'ai'; break;": 'audit actorType switch',
  "services/aiOriginSummary.ts:} else if (kind === 'ai_agent' && row.aiAgentRunId) {": 'AiInitiatorKind, not the principal',
  "services/actionIntents/actorContext.ts:case 'ai_agent':": 'stored origin_principal_kind switch (its flow arm is Task A5)',
  "services/aiToolsFilesystem.ts:actorType: requestedBy ? 'user' : 'ai_agent',": 'audit actorType value',
  "services/ticketService.ts:case 'ai_agent': return actor.runId ? { agentRunId: actor.runId } : {};": 'TicketActor discriminant',
  "services/ticketService.ts:case 'ai_agent':": 'TicketActor discriminant',
  "services/ticketService.ts:case 'ai_agent': return 'ai_agent';": 'TicketActor discriminant',
};

/** Value shapes tagged ai_agent — records, not principal branches. */
const OUT_OF_SCOPE_SHAPES: ReadonlyArray<{ re: RegExp; why: string }> = [
  {
    re: /\b(?:kind|actor|actorType|authorType|resourceType|source|originPrincipalKind|principalKind|aiOriginKind)\s*:\s*'ai_agent'/,
    why: 'builds a value tagged ai_agent (principal/origin construction, audit actor, intent source, ticket author, resource type)',
  },
  { re: /\baiOrigin\??\.kind\b/, why: 'AiInitiatorKind — who DECIDED a device mutation, not the principal' },
];

const RAW_SITE = /kind === 'ai_agent'|kind !== 'ai_agent'|isAiAgentPrincipal\(|case 'ai_agent'|'ai_agent'[,\]]/;
const AUTOMATION_CALL = /isAutomationPrincipal\(/;

const API_SRC = path.resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

interface Hit { file: string; line: number; text: string; key: string }

const FILE_TEXT = new Map<string, string>();
function fileText(file: string): string {
  let text = FILE_TEXT.get(file);
  if (text === undefined) {
    text = readFileSync(path.join(API_SRC, file), 'utf8');
    FILE_TEXT.set(file, text);
  }
  return text;
}

const HITS: Hit[] = walk(API_SRC).flatMap((full) => {
  const file = path.relative(API_SRC, full).split(path.sep).join('/');
  return fileText(file)
    .split('\n')
    .map((raw, index) => ({ file, line: index + 1, text: raw.trim() }))
    .filter(({ text }) => !(text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')))
    .filter(({ text }) => RAW_SITE.test(text) || AUTOMATION_CALL.test(text))
    .map((hit) => ({ ...hit, key: `${hit.file}:${hit.text}` }));
});

function fileOf(key: string): string {
  return key.slice(0, key.indexOf('.ts:') + 3);
}

function isOutOfScope(hit: Hit): boolean {
  if (hit.key in OUT_OF_SCOPE_SITES) return true;
  if (hit.key in REVIEWED_AI_AGENT_SITES) return false;
  return OUT_OF_SCOPE_SHAPES.some(({ re }) => re.test(hit.text));
}

describe('automation principal sweep (tool catalog W04, #5219)', () => {
  it('scans a real inventory (an empty walk can never read green)', () => {
    expect(HITS.length).toBeGreaterThan(80);
    expect(new Set(HITS.map((h) => h.file)).size).toBeGreaterThan(40);
  });

  it('classifies every ai_agent principal site (unclassified ⇒ decide automation or agent_only)', () => {
    const unclassified = HITS.filter((h) => !isOutOfScope(h) && !(h.key in REVIEWED_AI_AGENT_SITES)).map(
      (h) => `${h.file}:${h.line}  ${h.text}`,
    );
    expect(
      unclassified,
      'Classify each line in REVIEWED_AI_AGENT_SITES: `automation` (no human / no RBAC token / no approval '
        + 'surface / no secret reveal ⇒ use isAutomationPrincipal) or `agent_only` (needs agentId / agent run '
        + 'state ⇒ keep, plus an explicit flow guard when a flow can reach it).',
    ).toEqual([]);
  });

  it('every classification and waiver still names a live line (no stale entries)', () => {
    const live = new Set(HITS.map((h) => h.key));
    const stale = [...Object.keys(REVIEWED_AI_AGENT_SITES), ...Object.keys(OUT_OF_SCOPE_SITES)].filter((k) => !live.has(k));
    expect(stale).toEqual([]);
    for (const { re, why } of OUT_OF_SCOPE_SHAPES) {
      expect(HITS.some((h) => re.test(h.text)), `shape rule never matches: ${why}`).toBe(true);
    }
  });

  it('no automation site still uses the raw ai_agent comparison', () => {
    const raw = HITS.filter(
      (h) => REVIEWED_AI_AGENT_SITES[h.key] === 'automation' && !(h.key in AUTOMATION_KIND_SETS) && RAW_SITE.test(h.text),
    ).map((h) => `${h.file}:${h.line}  ${h.text}`);
    expect(raw, 'an automation site must use isAutomationPrincipal(), not the agent-only comparison').toEqual([]);
  });

  it('every isAutomationPrincipal() call is a reviewed automation site', () => {
    const wrong = HITS.filter(
      (h) => AUTOMATION_CALL.test(h.text) && !(h.key in OUT_OF_SCOPE_SITES) && REVIEWED_AI_AGENT_SITES[h.key] !== 'automation',
    ).map((h) => `${h.file}:${h.line}  ${h.text}`);
    expect(wrong).toEqual([]);
  });

  it('automation kind sets admit the flow principal', () => {
    for (const [key, setName] of Object.entries(AUTOMATION_KIND_SETS)) {
      expect(REVIEWED_AI_AGENT_SITES[key], key).toBe('automation');
      const match = new RegExp(`${setName}\\s*=\\s*new Set<[^>]*>\\(\\[([\\s\\S]*?)\\]\\)`).exec(fileText(fileOf(key)));
      expect(match, `${setName} literal not found`).not.toBeNull();
      expect(match![1], `${setName} must include 'flow'`).toContain("'flow'");
      expect(match![1], `${setName} must still include 'ai_agent'`).toContain("'ai_agent'");
    }
  });

  it('every agent_only site is still an agent comparison and has a flow-handling record', () => {
    const agentOnly = Object.entries(REVIEWED_AI_AGENT_SITES).filter(([, c]) => c === 'agent_only').map(([k]) => k);
    expect(agentOnly.filter((k) => !(k in AGENT_ONLY_FLOW_HANDLING))).toEqual([]);
    expect(Object.keys(AGENT_ONLY_FLOW_HANDLING).filter((k) => REVIEWED_AI_AGENT_SITES[k] !== 'agent_only')).toEqual([]);
    for (const key of agentOnly) {
      expect(RAW_SITE.test(key.slice(fileOf(key).length + 1)), key).toBe(true);
    }
  });

  it('a flow-reachable agent_only site handles the flow principal explicitly; an unreachable one says why', () => {
    const eligible = new Set(listFlowEligibleCoreTools());
    expect(eligible.has('manage_tickets')).toBe(true); // sanity: the catalog really loaded
    const problems: string[] = [];
    for (const [key, handling] of Object.entries(AGENT_ONLY_FLOW_HANDLING)) {
      if (handling.reachableVia.length === 0) problems.push(`${key}: reachableVia is empty`);
      for (const tool of handling.reachableVia) {
        if (!aiTools.has(tool)) problems.push(`${key}: reachableVia names unregistered tool ${tool}`);
      }
      const reachable = handling.reachableVia.some((tool) => eligible.has(tool));
      if (reachable) {
        const guard = handling.flowGuard;
        if (!guard) {
          problems.push(`${key}: reachable from a flow (${handling.reachableVia.join(', ')}) but has no flowGuard`);
          continue;
        }
        if (!/isFlowPrincipal\(|'flow'/.test(guard)) problems.push(`${key}: flowGuard does not name the flow principal`);
        const lines = fileText(fileOf(key)).split('\n').map((l) => l.trim());
        if (!lines.includes(guard)) problems.push(`${key}: flowGuard line not found in ${fileOf(key)}: ${guard}`);
      } else if (!handling.unreachableBecause) {
        problems.push(`${key}: not flow-reachable — state unreachableBecause`);
      }
    }
    expect(problems).toEqual([]);
  });
});
