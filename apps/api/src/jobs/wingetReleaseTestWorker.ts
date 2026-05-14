/**
 * Winget Release Test Worker
 *
 * Idempotency: enqueueWingetReleaseTest uses ON CONFLICT DO NOTHING so
 * duplicate enqueues for the same (catalog_id, version) are no-ops.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { thirdPartyReleaseTests, thirdPartyPackageCatalog } from '../db/schema';
import { runWingetReleaseTest } from '../services/aiPatchTestRunner';

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

export async function executeWingetReleaseTest({ testId }: { testId: string }): Promise<void> {
  const [row] = await db
    .select({
      id: thirdPartyReleaseTests.id,
      catalogId: thirdPartyReleaseTests.catalogId,
      version: thirdPartyReleaseTests.version,
      packageId: thirdPartyPackageCatalog.packageId,
    })
    .from(thirdPartyReleaseTests)
    .innerJoin(
      thirdPartyPackageCatalog,
      eq(thirdPartyReleaseTests.catalogId, thirdPartyPackageCatalog.id)
    )
    .where(eq(thirdPartyReleaseTests.id, testId))
    .limit(1);

  if (!row) return;

  await db
    .update(thirdPartyReleaseTests)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(thirdPartyReleaseTests.id, testId));

  let runResult: { result: 'pass' | 'fail' | 'inconclusive'; notes: string; log: string };
  try {
    runResult = await runWingetReleaseTest({ packageId: row.packageId, version: row.version });
  } catch (err) {
    runResult = {
      result: 'inconclusive',
      notes: err instanceof Error ? err.message : 'unknown error',
      log: '',
    };
  }

  await db
    .update(thirdPartyReleaseTests)
    .set({
      status: 'completed',
      result: runResult.result,
      log: `${runResult.notes ? runResult.notes + '\n\n' : ''}${runResult.log}`,
      completedAt: new Date(),
    })
    .where(eq(thirdPartyReleaseTests.id, testId));

  await db
    .update(thirdPartyPackageCatalog)
    .set({
      lastTestedAt: new Date(),
      lastTestedVersion: row.version,
      lastTestedResult: runResult.result,
    })
    .where(eq(thirdPartyPackageCatalog.id, row.catalogId));
}
