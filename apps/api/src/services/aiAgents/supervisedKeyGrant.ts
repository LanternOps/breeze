// apps/api/src/services/aiAgents/supervisedKeyGrant.ts
/**
 * P2-5 (#4192, Task A2-5) — the PROMOTE executor.
 *
 * The one and only writer that ADDS a colon key to an organization's
 * `ai_agents.actAssets.supervisedActionKeys` — the list `attemptPolicyDecision`
 * consults to release a Tier-3 intent without human fanout. It runs from the
 * `manage_ai_agents:authorize_supervised_key` tool handler, i.e. only ever as
 * the effect of a Tier-3 FOUR-EYES action intent that a second human approved
 * (`services/aiToolsAiAgentGovernance.ts`).
 *
 * APPROVAL TIME IS NOT EXECUTION TIME. Everything the approver relied on is
 * re-established here, under the per-tuple advisory lock, immediately before
 * the write:
 *
 *   - the feature flag (`BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED`) is re-read
 *     LIVE — a flag flipped off during the approval window must not grant;
 *   - the authorizing intent is re-loaded and must name THIS org and carry no
 *     `requesting_agent_run_id` (human origin);
 *   - eligibility is recomputed from the evidence ledger, and the partner
 *     ceiling is re-checked — a key demoted or dropped from the baseline in
 *     the meantime is refused.
 *
 * Every one of those is a REFUSAL, never a silent skip: the handler turns a
 * `SupervisedKeyGrantError` into a returned tool error, which the release
 * paths terminalize as `failed:tool_returned_error` rather than recording a
 * grant that never happened as a success.
 *
 * TENANCY. The whole executor runs in ONE system transaction (the partner
 * baseline row is invisible to an org-scoped reader), so — per this repo's
 * invariant — every statement predicates on `org_id`/`partner_id` explicitly
 * even though RLS passes unconditionally there. `orgId` itself is never
 * trusted from tool arguments: the handler has already compared it against
 * the executing auth context's org, and the first thing below re-compares it
 * against the intent's own immutable `org_id`.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AiAgentKind, AiAgentPolicy } from '@breeze/shared';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
// Direct module imports, NOT the ../../db/schema barrel — same reason
// graduationService.ts and effectivePolicy.ts give: this module is reachable
// from the intent-release path, and pulling the barrel would force every
// partial-mock unit test of that path to stub the entire schema surface.
import { actionIntents } from '../../db/schema/actionIntents';
import { aiAgentGraduation } from '../../db/schema/aiAgentGraduation';
import { aiAgents, type AiAgentRow } from '../../db/schema/aiAgents';
import { organizations } from '../../db/schema/orgs';
import { policyDecideEnabled } from '../../config/env';
import { createAuditLog } from '../auditService';
import { AgentAccessDeniedError } from './access';
import { withAgentRowLocked } from './agentService';
import { mergeAgentPolicies, normalizeAgentPolicy } from './effectivePolicy';
import { evaluateGraduation, withGraduationLock } from './graduationService';

/**
 * Why a grant was refused. Every member terminalizes the release as
 * `failed:tool_returned_error` with this code as the reason.
 *
 * Three of these are not in the plan's original union and are recorded here
 * as deliberate additions:
 *   - `org_mismatch` — the controller's ruling requires the executor to
 *     re-assert `args.orgId === intent.orgId`; the plan named no code for
 *     the refusal it mandates.
 *   - `no_authorizing_intent` — the tool was reached without a release
 *     context, or the intent row is gone. A grant with no recorded
 *     authorizing approval has no provenance, so it fails closed.
 */
export type SupervisedKeyGrantCode =
  | 'policy_decide_disabled'
  | 'not_eligible'
  | 'needs_partner_baseline'
  | 'agent_not_found'
  | 'already_granted'
  | 'non_human_origin'
  | 'org_mismatch'
  | 'no_authorizing_intent';

export class SupervisedKeyGrantError extends Error {
  constructor(public readonly code: SupervisedKeyGrantCode, message: string) {
    super(message);
    this.name = 'SupervisedKeyGrantError';
  }
}

export interface AuthorizeSupervisedKeyInput {
  /**
   * The org the key is granted for. NOT trusted from tool arguments: the
   * handler compares it against the executing auth context (which the release
   * path pins to the intent's `org_id`), and the intent re-load below compares
   * it again against the immutable column.
   */
  orgId: string;
  kind: AiAgentKind;
  opKey: string;
  /** The four-eyes intent whose release is executing this grant. */
  intentId: string;
  /** The human the release path rebuilt the auth context from. */
  actorUserId: string;
}

