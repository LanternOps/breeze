# AI Script Authoring W03 — Human Loop and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a human can read an AI-authored script proposal on a truthful approval card (web, mobile, helper), approve it with the STRICT-pattern ceremony, send it back for changes, watch an independent verification job prove the claimed effect, and promote the verified script into the library with provenance — with `BREEZE_AI_SCRIPT_AUTHORING_ENABLED` defaulting to `true`.

**Architecture:** three API additions (a live-authorised proposal read surface at `/api/v1/ai/script-proposals`, an acknowledgement parameter on the existing approval decide core, and a `script-verify` BullMQ worker that evaluates the proposal's verification claim through *independent* device reads), plus the render surfaces that consume them. Nothing in this wave decides anything autonomously; W04 hangs the unattended lane off the `onUnattendedVerificationOutcome` hook this wave exports.

**Tech Stack:** Hono + Zod + Drizzle (API), BullMQ + Redis (verification job), React + i18next + Tailwind (web), React Native (mobile), React (helper), Playwright (e2e), Vitest everywhere.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-11-ai-script-authoring-and-review-design.md` (§4.5 STRICT acknowledgements, §4.7 revision loop, §4.8 promotion, §4.9 verification/audit/library surfaces, §6 approver-permission rows, §7 Web/Mobile/helper/Verification/E2E, §8 W03)

**Roadmap / cross-wave contracts:** `docs/superpowers/plans/ai-mcp/2026-09-11-ai-script-authoring-roadmap.md` — this wave **consumes** §3.1–§3.4 as if already merged and **produces** §3.5.

---

## Global Constraints

Every task inherits these. They are copied verbatim from the roadmap §2 and CLAUDE.md; do not re-derive them.

- **Flag.** `BREEZE_AI_SCRIPT_AUTHORING_ENABLED` is read through `apps/api/src/config/env.ts` like other `BREEZE_*` flags. W01b shipped it defaulting to `false`; **this wave flips the default to `true`** (Task 23). Every new route and the verify worker must still respect it.
- **W01a/W01b/W02 are assumed merged.** You may `import` anything named in roadmap §3.1–§3.4 without implementing it: `scanScriptContent`, `SCANNER_VERSION`, `RISK_TIERS`, `riskTierRank`, `scriptVerificationClaimSchema`, `SCRIPT_PROPOSAL_STATUSES`, `ScriptProposal`, `ScriptProposalReview`, `ScriptOrigin`, `ScriptApprovalMethod`, `cutScriptVersion`, `headScriptVersion`, `sha256Content`, `createScriptProposal`, `getScriptProposalForPrincipal`, `transitionProposal`, `consumeProposalForIntent`, `assertProposalRunnable`, `proposalDispatchSnapshot`, `ScriptDispatchSource`'s `{ kind: 'proposal' }` variant, `scriptReviewVerdictSchema`, `ScriptReviewVerdict`. If an import does not exist when you run the task, the prerequisite wave is not merged — stop and say so; do not stub it.
- **Migrations.** This wave ships exactly ONE migration (Task 5). Name it `2026-10-16-101000-script-proposal-acknowledged-patterns.sql` — it sorts after W01b's `…-100300-…` and before W04's `…-110000-…`. Idempotent (`ADD COLUMN IF NOT EXISTS`), no inner `BEGIN;`/`COMMIT;`. It writes no rows, so it needs no `breeze.scope` elevation; if you add a backfill, `SELECT set_config('breeze.scope', 'system', true);` must be the first statement and the write must `RAISE WARNING` its row count. Re-verify the name against the remote before pushing: `./scripts/check-migration-naming.sh --against-ref origin/main`.
- **Export policy.** `script_proposals` is registered in `CORE_ORG_CASCADE_DELETE_ORDER` by W01b, so **the new column in Task 5 must be classified in `CORE_TENANT_EXPORT_POLICY`** (`apps/api/src/services/tenantExportPolicyRegistry.ts`) in the same PR. `acknowledged_patterns` is `text[]` of human-readable pattern descriptions — bucket `included`. Adding a column to an already-registered table is the one cascade-registry rule that fires on a COLUMN, and it only fails under **Integration Tests**.
- **Web mutations** go through `runAction` (`apps/web/src/lib/runAction.ts`). Every new component file with a mutating `fetchWithAuth` must be added to `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` and the pinned count at `:602` bumped deliberately.
- **i18n.** New web keys need REAL translations in all seven translated locales (`pt-BR, es-419, fr-FR, fr-CA, de-DE, it-IT, tr-TR`) plus `en`. `apps/web/src/lib/i18n/translationCoverage.test.ts:769-798` caps exact-English duplicates globally (<20%) and per namespace against `namespaceDuplicateBaselines` — copying English into a locale reddens `test-web`.
- **Mobile has no component test runtime.** `apps/mobile/vitest.config.ts` includes only `src/**/*.test.ts` (not `.tsx`) on purpose. A mobile renderer is tested by extracting its pure logic into a `.ts` module with its own `.test.ts`, exactly like `apps/mobile/src/screens/approvals/approvalCopy.ts` + `approvalCopy.test.ts`.
- **E2E** selectors are `data-testid` only — no text, role, label, or CSS. Naming is `<domain>-<element>[-<modifier>]`, lowercase kebab-case (`e2e-tests/README.md:3`, `:32-52`).
- **Tests sit beside source.** Run one API file with `cd apps/api && npx vitest run <path>` — never `pnpm --filter <pkg> test -- --run <path>` (the `--` makes vitest run the whole suite in watch mode). Integration suites need `pnpm test-stack up` and are run explicitly before the PR.
- **Every task ends with a commit.** Branch `feature/<parent#>-ai-script-authoring/wave-<sub#>`. PR body carries `Closes #<wave sub-issue>` and records the review round.

---

## File Structure

**API — created**

| File | Responsibility |
|---|---|
| `apps/api/src/routes/ai/scriptProposals.ts` | The three HTTP routes. Thin adapters over the services below. |
| `apps/api/src/services/scriptProposals/detail.ts` | `loadScriptProposalDetail` — the live-authorised read, shared by every surface. |
| `apps/api/src/services/scriptProposals/authorNotify.ts` | `postProposalOutcomeToAuthor` — delivers findings/outcomes back to the chat session or agent run. |
| `apps/api/src/services/scriptProposals/promote.ts` | `promoteProposalToLibrary` — the `insertScriptRow` + `cutScriptVersion` transaction. |
| `apps/api/src/services/scriptProposals/verify.ts` | `evaluateVerificationClaim`, the queue constants, and the `onUnattendedVerificationOutcome` hook registry. |
| `apps/api/src/jobs/scriptVerifyWorker.ts` | BullMQ worker for queue `script-verify`. |

**API — modified**

| File | Change |
|---|---|
| `apps/api/src/index.ts:~989` | Mount `/ai/script-proposals` BEFORE `api.route('/ai', aiRoutes)`. |
| `apps/api/src/db/schema/scriptProposals.ts` (W01b) | Add `acknowledgedPatterns` column. |
| `apps/api/migrations/2026-10-16-101000-script-proposal-acknowledged-patterns.sql` | New column. |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | Classify the new column. |
| `apps/api/src/services/approvals/decideApprovalRequest.ts` | `acknowledgedPatterns?: string[]` on `DecideApprovalInput` + the 422. |
| `apps/api/src/routes/approvals.ts:714-763` | Parse `acknowledgedPatterns` out of the approve body. |
| `apps/api/src/services/actionIntents/intentApprovers.ts:63-65` | `resolveIntentApprovers(orgId, opts?)` — optional extra-permission filter. |
| `apps/api/src/services/actionIntents/intentService.ts` | Pass the filter when the intent's proposal has strict hits. |
| `apps/api/src/services/scriptDispatch.ts:320-322` | Acknowledgements for `source.kind === 'proposal'`. |
| `apps/api/src/services/aiToolsScripts.ts:~517` | `reviewed/approved → executed` transition at dispatch. |
| `apps/api/src/services/commandResultHandlers.ts:467-556, 658-676` | Return `proposalId`; enqueue `script-verify` at the terminal convergence point. |
| `apps/api/src/services/workerRegistry.ts` | Register `scriptVerifyWorker`, placement `socket-owner`. |
| `apps/api/src/services/aiAgentSdk.ts:~1790` | Attach a `scriptProposal` summary to the `approval_required` event (helper). |
| `apps/api/src/config/env.ts`, `config/validate.ts` | Flag default → `true`. |

**Shared — modified:** `packages/shared/src/types/scriptProposals.ts` (DTO), `packages/shared/src/validators/scriptProposals.ts` (route schemas).

**Web — created:** `components/ai/ScriptProposalApprovalCard.tsx`, `components/scripts/ScriptProvenancePanel.tsx`, `hooks/useScriptProposal.ts`, `lib/api/scriptProposals.ts` (+ `.test.tsx` beside each).
**Web — modified:** `components/ai/AiApprovalDialog.tsx`, `components/approvals/ApprovalsInbox.tsx`, `components/scripts/ScriptList.tsx`, `components/scripts/ScriptEditPage.tsx`, `lib/__tests__/no-silent-mutations.test.ts`, `locales/*/ai.json`, `locales/*/scripts.json`.

**Mobile:** `screens/approvals/scriptProposalCopy.ts` (+ test), `screens/approvals/components/ScriptProposalDetails.tsx`, modified `screens/approvals/approvalFlow.ts`, `screens/approvals/ApprovalScreen.tsx`, `services/approvals.ts`.

**Helper:** modified `stores/chatStore.ts`, `components/shell/AppShell.tsx`.

**Docs / e2e:** `docs/release-notes/next-release-draft.md`, `e2e-tests/tests/ai-script-proposals.spec.ts`, `e2e-tests/pages/ScriptProposalsPage.ts`, `e2e-tests/seed-script-proposal.sql`.

---

## Decisions taken while planning (deviations recorded, not silent)

1. **Acknowledged patterns live on `script_proposals`, not on "the intent's decision payload".** Spec §4.5 says the acknowledged set is "stored on the intent's decision payload". There is no such payload: `action_intents.arguments` is immutable (`apps/api/src/db/schema/actionIntents.ts:298`) and `approval_requests` has only `decisionReason` plus fixed decision columns (`apps/api/src/db/schema/approvals.ts:29-115`), and `intentReleaseWorker.ts:817-828` reads exactly three columns off the winning approval row (`id`, `status`, `boundArgumentDigest`). A new column on the proposal is both cheaper and more correct: dispatch already holds the proposal row (`ScriptDispatchSource` `{ kind: 'proposal'; proposal }`), so nothing new has to be plumbed through release.
2. **`apps/api/src/routes/ai/scriptProposals.ts` (a directory beside the existing `routes/ai.ts`) is safe** — `apps/api/src/routes/devices.ts` and `apps/api/src/routes/devices/` already coexist in this repo, and nothing imports `./routes/ai/index`.
3. **There is no "intent detail" page in `apps/web`** (`components/approvals/` holds only `ApprovalsInbox.tsx`, `approvalGrouping.ts` and their tests). The card therefore renders from two surfaces, not three: `AiApprovalDialog` and the inbox row.

---

## Task 1: Shared DTO and route validators

**Files:**
- Modify: `packages/shared/src/types/scriptProposals.ts` (created by W01b)
- Modify: `packages/shared/src/validators/scriptProposals.ts` (created by W01b)
- Test: `packages/shared/src/validators/scriptProposals.w03.test.ts`

**Interfaces:**
- Consumes: `ScriptProposal`, `ScriptProposalReview`, `ScriptProposalStatus`, `RISK_TIERS` (roadmap §3.1).
- Produces: `ScriptProposalDetailDto`, `ScriptProposalExecutionDto`, `scriptProposalRequestChangesSchema`, `scriptProposalPromoteSchema`, `acknowledgedPatternsSchema`, `MAX_ACKNOWLEDGED_PATTERNS`.

- [ ] **Step 1: Write the failing validator test**

```ts
// packages/shared/src/validators/scriptProposals.w03.test.ts
import { describe, expect, it } from 'vitest';
import {
  scriptProposalRequestChangesSchema,
  scriptProposalPromoteSchema,
  acknowledgedPatternsSchema,
  MAX_ACKNOWLEDGED_PATTERNS,
} from './scriptProposals';

describe('scriptProposalRequestChangesSchema', () => {
  it('requires a non-empty trimmed note', () => {
    expect(scriptProposalRequestChangesSchema.safeParse({ note: '   ' }).success).toBe(false);
    expect(scriptProposalRequestChangesSchema.safeParse({}).success).toBe(false);
  });
  it('caps the note at 2000 characters', () => {
    expect(scriptProposalRequestChangesSchema.safeParse({ note: 'x'.repeat(2001) }).success).toBe(false);
    expect(scriptProposalRequestChangesSchema.parse({ note: '  fix the path  ' })).toEqual({ note: 'fix the path' });
  });
});

describe('scriptProposalPromoteSchema', () => {
  it('accepts both owner scopes and trims the name', () => {
    expect(scriptProposalPromoteSchema.parse({ name: ' Restart spooler ', ownerScope: 'partner' }))
      .toEqual({ name: 'Restart spooler', ownerScope: 'partner' });
    expect(scriptProposalPromoteSchema.parse({ name: 'A', ownerScope: 'organization', description: 'd' }).description)
      .toBe('d');
  });
  it('rejects an unknown owner scope and an empty name', () => {
    expect(scriptProposalPromoteSchema.safeParse({ name: 'A', ownerScope: 'site' }).success).toBe(false);
    expect(scriptProposalPromoteSchema.safeParse({ name: '', ownerScope: 'organization' }).success).toBe(false);
  });
});

describe('acknowledgedPatternsSchema', () => {
  it('defaults to an empty array and caps the length', () => {
    expect(acknowledgedPatternsSchema.parse(undefined)).toEqual([]);
    expect(acknowledgedPatternsSchema.safeParse(new Array(MAX_ACKNOWLEDGED_PATTERNS + 1).fill('x')).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/shared && npx vitest run src/validators/scriptProposals.w03.test.ts`
Expected: FAIL — `scriptProposalRequestChangesSchema` is not exported.

- [ ] **Step 3: Add the schemas**

```ts
// packages/shared/src/validators/scriptProposals.ts — appended
/** Well above the STRICT vocabulary size; mirrors MAX_ACKNOWLEDGED_SECURITY_PATTERNS
 *  in apps/api/src/services/scriptSecurityAcknowledgement.ts:38. */
export const MAX_ACKNOWLEDGED_PATTERNS = 64;

export const acknowledgedPatternsSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(MAX_ACKNOWLEDGED_PATTERNS)
  .default([]);

export const scriptProposalRequestChangesSchema = z.object({
  note: z.string().trim().min(1).max(2000),
});

export const scriptProposalPromoteSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).optional(),
  ownerScope: z.enum(['organization', 'partner']),
});

export type ScriptProposalRequestChangesInput = z.infer<typeof scriptProposalRequestChangesSchema>;
export type ScriptProposalPromoteInput = z.infer<typeof scriptProposalPromoteSchema>;
```

- [ ] **Step 4: Add the DTO the web, mobile and helper all read**

```ts
// packages/shared/src/types/scriptProposals.ts — appended
export interface ScriptProposalExecutionDto {
  id: string;
  deviceId: string;
  deviceHostname: string | null;
  status: string;
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ScriptProposalVerificationDto {
  outcome: 'pending' | 'verified' | 'verification_failed' | 'unknown';
  verifiedAt: string | null;
  attempts: number;
  /** Human-readable, already-safe explanation; never raw device output. */
  detail: string | null;
}

/** The one shape every approval surface renders. Dates are ISO strings —
 *  this crosses an HTTP boundary and is consumed by React Native too. */
export interface ScriptProposalDetailDto {
  proposal: {
    id: string;
    status: ScriptProposalStatus;
    language: string;
    content: string;
    contentDigest: string;
    goal: string;
    expectedEffect: string;
    rollbackNote: string | null;
    verification: unknown;
    runAs: string;
    timeoutSeconds: number;
    targetDeviceIds: string[];
    basicHits: string[];
    strictHits: string[];
    touchClasses: string[];
    riskTier: string | null;
    revision: number;
    acknowledgedPatterns: string[];
    createdAt: string;
    expiresAt: string;
    promotedScriptId: string | null;
  };
  review: {
    id: string;
    summary: string;
    riskTier: string;
    goalMatch: string;
    reversible: boolean;
    verificationAdequate: boolean;
    recommendedAction: string;
    findings: Array<{ severity: 'info' | 'warning' | 'blocking'; text: string; lineRef?: number }>;
    blastRadius: string[];
    model: string | null;
    createdAt: string;
  } | null;
  devices: Array<{ id: string; hostname: string; osType: string | null; status: string }>;
  executions: ScriptProposalExecutionDto[];
  verification: ScriptProposalVerificationDto;
  /** Live-derived for THIS caller — never cached, never trusted from the client. */
  viewer: { canDecide: boolean; canAcknowledge: boolean; canPromote: boolean };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/shared && npx vitest run src/validators/scriptProposals.w03.test.ts`
Expected: PASS (8 assertions).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/validators/scriptProposals.ts packages/shared/src/validators/scriptProposals.w03.test.ts packages/shared/src/types/scriptProposals.ts
git commit -m "feat(shared): script proposal detail DTO and W03 route validators"
```

---

## Task 2: `acknowledged_patterns` column, schema and export policy

**Files:**
- Create: `apps/api/migrations/2026-10-16-101000-script-proposal-acknowledged-patterns.sql`
- Modify: `apps/api/src/db/schema/scriptProposals.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Test: `apps/api/src/services/scriptProposals/acknowledgedPatterns.integration.test.ts`

**Interfaces:**
- Produces: `scriptProposals.acknowledgedPatterns` (`text[]`, NOT NULL, default `{}`) — read by Tasks 6, 8 and 4.

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/src/services/scriptProposals/acknowledgedPatterns.integration.test.ts
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { CORE_TENANT_EXPORT_POLICY } from '../tenantExportPolicyRegistry';

describe('script_proposals.acknowledged_patterns', () => {
  it('exists as a NOT NULL text[] defaulting to empty', async () => {
    const rows = await db.execute(sql`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'script_proposals' AND column_name = 'acknowledged_patterns'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].is_nullable).toBe('NO');
    expect(String(rows[0].column_default)).toContain('{}');
  });

  it('is classified in the tenant export policy', () => {
    const policy = CORE_TENANT_EXPORT_POLICY['script_proposals'];
    expect(policy.included).toContain('acknowledged_patterns');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/scriptProposals/acknowledgedPatterns.integration.test.ts`
Expected: FAIL — `rows.length` is 0.

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/migrations/2026-10-16-101000-script-proposal-acknowledged-patterns.sql
-- W03 (#<wave sub-issue>): the STRICT security-pattern descriptions the APPROVER
-- acknowledged when they decided this proposal's intent.
--
-- Why here and not on action_intents / approval_requests: action_intents.arguments
-- is immutable (action_intents_immutable_trg) and approval_requests has no
-- free-form decision payload — intentReleaseWorker reads only
-- (id, status, bound_argument_digest) off the winning row. scriptDispatch already
-- holds the proposal row for a proposal-backed run, so this is the only place the
-- set can live without new plumbing through release.
--
-- Resolved server-side as (submitted ∩ strict_hits), exactly like the library's
-- resolveScriptSecurityAcknowledgement, so an approver cannot pre-acknowledge
-- the whole vocabulary. Writes no rows: no breeze.scope elevation needed.
ALTER TABLE script_proposals
  ADD COLUMN IF NOT EXISTS acknowledged_patterns text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN script_proposals.acknowledged_patterns IS
  'STRICT pattern descriptions acknowledged by the deciding approver; (submitted ∩ strict_hits).';
```

- [ ] **Step 4: Add the Drizzle column and the export-policy entry**

```ts
// apps/api/src/db/schema/scriptProposals.ts — inside the scriptProposals table
  /** W03: (submitted ∩ strict_hits) as resolved at decide time. Rides the
   *  dispatch payload as acknowledgedSecurityPatterns. */
  acknowledgedPatterns: text('acknowledged_patterns')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
```

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, add `"acknowledged_patterns"` to the `included` array of the `"script_proposals"` entry W01b created. It is a list of human-readable pattern descriptions ("PowerShell HKLM write"), not credential material, and it is not `json`/`jsonb`/`bytea`, so `included` is the right bucket.

- [ ] **Step 5: Apply and re-run**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/scriptProposals/acknowledgedPatterns.integration.test.ts
```
Expected: PASS. Then `pnpm db:check-drift` → no drift.

- [ ] **Step 6: Prove the name still sorts last against the remote**

Run: `./scripts/check-migration-naming.sh --against-ref origin/main`
Expected: exit 0. If `origin/main` gained a migration sorting after `2026-10-16-101000`, rename the file to sort after it and sweep every path reference (nothing replays it by path yet, but `autoMigrate.test.ts` asserts that).

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-10-16-101000-script-proposal-acknowledged-patterns.sql apps/api/src/db/schema/scriptProposals.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/scriptProposals/acknowledgedPatterns.integration.test.ts
git commit -m "feat(db): script_proposals.acknowledged_patterns + export policy classification"
```

---

## Task 3: `loadScriptProposalDetail` — the live-authorised read

**Files:**
- Create: `apps/api/src/services/scriptProposals/detail.ts`
- Test: `apps/api/src/services/scriptProposals/detail.test.ts`

**Interfaces:**
- Consumes: `getScriptProposalForPrincipal` (§3.3), `ScriptProposalDetailDto` (Task 1).
- Produces:
  ```ts
  export type ProposalReadDenial = 'not_found' | 'forbidden';
  export async function loadScriptProposalDetail(
    auth: AuthContext,
    proposalId: string,
  ): Promise<{ ok: true; dto: ScriptProposalDetailDto } | { ok: false; reason: ProposalReadDenial }>;
  ```

**Why live-authorised:** `#3175` fixed exactly this hole on `GET /approvals/pending` — a demoted approver who was filtered out of the list could still fetch the same row's `actionArguments` (script bodies) from the detail endpoint. `apps/api/src/routes/approvals.ts:207-226` documents the rule; this endpoint hands back the *entire script body*, so it re-derives authority per request instead of trusting a stored link.

- [ ] **Step 1: Write the failing authz test**

```ts
// apps/api/src/services/scriptProposals/detail.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getUserPermissions = vi.fn();
const canAccessOrg = vi.fn();
const userCanDecideApprovals = vi.fn();
vi.mock('../permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../permissions')>()),
  getUserPermissions: (...a: unknown[]) => getUserPermissions(...a),
  canAccessOrg: (...a: unknown[]) => canAccessOrg(...a),
  userCanDecideApprovals: (...a: unknown[]) => userCanDecideApprovals(...a),
}));

const loadProposalRow = vi.fn();
vi.mock('./queries', () => ({
  loadProposalRow: (...a: unknown[]) => loadProposalRow(...a),
  loadLatestReview: vi.fn(async () => null),
  loadProposalExecutions: vi.fn(async () => []),
  loadProposalDevices: vi.fn(async () => []),
}));

import { loadScriptProposalDetail } from './detail';

const ORG = '11111111-1111-4111-8111-111111111111';
const REQUESTER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const PROPOSAL = '44444444-4444-4444-8444-444444444444';

const auth = (userId: string) => ({
  user: { id: userId }, scope: 'organization', orgId: ORG, partnerId: null,
  accessibleOrgIds: [ORG], token: { mfa: true },
}) as never;

beforeEach(() => {
  vi.clearAllMocks();
  loadProposalRow.mockResolvedValue({
    id: PROPOSAL, orgId: ORG, status: 'reviewed', requestedByUserId: REQUESTER,
    content: 'Restart-Service spooler', strictHits: [], basicHits: [], touchClasses: ['services'],
    targetDeviceIds: [], acknowledgedPatterns: [], createdAt: new Date(), expiresAt: new Date(),
  });
});

describe('loadScriptProposalDetail', () => {
  it('lets the requester read their own proposal without approvals:decide', async () => {
    getUserPermissions.mockResolvedValue({});
    userCanDecideApprovals.mockReturnValue(false);
    canAccessOrg.mockReturnValue(true);
    const r = await loadScriptProposalDetail(auth(REQUESTER), PROPOSAL);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dto.viewer.canDecide).toBe(false);
  });

  it('lets a live approvals:decide holder with org access read it', async () => {
    getUserPermissions.mockResolvedValue({});
    userCanDecideApprovals.mockReturnValue(true);
    canAccessOrg.mockReturnValue(true);
    const r = await loadScriptProposalDetail(auth(STRANGER), PROPOSAL);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dto.viewer.canDecide).toBe(true);
  });

  it('denies a stranger who holds neither', async () => {
    getUserPermissions.mockResolvedValue({});
    userCanDecideApprovals.mockReturnValue(false);
    canAccessOrg.mockReturnValue(true);
    expect(await loadScriptProposalDetail(auth(STRANGER), PROPOSAL)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('denies a decide-holder who has LOST org access since fan-out', async () => {
    getUserPermissions.mockResolvedValue({});
    userCanDecideApprovals.mockReturnValue(true);
    canAccessOrg.mockReturnValue(false);
    expect(await loadScriptProposalDetail(auth(STRANGER), PROPOSAL)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('reports not_found for a missing proposal without leaking existence', async () => {
    loadProposalRow.mockResolvedValue(null);
    expect(await loadScriptProposalDetail(auth(REQUESTER), PROPOSAL)).toEqual({ ok: false, reason: 'not_found' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/detail.test.ts`
Expected: FAIL — cannot resolve `./detail`.

- [ ] **Step 3: Write `queries.ts` (the four system-scope reads)**

```ts
// apps/api/src/services/scriptProposals/queries.ts
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { scriptProposals, scriptProposalReviews } from '../../db/schema/scriptProposals';
import { scriptExecutions } from '../../db/schema/scripts';
import { devices } from '../../db/schema/devices';

/** System scope for the same reason approvals.ts:249-254 does it: a partner
 *  approver with orgAccess 'selected' legitimately decides for an org outside
 *  its curated list, so the REQUEST context is not guaranteed to see the row.
 *  Authority is then re-derived in detail.ts — never inferred from visibility. */
export async function loadProposalRow(proposalId: string) {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db.select().from(scriptProposals).where(eq(scriptProposals.id, proposalId)).limit(1);
      return row ?? null;
    }),
  );
}

export async function loadLatestReview(proposalId: string, orgId: string) {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select()
        .from(scriptProposalReviews)
        .where(and(eq(scriptProposalReviews.proposalId, proposalId), eq(scriptProposalReviews.orgId, orgId)))
        .orderBy(desc(scriptProposalReviews.createdAt))
        .limit(1);
      return row ?? null;
    }),
  );
}

export async function loadProposalExecutions(proposalId: string) {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          id: scriptExecutions.id, deviceId: scriptExecutions.deviceId, status: scriptExecutions.status,
          exitCode: scriptExecutions.exitCode, startedAt: scriptExecutions.startedAt,
          completedAt: scriptExecutions.completedAt, hostname: devices.hostname,
        })
        .from(scriptExecutions)
        .leftJoin(devices, eq(devices.id, scriptExecutions.deviceId))
        .where(eq(scriptExecutions.proposalId, proposalId))
        .orderBy(desc(scriptExecutions.startedAt)),
    ),
  );
}

export async function loadProposalDevices(deviceIds: string[]) {
  if (deviceIds.length === 0) return [];
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: devices.id, hostname: devices.hostname, osType: devices.osType, status: devices.status })
        .from(devices)
        .where(inArray(devices.id, deviceIds)),
    ),
  );
}
```

- [ ] **Step 4: Write `detail.ts`**

```ts
// apps/api/src/services/scriptProposals/detail.ts
import type { AuthContext } from '../../middleware/auth';
import { hasSatisfiedMfa } from '../../middleware/auth';
import { canAccessOrg, getUserPermissions, userCanDecideApprovals, userHasPermission, PERMISSIONS } from '../permissions';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import type { ScriptProposalDetailDto } from '@breeze/shared';
import { loadProposalRow, loadLatestReview, loadProposalExecutions, loadProposalDevices } from './queries';

export type ProposalReadDenial = 'not_found' | 'forbidden';

/**
 * THE read rule for a script proposal (spec §4.9, roadmap §3.5). One function,
 * shared by every surface that can hand back the script BODY, for the reason
 * `isIntentRowLiveAuthorized` exists (routes/approvals.ts:207-226, #3175): a
 * demoted approver must stop being able to fetch the code, not merely stop
 * seeing the row in a list.
 *
 * Authorised when the proposal's org is reachable AND either
 *   - the caller is the proposal's requester (the author of the run request), or
 *   - the caller STILL holds approvals:decide for that org.
 */
export async function loadScriptProposalDetail(
  auth: AuthContext,
  proposalId: string,
): Promise<{ ok: true; dto: ScriptProposalDetailDto } | { ok: false; reason: ProposalReadDenial }> {
  const proposal = await loadProposalRow(proposalId);
  if (!proposal) return { ok: false, reason: 'not_found' };

  const perms = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      getUserPermissions(auth.user.id, { partnerId: auth.partnerId ?? undefined, orgId: proposal.orgId }),
    ),
  );
  const reachable = !!perms && canAccessOrg(perms, proposal.orgId);
  const canDecide = reachable && userCanDecideApprovals(perms!);
  const isRequester = proposal.requestedByUserId === auth.user.id;
  if (!reachable || (!canDecide && !isRequester)) return { ok: false, reason: 'forbidden' };

  const canWriteScripts =
    reachable && userHasPermission(perms!, PERMISSIONS.SCRIPTS_WRITE.resource, PERMISSIONS.SCRIPTS_WRITE.action);
  const mfaOk = hasSatisfiedMfa(auth);

  const [review, executions, devices] = await Promise.all([
    loadLatestReview(proposalId, proposal.orgId),
    loadProposalExecutions(proposalId),
    loadProposalDevices(proposal.targetDeviceIds ?? []),
  ]);

  const verdict = (review?.verdict ?? {}) as { findings?: unknown; blastRadius?: unknown };
  return {
    ok: true,
    dto: {
      proposal: {
        id: proposal.id, status: proposal.status, language: proposal.language, content: proposal.content,
        contentDigest: proposal.contentDigest, goal: proposal.goal, expectedEffect: proposal.expectedEffect,
        rollbackNote: proposal.rollbackNote, verification: proposal.verification, runAs: proposal.runAs,
        timeoutSeconds: proposal.timeoutSeconds, targetDeviceIds: proposal.targetDeviceIds ?? [],
        basicHits: proposal.basicHits ?? [], strictHits: proposal.strictHits ?? [],
        touchClasses: proposal.touchClasses ?? [], riskTier: proposal.riskTier, revision: proposal.revision,
        acknowledgedPatterns: proposal.acknowledgedPatterns ?? [],
        createdAt: proposal.createdAt.toISOString(), expiresAt: proposal.expiresAt.toISOString(),
        promotedScriptId: proposal.promotedScriptId ?? null,
      },
      review: review
        ? {
            id: review.id, summary: review.summary, riskTier: review.riskTier, goalMatch: review.goalMatch,
            reversible: review.reversible, verificationAdequate: review.verificationAdequate,
            recommendedAction: review.recommendedAction,
            findings: Array.isArray(verdict.findings) ? (verdict.findings as never) : [],
            blastRadius: Array.isArray(verdict.blastRadius) ? (verdict.blastRadius as string[]) : [],
            model: review.model, createdAt: review.createdAt.toISOString(),
          }
        : null,
      devices: devices.map((d) => ({ id: d.id, hostname: d.hostname, osType: d.osType, status: d.status })),
      executions: executions.map((e) => ({
        id: e.id, deviceId: e.deviceId, deviceHostname: e.hostname ?? null, status: e.status,
        exitCode: e.exitCode ?? null,
        startedAt: e.startedAt?.toISOString() ?? null, completedAt: e.completedAt?.toISOString() ?? null,
      })),
      verification: {
        outcome:
          proposal.status === 'verified' ? 'verified'
          : proposal.status === 'verification_failed' ? 'verification_failed'
          : ((proposal.verificationResult as { outcome?: string } | null)?.outcome as never) ?? 'pending',
        verifiedAt: proposal.verifiedAt?.toISOString() ?? null,
        attempts: ((proposal.verificationResult as { attempts?: number } | null)?.attempts) ?? 0,
        detail: ((proposal.verificationResult as { detail?: string } | null)?.detail) ?? null,
      },
      viewer: {
        canDecide,
        canAcknowledge: canWriteScripts && mfaOk,
        canPromote: canWriteScripts && mfaOk && proposal.status === 'verified',
      },
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/detail.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/scriptProposals/detail.ts apps/api/src/services/scriptProposals/queries.ts apps/api/src/services/scriptProposals/detail.test.ts
git commit -m "feat(api): live-authorised script proposal detail loader"
```

---

## Task 4: `GET /api/v1/ai/script-proposals/:id`

**Files:**
- Create: `apps/api/src/routes/ai/scriptProposals.ts`
- Modify: `apps/api/src/index.ts` (import + mount)
- Test: `apps/api/src/routes/ai/scriptProposals.test.ts`

**Interfaces:**
- Consumes: `loadScriptProposalDetail` (Task 3), `aiScriptAuthoringEnabled()` (W01b).
- Produces: `export const aiScriptProposalRoutes` — the Hono app Tasks 5 and 6 extend.

- [ ] **Step 1: Write the failing route test**

```ts
// apps/api/src/routes/ai/scriptProposals.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const loadScriptProposalDetail = vi.fn();
vi.mock('../../services/scriptProposals/detail', () => ({
  loadScriptProposalDetail: (...a: unknown[]) => loadScriptProposalDetail(...a),
}));
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/env')>()),
  aiScriptAuthoringEnabled: () => true,
}));
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', {
        user: { id: '22222222-2222-4222-8222-222222222222' },
        scope: 'organization', orgId: '11111111-1111-4111-8111-111111111111',
        partnerId: null, accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'],
        token: { mfa: true },
      });
      await next();
    },
  };
});

import { aiScriptProposalRoutes } from './scriptProposals';

const ID = '44444444-4444-4444-8444-444444444444';
beforeEach(() => vi.clearAllMocks());

describe('GET /:id', () => {
  it('returns the DTO for an authorised caller', async () => {
    loadScriptProposalDetail.mockResolvedValue({ ok: true, dto: { proposal: { id: ID } } });
    const res = await aiScriptProposalRoutes.request(`/${ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ proposal: { id: ID } });
  });

  it('404s an unknown proposal', async () => {
    loadScriptProposalDetail.mockResolvedValue({ ok: false, reason: 'not_found' });
    expect((await aiScriptProposalRoutes.request(`/${ID}`)).status).toBe(404);
  });

  it('403s a caller who is neither requester nor a live approvals:decide holder', async () => {
    loadScriptProposalDetail.mockResolvedValue({ ok: false, reason: 'forbidden' });
    const res = await aiScriptProposalRoutes.request(`/${ID}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('400s a non-uuid id before touching the service', async () => {
    expect((await aiScriptProposalRoutes.request('/not-a-uuid')).status).toBe(400);
    expect(loadScriptProposalDetail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/routes/ai/scriptProposals.test.ts`
Expected: FAIL — cannot resolve `./scriptProposals`.

- [ ] **Step 3: Write the route module**

```ts
// apps/api/src/routes/ai/scriptProposals.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { aiScriptAuthoringEnabled } from '../../config/env';
import { loadScriptProposalDetail } from '../../services/scriptProposals/detail';

/**
 * `/api/v1/ai/script-proposals` — the approver-facing read + decision surface for
 * AI-authored script proposals (spec §4.7-§4.9, roadmap §3.5).
 *
 * Mounted in index.ts BEFORE `api.route('/ai', aiRoutes)` so a future root-level
 * `/:id` on aiRoutes can never capture this prefix — the same ordering discipline
 * `/ai/agents/schedules` before `/ai/agents` already follows (index.ts:985-990),
 * and that `/sessions/search` before `/sessions/:id` follows inside ai.ts:250-272.
 */
export const aiScriptProposalRoutes = new Hono();

aiScriptProposalRoutes.use('*', authMiddleware);

/** The whole surface is dark when the wave flag is off. */
aiScriptProposalRoutes.use('*', async (c, next) => {
  if (!aiScriptAuthoringEnabled()) return c.json({ error: 'feature_disabled' }, 404);
  await next();
});

const idParam = z.object({ id: z.string().guid() });

aiScriptProposalRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParam),
  async (c) => {
    // No requirePermission here on purpose: the REQUESTER may read their own
    // proposal without approvals:decide, and a decide-holder may read it without
    // being the requester. The rule is one function, loadScriptProposalDetail.
    const result = await loadScriptProposalDetail(c.get('auth'), c.req.valid('param').id);
    if (!result.ok) {
      return result.reason === 'not_found'
        ? c.json({ error: 'not_found' }, 404)
        : c.json({ error: 'forbidden' }, 403);
    }
    return c.json(result.dto);
  },
);
```

- [ ] **Step 4: Mount it**

In `apps/api/src/index.ts`, beside the other AI imports (near `:140`):

```ts
import { aiScriptProposalRoutes } from './routes/ai/scriptProposals';
```

and immediately before `api.route('/ai', aiRoutes);` (currently `:990`):

```ts
// W03: more specific than '/ai', so it must be registered first — same reason
// '/ai/agents/schedules' sits above '/ai/agents'. Hono matches in registration order.
api.route('/ai/script-proposals', aiScriptProposalRoutes);
api.route('/ai', aiRoutes);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/ai/scriptProposals.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Prove the existing `/ai` surface still resolves**

Adding the `routes/ai/` directory next to `routes/ai.ts` mirrors `routes/devices.ts` + `routes/devices/`, but prove it rather than assume it:

Run: `cd apps/api && npx vitest run src/routes/ai_sessions_crud.test.ts src/routes/ai.ticket.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/ai/scriptProposals.ts apps/api/src/routes/ai/scriptProposals.test.ts apps/api/src/index.ts
git commit -m "feat(api): GET /ai/script-proposals/:id with live authorisation"
```

---

## Task 5: `postProposalOutcomeToAuthor` — deliver findings back to chat and agents

**Files:**
- Create: `apps/api/src/services/scriptProposals/authorNotify.ts`
- Test: `apps/api/src/services/scriptProposals/authorNotify.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ProposalAuthorEvent =
    | { kind: 'changes_requested'; note: string; findings: Array<{ severity: string; text: string }> }
    | { kind: 'verified'; detail: string }
    | { kind: 'verification_failed'; detail: string }
    | { kind: 'verification_unknown'; detail: string };
  export function renderAuthorMessage(proposalId: string, event: ProposalAuthorEvent): string;
  export async function postProposalOutcomeToAuthor(
    proposal: { id: string; orgId: string; authorKind: string; sessionId: string | null; agentRunId: string | null },
    event: ProposalAuthorEvent,
  ): Promise<void>;
  ```

**Background you need.** There is no existing background-worker writer of `ai_messages`; the two primitives are the insert (`aiAgentSdk.ts:2003-2013`) and the **process-local** `SessionEventBus` (`streamingSessionManager.ts:336` subscribe, `:357` publish, registry `get(sessionId)` at `:1058`, singleton export at `:1994`). There is no Redis fan-out for session streams, so a cross-process publish is a no-op — the DB row is the durable channel and the SSE publish is the best-effort live nudge. Say that in the code, do not pretend otherwise.

For an **agent** author, the pending `run_script` tool call is already resolved by the intent path: `runLoop.ts:605-620` turns a non-pending intent into `intentError` and `recordProposal` (`runLoop.ts:545`, return at `:635-642`) hands the model `{ allowed: false, error }`. Denying the intent with `reason: 'changes_requested'` (Task 6) is therefore what reaches the agent; this service only adds the durable notification.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/scriptProposals/authorNotify.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const insertValues = vi.fn();
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  db: { insert: () => ({ values: (v: unknown) => insertValues(v) }) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
const publish = vi.fn();
const getSession = vi.fn();
vi.mock('../streamingSessionManager', () => ({
  streamingSessionManager: { get: (...a: unknown[]) => getSession(...a) },
}));
const createNotification = vi.fn();
vi.mock('../userNotifications', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));

import { postProposalOutcomeToAuthor, renderAuthorMessage } from './authorNotify';

const proposal = {
  id: '44444444-4444-4444-8444-444444444444',
  orgId: '11111111-1111-4111-8111-111111111111',
  authorKind: 'chat_session',
  sessionId: '55555555-5555-4555-8555-555555555555',
  agentRunId: null,
  requestedByUserId: '22222222-2222-4222-8222-222222222222',
};

beforeEach(() => { vi.clearAllMocks(); getSession.mockReturnValue({ eventBus: { publish } }); });

describe('renderAuthorMessage', () => {
  it('names the note and every finding for changes_requested', () => {
    const text = renderAuthorMessage(proposal.id, {
      kind: 'changes_requested',
      note: 'Target only the print spooler.',
      findings: [{ severity: 'warning', text: 'Stops every service matching *spool*' }],
    });
    expect(text).toContain('Target only the print spooler.');
    expect(text).toContain('Stops every service matching *spool*');
    expect(text).toContain(proposal.id);
  });
});

describe('postProposalOutcomeToAuthor', () => {
  it('writes a durable ai_messages row for a chat author', async () => {
    await postProposalOutcomeToAuthor(proposal, { kind: 'verified', detail: 'Service spooler is running.' });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: proposal.sessionId, role: 'system' }),
    );
  });

  it('publishes to the live session bus when the session is in this process', async () => {
    await postProposalOutcomeToAuthor(proposal, { kind: 'verified', detail: 'ok' });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'script_proposal_update' }));
  });

  it('does not throw when the session is owned by another process', async () => {
    getSession.mockReturnValue(undefined);
    await expect(postProposalOutcomeToAuthor(proposal, { kind: 'verified', detail: 'ok' })).resolves.toBeUndefined();
    expect(insertValues).toHaveBeenCalled();
  });

  it('skips the message insert for an agent author and notifies the requester instead', async () => {
    await postProposalOutcomeToAuthor(
      { ...proposal, authorKind: 'agent_run', sessionId: null, agentRunId: '66666666-6666-4666-8666-666666666666' },
      { kind: 'verification_failed', detail: 'Service spooler is stopped.' },
    );
    expect(insertValues).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approval', orgId: proposal.orgId }),
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/authorNotify.test.ts`
Expected: FAIL — cannot resolve `./authorNotify`.

- [ ] **Step 3: Implement it**

```ts
// apps/api/src/services/scriptProposals/authorNotify.ts
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiMessages } from '../../db/schema/ai';
import { streamingSessionManager } from '../streamingSessionManager';
import { createNotification } from '../userNotifications';
import { captureException } from '../sentry';

export type ProposalAuthorEvent =
  | { kind: 'changes_requested'; note: string; findings: Array<{ severity: string; text: string }> }
  | { kind: 'verified'; detail: string }
  | { kind: 'verification_failed'; detail: string }
  | { kind: 'verification_unknown'; detail: string };

const TITLES: Record<ProposalAuthorEvent['kind'], string> = {
  changes_requested: 'Changes requested on your script proposal',
  verified: 'Script proposal verified',
  verification_failed: 'Script proposal failed verification',
  verification_unknown: 'Script proposal could not be verified',
};

/** Plain text, because it lands in a chat transcript AND a notification body. */
export function renderAuthorMessage(proposalId: string, event: ProposalAuthorEvent): string {
  const head = `${TITLES[event.kind]} (proposal ${proposalId}).`;
  if (event.kind !== 'changes_requested') return `${head}\n${event.detail}`;
  const findings = event.findings.length
    ? `\n\nReviewer findings:\n${event.findings.map((f) => `- [${f.severity}] ${f.text}`).join('\n')}`
    : '';
  return `${head}\n\nApprover note: ${event.note}${findings}\n\nCall propose_script again with supersedesProposalId set to this id; do not retry the same content.`;
}

/**
 * Deliver a proposal outcome to whoever authored it.
 *
 * Chat: a durable `ai_messages` row (role 'system') plus a best-effort publish on
 * the in-process SessionEventBus. The bus is PROCESS-LOCAL (streamingSessionManager
 * :336/:357, registry :1058) — there is no Redis fan-out for session streams — so a
 * session streaming from another API replica gets the row and nothing else, and the
 * client picks it up on its next fetch. That is the contract, not a bug to "fix"
 * with a broadcast.
 *
 * Agent: nothing is written into the run transcript here. The pending run_script
 * tool call is resolved by the intent denial itself (runLoop.ts:605-642), so this
 * only raises the durable notification for the humans watching the run.
 */
export async function postProposalOutcomeToAuthor(
  proposal: {
    id: string; orgId: string; authorKind: string;
    sessionId: string | null; agentRunId: string | null; requestedByUserId?: string | null;
  },
  event: ProposalAuthorEvent,
): Promise<void> {
  const body = renderAuthorMessage(proposal.id, event);

  if (proposal.authorKind === 'chat_session' && proposal.sessionId) {
    const sessionId = proposal.sessionId;
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.insert(aiMessages).values({ sessionId, role: 'system', content: body }),
      ),
    );
    try {
      streamingSessionManager.get(sessionId)?.eventBus.publish({
        type: 'script_proposal_update',
        proposalId: proposal.id,
        outcome: event.kind,
        message: body,
      } as never);
    } catch (err) {
      // A live-stream nudge failing must never fail the decision or the job.
      captureException(err, { tags: { area: 'script_proposal_author_notify' } });
    }
  }

  if (proposal.requestedByUserId) {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        createNotification({
          userId: proposal.requestedByUserId!,
          orgId: proposal.orgId,
          type: 'approval',
          priority: event.kind === 'verification_failed' ? 'high' : 'normal',
          title: TITLES[event.kind],
          message: body.slice(0, 500),
          link: `/approvals`,
          metadata: { proposalId: proposal.id, outcome: event.kind },
          dedupeKey: `script-proposal:${proposal.id}:${event.kind}`,
        }),
      ),
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/authorNotify.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/scriptProposals/authorNotify.ts apps/api/src/services/scriptProposals/authorNotify.test.ts
git commit -m "feat(api): deliver script proposal outcomes back to the chat session or run"
```

---

## Task 6: `POST /:id/request-changes`

**Files:**
- Modify: `apps/api/src/routes/ai/scriptProposals.ts`
- Test: `apps/api/src/routes/ai/scriptProposals.requestChanges.test.ts`

**Interfaces:**
- Consumes: `transitionProposal` (§3.3), `decideApprovalRequest` / the intent deny path, `postProposalOutcomeToAuthor` (Task 5), `loadScriptProposalDetail` (Task 3).
- Produces: `POST /api/v1/ai/script-proposals/:id/request-changes { note }` → `200 { status: 'changes_requested' }`.

**The transition** (spec §4.7): `reviewed | approved → changes_requested`. The linked intent, if any, is denied with `reason: 'changes_requested'` through the existing decide path so the pending tool call resolves as a tool error (`aiAgentSdk.ts:1347-1349` for chat, `runLoop.ts:605-642` for agents) — this route must not invent a second denial mechanism.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/routes/ai/scriptProposals.requestChanges.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const loadScriptProposalDetail = vi.fn();
const transitionProposal = vi.fn();
const denyIntentForProposal = vi.fn();
const postProposalOutcomeToAuthor = vi.fn();

vi.mock('../../services/scriptProposals/detail', () => ({
  loadScriptProposalDetail: (...a: unknown[]) => loadScriptProposalDetail(...a),
}));
vi.mock('../../services/scriptProposals/index', () => ({
  transitionProposal: (...a: unknown[]) => transitionProposal(...a),
  denyIntentForProposal: (...a: unknown[]) => denyIntentForProposal(...a),
}));
vi.mock('../../services/scriptProposals/authorNotify', () => ({
  postProposalOutcomeToAuthor: (...a: unknown[]) => postProposalOutcomeToAuthor(...a),
}));
vi.mock('../../config/env', async (o) => ({ ...(await o<never>()), aiScriptAuthoringEnabled: () => true }));
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', {
        user: { id: '22222222-2222-4222-8222-222222222222' }, scope: 'organization',
        orgId: '11111111-1111-4111-8111-111111111111', partnerId: null,
        accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'], token: { mfa: true },
      });
      await next();
    },
  };
});

import { aiScriptProposalRoutes } from './scriptProposals';

const ID = '44444444-4444-4444-8444-444444444444';
const post = (body: unknown) =>
  aiScriptProposalRoutes.request(`/${ID}/request-changes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  transitionProposal.mockResolvedValue(true);
  loadScriptProposalDetail.mockResolvedValue({
    ok: true,
    dto: {
      proposal: { id: ID, status: 'reviewed', intentId: 'intent-1' },
      review: { findings: [{ severity: 'warning', text: 'Broad service match' }] },
      viewer: { canDecide: true },
    },
  });
});

describe('POST /:id/request-changes', () => {
  it('transitions, denies the intent and notifies the author', async () => {
    const res = await post({ note: 'Narrow the service filter.' });
    expect(res.status).toBe(200);
    expect(transitionProposal).toHaveBeenCalledWith(
      expect.anything(), ID, ['reviewed', 'approved'], 'changes_requested', expect.anything(),
    );
    expect(denyIntentForProposal).toHaveBeenCalledWith(expect.anything(), 'changes_requested');
    expect(postProposalOutcomeToAuthor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'changes_requested', note: 'Narrow the service filter.' }),
    );
  });

  it('400s an empty note', async () => {
    expect((await post({ note: '  ' })).status).toBe(400);
    expect(transitionProposal).not.toHaveBeenCalled();
  });

  it('403s a caller who cannot decide', async () => {
    loadScriptProposalDetail.mockResolvedValue({ ok: true, dto: { proposal: { id: ID }, viewer: { canDecide: false } } });
    expect((await post({ note: 'x' })).status).toBe(403);
  });

  it('409s when the proposal already left a requestable state', async () => {
    transitionProposal.mockResolvedValue(false);
    const res = await post({ note: 'x' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'proposal_not_requestable' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/routes/ai/scriptProposals.requestChanges.test.ts`
Expected: FAIL — 404 from Hono (route not registered).

- [ ] **Step 3: Add `denyIntentForProposal` to the proposals service hub**

```ts
// apps/api/src/services/scriptProposals/intentLink.ts  (re-exported from ./index)
import { eq } from 'drizzle-orm';
import type { DbTransaction } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { publishIntentTerminalOutbox } from '../aiOperator/taskOutbox';

/**
 * Deny the one intent a proposal was consumed by, with a typed reason.
 *
 * CAS on `pending_approval` so a race with a real approver decision (or the
 * expiry reaper) loses cleanly instead of resurrecting a decided intent. The
 * terminal outbox publish is what unblocks the waiting tool call: chat sees it
 * through the intent-decision poll in aiAgentSdk.ts:1347-1349, agents through
 * runLoop.ts:605-620.
 */
export async function denyIntentForProposal(
  tx: DbTransaction,
  proposal: { intentId: string | null },
  reason: 'changes_requested',
): Promise<boolean> {
  if (!proposal.intentId) return false;
  const rows = await tx
    .update(actionIntents)
    .set({ status: 'rejected', decidedAt: new Date(), errorCode: reason })
    .where(and(eq(actionIntents.id, proposal.intentId), eq(actionIntents.status, 'pending_approval')))
    .returning({ id: actionIntents.id, orgId: actionIntents.orgId });
  if (rows.length === 0) return false;
  await publishIntentTerminalOutbox(tx, rows[0].id);
  return true;
}
```

(Import `and` from `drizzle-orm`. Export it from `apps/api/src/services/scriptProposals/index.ts` alongside the W01b exports.)

- [ ] **Step 4: Add the route**

```ts
// apps/api/src/routes/ai/scriptProposals.ts — appended
import { scriptProposalRequestChangesSchema } from '@breeze/shared';
import { db } from '../../db';
import { transitionProposal, denyIntentForProposal } from '../../services/scriptProposals';
import { postProposalOutcomeToAuthor } from '../../services/scriptProposals/authorNotify';
import { writeAuditEventAsync } from '../../services/auditEvents';

aiScriptProposalRoutes.post(
  '/:id/request-changes',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParam),
  zValidator('json', scriptProposalRequestChangesSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { note } = c.req.valid('json');

    const loaded = await loadScriptProposalDetail(auth, id);
    if (!loaded.ok) {
      return loaded.reason === 'not_found' ? c.json({ error: 'not_found' }, 404) : c.json({ error: 'forbidden' }, 403);
    }
    // Requesting changes IS a decision (spec §4.7) — the requester-only read
    // grant is not enough.
    if (!loaded.dto.viewer.canDecide) return c.json({ error: 'forbidden' }, 403);

    const moved = await db.transaction(async (tx) => {
      const ok = await transitionProposal(tx, id, ['reviewed', 'approved'], 'changes_requested', {
        decidedBy: auth.user.id, decidedAt: new Date(), decisionNote: note,
      });
      if (!ok) return false;
      await denyIntentForProposal(tx, loaded.dto.proposal as never, 'changes_requested');
      return true;
    });
    if (!moved) return c.json({ error: 'proposal_not_requestable' }, 409);

    await postProposalOutcomeToAuthor(loaded.dto.proposal as never, {
      kind: 'changes_requested',
      note,
      findings: loaded.dto.review?.findings ?? [],
    });
    writeAuditEventAsync({
      action: 'script.proposal.decided', orgId: auth.orgId ?? null, actorUserId: auth.user.id,
      targetType: 'script_proposal', targetId: id, metadata: { decision: 'changes_requested' },
    });
    return c.json({ status: 'changes_requested' });
  },
);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/ai/scriptProposals.requestChanges.test.ts src/routes/ai/scriptProposals.test.ts`
Expected: PASS (8 tests across the two files).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/ai/scriptProposals.ts apps/api/src/routes/ai/scriptProposals.requestChanges.test.ts apps/api/src/services/scriptProposals/intentLink.ts apps/api/src/services/scriptProposals/index.ts
git commit -m "feat(api): POST /ai/script-proposals/:id/request-changes revision loop"
```

---

## Task 7: `promoteProposalToLibrary`

**Files:**
- Create: `apps/api/src/services/scriptProposals/promote.ts`
- Modify: `apps/api/src/services/scriptWrite.ts` (thread provenance through `insertScriptRow`)
- Test: `apps/api/src/services/scriptProposals/promote.test.ts`

**Interfaces:**
- Consumes: `insertScriptRow` (`scriptWrite.ts:201-207`), `resolveScriptCreateScope` (`scriptWrite.ts:51-55`), `isScriptScopeError`, `cutScriptVersion` + `ScriptVersionProvenance` (roadmap §3.2), `transitionProposal` (§3.3).
- Produces:
  ```ts
  export type PromoteDenial =
    | { status: 409; error: 'proposal_not_verified' }
    | { status: 403 | 400; error: string };
  export async function promoteProposalToLibrary(args: {
    auth: AuthContext;
    proposal: ScriptProposalRow;
    review: { id: string; riskTier: string; summary: string; createdAt: Date } | null;
    input: ScriptProposalPromoteInput;
  }): Promise<{ ok: true; scriptId: string; versionId: string } | { ok: false } & PromoteDenial>;
  ```

**Spec §4.8 exactly:** the `scripts` row gets `origin = 'ai_proposal'`, `origin_proposal_id`, name/description from the caller (prefilled from `goal` client-side), the acknowledged STRICT set as `acknowledged_security_patterns`, `security_acknowledged_by` = the approver; the v1 `script_versions` row gets `origin`, `proposal_id`, `review_id`, `reviewed_at`, `approved_by`, `approved_at`, `approval_method`, `content_digest`. `ownerScope` follows the CLAUDE.md partner-wide playbook step 2 — the create route takes an `ownerScope` field and partner-wide creation is gated by `canManagePartnerWidePolicies`, which `resolveScriptCreateScope` already enforces (`scriptWrite.ts:64-68`). **Do not write a second gate.**

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/scriptProposals/promote.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const insertScriptRow = vi.fn();
const transitionProposal = vi.fn();
vi.mock('../scriptWrite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scriptWrite')>()),
  insertScriptRow: (...a: unknown[]) => insertScriptRow(...a),
}));
vi.mock('./index', () => ({ transitionProposal: (...a: unknown[]) => transitionProposal(...a) }));
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  db: { transaction: (fn: (tx: unknown) => unknown) => fn({}) },
}));

import { promoteProposalToLibrary } from './promote';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const baseProposal = {
  id: '44444444-4444-4444-8444-444444444444', orgId: ORG, status: 'verified',
  content: 'Restart-Service spooler', contentDigest: 'a'.repeat(64), language: 'powershell',
  timeoutSeconds: 300, runAs: 'system', goal: 'Restart the spooler',
  acknowledgedPatterns: ['PowerShell HKLM write'], decidedBy: USER, decidedAt: new Date('2026-09-11T10:00:00Z'),
};
const review = { id: 'r1', riskTier: 'medium', summary: 'Targets one service', createdAt: new Date('2026-09-11T09:00:00Z') };
const auth = (scope: 'organization' | 'partner') => ({
  user: { id: USER }, scope, orgId: scope === 'organization' ? ORG : null, partnerId: 'p1',
  accessibleOrgIds: [ORG], partnerOrgAccess: 'all', token: { mfa: true },
}) as never;

beforeEach(() => {
  vi.clearAllMocks();
  insertScriptRow.mockResolvedValue({ id: 'script-1', version: 1, headVersionId: 'ver-1' });
  transitionProposal.mockResolvedValue(true);
});

describe('promoteProposalToLibrary', () => {
  it('refuses a proposal that is not verified (D5/D12)', async () => {
    const r = await promoteProposalToLibrary({
      auth: auth('organization'), proposal: { ...baseProposal, status: 'executed' } as never, review,
      input: { name: 'Restart spooler', ownerScope: 'organization' },
    });
    expect(r).toMatchObject({ ok: false, status: 409, error: 'proposal_not_verified' });
    expect(insertScriptRow).not.toHaveBeenCalled();
  });

  it('carries the acknowledged STRICT set and the approver onto the script row', async () => {
    await promoteProposalToLibrary({
      auth: auth('organization'), proposal: baseProposal as never, review,
      input: { name: 'Restart spooler', description: 'From proposal', ownerScope: 'organization' },
    });
    expect(insertScriptRow).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({
        name: 'Restart spooler',
        content: baseProposal.content,
        acknowledgedSecurityPatterns: ['PowerShell HKLM write'],
      }),
      expect.objectContaining({
        provenance: expect.objectContaining({
          origin: 'ai_proposal', proposalId: baseProposal.id, reviewId: 'r1',
          approvedBy: USER, approvalMethod: expect.any(String),
        }),
        securityAcknowledgedBy: USER,
      }),
    );
  });

  it('moves the proposal to promoted and returns the new ids', async () => {
    const r = await promoteProposalToLibrary({
      auth: auth('organization'), proposal: baseProposal as never, review,
      input: { name: 'Restart spooler', ownerScope: 'organization' },
    });
    expect(r).toEqual({ ok: true, scriptId: 'script-1', versionId: 'ver-1' });
    expect(transitionProposal).toHaveBeenCalledWith(
      expect.anything(), baseProposal.id, ['verified'], 'promoted',
      expect.objectContaining({ promotedScriptId: 'script-1' }),
    );
  });

  it('surfaces the partner-wide capability denial from resolveScriptCreateScope', async () => {
    const r = await promoteProposalToLibrary({
      auth: { ...(auth('partner') as never as Record<string, unknown>), partnerOrgAccess: 'selected' } as never,
      proposal: baseProposal as never, review,
      input: { name: 'Restart spooler', ownerScope: 'partner' },
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(insertScriptRow).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/promote.test.ts`
Expected: FAIL — cannot resolve `./promote`.

- [ ] **Step 3: Thread provenance through `insertScriptRow`**

W01a already made `insertScriptRow` cut v1 through `cutScriptVersion`. Promotion needs that SAME version row to carry the review evidence — cutting a second version would make the head `v2` with an empty `v1`. So widen W01a's `opts` rather than calling `cutScriptVersion` again:

```ts
// apps/api/src/services/scriptWrite.ts
export async function insertScriptRow(
  auth: Pick<AuthContext, 'scope' | 'user'>,
  scope: ScriptCreateScope,
  input: ScriptInsertInput,
  opts: {
    requestedIsSystem?: boolean;
    /** W03: written onto the scripts row AND onto the v1 version cut below.
     *  Default (undefined) keeps every existing caller at origin 'human'. */
    provenance?: ScriptVersionProvenance;
    /** W03 promotion: the approver who acknowledged the STRICT patterns. */
    securityAcknowledgedBy?: string | null;
  } = {}
) {
  // …unchanged clamping…
  // scripts row:
  //   origin: opts.provenance?.origin ?? 'human',
  //   originProposalId: opts.provenance?.proposalId ?? null,
  //   securityAcknowledgedBy: opts.securityAcknowledgedBy ?? auth.user.id,
  // then, in the same transaction W01a introduced:
  //   const version = await cutScriptVersion(tx, {
  //     scriptId: row.id,
  //     provenance: opts.provenance ?? { origin: 'human', createdBy: auth.user.id },
  //   });
  //   return { ...row, headVersionId: version.id };
}
```

- [ ] **Step 4: Write `promote.ts`**

```ts
// apps/api/src/services/scriptProposals/promote.ts
import { db } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import type { ScriptProposalPromoteInput } from '@breeze/shared';
import { insertScriptRow, resolveScriptCreateScope, isScriptScopeError } from '../scriptWrite';
import { transitionProposal } from './index';

/**
 * Spec §4.8. Promotion is the trust step that turns a one-off remediation into a
 * repeatable library script, so it is deliberately narrow:
 *  - only from `verified` (D5 + D12 — a run that was never proved is not evidence);
 *  - the caller's `scripts:write` + MFA are enforced by the ROUTE middleware, the
 *    same pair `POST /scripts` uses (routes/scripts.ts:626-631);
 *  - partner-wide ownership is gated by `resolveScriptCreateScope`, which already
 *    calls `canManagePartnerWidePolicies` (scriptWrite.ts:64-68). One gate, not two.
 */
export async function promoteProposalToLibrary(args: {
  auth: AuthContext;
  proposal: {
    id: string; orgId: string; status: string; content: string; contentDigest: string;
    language: 'powershell' | 'bash' | 'python' | 'cmd'; timeoutSeconds: number;
    runAs: 'system' | 'user' | 'elevated'; goal: string; acknowledgedPatterns: string[];
    decidedBy: string | null; decidedAt: Date | null;
  };
  review: { id: string; riskTier: string; summary: string; createdAt: Date } | null;
  input: ScriptProposalPromoteInput;
}): Promise<
  | { ok: true; scriptId: string; versionId: string }
  | { ok: false; status: 400 | 403 | 409; error: string }
> {
  const { auth, proposal, review, input } = args;

  if (proposal.status !== 'verified') {
    return { ok: false, status: 409, error: 'proposal_not_verified' };
  }

  const scope = resolveScriptCreateScope(
    { ...auth, partnerOrgAccess: auth.partnerOrgAccess },
    input.ownerScope === 'partner' ? 'partner' : 'org',
    proposal.orgId,
  );
  if (isScriptScopeError(scope)) {
    return { ok: false, status: scope.status as 400 | 403, error: scope.error };
  }

  const approver = proposal.decidedBy ?? auth.user.id;
  const approvedAt = proposal.decidedAt ?? new Date();

  return db.transaction(async (tx) => {
    const script = await insertScriptRow(
      auth,
      scope,
      {
        name: input.name,
        description: input.description ?? proposal.goal,
        osTypes: [],
        language: proposal.language,
        content: proposal.content,
        timeoutSeconds: proposal.timeoutSeconds,
        runAs: proposal.runAs,
        acknowledgedSecurityPatterns: proposal.acknowledgedPatterns,
      },
      {
        securityAcknowledgedBy: approver,
        provenance: {
          origin: 'ai_proposal',
          proposalId: proposal.id,
          reviewId: review?.id ?? null,
          reviewedAt: review?.createdAt ?? null,
          approvedBy: approver,
          approvedAt,
          // Supervised-vs-four_eyes is the intent's property; the proposal-side
          // record keeps the coarse value the version panel renders. W04 widens
          // this to 'unattended_reviewer_gated'.
          approvalMethod: 'four_eyes',
          changelog: `Promoted from AI proposal ${proposal.id}`,
          createdBy: auth.user.id,
        },
      },
    );

    await transitionProposal(tx, proposal.id, ['verified'], 'promoted', {
      promotedScriptId: script.id,
      promotedVersionId: script.headVersionId,
    });

    return { ok: true as const, scriptId: script.id, versionId: script.headVersionId };
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/promote.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/scriptProposals/promote.ts apps/api/src/services/scriptProposals/promote.test.ts apps/api/src/services/scriptWrite.ts
git commit -m "feat(api): promote a verified script proposal into the library with provenance"
```

---

## Task 8: `POST /:id/promote`

**Files:**
- Modify: `apps/api/src/routes/ai/scriptProposals.ts`
- Test: `apps/api/src/routes/ai/scriptProposals.promote.test.ts`

**Interfaces:**
- Consumes: `promoteProposalToLibrary` (Task 7), `requireMfa()` (`middleware/auth.ts:885`), `PERMISSIONS.SCRIPTS_WRITE`.
- Produces: `POST /api/v1/ai/script-proposals/:id/promote { name, description?, ownerScope }` → `201 { scriptId, versionId }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/routes/ai/scriptProposals.promote.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const promoteProposalToLibrary = vi.fn();
const loadScriptProposalDetail = vi.fn();
const loadProposalRow = vi.fn();
const loadLatestReview = vi.fn();
vi.mock('../../services/scriptProposals/promote', () => ({
  promoteProposalToLibrary: (...a: unknown[]) => promoteProposalToLibrary(...a),
}));
vi.mock('../../services/scriptProposals/detail', () => ({
  loadScriptProposalDetail: (...a: unknown[]) => loadScriptProposalDetail(...a),
}));
vi.mock('../../services/scriptProposals/queries', () => ({
  loadProposalRow: (...a: unknown[]) => loadProposalRow(...a),
  loadLatestReview: (...a: unknown[]) => loadLatestReview(...a),
  loadProposalExecutions: vi.fn(async () => []),
  loadProposalDevices: vi.fn(async () => []),
}));
vi.mock('../../config/env', async (o) => ({ ...(await o<never>()), aiScriptAuthoringEnabled: () => true }));

// authMiddleware stub identical to scriptProposals.test.ts, plus requirePermission
// and requireMfa left REAL so the permission/MFA matrix is genuinely exercised.
vi.mock('../../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/permissions')>();
  return { ...actual, getUserPermissions: vi.fn(async () => permissionsFixture) };
});

import { aiScriptProposalRoutes } from './scriptProposals';

const ID = '44444444-4444-4444-8444-444444444444';
const post = (body: unknown, headers: Record<string, string> = {}) =>
  aiScriptProposalRoutes.request(`/${ID}/promote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  loadScriptProposalDetail.mockResolvedValue({ ok: true, dto: { proposal: { id: ID }, viewer: { canPromote: true } } });
  loadProposalRow.mockResolvedValue({ id: ID, status: 'verified' });
  loadLatestReview.mockResolvedValue({ id: 'r1' });
  promoteProposalToLibrary.mockResolvedValue({ ok: true, scriptId: 's1', versionId: 'v1' });
});

