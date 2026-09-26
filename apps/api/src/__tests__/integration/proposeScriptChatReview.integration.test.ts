import './setup';

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devices, scriptProposalReviews, scriptProposals } from '../../db/schema';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * #7128 — `propose_script` through the REAL chat/agent-run tool wrapper
 * (`aiAgentSdkTools.makeHandler`) against real Postgres.
 *
 * The wrapper used to run the whole handler in one transaction, so the review
 * job was enqueued while the proposal insert was still uncommitted: the worker
 * loaded it under its own system context about 2 ms later, found it 'missing',
 * and never reviewed it — while the wrapper's pooled connection sat idle in
 * transaction for the handler's full 45 s wait.
 *
 * Only the Anthropic client and the BullMQ hop are faked. The enqueue stand-in
 * does what the worker does: after ~2 ms it runs the real `runScriptReview`,
 * which loads the proposal under `withSystemDbAccessContext` on its own
 * connection. The proposal insert, RLS, the reviews chain and the inline wait
 * (`waitForReviewCompletion`) are all real.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

const h = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  visibleAtEnqueue: null as boolean | null,
  review: null as Promise<{ ok: true } | { ok: false; error: unknown }> | null,
  idleInTransactionDuringReview: null as number | null,
}));

vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aiScriptAuthoringEnabled: () => true,
}));

vi.mock('../../services/llm/llmConfigResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/llm/llmConfigResolver')>();
  return {
    ...actual,
    getAnthropicClientForPartner: vi.fn(async () => ({
      client: { messages: { create: h.messagesCreate } },
      resolved: { source: 'platform', model: 'claude-sonnet-4-6', catalog: null },
    })),
    resolveWireModel: vi.fn((_resolved: unknown, model: string) => ({ model })),
  };
});

vi.mock('../../services/scriptProposals/reviewQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/scriptProposals/reviewQueue')>();
  return {
    ...actual,
    enqueueScriptReview: vi.fn(async (data: { proposalId: string; orgId: string; attempt: number }) => {
      // What the worker would see, from its own connection, at enqueue time.
      const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        db.select({ id: scriptProposals.id }).from(scriptProposals).where(eq(scriptProposals.id, data.proposalId))));
      h.visibleAtEnqueue = rows.length === 1;
      // The worker picks the job up ~2 ms later, outside any caller context.
      const { runScriptReview } = await import('../../services/scriptProposals/reviewer');
      h.review = new Promise((resolve) => setTimeout(resolve, 2))
        .then(() => runOutsideDbContext(() => runScriptReview(data)))
        .then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
    }),
  };
});

import { __test__ as sdkToolsTest } from '../../services/aiAgentSdkTools';

const VALID_VERDICT = {
  summary: 'Restarts the print spooler service.',
  goalMatch: 'yes',
  riskTier: 'low',
  blastRadius: ['spooler queue drains'],
  reversible: true,
  verificationAdequate: true,
  findings: [{ severity: 'info', text: 'No destructive operations detected.' }],
  recommendedAction: 'approve',
};

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site!.id,
      agentId: randomUUID(),
      hostname: `propose-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  return { partnerId: partner.id, orgId: org.id, deviceId: device!.id };
}

function chatAuth(orgId: string, partnerId: string): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  const userId = randomUUID();
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: `${userId}@example.test`, name: 'Test User', isPlatformAdmin: false },
    token: {
      sub: userId, email: `${userId}@example.test`, roleId: null, orgId, partnerId,
      scope: 'organization', type: 'access', mfa: true,
    },
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition,
    canAccessOrg,
  } as unknown as AuthContext;
}

async function idleInTransactionCount(): Promise<number> {
  const rows = await getTestDb().execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND state LIKE 'idle in transaction%'`);
  return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}

beforeEach(() => {
  h.messagesCreate.mockReset();
  h.visibleAtEnqueue = null;
  h.review = null;
  h.idleInTransactionDuringReview = null;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

runDb('a chat-wrapped propose_script commits before enqueue, gets its model review, and holds no transaction across the wait (#7128)', async () => {
  const { orgId, partnerId, deviceId } = await seed();
  h.messagesCreate.mockImplementation(async () => {
    // Runs while the tool handler is inside its inline review wait.
    h.idleInTransactionDuringReview = await idleInTransactionCount();
    return {
      usage: { input_tokens: 420, output_tokens: 90 },
      content: [{ type: 'text', text: JSON.stringify(VALID_VERDICT) }],
    };
  });

  const handler = sdkToolsTest.makeHandler('propose_script', () => chatAuth(orgId, partnerId));
  const result = await handler({
    language: 'powershell',
    content: 'Restart-Service -Name Spooler',
    goal: 'Fix the print queue',
    expectedEffect: 'Spooler restarts',
    verification: { kind: 'service_running', name: 'Spooler' },
    deviceIds: [deviceId],
  });

  // 1. The worker could see the proposal the moment the job was enqueued.
  expect(h.visibleAtEnqueue).toBe(true);
  // 2. The worker's review ran to completion instead of failing 'missing'.
  const review = await h.review!;
  expect(review).toEqual({ ok: true });
  // 3. No connection sat idle in transaction while the handler waited.
  expect(h.idleInTransactionDuringReview).toBe(0);

  // 4. The inline wait returned the MODEL review, so the tool reports it.
  const text = (result.content[0] as { type: 'text'; text: string }).text;
  const out = JSON.parse(text);
  expect(out.status).toBe('reviewed');
  expect(out.review).toMatchObject({ status: 'completed', riskTier: expect.any(String) });

  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(scriptProposals).where(eq(scriptProposals.id, out.proposalId)));
  expect(row).toMatchObject({ orgId, status: 'reviewed', authorKind: 'chat_session' });
  const reviews = await withSystemDbAccessContext(() =>
    db.select().from(scriptProposalReviews).where(eq(scriptProposalReviews.proposalId, out.proposalId)));
  expect(reviews.map((r) => r.reviewerKind).sort()).toEqual(['model', 'static_scan']);
}, 90_000);
