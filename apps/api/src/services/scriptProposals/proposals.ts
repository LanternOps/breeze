import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  type ProposeScriptInput, type ScriptProposalStatus, type ScriptScanResult, scanScriptContent,
} from '@breeze/shared';
import { db } from '../../db';
import {
  scriptProposalReviews,
  scriptProposals,
  type ScriptProposalReviewRow,
  type ScriptProposalRow,
} from '../../db/schema/scriptProposals';
import { sha256Content } from '../scriptVersions';
import type { AuthContext } from '../../middleware/auth';

export type ScriptProposalAuthor =
  // sessionId is nullable: the chat SDK's tool handlers receive `(input, auth)`
  // and the Breeze session id is not one of the arguments. The SDK's
  // post-tool hook back-fills `session_id` from the tool output's proposalId
  // (see aiAgentSdk.ts), so `author_kind` is the column that is always
  // truthful at insert time.
  | { kind: 'chat_session'; sessionId: string | null }
  | { kind: 'agent_run'; agentRunId: string };

const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Create an immutable, content-addressed proposal.
 *
 * The scan runs BEFORE the insert and its verdict is part of the row, never a
 * later update: `content`, `content_digest`, `basic_hits`, `strict_hits`,
 * `touch_classes` and `scanner_version` are all covered by the immutability
 * trigger, so what a reviewer and an approver see is what was scanned.
 *
 * A BASIC hit lands the row in `scan_rejected` and STOPS (spec §4.4): no model
 * review is requested, no approval card is ever built, and no budget is
 * reserved. The row is still written so the attempt is auditable — a rejected
 * proposal is exactly the forensic trail you want when an assistant was steered
 * into writing something destructive.
 */
export async function createScriptProposal(
  auth: AuthContext,
  input: ProposeScriptInput,
  author: ScriptProposalAuthor,
): Promise<{ proposal: ScriptProposalRow; scan: ScriptScanResult }> {
  const scan = scanScriptContent(input.content, input.language);
  const status: ScriptProposalStatus = scan.basicHits.length > 0 ? 'scan_rejected' : 'proposed';

  const [proposal] = await db
    .insert(scriptProposals)
    .values({
      orgId: auth.orgId!,
      authorKind: author.kind,
      sessionId: author.kind === 'chat_session' ? author.sessionId : null,
      agentRunId: author.kind === 'agent_run' ? author.agentRunId : null,
      language: input.language,
      content: input.content,
      contentDigest: sha256Content(input.content),
      timeoutSeconds: input.timeoutSeconds,
      runAs: input.runAs,
      goal: input.goal,
      expectedEffect: input.expectedEffect,
      verification: input.verification,
      rollbackNote: input.rollbackNote ?? null,
      targetDeviceIds: input.deviceIds,
      scannerVersion: scan.scannerVersion,
      basicHits: scan.basicHits,
      strictHits: scan.strictHits,
      touchClasses: scan.touchClasses,
      status,
      revision: 1,
      supersedesId: input.supersedesProposalId ?? null,
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
    })
    .returning();

  if (!proposal) throw new Error('Failed to create script proposal');
  return { proposal, scan };
}

/**
 * Back-fill `session_id` on a chat-authored proposal once the SDK's post-tool
 * hook knows the proposal id (the tool handler itself never sees the Breeze
 * session id). Org-scoped and `session_id IS NULL`-guarded, so a foreign-org
 * id or an already-attributed row is a no-op — the immutability trigger also
 * refuses a NULL→non-NULL→other rewrite. Returns whether a row was written.
 */
export async function attachProposalToSession(
  proposalId: string,
  orgId: string,
  sessionId: string,
): Promise<boolean> {
  // `.returning` rather than an affected-row count: the count's shape differs
  // between drivers (postgres.js `count`, pg `rowCount`) and the repo's CAS
  // idiom (intentService.transitionIntent) reads the returned ids instead.
  const rows = await db
    .update(scriptProposals)
    .set({ sessionId })
    .where(and(
      eq(scriptProposals.id, proposalId),
      eq(scriptProposals.orgId, orgId),
      isNull(scriptProposals.sessionId),
    ))
    .returning({ id: scriptProposals.id });
  return rows.length === 1;
}

