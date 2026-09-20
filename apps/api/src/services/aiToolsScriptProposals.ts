/**
 * AI script authoring tools (spec §4.2).
 *
 * - propose_script (Tier 1): a proposal is INERT — nothing runs without an
 *   action intent — so authoring is auto-execute. The gate is run_script.
 * - get_script_proposal (Tier 1): org-scoped read.
 *
 * Registration here and in TOOL_TIERS is UNCONDITIONAL so the registry-parity
 * contract holds statically. `BREEZE_AI_SCRIPT_AUTHORING_ENABLED` gates the
 * SDK `tool()` definitions (the exposure gate — without one the model cannot
 * call these), the agent capability group, and both handlers below.
 */
import { proposeScriptInputSchema } from '@breeze/shared';
import { aiScriptAuthoringEnabled } from '../config/env';
import type { AiTool } from './aiTools';
import { verifyDeviceAccess } from './aiTools';
import type { AuthContext } from '../middleware/auth';
import {
  createScriptProposal, enqueueScriptReview, getScriptProposalForPrincipal,
  waitForReviewCompletion,
} from './scriptProposals';

/** Spec §4.2: the inline wait before propose_script returns `pending`. */
const INLINE_REVIEW_WAIT_MS = 45_000;

/**
 * The proposal's org comes from the TARGET DEVICE, never from `auth.orgId`
 * (#5682): a partner-scope token carries `orgId: null`, which inserted NULL
 * into `script_proposals.org_id` and killed AI script authoring for every MSP
 * tech. `verifyDeviceAccess` is the same org+site-gated resolution the
 * declarative `deviceArgs` gate already ran, so this re-resolve cannot widen
 * reach — it only reads back the org the caller was allowed to see.
 *
 * A proposal is a single row with a single `org_id`, so a set of devices
 * spanning two orgs has no honest answer: refuse rather than silently pinning
 * the batch to the first device's org.
 */
async function resolveProposalOrgId(
  deviceIds: string[],
  auth: AuthContext,
): Promise<{ orgId: string } | { error: string }> {
  const orgIds = new Set<string>();
  for (const deviceId of deviceIds) {
    const access = await verifyDeviceAccess(deviceId, auth);
    if ('error' in access) return { error: access.error };
    orgIds.add(access.device.orgId);
  }
  if (orgIds.size > 1) {
    return { error: 'invalid_input: all target devices must belong to one organization' };
  }
  // Fall back to the caller's own org only if a device somehow resolved
  // without one — the page-context org, exactly as routes/ai.ts resolves it.
  const [orgId] = [...orgIds];
  const resolved = orgId ?? auth.orgId;
  if (!resolved) return { error: 'invalid_input: could not resolve the organization for these devices' };
  return { orgId: resolved };
}

function disabled(): string {
  return JSON.stringify({ error: 'feature_disabled: AI script authoring is not enabled on this deployment' });
}

