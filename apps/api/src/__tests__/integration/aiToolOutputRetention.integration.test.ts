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

import { aiDataPolicies, aiMessages, aiRunArtifacts, aiSessions, aiToolExecutions, aiToolSearchEvents } from '../../db/schema';
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
    // The executions pass completed too (it ran after the capped messages pass).
    const execs = await getTestDb().select().from(aiToolExecutions).where(inArray(aiToolExecutions.id, pairs.map((p) => p.executionId)));
    for (const row of execs) expect((row.toolOutput as { _retention?: string })._retention).toBe('scrubbed');
    expect(resumed.executions.hasMore).toBe(false);
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

  describe('live sessions', () => {
    const HOUR_MS = 60 * 60 * 1000;
    const liveSession = async (lastMessageAgoMs: number, outputAgeDays: number) => {
      const sessionId = await insertSession(orgId, 'sdk-live');
      const old = await insertToolPair(sessionId, daysAgo(outputAgeDays));
      await getTestDb().insert(aiMessages).values({ sessionId, role: 'user', content: 'still here', createdAt: new Date(NOW.getTime() - lastMessageAgoMs) });
      return { sessionId, old };
    };

    it('defers a session with a message inside the 3 h quiet window (2 h 50 m ago)', async () => {
      // 30.5 days old under a 30-day window: inside the 1-day deferral allowance.
      const { sessionId, old } = await liveSession(2 * HOUR_MS + 50 * 60_000, 30.5);

      const result = await scrubOrgToolOutputs(orgId, 30, OPTS);

      expect(result.messages.deleted).toBe(0);
      expect(result.executions.deleted).toBe(0);
      expect((await message(old.messageId)).toolOutput).toEqual({ content: 'C:\\Users\\bob\\secret.txt contents' });
      expect((await session(sessionId)).sdkSessionId).toBe('sdk-live');
    });

    it('scrubs once the last message is outside the quiet window (3 h 10 m ago)', async () => {
      const { sessionId, old } = await liveSession(3 * HOUR_MS + 10 * 60_000, 30.5);

      await scrubOrgToolOutputs(orgId, 30, OPTS);

      expect((await message(old.messageId)).toolOutput).toMatchObject({ _retention: 'scrubbed' });
      expect((await session(sessionId)).sdkSessionId).toBeNull();
    });

    it('never defers past one day: a constantly active session is still scrubbed', async () => {
      const { sessionId, old } = await liveSession(5 * 60_000, 40);

      await scrubOrgToolOutputs(orgId, 30, OPTS);

      expect((await message(old.messageId)).toolOutput).toMatchObject({ _retention: 'scrubbed' });
      expect((await session(sessionId)).sdkSessionId).toBeNull();
    });
  });

  it('never touches another org: messages, executions, sessions, captures', async () => {
    const otherOrg = (await createOrganization({ partnerId, name: 'Other Org' })).id;
    const otherSession = await insertSession(otherOrg, 'sdk-other');
    const other = await insertToolPair(otherSession, daysAgo(40));
    const otherCapture = await insertCapture(otherOrg, otherSession, daysAgo(40));
    const ownSession = await insertSession(orgId, null);
    await insertCapture(orgId, ownSession, daysAgo(40));

    const first = await scrubOrgToolOutputs(orgId, 30, OPTS);
    const second = await scrubOrgToolOutputs(orgId, 30, { ...OPTS, now: new Date(NOW.getTime() + 60_000) });

    expect(first.artifacts.deleted).toBe(1);
    expect(second.artifacts.deleted).toBe(0);
    expect((await message(other.messageId)).toolOutput).toEqual({ content: 'C:\\Users\\bob\\secret.txt contents' });
    expect((await execution(other.executionId)).toolOutput).toEqual({ content: 'C:\\Users\\bob\\secret.txt contents' });
    expect((await session(otherSession)).sdkSessionId).toBe('sdk-other');
    const otherArtifact = await artifact(otherCapture);
    expect(otherArtifact.headPreview).toBe('HEAD secret');
    expect(otherArtifact.expiresAt.getTime()).toBeGreaterThan(Date.now());
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

    it('resolves every partner/org combination per org, never borrowing a sibling org\'s row', async () => {
      const deleteTranscript = vi.fn(async (_id: string) => 'not_found' as const);
      const policyOrg = async (partner: string, name: string, orgDays: number | null | undefined) => {
        const id = (await createOrganization({ partnerId: partner, name })).id;
        if (orgDays !== undefined) await getTestDb().insert(aiDataPolicies).values({ orgId: id, toolOutputRetentionDays: orgDays });
        return id;
      };
      const outputIn = async (org: string, ageDays: number) => (await insertToolPair(await insertSession(org, null), daysAgo(ageDays))).messageId;
      const scrubbed = async (messageId: string) => ((await message(messageId)).toolOutput as { _retention?: string })._retention === 'scrubbed';

      // Partner keep-forever ceiling, org sets 14: the org value applies (W01: NULL partner = unbounded).
      const pForever = (await createPartner()).id;
      await getTestDb().insert(aiDataPolicies).values({ partnerId: pForever, toolOutputRetentionDays: null });
      const orgForever14 = await policyOrg(pForever, 'Forever ceiling, org 14', 14);
      const f20 = await outputIn(orgForever14, 20);
      const f10 = await outputIn(orgForever14, 10);
      // Sibling under the same keep-forever partner with no org row: kept.
      const forever = await policyOrg(pForever, 'Forever sibling', undefined);
      const fs20 = await outputIn(forever, 20);

      // Partner 10, org row NULL: inherits 10.
      const p10 = (await createPartner()).id;
      await getTestDb().insert(aiDataPolicies).values({ partnerId: p10, toolOutputRetentionDays: 10 });
      const inherit = await policyOrg(p10, 'Inherits 10', null);
      const i15 = await outputIn(inherit, 15);
      const i5 = await outputIn(inherit, 5);

      // Partner 30; an org row above the ceiling (90) is ignored, not honoured.
      const p30 = (await createPartner()).id;
      await getTestDb().insert(aiDataPolicies).values({ partnerId: p30, toolOutputRetentionDays: 30 });
      const above = await policyOrg(p30, 'Org above ceiling', 90);
      const a40 = await outputIn(above, 40);
      // Sibling of an org that tightened to 5: keeps the partner's 30.
      await policyOrg(p30, 'Tight sibling', 5);
      const loose = await policyOrg(p30, 'Loose sibling', undefined);
      const l10 = await outputIn(loose, 10);

      const summary = await runAiToolOutputRetention({ ...OPTS, deleteTranscript });

      expect(await scrubbed(f20)).toBe(true);
      expect(await scrubbed(f10)).toBe(false);
      expect(await scrubbed(fs20)).toBe(false);
      expect(await scrubbed(i15)).toBe(true);
      expect(await scrubbed(i5)).toBe(false);
      expect(await scrubbed(a40)).toBe(true);
      expect(await scrubbed(l10)).toBe(false);
      expect(summary.orgsFailed).toBe(0);
      expect(summary.orgsSkipped).toBe(0);
    });
  });
});

