/**
 * Regression: the AI agent could not run ANY approval-gated tool on US prod
 * (every execute_command returned "Tool execution was rejected or timed out",
 * including read-only list_processes). Users had to manually flag the chat.
 *
 * Root cause: waitForApproval() (services/aiAgent.ts) polls ai_tool_executions
 * through the bare `db` pool. The AI Agent SDK runs its session OUTSIDE the
 * request's AsyncLocalStorage DB context (by design — runOutsideDbContext, to
 * avoid holding a request txn open for the whole stream), so inside
 * waitForApproval the `db` proxy resolves to the unprivileged `breeze_app`
 * role with NO `breeze.*` GUCs. ai_tool_executions has forced RLS, so the
 * SELECT matched 0 rows and `if (!execution) return false` fired on the first
 * poll (~67ms) — even after the user clicked Approve (which flips the row to
 * 'approved' via the authenticated, context-bound /approvals route).
 *
 * Same silent-0-row class as #1375; the contextless-write guard doesn't cover
 * SELECT, so nothing surfaced in logs.
 *
 * These tests run against a real DB as `breeze_app` (forced RLS) and call
 * waitForApproval with NO ambient context, exactly as the SDK does. They fail
 * (RED) until waitForApproval establishes a system-scope context for its poll.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import './setup';
import { getTestDb } from './setup';
import { partners, organizations, users } from '../../db/schema';
import { aiSessions, aiToolExecutions } from '../../db/schema/ai';
import { waitForApproval } from '../../services/aiAgent';

let orgId: string;
let userId: string;
let sessionId: string;

beforeEach(async () => {
  // Seed on the superuser test connection (bypasses RLS). setup.ts TRUNCATEs
  // users/partners CASCADE per test, clearing the ai_* rows transitively.
  const tdb = getTestDb();
  const sfx = `${Date.now()}-${Math.floor(performance.now())}`;
  const [p] = await tdb
    .insert(partners)
    .values({ name: 'AI Approval RLS', slug: `ai-appr-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
    .returning({ id: partners.id });
  const [o] = await tdb
    .insert(organizations)
    .values({ partnerId: p!.id, name: 'AI Approval Org', slug: `ai-appr-org-${sfx}` })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [u] = await tdb
    .insert(users)
    .values({ partnerId: p!.id, email: `ai-appr-${sfx}@test.local`, name: 'Approver', status: 'active' })
    .returning({ id: users.id });
  userId = u!.id;
  const [s] = await tdb
    .insert(aiSessions)
    .values({ orgId, userId, type: 'general' })
    .returning({ id: aiSessions.id });
  sessionId = s!.id;
});

async function seedExecution(status: 'pending' | 'approved' | 'rejected'): Promise<string> {
  const tdb = getTestDb();
  const [row] = await tdb
    .insert(aiToolExecutions)
    .values({
      sessionId,
      toolName: 'execute_command',
      toolInput: { deviceId: 'd', commandType: 'list_processes' },
      status,
    })
    .returning({ id: aiToolExecutions.id });
  return row!.id;
}

describe('waitForApproval — polls ai_tool_executions with RLS context (SDK path)', () => {
  it('returns true for an approved execution when called with no ambient DB context', async () => {
    const executionId = await seedExecution('approved');

    // No withDbAccessContext wrapper — mirrors the SDK session loop, which runs
    // outside the request context. Before the fix this resolved to breeze_app
    // with no GUC, saw 0 rows under forced RLS, and returned false.
    const approved = await waitForApproval(executionId, 5_000);

    expect(approved).toBe(true);
  });

  it('returns false for a rejected execution (genuine reject, not a 0-row miss)', async () => {
    const executionId = await seedExecution('rejected');
    const approved = await waitForApproval(executionId, 5_000);
    expect(approved).toBe(false);
  });

  it('respects an already-aborted signal without touching the DB', async () => {
    const executionId = await seedExecution('pending');
    const controller = new AbortController();
    controller.abort();
    const approved = await waitForApproval(executionId, 5_000, controller.signal);
    expect(approved).toBe(false);
  });
});
