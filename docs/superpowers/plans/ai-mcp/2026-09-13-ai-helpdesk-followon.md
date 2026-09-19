---
tracking_issue: LanternOps/breeze#5739
wave_issues: W01 LanternOps/breeze#5740 (#4211), W02 LanternOps/breeze#5741 (#4212), W03 LanternOps/breeze#5742 (#4209), W04 LanternOps/breeze#5743 (#4177)
branch: feature/5739-ai-helpdesk-followon/wave-<sub-issue>
---

# AI Helpdesk Agent Follow-On Implementation Plan (#4209 cluster)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the ticket-helpdesk AI lane: surface the agent's `ticketProposal` on the ticket detail with a one-click "Post as private note" under the *technician's* identity (#4211); let every subsequent human comment admit its own re-triage run behind a recency-ordered loop guard and per-event dedupe keys (#4212); make the already-shipped autonomous private-note lane auditable, DB-enforced private, and closed against the three `manage_tickets` actions that would still write an agent id into a `users` FK (#4209); and propose a Tier-2, human-reviewed time entry when a technician sends an AI draft or resolves with an AI resolution note (#4177).

**Architecture:** Four independently shippable waves on top of what wave 6.3 (#3828 / PR #4195) and phase-2 P2-4 (#4187 / #4191) already shipped — do **not** rebuild those. Verified prior art: `ai_agent_runs.outcome.ticketProposal` (projected by `runTrace.ts`), `ticket_comments.origin_principal_kind` / `agent_run_id` + RLS policy `breeze_ticket_parent_ai_agent_insert`, `addAiTriageNote()`, `ticket_drafts` + `GET/POST /tickets/:id/ai-drafts*`, the five-gate `evaluateTicketAutonomy()`, `ai_agents.triggers.ticketAutonomousWrites`, and the `agentTier2` supervised-intent path in `intentService.ts`. W01 adds one read endpoint, one write endpoint, one `ticket_comments` provenance column, and one extracted React card. W02 changes only `ticketHelpdeskSubscriber.ts` (dedupe keys + an ordered loop guard + a per-ticket ceiling). W03 adds an audit row, a DB CHECK, and a deny branch. W04 mints a Tier-2 `manage_tickets:log_time_entry` action intent (never a new action name) from two existing human-act sites.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL 16 (partial indexes, CHECK constraints, forced RLS), zod in `packages/shared`, Vitest (unit with Drizzle mocks; integration against real Postgres via `apps/api/src/__tests__/integration/setup`), React 18 islands under Astro, i18next with 8 locale bundles.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md` (§4.4 ticket triage + its amendment, §11 deferred roadmap: #4177, #4182). Predecessor plans: `docs/superpowers/plans/ai-mcp/2026-08-28-ai-agents-wave6-3-ticket-shadow.md`, `docs/superpowers/plans/ai-mcp/2026-08-30-ai-agents-p2-4-ticket-triage.md`.

**Tracking:** anchor issue LanternOps/breeze#4209. W01 = #4211, W02 = #4212, W03 = #4209, W04 = #4177. Register the feature with the `feature-lifecycle` MCP after Gate B and replace the frontmatter `tracking_issue`. One PR per wave, each `Closes #<wave issue>`.

---

## Global Constraints

- **Read this before touching anything: most of #4209 and half of #4212 already shipped.** The following are VERIFIED present on `origin/main` and must be extended, never re-created:
  - `apps/api/src/services/ticketService.ts::addAiTriageNote()` — writes `origin_principal_kind='ai_agent'`, `agent_run_id=<runId>`, `user_id=NULL`, `is_public=false`, `comment_type='internal'`; idempotent per run via the partial unique index `ticket_comments_one_ai_note_per_run_uq`.
  - `apps/api/src/services/actionIntents/ticketAutonomy.ts::evaluateTicketAutonomy()` — the five-gate creation-transaction autonomy gate (requested / `ai_agent` principal + run / ticket scope / run snapshot + live policy both `mode:'act'` and `triggers.ticketAutonomousWrites===true` for the same `agentId` / kill switch), fail-closed on any throw.
  - `apps/api/src/services/aiAgents/ticketHelpdeskSubscriber.ts` — already subscribed to all three of `ticket.created`, `ticket.commented`, `ticket.status_changed`.
  - `apps/api/src/routes/tickets/aiDrafts.ts` + `apps/web/src/components/tickets/TicketWorkbench.tsx` — the "AI draft / Send as me" surface.
  - `time_entries` (partner-axis RLS, Shape 3) **exists** — `apps/api/src/db/schema/timeTracking.ts`, created by `2026-06-12-a-ticketing-time-parts.sql`, already registered in `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:738`), `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts:590`) and org-merge `REPOINT_TABLES` (`orgMergeRegistry.ts:880`). **W04 creates no table.**
- **`ticket_comments` has no `org_id` column** (verified: no migration adds one; every RLS policy `EXISTS`-joins `tickets.org_id`). It is therefore absent from `CORE_ORG_CASCADE_DELETE_ORDER` and from `CORE_TENANT_EXPORT_POLICY`, and a new column on it triggers **neither** registration. Do not add it to either list. `ticket_categories` is partner-keyed and likewise in neither list (verified by grep, both files).
- **`time_entries` IS in `CORE_TENANT_EXPORT_POLICY`.** W04 changes only the CHECK on the existing `source` column and adds no column, so the export policy needs no edit — but if you end up adding any column to `time_entries`, `tenant-export-policy.integration.test.ts` will red in **Integration Tests** only.
- Migration filenames, in wave order — before pushing each, run `ls apps/api/migrations | sort | tail -1` against `origin/main` and bump `HHMMSS` if the newest sorts after yours (newest at planning time: `2026-10-16-180200-monitor-definitions-builtin-key.sql`; `180300`/`180500` are claimed by in-flight PRs):
  - W01 `apps/api/migrations/2026-10-16-181100-ticket-comment-proposed-by-run.sql`
  - W03 `apps/api/migrations/2026-10-16-181300-ticket-comment-agent-note-private-chk.sql`
  - W04 `apps/api/migrations/2026-10-16-181400-time-entry-ai-suggested-source.sql`
  - W02 has no migration.
- Every migration is idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then re-add, `DO $$ … $$` with `pg_constraint`/`pg_policies` existence checks), has **no inner `BEGIN`/`COMMIT`**, and never edits a shipped file. Any migration that writes rows must run `SELECT set_config('breeze.scope','system',true);` as its first statement before the first DML — enforced by `apps/api/src/db/migrationRlsScope.test.ts`; **never add a new file to that test's frozen baseline**. W01's and W03's migrations below deliberately contain no DML so the guard stays quiet; W04's does (a one-row-class CHECK swap with no data rewrite) — it still elects system scope first because the CHECK re-add validates existing rows.
- **`origin_principal_kind` is `text` with CHECK `ticket_comments_origin_principal_kind_chk IN ('user','ai_agent','system','unknown')`** — not a pg enum. Do not add values; the loop guard is a narrowing allowlist on `'user'` and any new value fails closed by construction.
- **Never write a synthetic id into a `users` FK.** `ai_agent` principals carry `auth.user.id = aiAgents.id` (`services/aiAgents/agentAuthContext.ts`, "attribution only, never RBAC, never copied into `breeze.user_id`"). `ticket_comments.user_id`, `time_entries.user_id` and `time_entries.approved_by` are all real `users` FKs. The all-zero UUID sentinel used elsewhere (`ANONYMOUS_ACTOR_ID`, `SYSTEM_ACTOR_ID`) is only ever used on `audit_logs.actor_id`, which has **no FK** — there is no seeded `users` row with that id. Reusing it on a `users` FK is a 23503.
- **`audit_logs.actor_id` is `uuid NOT NULL` with no FK**, and `actor_type` is the pg enum `actor_type` (`'user'|'api_key'|'agent'|'system'|'ai_agent'`). Dual attribution is one principal in `actor_type`/`actor_id` plus the second identifier inside the free-form `details` jsonb. There is no second-actor column; do not add one.
- **Tier-2 intents are never policy-decidable and never auto-execute.** `resolvePolicyDecisionState()` (`actionIntents/intentService.ts`) returns `'human_required'` for `tier < 3` **and** for `hasScope` (an explicit `{ticketId}`/`{deviceId}` scope). Only `auth.principal.kind === 'ai_agent'` may file a Tier-2 tool call as an `action_intents` row at all (`agentTier2`, `intentService.ts:1114-1117`), and such a row is always `approvalScope: 'supervised'`. W04 relies on both facts and adds no bypass.
- **W03 must not weaken `evaluateTicketAutonomy`.** Every gate stays; W03 only adds observability, a DB-level invariant, and a deny branch.
- Web: every mutation goes through `runAction` (`apps/web/src/lib/runAction.ts`) with `fetchWithAuth`; caller catch pattern is `if (err instanceof ActionError && err.status === 401) return;` then `if (!(err instanceof ActionError)) showToast(...)`. UI state that must survive a reload goes in `window.location.hash`, never a query param. DOM is queried by `data-testid` only.
- i18n: every new key must be added to **all 8** locale bundles — `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/tickets.json` — with a real translation, not the English string. Enforced by `apps/web/src/lib/i18n/localeParity.test.ts`.
- **CI traps.** `pnpm test` does **not** run the RLS or integration configs. The org-cascade, export-policy and every `*.integration.test.ts` suite only run in the **Integration Tests** job, so a unit-green PR can redden `main`. Run them locally with `pnpm test-stack up` … `pnpm test-stack down` (tear it down — nothing does it for you). A **stacked** PR (based on a sibling branch, not `main`) runs *no* CI at all — `gh pr checks` reads green; dispatch `gh workflow run CI --ref <branch>` per branch before merging. Never `pnpm --filter <pkg> test -- --run <path>` (the `--` makes vitest run the whole suite in watch mode); use `cd apps/api && npx vitest run <path>`. Vitest's path filter is a plain substring, not a glob — list dotted sibling files explicitly and check the reported file count.
- Every task: write the failing test first and watch it fail, implement, `pnpm --filter @breeze/api exec tsc --noEmit` (and `pnpm --filter @breeze/web exec tsc --noEmit` for web tasks), run the targeted tests, commit. Commit messages end with the repo's standard attribution lines.

---

# Wave W01 — Ticket-detail proposal card + "Post as private note" as the technician (#4211)

**Wave goal:** a technician looking at a ticket sees the AI's triage proposal in-place (not only on the agent-runs page) and can post its `summary` as an internal note **authored by themselves**, with the originating run recorded for provenance and audit.

**Wave-level design decisions (do not re-litigate mid-wave):**
1. The posted note is `origin_principal_kind = 'user'`, `user_id = <technician>`, `agent_run_id = NULL`. Setting `agent_run_id` would trip `ticketHasAgentOriginatedActivity()` (which ORs on `agent_run_id IS NOT NULL`) and silently dead-end future admissions — and W01 must ship independently of W02's guard rewrite.
2. Provenance therefore goes in a **new, separate** column `ticket_comments.proposed_by_run_id`: "which run authored the text a *human* posted", distinct from `agent_run_id` = "which run posted this row". The loop guard is untouched.
3. The card is rendered by a component extracted out of `RunDetailPage.tsx` so the two surfaces cannot drift; `RunDetailPage.tsx` (2027 lines) shrinks rather than grows.

---

### Task 1: Migration — `ticket_comments.proposed_by_run_id`

**Files:**
- Create: `apps/api/migrations/2026-10-16-181100-ticket-comment-proposed-by-run.sql`
- Modify: `apps/api/src/db/schema/portal.ts` (the `ticketComments` table, after `agentRunId`)
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing, auto-discovers), `apps/api/src/db/schema/ticketOutbox.test.ts` (existing — has a `describe('ticket_comments origin-tracking columns', …)` block)

**Interfaces:**
- Produces: column `ticket_comments.proposed_by_run_id uuid NULL`, FK `ticket_comments_proposed_by_run_id_fkey → ai_agent_runs(id) ON DELETE SET NULL`, partial index `ticket_comments_proposed_by_run_idx`; Drizzle field `ticketComments.proposedByRunId`.

- [ ] **Step 1: Write the failing schema assertion**

Add to the existing `describe('ticket_comments origin-tracking columns', …)` block in `apps/api/src/db/schema/ticketOutbox.test.ts`:

```ts
it('carries proposed_by_run_id for human-posted, AI-authored text (#4211)', () => {
  const col = (ticketComments as unknown as Record<string, { name: string; notNull: boolean }>).proposedByRunId;
  expect(col).toBeDefined();
  expect(col.name).toBe('proposed_by_run_id');
  expect(col.notNull).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/db/schema/ticketOutbox.test.ts`
Expected: FAIL — `expected undefined to be defined`.

- [ ] **Step 3: Write the migration**