describe('POST /:id/promote', () => {
  it('201s with the new script and version ids', async () => {
    const res = await post({ name: 'Restart spooler', ownerScope: 'organization' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ scriptId: 's1', versionId: 'v1' });
  });

  it('409s when the proposal is not verified', async () => {
    promoteProposalToLibrary.mockResolvedValue({ ok: false, status: 409, error: 'proposal_not_verified' });
    const res = await post({ name: 'X', ownerScope: 'organization' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'proposal_not_verified' });
  });

  it('403s without MFA', async () => {
    // token.mfa false in the auth stub for this case
    const res = await post({ name: 'X', ownerScope: 'organization' }, { 'x-test-mfa': 'false' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
  });

  it('400s an unknown ownerScope', async () => {
    expect((await post({ name: 'X', ownerScope: 'site' })).status).toBe(400);
    expect(promoteProposalToLibrary).not.toHaveBeenCalled();
  });

  it('403s a reader who cannot promote', async () => {
    loadScriptProposalDetail.mockResolvedValue({ ok: true, dto: { proposal: { id: ID }, viewer: { canPromote: false } } });
    expect((await post({ name: 'X', ownerScope: 'organization' })).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/routes/ai/scriptProposals.promote.test.ts`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Add the route**

```ts
// apps/api/src/routes/ai/scriptProposals.ts — appended
import { requireMfa, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { scriptProposalPromoteSchema } from '@breeze/shared';
import { promoteProposalToLibrary } from '../../services/scriptProposals/promote';
import { loadProposalRow, loadLatestReview } from '../../services/scriptProposals/queries';

aiScriptProposalRoutes.post(
  '/:id/promote',
  requireScope('organization', 'partner', 'system'),
  // Same pair POST /scripts requires (routes/scripts.ts:626-631): promotion IS
  // a library create, so it carries the library's own gate, not approvals:decide.
  requirePermission(PERMISSIONS.SCRIPTS_WRITE.resource, PERMISSIONS.SCRIPTS_WRITE.action),
  requireMfa(),
  zValidator('param', idParam),
  zValidator('json', scriptProposalPromoteSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');

    // The read gate first, so a caller with scripts:write in some OTHER org
    // cannot promote a proposal they may not read.
    const loaded = await loadScriptProposalDetail(auth, id);
    if (!loaded.ok) {
      return loaded.reason === 'not_found' ? c.json({ error: 'not_found' }, 404) : c.json({ error: 'forbidden' }, 403);
    }
    if (!loaded.dto.viewer.canPromote) return c.json({ error: 'forbidden' }, 403);

    const proposal = await loadProposalRow(id);
    if (!proposal) return c.json({ error: 'not_found' }, 404);
    const review = await loadLatestReview(id, proposal.orgId);

    const result = await promoteProposalToLibrary({ auth, proposal: proposal as never, review: review as never, input });
    if (!result.ok) return c.json({ error: result.error }, result.status);

    writeAuditEventAsync({
      action: 'script.proposal.promoted', orgId: proposal.orgId, actorUserId: auth.user.id,
      targetType: 'script_proposal', targetId: id,
      metadata: { scriptId: result.scriptId, versionId: result.versionId, ownerScope: input.ownerScope },
    });
    return c.json({ scriptId: result.scriptId, versionId: result.versionId }, 201);
  },
);
```

- [ ] **Step 4: Run the whole route suite**

Run: `cd apps/api && npx vitest run src/routes/ai/scriptProposals`
Expected: PASS — 3 files, 13 tests. Check the reported file count: the bare substring must pull in `scriptProposals.test.ts`, `.requestChanges.test.ts` and `.promote.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/ai/scriptProposals.ts apps/api/src/routes/ai/scriptProposals.promote.test.ts
git commit -m "feat(api): POST /ai/script-proposals/:id/promote (scripts:write + MFA, verified only)"
```

---

## Task 9: STRICT acknowledgement ceremony on the decide endpoint

**Files:**
- Modify: `apps/api/src/services/approvals/decideApprovalRequest.ts`
- Modify: `apps/api/src/routes/approvals.ts:714-763` (the approve adapter)
- Create: `apps/api/src/services/approvals/strictAcknowledgement.ts`
- Test: `apps/api/src/services/approvals/strictAcknowledgement.test.ts`
- Test: `apps/api/src/services/approvals/decideApprovalRequest.strictAck.test.ts`

**Interfaces:**
- Consumes: `unknownSecurityPatternDescriptions` (`scriptSecurityAcknowledgement.ts:77`), `hasSatisfiedMfa` (`middleware/auth.ts:915`), `userHasPermission`, `acknowledgedPatternsSchema` (Task 1), `loadProposalRow` (Task 3).
- Produces:
  ```ts
  export type StrictAckOutcome =
    | { ok: true; acknowledged: string[] }
    | { ok: false; error: 'strict_acknowledgement_not_permitted'; requirement: 'scripts:write' | 'mfa' }
    | { ok: false; error: 'strict_acknowledgement_incomplete'; missing: string[] };
  export async function resolveStrictAcknowledgement(args: {
    auth: AuthContext; proposal: { strictHits: string[]; orgId: string }; submitted: string[];
  }): Promise<StrictAckOutcome>;
  ```
  and `DecideApprovalInput.acknowledgedPatterns?: string[]`.

**Why this exists (spec §4.5 + §6).** The library's rule is `stored = requested ∩ matched` behind `scripts:write` + MFA (`scriptSecurityAcknowledgement.ts:14-35`, `routes/scripts.ts:626-631`). Supervised self-approve today re-checks only the *tool* permission (`decideApprovalRequest.ts:539-575`) — never `scripts:write`, never MFA — so approving a proposal with STRICT hits through that path would acknowledge a danger pattern under a weaker gate than editing the same script in the library. The fix is an additional check, not a replacement: a proposal with **no** strict hits is completely unaffected.

There is no "existing" acknowledgement set on a proposal, so the resolution is `(submitted ∩ strictHits)` and an approval that does not cover every strict hit is refused outright — an unacknowledged STRICT pattern would be blocked by the agent at run time anyway, and a silently-partial approval is a misleading UI.

- [ ] **Step 1: Write the failing unit test for the resolver**

```ts
// apps/api/src/services/approvals/strictAcknowledgement.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getUserPermissions = vi.fn();
const userHasPermission = vi.fn();
vi.mock('../permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../permissions')>()),
  getUserPermissions: (...a: unknown[]) => getUserPermissions(...a),
  userHasPermission: (...a: unknown[]) => userHasPermission(...a),
}));
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { resolveStrictAcknowledgement } from './strictAcknowledgement';

const STRICT = ['PowerShell HKLM write', 'Credential dump utility'];
const auth = (mfa: boolean) => ({
  user: { id: '22222222-2222-4222-8222-222222222222' }, scope: 'organization',
  orgId: '11111111-1111-4111-8111-111111111111', partnerId: null, token: { mfa },
}) as never;
const proposal = { strictHits: STRICT, orgId: '11111111-1111-4111-8111-111111111111' };

beforeEach(() => { vi.clearAllMocks(); getUserPermissions.mockResolvedValue({}); userHasPermission.mockReturnValue(true); });

describe('resolveStrictAcknowledgement', () => {
  it('is a no-op pass when the proposal has no strict hits', async () => {
    expect(await resolveStrictAcknowledgement({ auth: auth(false), proposal: { ...proposal, strictHits: [] }, submitted: [] }))
      .toEqual({ ok: true, acknowledged: [] });
    expect(userHasPermission).not.toHaveBeenCalled();
  });

  it('422s a decider without scripts:write', async () => {
    userHasPermission.mockReturnValue(false);
    expect(await resolveStrictAcknowledgement({ auth: auth(true), proposal, submitted: STRICT }))
      .toEqual({ ok: false, error: 'strict_acknowledgement_not_permitted', requirement: 'scripts:write' });
  });

  it('422s a decider without a fresh MFA claim', async () => {
    expect(await resolveStrictAcknowledgement({ auth: auth(false), proposal, submitted: STRICT }))
      .toEqual({ ok: false, error: 'strict_acknowledgement_not_permitted', requirement: 'mfa' });
  });

  it('intersects the submitted set with strict_hits and drops unmatched entries', async () => {
    const r = await resolveStrictAcknowledgement({
      auth: auth(true), proposal, submitted: [...STRICT, 'Something the content does not match'],
    });
    expect(r).toEqual({ ok: true, acknowledged: STRICT });
  });

  it('refuses a partial acknowledgement and names what is missing', async () => {
    expect(await resolveStrictAcknowledgement({ auth: auth(true), proposal, submitted: [STRICT[0]] }))
      .toEqual({ ok: false, error: 'strict_acknowledgement_incomplete', missing: [STRICT[1]] });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/approvals/strictAcknowledgement.test.ts`
Expected: FAIL — cannot resolve `./strictAcknowledgement`.

- [ ] **Step 3: Implement the resolver**

```ts
// apps/api/src/services/approvals/strictAcknowledgement.ts
import type { AuthContext } from '../../middleware/auth';
import { hasSatisfiedMfa } from '../../middleware/auth';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { getUserPermissions, userHasPermission, PERMISSIONS } from '../permissions';

export type StrictAckOutcome =
  | { ok: true; acknowledged: string[] }
  | { ok: false; error: 'strict_acknowledgement_not_permitted'; requirement: 'scripts:write' | 'mfa' }
  | { ok: false; error: 'strict_acknowledgement_incomplete'; missing: string[] };

/**
 * Spec §4.5. Acknowledging a STRICT danger pattern on an approval card carries the
 * LIBRARY's requirement — `scripts:write` + MFA — because acknowledging is the same
 * act as acknowledging on a saved script (scriptSecurityAcknowledgement.ts:14-35,
 * routes/scripts.ts:626-631). The supervised self-decide path re-checks only the
 * tool permission (decideApprovalRequest.ts:539-575), which is strictly weaker, so
 * this runs IN ADDITION to it, never instead of it.
 *
 * Resolution is `(submitted ∩ strictHits)`. There is no "existing" set on a
 * proposal (it is immutable and single-use), so the carry-forward half of the
 * library rule does not apply. An approval that leaves a strict hit unacknowledged
 * is refused rather than silently partial: the agent would refuse the run anyway,
 * and a card that said "Approved" would be lying.
 */
export async function resolveStrictAcknowledgement(args: {
  auth: AuthContext;
  proposal: { strictHits: string[]; orgId: string };
  submitted: string[];
}): Promise<StrictAckOutcome> {
  const strictHits = args.proposal.strictHits ?? [];
  if (strictHits.length === 0) return { ok: true, acknowledged: [] };

  if (!hasSatisfiedMfa(args.auth)) {
    return { ok: false, error: 'strict_acknowledgement_not_permitted', requirement: 'mfa' };
  }
  const perms = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      getUserPermissions(args.auth.user.id, {
        partnerId: args.auth.partnerId ?? undefined,
        orgId: args.proposal.orgId,
      }),
    ),
  );
  const canWrite =
    !!perms && userHasPermission(perms, PERMISSIONS.SCRIPTS_WRITE.resource, PERMISSIONS.SCRIPTS_WRITE.action);
  if (!canWrite) {
    return { ok: false, error: 'strict_acknowledgement_not_permitted', requirement: 'scripts:write' };
  }

  const submitted = new Set(args.submitted.map((s) => s.trim()).filter(Boolean));
  const acknowledged = strictHits.filter((hit) => submitted.has(hit));
  const missing = strictHits.filter((hit) => !submitted.has(hit));
  if (missing.length > 0) return { ok: false, error: 'strict_acknowledgement_incomplete', missing };
  return { ok: true, acknowledged };
}
```

- [ ] **Step 4: Write the failing decide-core test**

```ts
// apps/api/src/services/approvals/decideApprovalRequest.strictAck.test.ts
// Mocks: the existing decideApprovalRequest test harness in this directory plus
//   vi.mock('./strictAcknowledgement') and vi.mock('../scriptProposals/queries').
// Read decideApprovalRequest.test.ts first and REUSE its fixtures rather than
// building a second harness.
it('422s strict_acknowledgement_not_permitted and writes nothing', async () => {
  resolveStrictAcknowledgement.mockResolvedValue({
    ok: false, error: 'strict_acknowledgement_not_permitted', requirement: 'mfa',
  });
  const r = await decideApprovalRequest({ auth, id: APPROVAL_ID, status: 'approved', acknowledgedPatterns: [] });
  expect(r.httpStatus).toBe(422);
  expect(r.body).toEqual({ error: 'strict_acknowledgement_not_permitted', requirement: 'mfa' });
  expect(updateApprovalRequests).not.toHaveBeenCalled();
});

it('persists (submitted ∩ strict_hits) on the proposal before the CAS', async () => {
  resolveStrictAcknowledgement.mockResolvedValue({ ok: true, acknowledged: ['PowerShell HKLM write'] });
  await decideApprovalRequest({
    auth, id: APPROVAL_ID, status: 'approved',
    acknowledgedPatterns: ['PowerShell HKLM write', 'not matched'],
  });
  expect(updateScriptProposals).toHaveBeenCalledWith(
    expect.objectContaining({ acknowledgedPatterns: ['PowerShell HKLM write'] }),
  );
});

it('does not consult the acknowledgement resolver for a DENY', async () => {
  await decideApprovalRequest({ auth, id: APPROVAL_ID, status: 'denied', reason: 'no' });
  expect(resolveStrictAcknowledgement).not.toHaveBeenCalled();
});

it('leaves a non-proposal intent completely unaffected', async () => {
  loadProposalRow.mockResolvedValue(null);
  const r = await decideApprovalRequest({ auth, id: APPROVAL_ID, status: 'approved' });
  expect(r.httpStatus).toBe(200);
  expect(resolveStrictAcknowledgement).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Wire it into the decide core**

In `decideApprovalRequest.ts`, extend the input (`:286-296`):

```ts
export interface DecideApprovalInput {
  // …existing fields…
  /** W03 (spec §4.5): STRICT pattern descriptions the approver ticked on the
   *  script-proposal card. Only meaningful when the intent's proposal has
   *  strict_hits; ignored for every other approval. */
  acknowledgedPatterns?: string[];
}
```

and insert the gate **after** the supervised/four-eyes authority checks (`:575`) and **before** the assurance ladder (`:735`), so an unauthorised acknowledgement never costs a WebAuthn ceremony:

```ts
  // ── W03: STRICT acknowledgement ceremony ────────────────────────────────
  // Only on APPROVE, only for an intent whose run_script arguments name a
  // proposal. Everything else short-circuits before any extra DB read.
  let acknowledgedPatterns: string[] = [];
  if (status === 'approved' && linkedIntent?.actionName === 'run_script') {
    const proposalId = (linkedIntent.arguments as { proposalId?: unknown }).proposalId;
    if (typeof proposalId === 'string') {
      const proposal = await loadProposalRow(proposalId);
      if (proposal && (proposal.strictHits?.length ?? 0) > 0) {
        const resolved = await resolveStrictAcknowledgement({
          auth: input.auth,
          proposal,
          submitted: input.acknowledgedPatterns ?? [],
        });
        if (!resolved.ok) {
          recordActionIntentEvent({
            intentId: linkedIntent.id, outcome: 'approver_unauthorized',
            details: { approvalId: existing.id, errorCode: resolved.error },
          });
          return { httpStatus: 422, body: { ...resolved, ok: undefined } as Record<string, unknown> };
        }
        acknowledgedPatterns = resolved.acknowledged;
      }
    }
  }
```

Then, inside the transaction that already CASes the approval row (`:854-878`), before the CAS:

```ts
        if (acknowledgedPatterns.length > 0) {
          // Persisted on the PROPOSAL, not on the approval row: dispatch reads the
          // proposal (ScriptDispatchSource { kind: 'proposal' }) and the release
          // worker projects only (id, status, bound_argument_digest) off the
          // approval (intentReleaseWorker.ts:817-828). Same transaction as the CAS
          // so a lost decision race cannot leave an acknowledgement behind.
          await tx
            .update(scriptProposals)
            .set({ acknowledgedPatterns })
            .where(eq(scriptProposals.id, proposalIdForDecision!));
        }
```

- [ ] **Step 6: Pass it through the route adapter**

In `apps/api/src/routes/approvals.ts`, inside the existing `POST /:id/approve` handler (it already parses `raw` at `:719`), after the reauth block and before the `decideApprovalRequest` call at `:757`:

```ts
  // W03: the card submits the STRICT patterns the approver ticked. Shape-checked
  // here so a malformed array is a 400 rather than a silently-dropped
  // acknowledgement the approver believes they granted (same reasoning as
  // unknownSecurityPatternDescriptions in scriptSecurityAcknowledgement.ts:66-76).
  let acknowledgedPatterns: string[] | undefined;
  if (raw && raw.acknowledgedPatterns !== undefined) {
    const parsed = acknowledgedPatternsSchema.safeParse(raw.acknowledgedPatterns);
    if (!parsed.success) return c.json({ error: 'Invalid acknowledgedPatterns' }, 400);
    acknowledgedPatterns = parsed.data;
  }

  return respond(
    c,
    await decideApprovalRequest({
      auth: c.get('auth'),
      id: c.req.param('id'),
      status: 'approved',
      proof,
      reauthVerified,
      acknowledgedPatterns,
    }),
  );
```

This covers **both** mounts — `/api/v1/approvals` and `/api/v1/mobile/approvals` are the same `approvalRoutes` instance (`index.ts:906` and the transport-neutral alias below it).

- [ ] **Step 7: Run the tests**

Run: `cd apps/api && npx vitest run src/services/approvals/strictAcknowledgement.test.ts src/services/approvals/decideApprovalRequest.strictAck.test.ts src/services/approvals/decideApprovalRequest.test.ts src/routes/approvals.test.ts`
Expected: PASS — new tests green, the existing decide and approvals route suites unchanged.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/approvals/strictAcknowledgement.ts apps/api/src/services/approvals/strictAcknowledgement.test.ts apps/api/src/services/approvals/decideApprovalRequest.ts apps/api/src/services/approvals/decideApprovalRequest.strictAck.test.ts apps/api/src/routes/approvals.ts
git commit -m "feat(api): STRICT acknowledgement ceremony on approval decide (422 typed refusal)"
```

---

## Task 10: Four-eyes fan-out filtered to `scripts:write`

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentApprovers.ts:63-65`
- Modify: `apps/api/src/services/actionIntents/intentService.ts` (the fan-out call site)
- Test: `apps/api/src/services/actionIntents/intentApprovers.scriptProposal.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function resolveIntentApprovers(
    orgId: string,
    opts?: { alsoRequire?: PermissionPair },
  ): Promise<string[]>;
  ```

**Why (spec §4.5 last sentence, §6 "Approver lacks scripts:write + MFA for STRICT hits"):** if a proposal has strict hits, an approver without `scripts:write` will hit the 422 from Task 9. Fanning the request out to them produces a queue of approvals nobody in the list can action. Filter at fan-out; keep the 422 as the authoritative gate (an approver can lose the permission between fan-out and decide).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/actionIntents/intentApprovers.scriptProposal.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const resolveUsersWithPermissionForOrg = vi.fn();
vi.mock('../usersWithPermission', () => ({
  resolveUsersWithPermissionForOrg: (...a: unknown[]) => resolveUsersWithPermissionForOrg(...a),
}));

import { resolveIntentApprovers } from './intentApprovers';
import { PERMISSIONS } from '../permissions';

const ORG = '11111111-1111-4111-8111-111111111111';
beforeEach(() => vi.clearAllMocks());

describe('resolveIntentApprovers', () => {
  it('returns every approvals:decide holder when no extra permission is required', async () => {
    resolveUsersWithPermissionForOrg.mockResolvedValue(['u1', 'u2']);
    expect(await resolveIntentApprovers(ORG)).toEqual(['u1', 'u2']);
    expect(resolveUsersWithPermissionForOrg).toHaveBeenCalledTimes(1);
  });

  it('intersects with the extra permission holders when one is required', async () => {
    resolveUsersWithPermissionForOrg
      .mockResolvedValueOnce(['u1', 'u2', 'u3'])
      .mockResolvedValueOnce(['u2', 'u9']);
    expect(await resolveIntentApprovers(ORG, { alsoRequire: PERMISSIONS.SCRIPTS_WRITE })).toEqual(['u2']);
  });

  it('returns an empty list (never a widened one) when nobody holds both', async () => {
    resolveUsersWithPermissionForOrg.mockResolvedValueOnce(['u1']).mockResolvedValueOnce(['u9']);
    expect(await resolveIntentApprovers(ORG, { alsoRequire: PERMISSIONS.SCRIPTS_WRITE })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/actionIntents/intentApprovers.scriptProposal.test.ts`
Expected: FAIL — `resolveIntentApprovers` takes one argument.

- [ ] **Step 3: Widen the resolver**

```ts
// apps/api/src/services/actionIntents/intentApprovers.ts:63
/**
 * Four-eyes candidate set for an org.
 *
 * `alsoRequire` (W03, spec §4.5): when the intent carries a script proposal with
 * STRICT hits, only an approver who ALSO holds `scripts:write` can complete the
 * acknowledgement ceremony — everyone else gets a 422 from the decide core. Fan
 * out to the intersection so the queue does not fill with rows nobody can action.
 * Returning an EMPTY list is correct here: createActionIntent already fails with
 * no_eligible_approvers, which is a truthful refusal, not a reason to widen.
 */
export async function resolveIntentApprovers(
  orgId: string,
  opts?: { alsoRequire?: PermissionPair },
): Promise<string[]> {
  const deciders = await resolveUsersWithPermissionForOrg(orgId, PERMISSIONS.APPROVALS_DECIDE);
  if (!opts?.alsoRequire || deciders.length === 0) return deciders;
  const also = new Set(await resolveUsersWithPermissionForOrg(orgId, opts.alsoRequire));
  return deciders.filter((userId) => also.has(userId));
}
```

- [ ] **Step 4: Pass the filter at the fan-out call site**

In `intentService.ts`, where `resolveIntentApprovers(orgId)` is called for a four-eyes intent, supply the extra requirement when the run_script arguments name a proposal that has strict hits. Load the proposal once and reuse the row (do not re-query):

```ts
      const proposalForFanout =
        input.tool === 'run_script' && typeof input.arguments.proposalId === 'string'
          ? await loadProposalRow(input.arguments.proposalId)
          : null;
      const approverIds = await resolveIntentApprovers(orgId, {
        alsoRequire:
          (proposalForFanout?.strictHits?.length ?? 0) > 0 ? PERMISSIONS.SCRIPTS_WRITE : undefined,
      });
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && npx vitest run src/services/actionIntents/intentApprovers src/services/actionIntents/intentService`
Expected: PASS — the new file plus every existing `intentApprovers*`/`intentService*` suite. Check the reported file count; the substring pulls in the siblings deliberately.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/actionIntents/intentApprovers.ts apps/api/src/services/actionIntents/intentApprovers.scriptProposal.test.ts apps/api/src/services/actionIntents/intentService.ts
git commit -m "feat(api): filter four-eyes fan-out to scripts:write holders for STRICT proposals"
```

---

## Task 11: Acknowledgements ride the proposal dispatch payload

**Files:**
- Modify: `apps/api/src/services/scriptDispatch.ts:320-322`
- Test: `apps/api/src/services/scriptDispatch.proposalAck.test.ts`

**Interfaces:**
- Consumes: `ScriptDispatchSource` `{ kind: 'proposal'; proposal; snapshot }` (roadmap §3.3).

**The one-line rule:** a library script's acknowledgements come off `source.script.acknowledgedSecurityPatterns` (`:321-322`); a proposal's come off `source.proposal.acknowledgedPatterns`. The wire field is the same `acknowledgedSecurityPatterns` the Go agent already reads (`:598`), so the agent is unchanged — a hard requirement of spec §2.3.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/scriptDispatch.proposalAck.test.ts
// Reuse the queueCommand/encrypt mocks from the existing scriptDispatch tests.
it('sends the proposal acknowledgements as acknowledgedSecurityPatterns', async () => {
  await dispatchScriptToDevice({
    device, source: { kind: 'proposal', proposal: { ...proposalRow, acknowledgedPatterns: ['PowerShell HKLM write'] }, snapshot },
    runAs: 'system',
  });
  expect(queueCommand).toHaveBeenCalledWith(
    device.id, 'script',
    expect.objectContaining({ acknowledgedSecurityPatterns: ['PowerShell HKLM write'] }),
    expect.anything(),
  );
});

it('omits the key entirely when the proposal acknowledged nothing (agent fail-closed)', async () => {
  await dispatchScriptToDevice({
    device, source: { kind: 'proposal', proposal: { ...proposalRow, acknowledgedPatterns: [] }, snapshot },
    runAs: 'system',
  });
  const payload = queueCommand.mock.calls[0][2] as Record<string, unknown>;
  expect('acknowledgedSecurityPatterns' in payload).toBe(false);
});

it('leaves the saved-script path byte-identical', async () => {
  await dispatchScriptToDevice({ device, source: { kind: 'saved', script }, runAs: 'system' });
  const payload = queueCommand.mock.calls[0][2] as Record<string, unknown>;
  expect(payload.acknowledgedSecurityPatterns).toEqual(script.acknowledgedSecurityPatterns);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/scriptDispatch.proposalAck.test.ts`
Expected: FAIL — the proposal branch yields `[]` and the key is omitted.

- [ ] **Step 3: Extend the acknowledgement resolution**

```ts
// apps/api/src/services/scriptDispatch.ts:320-322 — replaced
  // A `raw` source has no script record and therefore no acknowledgement, so
  // ad-hoc content keeps the pre-#5129 behaviour exactly: any Strict match is
  // refused on the device.
  //
  // W03: a `proposal` source carries the set the APPROVER ticked on the card,
  // resolved server-side as (submitted ∩ strict_hits) at decide time
  // (services/approvals/strictAcknowledgement.ts). Same wire field, so the Go
  // agent is unchanged.
  const acknowledgedSecurityPatterns =
    source.kind === 'saved' ? (source.script.acknowledgedSecurityPatterns ?? [])
    : source.kind === 'proposal' ? (source.proposal.acknowledgedPatterns ?? [])
    : [];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/scriptDispatch`
Expected: PASS — new file plus every existing `scriptDispatch*` suite.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/scriptDispatch.ts apps/api/src/services/scriptDispatch.proposalAck.test.ts
git commit -m "feat(api): carry proposal STRICT acknowledgements into the dispatch payload"
```

---

## Task 12: Proposal moves to `executed` at dispatch

**Files:**
- Modify: `apps/api/src/services/aiToolsScripts.ts` (after the `dispatch.ok` check, ~`:517`)
- Test: `apps/api/src/services/aiToolsScripts.proposalExecuted.test.ts`

**Interfaces:**
- Consumes: `transitionProposal` (§3.3).

**Why here:** the `run_script` handler is the single place both transports converge — chat through the SDK and agents through the release worker's `executeTool(intent.actionName, …)` (`intentReleaseWorker.ts:1132-1139`). Marking `executed` in the dispatcher would also mark library runs; marking it in the release worker would miss nothing but would duplicate the branch. The status is what gates verification (Task 15) and promotion (Task 7).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiToolsScripts.proposalExecuted.test.ts
it('moves a proposal-backed run to executed once the dispatch is accepted', async () => {
  dispatchScriptToDevice.mockResolvedValue({ ok: true, commandId: 'c1', executionId: 'e1', runAs: 'system' });
  await runScriptTool({ proposalId: PROPOSAL, deviceIds: [DEVICE] }, auth);
  expect(transitionProposal).toHaveBeenCalledWith(
    expect.anything(), PROPOSAL, ['reviewed', 'approved'], 'executed', expect.objectContaining({}),
  );
});

it('does NOT move the proposal when the dispatch was suppressed', async () => {
  dispatchScriptToDevice.mockResolvedValue({ ok: false, reason: 'maintenance_suppressed' });
  await runScriptTool({ proposalId: PROPOSAL, deviceIds: [DEVICE] }, auth);
  expect(transitionProposal).not.toHaveBeenCalled();
});

it('never transitions for a library run', async () => {
  await runScriptTool({ scriptId: SCRIPT, deviceIds: [DEVICE] }, auth);
  expect(transitionProposal).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiToolsScripts.proposalExecuted.test.ts`
Expected: FAIL — `transitionProposal` never called.

- [ ] **Step 3: Add the transition**

Immediately after the `if (!dispatch.ok) { … }` block in the proposal branch:

```ts
          // W03: the proposal has now produced a real execution. `executed` is the
          // precondition for verification (§4.9) and, through `verified`, for
          // promotion (§4.8). CAS from reviewed|approved so a retried dispatch or a
          // second device in the same call cannot rewind a later status.
          await runOutsideDbContext(() =>
            withSystemDbAccessContext(() =>
              db.transaction((tx) =>
                transitionProposal(tx, proposal.id, ['reviewed', 'approved'], 'executed', {
                  executedAt: new Date(),
                }),
              ),
            ),
          );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiToolsScripts`
Expected: PASS — new file plus the existing `aiToolsScripts*` suites.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsScripts.ts apps/api/src/services/aiToolsScripts.proposalExecuted.test.ts
git commit -m "feat(api): mark a script proposal executed when its run is dispatched"
```

---

## Task 13: `evaluateVerificationClaim`

**Files:**
- Create: `apps/api/src/services/scriptProposals/verify.ts`
- Test: `apps/api/src/services/scriptProposals/verify.test.ts`

**Interfaces:**
- Consumes: `scriptVerificationClaimSchema` (§3.1), `verifyServiceRunningForTask` and `verifyProcessAbsent` (`services/aiAgents/actVerify.ts:132-146`, `:200`), `executeCommandWithSystemPrecheck` (via `getCommandQueue()`).
- Produces:
  ```ts
  export type VerificationOutcome = 'verified' | 'verification_failed' | 'unknown';
  export async function evaluateVerificationClaim(
    claim: unknown,
    execution: { status: string; exitCode: number | null; stdout: string | null; stderr: string | null },
    device: { deviceId: string; orgId: string },
    actorUserId: string,
  ): Promise<{ outcome: VerificationOutcome; evidence: Record<string, unknown> }>;
  ```

**The operator rule is load-bearing** (`aiOperator/verification.ts:5-12`): *a dispatch result is never evidence of recovery*. So `service_running`, `process_absent` and `file_exists` are INDEPENDENT device reads, not inferences from the script's own exit code. `exit_code` and `output_matches` are execution evidence only — the reviewer is the one who must mark `verificationAdequate = false` when they are the sole claim for a service/disk/application goal (§4.4 floor), and this function does not re-litigate that.

`unknown` is not a failure: a device that went offline has told us nothing, and the retry ladder in Task 14 is what turns a persistent nothing into a final `unknown`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/scriptProposals/verify.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const verifyServiceRunningForTask = vi.fn();
const verifyProcessAbsentForTask = vi.fn();
vi.mock('../aiAgents/actVerify', () => ({
  verifyServiceRunningForTask: (...a: unknown[]) => verifyServiceRunningForTask(...a),
  verifyProcessAbsentForTask: (...a: unknown[]) => verifyProcessAbsentForTask(...a),
}));
const executeCommandWithSystemPrecheck = vi.fn();
vi.mock('../commandQueue', () => ({
  getCommandQueue: async () => ({ executeCommandWithSystemPrecheck }),
}));

import { evaluateVerificationClaim } from './verify';

const device = { deviceId: 'd1', orgId: 'o1' };
const ok = { status: 'completed', exitCode: 0, stdout: 'Spooler started', stderr: null };
beforeEach(() => vi.clearAllMocks());

describe('exit_code', () => {
  it('verifies on an equal exit code', async () => {
    expect((await evaluateVerificationClaim({ kind: 'exit_code', equals: 0 }, ok, device, 'u1')).outcome)
      .toBe('verified');
  });
  it('fails on a different exit code', async () => {
    const r = await evaluateVerificationClaim({ kind: 'exit_code', equals: 0 }, { ...ok, exitCode: 3 }, device, 'u1');
    expect(r.outcome).toBe('verification_failed');
    expect(r.evidence).toMatchObject({ exitCode: 3, expected: 0 });
  });
  it('is unknown when the execution never reached a terminal state with an exit code', async () => {
    expect((await evaluateVerificationClaim({ kind: 'exit_code', equals: 0 }, { ...ok, status: 'timeout', exitCode: null }, device, 'u1')).outcome)
      .toBe('unknown');
  });
});

describe('output_matches', () => {
  it('verifies when the regex matches stdout', async () => {
    expect((await evaluateVerificationClaim({ kind: 'output_matches', regex: 'Spooler started' }, ok, device, 'u1')).outcome)
      .toBe('verified');
  });
  it('fails when it does not match', async () => {
    expect((await evaluateVerificationClaim({ kind: 'output_matches', regex: '^never$' }, ok, device, 'u1')).outcome)
      .toBe('verification_failed');
  });
  it('is unknown — never a crash — on an invalid regex', async () => {
    const r = await evaluateVerificationClaim({ kind: 'output_matches', regex: '([' }, ok, device, 'u1');
    expect(r.outcome).toBe('unknown');
    expect(r.evidence).toMatchObject({ reason: 'invalid_regex' });
  });
});

describe('service_running', () => {
  it('uses an INDEPENDENT list_services read, not the execution result', async () => {
    verifyServiceRunningForTask.mockResolvedValue({ verification: 'passed' });
    const r = await evaluateVerificationClaim({ kind: 'service_running', name: 'spooler' }, ok, device, 'u1');
    expect(verifyServiceRunningForTask).toHaveBeenCalledWith({ serviceName: 'spooler' }, device, 'u1');
    expect(r.outcome).toBe('verified');
  });
  it('maps inconclusive to unknown, not to failed', async () => {
    verifyServiceRunningForTask.mockResolvedValue({ verification: 'inconclusive', detail: 'device offline' });
    expect((await evaluateVerificationClaim({ kind: 'service_running', name: 'spooler' }, ok, device, 'u1')).outcome)
      .toBe('unknown');
  });
  it('fails on a genuine read-back of a stopped service', async () => {
    verifyServiceRunningForTask.mockResolvedValue({ verification: 'failed', detail: 'service status is "Stopped"' });
    expect((await evaluateVerificationClaim({ kind: 'service_running', name: 'spooler' }, ok, device, 'u1')).outcome)
      .toBe('verification_failed');
  });
  it('does not consult the execution exit code at all', async () => {
    verifyServiceRunningForTask.mockResolvedValue({ verification: 'passed' });
    const r = await evaluateVerificationClaim({ kind: 'service_running', name: 'spooler' }, { ...ok, exitCode: 1 }, device, 'u1');
    expect(r.outcome).toBe('verified');
  });
});

describe('process_absent', () => {
  it('verifies when the independent process list has no match', async () => {
    verifyProcessAbsentForTask.mockResolvedValue({ verification: 'passed' });
    expect((await evaluateVerificationClaim({ kind: 'process_absent', name: 'evil.exe' }, ok, device, 'u1')).outcome)
      .toBe('verified');
  });
});

describe('file_exists', () => {
  it('verifies from an independent file_list read', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ files: [{ path: 'C:/temp/marker' }] }) });
    const r = await evaluateVerificationClaim({ kind: 'file_exists', path: 'C:/temp/marker' }, ok, device, 'u1');
    expect(executeCommandWithSystemPrecheck).toHaveBeenCalledWith('d1', 'file_list', expect.anything(), expect.objectContaining({ expectedOrgId: 'o1' }));
    expect(r.outcome).toBe('verified');
  });
  it('is unknown when the read did not complete', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({ status: 'timeout' });
    expect((await evaluateVerificationClaim({ kind: 'file_exists', path: 'C:/temp/marker' }, ok, device, 'u1')).outcome)
      .toBe('unknown');
  });
  it('fails when the read completed and the file is not there', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ files: [] }) });
    expect((await evaluateVerificationClaim({ kind: 'file_exists', path: 'C:/temp/marker' }, ok, device, 'u1')).outcome)
      .toBe('verification_failed');
  });
});

describe('malformed claim', () => {
  it('is unknown, never verified', async () => {
    expect((await evaluateVerificationClaim({ kind: 'nonsense' }, ok, device, 'u1')).outcome).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/verify.test.ts`
Expected: FAIL — cannot resolve `./verify`.

- [ ] **Step 3: Implement it**

```ts
// apps/api/src/services/scriptProposals/verify.ts
import { scriptVerificationClaimSchema } from '@breeze/shared';
import { verifyServiceRunningForTask, verifyProcessAbsentForTask } from '../aiAgents/actVerify';
import { getCommandQueue } from '../commandQueue';

export type VerificationOutcome = 'verified' | 'verification_failed' | 'unknown';
export const SCRIPT_VERIFY_QUEUE = 'script-verify';
export const SCRIPT_VERIFY_MAX_ATTEMPTS = 3;
/** 3 attempts over 20 minutes (spec §4.9): t=0, t=10m, t=20m. */
export const SCRIPT_VERIFY_RETRY_DELAY_MS = 10 * 60 * 1000;
const VERIFY_READ_TIMEOUT_MS = 30_000;

export interface ScriptVerifyJobData {
  proposalId: string;
  executionId: string;
  attempt: number;
}

/**
 * Spec §4.9. Evaluate a proposal's verification claim AFTER its execution reached a
 * terminal state.
 *
 * The operator rule (aiOperator/verification.ts:5-12) is the whole design: a
 * dispatch result is never evidence of recovery. `service_running`,
 * `process_absent` and `file_exists` are therefore INDEPENDENT device reads that
 * ignore the execution entirely; only `exit_code` and `output_matches` read the
 * execution, and the reviewer's `verificationAdequate = false` floor is what stops
 * them being used as the sole claim for a service/disk/application goal.
 *
 * `unknown` ≠ failed. A device that is offline has told us nothing; the worker's
 * retry ladder is what turns a persistent nothing into a final `unknown`.
 */
export async function evaluateVerificationClaim(
  claim: unknown,
  execution: { status: string; exitCode: number | null; stdout: string | null; stderr: string | null },
  device: { deviceId: string; orgId: string },
  actorUserId: string,
): Promise<{ outcome: VerificationOutcome; evidence: Record<string, unknown> }> {
  const parsed = scriptVerificationClaimSchema.safeParse(claim);
  if (!parsed.success) {
    return { outcome: 'unknown', evidence: { reason: 'claim_not_parseable' } };
  }
  const c = parsed.data;

  switch (c.kind) {
    case 'exit_code': {
      if (execution.exitCode === null || execution.status !== 'completed') {
        return { outcome: 'unknown', evidence: { reason: 'execution_not_terminal', status: execution.status } };
      }
      return execution.exitCode === c.equals
        ? { outcome: 'verified', evidence: { exitCode: execution.exitCode } }
        : { outcome: 'verification_failed', evidence: { exitCode: execution.exitCode, expected: c.equals } };
    }

    case 'output_matches': {
      let re: RegExp;
      try {
        re = new RegExp(c.regex);
      } catch {
        // A bad regex is the AUTHOR's mistake, not the device's. Unknown, so the
        // run is never claimed as proven on the strength of a pattern that cannot
        // be evaluated.
        return { outcome: 'unknown', evidence: { reason: 'invalid_regex', regex: c.regex } };
      }
      const haystack = `${execution.stdout ?? ''}\n${execution.stderr ?? ''}`;
      return re.test(haystack)
        ? { outcome: 'verified', evidence: { matched: true } }
        : { outcome: 'verification_failed', evidence: { matched: false, regex: c.regex } };
    }

    case 'service_running': {
      const { verification, detail } = await verifyServiceRunningForTask({ serviceName: c.name }, device, actorUserId);
      return {
        outcome: verification === 'passed' ? 'verified' : verification === 'failed' ? 'verification_failed' : 'unknown',
        evidence: { independentRead: 'list_services', service: c.name, verification, detail: detail ?? null },
      };
    }

    case 'process_absent': {
      const { verification, detail } = await verifyProcessAbsentForTask({ processName: c.name }, device, actorUserId);
      return {
        outcome: verification === 'passed' ? 'verified' : verification === 'failed' ? 'verification_failed' : 'unknown',
        evidence: { independentRead: 'list_processes', process: c.name, verification, detail: detail ?? null },
      };
    }

    case 'file_exists': {
      const { executeCommandWithSystemPrecheck } = await getCommandQueue();
      const result = await executeCommandWithSystemPrecheck(
        device.deviceId,
        'file_list',
        { path: c.path },
        { userId: actorUserId, timeoutMs: VERIFY_READ_TIMEOUT_MS, expectedOrgId: device.orgId },
      );
      if (result.status !== 'completed') {
        return { outcome: 'unknown', evidence: { independentRead: 'file_list', reason: `read_${result.status}` } };
      }
      let files: Array<{ path?: string }> = [];
      try {
        files = (JSON.parse(result.stdout ?? '{}') as { files?: Array<{ path?: string }> }).files ?? [];
      } catch {
        return { outcome: 'unknown', evidence: { independentRead: 'file_list', reason: 'read_not_parseable' } };
      }
      const found = files.some((f) => (f.path ?? '').replace(/\\/g, '/').endsWith(c.path.replace(/\\/g, '/')));
      return {
        outcome: found ? 'verified' : 'verification_failed',
        evidence: { independentRead: 'file_list', path: c.path, found },
      };
    }
  }
}
```

If `verifyProcessAbsentForTask` does not exist yet, add it beside `verifyServiceRunningForTask` in `actVerify.ts` as the same thin adapter over the existing private `verifyProcessAbsent` (`actVerify.ts:200`) — one exported function, no new read logic.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/verify.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/scriptProposals/verify.ts apps/api/src/services/scriptProposals/verify.test.ts apps/api/src/services/aiAgents/actVerify.ts
git commit -m "feat(api): evaluateVerificationClaim with independent device reads"
```

---

## Task 14: `script-verify` worker, retry ladder, transitions and the W04 hook

**Files:**
- Modify: `apps/api/src/services/scriptProposals/verify.ts` (hook registry + `enqueueScriptVerify`)
- Create: `apps/api/src/jobs/scriptVerifyWorker.ts`
- Modify: `apps/api/src/services/workerRegistry.ts`
- Test: `apps/api/src/jobs/scriptVerifyWorker.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // verify.ts
  export type UnattendedVerificationHandler =
    (proposal: { id: string; orgId: string }, outcome: VerificationOutcome) => Promise<void>;
  export function registerUnattendedVerificationOutcomeHandler(h: UnattendedVerificationHandler | null): void;
  export async function onUnattendedVerificationOutcome(
    proposal: { id: string; orgId: string; decidedVia?: string | null }, outcome: VerificationOutcome,
  ): Promise<void>;
  export async function enqueueScriptVerify(data: ScriptVerifyJobData, delayMs?: number): Promise<void>;
  // scriptVerifyWorker.ts
  export async function runScriptVerifyJob(data: ScriptVerifyJobData): Promise<VerificationOutcome | 'retry'>;
  export function createScriptVerifyWorker(): Worker;
  export async function initializeScriptVerifyWorker(): Promise<void>;
  export async function shutdownScriptVerifyWorker(): Promise<void>;
  ```

**Placement is `socket-owner`, not `global`.** The worker's closure reaches `executeCommandWithSystemPrecheck` → `services/agentCommandAwait.ts` / `routes/agentWs.ts`, exactly like `alertVerdictScheduler` (`workerRegistry.ts:1174-1186`). `workerEntrypointClosure.contract.test.ts` is the mechanical authority — run it, do not guess.

- [ ] **Step 1: Write the failing worker test**

```ts
// apps/api/src/jobs/scriptVerifyWorker.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('bullmq', () => ({
  // Function expressions so `new Queue()` / `new Worker()` are constructible.
  Queue: function Queue() { return { add: addJob, close: vi.fn() }; },
  Worker: function Worker() { return { on: vi.fn(), close: vi.fn() }; },
}));
const addJob = vi.fn();
const evaluateVerificationClaim = vi.fn();
const transitionProposal = vi.fn();
const postProposalOutcomeToAuthor = vi.fn();
const onUnattendedVerificationOutcome = vi.fn();
// …plus the queries/db mocks, matching the style of aiUnattendedExposureRetention.test.ts…

import { runScriptVerifyJob } from './scriptVerifyWorker';

const JOB = { proposalId: 'p1', executionId: 'e1', attempt: 1 };
beforeEach(() => { vi.clearAllMocks(); transitionProposal.mockResolvedValue(true); });

describe('runScriptVerifyJob', () => {
  it('transitions executed → verified and tells the author', async () => {
    evaluateVerificationClaim.mockResolvedValue({ outcome: 'verified', evidence: { exitCode: 0 } });
    expect(await runScriptVerifyJob(JOB)).toBe('verified');
    expect(transitionProposal).toHaveBeenCalledWith(
      expect.anything(), 'p1', ['executed'], 'verified',
      expect.objectContaining({ verifiedAt: expect.any(Date) }),
    );
    expect(postProposalOutcomeToAuthor).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'verified' }));
  });

  it('transitions executed → verification_failed on a genuine failure', async () => {
    evaluateVerificationClaim.mockResolvedValue({ outcome: 'verification_failed', evidence: {} });
    expect(await runScriptVerifyJob(JOB)).toBe('verification_failed');
    expect(transitionProposal).toHaveBeenCalledWith(
      expect.anything(), 'p1', ['executed'], 'verification_failed', expect.anything(),
    );
  });

  it('re-enqueues with a 10-minute delay on unknown while attempts remain', async () => {
    evaluateVerificationClaim.mockResolvedValue({ outcome: 'unknown', evidence: { reason: 'read_timeout' } });
    expect(await runScriptVerifyJob({ ...JOB, attempt: 1 })).toBe('retry');
    expect(addJob).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ attempt: 2 }), expect.objectContaining({ delay: 600000 }),
    );
    expect(transitionProposal).not.toHaveBeenCalled();
  });

  it('finalises as unknown on the third attempt and does NOT leave the proposal in executed limbo', async () => {
    evaluateVerificationClaim.mockResolvedValue({ outcome: 'unknown', evidence: {} });
    expect(await runScriptVerifyJob({ ...JOB, attempt: 3 })).toBe('unknown');
    expect(addJob).not.toHaveBeenCalled();
    expect(transitionProposal).toHaveBeenCalledWith(
      expect.anything(), 'p1', ['executed'], 'verification_failed',
      expect.objectContaining({ verificationResult: expect.objectContaining({ outcome: 'unknown', attempts: 3 }) }),
    );
    expect(postProposalOutcomeToAuthor).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ kind: 'verification_unknown' }),
    );
  });

  it('calls the unattended hook for every terminal outcome', async () => {
    evaluateVerificationClaim.mockResolvedValue({ outcome: 'verified', evidence: {} });
    await runScriptVerifyJob(JOB);
    expect(onUnattendedVerificationOutcome).toHaveBeenCalledWith(expect.anything(), 'verified');
  });

  it('is idempotent: a proposal already past executed is a no-op success', async () => {
    transitionProposal.mockResolvedValue(false);
    evaluateVerificationClaim.mockResolvedValue({ outcome: 'verified', evidence: {} });
    await expect(runScriptVerifyJob(JOB)).resolves.toBe('verified');
    expect(postProposalOutcomeToAuthor).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/jobs/scriptVerifyWorker.test.ts`
Expected: FAIL — cannot resolve `./scriptVerifyWorker`.

- [ ] **Step 3: Add the queue accessor and the hook registry to `verify.ts`**

```ts
// apps/api/src/services/scriptProposals/verify.ts — appended
import { Queue } from 'bullmq';
import { getBullMQConnection } from '../redis';

let verifyQueue: Queue | null = null;
export function getScriptVerifyQueue(): Queue {
  if (!verifyQueue) verifyQueue = new Queue(SCRIPT_VERIFY_QUEUE, { connection: getBullMQConnection() });
  return verifyQueue;
}

export async function enqueueScriptVerify(data: ScriptVerifyJobData, delayMs = 0): Promise<void> {
  await getScriptVerifyQueue().add(SCRIPT_VERIFY_QUEUE, data, {
    // Deterministic id per (proposal, execution, attempt): a duplicate enqueue from
    // the result-ingest retry path is a no-op rather than a second device read.
    jobId: `script-verify:${data.proposalId}:${data.executionId}:${data.attempt}`,
    delay: delayMs,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  });
}

export type UnattendedVerificationHandler = (
  proposal: { id: string; orgId: string },
  outcome: VerificationOutcome,
) => Promise<void>;

let unattendedHandler: UnattendedVerificationHandler | null = null;

/** W04 registers the lane-state updater here at boot. Kept as a registry rather
 *  than a direct import so verify.ts never depends on the lane. */
export function registerUnattendedVerificationOutcomeHandler(h: UnattendedVerificationHandler | null): void {
  unattendedHandler = h;
}

/**
 * Fired for EVERY terminal verification outcome of a proposal-backed run.
 * No-op in W03 — W04's `ai_script_lane_state` circuit breaker is the first
 * consumer (spec §4.6 "After execution"). A handler failure must never fail the
 * verification job, so it is caught here.
 */
export async function onUnattendedVerificationOutcome(
  proposal: { id: string; orgId: string; decidedVia?: string | null },
  outcome: VerificationOutcome,
): Promise<void> {
  if (!unattendedHandler) return;
  try {
    await unattendedHandler(proposal, outcome);
  } catch (err) {
    console.error(`[scriptVerify] unattended outcome handler failed for ${proposal.id}:`, err);
  }
}
```

- [ ] **Step 4: Write the worker**

```ts
// apps/api/src/jobs/scriptVerifyWorker.ts
/**
 * `script-verify` (spec §4.9, roadmap §3.5). One job per proposal-backed
 * execution that reached a terminal state; three attempts over twenty minutes.
 *
 * `unknown` is RE-ENQUEUED rather than thrown: a throw would make BullMQ's own
 * backoff the retry ladder, and an exhausted-attempts failure looks like a fault in
 * Sentry when the truth is "the device never came back". Attempt count is carried in
 * the job data so the ladder is visible in the payload, the same way
 * ScriptReviewJobData carries it (roadmap §3.3).
 */
import { Job, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { scriptExecutions } from '../db/schema/scripts';
import {
  SCRIPT_VERIFY_QUEUE, SCRIPT_VERIFY_MAX_ATTEMPTS, SCRIPT_VERIFY_RETRY_DELAY_MS,
  enqueueScriptVerify, evaluateVerificationClaim, onUnattendedVerificationOutcome,
  type ScriptVerifyJobData, type VerificationOutcome,
} from '../services/scriptProposals/verify';
import { transitionProposal } from '../services/scriptProposals';
import { loadProposalRow } from '../services/scriptProposals/queries';
import { postProposalOutcomeToAuthor } from '../services/scriptProposals/authorNotify';
import { writeAuditEventAsync } from '../services/auditEvents';

export async function runScriptVerifyJob(data: ScriptVerifyJobData): Promise<VerificationOutcome | 'retry'> {
  const proposal = await loadProposalRow(data.proposalId);
  if (!proposal) return 'unknown';

  const [execution] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.select().from(scriptExecutions).where(eq(scriptExecutions.id, data.executionId)).limit(1),
    ),
  );
  if (!execution) return 'unknown';

  const { outcome, evidence } = await evaluateVerificationClaim(
    proposal.verification,
    { status: execution.status, exitCode: execution.exitCode, stdout: execution.stdout, stderr: execution.stderr },
    { deviceId: execution.deviceId, orgId: proposal.orgId },
    proposal.requestedByUserId ?? proposal.createdBy ?? '',
  );

  if (outcome === 'unknown' && data.attempt < SCRIPT_VERIFY_MAX_ATTEMPTS) {
    await enqueueScriptVerify({ ...data, attempt: data.attempt + 1 }, SCRIPT_VERIFY_RETRY_DELAY_MS);
    return 'retry';
  }

  // A final `unknown` still leaves the proposal, so it can never sit in `executed`
  // forever and block the Save-to-library gate with an ambiguous state. The STATUS
  // is verification_failed; the RESULT records that the truth was unknown.
  const finalStatus = outcome === 'verified' ? 'verified' : 'verification_failed';
  const result = { outcome, attempts: data.attempt, evidence, detail: describe(outcome, evidence) };

  const moved = await db.transaction((tx) =>
    transitionProposal(tx, proposal.id, ['executed'], finalStatus, {
      verifiedAt: new Date(),
      verificationResult: result,
    }),
  );

  if (moved) {
    await postProposalOutcomeToAuthor(proposal as never, {
      kind: outcome === 'verified' ? 'verified' : outcome === 'unknown' ? 'verification_unknown' : 'verification_failed',
      detail: result.detail,
    });
    writeAuditEventAsync({
      action: outcome === 'verified' ? 'script.proposal.verified' : 'script.proposal.verification_failed',
      orgId: proposal.orgId, actorUserId: null,
      targetType: 'script_proposal', targetId: proposal.id, metadata: { outcome, attempts: data.attempt },
    });
  }
  await onUnattendedVerificationOutcome(proposal as never, outcome);
  return outcome;
}

function describe(outcome: VerificationOutcome, evidence: Record<string, unknown>): string {
  if (outcome === 'verified') return 'The proposal\u2019s verification claim was confirmed by an independent read.';
  if (outcome === 'unknown') return `The claim could not be evaluated after ${SCRIPT_VERIFY_MAX_ATTEMPTS} attempts (${String(evidence.reason ?? 'no response')}).`;
  return `The claim was not satisfied: ${JSON.stringify(evidence)}`;
}

let worker: Worker | null = null;

export function createScriptVerifyWorker(): Worker {
  return new Worker(
    SCRIPT_VERIFY_QUEUE,
    async (job: Job<ScriptVerifyJobData>) => runScriptVerifyJob(job.data),
    { connection: getBullMQConnection(), concurrency: 5 },
  );
}

export async function initializeScriptVerifyWorker(): Promise<void> {
  worker = createScriptVerifyWorker();
  attachWorkerObservability(worker, 'scriptVerifyWorker');
  console.log('[ScriptVerify] Worker initialized');
}

export async function shutdownScriptVerifyWorker(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
}
```

- [ ] **Step 5: Register the worker**

```ts
// apps/api/src/services/workerRegistry.ts — new entry
  {
    // W03: evaluates a proposal's verification claim after its execution lands.
    // `socket-owner`, NOT `global`: the closure reaches evaluateVerificationClaim
    // -> executeCommandWithSystemPrecheck -> agentCommandAwait/agentWs, the same
    // dependency that puts alertVerdictScheduler on this placement.
    // workerEntrypointClosure.contract.test.ts is the mechanical authority.
    name: 'scriptVerifyWorker',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/scriptVerifyWorker');
      return { init: m.initializeScriptVerifyWorker, shutdown: m.shutdownScriptVerifyWorker };
    },
  },
```

- [ ] **Step 6: Run the tests, including the placement contract**

Run: `cd apps/api && npx vitest run src/jobs/scriptVerifyWorker.test.ts src/jobs/workerEntrypointClosure.contract.test.ts`
Expected: PASS. If the closure contract disagrees with `socket-owner`, follow the contract test, not this plan.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/scriptVerifyWorker.ts apps/api/src/jobs/scriptVerifyWorker.test.ts apps/api/src/services/scriptProposals/verify.ts apps/api/src/services/workerRegistry.ts
git commit -m "feat(api): script-verify worker with 3-attempt ladder and the W04 outcome hook"
```

---

## Task 15: Enqueue verification when a proposal-backed execution lands

**Files:**
- Modify: `apps/api/src/services/commandResultHandlers.ts:467-556` (returning projections) and `:658-676` (terminal convergence)
- Test: `apps/api/src/services/commandResultHandlers.scriptVerify.test.ts`

**Interfaces:**
- Consumes: `enqueueScriptVerify` (Task 14).

**Where and why:** `handleScriptResult` has four CAS rungs (`:458`, `:474`, `:492`, `:539`) that all converge on `effectiveExecution` at `:658-676`, which is already where the analogous downstream fan-out (`applyAutomationActionTerminal`) fires. One enqueue there covers every rung, including the `#3607` recovery path.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/commandResultHandlers.scriptVerify.test.ts
it('enqueues script-verify for a proposal-backed execution', async () => {
  updateReturning.mockResolvedValue([{ id: 'e1', scriptId: null, proposalId: 'p1' }]);
  await handleScriptResult({ agentId, command, result, resolvedDeviceId, stdout });
  expect(enqueueScriptVerify).toHaveBeenCalledWith({ proposalId: 'p1', executionId: 'e1', attempt: 1 });
});

it('does not enqueue for a library execution', async () => {
  updateReturning.mockResolvedValue([{ id: 'e1', scriptId: 's1', proposalId: null }]);
  await handleScriptResult({ agentId, command, result, resolvedDeviceId, stdout });
  expect(enqueueScriptVerify).not.toHaveBeenCalled();
});

it('does not enqueue when no CAS rung matched (a late duplicate frame)', async () => {
  updateReturning.mockResolvedValue([]);
  await handleScriptResult({ agentId, command, result, resolvedDeviceId, stdout });
  expect(enqueueScriptVerify).not.toHaveBeenCalled();
});

it('never lets an enqueue failure break result ingestion', async () => {
  updateReturning.mockResolvedValue([{ id: 'e1', scriptId: null, proposalId: 'p1' }]);
  enqueueScriptVerify.mockRejectedValue(new Error('redis down'));
  await expect(handleScriptResult({ agentId, command, result, resolvedDeviceId, stdout })).resolves.not.toThrow();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/commandResultHandlers.scriptVerify.test.ts`
Expected: FAIL — `enqueueScriptVerify` never called.

- [ ] **Step 3: Widen the projections and enqueue**

Extract the repeated projection once, near the top of `handleScriptResult`:

```ts
/** W03: `proposalId` rides every CAS rung's RETURNING so the terminal
 *  convergence point below can enqueue verification without a second read. */
const TERMINAL_EXECUTION_PROJECTION = {
  id: scriptExecutions.id,
  scriptId: scriptExecutions.scriptId,
  proposalId: scriptExecutions.proposalId,
} as const;
```

and replace all four inline `.returning({ id, scriptId })` blocks (`:467`, `:483`, `:502`, `:551`) with `.returning(TERMINAL_EXECUTION_PROJECTION)`.

Then at the convergence point, immediately after the existing `applyAutomationActionTerminal` call (`:658-676`):

```ts
      if (effectiveExecution?.proposalId) {
        // Spec §4.9: the claim is evaluated AFTER the execution reaches a terminal
        // state, by an independent read — never inferred from this result frame.
        // Wrapped: a Redis hiccup must not fail result ingestion, which is the
        // durable record. The proposal simply stays `executed` and the operator
        // sees "verification pending" rather than losing the output.
        try {
          await enqueueScriptVerify({
            proposalId: effectiveExecution.proposalId,
            executionId: effectiveExecution.id,
            attempt: 1,
          });
        } catch (err) {
          captureException(err, { tags: { area: 'script_verify_enqueue' } });
        }
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/commandResultHandlers`
Expected: PASS — new file plus every existing `commandResultHandlers*` suite.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/commandResultHandlers.ts apps/api/src/services/commandResultHandlers.scriptVerify.test.ts
git commit -m "feat(api): enqueue script-verify when a proposal-backed execution reaches a terminal state"
```

---

## Task 16: i18n keys, translated in all eight catalogs

**Files:**
- Modify: `apps/web/src/locales/{en,pt-BR,es-419,fr-FR,fr-CA,de-DE,it-IT,tr-TR}/ai.json`
- Modify: `apps/web/src/locales/{en,pt-BR,es-419,fr-FR,fr-CA,de-DE,it-IT,tr-TR}/scripts.json`

**Why this is its own task:** `translationCoverage.test.ts:769-798` enforces two rules — a global <20% exact-English-duplicate ratio and a per-namespace baseline in `namespaceDuplicateBaselines` (`ai.json` is `1` for pt-BR today). Copying English into a locale reddens `test-web`, and the failure arrives as a ratio, not as a named key, so doing the translations *after* the components is how a batch of "fix later" strings gets shipped.

Risk tier labels are **not** new keys — reuse the existing `approvals:risk.low|medium|high|critical` that `ApprovalsInbox.tsx:925` already renders.

- [ ] **Step 1: Write the failing key-parity test**

```ts
// apps/web/src/locales/scriptProposalKeys.test.ts
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = dirname(fileURLToPath(import.meta.url));
const locales = readdirSync(localesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const read = (locale: string, ns: string) => JSON.parse(readFileSync(join(localesDir, locale, ns), 'utf8'));

const AI_KEYS = [
  'title','goal','expectedEffect','verificationClaim','rollback','findings','blastRadius','touches','devices',
  'showCode','hideCode','acknowledgeTitle','acknowledgeRequirement','acknowledgeIncomplete','expiresIn',
  'requestChanges','notePlaceholder','noteRequired','sendBack','severityInfo','severityWarning','severityBlocking',
  'saveToLibrary','verificationPending','verified','verificationFailed','verificationUnknown',
];
const SCRIPT_KEYS = [
  'origin','originHuman','originAiProposal','originImported','originSystem','reviewed','editedSinceReview',
  'provenanceTitle','reviewSummary','approvedBy','evidenceErased','allOrigins',
];

describe('script proposal i18n', () => {
  it.each(locales)('%s ai.json carries every scriptProposal key', (locale) => {
    const block = read(locale, 'ai.json').scriptProposal;
    expect(Object.keys(block ?? {}).sort()).toEqual([...AI_KEYS].sort());
  });
  it.each(locales)('%s scripts.json carries every provenance key', (locale) => {
    const block = read(locale, 'scripts.json').provenance;
    expect(Object.keys(block ?? {}).sort()).toEqual([...SCRIPT_KEYS].sort());
  });
  it.each(locales.filter((l) => l !== 'en'))('%s translates them (no English copies)', (locale) => {
    const en = read('en', 'ai.json').scriptProposal as Record<string, string>;
    const other = read(locale, 'ai.json').scriptProposal as Record<string, string>;
    // expiresIn is pure interpolation in some locales; everything else must differ.
    const copied = Object.keys(en).filter((k) => en[k] === other[k]);
    expect(copied).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/locales/scriptProposalKeys.test.ts`
Expected: FAIL — `scriptProposal` is undefined in every catalog.

- [ ] **Step 3: Add the `scriptProposal` block to each `ai.json`**

`en`:
```json
"scriptProposal": {
  "title": "AI-authored script",
  "goal": "Goal",
  "expectedEffect": "Expected effect",
  "verificationClaim": "How this will be verified",
  "rollback": "Rollback",
  "findings": "Reviewer findings",
  "blastRadius": "Blast radius (advisory)",
  "touches": "Touches",
  "devices": "Target devices",
  "showCode": "Show script",
  "hideCode": "Hide script",
  "acknowledgeTitle": "Acknowledge dangerous patterns",
  "acknowledgeRequirement": "Acknowledging requires script write permission and a recent MFA sign-in.",
  "acknowledgeIncomplete": "Acknowledge every pattern to approve.",
  "expiresIn": "Expires in {{duration}}",
  "requestChanges": "Request changes",
  "notePlaceholder": "What should the author change?",
  "noteRequired": "A note is required.",
  "sendBack": "Send back to the author",
  "severityInfo": "Info",
  "severityWarning": "Warning",
  "severityBlocking": "Blocking",
  "saveToLibrary": "Save to library",
  "verificationPending": "Verification pending",
  "verified": "Verified",
  "verificationFailed": "Verification failed",
  "verificationUnknown": "Could not be verified"
}
```

`pt-BR`: `"Script criado por IA"`, `"Objetivo"`, `"Efeito esperado"`, `"Como isso será verificado"`, `"Reversão"`, `"Achados do revisor"`, `"Alcance do impacto (informativo)"`, `"Afeta"`, `"Dispositivos alvo"`, `"Mostrar script"`, `"Ocultar script"`, `"Reconhecer padrões perigosos"`, `"Reconhecer exige permissão de escrita de scripts e um login recente com MFA."`, `"Reconheça todos os padrões para aprovar."`, `"Expira em {{duration}}"`, `"Solicitar alterações"`, `"O que o autor deve mudar?"`, `"Uma observação é obrigatória."`, `"Devolver ao autor"`, `"Informação"`, `"Aviso"`, `"Bloqueante"`, `"Salvar na biblioteca"`, `"Verificação pendente"`, `"Verificado"`, `"Falha na verificação"`, `"Não foi possível verificar"`

`es-419`: `"Script creado por IA"`, `"Objetivo"`, `"Efecto esperado"`, `"Cómo se verificará"`, `"Reversión"`, `"Hallazgos del revisor"`, `"Alcance del impacto (informativo)"`, `"Afecta"`, `"Dispositivos objetivo"`, `"Mostrar script"`, `"Ocultar script"`, `"Reconocer patrones peligrosos"`, `"Reconocer requiere permiso de escritura de scripts y un inicio de sesión MFA reciente."`, `"Reconoce todos los patrones para aprobar."`, `"Vence en {{duration}}"`, `"Solicitar cambios"`, `"¿Qué debe cambiar el autor?"`, `"Se requiere una nota."`, `"Devolver al autor"`, `"Información"`, `"Advertencia"`, `"Bloqueante"`, `"Guardar en la biblioteca"`, `"Verificación pendiente"`, `"Verificado"`, `"Verificación fallida"`, `"No se pudo verificar"`

`fr-FR`: `"Script rédigé par l'IA"`, `"Objectif"`, `"Effet attendu"`, `"Comment cela sera vérifié"`, `"Retour arrière"`, `"Constats du relecteur"`, `"Portée de l'impact (indicatif)"`, `"Touche"`, `"Appareils ciblés"`, `"Afficher le script"`, `"Masquer le script"`, `"Reconnaître les motifs dangereux"`, `"La reconnaissance exige le droit d'écriture sur les scripts et une connexion MFA récente."`, `"Reconnaissez chaque motif pour approuver."`, `"Expire dans {{duration}}"`, `"Demander des modifications"`, `"Que doit changer l'auteur ?"`, `"Une note est obligatoire."`, `"Renvoyer à l'auteur"`, `"Information"`, `"Avertissement"`, `"Bloquant"`, `"Enregistrer dans la bibliothèque"`, `"Vérification en attente"`, `"Vérifié"`, `"Échec de la vérification"`, `"Vérification impossible"`

`fr-CA`: `"Script rédigé par l'IA"`, `"Objectif"`, `"Effet attendu"`, `"Comment ce sera vérifié"`, `"Annulation"`, `"Constats du réviseur"`, `"Portée de l'impact (à titre indicatif)"`, `"Touche"`, `"Appareils visés"`, `"Afficher le script"`, `"Masquer le script"`, `"Reconnaître les motifs dangereux"`, `"La reconnaissance exige le droit d'écriture sur les scripts et une connexion MFA récente."`, `"Reconnaissez chaque motif pour approuver."`, `"Expire dans {{duration}}"`, `"Demander des modifications"`, `"Que doit changer l'auteur?"`, `"Une note est requise."`, `"Renvoyer à l'auteur"`, `"Information"`, `"Avertissement"`, `"Bloquant"`, `"Enregistrer dans la bibliothèque"`, `"Vérification en attente"`, `"Vérifié"`, `"Échec de la vérification"`, `"Vérification impossible"`

`de-DE`: `"KI-erstelltes Skript"`, `"Ziel"`, `"Erwartete Wirkung"`, `"Wie dies überprüft wird"`, `"Rücknahme"`, `"Befunde der Prüfung"`, `"Wirkungsbereich (Hinweis)"`, `"Betrifft"`, `"Zielgeräte"`, `"Skript anzeigen"`, `"Skript ausblenden"`, `"Gefährliche Muster bestätigen"`, `"Das Bestätigen erfordert Schreibrechte für Skripte und eine aktuelle MFA-Anmeldung."`, `"Bestätigen Sie jedes Muster, um freizugeben."`, `"Läuft ab in {{duration}}"`, `"Änderungen anfordern"`, `"Was soll der Autor ändern?"`, `"Eine Notiz ist erforderlich."`, `"An den Autor zurückgeben"`, `"Hinweis"`, `"Warnung"`, `"Blockierend"`, `"In der Bibliothek speichern"`, `"Überprüfung ausstehend"`, `"Überprüft"`, `"Überprüfung fehlgeschlagen"`, `"Konnte nicht überprüft werden"`

`it-IT`: `"Script creato dall'IA"`, `"Obiettivo"`, `"Effetto previsto"`, `"Come verrà verificato"`, `"Ripristino"`, `"Rilievi del revisore"`, `"Ambito di impatto (indicativo)"`, `"Interessa"`, `"Dispositivi di destinazione"`, `"Mostra script"`, `"Nascondi script"`, `"Conferma i modelli pericolosi"`, `"La conferma richiede il permesso di scrittura degli script e un accesso MFA recente."`, `"Conferma ogni modello per approvare."`, `"Scade tra {{duration}}"`, `"Richiedi modifiche"`, `"Che cosa deve cambiare l'autore?"`, `"È obbligatoria una nota."`, `"Rinvia all'autore"`, `"Informazione"`, `"Avviso"`, `"Bloccante"`, `"Salva nella libreria"`, `"Verifica in sospeso"`, `"Verificato"`, `"Verifica non riuscita"`, `"Impossibile verificare"`

`tr-TR`: `"Yapay zekâ tarafından yazılan betik"`, `"Amaç"`, `"Beklenen etki"`, `"Bunun nasıl doğrulanacağı"`, `"Geri alma"`, `"İnceleme bulguları"`, `"Etki alanı (bilgilendirme)"`, `"Etkiler"`, `"Hedef cihazlar"`, `"Betiği göster"`, `"Betiği gizle"`, `"Tehlikeli kalıpları onayla"`, `"Onaylamak için betik yazma izni ve yakın zamanda yapılmış bir MFA girişi gerekir."`, `"Onaylamak için her kalıbı işaretleyin."`, `"{{duration}} içinde sona erer"`, `"Değişiklik iste"`, `"Yazar neyi değiştirmeli?"`, `"Bir not zorunludur."`, `"Yazara geri gönder"`, `"Bilgi"`, `"Uyarı"`, `"Engelleyici"`, `"Kitaplığa kaydet"`, `"Doğrulama bekliyor"`, `"Doğrulandı"`, `"Doğrulama başarısız"`, `"Doğrulanamadı"`

- [ ] **Step 4: Add the `provenance` block to each `scripts.json`**

Keys, in order: `origin`, `originHuman`, `originAiProposal`, `originImported`, `originSystem`, `reviewed`, `editedSinceReview`, `provenanceTitle`, `reviewSummary`, `approvedBy`, `evidenceErased`, `allOrigins`.

| Locale | Values, in the order above |
|---|---|
| `en` | Origin · Human · AI proposal · Imported · Built-in · Reviewed · Edited since review · Provenance · Review summary · Approved by · Review evidence erased · All origins |
| `pt-BR` | Origem · Humano · Proposta de IA · Importado · Integrado · Revisado · Editado após a revisão · Procedência · Resumo da revisão · Aprovado por · Evidência da revisão apagada · Todas as origens |
| `es-419` | Origen · Humano · Propuesta de IA · Importado · Integrado · Revisado · Editado tras la revisión · Procedencia · Resumen de la revisión · Aprobado por · Evidencia de revisión eliminada · Todos los orígenes |
| `fr-FR` | Origine · Humain · Proposition de l'IA · Importé · Intégré · Relu · Modifié depuis la relecture · Provenance · Résumé de la relecture · Approuvé par · Preuves de relecture supprimées · Toutes les origines |
| `fr-CA` | Origine · Humain · Proposition de l'IA · Importé · Intégré · Révisé · Modifié depuis la révision · Provenance · Résumé de la révision · Approuvé par · Preuves de révision supprimées · Toutes les origines |
| `de-DE` | Herkunft · Mensch · KI-Vorschlag · Importiert · Integriert · Geprüft · Seit der Prüfung bearbeitet · Nachweis · Zusammenfassung der Prüfung · Freigegeben von · Prüfnachweis gelöscht · Alle Herkünfte |
| `it-IT` | Origine · Umano · Proposta dell'IA · Importato · Integrato · Revisionato · Modificato dopo la revisione · Provenienza · Riepilogo della revisione · Approvato da · Prove della revisione eliminate · Tutte le origini |
| `tr-TR` | Köken · İnsan · Yapay zekâ önerisi · İçe aktarıldı · Yerleşik · İncelendi · İncelemeden sonra düzenlendi · Kaynak geçmişi · İnceleme özeti · Onaylayan · İnceleme kanıtı silindi · Tüm kökenler |

- [ ] **Step 5: Run the parity test and the coverage guard**

Run: `cd apps/web && npx vitest run src/locales/scriptProposalKeys.test.ts src/lib/i18n`
Expected: PASS. If `translationCoverage` reports a namespace regression, a value was copied from English — fix the value, do **not** raise the baseline.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/locales apps/web/src/locales/scriptProposalKeys.test.ts
git commit -m "i18n(web): script proposal card and provenance strings in all eight catalogs"
```

---

## Task 17: Web data layer — read hook and the two mutations

**Files:**
- Create: `apps/web/src/lib/api/scriptProposals.ts`
- Create: `apps/web/src/hooks/useScriptProposal.ts`
- Test: `apps/web/src/lib/api/scriptProposals.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // lib/api/scriptProposals.ts
  export async function fetchScriptProposal(id: string, signal?: AbortSignal): Promise<ScriptProposalDetailDto>;
  export async function requestScriptProposalChanges(id: string, note: string): Promise<void>;
  export async function promoteScriptProposal(
    id: string, input: { name: string; description?: string; ownerScope: 'organization' | 'partner' },
  ): Promise<{ scriptId: string; versionId: string }>;
  // hooks/useScriptProposal.ts
  export function useScriptProposal(id: string | null): {
    data: ScriptProposalDetailDto | null; loading: boolean; error: string | null; reload: () => void;
  };
  ```

There is no generic `apiClient` in this app (`lib/api/scripts.ts:1-14` says so explicitly): reads use `fetchWithAuth` directly, mutations are wrapped in `runAction` by the module that owns them. Follow that, and follow `hooks/useDeviceOptions.ts:239-267` for the abortable read.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/lib/api/scriptProposals.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('@/stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const runAction = vi.fn(async (opts: { request: () => Promise<Response> }) => {
  const res = await opts.request();
  return res.json();
});
vi.mock('@/lib/runAction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/runAction')>()),
  runAction: (...a: unknown[]) => runAction(...a),
}));

import { fetchScriptProposal, requestScriptProposalChanges, promoteScriptProposal } from './scriptProposals';

beforeEach(() => vi.clearAllMocks());

it('GETs the detail endpoint', async () => {
  fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ proposal: { id: 'p1' } }) });
  await fetchScriptProposal('p1');
  expect(fetchWithAuth).toHaveBeenCalledWith('/ai/script-proposals/p1', expect.anything());
});

it('throws on a non-ok read rather than returning a half DTO', async () => {
  fetchWithAuth.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) });
  await expect(fetchScriptProposal('p1')).rejects.toThrow();
});

it('routes request-changes through runAction', async () => {
  fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ status: 'changes_requested' }) });
  await requestScriptProposalChanges('p1', 'narrow it');
  expect(runAction).toHaveBeenCalled();
  const [[opts]] = runAction.mock.calls as unknown as [[{ request: () => Promise<Response> }]];
  await opts.request();
  expect(fetchWithAuth).toHaveBeenCalledWith(
    '/ai/script-proposals/p1/request-changes',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ note: 'narrow it' }) }),
  );
});

it('routes promote through runAction with the owner scope', async () => {
  fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ scriptId: 's1', versionId: 'v1' }) });
  await promoteScriptProposal('p1', { name: 'Restart spooler', ownerScope: 'partner' });
  const [[opts]] = runAction.mock.calls as unknown as [[{ request: () => Promise<Response> }]];
  await opts.request();
  expect(fetchWithAuth).toHaveBeenCalledWith(
    '/ai/script-proposals/p1/promote',
    expect.objectContaining({ body: JSON.stringify({ name: 'Restart spooler', ownerScope: 'partner' }) }),
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/lib/api/scriptProposals.test.ts`
Expected: FAIL — cannot resolve `./scriptProposals`.

- [ ] **Step 3: Implement the API module**

```ts
// apps/web/src/lib/api/scriptProposals.ts
// Mirrors lib/api/scripts.ts: there is no generic apiFetch in this app. Reads go
// straight through fetchWithAuth; MUTATIONS are wrapped in runAction here so no
// caller can accidentally fire a silent one (CLAUDE.md "Web Mutation Handlers").
import { fetchWithAuth } from '@/stores/auth';
import { runAction } from '@/lib/runAction';
import i18n from '@/lib/i18n';
import type { ScriptProposalDetailDto } from '@breeze/shared';

export async function fetchScriptProposal(id: string, signal?: AbortSignal): Promise<ScriptProposalDetailDto> {
  const res = await fetchWithAuth(`/ai/script-proposals/${id}`, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to load proposal (${res.status})`);
  }
  return (await res.json()) as ScriptProposalDetailDto;
}

export async function requestScriptProposalChanges(id: string, note: string): Promise<void> {
  await runAction({
    request: () =>
      fetchWithAuth(`/ai/script-proposals/${id}/request-changes`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      }),
    errorFallback: i18n.t('ai:scriptProposal.requestChanges'),
    successMessage: i18n.t('ai:scriptProposal.sendBack'),
  });
}

export async function promoteScriptProposal(
  id: string,
  input: { name: string; description?: string; ownerScope: 'organization' | 'partner' },
): Promise<{ scriptId: string; versionId: string }> {
  return runAction<{ scriptId: string; versionId: string }>({
    request: () =>
      fetchWithAuth(`/ai/script-proposals/${id}/promote`, { method: 'POST', body: JSON.stringify(input) }),
    errorFallback: i18n.t('ai:scriptProposal.saveToLibrary'),
    successMessage: i18n.t('ai:scriptProposal.saveToLibrary'),
  });
}
```

- [ ] **Step 4: Implement the hook**

```ts
// apps/web/src/hooks/useScriptProposal.ts
import { useCallback, useEffect, useState } from 'react';
import type { ScriptProposalDetailDto } from '@breeze/shared';
import { fetchScriptProposal } from '@/lib/api/scriptProposals';

/** Abortable read with an explicit reload, following useDeviceOptions.ts:239-267.
 *  `id === null` is a legitimate idle state (a non-proposal approval), not an error. */
export function useScriptProposal(id: string | null) {
  const [data, setData] = useState<ScriptProposalDetailDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!id) { setData(null); setError(null); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    fetchScriptProposal(id, controller.signal)
      .then((dto) => { setData(dto); setError(null); })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setData(null);
        setError(err instanceof Error ? err.message : 'Failed to load proposal');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, nonce]);

  return { data, loading, error, reload };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/api/scriptProposals.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Register the new file in the silent-mutation guard**

Add `'src/lib/api/scriptProposals.ts'` to `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` and bump the pinned count at `:602` from `125` to `126`. Bump it deliberately, in this commit, with this file as the reason — never by resolving a merge hunk.

Run: `cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/api/scriptProposals.ts apps/web/src/lib/api/scriptProposals.test.ts apps/web/src/hooks/useScriptProposal.ts apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(web): script proposal read hook and runAction-wrapped mutations"
```

---

## Task 18: `ScriptProposalApprovalCard.tsx`

**Files:**
- Create: `apps/web/src/components/ai/ScriptProposalApprovalCard.tsx`
- Create: `apps/web/src/components/ai/ScriptProposalApprovalCard.test.tsx`

**Interfaces:**
- Consumes: `useScriptProposal` (Task 17), `requestScriptProposalChanges` (Task 17), `ScriptProposalDetailDto` (Task 1).
- Produces:
  ```tsx
  export interface ScriptProposalApprovalCardProps {
    proposalId: string;
    /** Called with the acknowledged STRICT descriptions. The PARENT owns the
     *  approve call, because the approve endpoint differs per surface
     *  (AiApprovalDialog decides an intent, the inbox decides an approval row). */
    onApprove?: (acknowledgedPatterns: string[]) => void;
    onReject?: () => void;
    /** Hide the decision footer on a read-only surface (e.g. a promoted proposal). */
    readOnly?: boolean;
    onChanged?: () => void;
  }
  export default function ScriptProposalApprovalCard(props: ScriptProposalApprovalCardProps): JSX.Element;
  ```

**Layout, spec §4.8 order:** risk band + summary → goal / expected effect / verification claim / rollback → findings with severity → blast-radius chips (advisory, visibly labelled) → touch-class chips → device chips + the existing `RunContextRow` → script body in a read-only highlighted view, collapsed past 40 lines → STRICT acknowledgements as required checkboxes carrying the description and its line → expiry countdown → Approve / Request changes / Reject.

**`RunContextRow` is module-local to `AiApprovalDialog.tsx:91`.** Export it from that file (`export function RunContextRow`) and import it here rather than copying it — the "always visible, never in the JSON blob" rule documented at `:83-90` is exactly why it must not be duplicated.

**Monaco has no read-only usage in this repo yet** (verified: no `readOnly` option anywhere under `apps/web/src`). `ScriptForm.tsx:784-805` shows the dynamic-import shape and `lib/monacoLoader.ts:24-29` the self-hosted asset config. Reuse both, with `options={{ readOnly: true, domReadOnly: true, minimap: { enabled: false }, lineNumbers: 'on', scrollBeyondLastLine: false, automaticLayout: true }}` and a `<pre>` fallback while the editor chunk loads — the card must render its text content even if Monaco never arrives.

- [ ] **Step 1: Write the failing component test**

```tsx
// apps/web/src/components/ai/ScriptProposalApprovalCard.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestScriptProposalChanges = vi.fn();
vi.mock('@/lib/api/scriptProposals', () => ({
  requestScriptProposalChanges: (...a: unknown[]) => requestScriptProposalChanges(...a),
}));
const useScriptProposal = vi.fn();
vi.mock('@/hooks/useScriptProposal', () => ({ useScriptProposal: (...a: unknown[]) => useScriptProposal(...a) }));
// Monaco is dynamically imported; stub it so the test asserts on the text, not the editor.
vi.mock('@monaco-editor/react', () => ({ default: ({ value }: { value: string }) => <pre>{value}</pre> }));

import ScriptProposalApprovalCard from './ScriptProposalApprovalCard';

const dto = (over: Record<string, unknown> = {}) => ({
  proposal: {
    id: 'p1', status: 'reviewed', language: 'powershell',
    content: 'Restart-Service spooler', contentDigest: 'a'.repeat(64),
    goal: 'Restart the print spooler', expectedEffect: 'Spooler returns to Running',
    rollbackNote: 'Stop the service again', verification: { kind: 'service_running', name: 'spooler' },
    runAs: 'system', timeoutSeconds: 300, targetDeviceIds: ['d1'],
    basicHits: [], strictHits: [], touchClasses: ['services'], riskTier: 'medium', revision: 1,
    acknowledgedPatterns: [], createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), promotedScriptId: null,
    ...(over.proposal as object ?? {}),
  },
  review: {
    id: 'r1', summary: 'Targets one service on one device', riskTier: 'medium', goalMatch: 'yes',
    reversible: true, verificationAdequate: true, recommendedAction: 'approve',
    findings: [{ severity: 'warning', text: 'Service name is matched loosely', lineRef: 1 }],
    blastRadius: ['print spooler'], model: 'sonnet', createdAt: new Date().toISOString(),
    ...(over.review as object ?? {}),
  },
  devices: [{ id: 'd1', hostname: 'HOST-1', osType: 'windows', status: 'online' }],
  executions: [], verification: { outcome: 'pending', verifiedAt: null, attempts: 0, detail: null },
  viewer: { canDecide: true, canAcknowledge: true, canPromote: false },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useScriptProposal.mockReturnValue({ data: dto(), loading: false, error: null, reload: vi.fn() });
});

describe('ScriptProposalApprovalCard', () => {
  it.each(['low', 'medium', 'high', 'critical'])('renders the %s risk tier band', (tier) => {
    useScriptProposal.mockReturnValue({
      data: dto({ review: { riskTier: tier }, proposal: { riskTier: tier } }), loading: false, error: null, reload: vi.fn(),
    });
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId(`script-proposal-risk-${tier}`)).toBeInTheDocument();
  });

  it('shows the goal, expected effect, verification claim and rollback', () => {
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-goal')).toHaveTextContent('Restart the print spooler');
    expect(screen.getByTestId('script-proposal-expected-effect')).toHaveTextContent('Spooler returns to Running');
    expect(screen.getByTestId('script-proposal-verification')).toBeInTheDocument();
    expect(screen.getByTestId('script-proposal-rollback')).toHaveTextContent('Stop the service again');
  });

  it('renders each finding with its severity', () => {
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    const finding = screen.getByTestId('script-proposal-finding-0');
    expect(finding).toHaveTextContent('Service name is matched loosely');
    expect(finding).toHaveAttribute('data-severity', 'warning');
  });

  it('labels blast radius as advisory and shows the touch classes', () => {
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-blast-radius')).toBeInTheDocument();
    expect(screen.getByTestId('script-proposal-touch-services')).toBeInTheDocument();
  });

  it('shows the script body collapsed and expands it on request', () => {
    const long = Array.from({ length: 60 }, (_, i) => `Write-Host ${i}`).join('\n');
    useScriptProposal.mockReturnValue({ data: dto({ proposal: { content: long } }), loading: false, error: null, reload: vi.fn() });
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-body')).toHaveAttribute('data-collapsed', 'true');
    fireEvent.click(screen.getByTestId('script-proposal-body-toggle'));
    expect(screen.getByTestId('script-proposal-body')).toHaveAttribute('data-collapsed', 'false');
  });

  it('disables Approve until every STRICT pattern is acknowledged', () => {
    useScriptProposal.mockReturnValue({
      data: dto({ proposal: { strictHits: ['PowerShell HKLM write', 'Credential dump utility'] } }),
      loading: false, error: null, reload: vi.fn(),
    });
    render(<ScriptProposalApprovalCard proposalId="p1" onApprove={vi.fn()} />);
    expect(screen.getByTestId('script-proposal-approve-button')).toBeDisabled();
    fireEvent.click(screen.getByTestId('script-proposal-ack-0'));
    expect(screen.getByTestId('script-proposal-approve-button')).toBeDisabled();
    fireEvent.click(screen.getByTestId('script-proposal-ack-1'));
    expect(screen.getByTestId('script-proposal-approve-button')).toBeEnabled();
  });

  it('hands the acknowledged set to the parent on approve', () => {
    const onApprove = vi.fn();
    useScriptProposal.mockReturnValue({
      data: dto({ proposal: { strictHits: ['PowerShell HKLM write'] } }), loading: false, error: null, reload: vi.fn(),
    });
    render(<ScriptProposalApprovalCard proposalId="p1" onApprove={onApprove} />);
    fireEvent.click(screen.getByTestId('script-proposal-ack-0'));
    fireEvent.click(screen.getByTestId('script-proposal-approve-button'));
    expect(onApprove).toHaveBeenCalledWith(['PowerShell HKLM write']);
  });

  it('keeps Approve disabled and names the requirement when the viewer cannot acknowledge', () => {
    useScriptProposal.mockReturnValue({
      data: dto({ proposal: { strictHits: ['PowerShell HKLM write'] }, viewer: { canDecide: true, canAcknowledge: false, canPromote: false } }),
      loading: false, error: null, reload: vi.fn(),
    });
    render(<ScriptProposalApprovalCard proposalId="p1" onApprove={vi.fn()} />);
    expect(screen.getByTestId('script-proposal-approve-button')).toBeDisabled();
    expect(screen.getByTestId('script-proposal-ack-requirement')).toBeInTheDocument();
  });

  it('requires a note before Request changes submits', async () => {
    render(<ScriptProposalApprovalCard proposalId="p1" onApprove={vi.fn()} />);
    fireEvent.click(screen.getByTestId('script-proposal-request-changes-button'));
    fireEvent.click(screen.getByTestId('script-proposal-request-changes-submit'));
    expect(requestScriptProposalChanges).not.toHaveBeenCalled();
    expect(screen.getByTestId('script-proposal-note-error')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('script-proposal-note-input'), { target: { value: 'narrow the filter' } });
    fireEvent.click(screen.getByTestId('script-proposal-request-changes-submit'));
    await waitFor(() => expect(requestScriptProposalChanges).toHaveBeenCalledWith('p1', 'narrow the filter'));
  });

  it('renders an expiry countdown', () => {
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-expiry')).toBeInTheDocument();
  });

  it('renders an error state instead of a blank card when the read fails', () => {
    useScriptProposal.mockReturnValue({ data: null, loading: false, error: 'forbidden', reload: vi.fn() });
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-error')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/ai/ScriptProposalApprovalCard.test.tsx`
Expected: FAIL — cannot resolve `./ScriptProposalApprovalCard`.

- [ ] **Step 3: Export `RunContextRow` from `AiApprovalDialog.tsx`**

```tsx
// apps/web/src/components/ai/AiApprovalDialog.tsx:91
export function RunContextRow({ ctx }: { ctx: AiScriptRunContext }) {
```

- [ ] **Step 4: Write the card**

Structure (full file; the body follows this skeleton exactly):

```tsx
// apps/web/src/components/ai/ScriptProposalApprovalCard.tsx
import { useMemo, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { useScriptProposal } from '@/hooks/useScriptProposal';
import { requestScriptProposalChanges } from '@/lib/api/scriptProposals';
import { ActionError } from '@/lib/runAction';
import { useMonacoEditor } from '@/lib/monacoLoader';

const COLLAPSE_AFTER_LINES = 40;

const RISK_CLASS: Record<string, string> = {
  low: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200',
  critical: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

export interface ScriptProposalApprovalCardProps {
  proposalId: string;
  onApprove?: (acknowledgedPatterns: string[]) => void;
  onReject?: () => void;
  readOnly?: boolean;
  onChanged?: () => void;
}

export default function ScriptProposalApprovalCard({
  proposalId, onApprove, onReject, readOnly = false, onChanged,
}: ScriptProposalApprovalCardProps) {
  const { t } = useTranslation(['ai', 'approvals', 'common']);
  const { data, loading, error, reload } = useScriptProposal(proposalId);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const strictHits = data?.proposal.strictHits ?? [];
  const lineCount = useMemo(() => (data?.proposal.content.split('\n').length ?? 0), [data?.proposal.content]);
  const collapsible = lineCount > COLLAPSE_AFTER_LINES;
  const collapsed = collapsible && !expanded;

  // Approve is gated on the FULL acknowledgement set AND on the viewer's live
  // ability to acknowledge. The server re-checks both (422
  // strict_acknowledgement_not_permitted / _incomplete) — this only stops the
  // user wasting a ceremony on a request that will be refused.
  const allAcked = strictHits.every((h) => acked.has(h));
  const approveDisabled =
    submitting || (strictHits.length > 0 && (!allAcked || !data?.viewer.canAcknowledge));

  const submitNote = async () => {
    const trimmed = note.trim();
    if (!trimmed) { setNoteError(t('ai:scriptProposal.noteRequired')); return; }
    setSubmitting(true);
    try {
      await requestScriptProposalChanges(proposalId, trimmed);
      setNoteOpen(false);
      reload();
      onChanged?.();
    } catch (err) {
      // 401 lets the auth redirect handle it; any non-ActionError needs its own
      // surface because runAction only toasts the ones it produced.
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) setNoteError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div data-testid="script-proposal-loading">{t('common:loading')}</div>;
  if (error || !data) return <div data-testid="script-proposal-error">{error ?? t('common:errors.generic')}</div>;

  const tier = data.review?.riskTier ?? data.proposal.riskTier ?? 'medium';
  return (
    <section data-testid="script-proposal-card" className="rounded-lg border border-border p-4">
      {/* Risk band + reviewer summary */}
      <div data-testid={`script-proposal-risk-${tier}`} className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${RISK_CLASS[tier] ?? RISK_CLASS.medium}`}>
        {t(/* i18n-dynamic */ `approvals:risk.${tier}`)}
      </div>
      <p data-testid="script-proposal-summary" className="mt-2 text-sm">{data.review?.summary}</p>

      {/* Author's claims */}
      <dl className="mt-3 grid gap-2 text-sm">
        <div><dt>{t('ai:scriptProposal.goal')}</dt><dd data-testid="script-proposal-goal">{data.proposal.goal}</dd></div>
        <div><dt>{t('ai:scriptProposal.expectedEffect')}</dt><dd data-testid="script-proposal-expected-effect">{data.proposal.expectedEffect}</dd></div>
        <div><dt>{t('ai:scriptProposal.verificationClaim')}</dt><dd data-testid="script-proposal-verification">{describeClaim(data.proposal.verification)}</dd></div>
        {data.proposal.rollbackNote && (
          <div><dt>{t('ai:scriptProposal.rollback')}</dt><dd data-testid="script-proposal-rollback">{data.proposal.rollbackNote}</dd></div>
        )}
      </dl>

      {/* Findings */}
      <ul className="mt-3 space-y-1">
        {(data.review?.findings ?? []).map((f, i) => (
          <li key={i} data-testid={`script-proposal-finding-${i}`} data-severity={f.severity} className="text-sm">
            <span className="font-semibold">{t(`ai:scriptProposal.severity${cap(f.severity)}`)}</span>{' '}
            {f.text}{typeof f.lineRef === 'number' ? ` (L${f.lineRef})` : ''}
          </li>
        ))}
      </ul>

      {/* Advisory chips — labelled advisory because NOTHING enforces blastRadius (D9). */}
      {(data.review?.blastRadius.length ?? 0) > 0 && (
        <div data-testid="script-proposal-blast-radius" className="mt-3 flex flex-wrap gap-1">
          <span className="text-xs text-muted-foreground">{t('ai:scriptProposal.blastRadius')}</span>
          {data.review!.blastRadius.map((b) => <span key={b} className="rounded bg-muted px-2 py-0.5 text-xs">{b}</span>)}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        <span className="text-xs text-muted-foreground">{t('ai:scriptProposal.touches')}</span>
        {data.proposal.touchClasses.map((c) => (
          <span key={c} data-testid={`script-proposal-touch-${c}`} className="rounded bg-muted px-2 py-0.5 text-xs">{c}</span>
        ))}
      </div>

      {/* Devices + run context */}
      <div data-testid="script-proposal-devices" className="mt-3 flex flex-wrap gap-1">
        {data.devices.map((d) => (
          <span key={d.id} data-testid={`script-proposal-device-${d.id}`} className="rounded bg-muted px-2 py-0.5 text-xs">{d.hostname}</span>
        ))}
      </div>

      {/* Body — read-only Monaco, collapsed past 40 lines */}
      <div data-testid="script-proposal-body" data-collapsed={String(collapsed)} className={collapsed ? 'max-h-64 overflow-hidden' : ''}>
        <ReadOnlyScript language={data.proposal.language} content={data.proposal.content} />
      </div>
      {collapsible && (
        <button type="button" data-testid="script-proposal-body-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t('ai:scriptProposal.hideCode') : t('ai:scriptProposal.showCode')}
        </button>
      )}

      {/* STRICT acknowledgements */}
      {strictHits.length > 0 && (
        <fieldset className="mt-3" data-testid="script-proposal-acknowledgements">
          <legend>{t('ai:scriptProposal.acknowledgeTitle')}</legend>
          {!data.viewer.canAcknowledge && (
            <p data-testid="script-proposal-ack-requirement">{t('ai:scriptProposal.acknowledgeRequirement')}</p>
          )}
          {strictHits.map((hit, i) => (
            <label key={hit} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                data-testid={`script-proposal-ack-${i}`}
                disabled={!data.viewer.canAcknowledge}
                checked={acked.has(hit)}
                onChange={(e) =>
                  setAcked((prev) => {
                    const next = new Set(prev);
                    e.target.checked ? next.add(hit) : next.delete(hit);
                    return next;
                  })
                }
              />
              <span>{hit}</span>
            </label>
          ))}
          {!allAcked && <p className="text-xs">{t('ai:scriptProposal.acknowledgeIncomplete')}</p>}
        </fieldset>
      )}

      <p data-testid="script-proposal-expiry" className="mt-3 text-xs text-muted-foreground">
        {t('ai:scriptProposal.expiresIn', { duration: formatRemaining(data.proposal.expiresAt) })}
      </p>

      {!readOnly && data.viewer.canDecide && (
        <div className="mt-3 flex gap-2">
          <button type="button" data-testid="script-proposal-approve-button" disabled={approveDisabled}
                  onClick={() => onApprove?.(strictHits.filter((h) => acked.has(h)))}>
            {t('ai:aiApprovalDialog.approve')}
          </button>
          <button type="button" data-testid="script-proposal-request-changes-button" onClick={() => setNoteOpen(true)}>
            {t('ai:scriptProposal.requestChanges')}
          </button>
          <button type="button" data-testid="script-proposal-reject-button" onClick={onReject}>
            {t('ai:aiApprovalDialog.reject')}
          </button>
        </div>
      )}

      {noteOpen && (
        <div className="mt-2">
          <textarea data-testid="script-proposal-note-input" value={note}
                    placeholder={t('ai:scriptProposal.notePlaceholder')}
                    onChange={(e) => { setNote(e.target.value); setNoteError(null); }} />
          {noteError && <p data-testid="script-proposal-note-error">{noteError}</p>}
          <button type="button" data-testid="script-proposal-request-changes-submit" disabled={submitting} onClick={submitNote}>
            {t('ai:scriptProposal.sendBack')}
          </button>
        </div>
      )}
    </section>
  );
}
```

Write the three small helpers in the same file: `cap(s)` (`Info`/`Warning`/`Blocking` key suffix), `describeClaim(claim)` (renders the Zod union as one sentence, defaulting to the raw `kind` for an unknown shape), `formatRemaining(iso)` (whole minutes, `0m` when past), and `ReadOnlyScript` (the dynamic Monaco wrapper with the `<pre>` fallback).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/ai/ScriptProposalApprovalCard.test.tsx`
Expected: PASS (14 tests, including the four risk tiers).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ai/ScriptProposalApprovalCard.tsx apps/web/src/components/ai/ScriptProposalApprovalCard.test.tsx apps/web/src/components/ai/AiApprovalDialog.tsx
git commit -m "feat(web): script proposal approval card with STRICT acknowledgement gate"
```

---

## Task 19: Render the card from `AiApprovalDialog`

**Files:**
- Modify: `apps/web/src/components/ai/AiApprovalDialog.tsx:407-408, 482-516`
- Modify: `apps/web/src/lib/intentApprovals.ts:180-233`
- Test: `apps/web/src/components/ai/AiApprovalDialog.scriptProposal.test.tsx`

**Interfaces:**
- Modifies: `decideIntentApproval(approvalRequestId, decision, reason?, opts?: { acknowledgedPatterns?: string[] })`.

**The rule:** when `input.proposalId` is a string, the card REPLACES the raw-JSON `<details>` block at `:486-495` — it does not sit above it. Spec §2.1 names that JSON dump as the defect being fixed; leaving both would keep the script id and device list in front of the approver as if they were the interesting part.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/ai/AiApprovalDialog.scriptProposal.test.tsx
it('renders the proposal card instead of the JSON parameter dump', () => {
  render(<AiApprovalDialog {...baseProps} toolName="run_script" input={{ proposalId: 'p1', deviceIds: ['d1'] }} />);
  expect(screen.getByTestId('script-proposal-card')).toBeInTheDocument();
  expect(screen.queryByText('Show parameters')).not.toBeInTheDocument();
});

it('keeps the JSON dump for every other tool', () => {
  render(<AiApprovalDialog {...baseProps} toolName="execute_command" input={{ deviceId: 'd1' }} />);
  expect(screen.queryByTestId('script-proposal-card')).not.toBeInTheDocument();
  expect(screen.getByText('Show parameters')).toBeInTheDocument();
});

it('passes the acknowledged patterns into decideIntentApproval', async () => {
  render(<AiApprovalDialog {...baseProps} toolName="run_script" input={{ proposalId: 'p1' }}
                           intentBacked selfApprovalRequestId="ar1" />);
  fireEvent.click(screen.getByTestId('script-proposal-ack-0'));
  fireEvent.click(screen.getByTestId('script-proposal-approve-button'));
  await waitFor(() =>
    expect(decideIntentApproval).toHaveBeenCalledWith('ar1', 'approve', undefined,
      { acknowledgedPatterns: ['PowerShell HKLM write'] }),
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/ai/AiApprovalDialog.scriptProposal.test.tsx`
Expected: FAIL — no `script-proposal-card`.

- [ ] **Step 3: Thread the acknowledgements through `decideIntentApproval`**

```ts
// apps/web/src/lib/intentApprovals.ts:180
export async function decideIntentApproval(
  approvalRequestId: string,
  decision: 'approve' | 'deny',
  reason?: string,
  /** W03: STRICT descriptions ticked on the script-proposal card. The server
   *  re-derives (submitted ∩ strict_hits) — this is a request, not a grant. */
  opts?: { acknowledgedPatterns?: string[] },
): Promise<IntentDecisionOutcome> {
  // …existing body; add to the JSON body when present:
  //   ...(opts?.acknowledgedPatterns ? { acknowledgedPatterns: opts.acknowledgedPatterns } : {}),
```

Add a `friendly` mapping for the two new codes so the 422 is not an opaque failure: `strict_acknowledgement_not_permitted` → `ai:scriptProposal.acknowledgeRequirement`, `strict_acknowledgement_incomplete` → `ai:scriptProposal.acknowledgeIncomplete`.

- [ ] **Step 4: Swap the render branch**

```tsx
// apps/web/src/components/ai/AiApprovalDialog.tsx — replacing :486-495
  const proposalId = typeof input.proposalId === 'string' ? input.proposalId : null;
  // …
  {scriptRunContext && <RunContextRow ctx={scriptRunContext} />}
  {deviceContext && <DeviceBadge ctx={deviceContext} />}
  {proposalId ? (
    // Spec §2.1: the raw JSON for a proposal-backed run is a proposal id and a
    // device list — the approver never sees the code. The card REPLACES it.
    <ScriptProposalApprovalCard
      proposalId={proposalId}
      onApprove={(acknowledgedPatterns) => handleIntentDecision('approve', { acknowledgedPatterns })}
      onReject={onReject}
      onChanged={onIntentDecided}
    />
  ) : hasVisibleInput ? (
    <details className="mt-2 group">{/* …unchanged… */}</details>
  ) : null}
```

Extend `handleIntentDecision` (`:271-345`) to take the optional second argument and forward it to `decideIntentApproval`; for the legacy non-intent path keep `onApprove()` as-is.

- [ ] **Step 5: Run the tests**

Run: `cd apps/web && npx vitest run src/components/ai/AiApprovalDialog`
Expected: PASS — the new file plus the existing `AiApprovalDialog.test.tsx`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ai/AiApprovalDialog.tsx apps/web/src/components/ai/AiApprovalDialog.scriptProposal.test.tsx apps/web/src/lib/intentApprovals.ts
git commit -m "feat(web): render the proposal card in AiApprovalDialog and carry acknowledgements"
```

---

## Task 20: Render the card from the approvals inbox row

**Files:**
- Modify: `apps/web/src/components/approvals/ApprovalsInbox.tsx:890-1027`
- Test: `apps/web/src/components/approvals/ApprovalsInbox.scriptProposal.test.tsx`

**Interfaces:**
- Consumes: `ScriptProposalApprovalCard` (Task 18).

The inbox row today shows the action label, a risk pill, target device and risk summary (`:919-972`), and expands only for the deny form (`:973-1027`). A `run_script` row whose `actionArguments.proposalId` is set gets a **Show script review** disclosure that mounts the card lazily — the card fetches the full body, and the body is the expensive, sensitive part, so it must not load for every row in the list.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/approvals/ApprovalsInbox.scriptProposal.test.tsx
it('offers the script review disclosure only for proposal-backed rows', () => {
  renderInbox([row({ actionToolName: 'run_script', actionArguments: { proposalId: 'p1' } }), row({ actionToolName: 'execute_command' })]);
  expect(screen.getAllByTestId(/approval-script-review-toggle/)).toHaveLength(1);
});

it('does not fetch the proposal until the row is expanded', () => {
  renderInbox([row({ actionToolName: 'run_script', actionArguments: { proposalId: 'p1' } })]);
  expect(useScriptProposal).not.toHaveBeenCalledWith('p1');
  fireEvent.click(screen.getByTestId('approval-script-review-toggle-a1'));
  expect(screen.getByTestId('script-proposal-card')).toBeInTheDocument();
});

it('approves through the existing decide path with the acknowledged set', async () => {
  renderInbox([row({ actionToolName: 'run_script', actionArguments: { proposalId: 'p1' } })]);
  fireEvent.click(screen.getByTestId('approval-script-review-toggle-a1'));
  fireEvent.click(screen.getByTestId('script-proposal-ack-0'));
  fireEvent.click(screen.getByTestId('script-proposal-approve-button'));
  await waitFor(() =>
    expect(approveApproval).toHaveBeenCalledWith('a1', { acknowledgedPatterns: ['PowerShell HKLM write'] }),
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/approvals/ApprovalsInbox.scriptProposal.test.tsx`
Expected: FAIL — no toggle rendered.

- [ ] **Step 3: Add the disclosure to `renderRow`**

```tsx
// inside renderRow, after the existing risk-summary block (~:972)
  const proposalId =
    approval.actionToolName === 'run_script' && typeof approval.actionArguments?.proposalId === 'string'
      ? (approval.actionArguments.proposalId as string)
      : null;

  {proposalId && (
    <>
      <button
        type="button"
        data-testid={`approval-script-review-toggle-${approval.id}`}
        aria-expanded={reviewOpenId === approval.id}
        onClick={() => setReviewOpenId((cur) => (cur === approval.id ? null : approval.id))}
      >
        {t('ai:scriptProposal.title')}
      </button>
      {/* Mounted lazily: the card fetches the full script body, and a list of
          twenty pending approvals must not fetch twenty script bodies. */}
      {reviewOpenId === approval.id && (
        <ScriptProposalApprovalCard
          proposalId={proposalId}
          onApprove={(acknowledgedPatterns) => approveApproval(approval.id, { acknowledgedPatterns })}
          onReject={() => openDenyForm(approval.id)}
          onChanged={refresh}
        />
      )}
    </>
  )}
```

Add the `reviewOpenId` state beside `denyingId` (`:588` area) and extend the inbox's approve helper to forward `acknowledgedPatterns` into the POST body — it already calls the same `/approvals/:id/approve` endpoint Task 9 widened.

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && npx vitest run src/components/approvals/ApprovalsInbox`
Expected: PASS — the new file plus the existing `ApprovalsInbox.test.tsx`.

- [ ] **Step 5: Register the modified file in the silent-mutation guard if it is not already listed**

`ApprovalsInbox.tsx` mutates; confirm it is in `TARGET_GLOBS`, and if not, add it and bump the pinned count.

Run: `cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/approvals/ApprovalsInbox.tsx apps/web/src/components/approvals/ApprovalsInbox.scriptProposal.test.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(web): lazy script review disclosure on proposal-backed approval rows"
```

---

## Task 21: Script versions endpoint and `ScriptProvenancePanel`

**Files:**
- Modify: `apps/api/src/routes/scripts.ts` (add `GET /:id/versions`)
- Create: `apps/web/src/components/scripts/ScriptProvenancePanel.tsx`
- Modify: `apps/web/src/components/scripts/ScriptEditPage.tsx`
- Test: `apps/api/src/routes/scripts.versions.test.ts`
- Test: `apps/web/src/components/scripts/ScriptProvenancePanel.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  // API: GET /api/v1/scripts/:id/versions -> { versions: ScriptVersionDto[] }
  export interface ScriptVersionDto {
    id: string; version: number; contentDigest: string; changelog: string | null; createdAt: string;
    origin: ScriptOrigin; proposalId: string | null; reviewId: string | null; reviewedAt: string | null;
    approvedBy: string | null; approverName: string | null; approvedAt: string | null;
    approvalMethod: ScriptApprovalMethod | null;
    reviewSummary: string | null; reviewRiskTier: string | null; reviewModel: string | null;
    /** True when the review row this version cites is gone (source org erased). */
    reviewEvidenceErased: boolean;
  }
  // Web
  export default function ScriptProvenancePanel(props: { scriptId: string }): JSX.Element;
  ```

**Why an endpoint is needed:** `ScriptVersionHistory.tsx:84-97` fabricates its history from `GET /scripts/:id` with a literal comment saying "When a versions endpoint is available…". W01a made versions real; the provenance panel is the first consumer that must not lie, so it gets a real read. `GET /scripts/:id/versions` is two segments and cannot collide with the `/:id` registration at `routes/scripts.ts:607`.

**Spec §4.8 last paragraph:** a partner-wide promotion copies the review summary and tier onto the version row, and the source proposal may later be erased — so the panel renders **"Review evidence erased"**, never a broken link. That is what `reviewEvidenceErased` drives.

- [ ] **Step 1: Write the failing API test**

```ts
// apps/api/src/routes/scripts.versions.test.ts
it('returns versions newest-first with provenance', async () => {
  selectVersions.mockResolvedValue([
    { id: 'v2', version: 2, origin: 'human', proposalId: null, reviewId: null, createdAt: new Date() },
    { id: 'v1', version: 1, origin: 'ai_proposal', proposalId: 'p1', reviewId: 'r1', createdAt: new Date() },
  ]);
  const res = await scriptRoutes.request(`/${SCRIPT_ID}/versions`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  expect(body.versions[1].origin).toBe('ai_proposal');
});

it('marks review evidence erased when the cited review row is gone', async () => {
  selectVersions.mockResolvedValue([{ id: 'v1', version: 1, origin: 'ai_proposal', reviewId: 'r1', createdAt: new Date() }]);
  selectReviews.mockResolvedValue([]); // review erased with the source org
  const body = await (await scriptRoutes.request(`/${SCRIPT_ID}/versions`)).json();
  expect(body.versions[0].reviewEvidenceErased).toBe(true);
  expect(body.versions[0].reviewSummary).toBeNull();
});

it('404s a script in another org', async () => {
  getScriptWithOrgCheck.mockResolvedValue(null);
  expect((await scriptRoutes.request(`/${SCRIPT_ID}/versions`)).status).toBe(404);
});

it('requires scripts:read', async () => {
  // permission stub returns no scripts:read
  expect((await scriptRoutes.request(`/${SCRIPT_ID}/versions`)).status).toBe(403);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/routes/scripts.versions.test.ts`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Add the route**

```ts
// apps/api/src/routes/scripts.ts — beside GET /:id (:607)
scriptRoutes.get(
  '/:id/versions',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_READ.resource, PERMISSIONS.SCRIPTS_READ.action),
  zValidator('param', scriptIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: scriptId } = c.req.valid('param');
    // Same org gate the detail route uses — the version rows carry the full
    // historical CONTENT, so they are exactly as sensitive as the script itself.
    const script = await getScriptWithOrgCheck(scriptId, auth);
    if (!script) return c.json({ error: 'Script not found' }, 404);

    const rows = await db
      .select()
      .from(scriptVersions)
      .where(eq(scriptVersions.scriptId, scriptId))
      .orderBy(desc(scriptVersions.version));

    // Resolve the cited reviews in ONE query. A missing row is not an error: the
    // source org may have been erased after a partner-wide promotion (spec §4.8),
    // which the UI renders as "review evidence erased".
    const reviewIds = rows.map((r) => r.reviewId).filter((v): v is string => !!v);
    const reviews = reviewIds.length
      ? await runOutsideDbContext(() =>
          withSystemDbAccessContext(() =>
            db.select().from(scriptProposalReviews).where(inArray(scriptProposalReviews.id, reviewIds)),
          ),
        )
      : [];
    const byId = new Map(reviews.map((r) => [r.id, r]));

    return c.json({
      versions: rows.map((r) => {
        const review = r.reviewId ? byId.get(r.reviewId) : undefined;
        return {
          id: r.id, version: r.version, contentDigest: r.contentDigest, changelog: r.changelog,
          createdAt: r.createdAt.toISOString(), origin: r.origin, proposalId: r.proposalId,
          reviewId: r.reviewId, reviewedAt: r.reviewedAt?.toISOString() ?? null,
          approvedBy: r.approvedBy, approverName: null, approvedAt: r.approvedAt?.toISOString() ?? null,
          approvalMethod: r.approvalMethod,
          reviewSummary: review?.summary ?? null, reviewRiskTier: review?.riskTier ?? null,
          reviewModel: review?.model ?? null,
          reviewEvidenceErased: !!r.reviewId && !review,
        };
      }),
    });
  },
);
```

- [ ] **Step 4: Write the failing panel test**

```tsx
// apps/web/src/components/scripts/ScriptProvenancePanel.test.tsx
it('renders the head version origin, review summary and approver', async () => {
  fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ versions: [headVersion] }) });
  render(<ScriptProvenancePanel scriptId="s1" />);
  expect(await screen.findByTestId('script-provenance-origin')).toHaveTextContent('AI proposal');
  expect(screen.getByTestId('script-provenance-review-summary')).toHaveTextContent('Targets one service');
  expect(screen.getByTestId('script-provenance-approver')).toBeInTheDocument();
});

it('links to the source proposal when the evidence is intact', async () => {
  fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ versions: [headVersion] }) });
  render(<ScriptProvenancePanel scriptId="s1" />);
  expect(await screen.findByTestId('script-provenance-proposal-link')).toHaveAttribute('href', expect.stringContaining('p1'));
});

