---
tracking_issue: TBD (register after Gate B)
wave_issue: TBD (W01 sub-issue)
branch: feature/<parent>-ai-scorecard/wave-<sub-issue>
---

# AI Scorecard W01 — Attribution at the source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Read the hub first:** [`2026-09-13-ai-scorecard.md`](./2026-09-13-ai-scorecard.md). Its *Global Constraints* section is part of every task below.

**Goal:** Every device mutation an AI dispatches through the Breeze command queue records *who decided* — `ai_assistant` or `ai_agent`, plus the session or agent-run it came from — on the row itself and in an audit event the device page can read, and no future AI tool can reach the device without supplying that attribution.

**Architecture:** A new Postgres enum `ai_initiator_kind` and three nullable columns land on `script_executions`, `device_commands` and `action_intents`. The origin is carried in-process on `AuthContext.aiOrigin` (minted once per AI surface — agent run, chat session, MCP ledger session), conducted to the five insert chokepoints by an explicit `aiOrigin` field on each one's options bag, and enforced by `services/aiDispatch.ts`, an adapter whose four exported functions take `aiOrigin` as a **required positional parameter**, plus two source-scan contract tests that (a) forbid `db.insert`/`tx.insert` into `device_commands`/`script_executions` outside the chokepoint files and (b) forbid any file under `services/aiTools*.ts` or `services/aiAgents/**` from importing the raw dispatch functions. Two pre-existing defects are fixed on the way. Two rogue inserts are converted. The origin is persisted on `action_intents` so it survives `intentReleaseWorker`'s from-scratch auth rebuild, and detached on device move and org merge so a moved execution never points at another tenant's session or run.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL 16 (enum, partial indexes, `CREATE OR REPLACE FUNCTION`), Vitest (unit + integration against real Postgres).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-13-ai-scorecard-attribution-and-impact-design.md` §3.1, §3.2, §3.3, §4.1, §4.2, OD-1 A + adapter, OD-2 A, OD-3 B, OD-10 A.

**Tracking:** feature TBD, wave TBD. Branch `feature/<parent>-ai-scorecard/wave-<sub-issue>` off `main`. One PR, body `Closes #<wave sub-issue>` and `Refs #5022`.

## Global Constraints

Everything in the hub's *Global Constraints* section applies. W01-specific additions:

- Migration filename **`apps/api/migrations/2026-10-16-181700-ai-origin-attribution.sql`**. Re-verify at PR time that `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -1` sorts before it.
- The migration contains **no DML** — do not add `set_config('breeze.scope', …)`, and do not add the file to the frozen baseline in `apps/api/src/db/migrationRlsScope.test.ts`.
- **`ai_initiator_kind` is a two-value closed enum: `('ai_assistant', 'ai_agent')`.** Nothing else. NULL means *AI initiation not recorded*, never *a human did this*. No backfill. No `NOT NULL`. No `DEFAULT`.
- **`CREATE TYPE` gets its own guarded statement** in this file (`DO $$ BEGIN CREATE TYPE … ; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`). It is a fresh type, not an `ALTER TYPE … ADD VALUE`, so no separate committed file is needed — the columns in the same file may reference it.
- FK shapes are settled and must not be "improved": `script_executions.ai_session_id → ai_sessions(id) ON DELETE SET NULL` is the **only** new FK. `script_executions.ai_agent_run_id`, both `device_commands` columns and all three `action_intents` columns are **bare uuids with no FK** — a deliberate retention choice so an erased session or run cannot block or mutate a system-scoped command row or an immutable intent row. The deferrable-composite-FK rule does **not** apply (a single-column FK to a PK is not `(x, org_id) → parent(id, org_id)`).
- **Never derive an audit row's `actor_type` from authorship.** `actor_type`/`actor_id` come from the authenticated principal and are always mutually consistent. Authorship goes in `details`.
- Audit emission stays **fire-and-forget** (`createAuditLogAsync`, `void`). A lost audit row must never fail a dispatch that already succeeded. Do not "harden" this into an awaited write.
- `audit_logs` gets **no new column**. It is append-only (`migrations/2026-05-25-a-audit-log-append-only.sql` REVOKEs UPDATE/DELETE and installs an unconditional `RAISE EXCEPTION` on row UPDATE), so `ON DELETE SET NULL` is physically impossible there. The ids ride in the existing `details` jsonb.
- Every task ends with: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`, the task's targeted vitest run, and a commit.

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-16-181700-ai-origin-attribution.sql` (create) | enum, 9 columns across 3 tables, 3 partial indexes, `breeze_cascade_device_org_id()` detach |
| `packages/shared/src/types/aiOrigin.ts` (create) | `AiInitiatorKind`, `AiOriginRef`, `AI_INITIATOR_KINDS`, `isAiInitiatorKind` |
| `apps/api/src/db/schema/scripts.ts` (modify, `scriptExecutions` at `:211`) | 3 columns + `aiInitiatorKindEnum` |
| `apps/api/src/db/schema/devices.ts` (modify, `deviceCommands` at `:559-586`) | 3 columns |
| `apps/api/src/db/schema/actionIntents.ts` (modify) | 3 columns |
| `apps/api/src/middleware/auth.ts` (modify, `AuthContext` at `:74-174`) | `aiOrigin?: AiOriginRef` |
| `apps/api/src/services/aiAgents/agentAuthContext.ts` (modify, `:71-112`) | mint `{kind:'ai_agent', …}` |
| `apps/api/src/services/streamingSessionManager.ts` (modify, `:834`, `:787-790`, `:849-869`) | mint `{kind:'ai_assistant', sessionId}` on create **and** refresh |
| `apps/api/src/services/mcpToolExecutionLedger.ts` (modify, `:60-129`) | return the origin alongside the ledger handle |
| `apps/api/src/routes/mcpServer.ts` (modify) | apply the ledger origin to the tool `AuthContext` |
| `apps/api/src/services/commandQueue.ts` (modify, `:102-128`, `:441-475`, `:480-535`, `:561-609`, `:782-826`, `:1111-1223`) | `aiOrigin` conduit + stamping + `ai.command.executed` + agent-actor fix |
| `apps/api/src/services/scriptDispatch.ts` (modify, `:93-139`, `:514-555`, `:644`, `:783-804`) | `aiOrigin` conduit + stamping + audit actor fix |
| `apps/api/src/services/dispatchDeviceCommand.ts` (modify, `:18-37`, `:126-130`) | `aiOrigin` pass-through |
| `apps/api/src/services/aiDispatch.ts` (create) | mandatory-origin adapter — the only door AI code may use |
| `apps/api/src/services/aiDispatch.contract.test.ts` (create) | source scan: no raw inserts outside chokepoints; no raw dispatch imports in AI files |
| `apps/api/src/services/aiToolsScripts.ts` (modify, `:274-286`, `:507-514`, `:647`) | route through the adapter |
| `apps/api/src/services/aiToolsBrowser.ts` (modify, `:472`) | rogue insert → adapter |
| `apps/api/src/services/peripheralPolicyState.ts` (modify, `:262`) | rogue `tx.insert` → `insertQueuedCommandInTransaction` with origin |
| `apps/api/src/services/actionIntents/actorContext.ts` (modify, `:295`, `:513-515`) | reconstruct `aiOrigin` from the intent row |
| `apps/api/src/services/actionIntents/intentService.ts` (modify) | persist `aiOrigin` at intent creation |
| `apps/api/src/routes/devices/moveOrg.ts` (modify, beside `:475`) | route-local detach mirror |
| `apps/api/src/services/orgMergeRegistry.ts` (modify, `:822`) | `script_executions` `repoint` → `custom` |
| `apps/api/src/services/orgMergeCustomExecutors.ts` (modify) | `repointScriptExecutionsDetachingAiOrigin` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` (modify, `:44`, `:487`) | 6 new `included` strings |
| `apps/api/src/__tests__/integration/aiOriginAttribution.integration.test.ts` (create) | the Kit-case reproduction, move/merge/erasure proofs |

---

### Task 1: Migration — enum, nine columns, three partial indexes, device-move detach

**Files:**
- Create: `apps/api/migrations/2026-10-16-181700-ai-origin-attribution.sql`
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing, auto-discovers), `apps/api/src/db/migrationRlsScope.test.ts` (existing; must stay green *without* a baseline entry)

**Interfaces:**
- Produces: pg enum `ai_initiator_kind`; columns `script_executions.{ai_initiator_kind, ai_session_id, ai_agent_run_id}`, `device_commands.{ai_initiator_kind, ai_session_id, ai_agent_run_id}`, `action_intents.{ai_origin_kind, ai_origin_session_id, ai_origin_agent_run_id}`; indexes `script_executions_ai_device_created_idx`, `script_executions_ai_org_created_idx`, `device_commands_ai_device_created_idx`; replaced function body `public.breeze_cascade_device_org_id()`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/db/autoMigrate.test.ts` (in the existing ordering/discovery describe block):

```ts
it('the ai-origin attribution migration sorts after every migration on main', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort((a, b) => a.localeCompare(b));
  const idx = files.indexOf('2026-10-16-181700-ai-origin-attribution.sql');
  expect(idx, 'migration file missing').toBeGreaterThan(-1);
  expect(idx, 'migration must sort last among committed files at authoring time').toBe(files.length - 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts`
Expected: FAIL — "migration file missing", received `-1`.

- [ ] **Step 3: Write the migration**

