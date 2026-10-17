/**
 * #8852 W03 — nightly AI tool output retention against real Postgres, through
 * the unprivileged `breeze_app` pool (forced RLS): a write that forgot to
 * elect system scope matches zero rows here and fails these tests.
 *
 * Pins Review Focus 4 (an interrupted run is resumable and never re-scrubs a
 * tombstone) and 5 (a scrubbed session is not resumable from the raw SDK
 * transcript, and `read_artifact` on an old handle refuses).
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import { aiDataPolicies, aiMessages, aiRunArtifacts, aiSessions, aiToolExecutions } from '../../db/schema';
import {
  runAiToolOutputRetention,
  scrubOrgToolOutputs,
} from '../../jobs/aiToolOutputRetention';
import { storeSdkSessionPointer } from '../../services/aiSdkSessionPointer';
import { findArtifactForAuth, findArtifactForCaller } from '../../services/artifacts/artifactService';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY_MS);
const OPTS = { batchSize: 100, maxBatches: 10, now: NOW };

async function insertSession(orgId: string, sdkSessionId: string | null, createdAt = daysAgo(60)): Promise<string> {
  const [row] = await getTestDb()
    .insert(aiSessions)
    .values({ orgId, model: 'claude-test', sdkSessionId, createdAt, lastActivityAt: createdAt, updatedAt: createdAt })
    .returning({ id: aiSessions.id });
  return row!.id;
}

async function insertToolPair(sessionId: string, createdAt: Date, output: Record<string, unknown> = { content: 'C:\\Users\\bob\\secret.txt contents' }) {
  const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
  await getTestDb().insert(aiMessages).values({
    sessionId, role: 'tool_use', toolName: 'file_operations', toolInput: { action: 'read' }, toolUseId, createdAt,
  });
  const [result] = await getTestDb().insert(aiMessages).values({
    sessionId, role: 'tool_result', toolName: 'file_operations', toolOutput: output, toolUseId, createdAt,
  }).returning({ id: aiMessages.id });
  const [exec] = await getTestDb().insert(aiToolExecutions).values({
    sessionId, messageId: result!.id, toolName: 'file_operations', toolInput: { action: 'read' }, toolOutput: output,
    status: 'completed', createdAt, completedAt: createdAt,
  }).returning({ id: aiToolExecutions.id });
  return { toolUseId, messageId: result!.id, executionId: exec!.id };
}

async function insertCapture(orgId: string, sessionId: string, createdAt: Date, createdByTool = 'file_operations'): Promise<string> {
  const [row] = await getTestDb().insert(aiRunArtifacts).values({
    orgId, sessionId, kind: 'input_capture', name: `${createdByTool}.redacted.txt`, contentType: 'text/plain',
    bytes: 10, sha256: 'a'.repeat(64), blobKey: `test/${randomUUID()}`, headPreview: 'HEAD secret', tailPreview: 'TAIL secret',
    createdByTool, createdAt, expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
  }).returning({ id: aiRunArtifacts.id });
  return row!.id;
}

async function message(id: string) {
  const [row] = await getTestDb().select().from(aiMessages).where(eq(aiMessages.id, id));
  return row!;
}
async function execution(id: string) {
  const [row] = await getTestDb().select().from(aiToolExecutions).where(eq(aiToolExecutions.id, id));
  return row!;
}
async function session(id: string) {
  const [row] = await getTestDb().select().from(aiSessions).where(eq(aiSessions.id, id));
  return row!;
}
async function artifact(id: string) {
  const [row] = await getTestDb().select().from(aiRunArtifacts).where(eq(aiRunArtifacts.id, id));
  return row!;
}

describe('aiToolOutputRetention (real Postgres, breeze_app pool)', () => {
  let partnerId: string;
  let orgId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    partnerId = partner.id;
    orgId = (await createOrganization({ partnerId, name: 'Retention Org' })).id;
  });

  it('tombstones old tool outputs, keeps tool_use_id and audit columns, and leaves recent rows alone', async () => {
    const sessionId = await insertSession(orgId, 'sdk-old');
    const old = await insertToolPair(sessionId, daysAgo(40));
    const recent = await insertToolPair(sessionId, daysAgo(10));

    const result = await scrubOrgToolOutputs(orgId, 30, OPTS);

    const scrubbedMsg = await message(old.messageId);
    expect(scrubbedMsg.toolOutput).toEqual({ _retention: 'scrubbed', at: NOW.toISOString() });
    expect(scrubbedMsg.toolUseId).toBe(old.toolUseId);
    const scrubbedExec = await execution(old.executionId);
    expect(scrubbedExec.toolOutput).toEqual({ _retention: 'scrubbed', at: NOW.toISOString() });
    expect(scrubbedExec.status).toBe('completed');
    expect(scrubbedExec.toolInput).toEqual({ action: 'read' });

    expect((await message(recent.messageId)).toolOutput).toEqual({ content: 'C:\\Users\\bob\\secret.txt contents' });
    expect((await execution(recent.executionId)).toolOutput).toEqual({ content: 'C:\\Users\\bob\\secret.txt contents' });

    expect(result.messages.deleted).toBe(1);
    expect(result.executions.deleted).toBe(1);
  });

  it('clears the resumable SDK session in the same pass and reports the old id for transcript deletion', async () => {
    const sessionId = await insertSession(orgId, 'sdk-raw-transcript');
    await insertToolPair(sessionId, daysAgo(40));

    const result = await scrubOrgToolOutputs(orgId, 30, OPTS);

    expect((await session(sessionId)).sdkSessionId).toBeNull();
    expect(result.clearedSdkSessionIds).toEqual(['sdk-raw-transcript']);
  });

  it('is idempotent: a second run changes nothing and never re-scrubs a tombstone', async () => {
    const sessionId = await insertSession(orgId, 'sdk-1');
    const old = await insertToolPair(sessionId, daysAgo(40));
    await scrubOrgToolOutputs(orgId, 30, OPTS);
    const first = await message(old.messageId);

    const later = new Date(NOW.getTime() + DAY_MS);
    const again = await scrubOrgToolOutputs(orgId, 30, { ...OPTS, now: later });

    expect(again.messages.deleted).toBe(0);
    expect(again.executions.deleted).toBe(0);
    expect(again.clearedSdkSessionIds).toEqual([]);
    expect((await message(old.messageId)).toolOutput).toEqual(first.toolOutput);
  });

  it('resumes an interrupted (batch-capped) run without re-scrubbing what the first run finished', async () => {
    const sessionId = await insertSession(orgId, 'sdk-cap');
    const pairs = [await insertToolPair(sessionId, daysAgo(50)), await insertToolPair(sessionId, daysAgo(45)), await insertToolPair(sessionId, daysAgo(40))];

    const capped = await scrubOrgToolOutputs(orgId, 30, { batchSize: 1, maxBatches: 1, now: NOW });
    expect(capped.messages).toMatchObject({ deleted: 1, batches: 1, hasMore: true });
    // The FIRST scrubbed row already cleared its session: a crash right here
    // cannot leave a tombstoned row behind a still-resumable raw transcript.
    expect((await session(sessionId)).sdkSessionId).toBeNull();

    const firstPass = await getTestDb().select().from(aiMessages).where(inArray(aiMessages.id, pairs.map((p) => p.messageId)));
    const doneFirst = firstPass.filter((r) => (r.toolOutput as { _retention?: string })._retention === 'scrubbed');
    expect(doneFirst).toHaveLength(1);

    const resumeAt = new Date(NOW.getTime() + 60_000);
    const resumed = await scrubOrgToolOutputs(orgId, 30, { batchSize: 100, maxBatches: 10, now: resumeAt });
    expect(resumed.messages.deleted).toBe(2);
    expect(resumed.messages.hasMore).toBe(false);

    const after = await getTestDb().select().from(aiMessages).where(inArray(aiMessages.id, pairs.map((p) => p.messageId)));
    for (const row of after) expect((row.toolOutput as { _retention?: string })._retention).toBe('scrubbed');
    // The row the first run scrubbed keeps its ORIGINAL tombstone.
    expect(after.find((r) => r.id === doneFirst[0]!.id)!.toolOutput).toEqual({ _retention: 'scrubbed', at: NOW.toISOString() });
  });

  it('does not clear a fresh SDK session started after the scrub (no new rows expired)', async () => {
    const sessionId = await insertSession(orgId, 'sdk-before');
    await insertToolPair(sessionId, daysAgo(40));
    await scrubOrgToolOutputs(orgId, 30, OPTS);
    // The user resumes: a fresh transcript holding only new content.
    await getTestDb().update(aiSessions).set({ sdkSessionId: 'sdk-fresh' }).where(eq(aiSessions.id, sessionId));

    const next = await scrubOrgToolOutputs(orgId, 30, { ...OPTS, now: new Date(NOW.getTime() + DAY_MS) });

    expect(next.clearedSdkSessionIds).toEqual([]);
    expect((await session(sessionId)).sdkSessionId).toBe('sdk-fresh');
  });

  it('defers a session that is live right now (a message in the quiet window) to a later run', async () => {
    const sessionId = await insertSession(orgId, 'sdk-live');
    const old = await insertToolPair(sessionId, daysAgo(40));
    await getTestDb().insert(aiMessages).values({ sessionId, role: 'user', content: 'still here', createdAt: new Date(NOW.getTime() - 10 * 60_000) });

    const result = await scrubOrgToolOutputs(orgId, 30, OPTS);

    expect(result.messages.deleted).toBe(0);
    expect(result.executions.deleted).toBe(0);
    expect((await message(old.messageId)).toolOutput).toEqual({ content: 'C:\\Users\\bob\\secret.txt contents' });
    expect((await session(sessionId)).sdkSessionId).toBe('sdk-live');
  });

  it('never touches another org', async () => {
    const otherOrg = (await createOrganization({ partnerId, name: 'Other Org' })).id;
    const otherSession = await insertSession(otherOrg, 'sdk-other');
    const other = await insertToolPair(otherSession, daysAgo(40));

    await scrubOrgToolOutputs(orgId, 30, OPTS);

    expect((await message(other.messageId)).toolOutput).toEqual({ content: 'C:\\Users\\bob\\secret.txt contents' });
    expect((await session(otherSession)).sdkSessionId).toBe('sdk-other');
  });

  it('expires old input_capture artifacts, blanks their previews, and read_artifact on the old handle refuses', async () => {
    const sessionId = await insertSession(orgId, null);
    const oldCapture = await insertCapture(orgId, sessionId, daysAgo(40));
    const recentCapture = await insertCapture(orgId, sessionId, daysAgo(5));
    const oldExport = await insertCapture(orgId, sessionId, daysAgo(40), 'export_dataset');
    const anchor = { orgId, sessionId };

    // Positive control: the capture is readable by its own session before the scrub.
    const { withSystemDbAccessContext } = await import('../../db');
    expect(await withSystemDbAccessContext(() => findArtifactForCaller(oldCapture, anchor))).not.toBeNull();

    const result = await scrubOrgToolOutputs(orgId, 30, OPTS);

    expect(result.artifacts.deleted).toBe(1);
    const scrubbed = await artifact(oldCapture);
    expect(scrubbed.headPreview).toBe('');
    expect(scrubbed.tailPreview).toBe('');
    expect(scrubbed.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await withSystemDbAccessContext(() => findArtifactForCaller(oldCapture, anchor))).toBeNull();

    // The handler, end to end over the same row.
    vi.stubEnv('BREEZE_AI_ARTIFACT_CAPTURE_ENABLED', 'true');
    try {
      const { registerArtifactTools } = await import('../../services/aiToolsArtifacts');
      const tools = new Map();
      registerArtifactTools(tools);
      const out = await withSystemDbAccessContext(() =>
        tools.get('read_artifact').handler({ handle: oldCapture }, {} as never, { captureAnchor: anchor } as never));
      expect(JSON.parse(out as string)).toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
    } finally {
      vi.unstubAllEnvs();
    }

    // Recent captures and intentional exports keep their own TTL.
    expect((await artifact(recentCapture)).headPreview).toBe('HEAD secret');
    expect((await artifact(oldExport)).headPreview).toBe('HEAD secret');
  });

  it('the REST download refuses a scrubbed capture before the sweeper removes its blob', async () => {
    const sessionId = await insertSession(orgId, null);
    const oldCapture = await insertCapture(orgId, sessionId, daysAgo(40));
    const { withSystemDbAccessContext } = await import('../../db');
    const auth = { orgCondition: () => undefined } as never;
    expect(await withSystemDbAccessContext(() => findArtifactForAuth(oldCapture, auth))).not.toBeNull();

    await scrubOrgToolOutputs(orgId, 30, OPTS);

    expect(await withSystemDbAccessContext(() => findArtifactForAuth(oldCapture, auth))).toBeNull();
  });

  describe('storeSdkSessionPointer: init cannot resurrect a cleared transcript', () => {
    it('a query that resumed an id the retention job has since cleared does not write it back', async () => {
      const sessionId = await insertSession(orgId, 'sdk-raced');
      await insertToolPair(sessionId, daysAgo(40));
      // The request loaded 'sdk-raced' and resumed it; the scrub commits first.
      await scrubOrgToolOutputs(orgId, 30, OPTS);

      const stored = await storeSdkSessionPointer({ breezeSessionId: sessionId, orgId, sdkSessionId: 'sdk-raced', startedFrom: 'sdk-raced' });

      expect(stored).toBe(false);
      expect((await session(sessionId)).sdkSessionId).toBeNull();
    });

    it('a fresh query stores its id, and a resume of the current id keeps it', async () => {
      const sessionId = await insertSession(orgId, null);
      expect(await storeSdkSessionPointer({ breezeSessionId: sessionId, orgId, sdkSessionId: 'sdk-new', startedFrom: null })).toBe(true);
      expect((await session(sessionId)).sdkSessionId).toBe('sdk-new');
      expect(await storeSdkSessionPointer({ breezeSessionId: sessionId, orgId, sdkSessionId: 'sdk-new', startedFrom: 'sdk-new' })).toBe(true);
      expect((await session(sessionId)).sdkSessionId).toBe('sdk-new');
    });
  });

  describe('runAiToolOutputRetention: effective policy per org, resolved in system context', () => {
    it('applies the 30-day default with no policy rows, skips keep-forever partners, and honours an org tighten', async () => {
      const deleteTranscript = vi.fn(async (_id: string) => 'deleted' as const);

      // Org A: no rows anywhere → 30-day default.
      const sA = await insertSession(orgId, 'sdk-a');
      const a40 = await insertToolPair(sA, daysAgo(40));

      // Partner B: keep forever (NULL), org B2 inherits (NULL) → never scrubbed.
      const partnerB = (await createPartner()).id;
      const orgB = (await createOrganization({ partnerId: partnerB, name: 'Keep Forever Org' })).id;
      await getTestDb().insert(aiDataPolicies).values({ partnerId: partnerB, toolOutputRetentionDays: null });
      await getTestDb().insert(aiDataPolicies).values({ orgId: orgB, toolOutputRetentionDays: null });
      const sB = await insertSession(orgB, 'sdk-b');
      const b400 = await insertToolPair(sB, daysAgo(400));

      // Partner C: 30 days; org C tightens to 5.
      const partnerC = (await createPartner()).id;
      const orgC = (await createOrganization({ partnerId: partnerC, name: 'Tight Org' })).id;
      await getTestDb().insert(aiDataPolicies).values({ partnerId: partnerC, toolOutputRetentionDays: 30 });
      await getTestDb().insert(aiDataPolicies).values({ orgId: orgC, toolOutputRetentionDays: 5 });
      const sC = await insertSession(orgC, 'sdk-c');
      const c10 = await insertToolPair(sC, daysAgo(10));

      const summary = await runAiToolOutputRetention({ ...OPTS, deleteTranscript });

      expect((await message(a40.messageId)).toolOutput).toMatchObject({ _retention: 'scrubbed' });
      expect((await message(b400.messageId)).toolOutput).toEqual({ content: 'C:\\Users\\bob\\secret.txt contents' });
      expect((await session(sB)).sdkSessionId).toBe('sdk-b');
      expect((await message(c10.messageId)).toolOutput).toMatchObject({ _retention: 'scrubbed' });

      expect(summary.orgsKeptForever).toBeGreaterThanOrEqual(1);
      expect(summary.orgsFailed).toBe(0);
      expect(summary.orgsSkipped).toBe(0);
      expect(summary.incomplete).toBe(false);
      expect(deleteTranscript.mock.calls.map((c) => c[0]).sort()).toEqual(['sdk-a', 'sdk-c']);
      expect(summary.transcripts).toMatchObject({ deleted: 2, notFound: 0, failed: 0 });
    });
  });
});