it('says the evidence was erased instead of showing a broken link', async () => {
  fetchWithAuth.mockResolvedValue({
    ok: true, json: async () => ({ versions: [{ ...headVersion, reviewEvidenceErased: true, reviewSummary: null }] }),
  });
  render(<ScriptProvenancePanel scriptId="s1" />);
  expect(await screen.findByTestId('script-provenance-erased')).toBeInTheDocument();
  expect(screen.queryByTestId('script-provenance-proposal-link')).not.toBeInTheDocument();
});

it('shows "Edited since review" when the head version is human with no review', async () => {
  fetchWithAuth.mockResolvedValue({
    ok: true,
    json: async () => ({ versions: [{ ...headVersion, version: 2, origin: 'human', reviewId: null, reviewSummary: null }, headVersion] }),
  });
  render(<ScriptProvenancePanel scriptId="s1" />);
  expect(await screen.findByTestId('script-provenance-edited-since-review')).toBeInTheDocument();
});

it('renders nothing intrusive for a plain human script with no history', async () => {
  fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ versions: [] }) });
  render(<ScriptProvenancePanel scriptId="s1" />);
  expect(await screen.findByTestId('script-provenance-empty')).toBeInTheDocument();
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/scripts/ScriptProvenancePanel.test.tsx`
Expected: FAIL — cannot resolve `./ScriptProvenancePanel`.

- [ ] **Step 6: Write the panel and mount it**

The panel reads `GET /scripts/:id/versions`, takes `versions[0]` as the head, and renders: origin label (`scripts:provenance.origin*`), the "Reviewed" / "Edited since review" badge (badge = `Reviewed` when the head version carries a `reviewId` and intact evidence; `Edited since review` when the head is `human` but an EARLIER version carries one — that is exactly the honest downgrade spec §4.1 asks for), the review summary + tier + model + time, the approver and method, a link to the proposal when `proposalId && !reviewEvidenceErased`, and `scripts:provenance.evidenceErased` otherwise. Mount it in `ScriptEditPage.tsx` beside `ScriptVersionHistory`, inside the existing `CollapsibleSection` pattern.

- [ ] **Step 7: Run both suites**

Run: `cd apps/api && npx vitest run src/routes/scripts.versions.test.ts` then `cd apps/web && npx vitest run src/components/scripts/ScriptProvenancePanel.test.tsx src/components/scripts/ScriptEditPage.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/scripts.ts apps/api/src/routes/scripts.versions.test.ts apps/web/src/components/scripts/ScriptProvenancePanel.tsx apps/web/src/components/scripts/ScriptProvenancePanel.test.tsx apps/web/src/components/scripts/ScriptEditPage.tsx
git commit -m "feat(scripts): versions endpoint and the script provenance panel"
```

---

## Task 22: Origin column, filter and review badges in the scripts list

**Files:**
- Modify: `apps/web/src/components/scripts/ScriptList.tsx:106-145, 194-236, 242-298`
- Test: `apps/web/src/components/scripts/ScriptList.origin.test.tsx`

**Interfaces:**
- Consumes: `scripts.origin` + `scripts.originProposalId` (W01b), `scripts:provenance.*` keys (Task 16).

The columns are hand-written `<th>`s, not a column-def array (`:242-277`), and the empty state hardcodes `colSpan={7}` (`:282`) — bump it to `8` or the empty row silently under-spans.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/scripts/ScriptList.origin.test.tsx
it('renders an Origin column header', () => {
  render(<ScriptList scripts={[aiScript, humanScript]} />);
  expect(screen.getByTestId('script-col-origin')).toBeInTheDocument();
});

it('shows the origin label per row', () => {
  render(<ScriptList scripts={[aiScript, humanScript]} />);
  expect(screen.getByTestId(`script-origin-${aiScript.id}`)).toHaveTextContent('AI proposal');
  expect(screen.getByTestId(`script-origin-${humanScript.id}`)).toHaveTextContent('Human');
});

it('filters by origin', () => {
  render(<ScriptList scripts={[aiScript, humanScript]} />);
  fireEvent.change(screen.getByTestId('script-origin-filter'), { target: { value: 'ai_proposal' } });
  expect(screen.getByTestId(`script-row-${aiScript.id}`)).toBeInTheDocument();
  expect(screen.queryByTestId(`script-row-${humanScript.id}`)).not.toBeInTheDocument();
});

it('badges a reviewed AI script and an edited-since-review one differently', () => {
  render(<ScriptList scripts={[aiScript, { ...aiScript, id: 's3', reviewedAtHead: false }]} />);
  expect(screen.getByTestId(`script-badge-reviewed-${aiScript.id}`)).toBeInTheDocument();
  expect(screen.getByTestId('script-badge-edited-since-review-s3')).toBeInTheDocument();
});

it('keeps the empty-state row spanning every column', () => {
  render(<ScriptList scripts={[]} />);
  expect(screen.getByTestId('script-empty-row').querySelector('td')).toHaveAttribute('colspan', '8');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/scripts/ScriptList.origin.test.tsx`