// #12421 W01: tool-discovery telemetry rows are deleted at the org's
// tool-output window (180-day ceiling, keep-forever orgs included, no
// live-session deferral), and aged assistant rows lose their ToolSearch
// tool_use input while every other block stays byte-identical.
describe('aiToolOutputRetention: tool search events (#12421 W01)', () => {
  let orgId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    orgId = (await createOrganization({ partnerId: partner.id, name: 'Search Retention Org' })).id;
  });

  async function insertSearchEvent(sessionId: string, createdAt: Date): Promise<string> {
    const [row] = await getTestDb().insert(aiToolSearchEvents).values({
      sessionId, kind: 'search', surface: 'chat', surfaceFingerprint: '0123456789abcdef',
      query: 'restart a service', resultToolNames: ['manage_services'], empty: false, createdAt,
    }).returning({ id: aiToolSearchEvents.id });
    return row!.id;
  }
  async function searchEventIds(sessionId: string): Promise<string[]> {
    const rows = await getTestDb().select({ id: aiToolSearchEvents.id }).from(aiToolSearchEvents).where(eq(aiToolSearchEvents.sessionId, sessionId));
    return rows.map((r: { id: string }) => r.id).sort();
  }
  const BLOCKS = (query: string) => [
    { type: 'text', text: 'Looking that up.' },
    { type: 'tool_use', id: 'toolu_s1', name: 'ToolSearch', input: { query, max_results: 5 } },
    { type: 'tool_use', id: 'toolu_c1', name: 'mcp__breeze__manage_services', input: { action: 'restart', serviceName: 'Spooler' } },
  ];
  async function insertAssistant(sessionId: string, createdAt: Date, blocks: unknown[]): Promise<string> {
    const [row] = await getTestDb().insert(aiMessages).values({
      sessionId, role: 'assistant', content: 'Looking that up.', contentBlocks: blocks as Record<string, unknown>[], createdAt,
    }).returning({ id: aiMessages.id });
    return row!.id;
  }

  it('an org at the default 30 days deletes a 31-day search row and keeps a 29-day one', async () => {
    const sessionId = await insertSession(orgId, null);
    const old = await insertSearchEvent(sessionId, daysAgo(31));
    const kept = await insertSearchEvent(sessionId, daysAgo(29));
    const summary = await runAiToolOutputRetention({ ...OPTS, deleteTranscript: vi.fn() });
    expect(await searchEventIds(sessionId)).toEqual([kept]);
    expect(old).not.toBe(kept);
    expect(summary.searchEventsDeleted).toBeGreaterThanOrEqual(1);
  });

  it('a keep-forever org deletes rows older than 180 days and keeps a 179-day row', async () => {
    const partner = await createPartner();
    const foreverOrg = (await createOrganization({ partnerId: partner.id, name: 'Forever Org' })).id;
    await getTestDb().insert(aiDataPolicies).values({ partnerId: partner.id, toolOutputRetentionDays: null });
    const sessionId = await insertSession(foreverOrg, null, daysAgo(400));
    await insertSearchEvent(sessionId, daysAgo(181));
    const kept = await insertSearchEvent(sessionId, daysAgo(179));
    const summary = await runAiToolOutputRetention({ ...OPTS, deleteTranscript: vi.fn() });
    expect(await searchEventIds(sessionId)).toEqual([kept]);
    expect(summary.orgsKeptForever).toBeGreaterThanOrEqual(1);
  });

  it('a row of a live session (a message minutes ago) is deleted anyway', async () => {
    const sessionId = await insertSession(orgId, 'sdk-live');
    await getTestDb().insert(aiMessages).values({ sessionId, role: 'user', content: 'still here', createdAt: new Date(NOW.getTime() - 5 * 60_000) });
    await insertSearchEvent(sessionId, daysAgo(31));
    await runAiToolOutputRetention({ ...OPTS, deleteTranscript: vi.fn() });
    expect(await searchEventIds(sessionId)).toEqual([]);
  });

  it("blanks an aged assistant row's ToolSearch input, keeps its other blocks byte-identical, leaves an unaged row alone, and is idempotent", async () => {
    const sessionId = await insertSession(orgId, null);
    const aged = await insertAssistant(sessionId, daysAgo(31), BLOCKS('find the print spooler on ws-01'));
    const fresh = await insertAssistant(sessionId, daysAgo(10), BLOCKS('find the print spooler on ws-02'));

    // As stored (jsonb normalises key order), before the run.
    const before = (await message(aged)).contentBlocks as unknown[];
    const first = await runAiToolOutputRetention({ ...OPTS, deleteTranscript: vi.fn() });
    const agedRow = await message(aged);
    const after = agedRow.contentBlocks as unknown[];
    const expected = BLOCKS('x');
    expect(after).toEqual([expected[0], { ...expected[1], input: {} }, expected[2]]);
    // The other blocks keep their position and their stored bytes.
    expect(JSON.stringify(after[0])).toBe(JSON.stringify(before[0]));
    expect(JSON.stringify(after[2])).toBe(JSON.stringify(before[2]));
    expect((await message(fresh)).contentBlocks).toEqual(BLOCKS('find the print spooler on ws-02'));
    expect(first.toolSearchInputsBlanked).toBe(1);

    const second = await runAiToolOutputRetention({ ...OPTS, deleteTranscript: vi.fn() });
    expect(second.toolSearchInputsBlanked).toBe(0);
    expect((await message(aged)).contentBlocks).toEqual(agedRow.contentBlocks);
  });

  it('odd content_blocks shapes never fail the pass; two ToolSearch blocks in one row are both blanked and the row counts once', async () => {
    const sessionId = await insertSession(orgId, null);
    const nullRow = await insertAssistant(sessionId, daysAgo(31), null as unknown as unknown[]);
    const objectRow = await insertAssistant(sessionId, daysAgo(31), { type: 'text', text: 'not an array' } as unknown as unknown[]);
    const emptyRow = await insertAssistant(sessionId, daysAgo(31), []);
    const two = [
      { type: 'tool_use', id: 'toolu_s1', name: 'ToolSearch', input: { query: 'first' } },
      { type: 'text', text: 'between' },
      { type: 'tool_use', id: 'toolu_s2', name: 'ToolSearch', input: { query: 'second' } },
      { type: 'tool_use', id: 'toolu_c1', name: 'mcp__breeze__manage_services', input: { action: 'restart' } },
    ];
    const twoRow = await insertAssistant(sessionId, daysAgo(31), two);
    const before = {
      nullRow: (await message(nullRow)).contentBlocks,
      objectRow: (await message(objectRow)).contentBlocks,
      emptyRow: (await message(emptyRow)).contentBlocks,
    };

    const summary = await runAiToolOutputRetention({ ...OPTS, deleteTranscript: vi.fn() });

    expect(summary.orgsFailed).toBe(0);
    expect(summary.toolSearchInputsBlanked).toBe(1);
    expect((await message(twoRow)).contentBlocks).toEqual([
      { ...two[0], input: {} }, two[1], { ...two[2], input: {} }, two[3],
    ]);
    expect((await message(nullRow)).contentBlocks).toEqual(before.nullRow);
    expect((await message(objectRow)).contentBlocks).toEqual(before.objectRow);
    expect((await message(emptyRow)).contentBlocks).toEqual(before.emptyRow);
  });

  it('never touches another org\'s rows', async () => {
    const partner = await createPartner();
    const otherOrg = (await createOrganization({ partnerId: partner.id, name: 'Other Org' })).id;
    await getTestDb().insert(aiDataPolicies).values({ partnerId: partner.id, toolOutputRetentionDays: 120 });
    const otherSession = await insertSession(otherOrg, null);
    const kept = await insertSearchEvent(otherSession, daysAgo(31));
    const keptMsg = await insertAssistant(otherSession, daysAgo(31), BLOCKS('q'));
    await runAiToolOutputRetention({ ...OPTS, deleteTranscript: vi.fn() });
    expect(await searchEventIds(otherSession)).toEqual([kept]);
    expect((await message(keptMsg)).contentBlocks).toEqual(BLOCKS('q'));
  });
});