```sql
-- 2026-10-16-181700-ai-origin-attribution.sql
-- AI Scorecard W01 (#5022): record WHO DECIDED a device mutation.
--
-- ai_initiator_kind is orthogonal to script_executions.trigger_type: trigger_type
-- answers "what scheduled this run", this answers "who decided". An AI can kick
-- off a policy-driven run and a human can hand-run an AI-authored script, so
-- collapsing them would destroy information.
--
-- NULL means "AI initiation not recorded", NEVER "a human did this": every
-- AI-run library script that already exists stamps trigger_type='manual' plus
-- the invoker's user id, so all history is NULL. No backfill, no NOT NULL, no
-- DEFAULT. Consumers MUST render NULL as absence of a marker.
--
-- No DML in this file, so no set_config('breeze.scope','system',true) and no
-- entry in migrationRlsScope.test.ts's frozen baseline.

DO $$
BEGIN
  CREATE TYPE public.ai_initiator_kind AS ENUM ('ai_assistant', 'ai_agent');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- --------------------------------------------------------------------------
-- script_executions: org-cascade tenant table. The session FK is real (both
-- tables are org-scoped and erasure should null it cleanly); the run id stays
-- a bare uuid, following script_executions.automation_run_id and
-- script_proposals.agent_run_id -- ai_agent_runs is deliberately excluded from
-- the device-move re-stamp path, so a real FK would outlive its own tenant.
-- --------------------------------------------------------------------------
ALTER TABLE public.script_executions
  ADD COLUMN IF NOT EXISTS ai_initiator_kind public.ai_initiator_kind,
  ADD COLUMN IF NOT EXISTS ai_session_id uuid,
  ADD COLUMN IF NOT EXISTS ai_agent_run_id uuid;

DO $$
BEGIN
  ALTER TABLE public.script_executions
    ADD CONSTRAINT script_executions_ai_session_id_fk
    FOREIGN KEY (ai_session_id) REFERENCES public.ai_sessions(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- --------------------------------------------------------------------------
-- device_commands: system-scoped by design (no org_id column -- the RLS and
-- cascade auto-discovery both key on the LITERAL name 'org_id', verified
-- against rls-coverage.integration.test.ts:1259-1272 and
-- tenantCascade.integration.test.ts:57-71, so *_id columns are invisible to
-- them and that property is untouched). Both ids are bare uuids: an AI session
-- or run that is erased, merged away or left behind by a device move must not
-- be able to block or mutate a command row. (This is a RETENTION choice, not a
-- "no tenant FKs here" rule -- submitted_org_id is a real organizations FK.)
-- --------------------------------------------------------------------------
ALTER TABLE public.device_commands
  ADD COLUMN IF NOT EXISTS ai_initiator_kind public.ai_initiator_kind,
  ADD COLUMN IF NOT EXISTS ai_session_id uuid,
  ADD COLUMN IF NOT EXISTS ai_agent_run_id uuid;

-- --------------------------------------------------------------------------
-- action_intents: the origin has to survive a durable approval boundary.
-- intentReleaseWorker rebuilds the AuthContext from scratch for a human-owned
-- intent, so a chat-minted origin would be lost. Prefixed ai_origin_* to avoid
-- colliding with the existing origin_principal_kind/origin_principal_id pair,
-- which describes the REQUESTER, not the AI surface. Bare uuids: the row is
-- immutable evidence and must never be blocked by a deleted session.
-- --------------------------------------------------------------------------
ALTER TABLE public.action_intents
  ADD COLUMN IF NOT EXISTS ai_origin_kind public.ai_initiator_kind,
  ADD COLUMN IF NOT EXISTS ai_origin_session_id uuid,
  ADD COLUMN IF NOT EXISTS ai_origin_agent_run_id uuid;

-- --------------------------------------------------------------------------
-- Partial indexes for the two read paths that need them (device Scripts tab /
-- Activities feed, and the org-wide AI action count). Partial on
-- ai_initiator_kind IS NOT NULL keeps them tiny: AI rows are a small minority.
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS script_executions_ai_device_created_idx
  ON public.script_executions (device_id, created_at DESC)
  WHERE ai_initiator_kind IS NOT NULL;

CREATE INDEX IF NOT EXISTS script_executions_ai_org_created_idx
  ON public.script_executions (org_id, created_at DESC)
  WHERE ai_initiator_kind IS NOT NULL;

CREATE INDEX IF NOT EXISTS device_commands_ai_device_created_idx
  ON public.device_commands (device_id, created_at DESC)
  WHERE ai_initiator_kind IS NOT NULL;

-- --------------------------------------------------------------------------
-- Detach-on-device-move, trigger half.
--
-- script_executions is in CORE_DEVICE_ORG_DENORMALIZED_TABLES, so its org_id
-- follows the device to the target org. ai_agent_runs is deliberately NOT
-- re-stamped (run history stays with the source org, owner decision
-- 2026-08-23), and ai_sessions is only re-stamped when it is device-bound --
-- a device-less chat session stays behind. Either way a moved execution can
-- end up pointing at a session or run in a DIFFERENT tenant.
--
-- Sever both pointers and RETAIN ai_initiator_kind: the fact that an AI did
-- the work survives the move; the cross-tenant pointer does not.
--
-- Mirrored in routes/devices/moveOrg.ts for legibility at the call site; this
-- copy is the one that also covers a DIRECT devices.org_id UPDATE that
-- bypasses the route (a fix-up script, a future service path). Both copies are
-- convergent -- the second to run matches nothing. Same construction as the
-- ai_operator_tasks detach added by 2026-10-14-100000-ai-operator-thin-slice.sql
-- (section 8). The trigger itself (AFTER UPDATE OF org_id ON devices) is
-- unchanged and is NOT redeclared here.
-- --------------------------------------------------------------------------
-- REPLACEMENT BODY: copy the CURRENT body of public.breeze_cascade_device_org_id()
-- verbatim from the newest migration that defines it
-- (2026-10-14-100000-ai-operator-thin-slice.sql section 8 at authoring time --
-- re-check with:
--   grep -rln 'CREATE OR REPLACE FUNCTION public.breeze_cascade_device_org_id' apps/api/migrations | sort | tail -1
-- ), and add ONLY the statement below immediately after the existing
-- ai_operator_tasks detach:
--
--   UPDATE public.script_executions
--      SET ai_session_id = NULL, ai_agent_run_id = NULL
--    WHERE device_id = NEW.id
--      AND (ai_session_id IS NOT NULL OR ai_agent_run_id IS NOT NULL);
--
-- (device_commands needs no statement here: it is not device-org-denormalized
-- and its rows are system-scoped, so nothing about them changes tenant.)
```

> **Executor note:** step 3 deliberately does not inline a stale copy of `breeze_cascade_device_org_id()`. Fetch the current body first, paste it whole into this file, then insert the one `UPDATE` above. A partial re-declaration would silently drop every other cascade statement the function performs.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
Expected: PASS, and `migrationRlsScope.test.ts` green **without** a new baseline entry (the file has no DML). Check the reported test count is non-zero.

- [ ] **Step 5: Apply against a live database and eyeball it**

```bash
pnpm test-stack up
export DATABASE_URL="postgresql://breeze:breeze@localhost:5433/breeze"   # port per .env.test
pnpm db:migrate
psql "$DATABASE_URL" -c "\d+ script_executions" | grep ai_
psql "$DATABASE_URL" -c "SELECT indexname FROM pg_indexes WHERE indexname LIKE '%_ai_%';"
pnpm db:migrate   # second run must be a clean no-op
```
Expected: three `ai_*` columns on each of the three tables, three partial indexes, and the second `db:migrate` reports the file already applied.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-10-16-181700-ai-origin-attribution.sql apps/api/src/db/autoMigrate.test.ts
git commit -m "feat(ai): ai_initiator_kind enum and AI origin columns on script_executions, device_commands, action_intents"
```

---

### Task 2: Drizzle schema columns + export-policy classifications

**Files:**
- Modify: `apps/api/src/db/schema/scripts.ts` (`scriptExecutions`, table starts `:211`; `triggerTypeEnum` at `:23` — leave it alone)
- Modify: `apps/api/src/db/schema/devices.ts` (`deviceCommands`, `:559-586`)
- Modify: `apps/api/src/db/schema/actionIntents.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`"action_intents"` at `:44`, `"script_executions"` at `:487`)
- Test: `apps/api/src/services/tenantExportPolicy.test.ts` (existing unit), `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts` (existing integration)

**Interfaces:**
- Consumes: the enum and columns from Task 1.
- Produces: `aiInitiatorKindEnum` (exported from `db/schema/scripts.ts`); `scriptExecutions.aiInitiatorKind | aiSessionId | aiAgentRunId`; `deviceCommands.aiInitiatorKind | aiSessionId | aiAgentRunId`; `actionIntents.aiOriginKind | aiOriginSessionId | aiOriginAgentRunId`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/tenantExportPolicy.test.ts`:

```ts
import { CORE_TENANT_EXPORT_POLICY } from './tenantExportPolicyRegistry';