Expected: FAIL — no `script-col-origin`.

- [ ] **Step 3: Add the state, the filter control, the column and the badges**

```tsx
// :106-112 — new filter state
  const [originFilter, setOriginFilter] = useState<string>('all');

// :131-145 — in filteredScripts
      .filter((s) => originFilter === 'all' || (s.origin ?? 'human') === originFilter)

// :194-236 — beside the existing selects
  <select data-testid="script-origin-filter" value={originFilter} onChange={(e) => setOriginFilter(e.target.value)}>
    <option value="all">{t('scripts:provenance.allOrigins')}</option>
    <option value="human">{t('scripts:provenance.originHuman')}</option>
    <option value="ai_proposal">{t('scripts:provenance.originAiProposal')}</option>
    <option value="imported">{t('scripts:provenance.originImported')}</option>
    <option value="system">{t('scripts:provenance.originSystem')}</option>
  </select>

// :263 — new header, before the OS column
  <th data-testid="script-col-origin" className="px-4 py-2.5 cursor-pointer" onClick={() => toggleSort('origin')}>
    {t('scripts:provenance.origin')}
  </th>

// per row
  <td data-testid={`script-origin-${script.id}`} className="px-4 py-2.5">
    {t(/* i18n-dynamic */ `scripts:provenance.origin${originKey(script.origin)}`)}
    {script.origin === 'ai_proposal' && (
      script.reviewedAtHead
        ? <span data-testid={`script-badge-reviewed-${script.id}`}>{t('scripts:provenance.reviewed')}</span>
        // Honest downgrade (spec §4.1): a human edit cuts a head with no review,
        // so the badge must stop claiming the AI review still describes the code.
        : <span data-testid={`script-badge-edited-since-review-${script.id}`}>{t('scripts:provenance.editedSinceReview')}</span>
    )}
  </td>
```