export interface AuthorizeSupervisedKeyResult {
  /** The EFFECTIVE agent id — the partner baseline row, what evidence is keyed by. */
  agentId: string;
  /** The ORG row the key actually landed on (cloned from effective when absent). */
  orgAgentId: string;
  /** The org row's supervised keys AFTER the append, sorted. */
  keys: string[];
}

/** Join the ambient system context, or open one. Mirrors `graduationService.ts`. */
async function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, 'aiAgents.supervisedKeyGrant'));
}

/**
 * The org row a fresh clone must carry so the agent keeps behaving EXACTLY as
 * it does today. A row built from schema defaults would land `enabled: false`,
 * `mode: 'off'` and an empty allowlist — i.e. promoting a key would silently
 * turn the org's agent off, which is the opposite of what the approver
 * authorized.
 *
 * The material is `mergeAgentPolicies(partner, null, …).effective`, NOT
 * `resolveEffectiveAgentSystem`: that loader additionally forces
 * `enabled: false` when the `BREEZE_AI_AGENTS_ENABLED` kill switch is off, and
 * persisting a kill-switch artifact into a policy row would outlive the switch.
 * `allowedModels` is irrelevant to this branch by construction — it only ever
 * selects between an ORG model and the partner's, and this branch runs only
 * when there is no org row — so the merge is called with `null` rather than
 * paying for an `ai_budgets` read whose value cannot change the outcome.
 *
 * Two fields deliberately do NOT come from `effective`:
 *   - `instructions` stays NULL. The effective value is the RENDERED
 *     `[partner guidance]…` block; storing it as the ORG's own instructions
 *     would make the next merge wrap it a second time inside
 *     `[organization guidance]`. Partner instructions already flow through
 *     the merge, so NULL is the neutral override.
 *   - `supervisedActionKeys` stays `[]`, which is what the effective policy
 *     already reports for an org with no row (C3: the partner list is a
 *     CEILING, never an inherited grant). The key is appended afterwards, by
 *     the one writer allowed to do it.
 *
 * Two things `createAgent` does that this deliberately does NOT:
 *
 *   - `ensureManagedTriageAutomation`. The partner baseline's own managed
 *     automation already fires for every org beneath it, and the admission
 *     gate resolves the EFFECTIVE agent for the device's org (an org override
 *     wins over the managed baseline — see `automationRuntime.ts`'s
 *     `ai_triage` dispatch). Seeding a second, org-scoped automation would add
 *     a duplicate row to the customer's Automations list for a policy override
 *     they never asked to create.
 *   - `publishPolicyChanged`. The `ai.agent.policy_changed` event has no
 *     subscriber today (`agentService.ts`'s own TODO), and this executor has
 *     no `AuthContext` to attribute one with — the audit row below is the
 *     record of the change.
 *
 * A NOTE FOR REVIEWERS: cloning materializes the partner's CURRENT policy as
 * an org override, so from here on the org follows the partner only where the
 * merge is tighten-only (a partner that later NARROWS still wins; a partner
 * that later WIDENS does not reach this org). That is inherent to the plan's
 * "clone the effective policy" instruction — the alternative, a row of schema
 * defaults, would disable the agent outright — and is why the clone happens
 * only when no org row exists at all.
 */
function cloneValuesFromEffective(
  orgId: string,
  kind: AiAgentKind,
  partnerRow: AiAgentRow,
  actorUserId: string,
): typeof aiAgents.$inferInsert {
  const effective: AiAgentPolicy = mergeAgentPolicies(
    normalizeAgentPolicy(partnerRow),
    null,
    { allowedModels: null },
  ).effective;

  return {
    orgId,
    partnerId: null,
    kind,
    name: partnerRow.name,
    enabled: effective.enabled,
    mode: effective.mode,
    model: effective.model,
    toolAllowlist: effective.toolAllowlist,
    protectedResources: effective.protectedResources,
    limits: effective.limits,
    triggers: effective.triggers,
    recipients: effective.recipients,
    actAssets: { ...effective.actAssets, supervisedActionKeys: [] },
    instructions: null,
    cooldownSeconds: effective.cooldownSeconds,
    createdBy: actorUserId,
    lastUpdatedBy: actorUserId,
    updatedAt: new Date(),
  };
}