```sql
-- #4211 (W01): provenance for a note a HUMAN posted from an AI proposal.
--
-- Deliberately NOT ticket_comments.agent_run_id: that column means "an agent
-- run wrote this row", and the helpdesk loop guard
-- (ticketHelpdeskSubscriber.ticketHasAgentOriginatedActivity) treats a non-null
-- agent_run_id as agent-originated activity and refuses to re-admit. A note the
-- technician posted under their own identity is human activity; recording the
-- run here keeps the loop guard's meaning intact while preserving the "which
-- run's text was this" link that #4182 (measured time saved) will need.
--
-- No DML in this file, so the migrationRlsScope guard has nothing to elect
-- system scope for.

ALTER TABLE ticket_comments
  ADD COLUMN IF NOT EXISTS proposed_by_run_id uuid;

-- FK declared in SQL only: db/schema/aiAgents.ts already imports `tickets` from
-- portal.ts, so a .references() here would be a circular module import — same
-- reason agent_run_id's FK lives only in SQL.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ticket_comments_proposed_by_run_id_fkey'
  ) THEN
    ALTER TABLE ticket_comments
      ADD CONSTRAINT ticket_comments_proposed_by_run_id_fkey
      FOREIGN KEY (proposed_by_run_id) REFERENCES ai_agent_runs(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ticket_comments_proposed_by_run_idx
  ON ticket_comments (proposed_by_run_id)
  WHERE proposed_by_run_id IS NOT NULL;
```

- [ ] **Step 4: Add the Drizzle column**

In `apps/api/src/db/schema/portal.ts`, immediately after `agentRunId: uuid('agent_run_id')` inside `ticketComments`:

```ts
  // #4211 (W01): the agent run whose ticketProposal.summary a TECHNICIAN chose
  // to post under their own identity. Distinct from agentRunId above, which
  // means "an agent run wrote this row". A row with proposedByRunId set is
  // human-authored (origin_principal_kind='user', user_id=<tech>) and MUST NOT
  // trip the helpdesk loop guard — see the migration header. FK
  // (ON DELETE SET NULL) is SQL-only, same circular-import reason as agentRunId.
  proposedByRunId: uuid('proposed_by_run_id')
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/db/schema/ticketOutbox.test.ts src/db/autoMigrate.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/migrations/2026-10-16-181100-ticket-comment-proposed-by-run.sql apps/api/src/db/schema/portal.ts apps/api/src/db/schema/ticketOutbox.test.ts
git commit -m "feat(tickets): ticket_comments.proposed_by_run_id for human-posted AI text (#4211)"
```

---

### Task 2: Ticket-move must null the new pointer

**Files:**
- Modify: `apps/api/src/services/ticketService.ts` (`moveTicketOrg`, the `update(ticketComments).set({ agentRunId: null })` statement at ~line 2637, and the system feed-entry insert just below it)
- Test: `apps/api/src/services/ticketService.test.ts`

**Interfaces:**
- Consumes: `ticketComments.proposedByRunId` from Task 1.

**Why:** `ticket_comments` has no `org_id`; on a cross-org ticket move every comment travels to the target org while the runs stay behind. `agentRunId` is already nulled for exactly this reverse-pointer reason (#4524). `proposedByRunId` is the same class of pointer and must get the same treatment, or a target-org comment names a source-org run.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/ticketService.test.ts`, in the `moveTicketOrg` describe block (mirror the existing `agentRunId: null` assertion's mock setup exactly):

```ts
it('nulls proposed_by_run_id on a cross-org move (#4211)', async () => {
  const sets = captureCommentUpdates(); // same helper the agentRunId case uses
  await moveTicketOrg(TICKET_ID, TARGET_ORG_ID, actor, {});
  expect(sets).toContainEqual(expect.objectContaining({ agentRunId: null, proposedByRunId: null }));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/ticketService.test.ts -t "proposed_by_run_id"`
Expected: FAIL — the captured set object has only `{ agentRunId: null }`.

- [ ] **Step 3: Implement**

In `moveTicketOrg`, change the detach statement to clear both pointers in one UPDATE and widen its predicate:

```ts
    await tx
      .update(ticketComments)
      .set({ agentRunId: null, proposedByRunId: null })
      .where(and(
        eq(ticketComments.ticketId, ticketId),
        or(isNotNull(ticketComments.agentRunId), isNotNull(ticketComments.proposedByRunId)),
      ));
```

and add `proposedByRunId: null` to the system feed-entry `insert(ticketComments).values({...})` just below, next to the existing `agentRunId: null`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/ticketService.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.test.ts
git commit -m "fix(tickets): drop proposed_by_run_id on cross-org ticket move (#4211)"
```

---

### Task 3: Service — read the latest proposal, post it as the technician

**Files:**
- Create: `apps/api/src/services/aiTicketProposal.ts`
- Create: `apps/api/src/services/aiTicketProposal.test.ts`
- Modify: `apps/api/src/services/aiAgents/runTrace.ts` (export `mapTicketProposal`, currently a private `function` at line 315)
- Modify: `apps/api/src/services/ticketService.ts` (add `postProposalNote`)
- Test: `apps/api/src/services/ticketService.test.ts`

**Interfaces:**
- Consumes: `ticketComments.proposedByRunId` (Task 1); `TicketActor` (`ticketService.ts:81`); `mapTicketProposal` (`runTrace.ts`); `aiAgentRuns` (`db/schema/aiAgents.ts`) with `ticketId`, `profile`, `status`, `outcome`, `finishedAt`; `createAuditLogAsync` (`services/auditService.ts`).
- Produces:
  - `getLatestTicketProposal(ticketId: string): Promise<{ runId: string; finishedAt: Date | null; proposal: AiAgentRunTicketProposalDto } | null>` in `services/aiTicketProposal.ts`.
  - `postProposalNote(ticketId: string, runId: string, content: string, actor: TicketActor): Promise<{ comment: { id: string } }>` in `services/ticketService.ts`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/aiTicketProposal.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows: unknown[] = [];
vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) }),
  },
}));

import { getLatestTicketProposal } from './aiTicketProposal';

describe('getLatestTicketProposal (#4211)', () => {
  beforeEach(() => { rows.length = 0; });

  it('returns null when the ticket has no finished triage run', async () => {
    expect(await getLatestTicketProposal('11111111-1111-1111-1111-111111111111')).toBeNull();
  });

  it('projects the newest finished triage run outcome through the run-trace mapper', async () => {
    rows.push({
      id: 'run-1',
      finishedAt: new Date('2026-09-13T00:00:00Z'),
      intentIds: [],
      outcome: { ticketProposal: { version: 1, summary: 'Printer spooler wedged; restarted.' } },
    });
    const got = await getLatestTicketProposal('11111111-1111-1111-1111-111111111111');
    expect(got?.runId).toBe('run-1');
    expect(got?.proposal.summary).toBe('Printer spooler wedged; restarted.');
  });

  it('returns null when the newest finished triage run produced no proposal', async () => {
    rows.push({ id: 'run-2', finishedAt: new Date(), intentIds: [], outcome: {} });
    expect(await getLatestTicketProposal('11111111-1111-1111-1111-111111111111')).toBeNull();
  });
});
```

Add to `apps/api/src/services/ticketService.test.ts`:

```ts
describe('postProposalNote (#4211)', () => {
  it('posts under the technician identity, private, linked to the run', async () => {
    const values = captureCommentInsert();
    await postProposalNote(TICKET_ID, RUN_ID, 'Proposed summary', { userId: USER_ID, name: 'Tech' });
    expect(values).toMatchObject({
      userId: USER_ID,
      originPrincipalKind: 'user',
      agentRunId: null,
      proposedByRunId: RUN_ID,
      isPublic: false,
      commentType: 'internal',
      authorType: 'internal',
    });
  });

  it('audits the technician as actor and the run in details', async () => {
    const audits = captureAudits();
    await postProposalNote(TICKET_ID, RUN_ID, 'Proposed summary', { userId: USER_ID, name: 'Tech' });
    expect(audits[0]).toMatchObject({
      actorId: USER_ID,
      actorType: 'user',
      action: 'ticket.comment',
      initiatedBy: 'ai',
      details: expect.objectContaining({ isInternal: true, fromAgentRunId: RUN_ID }),
    });
  });

  it('404s when the run does not belong to this ticket', async () => {
    await expect(postProposalNote(TICKET_ID, OTHER_RUN_ID, 'x', { userId: USER_ID }))
      .rejects.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiTicketProposal.test.ts src/services/ticketService.test.ts`
Expected: FAIL — `Cannot find module './aiTicketProposal'` and `postProposalNote is not a function`.

- [ ] **Step 3: Export the run-trace mapper**

In `apps/api/src/services/aiAgents/runTrace.ts`, change `function mapTicketProposal(` (line 315) to `export function mapTicketProposal(`. Nothing else changes; `buildRunTrace` keeps calling it.

- [ ] **Step 4: Write `services/aiTicketProposal.ts`**

```ts
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { aiAgentRuns } from '../db/schema/aiAgents';
import { mapTicketProposal } from './aiAgents/runTrace';
import type { AiAgentRunTicketProposalDto } from '@breeze/shared';

export interface LatestTicketProposal {
  runId: string;
  finishedAt: Date | null;
  proposal: AiAgentRunTicketProposalDto;
}

/**
 * #4211 (W01) — the newest FINISHED `profile: 'triage'` run for this ticket
 * that actually produced a `ticketProposal`, projected through the SAME
 * mapper the agent-runs detail page uses (`runTrace.mapTicketProposal`) so the
 * two surfaces cannot drift.
 *
 * Tenant safety: this function does NOT scope by org. Every caller must have
 * already resolved the ticket through `getScopedTicketOr404(auth, id)`, which
 * applies the org + site axes; `ai_agent_runs` is then reached by the
 * ticket's own id. Do not call this from anywhere that skipped that step.
 *
 * Drafts are deliberately NOT read here: `mapTicketProposal`'s draft rows only
 * enrich `draftsWritten`, and the ticket detail already has a live drafts card
 * fed by `GET /tickets/:id/ai-drafts`. Passing an empty draft list keeps this
 * endpoint one query.
 */
export async function getLatestTicketProposal(ticketId: string): Promise<LatestTicketProposal | null> {
  const rows = await db
    .select({
      id: aiAgentRuns.id,
      finishedAt: aiAgentRuns.finishedAt,
      intentIds: aiAgentRuns.intentIds,
      outcome: aiAgentRuns.outcome,
    })
    .from(aiAgentRuns)
    .where(and(
      eq(aiAgentRuns.ticketId, ticketId),
      eq(aiAgentRuns.profile, 'triage'),
      eq(aiAgentRuns.status, 'succeeded'),
    ))
    .orderBy(desc(aiAgentRuns.finishedAt))
    .limit(1);

  const run = rows[0];
  if (!run) return null;
  const raw = (run.outcome as { ticketProposal?: unknown } | null)?.ticketProposal;
  if (!raw) return null;
  const proposal = mapTicketProposal(raw, run.intentIds ?? [], [], undefined);
  if (!proposal) return null;
  return { runId: run.id, finishedAt: run.finishedAt ?? null, proposal };
}
```

- [ ] **Step 5: Write `postProposalNote` in `ticketService.ts`**

Place it directly after `addAiTriageNote` so the contrast is visible in one screen:

```ts
/**
 * #4211 (W01) — post an AI proposal's text as an INTERNAL note under the
 * CALLING technician's own identity. Posting is a human act, so this is
 * `originPrincipalKind: 'user'` + `userId: actor.userId` (contrast
 * `addAiTriageNote` directly above, which is the agent writing as itself).
 *
 * `agentRunId` stays NULL on purpose: that column means "an agent run wrote
 * this row", and the helpdesk loop guard ORs on it. The run is recorded in
 * `proposedByRunId` instead (#4211 migration header).
 *
 * `isPublic` is hardcoded false and takes no input — a proposal summary is a
 * private note by definition (`TicketTriageProposal.summary`'s own docstring:
 * "Private-note body"). There is deliberately no public variant here; a
 * customer-facing reply goes through the `reply` DRAFT path (`sendTicketDraft`).
 *
 * Audits the TECHNICIAN as the actor and the run in `details.fromAgentRunId`
 * — audit_logs has one actor column, so dual attribution is actor + details
 * (never a synthetic second actor row).
 */
export async function postProposalNote(
  ticketId: string,
  runId: string,
  content: string,
  actor: TicketActor
): Promise<{ comment: { id: string } }> {
  const ticket = await getTicketOrThrow(ticketId);

  const [run] = await db
    .select({ id: aiAgentRuns.id })
    .from(aiAgentRuns)
    .where(and(eq(aiAgentRuns.id, runId), eq(aiAgentRuns.ticketId, ticketId)))
    .limit(1);
  if (!run) throw new TicketServiceError('Proposal run not found for this ticket', 404);

  const inserted = await db.insert(ticketComments).values({
    ticketId,
    userId: actor.userId,
    authorName: actor.name ?? null,
    authorType: 'internal',
    commentType: 'internal',
    content,
    isPublic: false,
    originPrincipalKind: 'user',
    agentRunId: null,
    proposedByRunId: runId
  }).returning({ id: ticketComments.id });
  const comment = inserted[0];
  if (!comment) throw new TicketServiceError('Failed to post proposal note', 500);

  await emitTicketEvent({
    type: 'ticket.commented',
    ticketId,
    orgId: ticket.orgId,
    partnerId: ticket.partnerId ?? null,
    actorUserId: actor.userId,
    payload: { commentId: comment.id, isPublic: false }
  });
  await writeTicketOutbox(ticket.orgId, ticketId, 'ticket.commented', { commentId: comment.id, isPublic: false });
  await createAuditLogAsync({
    orgId: ticket.orgId,
    actorId: actor.userId,
    actorType: 'user',
    action: 'ticket.comment',
    resourceType: 'ticket',
    resourceId: ticketId,
    details: { commentId: comment.id, isInternal: true, fromAgentRunId: runId },
    result: 'success',
    initiatedBy: 'ai'
  });

  return { comment };
}
```

Add `aiAgentRuns` to the schema imports at the top of `ticketService.ts` if it is not already there.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiTicketProposal.test.ts src/services/ticketService.test.ts src/services/aiAgents/runTrace.test.ts`
Expected: PASS (all three files).

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/aiTicketProposal.ts apps/api/src/services/aiTicketProposal.test.ts apps/api/src/services/aiAgents/runTrace.ts apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.test.ts
git commit -m "feat(tickets): read the latest AI ticket proposal and post it as the technician (#4211)"
```

---

### Task 4: Routes — `GET /tickets/:id/ai-proposal` and `POST /tickets/:id/ai-proposal/post-note`

**Files:**
- Modify: `apps/api/src/routes/tickets/aiDrafts.ts` (add both routes to the existing `ticketAiDraftsRoutes` router — it is already mounted before the generic `/:id` matcher in `routes/tickets/index.ts`)
- Test: `apps/api/src/routes/tickets/aiDrafts.test.ts`

**Interfaces:**
- Consumes: `getLatestTicketProposal`, `postProposalNote` (Task 3); `getScopedTicketOr404`, `actorFrom`, `handleServiceError` (already imported in this file from `./tickets`); `requireScope`, `requirePermission`, `PERMISSIONS.TICKETS_READ` / `TICKETS_WRITE`.
- Produces: `GET /tickets/:id/ai-proposal` → `200 { data: { runId, finishedAt, proposal } | null }`; `POST /tickets/:id/ai-proposal/post-note` → `201 { data: { commentId } }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/tickets/aiDrafts.test.ts` (reuse the file's existing mock scaffolding for `getScopedTicketOr404` and the service module):

```ts
describe('GET /tickets/:id/ai-proposal (#4211)', () => {
  it('404s when the ticket is out of scope', async () => {
    mockScoped(null);
    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-proposal`);
    expect(res.status).toBe(404);
  });

  it('returns null data when no triage run produced a proposal', async () => {
    mockScoped({ orgId: ORG_ID });
    vi.mocked(getLatestTicketProposal).mockResolvedValue(null);
    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-proposal`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null });
  });

  it('returns the projected proposal', async () => {
    mockScoped({ orgId: ORG_ID });
    vi.mocked(getLatestTicketProposal).mockResolvedValue({
      runId: RUN_ID, finishedAt: null, proposal: { version: 1, summary: 's' },
    });
    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-proposal`);
    expect((await res.json()).data.runId).toBe(RUN_ID);
  });
});