Bump the empty-state `colSpan` from `7` to `8` (`:282`) and give that row `data-testid="script-empty-row"`.

`reviewedAtHead` comes from the list payload — `GET /scripts` must project `origin` and a boolean for "the head version carries a review". Add it to the list query as a lateral/`EXISTS` on `script_versions` where `version = scripts.version AND review_id IS NOT NULL`; do **not** fetch versions per row in the client.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/scripts/ScriptList`
Expected: PASS — new file plus the existing `ScriptList.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/scripts/ScriptList.tsx apps/web/src/components/scripts/ScriptList.origin.test.tsx apps/api/src/routes/scripts.ts
git commit -m "feat(web): origin column, origin filter and review badges in the scripts list"
```

---

## Task 23: "Save to library", gated on `verified`

**Files:**
- Create: `apps/web/src/components/ai/SaveProposalToLibraryDialog.tsx`
- Modify: `apps/web/src/components/ai/ScriptProposalApprovalCard.tsx`
- Test: `apps/web/src/components/ai/SaveProposalToLibraryDialog.test.tsx`

**Interfaces:**
- Consumes: `promoteScriptProposal` (Task 17), `dto.viewer.canPromote` (Task 3).

**Spec §4.8 / D5:** the button appears **only** when `status === 'verified'`. `viewer.canPromote` already encodes `scripts:write && mfa && status === 'verified'`, so the button renders on status and is *enabled* on `canPromote` — a verified proposal with a read-only viewer still shows why the action is unavailable rather than hiding it.

`ownerScope` is a create-only selector per the CLAUDE.md partner-wide playbook: an organization/partner radio pair, defaulting to `organization`, with an "All orgs under this partner" helper line on the partner option (the same shape as `apps/web/src/components/software/PolicyForm.tsx`).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/ai/SaveProposalToLibraryDialog.test.tsx
it('prefills the name from the proposal goal', () => {
  render(<SaveProposalToLibraryDialog proposalId="p1" goal="Restart the print spooler" onClose={vi.fn()} />);
  expect(screen.getByTestId('promote-name-input')).toHaveValue('Restart the print spooler');
});

it('defaults the owner scope to organization', () => {
  render(<SaveProposalToLibraryDialog proposalId="p1" goal="g" onClose={vi.fn()} />);
  expect(screen.getByTestId('promote-owner-scope-organization')).toBeChecked();
});

it('submits through promoteScriptProposal with the chosen scope', async () => {
  render(<SaveProposalToLibraryDialog proposalId="p1" goal="g" onClose={vi.fn()} />);
  fireEvent.click(screen.getByTestId('promote-owner-scope-partner'));
  fireEvent.click(screen.getByTestId('promote-submit'));
  await waitFor(() =>
    expect(promoteScriptProposal).toHaveBeenCalledWith('p1', { name: 'g', ownerScope: 'partner' }),
  );
});

it('requires a name', () => {
  render(<SaveProposalToLibraryDialog proposalId="p1" goal="" onClose={vi.fn()} />);
  fireEvent.click(screen.getByTestId('promote-submit'));
  expect(promoteScriptProposal).not.toHaveBeenCalled();
  expect(screen.getByTestId('promote-name-error')).toBeInTheDocument();
});

it('surfaces a 403 from the server instead of closing silently', async () => {
  promoteScriptProposal.mockRejectedValue(new ActionError('denied', 403, 'forbidden'));
  render(<SaveProposalToLibraryDialog proposalId="p1" goal="g" onClose={onClose} />);
  fireEvent.click(screen.getByTestId('promote-submit'));
  await waitFor(() => expect(onClose).not.toHaveBeenCalled());
});
```