/** The live ORG override row for `(org, kind)`, SELECT … FOR UPDATE. */
async function lockOrgRow(orgId: string, kind: AiAgentKind): Promise<AiAgentRow | null> {
  const [row] = await db
    .select()
    .from(aiAgents)
    .where(and(
      eq(aiAgents.orgId, orgId),
      eq(aiAgents.kind, kind),
      isNull(aiAgents.disabledAt),
    ))
    .limit(1)
    .for('update');
  return row ?? null;
}

/**
 * Grants one supervised action key to one organization's agent.
 *
 * Ordering is load-bearing. The advisory lock is taken as soon as the
 * `(org, agent, op_key)` tuple is known and held for the rest of the
 * transaction, so this executor, `refreshGraduationRow` and the demote path
 * can never interleave on the same tuple. Inside it the PARTNER baseline is
 * locked before the ORG row: every writer that touches both takes them in
 * that order, which is what makes a deadlock structurally impossible rather
 * than merely unlikely.
 */
export async function authorizeSupervisedKey(
  input: AuthorizeSupervisedKeyInput,
): Promise<AuthorizeSupervisedKeyResult> {
  const { orgId, kind, opKey, intentId, actorUserId } = input;

  // Read LIVE, before anything else — the whole point is that the flag may
  // have moved since the approval was raised. No I/O, so it costs nothing to
  // be first.
  if (!policyDecideEnabled()) {
    throw new SupervisedKeyGrantError(
      'policy_decide_disabled',
      'Policy-decided releases are disabled; the supervised key was not granted',
    );
  }

  return inSystemDbContext(async () => {
    // (1) The authorizing intent. `org_id` and `requesting_agent_run_id` are
    // both immutable columns on `action_intents`, so this is the authoritative
    // answer to "which org did a human approve this for, and was it a human".
    const [intent] = await db
      .select({
        id: actionIntents.id,
        orgId: actionIntents.orgId,
        requestingAgentRunId: actionIntents.requestingAgentRunId,
      })
      .from(actionIntents)
      .where(eq(actionIntents.id, intentId))
      .limit(1);
    if (!intent) {
      throw new SupervisedKeyGrantError(
        'no_authorizing_intent',
        'No approved action intent authorizes this grant',
      );
    }
    if (intent.orgId !== orgId) {
      throw new SupervisedKeyGrantError(
        'org_mismatch',
        'The grant names a different organization than the approved intent',
      );
    }
    // An `ai_agent` principal can never reach this tool (AGENT_HUMAN_ONLY_TOOLS
    // in aiGuardrails.ts denies it above the allowlist), so this is
    // defence-in-depth against a row written by any future path that skips it:
    // an agent that could grant itself unattended authority is the one
    // escalation no approval scope contains.
    if (intent.requestingAgentRunId !== null) {
      throw new SupervisedKeyGrantError(
        'non_human_origin',
        'Supervised keys may only be granted by a human-originated intent',
      );
    }

    // (2) Resolve the EFFECTIVE agent id — always the PARTNER baseline row,
    // which is what every evidence row and every graduation row is keyed by.
    // Pinned through the organization's own partner, never a caller-named one.
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) {
      throw new SupervisedKeyGrantError('agent_not_found', 'Organization not found');
    }
    const [baseline] = await db
      .select({ id: aiAgents.id })
      .from(aiAgents)
      .where(and(
        eq(aiAgents.partnerId, org.partnerId),
        isNull(aiAgents.orgId),
        eq(aiAgents.kind, kind),
        isNull(aiAgents.disabledAt),
      ))
      .limit(1);
    if (!baseline) {
      throw new SupervisedKeyGrantError(
        'agent_not_found',
        'No partner baseline agent of this kind exists for this organization',
      );
    }
    const agentId = baseline.id;

    return withGraduationLock(orgId, agentId, opKey, async () => {
      // (3) Eligibility, recomputed from the ledger under the lock. `promoted`
      // means the effective grant already holds the key: refuse rather than
      // re-stamp, so the graduation row keeps pointing at the intent that
      // actually granted it.
      const graduation = await evaluateGraduation(orgId, agentId, opKey);
      if (graduation.state === 'promoted') {
        throw new SupervisedKeyGrantError('already_granted', `"${opKey}" is already authorized`);
      }
      if (graduation.blockedReason === 'needs_partner_baseline') {
        throw new SupervisedKeyGrantError(
          'needs_partner_baseline',
          `"${opKey}" is no longer inside the partner baseline ceiling`,
        );
      }
      if (graduation.state !== 'eligible') {
        throw new SupervisedKeyGrantError(
          'not_eligible',
          `"${opKey}" is no longer eligible for promotion (${graduation.blockedReason ?? 'not eligible'})`,
        );
      }

      // (4) PARTNER first, ORG second — see the function docstring.
      const [partnerRow] = await db
        .select()
        .from(aiAgents)
        .where(and(
          eq(aiAgents.partnerId, org.partnerId),
          isNull(aiAgents.orgId),
          eq(aiAgents.kind, kind),
          isNull(aiAgents.disabledAt),
        ))
        .limit(1)
        .for('update');
      // Identity, not mere existence: a baseline disabled and replaced between
      // the unlocked read above and this lock is a DIFFERENT agent, and the
      // evidence this promotion rests on belongs to the old one.
      if (!partnerRow || partnerRow.id !== agentId) {
        throw new SupervisedKeyGrantError(
          'agent_not_found',
          'The partner baseline agent changed while the grant was being released',
        );
      }

      let orgRow = await lockOrgRow(orgId, kind);
      const cloned = orgRow === null;
      if (!orgRow) {
        // ON CONFLICT DO NOTHING against the partial unique index, then
        // re-read under the lock: a concurrent creator may have won, and the
        // append below must land on whichever row actually exists.
        await db
          .insert(aiAgents)
          .values(cloneValuesFromEffective(orgId, kind, partnerRow, actorUserId))
          .onConflictDoNothing({
            target: [aiAgents.orgId, aiAgents.kind],
            where: sql`${aiAgents.disabledAt} is null`,
          });
        orgRow = await lockOrgRow(orgId, kind);
        if (!orgRow) {
          throw new SupervisedKeyGrantError(
            'agent_not_found',
            'The organization agent row could not be created for this grant',
          );
        }
      }
      const orgAgentId = orgRow.id;

      // (5) Append through the canonical `actAssets` writer. It re-takes the
      // row lock this transaction already holds (a no-op) rather than issuing
      // a bare UPDATE, so every writer of this column goes through one place.
      let keys: string[];
      try {
        keys = await withAgentRowLocked(null, orgAgentId, async (locked) => {
          const stored = normalizeAgentPolicy(locked);
          const current = stored.actAssets.supervisedActionKeys ?? [];
          if (current.includes(opKey)) {
            throw new SupervisedKeyGrantError('already_granted', `"${opKey}" is already authorized`);
          }
          const next = [...current, opKey].sort();
          await db
            .update(aiAgents)
            .set({
              actAssets: { ...stored.actAssets, supervisedActionKeys: next },
              lastUpdatedBy: actorUserId,
              updatedAt: new Date(),
            })
            .where(eq(aiAgents.id, orgAgentId));
          return next;
        }, { orgId });
      } catch (err) {
        if (err instanceof AgentAccessDeniedError) {
          throw new SupervisedKeyGrantError(
            'agent_not_found',
            'The organization agent row disappeared while the grant was being released',
          );
        }
        throw err;
      }

      // (6) Identifiers only — never a rationale, never the approver's or the
      // model's prose (this row is read back into operator-facing surfaces).
      await createAuditLog({
        orgId,
        actorType: 'user',
        actorId: actorUserId,
        action: 'ai.agent.supervised_key.authorized',
        resourceType: 'ai_agent',
        resourceId: orgAgentId,
        details: {
          agentId,
          orgAgentId,
          kind,
          opKey,
          intentId,
          clonedFromEffective: cloned,
        },
        result: 'success',
      });

      const promotedAt = new Date();
      await db
        .insert(aiAgentGraduation)
        .values({
          orgId,
          agentId,
          opKey,
          state: 'promoted',
          promotedAt,
          promotedIntentId: intentId,
          updatedAt: promotedAt,
        })
        .onConflictDoUpdate({
          target: [aiAgentGraduation.orgId, aiAgentGraduation.agentId, aiAgentGraduation.opKey],
          set: {
            state: 'promoted',
            promotedAt,
            promotedIntentId: intentId,
            // A promotion ENDS a demotion: leaving `demoted_at` set would keep
            // the evidence window clamped at the old demotion and make the
            // freshly promoted key read as blocked on the next refresh.
            demotedAt: null,
            demoteReason: null,
            demoteRunId: null,
            demoteWatchId: null,
            updatedAt: promotedAt,
          },
        });

      return { agentId, orgAgentId, keys };
    });
  });
}