describe('POST /tickets/:id/ai-proposal/post-note (#4211)', () => {
  it('rejects a body with no runId', async () => {
    mockScoped({ orgId: ORG_ID });
    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-proposal/post-note`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('posts with the session actor and returns 201', async () => {
    mockScoped({ orgId: ORG_ID });
    vi.mocked(postProposalNote).mockResolvedValue({ comment: { id: COMMENT_ID } });
    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-proposal/post-note`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: RUN_ID, content: 'Proposed summary' }),
    });
    expect(res.status).toBe(201);
    expect(vi.mocked(postProposalNote)).toHaveBeenCalledWith(
      TICKET_ID, RUN_ID, 'Proposed summary', expect.objectContaining({ userId: USER_ID }),
    );
  });

  it('never accepts an isPublic field', async () => {
    mockScoped({ orgId: ORG_ID });
    const res = await ticketsRoutes.request(`/${TICKET_ID}/ai-proposal/post-note`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: RUN_ID, content: 'x', isPublic: true }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/routes/tickets/aiDrafts.test.ts`
Expected: FAIL — the new routes 404 through to the generic handler.

- [ ] **Step 3: Implement the routes**

Add to `apps/api/src/routes/tickets/aiDrafts.ts` (imports: `getLatestTicketProposal` from `../../services/aiTicketProposal`, `postProposalNote` from `../../services/ticketService`):

```ts
// #4211 (W01) — the ticket-detail view of the agent's triage proposal, and the
// one-click "post it as me". Same RBAC/scoping idiom as the ai-drafts routes
// above: tickets:read for the read, tickets:write for the post.
const postNoteSchema = z.object({
  runId: z.string().guid(),
  // The technician may edit the summary before posting. Bounded by the
  // proposal's own summary cap (TicketTriageProposal.summary: 1..2000).
  content: z.string().trim().min(1).max(2000)
}).strict();   // .strict() is load-bearing: it rejects an `isPublic` field
               // outright rather than silently ignoring it. This endpoint has
               // no public variant, by design.

ticketAiDraftsRoutes.get(
  '/:id/ai-proposal',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  zValidator('param', idParam),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    const found = await getScopedTicketOr404(auth, id);
    if (!found) return c.json({ error: 'Ticket not found' }, 404);
    return c.json({ data: await getLatestTicketProposal(id) });
  }
);

ticketAiDraftsRoutes.post(
  '/:id/ai-proposal/post-note',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', idParam),
  zValidator('json', postNoteSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { runId, content } = c.req.valid('json');
    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    const found = await getScopedTicketOr404(auth, id);
    if (!found) return c.json({ error: 'Ticket not found' }, 404);
    try {
      const { comment } = await postProposalNote(id, runId, content, actorFrom(c));
      return c.json({ data: { commentId: comment.id } }, 201);
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);
```

Register both paths **above** the existing `/:id/ai-drafts/:draftId/*` handlers is not required (segment counts differ), but keep them inside this router so the mount ordering in `routes/tickets/index.ts` is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/tickets/aiDrafts.test.ts src/routes/tickets/tickets.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/routes/tickets/aiDrafts.ts apps/api/src/routes/tickets/aiDrafts.test.ts
git commit -m "feat(api): GET /tickets/:id/ai-proposal + post-note routes (#4211)"
```

---

### Task 5: Web — extract the proposal card and render it on the ticket detail

**Files:**
- Create: `apps/web/src/components/aiAgents/TicketProposalCard.tsx`
- Create: `apps/web/src/components/aiAgents/TicketProposalCard.test.tsx`
- Modify: `apps/web/src/components/aiAgents/RunDetailPage.tsx` (delete the private `TicketProposalSection` at ~line 997; import and render the extracted component at its call site ~line 1737)
- Modify: `apps/web/src/components/tickets/TicketWorkbench.tsx` (fetch + render + post)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/tickets.json`
- Test: `apps/web/src/components/tickets/TicketWorkbench.test.tsx`, `apps/web/src/components/aiAgents/RunDetailPage.test.tsx` (existing — must stay green unchanged), `apps/web/src/lib/i18n/localeParity.test.ts` (existing)

**Interfaces:**
- Consumes: `GET /tickets/:id/ai-proposal`, `POST /tickets/:id/ai-proposal/post-note` (Task 4); `AiAgentRunTicketProposalDto` from `@breeze/shared`.
- Produces: `export function TicketProposalCard(props: { proposal: AiAgentRunTicketProposalDto; intents?: AiAgentRunIntentSummaryDto[]; t: TFunction; onPostNote?: (content: string) => void | Promise<void>; posting?: boolean })`.

**Note on `data-testid`:** the extracted component keeps every existing testid verbatim (`ai-agent-run-triage`, `-summary`, `-fields`, `-device`, `-draft-reply`, `-draft-resolution`, `-notes`, `-intents`) so `RunDetailPage.test.tsx` passes without edits. The new post button is `ai-agent-run-triage-post-note`, rendered only when `onPostNote` is supplied — i.e. never on the run-detail page.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/aiAgents/TicketProposalCard.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { TicketProposalCard } from './TicketProposalCard';

const t = ((k: string) => k) as never;
const proposal = { version: 1 as const, summary: 'Spooler wedged; restarted.', notes: ['Check driver'] };

describe('TicketProposalCard (#4211)', () => {
  it('renders the summary under the existing triage testids', () => {
    render(<TicketProposalCard proposal={proposal} t={t} />);
    expect(screen.getByTestId('ai-agent-run-triage-summary')).toHaveTextContent('Spooler wedged; restarted.');
  });

  it('hides the post button when no handler is supplied', () => {
    render(<TicketProposalCard proposal={proposal} t={t} />);
    expect(screen.queryByTestId('ai-agent-run-triage-post-note')).toBeNull();
  });

  it('calls onPostNote with the summary when clicked', async () => {
    const onPostNote = vi.fn();
    render(<TicketProposalCard proposal={proposal} t={t} onPostNote={onPostNote} />);
    await userEvent.click(screen.getByTestId('ai-agent-run-triage-post-note'));
    expect(onPostNote).toHaveBeenCalledWith('Spooler wedged; restarted.');
  });
});
```

Add to `apps/web/src/components/tickets/TicketWorkbench.test.tsx` (extend the existing fetch-mock switch; do **not** restructure the file):

```tsx
describe('TicketWorkbench AI proposal card (#4211)', () => {
  it('renders the proposal fetched for the ticket', async () => {
    mockFetch({ '/tickets/tk-1/ai-proposal': { data: { runId: 'run-1', finishedAt: null, proposal: { version: 1, summary: 'Spooler wedged.' } } } });
    renderWorkbench();
    expect(await screen.findByTestId('ai-agent-run-triage-summary')).toHaveTextContent('Spooler wedged.');
  });

  it('posts the summary as a private note through runAction and refetches', async () => {
    const calls = mockFetch({ '/tickets/tk-1/ai-proposal': { data: { runId: 'run-1', finishedAt: null, proposal: { version: 1, summary: 'Spooler wedged.' } } } });
    renderWorkbench();
    await userEvent.click(await screen.findByTestId('ai-agent-run-triage-post-note'));
    expect(calls).toContainEqual(expect.objectContaining({
      url: '/tickets/tk-1/ai-proposal/post-note',
      method: 'POST',
      body: { runId: 'run-1', content: 'Spooler wedged.' },
    }));
  });

  it('renders no card when the endpoint returns null data', async () => {
    mockFetch({ '/tickets/tk-1/ai-proposal': { data: null } });
    renderWorkbench();
    await screen.findByTestId('ticket-feed');
    expect(screen.queryByTestId('ai-agent-run-triage')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && npx vitest run src/components/aiAgents/TicketProposalCard.test.tsx src/components/tickets/TicketWorkbench.test.tsx`
Expected: FAIL — `Cannot find module './TicketProposalCard'`, and the workbench never requests `/ai-proposal`.

- [ ] **Step 3: Extract the card**

Move the body of `TicketProposalSection` out of `RunDetailPage.tsx` into `apps/web/src/components/aiAgents/TicketProposalCard.tsx` verbatim, then:
- rename the export to `TicketProposalCard` and `export` it;
- widen the props to `{ proposal, intents?, t, onPostNote?, posting? }`;
- append, inside the root `<div data-testid="ai-agent-run-triage">`, after the summary block:

```tsx
      {onPostNote && (
        <button
          type="button"
          data-testid="ai-agent-run-triage-post-note"
          className="mt-2 rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50"
          disabled={posting}
          onClick={() => { void onPostNote(proposal.summary); }}
        >
          {t('ticketWorkbench.aiProposal.postAsNote')}
        </button>
      )}
```

In `RunDetailPage.tsx`, delete the old local function and replace the call site with `<TicketProposalCard proposal={run.ticketProposal} intents={run.intents} t={t} />` (no `onPostNote` — the run-detail page never posts).

- [ ] **Step 4: Wire the ticket detail**

In `apps/web/src/components/tickets/TicketWorkbench.tsx`, next to the existing `refetchAiDrafts` block:

```tsx
  const [aiProposal, setAiProposal] = useState<{ runId: string; proposal: AiAgentRunTicketProposalDto } | null>(null);
  const [postingProposal, setPostingProposal] = useState(false);

  const refetchAiProposal = useCallback(async (forTicketId: string) => {
    try {
      const res = await fetchWithAuth(`/tickets/${forTicketId}/ai-proposal`);
      if (!res.ok) { setAiProposal(null); return; }
      const body = await res.json();
      setAiProposal(body?.data ?? null);
    } catch { setAiProposal(null); }
  }, []);

  useEffect(() => {
    if (!ticket || !ticketId) { setAiProposal(null); return; }
    void refetchAiProposal(ticketId);
  }, [ticket, ticketId, refetchAiProposal]);

  const postProposalNote = useCallback(async (content: string) => {
    if (!aiProposal || postingProposal) return;
    setPostingProposal(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${ticketId}/ai-proposal/post-note`, {
          method: 'POST',
          body: JSON.stringify({ runId: aiProposal.runId, content })
        }),
        errorFallback: t('ticketWorkbench.aiProposal.postFailed'),
        successMessage: t('ticketWorkbench.aiProposal.posted')
      });
      setAiProposal(null);
      await afterMutation();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('ticketWorkbench.aiProposal.postFailed') });
    } finally {
      setPostingProposal(false);
    }
  }, [afterMutation, aiProposal, postingProposal, ticketId, t]);
```

and render it immediately above the AI-drafts card:

```tsx
        {aiProposal && (
          <TicketProposalCard
            proposal={aiProposal.proposal}
            t={t}
            onPostNote={postProposalNote}
            posting={postingProposal}
          />
        )}
```

- [ ] **Step 5: Add the i18n keys to all 8 bundles**

Add under `ticketWorkbench` in `apps/web/src/locales/en/tickets.json`:

```json
      "aiProposal": {
        "postAsNote": "Post as private note",
        "posted": "Posted as a private note",
        "postFailed": "Could not post the note"
      }
```

Then add the same block, **really translated**, to `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`. Suggested strings:
- de-DE: `"Als interne Notiz posten"` / `"Als interne Notiz gepostet"` / `"Notiz konnte nicht gepostet werden"`
- es-419: `"Publicar como nota privada"` / `"Publicado como nota privada"` / `"No se pudo publicar la nota"`
- fr-CA: `"Publier comme note privée"` / `"Publié comme note privée"` / `"Impossible de publier la note"`
- fr-FR: `"Publier en note privée"` / `"Publié en note privée"` / `"Impossible de publier la note"`
- it-IT: `"Pubblica come nota privata"` / `"Pubblicato come nota privata"` / `"Impossibile pubblicare la nota"`
- pt-BR: `"Publicar como nota privada"` / `"Publicado como nota privada"` / `"Não foi possível publicar a nota"`
- tr-TR: `"Özel not olarak gönder"` / `"Özel not olarak gönderildi"` / `"Not gönderilemedi"`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/aiAgents/TicketProposalCard.test.tsx src/components/aiAgents/RunDetailPage.test.tsx src/components/tickets/TicketWorkbench.test.tsx src/lib/i18n/localeParity.test.ts`
Expected: PASS (four files). `RunDetailPage.test.tsx` must pass **without edits** — if it does not, the extraction changed a testid or a rendered string; fix the component, not the test.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm --filter @breeze/web exec tsc --noEmit
git add apps/web/src/components/aiAgents/TicketProposalCard.tsx apps/web/src/components/aiAgents/TicketProposalCard.test.tsx apps/web/src/components/aiAgents/RunDetailPage.tsx apps/web/src/components/tickets/TicketWorkbench.tsx apps/web/src/components/tickets/TicketWorkbench.test.tsx apps/web/src/locales
git commit -m "feat(web): render the AI ticket proposal on the ticket detail with post-as-me (#4211)"
```

---

### Task 6: W01 integration proof + PR

**Files:**
- Create: `apps/api/src/__tests__/integration/ticketProposalPostNote.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-4.

- [ ] **Step 1: Write the integration test**

Model the fixture setup on `apps/api/src/__tests__/integration/aiAgentTicketTriage.integration.test.ts`. Assert against real Postgres:

```ts
it('a technician-posted proposal note is human-origin, private, and run-linked (#4211)', async () => {
  // ... seed partner/org/user/ticket and a succeeded triage run with an outcome
  await postProposalNote(ticketId, runId, 'Summary text', { userId, name: 'Tech' });
  const [row] = await sysDb.select().from(ticketComments).where(eq(ticketComments.ticketId, ticketId));
  expect(row.originPrincipalKind).toBe('user');
  expect(row.userId).toBe(userId);
  expect(row.agentRunId).toBeNull();
  expect(row.proposedByRunId).toBe(runId);
  expect(row.isPublic).toBe(false);
});

it('the helpdesk loop guard still sees the ticket as human-only (#4211)', async () => {
  // ticketHasAgentOriginatedActivity is not exported; assert its query shape instead
  const [hit] = await sysDb.select({ id: ticketComments.id }).from(ticketComments).where(and(
    eq(ticketComments.ticketId, ticketId),
    or(ne(ticketComments.originPrincipalKind, 'user'), isNotNull(ticketComments.agentRunId)),
  )).limit(1);
  expect(hit).toBeUndefined();
});

it('a cross-org move drops proposed_by_run_id (#4211)', async () => {
  await moveTicketOrg(ticketId, targetOrgId, actor, {});
  const [row] = await sysDb.select().from(ticketComments).where(eq(ticketComments.id, commentId));
  expect(row.proposedByRunId).toBeNull();
});
```

- [ ] **Step 2: Run the live-DB suites**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/ticketProposalPostNote.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts
cd ../.. && pnpm test-stack down
```

Expected: all PASS. `tenant-export-policy` must be green **unchanged** — `ticket_comments` has no `org_id`, so a new column on it is not export-classified. If it reds, you added the column to the wrong table.

- [ ] **Step 3: Commit and open the PR**

```bash
git add apps/api/src/__tests__/integration/ticketProposalPostNote.integration.test.ts
git commit -m "test(tickets): integration proof for the technician-posted AI proposal note (#4211)"
git push -u origin feature/<parent>-ai-helpdesk-followon/wave-4211
gh pr create --base main --title "feat(tickets): AI ticket proposal on the ticket detail, posted as the technician" --body "Closes #4211 …"
```

Stop at the open PR. Do not merge.

---

# Wave W02 — Per-event admissions on `ticket.commented` / `ticket.status_changed` (#4212)

**Wave goal:** every genuinely human public comment can admit its *own* re-triage run, bounded by a recency-ordered loop guard and a hard per-ticket ceiling, instead of the current "one triage run per ticket, first event wins".

**What is already true (verified, do not rebuild):** `ticketHelpdeskSubscriber.ts` is already subscribed to all three event types and already admits on `ticket.commented` (via `loadVerifiedHumanComment`) and on `ticket.status_changed → resolved` (via `isEligibleForResolvedAdmission`).

**The two verified defects this wave fixes:**
1. The commented lane reuses the created lane's dedupe key `ticket-created:<ticketId>`, and `ai_agent_runs_org_dedupe_key_uq` is `(org_id, dedupe_key)` — so the *second* human comment on a ticket can never admit a run. The doc comment calls this the "first-admitting-event-wins contract"; #4212 supersedes it.
2. Even with a per-event key, `ticketHasAgentOriginatedActivity()` is a permanent latch: once any triage run posts its AI note, the created/commented lanes are dead for the life of the ticket. A re-triage lane needs an *ordered* guard, not a latch.

**Explicit scope boundaries (decided, with reasons):**
- The `ticket.created` key stays `ticket-created:<ticketId>` and the resolved key stays `ticket-resolved:<ticketId>`. Both are per-ticket *by semantics* — one first-pass, one resolution pass. Changing either key's format would re-admit a run on every existing ticket the moment this deploys.
- A reopen → re-resolve cycle still admits at most one resolved-lane run per ticket. Out of scope; note it in the PR body.

---

### Task 7: Per-event dedupe key for the commented lane

**Files:**
- Modify: `apps/api/src/services/aiAgents/ticketHelpdeskSubscriber.ts` (`handleTicketCommentedEvent`, ~line 402; and the module header comment's `ticket.commented` bullet)
- Test: `apps/api/src/services/aiAgents/ticketHelpdeskSubscriber.test.ts`

**Interfaces:**
- Consumes: `loadVerifiedHumanComment` (existing, returns the DB-verified comment row), `admitTriageRun(orgId, ticketId, dedupeKey, applyLoopGuard?)` (existing).
- Produces: dedupe key format `ticket-commented:<commentId>`.

- [ ] **Step 1: Write the failing test**

```ts
it('admits the commented lane under a per-comment dedupe key (#4212)', async () => {
  mockVerifiedHumanComment({ id: COMMENT_ID, ticketId: TICKET_ID, orgId: ORG_ID });
  await handleTicketCommentedEvent(commentedEvent({ commentId: COMMENT_ID }));
  expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(
    expect.objectContaining({ dedupeKey: `ticket-commented:${COMMENT_ID}` }),
  );
});

it('a second human comment admits a second run (#4212)', async () => {
  mockVerifiedHumanComment({ id: 'c1', ticketId: TICKET_ID, orgId: ORG_ID });
  await handleTicketCommentedEvent(commentedEvent({ commentId: 'c1' }));
  mockVerifiedHumanComment({ id: 'c2', ticketId: TICKET_ID, orgId: ORG_ID });
  await handleTicketCommentedEvent(commentedEvent({ commentId: 'c2' }));
  const keys = vi.mocked(createAndEnqueueAgentRun).mock.calls.map(([a]) => a.dedupeKey);
  expect(keys).toEqual(['ticket-commented:c1', 'ticket-commented:c2']);
});

it('leaves the created lane key untouched (#4212)', async () => {
  await handleTicketCreatedEvent(createdEvent());
  expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(
    expect.objectContaining({ dedupeKey: `ticket-created:${TICKET_ID}` }),
  );
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd apps/api && npx vitest run src/services/aiAgents/ticketHelpdeskSubscriber.test.ts -t "4212"`
Expected: FAIL — both commented cases assert `ticket-created:<ticketId>`.

- [ ] **Step 3: Implement**

In `handleTicketCommentedEvent`, replace `await admitTriageRun(orgId, ticketId, \`ticket-created:${ticketId}\`);` with:

```ts
    // #4212: per-EVENT dedupe. The comment IS the event, so its id is the
    // natural idempotency key: a redelivered outbox row for the same comment
    // collides on ai_agent_runs_org_dedupe_key_uq and no-ops, while the NEXT
    // human comment gets its own key and can admit its own re-triage run.
    // Before this change the commented lane shared `ticket-created:<ticketId>`
    // with the created lane, which capped the ticket at one triage run for
    // life (the "first-admitting-event-wins contract" the old header comment
    // described — deliberately superseded here).
    await admitTriageRun(orgId, ticketId, `ticket-commented:${comment.id}`);
```

Update the module header's `ticket.commented` bullet to describe the new key and delete the "SAME dedupe key" sentence.

- [ ] **Step 4: Verify green**

Run: `cd apps/api && npx vitest run src/services/aiAgents/ticketHelpdeskSubscriber.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/aiAgents/ticketHelpdeskSubscriber.ts apps/api/src/services/aiAgents/ticketHelpdeskSubscriber.test.ts
git commit -m "feat(ai-agents): per-comment dedupe key for the helpdesk commented lane (#4212)"
```

---

### Task 8: Replace the latching loop guard with a recency-ordered one

**Files:**
- Modify: `apps/api/src/services/aiAgents/ticketHelpdeskSubscriber.ts` (`ticketHasAgentOriginatedActivity` → `humanCommentIsNewerThanAgentActivity`; `admitTriageRun`'s `applyLoopGuard` param)
- Test: `apps/api/src/services/aiAgents/ticketHelpdeskSubscriber.test.ts`

**Interfaces:**
- Produces: `humanCommentIsNewerThanAgentActivity(ticketId: string, humanCommentCreatedAt: Date): Promise<boolean>` — replaces the boolean latch. `admitTriageRun` gains `loopGuard: { humanCommentAt: Date } | 'skip'` in place of the `applyLoopGuard: boolean` param.

**Design:** the ticket may re-triage only when the human said something *after* the agent last spoke. The created lane has no prior comments, so it passes vacuously; the resolved lane still skips the guard entirely (unchanged reason: every triage run posts an AI note, so a latch there dead-ends the lane permanently, and `isEligibleForResolvedAdmission`'s fresh re-read is that lane's own anti-loop gate).

- [ ] **Step 1: Write the failing tests**

```ts
describe('recency-ordered loop guard (#4212)', () => {
  it('admits when the human comment is newer than the newest agent comment', async () => {
    seedComments([
      { originPrincipalKind: 'ai_agent', agentRunId: 'r1', createdAt: new Date('2026-09-10T10:00:00Z') },
    ]);
    mockVerifiedHumanComment({ id: 'c2', ticketId: TICKET_ID, orgId: ORG_ID, createdAt: new Date('2026-09-10T11:00:00Z') });
    await handleTicketCommentedEvent(commentedEvent({ commentId: 'c2' }));
    expect(createAndEnqueueAgentRun).toHaveBeenCalled();
  });

  it('skips when the newest agent comment is newer than the human comment (redelivery)', async () => {
    seedComments([
      { originPrincipalKind: 'ai_agent', agentRunId: 'r1', createdAt: new Date('2026-09-10T12:00:00Z') },
    ]);
    mockVerifiedHumanComment({ id: 'c1', ticketId: TICKET_ID, orgId: ORG_ID, createdAt: new Date('2026-09-10T11:00:00Z') });
    await handleTicketCommentedEvent(commentedEvent({ commentId: 'c1' }));
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('a brand-new ticket with no comments still admits (created lane)', async () => {
    seedComments([]);
    await handleTicketCreatedEvent(createdEvent());
    expect(createAndEnqueueAgentRun).toHaveBeenCalled();
  });

  it('a DB error in the guard denies rather than admitting', async () => {
    seedCommentsThrows(new Error('boom'));
    mockVerifiedHumanComment({ id: 'c1', ticketId: TICKET_ID, orgId: ORG_ID, createdAt: new Date() });
    await handleTicketCommentedEvent(commentedEvent({ commentId: 'c1' }));
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd apps/api && npx vitest run src/services/aiAgents/ticketHelpdeskSubscriber.test.ts -t "recency-ordered"`
Expected: FAIL — the first case is blocked by the latch.

- [ ] **Step 3: Implement**

Replace `ticketHasAgentOriginatedActivity` with:

```ts
/**
 * #4212 — the loop guard, ordered rather than latching.
 *
 * The old `ticketHasAgentOriginatedActivity` returned true as soon as ANY
 * agent-originated comment existed, which permanently dead-ended the
 * created/commented lanes after a ticket's first triage pass — acceptable when
 * those lanes shared one dedupe key and could only fire once anyway (#3828 /
 * #4191), and wrong now that each human comment carries its own key (Task 7).
 *
 * The replacement admits only when the human actually spoke AFTER the agent
 * last did. That is exactly what stops ping-pong: the agent's own note (and
 * any comment a human posted FROM an agent proposal, which carries
 * origin_principal_kind='user' and so is human by construction — #4211) can
 * never be the thing that re-admits a run, because a run's note is never
 * newer than the human comment that triggered it.
 *
 * Fail-closed: any read error denies. Same discipline as
 * `evaluateTicketAutonomy` — a loop guard that fails open is a runaway spend.
 */
async function humanCommentIsNewerThanAgentActivity(
  ticketId: string,
  humanCommentCreatedAt: Date,
): Promise<boolean> {
  const { db } = dbModule;
  try {
    const [newestAgent] = await db
      .select({ createdAt: ticketComments.createdAt })
      .from(ticketComments)
      .where(and(
        eq(ticketComments.ticketId, ticketId),
        or(ne(ticketComments.originPrincipalKind, HUMAN_ORIGIN_KIND), isNotNull(ticketComments.agentRunId)),
      ))
      .orderBy(desc(ticketComments.createdAt))
      .limit(1);
    if (!newestAgent) return true;
    return humanCommentCreatedAt.getTime() > newestAgent.createdAt.getTime();
  } catch (err) {
    console.error('[ticketHelpdesk] loop-guard read failed — denying admission:', err);
    return false;
  }
}
```

Change `admitTriageRun`'s fourth parameter from `applyLoopGuard = true` to `loopGuard: { humanCommentAt: Date } | 'skip'`, and inside it:

```ts
  if (loopGuard !== 'skip') {
    const ok = await runWithSystemDbAccess(() =>
      humanCommentIsNewerThanAgentActivity(ticketId, loopGuard.humanCommentAt));
    if (!ok) return;
  }
```

Call sites:
- created lane: `admitTriageRun(orgId, ticketId, \`ticket-created:${ticketId}\`, { humanCommentAt: new Date(0) })` — a brand-new ticket has no comments, so the guard returns true vacuously; passing epoch makes "no prior agent activity" the only path that can admit and keeps a redelivered `ticket.created` for an already-triaged ticket denied.
- commented lane: `admitTriageRun(orgId, ticketId, \`ticket-commented:${comment.id}\`, { humanCommentAt: comment.createdAt })`.
- resolved lane: `admitTriageRun(orgId, ticketId, \`ticket-resolved:${ticketId}\`, 'skip')` — unchanged behaviour, now spelled explicitly.

Ensure `loadVerifiedHumanComment` selects `createdAt` (add it to the select list if absent) and `desc` is imported from `drizzle-orm`.

- [ ] **Step 4: Verify green**

Run: `cd apps/api && npx vitest run src/services/aiAgents/ticketHelpdeskSubscriber.test.ts src/services/aiAgents/ticketShadowGuardrail.contract.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/aiAgents/ticketHelpdeskSubscriber.ts apps/api/src/services/aiAgents/ticketHelpdeskSubscriber.test.ts
git commit -m "feat(ai-agents): recency-ordered helpdesk loop guard replaces the latch (#4212)"
```

---

### Task 9: Hard per-ticket re-triage ceiling

**Files:**
- Modify: `apps/api/src/services/aiAgents/ticketHelpdeskSubscriber.ts`
- Test: `apps/api/src/services/aiAgents/ticketHelpdeskSubscriber.test.ts`

**Interfaces:**
- Produces: `export const MAX_TRIAGE_RUNS_PER_TICKET = 5;` and a count check inside `admitTriageRun`.

**Why a constant and not a policy field:** the existing `ai_agents.limits` jsonb is at schemaVersion 8 and every bump ripples through `validators/aiAgents.ts`, `effectivePolicy.ts`, `agentPreview.ts` and the settings UI. A ceiling is a safety backstop, not a knob techs tune — `limits.maxTriageRunsPerHour` and `cooldownSeconds` are the tunable dials and already apply. Revisit only if a customer asks.

- [ ] **Step 1: Write the failing test**

```ts
it('stops admitting after MAX_TRIAGE_RUNS_PER_TICKET runs on one ticket (#4212)', async () => {
  seedTriageRunCount(MAX_TRIAGE_RUNS_PER_TICKET);
  mockVerifiedHumanComment({ id: 'c9', ticketId: TICKET_ID, orgId: ORG_ID, createdAt: new Date() });
  await handleTicketCommentedEvent(commentedEvent({ commentId: 'c9' }));
  expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
});

it('still admits below the ceiling (#4212)', async () => {
  seedTriageRunCount(MAX_TRIAGE_RUNS_PER_TICKET - 1);
  mockVerifiedHumanComment({ id: 'c9', ticketId: TICKET_ID, orgId: ORG_ID, createdAt: new Date() });
  await handleTicketCommentedEvent(commentedEvent({ commentId: 'c9' }));
  expect(createAndEnqueueAgentRun).toHaveBeenCalled();
});

it('counts denied rather than admitting when the count read throws (#4212)', async () => {
  seedTriageRunCountThrows(new Error('boom'));
  mockVerifiedHumanComment({ id: 'c9', ticketId: TICKET_ID, orgId: ORG_ID, createdAt: new Date() });
  await handleTicketCommentedEvent(commentedEvent({ commentId: 'c9' }));
  expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd apps/api && npx vitest run src/services/aiAgents/ticketHelpdeskSubscriber.test.ts -t "MAX_TRIAGE_RUNS_PER_TICKET"`
Expected: FAIL — admission still happens at the ceiling.

- [ ] **Step 3: Implement**

```ts
/**
 * #4212 — absolute per-ticket backstop on re-triage. Independent of the
 * per-hour / concurrency / budget caps in runService.ts, which are per AGENT:
 * a single pathological ticket that a customer replies to twenty times must
 * not consume an org's whole triage budget on its own. Counted over every
 * triage-profile run ever admitted for the ticket, not a rolling window, so
 * the ceiling is a true ceiling.
 *
 * Fail-closed on a read error, same as the loop guard.
 */
export const MAX_TRIAGE_RUNS_PER_TICKET = 5;

async function triageRunCeilingReached(ticketId: string): Promise<boolean> {
  const { db } = dbModule;
  try {
    const rows = await db
      .select({ id: aiAgentRuns.id })
      .from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.ticketId, ticketId), eq(aiAgentRuns.profile, 'triage')))
      .limit(MAX_TRIAGE_RUNS_PER_TICKET);
    return rows.length >= MAX_TRIAGE_RUNS_PER_TICKET;
  } catch (err) {
    console.error('[ticketHelpdesk] triage-run ceiling read failed — denying admission:', err);
    return true;
  }
}
```

Call it inside `admitTriageRun`, wrapped in `runWithSystemDbAccess`, immediately after the loop guard and before `createAndEnqueueAgentRun`. Import `aiAgentRuns` from `'../../db/schema/aiAgents'`.

- [ ] **Step 4: Verify green**

Run: `cd apps/api && npx vitest run src/services/aiAgents/ticketHelpdeskSubscriber.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/aiAgents/ticketHelpdeskSubscriber.ts apps/api/src/services/aiAgents/ticketHelpdeskSubscriber.test.ts
git commit -m "feat(ai-agents): hard per-ticket triage-run ceiling (#4212)"
```

---

### Task 10: W02 integration proof + PR

**Files:**
- Modify: `apps/api/src/__tests__/integration/aiAgentTicketTriage.integration.test.ts` (extend; do not create a parallel file — that suite already owns the live-DB triage fixtures)

- [ ] **Step 1: Write the integration cases**

```ts
it('two human comments admit two runs with distinct dedupe keys (#4212)', async () => { /* … */ });
it('an agent note followed by a redelivered older human comment admits nothing (#4212)', async () => { /* … */ });
it('the sixth human comment on one ticket admits nothing (#4212)', async () => { /* … */ });
```

- [ ] **Step 2: Run the live-DB suites**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiAgentTicketTriage.integration.test.ts
cd ../.. && pnpm test-stack down
```

Expected: PASS.

- [ ] **Step 3: Commit and open the PR**

```bash
git add apps/api/src/__tests__/integration/aiAgentTicketTriage.integration.test.ts
git commit -m "test(ai-agents): live-DB proof for per-event helpdesk admissions (#4212)"
git push -u origin feature/<parent>-ai-helpdesk-followon/wave-4212
gh pr create --base main --title "feat(ai-agents): per-event helpdesk admissions with an ordered loop guard" --body "Closes #4212 …"
```

Call out in the PR body: (a) the first deploy admits at most one extra run per ticket that already has a human comment newer than its AI note; (b) a reopen → re-resolve cycle still admits only one resolved-lane run, out of scope.

---

# Wave W03 — Harden the autonomous private-note lane (#4209)

**Wave goal:** close the three verified gaps left by P2-4 in the lane that already exists, so the autonomous note is auditable, provably private at the database level, and cannot be reached by the `manage_tickets` actions that were never taught about the agent principal.

**Read this first — #4209's core is already shipped.** VERIFIED on `origin/main`: the `ai_agent` principal kind (`middleware/auth.ts`), `buildAgentAuthContext` (which sets `user.id = aiAgents.id` for attribution only and `userId: null` in the DB access context), `addAiTriageNote()` writing `user_id=NULL` + `origin_principal_kind='ai_agent'` + `agent_run_id`, RLS policy `breeze_ticket_parent_ai_agent_insert` (`2026-09-25-b-ai-agents-ticket-triage-ai-note-rls.sql`) permitting exactly that insert, the `comment` branch of `manage_tickets` routing an `ai_agent` principal to `addAiTriageNote` (`aiToolsTicketing.ts:522-527`), and the per-agent opt-in gate `triggers.ticketAutonomousWrites` enforced five ways by `evaluateTicketAutonomy`. **Do not re-implement any of it.** This wave is the residue.

**The three verified gaps:**
1. **No audit trail.** `addTicketComment` calls `createAuditLogAsync` (`ticketService.ts:1579`); `addAiTriageNote` does not — verified by reading the whole function body. An autonomous write with no audit row is the one thing an MSP's own compliance review will find first.
2. **`isPublic` is forced only in application code.** `addAiTriageNote` hardcodes `false`, but nothing at the database level stops a future writer from inserting `origin_principal_kind='ai_agent'` with `is_public=true`. The issue's requirement is "`isPublic` forced false"; a hardcode is not a force.
3. **Three `manage_tickets` actions never learned about the agent principal.** `comment`, `update_fields` and `draft` branch on `agentRunIdFrom(auth)`; `assign`, `update_status` and `create` call `actorFrom(auth)` unconditionally, which for an `ai_agent` principal puts `aiAgents.id` into a `users` FK. Not exercised by any test found, so it is latent rather than shipped-broken — but the autonomous lane is exactly what makes it reachable.

---

### Task 11: Audit every agent-authored ticket note

**Files:**
- Modify: `apps/api/src/services/ticketService.ts` (`addAiTriageNote`)
- Test: `apps/api/src/services/ticketService.aiExecutors.test.ts`

**Interfaces:**
- Consumes: `createAuditLogAsync` (`services/auditService.ts`), `actor_type` enum value `'ai_agent'` (already in `packages/shared/src/constants/index.ts:60`), `initiatedBy: 'ai'`.
- Produces: an `audit_logs` row per agent-authored note, including on the idempotent-retry path.

- [ ] **Step 1: Write the failing tests**

```ts
describe('addAiTriageNote audit trail (#4209)', () => {
  it('writes an ai_agent-actor audit row naming the run', async () => {
    const audits = captureAudits();
    await addAiTriageNote(TICKET_ID, RUN_ID, 'note', ORG_ID, 'Helpdesk Agent');
    expect(audits[0]).toMatchObject({
      orgId: ORG_ID,
      actorType: 'ai_agent',
      actorId: RUN_ID,
      action: 'ticket.comment',
      resourceType: 'ticket',
      resourceId: TICKET_ID,
      initiatedBy: 'ai',
      result: 'success',
      details: expect.objectContaining({ agentRunId: RUN_ID, isInternal: true, isPublic: false }),
    });
  });

  it('does not double-audit when the idempotent retry returns the existing row', async () => {
    const audits = captureAudits();
    forceUniqueViolationThenExisting(COMMENT_ID);
    await addAiTriageNote(TICKET_ID, RUN_ID, 'note', ORG_ID);
    expect(audits).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd apps/api && npx vitest run src/services/ticketService.aiExecutors.test.ts -t "audit trail"`
Expected: FAIL — zero audit rows captured.

- [ ] **Step 3: Implement**

In `addAiTriageNote`, after `writeTicketOutbox(...)` and before `return { comment }`:

```ts
    // #4209: an autonomous write must leave an audit trail. `audit_logs.actor_id`
    // is uuid NOT NULL with NO FK, so the RUN id is legal there — and it is the
    // right identifier: it is the thing an operator can open, whose policy
    // snapshot froze the gate that authorised this note. The agent's own id
    // rides along in `details` for fan-in across runs. Deliberately NOT the
    // all-zero sentinel other services use for a system actor: that would erase
    // the only link back to the authorising run.
    await createAuditLogAsync({
      orgId: ticket.orgId,
      actorType: 'ai_agent',
      actorId: runId,
      action: 'ticket.comment',
      resourceType: 'ticket',
      resourceId: ticketId,
      details: { commentId: comment.id, agentRunId: runId, isInternal: true, isPublic: false },
      result: 'success',
      initiatedBy: 'ai'
    });
```

Leave the `isUniqueViolation` catch branch untouched — it returns the pre-existing row and must not audit a second time.

- [ ] **Step 4: Verify green**

Run: `cd apps/api && npx vitest run src/services/ticketService.aiExecutors.test.ts src/services/ticketService.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.aiExecutors.test.ts
git commit -m "feat(tickets): audit every agent-authored ticket note (#4209)"
```

---

### Task 12: Migration — DB-level "an agent note is never public"

**Files:**
- Create: `apps/api/migrations/2026-10-16-181300-ticket-comment-agent-note-private-chk.sql`
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing), `apps/api/src/db/migrationRlsScope.test.ts` (existing — must stay green)

**Interfaces:**
- Produces: CHECK constraint `ticket_comments_agent_note_private_chk`.

- [ ] **Step 1: Write the migration**

```sql
-- #4209 (W03): an ai_agent-authored ticket comment can never be customer-facing.
--
-- addAiTriageNote() already hardcodes is_public=false and manage_tickets' comment
-- branch ignores a caller-supplied isPublic for an ai_agent principal, but both
-- are application-layer. The requirement is "isPublic FORCED false", and the only
-- place a force survives a future writer is the database.
--
-- Scoped to origin_principal_kind='ai_agent' ONLY: 'system' rows (org-move feed
-- entries etc.) and 'user' rows are untouched, and 'unknown' stays unconstrained
-- so the fail-closed default value cannot brick an insert path.
--
-- NOT VALID is deliberately NOT used: there is no legal pre-existing violating
-- row (every ai_agent row was written by addAiTriageNote, which has hardcoded
-- false since it shipped), so a validating add is correct and gives us the
-- backfill check for free. If it fails on a real database, that failure IS the
-- finding — do not downgrade the constraint, investigate the rows.
--
-- No DML in this file.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ticket_comments_agent_note_private_chk'
  ) THEN
    ALTER TABLE ticket_comments
      ADD CONSTRAINT ticket_comments_agent_note_private_chk
      CHECK (origin_principal_kind <> 'ai_agent' OR is_public = false);
  END IF;
END $$;
```

- [ ] **Step 2: Run the migration tests**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: PASS. `migrationRlsScope` must stay green **without** adding this file to its baseline — if it reds, the file grew DML that does not belong here.

- [ ] **Step 3: Commit**

```bash
git add apps/api/migrations/2026-10-16-181300-ticket-comment-agent-note-private-chk.sql
git commit -m "feat(db): CHECK that an ai_agent ticket comment is never public (#4209)"
```

---

### Task 13: Deny the three `manage_tickets` actions that would forge a users FK

**Files:**
- Modify: `apps/api/src/services/aiToolsTicketing.ts` (the `assign`, `update_status` and `create` branches)
- Test: `apps/api/src/services/aiToolsTicketing.aiExecutors.test.ts`

**Interfaces:**
- Consumes: `agentRunIdFrom(auth)` (existing, `aiToolsTicketing.ts:65`).
- Produces: a typed refusal `{ success: false, error: 'agent_principal_unsupported_action', action }` for those three actions when the caller is an `ai_agent` principal.

**Why deny rather than support:** `assign` writes `tickets.assigned_to` (a `users` FK), `update_status` and `create` write `created_by`/actor columns and emit `actorUserId`. An agent has no `users` row, so each of the three needs its own attribution design (a nullable actor, or an agent-authored system feed entry) — that is a separate product decision, not a bug fix. Failing loudly and specifically is the correct interim contract, and it is what stops the autonomous lane from producing a 23503 in production.

- [ ] **Step 1: Write the failing tests**

```ts
describe.each(['assign', 'update_status', 'create'] as const)(
  'manage_tickets %s refuses an ai_agent principal (#4209)',
  (action) => {
    it('returns a typed refusal and writes nothing', async () => {
      const res = await executeManageTickets({ action, ticketId: TICKET_ID }, agentAuth());
      expect(res).toMatchObject({ success: false, error: 'agent_principal_unsupported_action', action });
      expect(dbInsertSpy).not.toHaveBeenCalled();
      expect(dbUpdateSpy).not.toHaveBeenCalled();
    });

    it('still works for a user_session principal', async () => {
      const res = await executeManageTickets({ action, ticketId: TICKET_ID }, userAuth());
      expect(res.success).not.toBe(false);
    });
  },
);
```

- [ ] **Step 2: Run and watch fail**

Run: `cd apps/api && npx vitest run src/services/aiToolsTicketing.aiExecutors.test.ts -t "agent_principal_unsupported_action"`
Expected: FAIL — the calls succeed (or throw a raw 23503 from the mock).

- [ ] **Step 3: Implement**

At the top of each of the three action branches in `aiToolsTicketing.ts`:

```ts
      // #4209: these three write a users FK (tickets.assigned_to / created_by)
      // and emit actorUserId. An ai_agent principal's auth.user.id is an
      // aiAgents.id — attribution only, never a users row (agentAuthContext.ts)
      // — so `actorFrom(auth)` here would forge a foreign key. The comment /
      // update_fields / draft branches each got a real agent-principal design
      // (addAiTriageNote, applyAiFieldUpdates, ticket_drafts); these three did
      // not, so they refuse rather than guess. Supporting them means designing
      // agent attribution for assignment and status, tracked separately.
      if (agentRunIdFrom(auth)) {
        return { success: false, error: 'agent_principal_unsupported_action', action };
      }
```

- [ ] **Step 4: Verify green**

Run: `cd apps/api && npx vitest run src/services/aiToolsTicketing.aiExecutors.test.ts src/services/aiToolsTicketing.test.ts src/services/aiToolsTicketing.writeGaps.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/aiToolsTicketing.ts apps/api/src/services/aiToolsTicketing.aiExecutors.test.ts
git commit -m "fix(ai-tools): refuse manage_tickets assign/update_status/create for an agent principal (#4209)"
```

---

### Task 14: Lock the lane's invariants as a contract test, then W03 PR

**Files:**
- Create: `apps/api/src/services/aiAgents/ticketAutonomousNote.contract.test.ts`
- Modify: `apps/api/src/__tests__/integration/aiAgentTicketTriage.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 11-13 plus the shipped `evaluateTicketAutonomy`.

**Why a contract test:** the four properties below are the whole of #4209's requirement, three of them were already true before this wave, and none of them was pinned. Contract tests have caught this class 5/5 in this repo; code review has caught it 0/5.

- [ ] **Step 1: Write the contract test**

```ts
/**
 * #4209 — the autonomous private-note lane's four load-bearing invariants.
 * Every one of these is a security property, not a preference. If a change
 * makes one of these fail, the change is wrong.
 */
describe('autonomous private-note lane contract (#4209)', () => {
  it('addAiTriageNote never writes a users FK', () => {
    const src = readFileSync(resolve(__dirname, '../ticketService.ts'), 'utf8');
    const fn = extractFunction(src, 'addAiTriageNote');
    expect(fn).toMatch(/userId:\s*null/);
    expect(fn).toMatch(/portalUserId:\s*null/);
    expect(fn).not.toMatch(/userId:\s*actor/);
  });

  it('addAiTriageNote hardcodes isPublic false and takes no isPublic parameter', () => {
    const fn = extractFunction(readFileSync(resolve(__dirname, '../ticketService.ts'), 'utf8'), 'addAiTriageNote');
    expect(fn).toMatch(/isPublic:\s*false/);
    expect(fn).not.toMatch(/isPublic:\s*\w+\.isPublic/);
  });

  it('the migration carries the database-level private CHECK', () => {
    const sql = readFileSync(resolve(__dirname, '../../../migrations/2026-10-16-181300-ticket-comment-agent-note-private-chk.sql'), 'utf8');
    expect(sql).toContain('ticket_comments_agent_note_private_chk');
    expect(sql).toMatch(/origin_principal_kind\s*<>\s*'ai_agent'\s*OR\s*is_public\s*=\s*false/);
  });

  it('evaluateTicketAutonomy still denies on every one of its documented reasons', async () => {
    for (const [args, reason] of DENIAL_CASES) {
      await expect(evaluateTicketAutonomy(args)).resolves.toEqual({ granted: false, reason });
    }
  });
});
```

`DENIAL_CASES` must cover all eight `TicketAutonomyDenialReason` values: `not_requested`, `not_agent_run`, `scope_not_ticket`, `run_not_ticket_triggered`, `run_snapshot_not_authorized`, `live_policy_not_authorized`, `kill_switch_engaged`, `gate_evaluation_failed`.

- [ ] **Step 2: Run and watch it fail, then pass**

Run: `cd apps/api && npx vitest run src/services/aiAgents/ticketAutonomousNote.contract.test.ts`
Expected: FAIL first (the migration assertion, before Task 12 lands), PASS after.

- [ ] **Step 3: Add the integration case**

In `aiAgentTicketTriage.integration.test.ts`:

```ts
it('a forged public ai_agent comment is rejected by the database (#4209)', async () => {
  await expect(sysDb.insert(ticketComments).values({
    ticketId, userId: null, content: 'x', isPublic: true,
    originPrincipalKind: 'ai_agent', agentRunId: runId, commentType: 'internal',
  })).rejects.toThrow(/ticket_comments_agent_note_private_chk/);
});

it('an autonomous note leaves exactly one ai_agent audit row naming the run (#4209)', async () => { /* … */ });
```

- [ ] **Step 4: Run the live-DB suites**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiAgentTicketTriage.integration.test.ts src/__tests__/integration/ticket-comments-rls.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
cd ../.. && pnpm test-stack down
```

Expected: PASS.

- [ ] **Step 5: Commit and open the PR**

```bash
git add apps/api/src/services/aiAgents/ticketAutonomousNote.contract.test.ts apps/api/src/__tests__/integration/aiAgentTicketTriage.integration.test.ts
git commit -m "test(ai-agents): pin the autonomous private-note lane's invariants (#4209)"
git push -u origin feature/<parent>-ai-helpdesk-followon/wave-4209
gh pr create --base main --title "feat(ai-agents): harden the autonomous ticket private-note lane" --body "Closes #4209 …"
```

The PR body must state plainly that the lane itself shipped in P2-4 (#4191) and this wave closes an audit gap, a DB-enforcement gap and a latent users-FK forge — reviewers reading #4209's title will otherwise expect a much bigger diff.

---

# Wave W04 — Tier-2 time-entry proposal from AI-assisted ticket work (#4177)

**Wave goal:** when a technician sends an AI-drafted reply or resolves a ticket with an AI resolution note, mint a **Tier-2, human-reviewed, never-auto-executing** `manage_tickets:log_time_entry` action intent pre-filled with a duration and the billable flag from the category/org defaults.

**Design decisions for this wave (settled; the rationale is here so it is not re-derived):**
1. **No new action name.** `log_time_entry` already exists on `manage_tickets`, is already in `TIER2_ACTIONS` (`aiGuardrails.ts:51`), already maps to `{ resource: 'time_entries', action: 'write' }` for RBAC, and already has a handler that calls `createTimeEntry`. Reusing it means no `tierConfig.ts` change and no `aiGuardrailsTierConfig.parity.test.ts` churn. A new action name would buy nothing and cost two contract tests.
2. **Propose-only comes free from two existing rules**, not from new code: a Tier-2 tool call may only become an `action_intents` row when the principal is `ai_agent` (`agentTier2`, `intentService.ts:1114-1117`), such a row is always `approvalScope: 'supervised'`, and `resolvePolicyDecisionState()` returns `'human_required'` for both `tier < 3` **and** `hasScope`. We pass an explicit `scope: { ticketId }`, so it is human-required twice over. **Add no bypass and no auto-release.**
3. **The time entry is owned by the approving technician, never the agent.** `time_entries.user_id` is a `users` FK NOT NULL. On release the executor must build the actor from `action_intents.decided_by_user_id`. This is the single riskiest line in the wave and gets its own task.
4. **Duration needs a source.** Verified: neither `ticket_categories` nor `org_ticket_settings` has any duration default — they supply `default_billable` and `default_hourly_rate` only, resolved by `getTicketTimeEntryDefaults(ticketId)`. W04 adds `ticket_categories.default_time_entry_minutes` (nullable) with a module constant fallback.
5. **`source = 'ai_suggested'`.** The existing CHECK `time_entries_source_chk` admits `manual|timer|location|remote_session|support_session`; a proposal-born entry must be distinguishable in `invoiceAssembly.ts` reporting and in #4182's measured-time-saved rollup.

---

### Task 15: Migration — `ai_suggested` source + category duration default

**Files:**
- Create: `apps/api/migrations/2026-10-16-181400-time-entry-ai-suggested-source.sql`
- Modify: `apps/api/src/db/schema/tickets.ts` (`ticketCategories`)
- Modify: `packages/shared/src/validators/timeEntries.ts` (`timeEntrySourceSchema`)
- Test: `apps/api/src/db/autoMigrate.test.ts`, `packages/shared/src/validators/timeEntries.test.ts`

**Interfaces:**
- Produces: CHECK `time_entries_source_chk` widened with `'ai_suggested'`; column `ticket_categories.default_time_entry_minutes integer NULL`; `TimeEntrySource` gains `'ai_suggested'`.

**Registration check (do this, do not assume):** `grep -n "ticket_categories" apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts` — at planning time this returns **nothing** for the first two (the table is partner-keyed, no `org_id`), so a new column on it needs no export-policy entry. `time_entries` **is** in all three, but this migration adds no column to it, only widens a CHECK, so `CORE_TENANT_EXPORT_POLICY` is unchanged. Re-run the grep before you commit; if either answer has changed, register the table before opening the PR.

- [ ] **Step 1: Write the failing validator test**

In `packages/shared/src/validators/timeEntries.test.ts`:

```ts
it('accepts ai_suggested as a source (#4177)', () => {
  expect(timeEntrySourceSchema.parse('ai_suggested')).toBe('ai_suggested');
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd packages/shared && npx vitest run src/validators/timeEntries.test.ts`
Expected: FAIL — invalid enum value.

- [ ] **Step 3: Write the migration**

```sql
-- #4177 (W04): AI-proposed time entries.
--
-- Elect system scope before the CHECK re-add: time_entries is FORCE ROW LEVEL
-- SECURITY and the validating ADD CONSTRAINT scans existing rows, which under
-- 'none' scope would see nothing and validate vacuously.
SELECT set_config('breeze.scope', 'system', true);

-- 1. Widen the source vocabulary. Drop-then-add because a CHECK cannot be
--    altered in place; both halves are guarded so re-application is a no-op.
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_source_chk;
ALTER TABLE time_entries
  ADD CONSTRAINT time_entries_source_chk
  CHECK (source IN ('manual', 'timer', 'location', 'remote_session', 'support_session', 'ai_suggested'));

-- 2. The duration default an AI proposal pre-fills from. Nullable on purpose:
--    a partner who has not set one gets the module constant fallback
--    (AI_TIME_ENTRY_DEFAULT_MINUTES) rather than a guessed number baked into
--    every category row. ticket_categories is partner-keyed (no org_id), so
--    this column triggers no export-policy or org-cascade registration —
--    verified by grep against tenantCascade.ts / tenantExportPolicyRegistry.ts.
ALTER TABLE ticket_categories
  ADD COLUMN IF NOT EXISTS default_time_entry_minutes integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ticket_categories_default_time_entry_minutes_chk'
  ) THEN
    ALTER TABLE ticket_categories
      ADD CONSTRAINT ticket_categories_default_time_entry_minutes_chk
      CHECK (default_time_entry_minutes IS NULL OR (default_time_entry_minutes > 0 AND default_time_entry_minutes <= 1440));
  END IF;
END $$;
```

- [ ] **Step 4: Update the schema and the validator**

`apps/api/src/db/schema/tickets.ts`, inside `ticketCategories` after `defaultHourlyRate`:

```ts
  // #4177: minutes an AI time-entry proposal pre-fills for this category.
  // Nullable — no default means "use AI_TIME_ENTRY_DEFAULT_MINUTES". CHECK
  // (0 < n <= 1440) is SQL-only.
  defaultTimeEntryMinutes: integer('default_time_entry_minutes'),
```

`packages/shared/src/validators/timeEntries.ts`: add `'ai_suggested'` to `timeEntrySourceSchema`'s enum, with a comment that it is server-stamped only and never accepted from a public create payload (same rule as the existing values).

- [ ] **Step 5: Verify green**

Run:
```bash
cd packages/shared && npx vitest run src/validators/timeEntries.test.ts
cd ../../apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
Expected: PASS. `migrationRlsScope` must stay green because the file's first statement elects system scope.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit && pnpm --filter @breeze/shared exec tsc --noEmit
git add apps/api/migrations/2026-10-16-181400-time-entry-ai-suggested-source.sql apps/api/src/db/schema/tickets.ts packages/shared/src/validators/timeEntries.ts packages/shared/src/validators/timeEntries.test.ts
git commit -m "feat(db): ai_suggested time-entry source and per-category duration default (#4177)"
```

---

### Task 16: Compute the proposal's duration and billable defaults

**Files:**
- Create: `apps/api/src/services/aiTimeEntryProposal.ts`
- Create: `apps/api/src/services/aiTimeEntryProposal.test.ts`

**Interfaces:**
- Consumes: `getTicketTimeEntryDefaults(ticketId, …)` (`services/timeEntryService.ts:285`, returns `{ hourlyRate, currencyCode, isBillable }` resolving `orgTicketSettings.defaultBillable ?? ticketCategories.defaultBillable ?? false`); `ticketCategories.defaultTimeEntryMinutes` (Task 15).
- Produces:
  ```ts
  export const AI_TIME_ENTRY_DEFAULT_MINUTES = 15;
  export interface AiTimeEntryProposalDefaults { durationMinutes: number; isBillable: boolean; }
  export async function resolveAiTimeEntryDefaults(ticketId: string): Promise<AiTimeEntryProposalDefaults>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe('resolveAiTimeEntryDefaults (#4177)', () => {
  it('uses the category duration default when set', async () => {
    mockCategory({ defaultTimeEntryMinutes: 30 });
    mockTicketDefaults({ isBillable: true });
    expect(await resolveAiTimeEntryDefaults(TICKET_ID)).toEqual({ durationMinutes: 30, isBillable: true });
  });

  it('falls back to AI_TIME_ENTRY_DEFAULT_MINUTES when the category has none', async () => {
    mockCategory({ defaultTimeEntryMinutes: null });
    mockTicketDefaults({ isBillable: false });
    expect(await resolveAiTimeEntryDefaults(TICKET_ID)).toEqual({ durationMinutes: 15, isBillable: false });
  });

  it('takes the billable flag from getTicketTimeEntryDefaults, never from the category directly', async () => {
    mockCategory({ defaultBillable: true, defaultTimeEntryMinutes: null });
    mockTicketDefaults({ isBillable: false });   // org override wins
    expect((await resolveAiTimeEntryDefaults(TICKET_ID)).isBillable).toBe(false);
  });

  it('falls back to non-billable and the constant when the ticket has no category', async () => {
    mockCategory(null);
    mockTicketDefaults({ isBillable: false });
    expect(await resolveAiTimeEntryDefaults(TICKET_ID)).toEqual({ durationMinutes: 15, isBillable: false });
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd apps/api && npx vitest run src/services/aiTimeEntryProposal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * #4177 (W04) — the defaults an AI time-entry PROPOSAL is pre-filled with.
 *
 * Billable and rate come from `getTicketTimeEntryDefaults`, the single
 * existing resolver (`org_ticket_settings.default_billable ??
 * ticket_categories.default_billable ?? false`) — never read the category
 * directly here, or an org-level override silently stops applying to AI
 * proposals while it still applies to manual entries.
 *
 * Duration has no existing resolver because nothing in the schema had a
 * duration default before this wave: `ticket_categories.default_time_entry_minutes`
 * (Task 15) is it, and an unset category falls back to the constant below
 * rather than to zero — a zero-minute proposal is worse than a wrong one,
 * because a technician will approve it without reading it.
 */
export const AI_TIME_ENTRY_DEFAULT_MINUTES = 15;
```

Read the ticket's `categoryId` → `ticket_categories.defaultTimeEntryMinutes`, call `getTicketTimeEntryDefaults`, and combine.

- [ ] **Step 4: Verify green**

Run: `cd apps/api && npx vitest run src/services/aiTimeEntryProposal.test.ts src/services/timeEntryService.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/aiTimeEntryProposal.ts apps/api/src/services/aiTimeEntryProposal.test.ts
git commit -m "feat(tickets): resolve AI time-entry proposal defaults (#4177)"
```

---

### Task 17: Mint the Tier-2 intent from the two human-act sites

**Files:**
- Modify: `apps/api/src/services/aiTimeEntryProposal.ts` (add `proposeTimeEntryForAiAssistedWork`)
- Modify: `apps/api/src/services/ticketService.ts` (`sendTicketDraft`; and the resolve path that consumes `aiDraftId`)
- Test: `apps/api/src/services/aiTimeEntryProposal.test.ts`, `apps/api/src/services/ticketService.test.ts`

**Interfaces:**
- Consumes: `createActionIntent` (`services/actionIntents/intentService.ts`), `resolveAiTimeEntryDefaults` (Task 16), `ticketDrafts.runId` (the run that authored the consumed draft).
- Produces:
  ```ts
  export async function proposeTimeEntryForAiAssistedWork(args: {
    ticketId: string; orgId: string; agentRunId: string;
    trigger: 'draft_sent' | 'resolved_with_ai_note'; technicianUserId: string;
  }): Promise<{ intentId: string } | null>;
  ```

**Hard constraints for this task:**
- The intent is created with `source: 'ai_agent'`, `scope: { ticketId }`, `actionName: 'manage_tickets'`, `arguments: { action: 'log_time_entry', ticketId, durationMinutes, isBillable, description }`, `idempotencyKey: \`ai-time-entry:${agentRunId}:${trigger}\``, and `requestingAgentRunId: agentRunId`.
- **Never pass `autonomy`.** `evaluateTicketAutonomy` exists for the triage write lane; a billing-adjacent proposal is not in its scope and must land in the human-review inbox.
- A failure here must **never** fail the technician's send/resolve. Wrap the whole call and log-and-continue — the draft was sent; a missing time-entry proposal is an annoyance, a rolled-back send is a data-loss incident.

- [ ] **Step 1: Write the failing tests**

```ts
describe('proposeTimeEntryForAiAssistedWork (#4177)', () => {
  it('creates a Tier-2 supervised, ticket-scoped, human-required intent', async () => {
    const created = captureCreateActionIntent();
    await proposeTimeEntryForAiAssistedWork({ ticketId: TICKET_ID, orgId: ORG_ID, agentRunId: RUN_ID, trigger: 'draft_sent', technicianUserId: USER_ID });
    expect(created[0]).toMatchObject({
      actionName: 'manage_tickets',
      source: 'ai_agent',
      scope: { ticketId: TICKET_ID },
      requestingAgentRunId: RUN_ID,
      idempotencyKey: `ai-time-entry:${RUN_ID}:draft_sent`,
      arguments: expect.objectContaining({ action: 'log_time_entry', durationMinutes: 15, isBillable: false }),
    });
    expect(created[0]).not.toHaveProperty('autonomy');
  });

  it('is idempotent per (run, trigger)', async () => {
    const created = captureCreateActionIntent();
    const args = { ticketId: TICKET_ID, orgId: ORG_ID, agentRunId: RUN_ID, trigger: 'draft_sent' as const, technicianUserId: USER_ID };
    await proposeTimeEntryForAiAssistedWork(args);
    await proposeTimeEntryForAiAssistedWork(args);
    expect(new Set(created.map((c) => c.idempotencyKey)).size).toBe(1);
  });

  it('returns null and does not throw when intent creation fails', async () => {
    failCreateActionIntent(new Error('boom'));
    await expect(proposeTimeEntryForAiAssistedWork({ /* … */ })).resolves.toBeNull();
  });
});

describe('sendTicketDraft mints a time-entry proposal (#4177)', () => {
  it('proposes once, keyed to the draft run', async () => {
    const spy = spyOnPropose();
    await sendTicketDraft(TICKET_ID, DRAFT_ID, undefined, { userId: USER_ID });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ agentRunId: DRAFT_RUN_ID, trigger: 'draft_sent' }));
  });

  it('still sends the draft when the proposal throws', async () => {
    spyOnProposeThrows();
    await expect(sendTicketDraft(TICKET_ID, DRAFT_ID, undefined, { userId: USER_ID })).resolves.toMatchObject({ comment: expect.anything() });
  });

  it('does not propose for a draft with no run', async () => {
    const spy = spyOnPropose();
    mockDraft({ runId: null });
    await sendTicketDraft(TICKET_ID, DRAFT_ID, undefined, { userId: USER_ID });
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd apps/api && npx vitest run src/services/aiTimeEntryProposal.test.ts src/services/ticketService.test.ts -t "4177"`
Expected: FAIL — function missing, no call from `sendTicketDraft`.

- [ ] **Step 3: Implement**

Add `proposeTimeEntryForAiAssistedWork` to `aiTimeEntryProposal.ts`. Then, in `sendTicketDraft`, **after** the transaction that inserts the comment and consumes the draft has fully committed (never inside it — `createActionIntent` opens its own system-scoped transaction and nesting it inside the send would hold a pooled connection across the intent's own fan-out, the #1105 pattern):

```ts
  // #4177: sending an AI-drafted reply is billable work the technician just
  // did. Propose a time entry as a Tier-2, human-reviewed intent — never a
  // write. Deliberately outside the send transaction and deliberately
  // swallowing every error: the reply is already public; a failed proposal
  // must not roll it back or surface as a send failure.
  if (draft.runId) {
    try {
      await proposeTimeEntryForAiAssistedWork({
        ticketId, orgId: ticket.orgId, agentRunId: draft.runId,
        trigger: 'draft_sent', technicianUserId: actor.userId,
      });
    } catch (err) {
      console.error('[tickets] AI time-entry proposal failed after draft send (non-fatal):', err);
    }
  }
```

Add the mirror call on the resolve path that consumes an `aiDraftId`, with `trigger: 'resolved_with_ai_note'`.

- [ ] **Step 4: Verify green**

Run: `cd apps/api && npx vitest run src/services/aiTimeEntryProposal.test.ts src/services/ticketService.test.ts src/routes/tickets/aiDrafts.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/aiTimeEntryProposal.ts apps/api/src/services/aiTimeEntryProposal.test.ts apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.test.ts
git commit -m "feat(tickets): propose a Tier-2 time entry when AI-assisted work is sent or resolved (#4177)"
```

---

### Task 18: On release, the time entry belongs to the approver

**Files:**
- Modify: `apps/api/src/jobs/intentReleaseWorker.ts` (the auth rebuild in `releaseApprovedIntent`)
- Modify: `apps/api/src/services/aiToolsTicketing.ts` (the `log_time_entry` branch)
- Test: `apps/api/src/jobs/intentReleaseWorker.test.ts`, `apps/api/src/services/aiToolsTicketing.aiExecutors.test.ts`

**Interfaces:**
- Consumes: `action_intents.decided_by_user_id`, `time_entries.user_id` (a `users` FK, NOT NULL).
- Produces: `log_time_entry` executed from a released intent creates the entry with `userId = intent.decidedByUserId` and `source = 'ai_suggested'`.

**This is the wave's highest-risk task.** Without it, releasing the intent runs `createTimeEntry` under the rebuilt agent auth, whose `user.id` is an `aiAgents.id` — a 23503 on `time_entries_user_id_fkey`, at approval time, in front of the technician.

- [ ] **Step 1: Write the failing tests**

```ts
it('releases a log_time_entry intent as the approving technician (#4177)', async () => {
  const created = captureCreateTimeEntry();
  await releaseApprovedIntent(intentFixture({
    actionName: 'manage_tickets',
    arguments: { action: 'log_time_entry', ticketId: TICKET_ID, durationMinutes: 15, isBillable: false },
    originPrincipalKind: 'ai_agent',
    decidedByUserId: APPROVER_ID,
  }));
  expect(created[0]).toMatchObject({ actor: expect.objectContaining({ userId: APPROVER_ID }), source: 'ai_suggested' });
});

it('refuses to release a log_time_entry intent with no decided_by_user_id (#4177)', async () => {
  await expect(releaseApprovedIntent(intentFixture({
    actionName: 'manage_tickets',
    arguments: { action: 'log_time_entry', ticketId: TICKET_ID },
    originPrincipalKind: 'ai_agent',
    decidedByUserId: null,
  }))).rejects.toThrow(/decided_by_user_id/);
});

it('an agent principal calling log_time_entry directly (not via release) is refused (#4177)', async () => {
  const res = await executeManageTickets({ action: 'log_time_entry', ticketId: TICKET_ID }, agentAuth());
  expect(res).toMatchObject({ success: false, error: 'agent_principal_requires_intent_release' });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd apps/api && npx vitest run src/jobs/intentReleaseWorker.test.ts src/services/aiToolsTicketing.aiExecutors.test.ts -t "4177"`
Expected: FAIL — the actor is the agent, and there is no refusal branch.

- [ ] **Step 3: Implement**

In `releaseApprovedIntent`, before `executeTool(...)`, for an intent whose `originPrincipalKind === 'ai_agent'` and whose resolved action writes a `users` FK (start with the explicit allowlist `['log_time_entry']` on `manage_tickets`; do not generalise speculatively):

```ts
  // #4177: a time entry is OWNED by a real technician (time_entries.user_id is
  // a users FK, NOT NULL). An agent-originated intent's rebuilt auth carries
  // auth.user.id = aiAgents.id — attribution only, never a users row — so
  // releasing under it is a guaranteed 23503. The approver IS the owner: they
  // read the proposal and accepted the work as theirs. Fail loudly rather than
  // substituting a sentinel; a time entry with no real owner is an invoice
  // line no one can defend.
  if (USER_OWNED_RELEASE_ACTIONS.has(`${intent.actionName}:${action}`)) {
    if (!intent.decidedByUserId) {
      throw new Error(`intent ${intent.id}: ${action} requires decided_by_user_id to own the created row`);
    }
    releaseAuth = rebuildAuthForUser(intent.decidedByUserId, intent.orgId);
  }
```

In `aiToolsTicketing.ts`'s `log_time_entry` branch, add the agent-principal refusal (mirrors Task 13's shape, distinct error code because the correct route exists):

```ts
      // #4177: an agent may PROPOSE a time entry (an action_intents row) but
      // never create one inline — the row needs a real users owner, which only
      // the release path (with decided_by_user_id) can supply.
      if (agentRunIdFrom(auth)) {
        return { success: false, error: 'agent_principal_requires_intent_release', action };
      }
```

and pass `source: 'ai_suggested'` through `TimeEntryProvenance` when the call originates from a released intent.

- [ ] **Step 4: Verify green**

Run: `cd apps/api && npx vitest run src/jobs/intentReleaseWorker.test.ts src/jobs/intentReleaseWorker.durable.contract.test.ts src/services/aiToolsTicketing.aiExecutors.test.ts src/services/actionIntents/intentService.tier2Agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/jobs/intentReleaseWorker.ts apps/api/src/jobs/intentReleaseWorker.test.ts apps/api/src/services/aiToolsTicketing.ts apps/api/src/services/aiToolsTicketing.aiExecutors.test.ts
git commit -m "fix(intents): a released time-entry intent is owned by the approving technician (#4177)"
```

---

### Task 19: W04 integration proof + PR

**Files:**
- Create: `apps/api/src/__tests__/integration/aiTimeEntryProposal.integration.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
it('sending an AI draft mints exactly one supervised, human-required, ticket-scoped intent (#4177)', async () => {
  await sendTicketDraft(ticketId, draftId, undefined, { userId: techId, name: 'Tech' });
  const [intent] = await sysDb.select().from(actionIntents).where(eq(actionIntents.scopeTicketId, ticketId));
  expect(intent.actionName).toBe('manage_tickets');
  expect(intent.approvalScope).toBe('supervised');
  expect(intent.policyDecisionState).toBe('human_required');
  expect(intent.status).toBe('pending');
  expect(intent.requestingAgentRunId).toBe(runId);
});

it('the proposal never auto-executes — no time entry exists before approval (#4177)', async () => {
  const rows = await sysDb.select().from(timeEntries).where(eq(timeEntries.ticketId, ticketId));
  expect(rows).toHaveLength(0);
});

it('releasing it creates one ai_suggested entry owned by the approver (#4177)', async () => {
  await approveAndRelease(intentId, approverId);
  const [entry] = await sysDb.select().from(timeEntries).where(eq(timeEntries.ticketId, ticketId));
  expect(entry).toMatchObject({ userId: approverId, source: 'ai_suggested', durationMinutes: 15 });
  expect(entry.partnerId).toBe(partnerId);
  expect(entry.orgId).toBe(orgId);
});

it('a forged source value is rejected by the widened CHECK (#4177)', async () => {
  await expect(sysDb.insert(timeEntries).values({ /* … */ source: 'bogus' }))
    .rejects.toThrow(/time_entries_source_chk/);
});
```

- [ ] **Step 2: Run the live-DB suites**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiTimeEntryProposal.integration.test.ts src/__tests__/integration/timeEntriesTicketOrgFkCleanup.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
cd ../.. && pnpm test-stack down
```

Expected: PASS. The export-policy and cascade suites must be green **without registry edits** — this wave adds no `org_id` column anywhere. If either reds, re-read the "Registration check" note in Task 15 and register the table before proceeding.

- [ ] **Step 3: Commit and open the PR**

```bash
git add apps/api/src/__tests__/integration/aiTimeEntryProposal.integration.test.ts
git commit -m "test(tickets): live-DB proof for the AI time-entry proposal lane (#4177)"
git push -u origin feature/<parent>-ai-helpdesk-followon/wave-4177
gh pr create --base main --title "feat(tickets): Tier-2 time-entry proposal from AI-assisted ticket work" --body "Closes #4177 …"
```

---

## Cross-wave verification before any PR merges

- [ ] `pnpm --filter @breeze/api exec tsc --noEmit && pnpm --filter @breeze/web exec tsc --noEmit && pnpm --filter @breeze/shared exec tsc --noEmit`
- [ ] `pnpm lint`
- [ ] `cd apps/api && npx vitest run src/services/aiAgents src/services/actionIntents src/services/ticketService src/services/aiToolsTicketing src/routes/tickets` — check the reported file count; vitest's filter is a plain substring, so `src/services/ticketService` also pulls `ticketService.aiExecutors.test.ts`, which is intended here.
- [ ] `cd apps/web && npx vitest run src/components/tickets src/components/aiAgents src/lib/i18n`
- [ ] `pnpm test-stack up`, then the full integration config, then `pnpm test-stack down`. Tear it down — nothing does it for you, and each session leaves its own behind.
- [ ] `ls apps/api/migrations | sort | tail -1` against **`origin/main`** must sort before every migration this plan adds. The pre-push hook re-checks against `origin/main`, so a name that was fine at commit time can fail at push time; rename if it does.
- [ ] Each wave PR targets `main` directly. Do **not** stack them — `ci.yml` triggers on `pull_request: branches: [main]`, so a PR based on a sibling branch runs no CI at all and `gh pr checks` reads green.
- [ ] Merge with `gh pr merge <N>` (merge queue owns the strategy). Never `--admin`.

## Self-review notes for the executor

- **Type consistency across waves:** `proposedByRunId` (Drizzle) ↔ `proposed_by_run_id` (SQL) is used in Tasks 1, 2, 3, 6. `getLatestTicketProposal` returns `{ runId, finishedAt, proposal }` in Tasks 3, 4, 5. `resolveAiTimeEntryDefaults` returns `{ durationMinutes, isBillable }` in Tasks 16, 17, 19. `proposeTimeEntryForAiAssistedWork` takes `{ ticketId, orgId, agentRunId, trigger, technicianUserId }` in Tasks 17 and 19. `admitTriageRun`'s fourth parameter changes shape in Task 8 and every call site in Tasks 7-9 must use the new shape.
- **Wave independence:** W01 does not depend on W02's guard rewrite (that is why it uses a separate column). W02 depends on nothing in W01. W03 depends on nothing in W01/W02. W04 depends on nothing earlier. Ship them in any order; the numbering is priority, not a dependency chain.
- **If any "already shipped" claim in the Global Constraints turns out to be false on the branch you are working from**, stop and re-read the file rather than implementing around it — those claims were verified against `origin/main` at `e000e329f` on 2026-09-13 and are what makes these waves small.