and, on the card:

```tsx
it('shows Save to library only for a verified proposal', () => {
  useScriptProposal.mockReturnValue({ data: dto({ proposal: { status: 'executed' } }), loading: false, error: null, reload: vi.fn() });
  const { rerender } = render(<ScriptProposalApprovalCard proposalId="p1" />);
  expect(screen.queryByTestId('script-proposal-save-to-library')).not.toBeInTheDocument();

  useScriptProposal.mockReturnValue({
    data: dto({ proposal: { status: 'verified' }, viewer: { canDecide: true, canAcknowledge: true, canPromote: true } }),
    loading: false, error: null, reload: vi.fn(),
  });
  rerender(<ScriptProposalApprovalCard proposalId="p1" />);
  expect(screen.getByTestId('script-proposal-save-to-library')).toBeEnabled();
});

it('disables Save to library when the viewer cannot promote', () => {
  useScriptProposal.mockReturnValue({
    data: dto({ proposal: { status: 'verified' }, viewer: { canDecide: true, canAcknowledge: false, canPromote: false } }),
    loading: false, error: null, reload: vi.fn(),
  });
  render(<ScriptProposalApprovalCard proposalId="p1" />);
  expect(screen.getByTestId('script-proposal-save-to-library')).toBeDisabled();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && npx vitest run src/components/ai/SaveProposalToLibraryDialog.test.tsx src/components/ai/ScriptProposalApprovalCard.test.tsx`