/** Org-scoped read. Returns null rather than throwing on a cross-org id. */
export async function getScriptProposalForPrincipal(
  auth: AuthContext,
  proposalId: string,
): Promise<ScriptProposalRow | null> {
  const [row] = await db
    .select()
    .from(scriptProposals)
    .where(and(eq(scriptProposals.id, proposalId), eq(scriptProposals.orgId, auth.orgId!)))
    .limit(1);
  return row ?? null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

/**
 * CAS on status. Returns false — never throws — when the row has already moved,
 * so a caller in a request transaction can branch instead of aborting the
 * transaction (a caught error inside `withDbAccessContext` still poisons the
 * enclosing tx and turns a mapped 409 into a 500 at commit).
 */
export async function transitionProposal(
  tx: Tx,
  proposalId: string,
  from: ScriptProposalStatus[],
  to: ScriptProposalStatus,
  patch: Partial<ScriptProposalRow> = {},
): Promise<boolean> {
  const rows = await tx
    .update(scriptProposals)
    .set({ ...patch, status: to })
    .where(and(eq(scriptProposals.id, proposalId), inArray(scriptProposals.status, from)))
    .returning({ id: scriptProposals.id });
  return rows.length === 1;
}

/** The revision loop: the old row becomes terminal and can never be consumed. */
export async function supersedeProposal(tx: Tx, oldId: string, newId: string): Promise<void> {
  await transitionProposal(
    tx, oldId,
    ['proposed', 'reviewed', 'changes_requested', 'review_failed', 'scan_rejected'],
    'superseded',
    { decisionNote: `Superseded by proposal ${newId}` },
  );
}

/**
 * Atomically claim the proposal for exactly one intent.
 *
 * The `intent_id IS NULL` predicate is the whole mutual exclusion: two
 * concurrent `run_script { proposalId }` calls both read `reviewed`, both try
 * this, and exactly one UPDATE matches. Status is left at `reviewed` — the
 * approval lifecycle belongs to the intent, and the proposal only records that
 * it has been spoken for. `expires_at > now()` is re-checked here rather than
 * trusted from the earlier read.
 */
export async function consumeProposalForIntent(
  tx: Tx,
  proposalId: string,
  intentId: string,
): Promise<boolean> {
  const rows = await tx
    .update(scriptProposals)
    .set({ intentId })
    .where(and(
      eq(scriptProposals.id, proposalId),
      isNull(scriptProposals.intentId),
      eq(scriptProposals.status, 'reviewed'),
      sql`${scriptProposals.expiresAt} > now()`,
    ))
    .returning({ id: scriptProposals.id });
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Unattended lane readers (W04, #5612). Plain in-context reads — they run on
// whatever connection the caller holds (the intent-creation transaction, the
// release worker's system context) and never escalate.
// ---------------------------------------------------------------------------

/** The proposal row, org-pinned. `null` when absent or in another org. */
type ReadExecutor = Pick<typeof db, 'select'>;

export async function loadProposalForRelease(
  tx: ReadExecutor,
  proposalId: string,
  orgId: string,
): Promise<ScriptProposalRow | null> {
  const [row] = await tx
    .select()
    .from(scriptProposals)
    .where(and(eq(scriptProposals.id, proposalId), eq(scriptProposals.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * The proposal's LATEST completed MODEL review — the row the lane pins by id
 * in its evidence and re-checks at release ("still the operative review").
 * Static-scan rows are not reviews in this sense.
 */
export async function latestCompletedReview(
  tx: ReadExecutor,
  proposalId: string,
): Promise<ScriptProposalReviewRow | null> {
  const [row] = await tx
    .select()
    .from(scriptProposalReviews)
    .where(and(
      eq(scriptProposalReviews.proposalId, proposalId),
      eq(scriptProposalReviews.reviewerKind, 'model'),
      eq(scriptProposalReviews.status, 'completed'),
    ))
    .orderBy(desc(scriptProposalReviews.createdAt))
    .limit(1);
  return row ?? null;
}
