/**
 * AI script authoring W06 (#5618) — live-DB coverage for
 * loadScriptProposalReviewerDisagreements (services/scriptProposals/
 * metrics.ts), the hand-written raw SQL behind GET /ai/admin/script-
 * proposals-metrics. Every ai_admin.test.ts case mocks db.execute directly,
 * so the query text itself — table/column names, the enum literals, the
 * DISTINCT ON dedup, and the decided_by IS NOT NULL lane-exclusion — has
 * never actually run against Postgres. This repo's own history (CLAUDE.md's
 * tenancy section) is that raw SQL bugs are caught by live-DB tests, not
 * code review or mocks.
 *
 * Calls the extracted function directly rather than routing through the
 * full routes/ai.ts (a large file with many transitive service imports that
 * do not resolve cleanly under the integration Vite/vitest environment,
 * unlike the unit test which mocks every one of those imports away before
 * loading it).
 */
import './setup';
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';

import { getTestDb } from './setup';
import { withSystemDbAccessContext } from '../../db';
import { scriptProposalReviews, scriptProposals } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { loadScriptProposalReviewerDisagreements } from '../../services/scriptProposals/metrics';

async function insertProposal(
  orgId: string,
  overrides: Partial<typeof scriptProposals.$inferInsert> & { decidedBy?: string | null },
) {
  const [row] = await withSystemDbAccessContext(() =>
    getTestDb()
      .insert(scriptProposals)
      .values({
        orgId,
        authorKind: 'chat_session',
        language: 'bash',
        content: `echo ${randomUUID()}`,
        contentDigest: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        timeoutSeconds: 60,
        goal: 'test',
        expectedEffect: 'test',
        verification: { kind: 'exit_code', equals: 0 },
        targetDeviceIds: [],
        scannerVersion: '2026-09-11.1',
        status: 'proposed',
        riskTier: 'low',
        ...overrides,
      })
      .returning(),
  );
  return row!;
}

async function insertModelReview(orgId: string, proposalId: string, recommendedAction: 'approve' | 'changes' | 'reject') {
  await withSystemDbAccessContext(() =>
    getTestDb().insert(scriptProposalReviews).values({
      orgId,
      proposalId,
      reviewerKind: 'model',
      status: 'completed',
      recommendedAction,
      riskTier: 'low',
    }),
  );
}

describe('loadScriptProposalReviewerDisagreements — raw SQL against live Postgres', () => {
  it('counts every disagreement status correctly, excludes lane auto-decisions, and dedups to the latest review', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const approver = await createUser({ partnerId: partner.id, orgId: org.id });

    // 1. approve -> rejected: humanRejectedAfterApprove
    const p1 = await insertProposal(org.id, { status: 'rejected', decidedBy: approver.id });
    await insertModelReview(org.id, p1.id, 'approve');

    // 2. approve -> changes_requested: ALSO humanRejectedAfterApprove (the fix)
    const p2 = await insertProposal(org.id, { status: 'changes_requested', decidedBy: approver.id });
    await insertModelReview(org.id, p2.id, 'approve');

    // 3. reject -> approved: humanApprovedAfterReject
    const p3 = await insertProposal(org.id, { status: 'approved', decidedBy: approver.id });
    await insertModelReview(org.id, p3.id, 'reject');

    // 4. reject -> verification_failed: ALSO humanApprovedAfterReject (the fix
    // — the human approved despite the reject recommendation, and the run's
    // own verification later failed; this must still count as a disagreement).
    const p4 = await insertProposal(org.id, { status: 'verification_failed', decidedBy: approver.id });
    await insertModelReview(org.id, p4.id, 'reject');

    // 5. Lane auto-decision (decided_by NULL): must be excluded entirely,
    // even though its status/recommendation would otherwise match arm 1.
    const p5 = await insertProposal(org.id, { status: 'rejected', decidedBy: null });
    await insertModelReview(org.id, p5.id, 'approve');

    // 6. Two reviews on the same proposal: only the LATEST (by created_at)
    // must count. The earliest review recommends 'reject' (would not match
    // arm 1 alone) while the latest recommends 'approve' against a
    // 'rejected' status — proving DISTINCT ON picks the latest, not an
    // aggregate over every review the proposal ever received.
    const p6 = await insertProposal(org.id, { status: 'rejected', decidedBy: approver.id });
    await insertModelReview(org.id, p6.id, 'reject');
    await new Promise((r) => setTimeout(r, 10));
    await insertModelReview(org.id, p6.id, 'approve');

    // Out of window: created far enough in the past that the default 7-day
    // caller window would exclude it, proving the date filter actually binds.
    const oldSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const p7 = await withSystemDbAccessContext(() =>
      getTestDb()
        .insert(scriptProposals)
        .values({
          orgId: org.id, authorKind: 'chat_session', language: 'bash', content: 'echo old',
          contentDigest: randomUUID().replace(/-/g, '').padEnd(64, '0'), timeoutSeconds: 60,
          goal: 'test', expectedEffect: 'test', verification: { kind: 'exit_code', equals: 0 },
          targetDeviceIds: [], scannerVersion: '2026-09-11.1', status: 'rejected', riskTier: 'low',
          decidedBy: approver.id, createdAt: oldSince,
        })
        .returning(),
    );
    await insertModelReview(org.id, p7[0]!.id, 'approve');

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const until = new Date();
    const result = await withSystemDbAccessContext(() =>
      loadScriptProposalReviewerDisagreements(org.id, since, until),
    );

    // p1, p2, p6 -> humanRejectedAfterApprove (3); p3, p4 -> humanApprovedAfterReject (2);
    // p5 excluded (lane); p7 excluded (out of window).
    expect(result).toEqual({ humanRejectedAfterApprove: 3, humanApprovedAfterReject: 2 });
  });
});