Expected: FAIL — dialog missing, button missing.

- [ ] **Step 3: Write the dialog and wire the button**

```tsx
// apps/web/src/components/ai/SaveProposalToLibraryDialog.tsx (skeleton)
export default function SaveProposalToLibraryDialog({
  proposalId, goal, onClose, onPromoted,
}: { proposalId: string; goal: string; onClose: () => void; onPromoted?: (scriptId: string) => void }) {
  const { t } = useTranslation(['ai', 'scripts', 'common']);
  const [name, setName] = useState(goal);
  const [description, setDescription] = useState('');
  // Create-only selector (CLAUDE.md partner-wide playbook step 2): ownerScope is
  // chosen once, at creation, and never editable afterwards.
  const [ownerScope, setOwnerScope] = useState<'organization' | 'partner'>('organization');
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setNameError(t('common:errors.required')); return; }
    setSubmitting(true);
    try {
      const r = await promoteScriptProposal(proposalId, {
        name: trimmed, ...(description.trim() ? { description: description.trim() } : {}), ownerScope,
      });
      onPromoted?.(r.scriptId);
      onClose();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) setNameError(String(err));
      // A non-401 ActionError was already toasted by runAction; the dialog STAYS
      // OPEN so the user can correct the name or the scope.
    } finally {
      setSubmitting(false);
    }
  };
  /* …fields with data-testid promote-name-input / promote-description-input /
     promote-owner-scope-organization / promote-owner-scope-partner / promote-submit… */
}
```

In the card, beside the decision footer:

```tsx
      {data.proposal.status === 'verified' && (
        <button type="button" data-testid="script-proposal-save-to-library"
                disabled={!data.viewer.canPromote} onClick={() => setPromoteOpen(true)}>
          {t('ai:scriptProposal.saveToLibrary')}
        </button>
      )}
      {promoteOpen && (
        <SaveProposalToLibraryDialog
          proposalId={proposalId} goal={data.proposal.goal}
          onClose={() => setPromoteOpen(false)} onPromoted={() => reload()}
        />
      )}
```

Also render the verification state line from `data.verification.outcome` using the four `verification*` keys, so the reason Save is absent is visible rather than mysterious.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/ai/SaveProposalToLibraryDialog.test.tsx src/components/ai/ScriptProposalApprovalCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Register the new mutating file in the guard**

Add `'src/components/ai/SaveProposalToLibraryDialog.tsx'` to `TARGET_GLOBS` only if it calls `fetchWithAuth` directly — it does not (it goes through `lib/api/scriptProposals.ts`, already registered in Task 17), so confirm with the guard rather than guessing.

Run: `cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ai/SaveProposalToLibraryDialog.tsx apps/web/src/components/ai/SaveProposalToLibraryDialog.test.tsx apps/web/src/components/ai/ScriptProposalApprovalCard.tsx apps/web/src/components/ai/ScriptProposalApprovalCard.test.tsx
git commit -m "feat(web): Save to library on a verified proposal with an ownerScope selector"
```

---

## Task 24: Mobile typed renderer `ScriptProposalDetails`

**Files:**
- Create: `apps/mobile/src/screens/approvals/scriptProposalCopy.ts`
- Create: `apps/mobile/src/screens/approvals/scriptProposalCopy.test.ts`
- Create: `apps/mobile/src/screens/approvals/components/ScriptProposalDetails.tsx`
- Modify: `apps/mobile/src/screens/approvals/approvalFlow.ts:14-35`
- Modify: `apps/mobile/src/screens/approvals/ApprovalScreen.tsx:290, 332-337`
- Modify: `apps/mobile/src/services/approvals.ts`

**Interfaces:**
- Produces:
  ```ts
  // approvalFlow.ts
  export type ApprovalFlowType = 'uac_intercept' | 'script_proposal' | 'standard';
  export function extractProposalId(args: Record<string, unknown>): string | null;
  // scriptProposalCopy.ts
  export interface ProposalRows { label: string; value: string }
  export function proposalDetailRows(dto: ScriptProposalDetailDto): ProposalRows[];
  export function findingLines(dto: ScriptProposalDetailDto): string[];
  export function approveBlockedReason(dto: ScriptProposalDetailDto, acked: string[]): 'acknowledge' | 'permission' | null;
  // services/approvals.ts
  export async function fetchScriptProposal(id: string): Promise<ScriptProposalDetailDto>;
  ```

**The mobile constraint is hard:** `apps/mobile/vitest.config.ts` includes only `src/**/*.test.ts` because there is no React Native test runtime, and there are **zero** `.test.tsx` files in `apps/mobile`. So every decision the renderer makes — which rows to show, what blocks Approve — lives in `scriptProposalCopy.ts` and is tested there, exactly like `approvalCopy.ts` + `approvalCopy.test.ts`. The `.tsx` file is then a thin, decision-free view.

- [ ] **Step 1: Write the failing pure-logic test**

```ts
// apps/mobile/src/screens/approvals/scriptProposalCopy.test.ts
import { describe, expect, it } from 'vitest';
import { proposalDetailRows, findingLines, approveBlockedReason } from './scriptProposalCopy';
import { extractProposalId, resolveApprovalFlowType } from './approvalFlow';

const dto = (over: Record<string, unknown> = {}) => ({
  proposal: {
    id: 'p1', status: 'reviewed', language: 'powershell', content: 'Restart-Service spooler',
    goal: 'Restart the print spooler', expectedEffect: 'Spooler returns to Running',
    rollbackNote: null, verification: { kind: 'service_running', name: 'spooler' },
    runAs: 'system', timeoutSeconds: 300, strictHits: [], touchClasses: ['services'],
    riskTier: 'medium', expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...(over.proposal as object ?? {}),
  },
  review: { summary: 'Targets one service', riskTier: 'medium', findings: [{ severity: 'warning', text: 'Loose match' }], blastRadius: [] },
  devices: [{ id: 'd1', hostname: 'HOST-1', osType: 'windows', status: 'online' }],
  viewer: { canDecide: true, canAcknowledge: true, canPromote: false },
  ...over,
}) as never;

describe('resolveApprovalFlowType', () => {
  it('routes a run_script approval carrying a proposalId to script_proposal', () => {
    expect(resolveApprovalFlowType({ actionToolName: 'run_script', actionArguments: { proposalId: 'p1' } })).toBe('script_proposal');
  });
  it('leaves a library run_script on the standard renderer', () => {
    expect(resolveApprovalFlowType({ actionToolName: 'run_script', actionArguments: { scriptId: 's1' } })).toBe('standard');
  });
  it('still routes uac_intercept first', () => {
    expect(resolveApprovalFlowType({ actionToolName: 'uac_intercept', actionArguments: {} })).toBe('uac_intercept');
  });
});

describe('extractProposalId', () => {
  it('reads a string proposalId and rejects anything else', () => {
    expect(extractProposalId({ proposalId: 'p1' })).toBe('p1');
    expect(extractProposalId({ proposalId: 42 })).toBeNull();
    expect(extractProposalId({})).toBeNull();
  });
});

describe('proposalDetailRows', () => {
  it('names the goal, expected effect, verification, device and run context', () => {
    expect(proposalDetailRows(dto()).map((r) => r.label))
      .toEqual(['GOAL', 'EXPECTED EFFECT', 'VERIFICATION', 'DEVICE', 'RUNS AS', 'TOUCHES']);
  });
  it('adds a rollback row only when one exists', () => {
    expect(proposalDetailRows(dto({ proposal: { rollbackNote: 'Stop it again' } })).some((r) => r.label === 'ROLLBACK')).toBe(true);
  });
});

describe('findingLines', () => {
  it('prefixes each finding with its severity', () => {
    expect(findingLines(dto())).toEqual(['[warning] Loose match']);
  });
  it('is empty, never undefined, with no review', () => {
    expect(findingLines(dto({ review: null }))).toEqual([]);
  });
});

describe('approveBlockedReason', () => {
  it('is null when there are no strict hits', () => {
    expect(approveBlockedReason(dto(), [])).toBeNull();
  });
  it('asks for acknowledgement while any strict hit is unticked', () => {
    expect(approveBlockedReason(dto({ proposal: { strictHits: ['A', 'B'] } }), ['A'])).toBe('acknowledge');
  });
  it('reports the permission requirement ahead of the acknowledgement one', () => {
    expect(approveBlockedReason(
      dto({ proposal: { strictHits: ['A'] }, viewer: { canDecide: true, canAcknowledge: false, canPromote: false } }), ['A'],
    )).toBe('permission');
  });
  it('is null once every strict hit is ticked by a permitted approver', () => {
    expect(approveBlockedReason(dto({ proposal: { strictHits: ['A'] } }), ['A'])).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/mobile && npx vitest run src/screens/approvals/scriptProposalCopy.test.ts`
Expected: FAIL — cannot resolve `./scriptProposalCopy`.

- [ ] **Step 3: Extend `approvalFlow.ts`**

```ts
// apps/mobile/src/screens/approvals/approvalFlow.ts
export type ApprovalFlowType = 'uac_intercept' | 'script_proposal' | 'standard';
export const UAC_INTERCEPT_TOOL = 'uac_intercept';
export const RUN_SCRIPT_TOOL = 'run_script';

export interface FlowTypeInput {
  flowType?: string | null;
  actionToolName: string;
  /** W03: a run_script approval is only a PROPOSAL approval when the arguments
   *  name one. A library run keeps the standard renderer. */
  actionArguments?: Record<string, unknown> | null;
}

export function extractProposalId(args: Record<string, unknown> | null | undefined): string | null {
  const value = args?.proposalId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function resolveApprovalFlowType(input: FlowTypeInput): ApprovalFlowType {
  const explicit = input.flowType?.trim();
  if (explicit === UAC_INTERCEPT_TOOL) return 'uac_intercept';
  if (input.actionToolName === UAC_INTERCEPT_TOOL) return 'uac_intercept';
  if (input.actionToolName === RUN_SCRIPT_TOOL && extractProposalId(input.actionArguments)) return 'script_proposal';
  return 'standard';
}
```

- [ ] **Step 4: Write `scriptProposalCopy.ts` and the view**

