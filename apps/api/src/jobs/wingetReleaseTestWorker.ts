/**
 * Winget Release Test Worker (stub)
 *
 * Records status transitions for a queued release test. The actual
 * AI-driven test orchestration is implemented in T28.
 *
 * Idempotency: enqueueWingetReleaseTest uses ON CONFLICT DO NOTHING so
 * duplicate enqueues for the same (catalog_id, version) are no-ops.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { thirdPartyReleaseTests, thirdPartyPackageCatalog } from '../db/schema';

export interface EnqueueArgs {
  catalogId: string;
  version: string;
}

export interface EnqueueResult {
  testId: string | null;
  alreadyExisted: boolean;
}

export async function enqueueWingetReleaseTest({ catalogId, version }: EnqueueArgs): Promise<EnqueueResult> {
  if (!catalogId || !version) {
    return { testId: null, alreadyExisted: false };
  }

  // Only enqueue for Breeze-tested entries.
  const [catalog] = await db
    .select({ id: thirdPartyPackageCatalog.id, breezeTested: thirdPartyPackageCatalog.breezeTested })
    .from(thirdPartyPackageCatalog)
    .where(eq(thirdPartyPackageCatalog.id, catalogId))
    .limit(1);

  if (!catalog || !catalog.breezeTested) {
    return { testId: null, alreadyExisted: false };
  }

  const [inserted] = await db
    .insert(thirdPartyReleaseTests)
    .values({ catalogId, version, status: 'queued' })
    .onConflictDoNothing({ target: [thirdPartyReleaseTests.catalogId, thirdPartyReleaseTests.version] })
    .returning({ id: thirdPartyReleaseTests.id });

  if (inserted) {
    return { testId: inserted.id, alreadyExisted: false };
  }

  // Already queued - return the existing row id for callers that want it.
  const [existing] = await db
    .select({ id: thirdPartyReleaseTests.id })
    .from(thirdPartyReleaseTests)
    .where(
      and(
        eq(thirdPartyReleaseTests.catalogId, catalogId),
        eq(thirdPartyReleaseTests.version, version)
      )
    )
    .limit(1);

  return { testId: existing?.id ?? null, alreadyExisted: true };
}

/**
 * Stub worker - to be replaced in T28 by the real AI runner.
 * Marks a queued test as running -> completed (skipped).
 */
export async function executeWingetReleaseTest({ testId }: { testId: string }): Promise<void> {
  await db
    .update(thirdPartyReleaseTests)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(thirdPartyReleaseTests.id, testId));

  // PHASE 9 NEXT TASK (T28): dispatch to AI test runner here.
  await db
    .update(thirdPartyReleaseTests)
    .set({
      status: 'completed',
      result: 'skipped',
      log: 'AI runner not yet implemented',
      completedAt: new Date(),
    })
    .where(eq(thirdPartyReleaseTests.id, testId));
}