describe('AI origin columns are classified (#5022 W01)', () => {
  it('classifies the three script_executions AI columns as included', () => {
    const cols = CORE_TENANT_EXPORT_POLICY['script_executions']!.columns;
    for (const name of ['ai_initiator_kind', 'ai_session_id', 'ai_agent_run_id']) {
      expect(cols[name], `script_executions.${name} unclassified`).toBeDefined();
      expect(cols[name]!.decision).toBe('include');
    }
  });

  it('classifies the three action_intents AI origin columns as included', () => {
    const cols = CORE_TENANT_EXPORT_POLICY['action_intents']!.columns;
    for (const name of ['ai_origin_kind', 'ai_origin_session_id', 'ai_origin_agent_run_id']) {
      expect(cols[name], `action_intents.${name} unclassified`).toBeDefined();
      expect(cols[name]!.decision).toBe('include');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/tenantExportPolicy.test.ts`
Expected: FAIL — `script_executions.ai_initiator_kind unclassified`, received `undefined`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/db/schema/scripts.ts` — beside the existing enums near `:23`:

```ts
// #5022 W01. Deliberately NOT folded into triggerTypeEnum: trigger_type says
// what SCHEDULED a run, this says WHO DECIDED. NULL = "AI initiation not
// recorded", never "a human did this".
export const aiInitiatorKindEnum = pgEnum('ai_initiator_kind', ['ai_assistant', 'ai_agent']);
```

Inside `scriptExecutions`, after `reviewSummary`:

```ts
  aiInitiatorKind: aiInitiatorKindEnum('ai_initiator_kind'),
  aiSessionId: uuid('ai_session_id').references(() => aiSessions.id, { onDelete: 'set null' }),
  aiAgentRunId: uuid('ai_agent_run_id'),
```

Inside `deviceCommands` (`db/schema/devices.ts`), after `submittedOrgId`:

```ts
  // Bare uuids, no FK: a system-scoped command row must never be blockable or
  // mutable by the lifecycle of an ai_sessions / ai_agent_runs row. Neither
  // name is `org_id`, so the RLS and cascade auto-discovery still treat this
  // table as system-scoped (verified: both key on the literal column name).
  aiInitiatorKind: aiInitiatorKindEnum('ai_initiator_kind'),
  aiSessionId: uuid('ai_session_id'),
  aiAgentRunId: uuid('ai_agent_run_id'),
```

Inside `actionIntents` (`db/schema/actionIntents.ts`), after `originPrincipalId`:

```ts
  // The serializable AiOriginRef, so a chat-minted origin survives
  // intentReleaseWorker's from-scratch AuthContext rebuild. Distinct from
  // originPrincipal*, which describes the REQUESTER, not the AI surface.
  aiOriginKind: aiInitiatorKindEnum('ai_origin_kind'),
  aiOriginSessionId: uuid('ai_origin_session_id'),
  aiOriginAgentRunId: uuid('ai_origin_agent_run_id'),
```

`apps/api/src/services/tenantExportPolicyRegistry.ts` — append the three strings to the `included` array of the `"script_executions"` entry (`:487`) and the three to `"action_intents"` (`:44`). All six are typed scalars (one enum, two uuids each); none matches `SUSPICIOUS_NAME_PARTS`; none is `json`/`jsonb`/`bytea`. They are `included`, **not** `reviewedIncluded`, **not** `excludedOpen`. Add above the `script_executions` entry:

```ts
  // ai_initiator_kind / ai_session_id / ai_agent_run_id (#5022 W01): who
  // DECIDED to run this script, and the conversation or agent run it came
  // from. Plain scalars -- an enum label and two identifiers, no free text and
  // no credential material -- so ordinary `included` customer data. This
  // classification is precisely why the attribution is typed columns and not
  // an `ai_origin jsonb` blob: jsonb is excludedOpen by policy and would be
  // STRIPPED from the tenant GDPR export, i.e. from the one artifact in which
  // a customer asks "who did this to my machine".
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/tenantExportPolicy.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
pnpm db:check-drift
```
Expected: PASS; `db:check-drift` reports no drift (schema matches the migration).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/tenantExportPolicy.test.ts
git commit -m "feat(ai): Drizzle columns and export-policy classifications for AI origin attribution"
```

---

### Task 3: `AiOriginRef` shared type and `AuthContext.aiOrigin`

**Files:**
- Create: `packages/shared/src/types/aiOrigin.ts`
- Modify: `packages/shared/src/types/index.ts` (re-export)
- Create: `packages/shared/src/types/aiOrigin.test.ts`
- Modify: `apps/api/src/middleware/auth.ts` (`AuthContext`, `:74-174`)

**Interfaces:**
- Produces:
  ```ts
  export const AI_INITIATOR_KINDS = ['ai_assistant', 'ai_agent'] as const;
  export type AiInitiatorKind = (typeof AI_INITIATOR_KINDS)[number];
  export interface AiOriginRef {
    kind: AiInitiatorKind;
    sessionId?: string;    // ai_sessions.id
    agentRunId?: string;   // ai_agent_runs.id
  }
  export function isAiInitiatorKind(v: unknown): v is AiInitiatorKind;
  export function serializeAiOrigin(o: AiOriginRef | undefined): {
    aiOriginKind: AiInitiatorKind | null;
    aiOriginSessionId: string | null;
    aiOriginAgentRunId: string | null;
  };
  export function deserializeAiOrigin(row: {
    aiOriginKind: string | null; aiOriginSessionId: string | null; aiOriginAgentRunId: string | null;
  }): AiOriginRef | undefined;
  ```
  `AuthContext` gains `aiOrigin?: AiOriginRef`.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/types/aiOrigin.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { AI_INITIATOR_KINDS, isAiInitiatorKind, serializeAiOrigin, deserializeAiOrigin } from './aiOrigin';

describe('AiOriginRef', () => {
  it('is a closed two-value vocabulary', () => {
    expect([...AI_INITIATOR_KINDS]).toEqual(['ai_assistant', 'ai_agent']);
    expect(isAiInitiatorKind('ai_agent')).toBe(true);
    expect(isAiInitiatorKind('automation')).toBe(false);
    expect(isAiInitiatorKind(null)).toBe(false);
  });

  it('round-trips through the persisted column shape', () => {
    const origin = { kind: 'ai_agent' as const, sessionId: 's1', agentRunId: 'r1' };
    expect(deserializeAiOrigin(serializeAiOrigin(origin))).toEqual(origin);
  });

  it('serializes an absent origin to three nulls, never to a human default', () => {
    expect(serializeAiOrigin(undefined)).toEqual({
      aiOriginKind: null, aiOriginSessionId: null, aiOriginAgentRunId: null,
    });
  });

  it('deserializes an all-null row to undefined, not to a fabricated kind', () => {
    expect(deserializeAiOrigin({ aiOriginKind: null, aiOriginSessionId: null, aiOriginAgentRunId: null }))
      .toBeUndefined();
  });

  it('refuses to reconstruct an origin from ids alone when the kind is missing', () => {
    // A row with ids but no kind is a threading bug, not an assistant run.
    expect(deserializeAiOrigin({ aiOriginKind: null, aiOriginSessionId: 's1', aiOriginAgentRunId: null }))
      .toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/types/aiOrigin.test.ts`
Expected: FAIL — "Failed to resolve import ./aiOrigin".

- [ ] **Step 3: Write the implementation**

`packages/shared/src/types/aiOrigin.ts`:

```ts
/**
 * Who DECIDED a device mutation (#5022 W01).
 *
 * `ai_assistant` — a human asked, in chat or over MCP; the human stays
 *   accountable and `triggered_by` / `created_by` are unchanged.
 * `ai_agent`     — an autonomous agent run decided; no human was in the loop.
 *
 * Absent (undefined here, NULL in the database) means "AI initiation not
 * recorded" — NEVER "a human did this". Consumers must render absence as the
 * absence of a marker.
 */
export const AI_INITIATOR_KINDS = ['ai_assistant', 'ai_agent'] as const;
export type AiInitiatorKind = (typeof AI_INITIATOR_KINDS)[number];

export interface AiOriginRef {
  kind: AiInitiatorKind;
  /** ai_sessions.id — the persisted session, not an MCP transport session id. */
  sessionId?: string;
  /** ai_agent_runs.id */
  agentRunId?: string;
}

export function isAiInitiatorKind(value: unknown): value is AiInitiatorKind {
  return typeof value === 'string' && (AI_INITIATOR_KINDS as readonly string[]).includes(value);
}

export function serializeAiOrigin(origin: AiOriginRef | undefined): {
  aiOriginKind: AiInitiatorKind | null;
  aiOriginSessionId: string | null;
  aiOriginAgentRunId: string | null;
} {
  return {
    aiOriginKind: origin?.kind ?? null,
    aiOriginSessionId: origin?.sessionId ?? null,
    aiOriginAgentRunId: origin?.agentRunId ?? null,
  };
}

export function deserializeAiOrigin(row: {
  aiOriginKind: string | null;
  aiOriginSessionId: string | null;
  aiOriginAgentRunId: string | null;
}): AiOriginRef | undefined {
  // The kind is the discriminator. Ids without a kind are a threading bug and
  // must not be laundered into a plausible-looking origin.
  if (!isAiInitiatorKind(row.aiOriginKind)) return undefined;
  return {
    kind: row.aiOriginKind,
    ...(row.aiOriginSessionId ? { sessionId: row.aiOriginSessionId } : {}),
    ...(row.aiOriginAgentRunId ? { agentRunId: row.aiOriginAgentRunId } : {}),
  };
}
```

Re-export from `packages/shared/src/types/index.ts`.

`apps/api/src/middleware/auth.ts`, inside the `AuthContext` interface (`:74-174`), after `principal`:

```ts
  /**
   * Set when this request originated from an AI surface (#5022 W01). Minted
   * ONCE per surface -- autonomous agent run, chat session, MCP ledger session
   * -- never per tool.
   *
   * This is the in-process CARRIER and the only route into the act/verify
   * bypass lanes (`executeCommandWithSystemPrecheck`), which never enter
   * `executeTool`. It is NOT the conduit: no insert chokepoint receives an
   * AuthContext, so the origin is passed explicitly through each dispatch
   * options bag as well. Use `services/aiDispatch.ts` -- do not hand-thread it.
   */
  aiOrigin?: AiOriginRef;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/shared && npx vitest run src/types/aiOrigin.test.ts && npx tsc --noEmit
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types apps/api/src/middleware/auth.ts
git commit -m "feat(ai): AiOriginRef shared type and AuthContext.aiOrigin carrier"
```

---

### Task 4: Mint the origin at all three AI surfaces

**Files:**
- Modify: `apps/api/src/services/aiAgents/agentAuthContext.ts` (`buildAgentAuthContext`, `:71-112`; `principal` at `:78`)
- Modify: `apps/api/src/services/streamingSessionManager.ts` (create path `:834`/`:849-869`; refresh path `:787-790`)
- Modify: `apps/api/src/services/mcpToolExecutionLedger.ts` (`beginMcpToolExecutionLedger`, `:60-129`; `sessionId` minted `:72`)
- Modify: `apps/api/src/routes/mcpServer.ts` (apply the returned origin to the tool `AuthContext`)
- Create: `apps/api/src/services/aiOriginMint.contract.test.ts`

**Interfaces:**
- Consumes: `AiOriginRef` (Task 3).
- Produces: every AI-surface `AuthContext` carries `aiOrigin`. `McpToolExecutionLedgerHandle` gains `aiOrigin: AiOriginRef`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/aiOriginMint.contract.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildAgentAuthContext } from './aiAgents/agentAuthContext';

describe('AI surfaces mint aiOrigin (#5022 W01)', () => {
  it('the autonomous agent context carries kind ai_agent plus the run id', () => {
    const auth = buildAgentAuthContext(
      { id: 'agent-1', orgId: 'org-1', partnerId: 'p-1', name: 'Triage', kind: 'triage' },
      { id: 'run-1', orgId: 'org-1', deviceId: 'dev-1' },
      { id: 'org-1', partnerId: 'p-1' },
    );
    expect(auth.aiOrigin).toEqual({ kind: 'ai_agent', agentRunId: 'run-1' });
    expect(auth.principal).toMatchObject({ kind: 'ai_agent', agentId: 'agent-1', runId: 'run-1' });
  });

  it('carries the run session id when the run has one', () => {
    const auth = buildAgentAuthContext(
      { id: 'agent-1', orgId: 'org-1', partnerId: 'p-1', name: 'Triage', kind: 'triage' },
      { id: 'run-1', orgId: 'org-1', deviceId: null, sessionId: 'sess-1' },
      { id: 'org-1', partnerId: 'p-1' },
    );
    expect(auth.aiOrigin).toEqual({ kind: 'ai_agent', agentRunId: 'run-1', sessionId: 'sess-1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiOriginMint.contract.test.ts`
Expected: FAIL — `expected undefined to deeply equal { kind: 'ai_agent', … }`.

- [ ] **Step 3: Write the implementation**

**(a) Agent surface** — `agentAuthContext.ts`. Widen `AgentRunRef` with `sessionId?: string | null` and, in the returned literal beside `principal` (`:78`):

```ts
    aiOrigin: {
      kind: 'ai_agent' as const,
      agentRunId: run.id,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    },
```

**(b) Chat surface** — `streamingSessionManager.ts`. `breezeSessionId` **is** the persisted `ai_sessions.id`. Mint once and apply to **both** `auth` and `toolAuth`, at the create site (around `:834`, before the `const session: ActiveSession = {` literal at `:849`) **and** at the refresh site (`:787-790`) — the spec is explicit that stamping only at creation loses the origin on every refreshed execution context:

```ts
const chatOrigin = { kind: 'ai_assistant' as const, sessionId: breezeSessionId };
const authWithOrigin = { ...auth, aiOrigin: chatOrigin };
const toolAuth = deviceId
  ? buildDeviceBoundSessionAuth(authWithOrigin, dbSession.orgId)
  : authWithOrigin;
```

At `:787-790` (refresh), replace with the same three lines using `reusable.breezeSessionId`, assigning `reusable.auth = authWithOrigin`. **Verify `buildDeviceBoundSessionAuth` preserves unknown fields** — if it constructs a fresh literal rather than spreading, add `aiOrigin: base.aiOrigin` to it in this task; a fresh-literal builder is exactly the "lane that rebuilds a fresh AuthContext mid-flight" the spec warns about.

**(c) MCP surface** — `mcpToolExecutionLedger.ts`. The MCP *transport* session id is **not** the persisted `ai_sessions.id`; the ledger mints the latter at `:72`. Return it as an origin so the caller cannot get this wrong:

```ts
export interface McpToolExecutionLedgerHandle {
  executionId: string;
  sessionId: string;
  orgId: string;
  /** #5022 W01: stamp the tool AuthContext with THIS, never with transportSessionId. */
  aiOrigin: AiOriginRef;
}
// …in the return:
return { executionId, sessionId, orgId, aiOrigin: { kind: 'ai_assistant', sessionId } };
```

In `routes/mcpServer.ts`, at the point the tool `AuthContext` is built for the ledgered execution, spread `aiOrigin: handle.aiOrigin` onto it.

**(d)** Add a mint-site table test to `aiOriginMint.contract.test.ts` asserting each of the three producers is exercised, so a fourth AI surface added later without a mint fails here:

```ts
it('every AI surface listed in the spec has a mint site covered by this file', () => {
  const covered = new Set(['agent_run', 'chat_session', 'mcp_ledger']);
  // Update BOTH this set and a test above when a new AI surface is added.
  expect([...covered].sort()).toEqual(['agent_run', 'chat_session', 'mcp_ledger']);
});
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/aiOriginMint.contract.test.ts src/services/streamingSessionManager.test.ts src/services/mcpToolExecutionLedger.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS. If either of the two named existing test files does not exist, drop it from the command and note it — do not create a stub.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services apps/api/src/routes/mcpServer.ts
git commit -m "feat(ai): mint aiOrigin at the agent, chat and MCP surfaces"
```

---

### Task 5: The conduit — `aiOrigin` on every dispatch options bag, stamped at the five chokepoints

**Files:**
- Modify: `apps/api/src/services/commandQueue.ts` — `insertQueuedCommandInTransaction` (`:102-128`), `queueCommand` (`:480-535`), `ExecuteCommandOptions` (`:782-826`), `dispatchPreparedCommand` insert (`:1161-1182`)
- Modify: `apps/api/src/services/scriptDispatch.ts` — `DispatchScriptInput` (`:93-139`), `buildExecutionValues` → `db.insert(scriptExecutions)` (`:535-555`), the `queueCommand` call at `:644`
- Modify: `apps/api/src/services/dispatchDeviceCommand.ts` — `DispatchDeviceCommandInput` (`:18-37`), the `queueCommand` call (`:126-130`)
- Test: `apps/api/src/services/commandQueue.test.ts`, `apps/api/src/services/scriptDispatch.test.ts` (both exist)

**Interfaces:**
- Consumes: `AiOriginRef`.
- Produces: `aiOrigin?: AiOriginRef` on `insertQueuedCommandInTransaction`'s input, `queueCommand`'s options bag, `ExecuteCommandOptions`, `DispatchScriptInput`, `DispatchDeviceCommandInput`. Both `queueCommandForExecution` (`:708-719`) and `dispatchDeviceCommand` bottom out in `queueCommand`, so widening those three types covers all five chokepoints.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/commandQueue.test.ts`:

```ts
describe('aiOrigin conduit (#5022 W01)', () => {
  it('queueCommand stamps the three AI columns from options.aiOrigin', async () => {
    // (uses the file's existing Drizzle insert mock; capture the values object)
    const values = await captureQueueCommandInsert(() =>
      queueCommand('dev-1', 'script', {}, 'user-1', {
        aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' },
      }),
    );
    expect(values).toMatchObject({
      aiInitiatorKind: 'ai_assistant',
      aiSessionId: 'sess-1',
      aiAgentRunId: null,
    });
  });

  it('leaves all three NULL when no origin is supplied', async () => {
    const values = await captureQueueCommandInsert(() => queueCommand('dev-1', 'script', {}, 'user-1'));
    expect(values).toMatchObject({
      aiInitiatorKind: null, aiSessionId: null, aiAgentRunId: null,
    });
  });
});
```

> **Executor note:** reuse the file's existing Drizzle mock helper rather than writing a new one; if no `captureQueueCommandInsert` exists, add a thin local helper that reads the `values()` argument off the shared insert spy. Do **not** assert with a deep-search matcher that walks the whole mock — that pattern has produced vacuous passes in this repo.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/commandQueue.test.ts`
Expected: FAIL — `aiInitiatorKind: undefined` (the insert has no such key).

- [ ] **Step 3: Write the implementation**

In `commandQueue.ts`, add once near the top:

```ts
import type { AiOriginRef } from '@breeze/shared';

/** Column triple for an insert into device_commands / script_executions. */
function aiOriginColumns(origin: AiOriginRef | undefined) {
  return {
    aiInitiatorKind: origin?.kind ?? null,
    aiSessionId: origin?.sessionId ?? null,
    aiAgentRunId: origin?.agentRunId ?? null,
  };
}
```

- `insertQueuedCommandInTransaction` (`:102`): add `aiOrigin?: AiOriginRef` to the input type; spread `...aiOriginColumns(input.aiOrigin)` into the `values()` object at `:118-125`.
- `queueCommand` (`:480`): add `aiOrigin?: AiOriginRef` to the inline options type; spread `...aiOriginColumns(options.aiOrigin)` into the `values()` object at `:526-535`.
- `ExecuteCommandOptions` (`:782-826`): add `aiOrigin?: AiOriginRef`; in `dispatchPreparedCommand`'s insert (`:1161-1182`) spread `...aiOriginColumns(options.aiOrigin)`.
- `dispatchDeviceCommand.ts`: add `aiOrigin?: AiOriginRef` to `DispatchDeviceCommandInput` (`:18-37`) and forward it in the `queueCommand` options at `:126-130`.
- `queueCommandForExecution` (`:708-719`): add `aiOrigin?: AiOriginRef` to its options type and forward to `dispatchDeviceCommand`.
- `scriptDispatch.ts`: add `aiOrigin?: AiOriginRef` to `DispatchScriptInput` (`:93-139`); pass `...aiOriginColumns(input.aiOrigin)` through `buildExecutionValues` into the `scriptExecutions` insert (`:535-555`); and forward `aiOrigin: input.aiOrigin` in the `queueCommand` options at `:644` so **the script's own command row carries it too**.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/commandQueue.test.ts src/services/scriptDispatch.test.ts src/services/dispatchDeviceCommand.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS. Confirm the reported file count is 3 (or note which file does not exist).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/commandQueue.ts apps/api/src/services/scriptDispatch.ts apps/api/src/services/dispatchDeviceCommand.ts apps/api/src/services/commandQueue.test.ts
git commit -m "feat(ai): thread aiOrigin through the five device-dispatch chokepoints"
```

---

### Task 6: `services/aiDispatch.ts` — the mandatory-origin adapter

**Files:**
- Create: `apps/api/src/services/aiDispatch.ts`
- Create: `apps/api/src/services/aiDispatch.test.ts`

**Interfaces:**
- Consumes: `queueCommand`, `executeCommand`, `queueCommandForExecution`, `dispatchDeviceCommand`, `dispatchScriptToDevice`, `AiOriginRef`, `AuthContext`.
- Produces:
  ```ts
  export class MissingAiOriginError extends Error {}
  export function requireAiOrigin(auth: AuthContext, toolName: string): AiOriginRef;
  export function aiExecuteCommand(auth: AuthContext, toolName: string, deviceId: string, type: string, payload?: CommandPayload, options?: Omit<ExecuteCommandOptions, 'aiOrigin'>): Promise<CommandResult>;
  export function aiQueueCommandForExecution(auth: AuthContext, toolName: string, deviceId: string, type: string, payload?: CommandPayload, options?: …): Promise<…>;
  export function aiDispatchDeviceCommand(auth: AuthContext, toolName: string, input: Omit<DispatchDeviceCommandInput, 'aiOrigin'>): Promise<DispatchDeviceCommandResult>;
  export function aiDispatchScriptToDevice(auth: AuthContext, toolName: string, input: Omit<DispatchScriptInput, 'aiOrigin'>): Promise<DispatchScriptResult>;
  export function aiInsertQueuedCommandInTransaction(origin: AiOriginRef, tx: CommandQueueTx, input: Omit<Parameters<typeof insertQueuedCommandInTransaction>[1], 'aiOrigin'>): Promise<QueuedCommand>;
  ```
  `auth` is positional argument 1 and `toolName` positional argument 2 on every function — a caller cannot forget them, and a caller with no origin gets a thrown error naming the tool.

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/aiDispatch.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./commandQueue', () => ({
  executeCommand: vi.fn().mockResolvedValue({ ok: true }),
  queueCommand: vi.fn().mockResolvedValue({ id: 'cmd-1' }),
  queueCommandForExecution: vi.fn().mockResolvedValue({ ok: true }),
  insertQueuedCommandInTransaction: vi.fn().mockResolvedValue({ id: 'cmd-1' }),
}));

import { executeCommand } from './commandQueue';
import { aiExecuteCommand, requireAiOrigin, MissingAiOriginError } from './aiDispatch';

const withOrigin = { aiOrigin: { kind: 'ai_agent' as const, agentRunId: 'run-1' } } as never;
const withoutOrigin = {} as never;

beforeEach(() => vi.clearAllMocks());

describe('aiDispatch adapter (#5022 W01)', () => {
  it('forwards the auth context origin into the dispatch options', async () => {
    await aiExecuteCommand(withOrigin, 'execute_command', 'dev-1', 'run_shell', {});
    expect(executeCommand).toHaveBeenCalledWith('dev-1', 'run_shell', {},
      expect.objectContaining({ aiOrigin: { kind: 'ai_agent', agentRunId: 'run-1' } }));
  });

  it('throws, naming the tool, when the AuthContext carries no origin', async () => {
    await expect(aiExecuteCommand(withoutOrigin, 'execute_command', 'dev-1', 'run_shell', {}))
      .rejects.toBeInstanceOf(MissingAiOriginError);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('fails closed: it never silently dispatches an unattributed command', async () => {
    try { requireAiOrigin(withoutOrigin, 'manage_services'); } catch (e) {
      expect((e as Error).message).toContain('manage_services');
    }
    expect.assertions(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiDispatch.test.ts`
Expected: FAIL — "Failed to resolve import ./aiDispatch".

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/aiDispatch.ts
/**
 * The ONLY door AI code may use to reach a device (#5022 W01, spec OD-1).
 *
 * `AuthContext.aiOrigin` is the in-process carrier, but no insert chokepoint
 * receives an AuthContext -- `queueCommand` takes a userId plus an options bag,
 * `insertQueuedCommandInTransaction` takes a small input object,
 * `dispatchPreparedCommand` takes ExecuteCommandOptions -- and the AI handlers
 * already reduce auth to `auth.user.id` before calling them. So the origin has
 * to be passed explicitly. Every function here takes `auth` and `toolName` as
 * REQUIRED positional arguments and throws when the origin is absent, which
 * converts "remember to pass it" into a runtime failure plus (with
 * aiDispatch.contract.test.ts) a source scan -- the only control this repo has
 * a good record with. Code review has caught registration-shaped omissions
 * 0/5 times here; contract tests have caught them 5/5.
 */
import { executeCommand, queueCommandForExecution, insertQueuedCommandInTransaction } from './commandQueue';
import { dispatchDeviceCommand } from './dispatchDeviceCommand';
import { dispatchScriptToDevice } from './scriptDispatch';
import type { AiOriginRef } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';

export class MissingAiOriginError extends Error {
  constructor(toolName: string) {
    super(
      `[aiDispatch] tool "${toolName}" reached the device with no AuthContext.aiOrigin. `
      + 'Every AI surface must mint one (agentAuthContext / streamingSessionManager / '
      + 'mcpToolExecutionLedger). Dispatching unattributed device work is refused.',
    );
    this.name = 'MissingAiOriginError';
  }
}

export function requireAiOrigin(auth: Pick<AuthContext, 'aiOrigin'>, toolName: string): AiOriginRef {
  if (!auth.aiOrigin) throw new MissingAiOriginError(toolName);
  return auth.aiOrigin;
}

export async function aiExecuteCommand(
  auth: Pick<AuthContext, 'aiOrigin'>, toolName: string,
  deviceId: string, type: string, payload = {}, options: Record<string, unknown> = {},
) {
  const aiOrigin = requireAiOrigin(auth, toolName);
  return executeCommand(deviceId, type, payload, { ...options, aiOrigin });
}

// aiQueueCommandForExecution / aiDispatchDeviceCommand / aiDispatchScriptToDevice /
// aiInsertQueuedCommandInTransaction follow exactly the same two-line shape:
// resolve the origin (throwing when absent), then delegate with it merged in.
```

Write out all five wrappers explicitly — no `// …` in the shipped file.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/aiDispatch.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiDispatch.ts apps/api/src/services/aiDispatch.test.ts
git commit -m "feat(ai): mandatory-origin AI dispatch adapter"
```

---

### Task 7: Route every AI tool call site through the adapter, and convert the two rogue inserts

**Files:**
- Modify: `apps/api/src/services/aiToolsScripts.ts` (`:274-286` proposal branch, `:507-514` library branch, `:647` `execute_command`)
- Modify: `apps/api/src/services/aiToolsBrowser.ts` (`:472` — raw `db.insert(deviceCommands)`)
- Modify: `apps/api/src/services/peripheralPolicyState.ts` (`:262` — raw `tx.insert(deviceCommands)`)
- Modify: every other `services/aiTools*.ts` and `services/aiAgents/**` file that imports `executeCommand` / `queueCommand` / `queueCommandForExecution` / `dispatchDeviceCommand` / `dispatchScriptToDevice` (the sweep is 54 verified call sites — enumerate with the grep in step 1)
- Test: `apps/api/src/services/aiToolsScripts.test.ts` and the per-domain AI tool tests that already exist

**Interfaces:**
- Consumes: the adapter (Task 6).
- Produces: no `services/aiTools*.ts` or `services/aiAgents/**` file imports a raw dispatch function; `manage_browser_policy` and the peripheral reconciliation path go through the queue helpers.

- [ ] **Step 1: Write the failing test**

First enumerate the work:

```bash
cd apps/api && grep -rln "from '\./commandQueue'\|from '\.\./commandQueue'\|from '\./dispatchDeviceCommand'\|from '\.\./dispatchDeviceCommand'\|from '\./scriptDispatch'\|from '\.\./scriptDispatch'" src/services/aiTools*.ts src/services/aiAgents | sort
```

Then add to `apps/api/src/services/aiToolsScripts.test.ts`:

```ts
it('run_script (library branch) forwards the AI origin to the dispatcher', async () => {
  const auth = makeAuth({ aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' } });
  await runScriptTool.handler({ deviceId: 'dev-1', scriptId: 'scr-1' }, auth);
  expect(dispatchScriptToDeviceMock).toHaveBeenCalledWith(
    expect.objectContaining({ aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' } }),
  );
});

it('execute_command forwards the AI origin', async () => {
  const auth = makeAuth({ aiOrigin: { kind: 'ai_agent', agentRunId: 'run-9' } });
  await executeCommandTool.handler({ deviceId: 'dev-1', command: 'uptime' }, auth);
  expect(executeCommandMock).toHaveBeenCalledWith('dev-1', expect.any(String), expect.anything(),
    expect.objectContaining({ aiOrigin: { kind: 'ai_agent', agentRunId: 'run-9' } }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiToolsScripts.test.ts`
Expected: FAIL — the dispatcher was called without an `aiOrigin` key.

- [ ] **Step 3: Write the implementation**

- Replace each raw import with the adapter equivalent and pass `auth` plus the literal tool name: `dispatchScriptToDevice({…})` → `aiDispatchScriptToDevice(auth, 'run_script', {…})`; `executeCommand(a,b,c,d)` → `aiExecuteCommand(auth, '<tool>', a, b, c, d)`; likewise for `queueCommandForExecution` and `dispatchDeviceCommand`.
- **`aiToolsBrowser.ts:472`** currently does a raw multi-row `db.insert(deviceCommands).values(targetDevices.map(d => ({ deviceId: d.id, type: 'apply_browser_policy', payload, createdBy: auth.user.id })))`, bypassing `queueCommand`, `dispatchDeviceCommand` **and** `resolveCommandCreatedBy` (so it can also write a non-existent `created_by`). Replace the whole insert with a loop of `aiQueueCommandForExecution(auth, 'manage_browser_policy', device.id, 'apply_browser_policy', payload, { userId: auth.user.id })` — preserve the existing per-device result aggregation and the tool's return shape exactly.
- **`peripheralPolicyState.ts:262`** does `tx.insert(deviceCommands).values({ deviceId, type: 'peripheral_policy_sync_v2', payload: plan.envelope, status: 'pending', targetRole: 'agent' })` inside a caller transaction, with **no `createdBy` at all**. Replace with `insertQueuedCommandInTransaction(tx, { id, deviceId, type: 'peripheral_policy_sync_v2', payload: plan.envelope, createdBy: null, aiOrigin })`, threading an optional `aiOrigin?: AiOriginRef` parameter down from `jobs/peripheralJobs.ts:344`'s caller and from `aiToolsFleet.ts:1318`. If `insertQueuedCommandInTransaction` does not currently accept `targetRole`, add it to its input type in this task rather than keeping the raw insert — **the raw insert must go, or the source scan in Task 8 has a permanent hole and the peripheral lane stays silently unattributed forever.**
- The two `executeCommandWithSystemPrecheck` act/verify lanes (`services/aiAgents/playbookActExecutor.ts:454`, `services/aiAgents/actVerify.ts:159/210/240`) never enter `executeTool`, so they are reached only by the `AuthContext` carrier. Route them through `aiExecuteCommand` too, or — if `executeCommandWithSystemPrecheck` has its own options bag — add `aiOrigin` there and pass `auth.aiOrigin` at each of the four sites.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/aiTools
cd apps/api && npx vitest run src/services/peripheralPolicyState.test.ts src/services/aiAgents
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS. Note that `src/services/aiTools` is a **substring** filter and will pull in every `aiTools*.test.ts` — check the reported file count matches what the grep in step 1 found.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services
git commit -m "feat(ai): route every AI device tool through the origin adapter; convert the two rogue command inserts"
```

---

### Task 8: The two source-scan contract tests

**Files:**
- Create: `apps/api/src/services/aiDispatch.contract.test.ts`

**Interfaces:**
- Consumes: nothing at runtime — it reads the source tree.
- Produces: two failing-by-default guards. Template: `apps/api/src/services/agentEditionCompat.test.ts:155-231` (recursive `readdirSync`/`statSync` walk of `src/`, `scripts/`, `ee/`, skipping `node_modules`, `__tests__` and `*.test.*`; regex over raw file text; diff against a hand-maintained `ALLOWED` set of repo-root-relative paths; `expect(offenders).toEqual([])`; **plus a `expect(files.length).toBeGreaterThan(100)` sanity assertion so an empty scan cannot read green**).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiDispatch.contract.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCAN_ROOTS = ['apps/api/src', 'ee'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = SCAN_ROOTS.flatMap((r) => walk(path.join(REPO_ROOT, r)))
  .map((f) => path.relative(REPO_ROOT, f));

// The ONLY files permitted to insert into device_commands or script_executions.
// Adding a file here is a deliberate act: it makes that file a chokepoint, and
// the chokepoint must stamp aiOriginColumns(...) or AI work goes unattributed.
const INSERT_CHOKEPOINTS = new Set([
  'apps/api/src/services/commandQueue.ts',
  'apps/api/src/services/scriptDispatch.ts',
]);

// AI code must reach the device through services/aiDispatch.ts, whose signatures
// make aiOrigin mandatory.
const RAW_DISPATCH = /\b(?:queueCommand|queueCommandForExecution|executeCommand|dispatchDeviceCommand|dispatchScriptToDevice|insertQueuedCommandInTransaction)\b/;
const AI_FILE = /^apps\/api\/src\/services\/(aiTools[^/]*\.ts|aiAgents\/.*\.ts)$/;
const AI_RAW_DISPATCH_ALLOWED = new Set<string>([
  'apps/api/src/services/aiDispatch.ts', // the adapter itself
]);

describe('AI device dispatch is attributable by construction (#5022 W01)', () => {
  it('scans a non-empty file set', () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it('no file outside the chokepoints inserts into device_commands or script_executions', () => {
    const re = /\b(?:db|tx|trx|client)\s*\.\s*insert\s*\(\s*(deviceCommands|scriptExecutions)\b/;
    const offenders = FILES.filter((f) => !INSERT_CHOKEPOINTS.has(f)
      && re.test(readFileSync(path.join(REPO_ROOT, f), 'utf8')));
    expect(offenders,
      'A hand-rolled insert bypasses the aiOrigin stamping AND resolveCommandCreatedBy. '
      + 'Use services/aiDispatch.ts (AI code) or commandQueue.insertQueuedCommandInTransaction. '
      + 'Two such inserts existed on main before W01: aiToolsBrowser.ts and peripheralPolicyState.ts.',
    ).toEqual([]);
  });

  it('no AI tool or agent file imports an un-attributed dispatch function', () => {
    const offenders = FILES.filter((f) => AI_FILE.test(f) && !AI_RAW_DISPATCH_ALLOWED.has(f))
      .filter((f) => {
        const text = readFileSync(path.join(REPO_ROOT, f), 'utf8');
        const imports = text.match(/^import\s[\s\S]*?from\s+'[^']*(?:commandQueue|dispatchDeviceCommand|scriptDispatch)';$/gm) ?? [];
        return imports.some((line) => RAW_DISPATCH.test(line));
      });
    expect(offenders,
      'AI code must import from services/aiDispatch.ts, whose signatures require aiOrigin.',
    ).toEqual([]);
  });

  it('sees at least one AI file, so the AI_FILE pattern cannot rot silently', () => {
    expect(FILES.filter((f) => AI_FILE.test(f)).length).toBeGreaterThan(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Temporarily revert one conversion from Task 7 (e.g. `git stash push -u -m "w01-contract-red" apps/api/src/services/aiToolsBrowser.ts`), then:
Run: `cd apps/api && npx vitest run src/services/aiDispatch.contract.test.ts`
Expected: FAIL, listing `apps/api/src/services/aiToolsBrowser.ts` as an offender. **You must see this red** — a source scan that has never failed is not evidence of anything. Restore with `git stash list --format='%H %gs'` → `git stash apply <sha>` → drop the entry.

- [ ] **Step 3: (no implementation)** — Task 7 already made the tree compliant.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/aiDispatch.contract.test.ts`
Expected: PASS, 4 tests, `FILES.length > 100`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiDispatch.contract.test.ts
git commit -m "test(ai): source-scan contract tests forbidding un-attributed device dispatch"
```

---

### Task 9: Defect fix — `ai.script.executed` derives its actor from authorship, not the principal

**Files:**
- Modify: `apps/api/src/services/scriptDispatch.ts` (`:783-804`)
- Test: `apps/api/src/services/scriptDispatch.test.ts`

**Interfaces:**
- Produces: `ai.script.executed` rows whose `actor_type` and `actor_id` always describe the same entity; authorship moves into `details.authorKind`.

**Why this is a live defect, not a refactor.** Today `actorType: source.proposal.authorKind === 'agent_run' ? 'ai_agent' : 'user'` while `actorId: safeCreatedBy ?? safeTriggeredBy ?? SYSTEM_ACTOR_ID`. An AI-*authored* script hand-run by a human therefore writes `actor_type='ai_agent'` paired with a **human user id** — an audit row that misattributes a human action to an AI. *Authorship*, *initiation* and *authenticated principal* are three different things.

- [ ] **Step 1: Write the failing test**

```ts
it('a human hand-running an AI-authored proposal is audited as the human, not as an AI agent', async () => {
  await dispatchScriptToDevice({
    device, source: { kind: 'proposal', proposal: { id: 'prop-1', authorKind: 'agent_run' } },
    triggeredBy: HUMAN_USER_ID, createdBy: HUMAN_USER_ID,
  });
  expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
    action: 'ai.script.executed',
    actorType: 'user',
    actorId: HUMAN_USER_ID,
    details: expect.objectContaining({ authorKind: 'agent_run' }),
  }));
});

it('an agent-initiated proposal run is audited as the agent principal', async () => {
  await dispatchScriptToDevice({
    device, source: { kind: 'proposal', proposal: { id: 'prop-1', authorKind: 'agent_run' } },
    triggeredBy: null, createdBy: null,
    aiOrigin: { kind: 'ai_agent', agentRunId: 'run-1' },
    principalActorId: AGENT_ID,
  });
  expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
    actorType: 'ai_agent', actorId: AGENT_ID,
  }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/scriptDispatch.test.ts`
Expected: FAIL — first test gets `actorType: 'ai_agent'`.

- [ ] **Step 3: Write the implementation**

Add an optional `principalActorId?: string | null` to `DispatchScriptInput` (populated by the adapter from `auth.user.id` when `auth.aiOrigin?.kind === 'ai_agent'`) and rewrite the emission at `:783-804`:

```ts
  // Actor type and id BOTH derive from the AUTHENTICATED PRINCIPAL, never from
  // authorship. (#5022 W01: the previous version read actorType off
  // source.proposal.authorKind while actorId came from the invoker, so an
  // AI-authored script hand-run by a human wrote actor_type='ai_agent' against
  // a HUMAN user id.) Authorship is a separate fact and lives in `details`.
  const principalIsAgent = input.aiOrigin?.kind === 'ai_agent';
  const auditActorType = principalIsAgent ? 'ai_agent' as const : 'user' as const;
  const auditActorId = principalIsAgent
    ? (input.principalActorId ?? SYSTEM_ACTOR_ID)
    : (safeCreatedBy ?? safeTriggeredBy ?? SYSTEM_ACTOR_ID);
```

and widen the gate so an AI-run **library** script also writes a row (Todd's Kit case):

```ts
  if (executionId && (source.kind === 'proposal' || input.aiOrigin)) {
```

with `details` gaining `authorKind`, `aiInitiatorKind`, `aiSessionId`, `aiAgentRunId`, `sourceKind` (already present for proposals) and `deviceId: device.id` (`resourceId` is already `device.id`, which is what the events feed's resource arm indexes — keep both).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/scriptDispatch.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/scriptDispatch.ts apps/api/src/services/scriptDispatch.test.ts
git commit -m "fix(ai): derive ai.script.executed actor from the principal, not from script authorship"
```

---

### Task 10: Defect fix — an agent principal no longer vanishes when `resolveCommandCreatedBy` degrades

**Files:**
- Modify: `apps/api/src/services/commandQueue.ts` (`resolveCommandCreatedBy`, `:441-475`)
- Modify: `apps/api/src/services/scriptDispatch.ts` (the inline users-FK probe, `:514-531`)
- Test: `apps/api/src/services/commandQueue.test.ts`, `apps/api/src/__tests__/integration/commandQueueCreatedBy.integration.test.ts` (existing)

**Interfaces:**
- Produces: `resolveCommandCreatedBy` returns `{ createdBy: string | null; degraded: boolean }` (or keeps its current return and gains a sibling that reports the degrade) and logs a single structured warning when it drops a non-`users` actor.

**What is actually broken, and what the fix can and cannot be.** `device_commands.created_by` is a real FK to `users`, and `ai_agents.id` is not a `users` row, so an agent principal genuinely **cannot** be written there — `resolveCommandCreatedBy` is right to return `null`. The defect is that today the attribution is dropped **entirely and silently**: nothing else on the row records that an agent acted, so agent-issued device work has *no actor whatsoever*. After Tasks 1–7 the row carries `ai_initiator_kind='ai_agent'` and `ai_agent_run_id`, and Task 11 writes an audit row whose `actor_type='ai_agent'` / `actor_id=<agent id>` (`audit_logs.actor_id` has no FK to `users` — `actor_type='agent'` already stores device ids there). This task makes the degrade **observable** and asserts the new attribution is present so it can never silently regress to nothing.

- [ ] **Step 1: Write the failing test**

```ts
it('an ai_agent principal degrades created_by to NULL but is still attributed', async () => {
  const values = await captureQueueCommandInsert(() =>
    queueCommand('dev-1', 'run_shell', {}, AI_AGENT_ID, {
      aiOrigin: { kind: 'ai_agent', agentRunId: 'run-1' },
    }),
  );
  expect(values.createdBy).toBeNull();                 // FK reality: not a users row
  expect(values.aiInitiatorKind).toBe('ai_agent');     // …but the row is NOT anonymous
  expect(values.aiAgentRunId).toBe('run-1');
});

it('logs the degrade exactly once instead of dropping it silently', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await queueCommand('dev-1', 'run_shell', {}, AI_AGENT_ID, {
    aiOrigin: { kind: 'ai_agent', agentRunId: 'run-1' },
  });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]!.join(' ')).toContain('created_by');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/commandQueue.test.ts`
Expected: FAIL — `aiInitiatorKind` present but no warning emitted (`toHaveBeenCalledTimes(1)` receives 0).

- [ ] **Step 3: Write the implementation**

In `resolveCommandCreatedBy` (`:441-475`), when the `users` probe misses, emit one structured warning before returning `null`:

```ts
    // #5022 W01: the probe is CORRECT to return null -- created_by is an FK to
    // `users` and an ai_agents.id is not a users row. What was wrong is that
    // the drop was silent, which left agent-issued device work with no actor at
    // all. The row now carries ai_initiator_kind / ai_agent_run_id and the
    // audit row carries actor_type='ai_agent' + the agent id, so this is a
    // NARROWING of attribution, not a loss -- log it so a future lane that
    // loses BOTH is visible.
    console.warn('[commandQueue] created_by degraded to NULL: actor is not a users row', {
      candidateUserId, deviceId, hasAiOrigin: Boolean(aiOrigin),
    });
```

Thread `aiOrigin` into the helper (or into its caller's log line) so the message distinguishes an attributed degrade from an unattributed one. Apply the same treatment to `scriptDispatch.ts:514-531`'s inline probe, reusing its existing `degradedActorId` sidecar.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/commandQueue.test.ts src/services/scriptDispatch.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/commandQueue.ts apps/api/src/services/scriptDispatch.ts apps/api/src/services/commandQueue.test.ts
git commit -m "fix(ai): agent principals are attributed on the row and audibly degraded, not silently dropped"
```

---

### Task 11: Broadened audit emission — `ai.command.executed`

**Files:**
- Modify: `apps/api/src/services/commandQueue.ts` (`queueCommand` audit block `:561-609`, `dispatchPreparedCommand` audit block `:1192-1223`)
- Test: `apps/api/src/services/commandQueue.test.ts`

**Interfaces:**
- Produces: a `ai.command.executed` audit row for **every** command dispatched with an `aiOrigin`, independent of `AUDITED_COMMANDS`.

**Field contract (do not vary it):**

| Field | Value |
|---|---|
| `actorType` | from the principal: `'ai_agent'` only when `aiOrigin.kind === 'ai_agent'`; otherwise `'user'` (or `'api_key'` when that is the principal) |
| `actorId` | the principal's own id — always consistent with `actorType` |
| `action` | `'ai.command.executed'` |
| `initiatedBy` | `'ai'` |
| `resourceType` / `resourceId` / `resourceName` | `'device'` / `deviceId` / hostname — **matching `ai.script.executed` (`scriptDispatch.ts:788-790`)** so the device events feed's *resource* arm (`audit_logs_device_feed_resource_idx`, predicate `actor_type <> 'agent'`) serves it. All three actor types above satisfy that predicate. |
| `details` | `{ deviceId, commandId, commandType, aiInitiatorKind, aiSessionId, aiAgentRunId, toolName }` — `deviceId` is set as well so the feed's *details* arm can also find it if the resource id is ever repurposed |
| `result` | `'dispatched'` |

`deriveCategory()` (`routes/devices/events.ts:433-450`) already maps the `ai.` prefix to category `'ai'` and `resolveActorLabel()` (`:421-431`) already renders `'AI Agent'`, so **no route change is needed** — only the client allowlist in W02.

- [ ] **Step 1: Write the failing test**

```ts
it('writes ai.command.executed for an AI-dispatched command that is not in AUDITED_COMMANDS', async () => {
  await queueCommand('dev-1', 'get_processes', {}, 'user-1', {
    aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' },
  });
  expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
    action: 'ai.command.executed',
    initiatedBy: 'ai',
    resourceType: 'device',
    resourceId: 'dev-1',
    details: expect.objectContaining({ aiInitiatorKind: 'ai_assistant', aiSessionId: 'sess-1', deviceId: 'dev-1' }),
  }));
});

it('writes no ai.command.executed row when there is no AI origin', async () => {
  await queueCommand('dev-1', 'get_processes', {}, 'user-1');
  const actions = createAuditLogAsyncMock.mock.calls.map((c) => c[0].action);
  expect(actions).not.toContain('ai.command.executed');
});

it('does not fail the dispatch when the audit write rejects', async () => {
  createAuditLogAsyncMock.mockRejectedValueOnce(new Error('audit down'));
  await expect(queueCommand('dev-1', 'get_processes', {}, 'user-1', {
    aiOrigin: { kind: 'ai_agent', agentRunId: 'run-1' },
  })).resolves.toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/commandQueue.test.ts`
Expected: FAIL — no call with `action: 'ai.command.executed'`.

- [ ] **Step 3: Write the implementation**

Add, in both `queueCommand` and `dispatchPreparedCommand`, **beside** (not replacing) the existing `AUDITED_COMMANDS`-gated `agent.command.<type>` emission:

```ts
  // #5022 W01: an AI-initiated mutation is audited regardless of whether the
  // command type is in AUDITED_COMMANDS -- the device page's question is "what
  // touched this machine", and AUDITED_COMMANDS answers a different one.
  // Fire-and-forget, like every other audit caller here: a lost row must never
  // fail a dispatch that already succeeded. This is BEST EFFORT and the UI copy
  // says so (spec OD-10 A); a completeness guarantee would need a durable
  // outbox, filed as a platform follow-up.
  if (aiOrigin) {
    void createAuditLogAsync({ /* the field contract above */ }).catch(() => {});
  }
```

Guard against a double row when a script dispatch produces both a `script_executions` row (audited by `scriptDispatch.ts`) and its own `device_commands` row: pass `suppressAiCommandAudit: true` from `scriptDispatch.ts:644`'s `queueCommand` options so exactly one `ai.` row is written per *dispatched mutation*. W02's Overview count depends on this one-row-per-mutation property.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/commandQueue.test.ts src/services/scriptDispatch.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/commandQueue.ts apps/api/src/services/scriptDispatch.ts apps/api/src/services/commandQueue.test.ts
git commit -m "feat(ai): ai.command.executed audit row for every AI-dispatched device command"
```

---

### Task 12: Origin survives the approval boundary — persist on `action_intents`, reconstruct in the release worker

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentService.ts` (intent creation)
- Modify: `apps/api/src/services/actionIntents/actorContext.ts` (`buildUserOwnedAuthContext` return at `:295`; `buildAgentOwnedAuthContext` at `:513-515`)
- Test: `apps/api/src/services/actionIntents/actorContext.test.ts`, `apps/api/src/jobs/intentReleaseWorker.test.ts`

**Interfaces:**
- Consumes: `serializeAiOrigin` / `deserializeAiOrigin` (Task 3), the three `action_intents` columns (Tasks 1–2).
- Produces: `intentReleaseWorker`'s rebuilt `AuthContext` carries `aiOrigin` for a human-owned intent created from an AI surface.

**Why.** `intentReleaseWorker` (`jobs/intentReleaseWorker.ts:917-938`) executes under an `AuthContext` **rebuilt from scratch** by `revalidateApprovedIntentForRelease`. For a human-owned intent that is `buildUserOwnedAuthContext` (`actorContext.ts:175-…`, literal returned at `:295`), which synthesizes the context from the `users` row and permissions — so a chat-minted origin is gone by the time the approved action dispatches. The agent-owned branch delegates to `buildAgentAuthContext` (`:513-515`) and is already covered by Task 4's mint, but persisting the origin makes both branches read from the same durable fact.

- [ ] **Step 1: Write the failing test**

```ts
it('reconstructs the AI origin for a human-owned intent created from a chat session', async () => {
  const intent = makeIntent({
    aiOriginKind: 'ai_assistant', aiOriginSessionId: 'sess-1', aiOriginAgentRunId: null,
  });
  const auth = await buildUserOwnedAuthContext(intent, 'user-1');
  expect(auth.aiOrigin).toEqual({ kind: 'ai_assistant', sessionId: 'sess-1' });
});

it('leaves aiOrigin undefined for an intent that had no AI origin', async () => {
  const intent = makeIntent({ aiOriginKind: null, aiOriginSessionId: null, aiOriginAgentRunId: null });
  const auth = await buildUserOwnedAuthContext(intent, 'user-1');
  expect(auth.aiOrigin).toBeUndefined();
});

it('persists the creating context origin onto the intent row', async () => {
  const values = await captureIntentInsert(() =>
    createActionIntent(makeAuth({ aiOrigin: { kind: 'ai_agent', agentRunId: 'run-1' } }), input),
  );
  expect(values).toMatchObject({ aiOriginKind: 'ai_agent', aiOriginAgentRunId: 'run-1', aiOriginSessionId: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/actionIntents/actorContext.test.ts`
Expected: FAIL — `auth.aiOrigin` is `undefined` in the first test.

- [ ] **Step 3: Write the implementation**

- `intentService.ts`: at intent creation, spread `...serializeAiOrigin(auth.aiOrigin)` into the insert values.
- `actorContext.ts`: in the `buildUserOwnedAuthContext` return literal (`:295`) add `aiOrigin: deserializeAiOrigin(intent)`; in `buildAgentOwnedAuthContext` (`:513-515`) prefer the persisted value and fall back to the freshly built agent origin: `aiOrigin: deserializeAiOrigin(intent) ?? agentContext.aiOrigin`.
- **Do not add an UPDATE path.** `action_intents` carries `action_intents_block_content_update` (a BEFORE UPDATE immutability trigger), and `org_id` is trigger-immutable. These columns are written at INSERT only; the merge policy stays `leave-for-erasure` and no trigger-classification list changes.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/actionIntents src/jobs/intentReleaseWorker.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS. `src/services/actionIntents` is a substring filter — check the file count.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/actionIntents apps/api/src/jobs
git commit -m "feat(ai): persist and reconstruct the AI origin across the action-intent approval boundary"
```

---

### Task 13: Detach on device move — the route-local mirror

**Files:**
- Modify: `apps/api/src/routes/devices/moveOrg.ts` (add beside the `ai_agent_runs` detach at `:475`, **before** the generic denormalized re-stamp loop at `:695-703`)
- Modify: `apps/api/src/routes/devices/core.ts` (extend the exclusion-rationale comment block at `:200-260`)
- Test: `apps/api/src/routes/devices/moveOrg.coverage.test.ts` (existing), integration in Task 16

**Interfaces:**
- Consumes: the trigger half from Task 1.
- Produces: after a device move, every moved `script_executions` row has `ai_session_id IS NULL AND ai_agent_run_id IS NULL` and its `ai_initiator_kind` unchanged.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/routes/devices/moveOrg.coverage.test.ts`:

```ts
it('moveOrg severs the AI origin pointers on script_executions', () => {
  const src = readFileSync(path.join(__dirname, 'moveOrg.ts'), 'utf8');
  expect(src, 'a moved execution would otherwise point at a session or run in the SOURCE tenant')
    .toMatch(/UPDATE script_executions\s+SET ai_session_id = NULL, ai_agent_run_id = NULL/);
  expect(src, 'ai_initiator_kind must be RETAINED — the fact survives, the pointer does not')
    .not.toMatch(/SET[^;]*ai_initiator_kind\s*=\s*NULL/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/devices/moveOrg.coverage.test.ts`
Expected: FAIL — the first `toMatch` finds nothing.

- [ ] **Step 3: Write the implementation**

In `moveOrg.ts`, immediately after the `ai_agent_runs` detach at `:475`:

```ts
        // #5022 W01: script_executions IS re-stamped to the target org (it is
        // in CORE_DEVICE_ORG_DENORMALIZED_TABLES, core.ts:295), but
        // ai_agent_runs deliberately is NOT, and ai_sessions is re-stamped only
        // when it is device-bound -- a device-less chat session stays behind.
        // Either way a moved execution can end up pointing at a session or run
        // in a DIFFERENT tenant, and /devices/:id/scripts would then serve a
        // foreign id to the target org. Sever both pointers; RETAIN
        // ai_initiator_kind, so the fact that an AI did the work survives the
        // move while the cross-tenant pointer does not.
        //
        // Like the ai_agent_runs statement above, this normally matches
        // NOTHING: the devices row was already flipped earlier in this same
        // transaction, firing breeze_cascade_device_org_id(), whose body
        // carries an identical statement (this migration's detach section).
        // Kept as a route-local mirror so the detach is visible where the move
        // is read, and so the route still detaches if the trigger is dropped.
        // Both copies are convergent -- whichever runs first wins.
        await tx.execute(
          sql`UPDATE script_executions
                 SET ai_session_id = NULL, ai_agent_run_id = NULL
               WHERE device_id = ${deviceId}::uuid
                 AND (ai_session_id IS NOT NULL OR ai_agent_run_id IS NOT NULL)`,
        );
```

Extend the `core.ts:200-260` comment block with a one-line note that `script_executions` re-stamps but its AI origin pointers detach.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/routes/devices/moveOrg.coverage.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/devices
git commit -m "feat(ai): detach cross-tenant AI origin pointers on device move"
```

---

### Task 14: Detach on org merge — `script_executions` becomes a `custom` merge policy

**Files:**
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (remove `"script_executions"` from `REPOINT_TABLES` at `:822`; add a `SPECIAL` entry)
- Modify: `apps/api/src/services/orgMergeCustomExecutors.ts` (add the executor)
- Modify: `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts` (**do NOT** add `script_executions` to `CUSTOM_EXECUTORS_THAT_NEVER_WRITE_ORG_ID` — the executor *does* write `org_id`)
- Test: `apps/api/src/services/orgMergeRegistry.test.ts` (if present) + integration in Task 16

**Interfaces:**
- Produces: `orgMergeCustomExecutors.repointScriptExecutionsDetachingAiOrigin(loserOrgId, survivorOrgId)` — one `UPDATE` that repoints `org_id` **and** nulls `ai_agent_run_id`, run in the `move` phase.

**Scoping note (a refinement of the spec).** On a merge, `ai_sessions` is itself in `REPOINT_TABLES` (`orgMergeRegistry.ts:593`) alongside `script_executions` (`:822`), so the session follows and `ai_session_id` stays intra-tenant. Only `ai_agent_run_id` strands, because `ai_agent_runs` is `leave-for-erasure` (`:214`, `org_id` is trigger-immutable). **Null both anyway** — an unconditional detach is one statement, matches the move behaviour, and removes a class of "which one was it again" bugs. The comment must record *why* only one of the two was actually at risk, so a later reader does not "simplify" it back.

- [ ] **Step 1: Write the failing test**

```ts
it('script_executions is a custom merge policy that detaches AI origin pointers', () => {
  expect(ORG_MERGE_REGISTRY['script_executions']).toMatchObject({ kind: 'custom' });
  expect(CUSTOM_EXECUTORS['script_executions']).toBeTypeOf('function');
});

it('does not claim the executor skips org_id — it repoints it', () => {
  // guards against a copy-paste into CUSTOM_EXECUTORS_THAT_NEVER_WRITE_ORG_ID
  const src = readFileSync(path.join(__dirname, 'orgMergeCustomExecutors.ts'), 'utf8');
  expect(src).toMatch(/UPDATE script_executions[\s\S]*SET org_id =/);
  expect(src).toMatch(/ai_agent_run_id = NULL/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/orgMergeRegistry.test.ts`
Expected: FAIL — the registry entry is `{ kind: 'repoint' }`.

- [ ] **Step 3: Write the implementation**

Registry `SPECIAL` entry:

```ts
  // #5022 W01. Was a plain `repoint`. It still repoints org_id, but a merged
  // execution must not keep pointing at an ai_agent_runs row: runs are
  // leave-for-erasure (org_id is trigger-immutable, ai_agent_runs_immutable_guard),
  // so the run stays with the loser shell and dies with it while the execution
  // moves to the survivor. ai_session_id is NOT actually at risk here --
  // ai_sessions is itself in REPOINT_TABLES and follows -- but it is nulled
  // together with the run id so merge and device-move behave identically and
  // "the fact survives, the pointer does not" is one rule, not two.
  script_executions: { kind: 'custom', note: 'repoint org_id AND null ai_agent_run_id/ai_session_id — agent runs stay with the loser shell, so a repointed execution would otherwise hold a cross-tenant pointer' },
```

Executor (move phase, one statement so the row is never briefly inconsistent):

```ts
export async function repointScriptExecutionsDetachingAiOrigin(
  loserOrgId: string, survivorOrgId: string,
): Promise<MergeTableOutcome> {
  const moved = await exec(sql`
    UPDATE script_executions
       SET org_id = ${uuid(survivorOrgId)},
           ai_session_id = NULL,
           ai_agent_run_id = NULL
     WHERE org_id = ${uuid(loserOrgId)}
  `);
  return { moved, dropped: 0, notes: [] };
}
```

Register it in `CUSTOM_EXECUTORS`. Leave `CUSTOM_EXECUTORS_THAT_NEVER_WRITE_ORG_ID` alone.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/orgMerge
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS. `src/services/orgMerge` is a substring filter — confirm it picks up the registry and executor tests, and note the count.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/orgMergeCustomExecutors.ts apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts
git commit -m "feat(ai): detach cross-tenant AI run pointers during org merge"
```

---

### Task 15: Release notes, device-page copy, and the OD-3 follow-up issue

**Files:**
- Modify: the repo's release-notes source for the next version (`apps/docs` / the release-notes content file — locate with `grep -rl "Unreleased" apps/docs/src`)
- Create: a GitHub issue (this is a real deliverable, not a note)

**Interfaces:**
- Produces: release copy that states the incompleteness, plus a filed issue whose number is referenced in the W01 PR body.

- [ ] **Step 1: Write the release-note entry**

Copy — the wording matters, per hub constraint 3 and 4:

> **AI attribution on the device page.** Scripts and commands that an AI assistant or an autonomous AI agent dispatches to a device are now recorded as such, and appear on the device's Activities feed and Scripts tab with an AI marker and a link to the originating conversation or agent run (where you have access to it).
>
> **What is not yet attributed.** Work an AI *schedules* rather than dispatches — patch jobs, software deployments, automation runs, playbook executions, elevation requests and backups — is still recorded without an AI marker, because the device command is issued later by a background worker. SentinelOne isolation and threat actions are performed through the vendor's API and never create a Breeze command, so they are unmarked too. Tracking: `#<follow-up issue>`.
>
> **Rows created before this release are unmarked.** An unmarked row means "AI initiation was not recorded", not "a human did this" — there is no backfill, and historical AI-run scripts are indistinguishable from human runs.
>
> **Best effort, not a guarantee.** The AI marker is written alongside the dispatch on a fire-and-forget path. A dropped write leaves a real action unmarked; it never marks a human action as AI.

- [ ] **Step 2: File the OD-3 follow-up issue**

Gate A approved OD-3 B **with the indirect-lane follow-up filed before W01 merges**. File exactly this:

**Title:** `AI attribution for indirect lanes: patch jobs, deployments, automation runs, playbook executions, elevations, backup, and SentinelOne`

**Body:**

> Follow-up to the AI Scorecard W01 (#5022), which shipped attribution for **direct** device dispatch only (spec OD-3, option B: "ship direct-dispatch attribution now; file the indirect lanes as a follow-up"). This issue is that follow-up, filed as a condition of W01 merging, so the gap is a decision on the record rather than an omission.
>
> ### The gap
>
> When an AI tool creates an intermediate row and a **worker** dispatches the device command later, the worker runs under its own `AuthContext` with no `aiOrigin`. W01's three columns on `script_executions` / `device_commands` are stamped at the chokepoints, so nothing marks these commands as AI-initiated. Roughly eight AI tool call sites are in this shape.
>
> | Lane | AI entry point | Where the origin is lost | Consequence today |
> |---|---|---|---|
> | Patch jobs | `manage_patches` install/rollback → `patch_jobs` / `patch_rollbacks` (`services/aiToolsFleet.ts:932`) | `jobs/patchJobExecutor.ts:1191` passes neither the creating actor nor any AI origin. The final insert *is* centralized — this is a **propagation** hole, not an insert hole. | An AI-installed patch reads as an ordinary patch job on the device page |
> | Deployments | `manage_deployments` → `deployments` | worker dispatch | unattributed |
> | Automation runs | `manage_automations` run → `automation_runs` | worker dispatch | unattributed |
> | Playbook executions | `execute_playbook` → `playbook_executions` | worker dispatch | unattributed |
> | Elevations | `request_elevation` / `revoke_elevation` → `elevation_requests` | worker dispatch | unattributed |
> | **Backup** | `services/aiToolsBackup.ts:553` → `jobs/backupEnqueue.ts:138` | `jobs/backupWorker.ts:1011` and `:1189` call `dispatchCommandToAgent` **directly** and never create a `device_commands` row at all; queue metadata defaults to system | **No column on any W01 table can attribute AI-initiated backups.** This lane needs the origin on the backup job row plus its own audit event, not a column on `device_commands` |
> | **SentinelOne** | `s1_isolate_device`, `s1_threat_action` | `services/sentinelOne/actions.ts:233`, `:388` mutate the endpoint through the provider API, outside Breeze's command queue | Real device work with no Breeze command row. Earns an `ai.` audit event against the device — not a column |
>
> ### Proposed shape (spec OD-3, option A)
>
> 1. Add `ai_initiator_kind` / `ai_session_id` / `ai_agent_run_id` to each intermediate table (`patch_jobs`, `patch_rollbacks`, `deployments`, `automation_runs`, `playbook_executions`, `elevation_requests`, and the backup job row).
> 2. Each worker reads them back into the `aiOrigin` it passes to `services/aiDispatch.ts`.
> 3. The direct-transport lane (`dispatchCommandToAgent`) gets its own seam: the backup job row carries the origin and the worker emits the audit event itself.
> 4. Provider-API actions (SentinelOne) get an `ai.` audit row against the device, with no column anywhere.
>
> ### Registration cost (do not skip — this is why it was deferred)
>
> Every one of those tables is on the org cascade, so **each new column is a `CORE_TENANT_EXPORT_POLICY` entry** in `services/tenantExportPolicyRegistry.ts` (`included` — plain scalars). `tenant-export-policy.integration.test.ts` and `tenantExportErasureRoundtrip.integration.test.ts` fail **only under the Integration Tests CI job**, so a unit-green PR on a stale base will go green and then redden `main`. Any table whose rows can follow a device across an org move also needs the detach treatment W01 gave `script_executions` (`routes/devices/moveOrg.ts` + `breeze_cascade_device_org_id()`), and a merge policy that does not strand a cross-tenant `ai_agent_run_id`.
>
> ### Acceptance
>
> - An AI-installed patch, an AI-triggered backup and an AI SentinelOne isolation each appear on the device Activities feed with an AI marker.
> - Integration proof per lane against real Postgres, including one that proves the export-policy and org-erasure contracts still pass with the new columns present.
> - The W01 release-note paragraph "What is not yet attributed" is updated or removed.
>
> Refs #5022. Spec: `docs/superpowers/specs/ai-mcp/2026-09-13-ai-scorecard-attribution-and-impact-design.md` §4.2 and OD-3.

File it and label it:

```bash
gh issue create --title "AI attribution for indirect lanes: patch jobs, deployments, automation runs, playbook executions, elevations, backup, and SentinelOne" --body-file <path> --label enhancement --label category:ai
```

- [ ] **Step 3: Reference the issue number**

Put the number into the release-note copy (replacing `#<follow-up issue>`) and into the W01 PR body under a "Known gap" heading.

- [ ] **Step 4: Commit**

```bash
git add apps/docs
git commit -m "docs(ai): release notes for AI device attribution, stating the indirect-lane gap"
```

---

### Task 16: Live-database suites and the PR

**Files:**
- Create: `apps/api/src/__tests__/integration/aiOriginAttribution.integration.test.ts`
- Test: the existing contract suites listed below

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the failing integration test**

`aiOriginAttribution.integration.test.ts` — five cases, each against real Postgres as `breeze_app`:

```ts
import './setup';

describe('AI origin attribution (#5022 W01)', () => {
  it('reproduces the Kit case: an AI-dispatched LIBRARY script is attributed end to end', async () => {
    // dispatch a saved (non-proposal) script through aiDispatchScriptToDevice with
    // an ai_assistant origin, then assert:
    //  - script_executions row: ai_initiator_kind='ai_assistant', ai_session_id set
    //  - its device_commands row carries the same triple
    //  - exactly ONE audit row with action LIKE 'ai.%' for this mutation
    //  - GET /devices/:id/events returns it with category 'ai' and initiatedBy 'ai'
  });

  it('detaches AI origin pointers on device move but keeps ai_initiator_kind', async () => {
    // move the device to another org via the route; assert ai_session_id IS NULL,
    // ai_agent_run_id IS NULL, ai_initiator_kind unchanged, org_id re-stamped.
  });

  it('detaches ai_agent_run_id on org merge and repoints org_id', async () => {
    // merge loser -> survivor; assert the execution moved and holds no run pointer.
  });

  it('org erasure succeeds with AI-attributed rows present, and ON DELETE SET NULL fires', async () => {
    // delete the ai_sessions row under a surviving execution: ai_session_id becomes
    // NULL while ai_initiator_kind survives ("the fact survives, the evidence is erased").
    // Then erase the whole org and assert no FK violation.
  });

  it('reconstructs the origin across an approved action intent', async () => {
    // create an intent from a chat AuthContext, approve it, run the release worker,
    // and assert the resulting device_commands row carries ai_initiator_kind='ai_assistant'.
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiOriginAttribution.integration.test.ts
```
Expected: FAIL on the first assertion of each case before its implementation exists. (If the tasks above are already done, this file must still be written test-first against the *unimplemented* assertions — write one case, watch it fail for the right reason, fill it in.)

- [ ] **Step 3: Run the full live-DB contract set**

**These are the suites that only run in the Integration Tests CI job. Local green under `pnpm test` is not evidence.**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiOriginAttribution.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/commandQueueCreatedBy.integration.test.ts \
  src/__tests__/integration/commandDispatchOrgMove.integration.test.ts \
  src/__tests__/integration/deviceEventsFeedIndexes.integration.test.ts
```
Expected: all PASS. The two most likely reds are `tenant-export-policy` (a forgotten `included` string on `script_executions` or `action_intents` → `missing classifications: …`) and `orgMergeRegistry` (the `custom` reclassification).

- [ ] **Step 4: Forge a cross-tenant insert as `breeze_app`**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze
-- inside: set an org-scoped context for org A, then try to insert a
-- script_executions row for org B with ai_initiator_kind set.
```
Expected: `new row violates row-level security policy`. The AI columns must not have widened anything.

- [ ] **Step 5: Full unit sweep, typecheck, lint, then PR**

```bash
cd apps/api && npx vitest run
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
cd packages/shared && npx vitest run && npx tsc --noEmit
pnpm lint
pnpm test-stack down
```

Open the PR against `main` with body `Closes #<wave sub-issue>`, `Refs #5022`, a "Known gap" section pointing at the Task 15 follow-up issue, and an explicit callout of the two pre-existing defects fixed (`scriptDispatch.ts:783` actor mismatch; the silent agent-actor drop in `resolveCommandCreatedBy`). Merge with `gh pr merge <N>` — no `--admin`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/__tests__/integration/aiOriginAttribution.integration.test.ts
git commit -m "test(ai): live-Postgres proof of AI origin attribution, move/merge/erasure detach, and intent reconstruction"
```