export function registerScriptProposalTools(aiTools: Map<string, AiTool>): void {
  const registerTool = (tool: AiTool): void => { aiTools.set(tool.definition.name, tool); };

  registerTool({
    tier: 1,
    domain: 'scripts',
    searchHint: 'AI-authored script proposals for review before execution',
    // deviceArgs gates every supplied id through the org+site verifyDeviceAccess
    // before the handler runs, so an author cannot propose against a device
    // they cannot see.
    deviceArgs: ['deviceIds'],
    definition: {
      name: 'propose_script',
      description:
        'Author a script as an immutable proposal for independent review. The proposal is scanned and classified immediately; a model review follows. Nothing runs until a human approves it through run_script with the returned proposalId. Use this only when no library script fits.',
      input_schema: {
        type: 'object' as const,
        properties: {
          language: { type: 'string', enum: ['powershell', 'bash', 'python', 'cmd'], description: 'Script language' },
          content: { type: 'string', description: 'The complete script body, max 64 KiB' },
          goal: { type: 'string', description: 'What problem this is meant to solve, in the user\'s terms' },
          expectedEffect: { type: 'string', description: 'What will change on the device' },
          verification: { type: 'object', description: 'A checkable claim: {kind: exit_code|service_running|process_absent|file_exists|output_matches, ...}' },
          rollbackNote: { type: 'string', description: 'How to undo this, if it can be undone' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Target device UUIDs, 1 to 10' },
          runAs: { type: 'string', enum: ['system', 'user'], description: 'Run context, default system' },
          timeoutSeconds: { type: 'number', description: 'Execution timeout, default 300, max 3600' },
          supersedesProposalId: { type: 'string', description: 'The proposal this revision replaces, after a Request changes' },
        },
        required: ['language', 'content', 'goal', 'expectedEffect', 'verification', 'deviceIds'],
      },
    },
    handler: async (input, auth) => {
      if (!aiScriptAuthoringEnabled()) return disabled();
      const parsed = proposeScriptInputSchema.safeParse(input);
      if (!parsed.success) {
        return JSON.stringify({ error: `invalid_input: ${parsed.error.issues.map((i) => i.message).join('; ')}` });
      }
      // The principal IS the author record. An agent run carries its run id
      // (`AuthContext.principal` = `{ kind: 'ai_agent'; agentId; runId }`); a
      // chat caller does not hand this handler the Breeze session id, so
      // `session_id` starts NULL and the SDK post-tool hook back-fills it
      // (aiAgentSdk.attachChatProposalToSession) — `author_kind` carries the
      // truth either way.
      const author = auth.principal.kind === 'ai_agent'
        ? { kind: 'agent_run' as const, agentRunId: auth.principal.runId }
        : { kind: 'chat_session' as const, sessionId: null };

      const resolvedOrg = await resolveProposalOrgId(parsed.data.deviceIds, auth);
      if ('error' in resolvedOrg) return JSON.stringify({ error: resolvedOrg.error });

      const { proposal, scan } = await createScriptProposal(
        auth, parsed.data, author, resolvedOrg.orgId);
      const staticScan = {
        basicHits: scan.basicHits, strictHits: scan.strictHits, touchClasses: scan.touchClasses,
      };

      // A BASIC hit STOPS here (spec §4.4): no model review, no budget
      // reservation, no approval card. The row stays as the audit trail.
      if (scan.basicHits.length > 0) {
        return JSON.stringify({
          proposalId: proposal.id, status: 'scan_rejected', staticScan,
          review: { status: 'not_requested' },
        });
      }

      await enqueueScriptReview({ proposalId: proposal.id, orgId: proposal.orgId, attempt: 1 });
      const review = await waitForReviewCompletion(proposal.id, INLINE_REVIEW_WAIT_MS);

      return JSON.stringify({
        proposalId: proposal.id,
        status: review?.status === 'completed' ? 'reviewed' : proposal.status,
        staticScan,
        review: review
          ? {
            status: review.status, riskTier: review.riskTier, summary: review.summary,
            goalMatch: review.goalMatch, reversible: review.reversible,
            verificationAdequate: review.verificationAdequate,
            recommendedAction: review.recommendedAction,
          }
          // The reviewer worker lands in W02, so this is the normal answer in
          // W01b. It means "not yet", never "failed".
          : { status: 'pending' },
      });
    },
  });

  registerTool({
    tier: 1,
    domain: 'scripts',
    searchHint: 'script proposal details, source and review status by ID',
    definition: {
      name: 'get_script_proposal',
      description:
        'Read a script proposal: its status, the static scan, the independent review verdict and findings, the human decision, any executions, and the verification result.',
      input_schema: {
        type: 'object' as const,
        properties: { proposalId: { type: 'string', description: 'Proposal UUID' } },
        required: ['proposalId'],
      },
    },
    handler: async (input, auth) => {
      if (!aiScriptAuthoringEnabled()) return disabled();
      const proposal = await getScriptProposalForPrincipal(auth, String(input.proposalId));
      if (!proposal) return JSON.stringify({ error: 'not_found: no such proposal in this organization' });
      return JSON.stringify({
        proposalId: proposal.id,
        status: proposal.status,
        riskTier: proposal.riskTier,
        goal: proposal.goal,
        expectedEffect: proposal.expectedEffect,
        language: proposal.language,
        runAs: proposal.runAs,
        timeoutSeconds: proposal.timeoutSeconds,
        targetDeviceIds: proposal.scopedDeviceIds ?? proposal.targetDeviceIds,
        staticScan: {
          basicHits: proposal.basicHits, strictHits: proposal.strictHits,
          touchClasses: proposal.touchClasses, scannerVersion: proposal.scannerVersion,
        },
        decision: {
          decidedBy: proposal.decidedBy, decidedAt: proposal.decidedAt, note: proposal.decisionNote,
        },
        intentId: proposal.intentId,
        verification: { verifiedAt: proposal.verifiedAt, result: proposal.verificationResult },
        expiresAt: proposal.expiresAt,
      });
    },
  });
}
