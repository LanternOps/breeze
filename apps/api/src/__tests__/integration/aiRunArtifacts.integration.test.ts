import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, aiRunArtifacts } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

/**
 * Execution-plane W01 (spec §6.1, §12 "Integration (live DB)"): RLS forge on
 * ai_run_artifacts (42501), the composite tenant FK (23503), org isolation on
 * SELECT, and the ON DELETE CASCADE from ai_agent_runs. `rls-coverage`
 * auto-discovers the table's policy set; this file proves the predicates bite.
 */

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdArtifacts: string[] = [];
const createdRuns: string[] = [];
const createdAgents: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdArtifacts.length)
      await db.delete(aiRunArtifacts).where(inArray(aiRunArtifacts.id, createdArtifacts));
    if (createdRuns.length) await db.delete(aiAgentRuns).where(inArray(aiAgentRuns.id, createdRuns));
    if (createdAgents.length) await db.delete(aiAgents).where(inArray(aiAgents.id, createdAgents));
  });
  createdArtifacts.length = 0;
  createdRuns.length = 0;
  createdAgents.length = 0;
});

function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

/** An org with a live agent and one run. */
async function orgWithRun() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id });
  const [agent] = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(aiAgents)
      .values({ orgId: org.id, partnerId: null, kind: 'triage', name: 'Triage', createdBy: user.id })
      .returning(),
  );
  createdAgents.push(agent!.id);
  const [run] = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(aiAgentRuns)
      .values({
        agentId: agent!.id,
        orgId: org.id,
        triggerKind: 'manual',
        dedupeKey: `art-${crypto.randomUUID()}`,
        modeAtStart: 'shadow',
        policySnapshot: { schemaVersion: 1 } as never,
      })
      .returning(),
  );
  createdRuns.push(run!.id);
  return { partner, org, agent: agent!, run: run! };
}

function artifactValues(orgId: string, runId: string | null) {
  return {
    orgId,
    runId,
    kind: 'input_capture' as const,
    name: 'search_logs.json',
    contentType: 'application/json',
    bytes: 12_345,
    sha256: 'a'.repeat(64),
    blobKey: `us/2026/10/${crypto.randomUUID()}`,
    headPreview: '{"rows":[',
    tailPreview: ']}',
    createdByTool: 'search_logs',
  };
}

describe('ai_run_artifacts — RLS forge, composite tenant FK, isolation, cascade', () => {
  it('rejects a cross-org forge under the attacker org context (42501)', async () => {
    const victim = await orgWithRun();
    const attacker = await orgWithRun();
    await expectSqlState(
      () =>
        withDbAccessContext(orgContext(attacker.org.id, attacker.partner.id), () =>
          db.insert(aiRunArtifacts).values(artifactValues(victim.org.id, attacker.run.id)).returning(),
        ),
      '42501',
    );
  });

  it('rejects a row whose run belongs to another org even under system context (23503, composite FK)', async () => {
    const a = await orgWithRun();
    const b = await orgWithRun();
    await expectSqlState(
      () =>
        withSystemDbAccessContext(() =>
          db.insert(aiRunArtifacts).values(artifactValues(a.org.id, b.run.id)).returning(),
        ),
      '23503',
    );
  });

  it('accepts a run-anchored row in its own org and a chat-only row with run_id NULL', async () => {
    const t = await orgWithRun();
    const ctx = orgContext(t.org.id, t.partner.id);
    const [withRun] = await withDbAccessContext(ctx, () =>
      db.insert(aiRunArtifacts).values(artifactValues(t.org.id, t.run.id)).returning(),
    );
    const [chatOnly] = await withDbAccessContext(ctx, () =>
      db.insert(aiRunArtifacts).values(artifactValues(t.org.id, null)).returning(),
    );
    createdArtifacts.push(withRun!.id, chatOnly!.id);
    expect(withRun!.runId).toBe(t.run.id);
    expect(chatOnly!.runId).toBeNull();
    // Default TTL lands ~30 days out.
    const days = (withRun!.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("org B cannot SELECT org A's artifact", async () => {
    const a = await orgWithRun();
    const b = await orgWithRun();
    const [row] = await withSystemDbAccessContext(() =>
      db.insert(aiRunArtifacts).values(artifactValues(a.org.id, a.run.id)).returning(),
    );
    createdArtifacts.push(row!.id);
    const visible = await withDbAccessContext(orgContext(b.org.id, b.partner.id), () =>
      db.select({ id: aiRunArtifacts.id }).from(aiRunArtifacts).where(eq(aiRunArtifacts.id, row!.id)),
    );
    expect(visible).toEqual([]);
    const own = await withDbAccessContext(orgContext(a.org.id, a.partner.id), () =>
      db.select({ id: aiRunArtifacts.id }).from(aiRunArtifacts).where(eq(aiRunArtifacts.id, row!.id)),
    );
    expect(own).toHaveLength(1);
  });

  it('deleting the run cascades its artifacts (ON DELETE CASCADE on the composite FK)', async () => {
    const t = await orgWithRun();
    const [row] = await withSystemDbAccessContext(() =>
      db.insert(aiRunArtifacts).values(artifactValues(t.org.id, t.run.id)).returning(),
    );
    await withSystemDbAccessContext(() => db.delete(aiAgentRuns).where(eq(aiAgentRuns.id, t.run.id)));
    createdRuns.splice(createdRuns.indexOf(t.run.id), 1);
    const left = await withSystemDbAccessContext(() =>
      db.select({ id: aiRunArtifacts.id }).from(aiRunArtifacts).where(eq(aiRunArtifacts.id, row!.id)),
    );
    expect(left).toEqual([]);
  });
});

describe('org erasure pre-clears artifact blobs before rows (spec §8)', () => {
  it('removes the blob and the row, in that order, and is rerunnable', async () => {
    const { createMemoryBlobStorage, setBlobStorageForTests } = await import(
      '../../services/artifacts/blobStorage'
    );
    const { cascadeDeleteOrg } = await import('../../services/tenantCascade');
    const blobs = createMemoryBlobStorage();
    setBlobStorageForTests(blobs);
    try {
      const t = await orgWithRun();
      const put = await blobs.put({
        region: 'us',
        contentType: 'application/json',
        body: Buffer.from('{"a":1}'),
        maxBytes: 1024,
      });
      const [row] = await withSystemDbAccessContext(() =>
        db
          .insert(aiRunArtifacts)
          .values({ ...artifactValues(t.org.id, t.run.id), blobKey: put.key })
          .returning(),
      );
      expect(blobs.objects.has(put.key)).toBe(true);

      await cascadeDeleteOrg(t.org.id, '00000000-0000-4000-8000-00000000ffff');

      expect(blobs.objects.has(put.key)).toBe(false);
      const left = await withSystemDbAccessContext(() =>
        db.select({ id: aiRunArtifacts.id }).from(aiRunArtifacts).where(eq(aiRunArtifacts.id, row!.id)),
      );
      expect(left).toEqual([]);
      // The org and its run went with it, so nothing needs afterEach cleanup.
      createdRuns.splice(createdRuns.indexOf(t.run.id), 1);
      createdAgents.splice(createdAgents.indexOf(t.agent.id), 1);
    } finally {
      setBlobStorageForTests(null);
    }
  });
});