`scriptProposalCopy.ts` holds `proposalDetailRows`, `findingLines` and `approveBlockedReason` — permission checked **before** acknowledgement, because telling a user to tick boxes they cannot tick is worse than telling them they lack the permission.

`ScriptProposalDetails.tsx` copies `UacInterceptDetails.tsx`'s structure exactly — `useApprovalTheme('dark')`, `spacing[n]`/`radii.md`, `type.metaCaps` + `type.mono`, a `Pressable` collapse header — and adds: the summary line, `findingLines` as rows, a checkbox list over `proposal.strictHits` (React Native `Pressable` + a `✓`/`○` glyph; there is no RN checkbox primitive in this app), and the script body inside a second collapse. It calls `onAcknowledgementsChange(acked)` so `ApprovalScreen` can pass them to the decide call, and renders the blocked reason from `approveBlockedReason`.

- [ ] **Step 5: Fetch the detail from the mobile client**

```ts
// apps/mobile/src/services/approvals.ts — appended (uses the existing private authedFetch)
/** W03: the approval row carries only the proposal id; the card content lives
 *  behind the live-authorised detail endpoint, which re-derives this user's
 *  authority per request. */
export async function fetchScriptProposal(id: string): Promise<ScriptProposalDetailDto> {
  const res = await authedFetch(`/api/v1/ai/script-proposals/${id}`);
  if (res.status === 404) throw new Error('NOT_FOUND');
  if (!res.ok) throw new Error(`Failed to fetch proposal: ${res.status}`);
  return (await res.json()) as ScriptProposalDetailDto;
}
```

- [ ] **Step 6: Choose the renderer**

```tsx
// apps/mobile/src/screens/approvals/ApprovalScreen.tsx:332-337
          <RiskBand tier={focused.riskTier} summary={focused.riskSummary} />
          {flowType === 'uac_intercept' ? (
            <UacInterceptDetails args={focused.actionArguments} />
          ) : flowType === 'script_proposal' ? (
            <ScriptProposalDetails
              proposalId={extractProposalId(focused.actionArguments)!}
              onAcknowledgementsChange={setAcknowledgedPatterns}
            />
          ) : (
            <DetailsCollapse toolName={focused.actionToolName} args={focused.actionArguments} />
          )}
```

`resolveApprovalFlowType` at `:290` now receives `actionArguments`, and the approve call passes `acknowledgedPatterns` in the POST body to `/api/v1/mobile/approvals/:id/approve` (the same handler Task 9 widened).

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd apps/mobile && npx vitest run src/screens/approvals`
Expected: PASS — `scriptProposalCopy.test.ts` plus the existing `approvalCopy.test.ts` and `approvalFlow` tests.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/screens/approvals apps/mobile/src/services/approvals.ts
git commit -m "feat(mobile): typed script proposal approval renderer with acknowledgement gate"
```

---

## Task 25: Helper approval card — summary, findings, body collapse

**Files:**
- Modify: `apps/api/src/services/aiAgentSdk.ts` (the `approval_required` publish, `:1784-1795`)
- Modify: `apps/helper/src/stores/chatStore.ts:46-60, 431-442`
- Modify: `apps/helper/src/components/shell/AppShell.tsx:178-228`
- Test: `apps/helper/src/components/shell/ToolApprovalPopup.test.tsx`

**Interfaces:**
- Produces: `PendingApproval.scriptProposal?: { goal: string; summary: string; riskTier: string; findings: string[]; content: string; strictHits: string[] }`

**Be precise about what this does and does not do.** The helper popup is fed by the `approval_required` SSE event published at `aiAgentSdk.ts:1784-1795` (the legacy Tier-2 path). A proposal-backed `run_script` is Tier 3 and normally reaches a human through an action intent, not this popup. This task makes the helper render a proposal **when the event carries one** — it does not add a new helper approval lane, and the PR body must say so rather than claiming end-to-end helper coverage.

- [ ] **Step 1: Write the failing component test**

```tsx
// apps/helper/src/components/shell/ToolApprovalPopup.test.tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolApprovalPopup } from './AppShell';

const base = {
  executionId: 'e1', toolName: 'run_script', description: 'Run a script on HOST-1',
  input: { proposalId: 'p1' },
};
const withProposal = {
  ...base,
  scriptProposal: {
    goal: 'Restart the print spooler', summary: 'Targets one service', riskTier: 'medium',
    findings: ['[warning] Loose service match'], content: 'Restart-Service spooler', strictHits: [],
  },
};

describe('ToolApprovalPopup', () => {
  it('renders the goal and reviewer summary instead of the JSON dump', () => {
    render(<ToolApprovalPopup approval={withProposal} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByTestId('helper-proposal-summary')).toHaveTextContent('Targets one service');
    expect(screen.queryByText('Show parameters')).not.toBeInTheDocument();
  });

  it('lists each finding', () => {
    render(<ToolApprovalPopup approval={withProposal} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByTestId('helper-proposal-finding-0')).toHaveTextContent('Loose service match');
  });

  it('keeps the script body collapsed until asked', () => {
    render(<ToolApprovalPopup approval={withProposal} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByTestId('helper-proposal-body')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByTestId('helper-proposal-body-toggle'));
    expect(screen.getByTestId('helper-proposal-body')).toHaveAttribute('open');
  });

  it('falls back to the JSON parameters when no proposal rides the event', () => {
    render(<ToolApprovalPopup approval={base} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.queryByTestId('helper-proposal-summary')).not.toBeInTheDocument();
    expect(screen.getByText('Show parameters')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/helper && npx vitest run src/components/shell/ToolApprovalPopup.test.tsx`
Expected: FAIL — `ToolApprovalPopup` is not exported from `AppShell.tsx`.

- [ ] **Step 3: Publish the proposal summary on the event**

At `aiAgentSdk.ts:1784-1795`, when `input.proposalId` is a string, load the proposal + latest review under system scope and attach a trimmed block. Cap `content` at 16 KiB and `findings` at 20 entries — this rides an SSE frame to a desktop client, not a paginated API.

```ts
          session.eventBus.publish({
            type: 'approval_required',
            executionId: approvalExec.id,
            approvalRequestId, toolName, input, description, deviceContext, scriptRunContext,
            // W03: the helper card has no API client of its own, so the summary
            // travels on the event. Trimmed deliberately — this is an SSE frame.
            ...(scriptProposalSummary ? { scriptProposal: scriptProposalSummary } : {}),
          });
```

- [ ] **Step 4: Carry it into the store and render it**

```ts
// apps/helper/src/stores/chatStore.ts:46-60
export interface PendingApprovalScriptProposal {
  goal: string;
  summary: string;
  riskTier: string;
  findings: string[];
  content: string;
  strictHits: string[];
}

export interface PendingApproval {
  executionId: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  deviceContext?: DeviceContext;
  /** W03: present only when the approval is for an AI-authored script proposal. */
  scriptProposal?: PendingApprovalScriptProposal;
}
```

with the `approval_required` case at `:431-442` passing `scriptProposal: event.scriptProposal` straight through, and `ToolApprovalPopup` (`AppShell.tsx:178-228`) exported and extended: when `approval.scriptProposal` exists, render the risk pill, goal, summary, the findings list, the STRICT hits as a plain read-only list (the helper cannot acknowledge — that requires `scripts:write` + MFA, which the helper session does not carry, and the card must say so rather than offering a checkbox that 422s), and the body inside a `<details data-testid="helper-proposal-body">`, replacing the `Show parameters` block.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/helper && npx vitest run src/components/shell/ToolApprovalPopup.test.tsx src/App.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/helper/src/components/shell/AppShell.tsx apps/helper/src/components/shell/ToolApprovalPopup.test.tsx apps/helper/src/stores/chatStore.ts apps/api/src/services/aiAgentSdk.ts
git commit -m "feat(helper): render proposal summary, findings and body on the approval card"
```

---

## Task 26: Flip the flag default and write the release note

**Files:**
- Modify: `apps/api/src/config/env.ts`
- Modify: `apps/api/src/config/validate.ts`
- Modify: `docs/release-notes/next-release-draft.md`
- Test: `apps/api/src/config/env.aiScriptAuthoring.test.ts`

**Interfaces:**
- Modifies: `aiScriptAuthoringEnabled()` default `false` → `true`.

Per roadmap §2 this is the wave that makes the feature user-visible, so it is also the wave that owns the release note (roadmap §4 "Definition of done").

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/config/env.aiScriptAuthoring.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { aiScriptAuthoringEnabled } from './env';

const original = process.env.BREEZE_AI_SCRIPT_AUTHORING_ENABLED;
afterEach(() => {
  if (original === undefined) delete process.env.BREEZE_AI_SCRIPT_AUTHORING_ENABLED;
  else process.env.BREEZE_AI_SCRIPT_AUTHORING_ENABLED = original;
});

describe('aiScriptAuthoringEnabled', () => {
  it('defaults to ON when unset (W03)', () => {
    delete process.env.BREEZE_AI_SCRIPT_AUTHORING_ENABLED;
    expect(aiScriptAuthoringEnabled()).toBe(true);
  });
  it('an operator can still turn it off explicitly', () => {
    process.env.BREEZE_AI_SCRIPT_AUTHORING_ENABLED = 'false';
    expect(aiScriptAuthoringEnabled()).toBe(false);
  });
  it('is read at CALL time, so a flip needs no module reload', () => {
    process.env.BREEZE_AI_SCRIPT_AUTHORING_ENABLED = 'false';
    expect(aiScriptAuthoringEnabled()).toBe(false);
    process.env.BREEZE_AI_SCRIPT_AUTHORING_ENABLED = 'true';
    expect(aiScriptAuthoringEnabled()).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/config/env.aiScriptAuthoring.test.ts`
Expected: FAIL — the first case returns `false`.

- [ ] **Step 3: Flip the default**

```ts
// apps/api/src/config/env.ts
// AI script authoring (spec docs/superpowers/specs/ai-mcp/2026-09-11-…-design.md §8).
// W01b shipped this dark. W03 turns it ON by default: the human loop, the review
// card and the verification job are all in place, so a proposal can no longer
// reach a device without a human reading a truthful summary of it. W05 removes
// the flag. Read at CALL time so an operator (and a test) can flip it without a
// module reload — same shape as policyDecideEnabled above.
export function aiScriptAuthoringEnabled(): boolean {
  return envFlag('BREEZE_AI_SCRIPT_AUTHORING_ENABLED', true);
}
```

Update the `validate.ts` message for the key (added by W01b) so it reads "Defaults to **true**" — the boolean guard itself is unchanged.

- [ ] **Step 4: Append the release note**

Append below the `---` at `docs/release-notes/next-release-draft.md:13`:

```md
## Feature: AI-authored scripts, reviewed and approved on a readable card (#<feature issue>)

The assistant and background agents can now author a script as an immutable
**proposal**. Every proposal is scanned, classified, and independently reviewed by
a model that never sees the author's transcript; a human then approves it on a card
that shows the goal, the expected effect, the reviewer's findings and risk tier, the
target devices, and the code itself — not a JSON blob with a script id in it.

After the run, a `script-verify` job checks the proposal's own verification claim
with an **independent** device read (a service status read, a process list, a file
stat) rather than trusting the script's exit code, and only a **verified** proposal
can be saved to the library, where its origin, reviewer and approver stay visible
on the script and on every version.

**Self-Hosting / Upgrade Notes**

- `BREEZE_AI_SCRIPT_AUTHORING_ENABLED` now **defaults to `true`**. Set it to
  `false` to keep the two new tools (`propose_script`, `get_script_proposal`)
  unregistered and the `/api/v1/ai/script-proposals` surface dark.
- One new migration, `2026-10-16-101000-script-proposal-acknowledged-patterns.sql`
  — one nullable-free `text[]` column with a default. No backfill, no downtime.
- A new BullMQ queue, `script-verify`, runs on the API replica that owns the agent
  socket. No new service, no new port.
- Approving a proposal that matched a **Strict** danger pattern now requires the
  approver to hold `scripts:write` and to have completed MFA — the same bar the
  script library already applies — and four-eyes requests for such proposals are
  fanned out only to approvers who hold it. Approvers who decide AI script runs but
  cannot write scripts should be granted `scripts:write` before you enable this.
- The unattended lane is **not** part of this release. Nothing runs without a human
  approval yet.
```

- [ ] **Step 5: Run the config suites**

Run: `cd apps/api && npx vitest run src/config/env.aiScriptAuthoring.test.ts src/config/validate.test.ts src/config/envComposeParity.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/config/env.ts apps/api/src/config/env.aiScriptAuthoring.test.ts apps/api/src/config/validate.ts docs/release-notes/next-release-draft.md
git commit -m "feat(config): default BREEZE_AI_SCRIPT_AUTHORING_ENABLED to true; release note"
```

---

## Task 27: E2E — propose → card → approve → execute → verify → promote → library provenance

**Files:**
- Create: `e2e-tests/seed-script-proposal.sql`
- Create: `e2e-tests/pages/ScriptProposalsPage.ts`
- Create: `e2e-tests/tests/ai-script-proposals.spec.ts`

**Interfaces:**
- Consumes: every `data-testid` added in Tasks 18–23.

**Seed, do not simulate.** A real `propose_script` call needs a live model, which no CI stack has. `intent-self-approve.spec.ts` already solves this exact problem by seeding the approval through `psql` inside the stack's Postgres container (`:12-40`) and driving the UI from there — copy that helper verbatim rather than inventing a second one. Seed: an org device, a `script_proposals` row (`status = 'reviewed'`, one STRICT hit so the acknowledgement ceremony is exercised), a completed `script_proposal_reviews` row with two findings, an `action_intents` row and its `approval_requests` fan-out row.

**Test-ids required by this spec** (add any that are missing in the task that owns the component, not here): `script-proposal-card`, `script-proposal-risk-<tier>`, `script-proposal-goal`, `script-proposal-finding-0`, `script-proposal-body`, `script-proposal-body-toggle`, `script-proposal-ack-0`, `script-proposal-approve-button`, `script-proposal-request-changes-button`, `script-proposal-save-to-library`, `promote-name-input`, `promote-owner-scope-organization`, `promote-submit`, `approval-script-review-toggle-<id>`, `script-col-origin`, `script-origin-<id>`, `script-badge-reviewed-<id>`, `script-provenance-review-summary`, `script-provenance-proposal-link`.

- [ ] **Step 1: Write the seed**

```sql
-- e2e-tests/seed-script-proposal.sql
-- Seeds ONE reviewed, STRICT-bearing script proposal plus the intent and approval
-- row that fan out from it, and prints PROPOSAL_ID / APPROVAL_ID for the spec.
-- Mirrors seed-sole-operator-intent.sql; run with -v ON_ERROR_STOP=1.
SELECT set_config('breeze.scope', 'system', true);
-- …INSERT script_proposals / script_proposal_reviews / action_intents /
--    approval_requests, each ON CONFLICT DO NOTHING with fixed uuids…
\echo 'PROPOSAL_ID=<fixed uuid>'
\echo 'APPROVAL_ID=<fixed uuid>'
```

- [ ] **Step 2: Write the failing spec**

```ts
// e2e-tests/tests/ai-script-proposals.spec.ts
import { test, expect } from '../fixtures';
import { ScriptProposalsPage } from '../pages/ScriptProposalsPage';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The AI-authored script loop end to end (spec §7 "E2E"). The proposal and its
 * review are SEEDED: a real propose_script needs a live model, which the wt-stack
 * has not got. Everything downstream of the seed — the card, the acknowledgement
 * ceremony, the decision, the execution, the verification transition and the
 * promotion — is the real code path.
 *
 * Skips entirely when BREEZE_AI_SCRIPT_AUTHORING_ENABLED is off on the stack under
 * test, the same probe shape ai-agents.spec.ts uses for its own flag.
 */
test.describe.configure({ mode: 'serial' });

test.describe('AI script proposals', () => {
  let proposalId: string;
  let approvalId: string;

  test.beforeAll(() => {
    ({ proposalId, approvalId } = seedProposal());
  });

  test('the approvals inbox shows the script review instead of raw JSON', async ({ authedPage }) => {
    const page = new ScriptProposalsPage(authedPage);
    await page.gotoApprovals();
    await page.openScriptReview(approvalId);
    await expect(authedPage.getByTestId('script-proposal-card')).toBeVisible();
    await expect(authedPage.getByTestId('script-proposal-risk-medium')).toBeVisible();
    await expect(authedPage.getByTestId('script-proposal-goal')).toBeVisible();
    await expect(authedPage.getByTestId('script-proposal-finding-0')).toBeVisible();
  });

  test('the script body is collapsed until it is expanded', async ({ authedPage }) => {
    const page = new ScriptProposalsPage(authedPage);
    await page.gotoApprovals();
    await page.openScriptReview(approvalId);
    await expect(authedPage.getByTestId('script-proposal-body')).toHaveAttribute('data-collapsed', 'true');
    await authedPage.getByTestId('script-proposal-body-toggle').click();
    await expect(authedPage.getByTestId('script-proposal-body')).toHaveAttribute('data-collapsed', 'false');
  });

  test('Approve stays disabled until the STRICT pattern is acknowledged', async ({ authedPage }) => {
    const page = new ScriptProposalsPage(authedPage);
    await page.gotoApprovals();
    await page.openScriptReview(approvalId);
    await expect(authedPage.getByTestId('script-proposal-approve-button')).toBeDisabled();
    await authedPage.getByTestId('script-proposal-ack-0').click();
    await expect(authedPage.getByTestId('script-proposal-approve-button')).toBeEnabled();
  });

  test('approving records the acknowledgement and moves the proposal on', async ({ authedPage }) => {
    const page = new ScriptProposalsPage(authedPage);
    await page.gotoApprovals();
    await page.openScriptReview(approvalId);
    await authedPage.getByTestId('script-proposal-ack-0').click();
    await authedPage.getByTestId('script-proposal-approve-button').click();
    await expect
      .poll(() => psql(`SELECT acknowledged_patterns::text FROM script_proposals WHERE id = '${proposalId}'`))
      .toContain('HKLM');
    await expect
      .poll(() => psql(`SELECT status FROM script_proposals WHERE id = '${proposalId}'`))
      .not.toBe('reviewed');
  });

  test('a verified proposal offers Save to library and promotion lands with provenance', async ({ authedPage }) => {
    // Drive the proposal to `verified` the way the worker would, so the test does
    // not depend on a live agent: mark the seeded execution completed and let the
    // spec assert on the PROMOTION path, which is the part this test owns.
    forceVerified(proposalId);
    const page = new ScriptProposalsPage(authedPage);
    await page.gotoProposal(proposalId);
    await authedPage.getByTestId('script-proposal-save-to-library').click();
    await authedPage.getByTestId('promote-name-input').fill('E2E promoted spooler fix');
    await authedPage.getByTestId('promote-owner-scope-organization').click();
    await authedPage.getByTestId('promote-submit').click();

    await page.gotoScripts();
    await expect(authedPage.getByTestId('script-col-origin')).toBeVisible();
    const scriptId = psql(`SELECT id FROM scripts WHERE origin_proposal_id = '${proposalId}'`);
    await expect(authedPage.getByTestId(`script-badge-reviewed-${scriptId}`)).toBeVisible();

    await page.gotoScript(scriptId);
    await expect(authedPage.getByTestId('script-provenance-review-summary')).toBeVisible();
    await expect(authedPage.getByTestId('script-provenance-proposal-link')).toBeVisible();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm wt-stack up
cd e2e-tests && pnpm exec playwright test tests/ai-script-proposals.spec.ts
```
Expected: FAIL — `ScriptProposalsPage` does not exist.

- [ ] **Step 4: Write the page object**

```ts
// e2e-tests/pages/ScriptProposalsPage.ts
import type { Page } from '@playwright/test';
import { BasePage } from './BasePage';

export class ScriptProposalsPage extends BasePage {
  constructor(page: Page) { super(page); }
  async gotoApprovals() { await this.page.goto('/approvals'); await this.waitForHydration(); }
  async gotoProposal(id: string) { await this.page.goto(`/approvals#proposal-${id}`); await this.waitForHydration(); }
  async gotoScripts() { await this.page.goto('/scripts'); await this.waitForHydration(); }
  async gotoScript(id: string) { await this.page.goto(`/scripts/${id}`); await this.waitForHydration(); }
  async openScriptReview(approvalId: string) {
    await this.page.getByTestId(`approval-script-review-toggle-${approvalId}`).click();
  }
}
```

Use the existing hydration helper (`e2e-tests/pages/hydration.ts`) — an Astro island that has not hydrated swallows the first click, which is the single most common cause of a flaky first assertion in this suite.

- [ ] **Step 5: Run it green**

```bash
cd e2e-tests && pnpm exec playwright test tests/ai-script-proposals.spec.ts
```
Expected: PASS, 5 tests. Then `pnpm wt-stack down` — nothing reaps the stack for you.

- [ ] **Step 6: Commit**

```bash
git add e2e-tests/tests/ai-script-proposals.spec.ts e2e-tests/pages/ScriptProposalsPage.ts e2e-tests/seed-script-proposal.sql
git commit -m "test(e2e): AI script proposal approval, verification and promotion loop"
```

---

## Task 28: Contract suites, review round, PR

**Files:**
- Modify: whatever the contract suites name. Nothing new is written speculatively.

**This is the roadmap §4 definition of done.** Do not skip it because the unit suites are green: the org-cascade and export-policy contracts only fail under **Integration Tests**, so a unit-green PR on a stale base reddens `main` after merge.

- [ ] **Step 1: Run the API unit surface this wave touched**

```bash
cd apps/api && npx vitest run \
  src/routes/ai/scriptProposals src/services/scriptProposals src/services/approvals \
  src/services/actionIntents/intentApprovers src/services/scriptDispatch \
  src/services/commandResultHandlers src/services/aiToolsScripts \
  src/jobs/scriptVerifyWorker src/jobs/workerEntrypointClosure.contract.test.ts \
  src/config/env.aiScriptAuthoring.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
Expected: PASS. Check the reported FILE COUNT for each substring — a bare substring can pull in unrelated matches and can also miss a dotted sibling.

- [ ] **Step 2: Run the web, mobile and shared surfaces**

```bash
cd apps/web && npx vitest run src/components/ai src/components/approvals src/components/scripts src/lib/api/scriptProposals.test.ts src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts src/locales/scriptProposalKeys.test.ts
cd apps/mobile && npx vitest run src/screens/approvals
cd apps/helper && npx vitest run src/components/shell src/App.test.tsx
cd packages/shared && npx vitest run src/validators/scriptProposals
```
Expected: PASS everywhere.

- [ ] **Step 3: Run the live-DB contract suites**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/services/scriptProposals/acknowledgedPatterns.integration.test.ts
```
Expected: PASS. The export-policy pair is the one that fires on the **column** added in Task 2 — if it is red, classify the column, do not allowlist it.

Tear down when finished: `pnpm test-stack down`.

- [ ] **Step 4: Lint and typecheck**

```bash
pnpm lint
pnpm build
```
Expected: clean. `pnpm lint` before the PR is not optional — an `eslint-disable` for an unregistered rule IS itself a lint error in this repo.

- [ ] **Step 5: One review round**

Per CLAUDE.md model routing: this wave touches **auth and approval-decision code** (Task 9) and **agent-shipped payload construction** (Task 11), so the review is Sonnet (precision) plus Codex `medium` in parallel, orchestrator arbitrating — not the default cheap pair alone. Fix confirmed, consequential findings only; re-review only a fix that itself touched the decide path or the dispatch payload.

- [ ] **Step 6: Open the PR**

Body must carry: `Closes #<wave sub-issue>`; the review round and what it found; the three planning deviations recorded at the top of this plan (acknowledgements on the proposal row, no intent-detail web surface, helper coverage limited to events that carry a proposal); and the note that the unattended lane is **not** in this wave.

```bash
git push -u origin feature/<parent#>-ai-script-authoring/wave-<sub#>
gh pr create --title "W03: AI script authoring — human loop and verification" --body-file <body>
```

Wait for `CI Success` on the PR's own head, then `gh pr merge <N>` to enqueue. Never `--admin`.

- [ ] **Step 7: Commit any review fixes**

```bash
git add -A
git commit -m "fix(ai-scripts): address W03 review findings"
```

---

## Self-Review

Run against the spec with fresh eyes. Findings are recorded here rather than silently fixed, so the executor inherits the reasoning.

**1. Spec coverage**

| Spec section | Covered by |
|---|---|
| §4.5 STRICT acknowledgements (permission + MFA, typed 422, card disables Approve, four-eyes filtered) | Tasks 9, 10, 18, 19 |
| §4.5 acknowledged set rides the dispatch payload | Tasks 2, 9, 11 |
| §4.7 revision loop (proposal → `changes_requested`, intent denied, findings + note to the author) | Tasks 5, 6 |
| §4.8 promotion (verified-only, `scripts:write` + MFA, `insertScriptRow` + `cutScriptVersion` provenance, ownerScope, proposal → `promoted`) | Tasks 7, 8, 23 |
| §4.9 verification claim kinds, independent reads, 3 attempts / 20 min, `verified_at` + `verification_result`, posts to session and recipients | Tasks 5, 13, 14, 15 |
| §4.9 audit actions | Tasks 6, 8, 14 (`.decided`, `.promoted`, `.verified`, `.verification_failed`) |
| §4.9 library surfaces: Origin column + filter, Reviewed / Edited-since-review badges, Provenance panel | Tasks 21, 22 |
| §7 Web tests (each risk tier, checkboxes gate Approve, note required, no-silent-mutations) | Tasks 17, 18, 20 |
| §7 Mobile / helper renderer tests | Tasks 24, 25 |
| §7 Verification tests (each claim kind, unknown after retries) | Tasks 13, 14 |
| §7 E2E | Task 27 |
| §8 W03 flag default on | Task 26 |
| Roadmap §3.5 `onUnattendedVerificationOutcome` hook for W04 | Task 14 |

**Gaps deliberately NOT closed in this wave, with the reason:**
- **Lane-state increments on failed verification** (§4.6 "After execution") belong to W04 — `ai_script_lane_state` does not exist yet. Task 14 exports the hook it plugs into and calls it for every terminal outcome, so W04 adds a handler, not a seam.
- **Device activity feed** (§4.9 "Device activity lists AI-authored runs") is W05 per the roadmap wave table; the execution snapshot columns it reads were shipped in W01b.
- **`AiRiskDashboard` proposal metrics** (§4.9 last sentence) are W05.
- **`script.proposal.created` / `.scan_rejected` / `.reviewed` / `.review_failed` / `.executed`** audit actions belong to W01b and W02, which own those transitions.

**2. Placeholder scan**

Every code step carries real code. Three steps describe a shape rather than transcribing a whole file — Task 18 Step 4 (the three helpers `cap`, `describeClaim`, `formatRemaining` and the `ReadOnlyScript` wrapper), Task 21 Step 6 (the panel body) and Task 24 Step 4 (the `.tsx` view). Each of those names the exact props, test-ids and source precedent to copy, and each is preceded by a test that pins its observable behaviour, so none of them is a "figure it out" instruction. The one genuinely unwritten file is `e2e-tests/seed-script-proposal.sql`, whose row list and printed variables are specified and whose model (`seed-sole-operator-intent.sql`) is named.

**3. Type consistency**

Checked across tasks: `ScriptProposalDetailDto` (Task 1) is what Tasks 3, 17, 18, 24 all consume, with `viewer.canDecide` / `canAcknowledge` / `canPromote` spelled identically everywhere. `acknowledgedPatterns` is the name in the shared validator (Task 1), the DB column (Task 2), `DecideApprovalInput` (Task 9), `decideIntentApproval` opts (Task 19) and the mobile POST body (Task 24) — it becomes `acknowledgedSecurityPatterns` **only** on the agent wire (Task 11), which is the pre-existing field name and must not be renamed. `evaluateVerificationClaim`, `onUnattendedVerificationOutcome`, `ScriptVerifyJobData`, `SCRIPT_VERIFY_QUEUE` match roadmap §3.5 verbatim. `transitionProposal(tx, id, from[], to, patch)` is called with the same five-argument shape in Tasks 6, 7, 12 and 14.

One inconsistency found and fixed while reviewing: Task 7 originally called `cutScriptVersion` a second time after `insertScriptRow`, which would have produced an empty `v1` and a provenance-bearing `v2`. It now threads `provenance` through `insertScriptRow`'s `opts` so the single version W01a already cuts carries the evidence.

## Amendments after cross-wave reconciliation (2026-09-11)

- STRICT acknowledgement MFA bar = JWT `mfa` claim (same as `POST /scripts`), as this plan decided; the spec §4.5 now says the same. The #5601 grant is not used.
- `script_proposals.session_id` is populated by W01b's SDK post-tool hook; author delivery (request-changes, verification posts) may rely on it being set for chat proposals.
- Promote threads provenance through `insertScriptRow(opts.provenance)` (W01a amendment) — no second `cutScriptVersion`.
- The spec's Approval UI section is now §4.10 (restored); the card layout there matches this plan.

