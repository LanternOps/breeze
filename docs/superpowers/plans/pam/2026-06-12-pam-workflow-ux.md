# PAM Workflow & UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loops in the PAM elevation workflow: decision provenance visible on every request, rule-from-request one click away, a rule-preview endpoint ("would have matched N requests"), teaching empty states, evaluation-order copy, and live-refresh fixes — per the confirmed design brief (impeccable shape, 2026-06-12).

**Architecture:** Two API tasks (response-shape extension + new read-only preview endpoint reusing `pamRuleEngine` as the single matching source of truth — no schema changes, no migrations), then four web tasks layered on the existing `/pam` console components. All mutations stay on `runAction`. Restrained color strategy; existing badge/select/table idioms only.

**Tech Stack:** Hono + Drizzle + Zod (API), React (web), Vitest both sides.

**Branch/worktree:** continue on `worktree-pam-config-policy-enablement` at `/Users/toddhebebrand/breeze/.claude/worktrees/pam-config-policy-enablement` (follow-up to PR #1286). ALL file paths below are relative to that worktree root. NEVER touch `/Users/toddhebebrand/breeze` (main checkout).

**Environment:** prefix all pnpm/npx with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.

---

## Established facts (verified by research — don't re-derive)

- `GET /pam/elevation-requests` handler: `apps/api/src/routes/pam.ts:134-196`. SELECT already returns the whole `elevationRequests` row (including `metadata` jsonb and `softwarePolicyMatchId`) plus joined `deviceHostname`/`siteName`/`approvedByName`/`deniedByName`/`revokedByName` via aliased leftJoins.
- Decision provenance is already STORED: `softwarePolicyMatchId` column (policy-decided), `metadata.pam_rule_id` + `metadata.pam_rule_name` (rule-decided, written in `apps/api/src/routes/agents/elevationRequests.ts` ~308-315), `denialReason` text. Missing only: the software policy NAME (needs a join) and first-class surfacing.
- `softwarePolicies` table has `id`, `name`, `mode` columns.
- Rule-creation Zod: `ruleBaseSchema` (pam.ts:565-593), `validateRuleShape` (pam.ts:637), `createRuleSchema` (pam.ts:~654). `POST /rules` at pam.ts:665 guarded by `requirePamWrite` + `requireMfa()`; `PATCH/DELETE /rules/:id` at pam.ts:717/781. Router-level: `authMiddleware` + `requireScope('organization','partner','system')` (pam.ts:85-86); `requirePamWrite` = DEVICES_WRITE permission (pam.ts:60-63). `siteScopeCondition` helper at pam.ts:102.
- `pamRuleEngine.ts`: `evaluatePamRules(rules, candidate)` (line 181) sorts by priority and returns the first `PamRuleMatch` or null — passing a single-element array makes it a pure per-rule matcher. `PamRuleCandidate.at` is injectable ("Evaluation instant; injectable for tests. Defaults to now.") and `isWithinTimeWindow` is already folded into matching (line 169-171). Candidate fields: `targetExecutablePath/Hash/Signer`, `subjectUsername`, `parentImage`, `subjectAdGroups`, `toolName`, `riskTier`, `at`.
- Web `apps/web/src/components/pam/types.ts`: `ElevationRequest` interface (lines 16-49, has `denialReason`, `toolName`, `riskTier` but NOT `metadata`/`softwarePolicyMatchId`), `FLOW_LABELS`, `STATUS_LABELS`, `VERDICT_LABELS`, `statusBadgeClass()` (yellow/green/blue/red/muted recipe), `requestTarget()`, `decidedByLabel()` (lines ~150-163 — returns **null** for `auto_approved` and for policy/rule-denied rows: the provenance gap).
- `PamRequestsTab.tsx`: status+flow filter selects exist (lines 84-124); row table at 149-253; row actions Respond/Revoke (226-247); empty state at 140-147 ("No elevation requests / Requests matching the current filters will appear here."); refetches on `liveTick` (line 78).
- `PamRespondModal.tsx` (176 lines): approve/deny toggle, duration, reason, `runAction` POST to `/pam/elevation-requests/:id/respond`; footer Cancel/Submit at 154-172.
- `PamRuleModal.tsx` (540 lines): props `{ rule: PamRule | null; onClose; onSaved }`; full criteria state at lines 33-64 incl. `shape: 'executable' | 'tool'` toggle; submit handler 131-233 builds `payload` and POSTs `/pam/rules` (or PATCH `/rules/:id`); "Rule shape" section heading at line ~366.
- `PamRulesTab.tsx`: header text "Rules are evaluated in priority order (lowest first); the first match decides." (line ~125); does NOT accept/consume `liveTick` (useEffect deps `[fetchRules]`, line 73-77); `PamPage.tsx` renders `<PamRulesTab />` without the prop while Overview/Requests/Audit get `liveTick`.
- `PamOverviewTab.tsx`: 3 StatCards (Active/Pending/Recent), per-section empty states; fetches `/pam/active` + two `/pam/elevation-requests` queries.
- `SoftwarePolicyTab.tsx` (configurationPolicies/featureTabs): linked-policy summary block at lines ~129-156 shows name/mode/`rules.software` only — no PAM mention.
- Badge idiom: `inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(...)}`. Dialogs: `../shared/Dialog`.
- API tests: `apps/api/src/routes/pam.test.ts` exists with `vi.mock('../db')` chain rigs, `setAuth()` helper, `app()` mounting `pamRoutes` (representative list test ~line 151).
- Known limitation to carry through: historical rows don't store AD groups → a `matchAdGroup`-only draft previews 0 matches (faithful to live `uac_intercept` matching; pamRuleEngine.ts:23-25).

---

## File Map

| File | Action | Task |
|---|---|---|
| `apps/api/src/routes/pam.ts` | Modify: provenance join+fields in list response; add `POST /rules/preview` | 1, 2 |
| `apps/api/src/routes/pam.test.ts` | Modify: provenance + preview tests | 1, 2 |
| `apps/web/src/components/pam/types.ts` | Modify: new fields, `decisionAttribution()`, `FLOW_ICONS`, `requestToRuleDraft()` | 3, 4, 6 |
| `apps/web/src/components/pam/PamRequestsTab.tsx` | Modify: attribution display, Create-rule action, empty states | 3, 4, 6 |
| `apps/web/src/components/pam/PamOverviewTab.tsx` | Modify: attribution in Recent decisions; first-run setup empty state | 3, 6 |
| `apps/web/src/components/pam/PamAuditTab.tsx` | Modify: attribution display | 3 |
| `apps/web/src/components/pam/PamRespondModal.tsx` | Modify: "create rule from request" path | 4 |
| `apps/web/src/components/pam/PamRuleModal.tsx` | Modify: `initial` prop; preview section | 4, 5 |
| `apps/web/src/components/pam/PamRulesTab.tsx` | Modify: liveTick; evaluation-order sentence | 6 |
| `apps/web/src/components/pam/PamPage.tsx` | Modify: pass liveTick to RulesTab | 6 |
| `apps/web/src/components/configurationPolicies/featureTabs/SoftwarePolicyTab.tsx` | Modify: UAC-gating note | 6 |
| `apps/web/src/components/pam/*.test.tsx` | Modify/create: coverage per task | 3-6 |

---

### Task 1: API — decision provenance in the elevation-request list

**Files:**
- Modify: `apps/api/src/routes/pam.ts:158-196` (the GET `/elevation-requests` SELECT + response mapping)
- Test: `apps/api/src/routes/pam.test.ts`

- [ ] **Step 1: Write the failing tests**

In `pam.test.ts`, find the existing GET `/elevation-requests` list test (~line 151) and its db rig. Add two tests in the same describe, reusing the rig verbatim and changing only the rigged row + assertions:

```typescript
it('surfaces software-policy provenance as first-class fields', async () => {
  // Rig one row: status 'denied', softwarePolicyMatchId set, joined policy name present.
  // (Extend the select-chain rig the existing list test uses: the row object gains
  //  `matchedPolicyName: 'Engineering Blocklist'` alongside request/deviceHostname/etc.)
  // ...same arrange + app().request invocation as the existing list test...
  expect(res.status).toBe(200);
  const body = await res.json();
  const row = body.requests[0];
  expect(row.matchedPolicyName).toBe('Engineering Blocklist');
  expect(row.decisionSource).toBe('software_policy');
});

it('surfaces pam-rule provenance from metadata and computes decisionSource', async () => {
  // Rig one row: status 'auto_approved', softwarePolicyMatchId null,
  // metadata: { pam_rule_id: 'rule-1', pam_rule_name: 'Allow signed installers' }.
  expect(res.status).toBe(200);
  const body = await res.json();
  const row = body.requests[0];
  expect(row.pamRuleId).toBe('rule-1');
  expect(row.pamRuleName).toBe('Allow signed installers');
  expect(row.decisionSource).toBe('pam_rule');
});
```

Also add a third quick case to an existing human-decided row assertion (or new test): a row with `approvedByUserId` set and neither policy nor rule metadata → `decisionSource === 'human'`; an untouched pending row → `decisionSource === null`.

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/pam.test.ts` — new tests FAIL (fields undefined), existing pass.

- [ ] **Step 2: Implement in `pam.ts`**

(a) Import `softwarePolicies` from the schema module pam.ts already imports tables from (check the top-of-file schema import and extend it).

(b) In the list SELECT (lines 160-167), add a join + field:

```typescript
        matchedPolicyName: softwarePolicies.name,
```
and after the other leftJoins (line 173):
```typescript
      .leftJoin(softwarePolicies, eq(elevationRequests.softwarePolicyMatchId, softwarePolicies.id))
```

(c) Replace the response mapping (lines 186-193) with:

```typescript
    requests: rows.map((r) => {
      const meta = (r.request.metadata ?? {}) as Record<string, unknown>;
      const pamRuleId = typeof meta.pam_rule_id === 'string' ? meta.pam_rule_id : null;
      const pamRuleName = typeof meta.pam_rule_name === 'string' ? meta.pam_rule_name : null;
      const decisionSource = r.request.softwarePolicyMatchId
        ? ('software_policy' as const)
        : pamRuleId
          ? ('pam_rule' as const)
          : r.request.approvedByUserId || r.request.deniedByUserId || r.request.revokedByUserId
            ? ('human' as const)
            : null;
      return {
        ...r.request,
        deviceHostname: r.deviceHostname,
        siteName: r.siteName,
        approvedByName: r.approvedByName,
        deniedByName: r.deniedByName,
        revokedByName: r.revokedByName,
        matchedPolicyName: r.matchedPolicyName,
        pamRuleId,
        pamRuleName,
        decisionSource,
      };
    }),
```

- [ ] **Step 3: Run tests** — all pass. Run `npx tsc --noEmit` (clean).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/pam.ts apps/api/src/routes/pam.test.ts
git commit -m "feat(pam): first-class decision provenance in elevation-request list

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: API — `POST /pam/rules/preview` (rule dry-run)

**Files:**
- Modify: `apps/api/src/routes/pam.ts` (constants near line 71; schema after `createRuleSchema` ~653; handler after the `POST /rules` block ~713, BEFORE `PATCH /rules/:id`)
- Test: `apps/api/src/routes/pam.test.ts`

Implements the agreed endpoint spec (Plan-agent design, 2026-06-12). Semantics: **pure per-rule criteria matching** against historical `elevation_requests` (NOT chain replay — no priority context, no software-policy bridge replay; that's documented future work). Reuses `evaluatePamRules([draftRule], candidate)` so matching has a single source of truth. Time windows are evaluated against each row's real `requestedAt` via `candidate.at`. No `verdict` in the request body (matching is verdict-independent; handler injects synthetic `require_approval` for `validateRuleShape`). No `excludeRuleId` (only meaningful for chain replay). `requirePamWrite`, **no** `requireMfa` (read-only dry-run). No migrations.

- [ ] **Step 1: Write the failing tests**

Add a `describe('POST /rules/preview', ...)` to `pam.test.ts` reusing the file's `setAuth()`/`app()`/db-rig harness. **Do NOT mock `../services/pamRuleEngine`** — the real engine must run (it's pure); rig only `db.select` rows. Six cases:

```typescript
// Helper for rigged elevation rows (only the columns preview selects):
const previewRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'er-1', requestedAt: new Date('2026-06-10T18:00:00Z'), flowType: 'uac_intercept',
  status: 'pending', subjectUsername: 'ACME\\jdoe',
  targetExecutablePath: 'C:\\Tools\\installer.exe', targetExecutableHash: null,
  targetExecutableSigner: 'Acme Corp', toolName: null, riskTier: null, metadata: {},
  ...over,
});

it('counts signer matches case-insensitively', async () => {
  // rig 5 rows, 3 with signer 'Acme Corp'/'ACME CORP'/'acme corp', 2 with 'Other Inc'
  // body: { matchSigner: 'acme corp', windowDays: 30 }
  expect(body.totalMatched).toBe(3);
  expect(body.totalScanned).toBe(5);
  expect(body.sample).toHaveLength(3);
});

it('does not match tool-action rows against executable criteria', async () => {
  // rig 2 rows: one uac with signer, one ai_tool_action (toolName set, no signer)
  // body: { matchSigner: 'Acme Corp' } → totalMatched 1
});

it('evaluates timeWindow against each row requestedAt', async () => {
  // rows at 23:00Z and 12:00Z, body { matchUser: 'ACME\\jdoe',
  //   timeWindow: { start: '22:00', end: '06:00', timezone: 'UTC' } }
  // → totalMatched 1 (the 23:00 row; overnight wrap)
});

it('returns zeroed shape on empty scan', async () => {
  // rig [] → 200, totalMatched 0, totalScanned 0, truncated false, sample []
});

it('rejects criterion-less, mixed, and out-of-range bodies', async () => {
  // {} → 400; { matchSigner: 'x', matchToolName: 'y' } → 400;
  // { matchSigner: 'x', windowDays: 0 } → 400; windowDays: 91 → 400
});

it('caps sample at 10 and tallies statusBreakdown', async () => {
  // rig 14 matching rows: 9 pending, 5 auto_approved
  // → totalMatched 14, sample.length 10, statusBreakdown.pending 9, statusBreakdown.auto_approved 5
});
```

Run — all FAIL (404 route not found).

- [ ] **Step 2: Implement**

(a) Constants near the file's other bounds (~line 71):

```typescript
const PREVIEW_MAX_WINDOW_DAYS = 90;
const PREVIEW_DEFAULT_WINDOW_DAYS = 30;
const PREVIEW_SCAN_CAP = 5000;  // rows pulled into JS — totalScanned/truncated keep this honest
const PREVIEW_SAMPLE_CAP = 10;
```

(b) Schema immediately after `createRuleSchema` (~line 653):

```typescript
const previewRuleSchema = ruleBaseSchema
  .pick({
    siteId: true,
    matchSigner: true,
    matchHash: true,
    matchPathGlob: true,
    matchParentImage: true,
    matchUser: true,
    matchAdGroup: true,
    matchToolName: true,
    matchRiskTier: true,
    timeWindow: true,
  })
  .extend({
    windowDays: z.number().int().min(1).max(PREVIEW_MAX_WINDOW_DAYS).optional(),
    flowType: z.enum(['uac_intercept', 'tech_jit_admin', 'ai_tool_action']).optional(),
  })
  .superRefine((rule, ctx) => {
    // Same shape rules as create (≥1 criterion, no executable/tool mixing).
    // verdict is irrelevant to matching; inject a synthetic one for the validator.
    const err = validateRuleShape({ ...rule, verdict: 'require_approval' });
    if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
  });
```

(If `ruleBaseSchema.pick` fights Zod typing on any field, fall back to a hand-rolled `z.object` duplicating exactly those field validators from `ruleBaseSchema` — keep validators identical.)

(c) Handler after the `POST /rules` block (~line 713), before `PATCH /rules/:id`:

```typescript
// ============================================================
// Rules — preview (dry-run draft criteria against history)
// ============================================================
// Pure per-rule matching: "would these criteria match these historical
// requests". NOT a chain replay (no priority shadowing, no software-policy
// bridge) — that variant is future work. Known limitation: historical rows
// don't store AD groups, so matchAdGroup-only drafts report 0 (mirrors the
// live uac_intercept ingest gap).
pamRoutes.post('/rules/preview', requirePamWrite, zValidator('json', previewRuleSchema), async (c) => {
  const auth = c.get('auth');
  const perms = c.get('permissions') as UserPermissions | undefined;
  const body = c.req.valid('json');

  const windowDays = body.windowDays ?? PREVIEW_DEFAULT_WINDOW_DAYS;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const conditions: (SQL | undefined)[] = [
    auth.orgCondition(elevationRequests.orgId),
    siteScopeCondition(perms),
    gte(elevationRequests.requestedAt, since),
  ];
  if (body.flowType) conditions.push(eq(elevationRequests.flowType, body.flowType));
  if (body.siteId) {
    if (perms && !canAccessSite(perms, body.siteId)) {
      return c.json({ error: 'Site access denied' }, 403);
    }
    conditions.push(eq(elevationRequests.siteId, body.siteId));
  }

  const rows = await db
    .select({
      id: elevationRequests.id,
      requestedAt: elevationRequests.requestedAt,
      flowType: elevationRequests.flowType,
      status: elevationRequests.status,
      subjectUsername: elevationRequests.subjectUsername,
      targetExecutablePath: elevationRequests.targetExecutablePath,
      targetExecutableHash: elevationRequests.targetExecutableHash,
      targetExecutableSigner: elevationRequests.targetExecutableSigner,
      toolName: elevationRequests.toolName,
      riskTier: elevationRequests.riskTier,
      metadata: elevationRequests.metadata,
    })
    .from(elevationRequests)
    .where(and(...conditions.filter((cn): cn is SQL => cn !== undefined)))
    .orderBy(desc(elevationRequests.requestedAt))
    .limit(PREVIEW_SCAN_CAP);

  // Engine-shaped draft rule; matching reads match*/timeWindow/enabled only.
  const draftRule = {
    id: 'preview', name: 'preview', enabled: true, priority: 0,
    verdict: 'ignore' as const, approvalDurationMinutes: null,
    createdAt: new Date(),
    matchSigner: body.matchSigner ?? null,
    matchHash: body.matchHash ? body.matchHash.toLowerCase() : null,
    matchPathGlob: body.matchPathGlob ?? null,
    matchParentImage: body.matchParentImage ?? null,
    matchUser: body.matchUser ?? null,
    matchAdGroup: body.matchAdGroup ?? null,
    matchToolName: body.matchToolName ?? null,
    matchRiskTier: body.matchRiskTier ?? null,
    timeWindow: body.timeWindow ?? null,
  };

  let totalMatched = 0;
  const statusBreakdown: Record<string, number> = {
    pending: 0, approved: 0, auto_approved: 0, denied: 0, expired: 0, revoked: 0, actuating: 0,
  };
  const sample: Array<Record<string, unknown>> = [];

  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const candidate = {
      targetExecutablePath: r.targetExecutablePath ?? undefined,
      targetExecutableHash: r.targetExecutableHash ?? undefined,
      targetExecutableSigner: r.targetExecutableSigner ?? undefined,
      subjectUsername: r.subjectUsername,
      parentImage: typeof meta.parent_image === 'string' ? meta.parent_image : undefined,
      toolName: r.toolName ?? undefined,
      riskTier: r.riskTier ?? undefined,
      at: r.requestedAt,
    };
    if (evaluatePamRules([draftRule], candidate)) {
      totalMatched++;
      statusBreakdown[r.status] = (statusBreakdown[r.status] ?? 0) + 1;
      if (sample.length < PREVIEW_SAMPLE_CAP) {
        sample.push({
          id: r.id, requestedAt: r.requestedAt, flowType: r.flowType,
          subjectUsername: r.subjectUsername,
          targetExecutablePath: r.targetExecutablePath ?? null,
          toolName: r.toolName ?? null, status: r.status,
        });
      }
    }
  }

  return c.json({
    success: true,
    totalMatched,
    totalScanned: rows.length,
    windowDays,
    truncated: rows.length === PREVIEW_SCAN_CAP,
    statusBreakdown,
    sample,
  });
});
```

Adapt the `draftRule`/`candidate` literals to the engine's actual exported types (`PamRule`-shape, `PamRuleCandidate`) — import what's needed from `../services/pamRuleEngine`; if `PamRule` there has extra required fields, satisfy them with nulls. `desc`/`gte`/`and`/`eq` are already imported (pam.ts:23).

- [ ] **Step 3: Run tests** — 6 preview tests + whole pam.test.ts pass; `npx tsc --noEmit` clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/pam.ts apps/api/src/routes/pam.test.ts
git commit -m "feat(pam): POST /rules/preview — dry-run draft rule criteria against recent requests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Web — decision attribution on every decided request

**Files:**
- Modify: `apps/web/src/components/pam/types.ts`
- Modify: `apps/web/src/components/pam/PamRequestsTab.tsx` (status cell, lines 205-225)
- Modify: `apps/web/src/components/pam/PamOverviewTab.tsx` (Recent decisions list)
- Modify: `apps/web/src/components/pam/PamAuditTab.tsx` (status cell)
- Test: `apps/web/src/components/pam/PamRequestsTab.test.tsx` (extend)

- [ ] **Step 1: Failing test** — in `PamRequestsTab.test.tsx` (read its existing fetch-mock harness first), add: a rigged row with `status: 'auto_approved'`, `decisionSource: 'pam_rule'`, `pamRuleName: 'Allow signed installers'` renders the text `Rule · Allow signed installers`; a row with `decisionSource: 'software_policy'`, `matchedPolicyName: 'Engineering Blocklist'`, `status: 'denied'` renders `Policy · Engineering Blocklist`. Run — FAIL.

- [ ] **Step 2: types.ts** — extend `ElevationRequest`:

```typescript
  softwarePolicyMatchId?: string | null;
  matchedPolicyName?: string | null;
  pamRuleId?: string | null;
  pamRuleName?: string | null;
  decisionSource?: 'software_policy' | 'pam_rule' | 'human' | null;
```

Add below `decidedByLabel` (keep `decidedByLabel` for human attribution):

```typescript
/**
 * Who/what decided the request, for display under the status badge.
 * Auto decisions name their source (software policy / PAM rule); human
 * decisions defer to decidedByLabel. Null while pending/undecided.
 */
export function decisionAttribution(r: ElevationRequest): string | null {
  if (r.decisionSource === 'software_policy') {
    return `Policy · ${r.matchedPolicyName ?? 'Software policy'}`;
  }
  if (r.decisionSource === 'pam_rule') {
    return `Rule · ${r.pamRuleName ?? 'PAM rule'}`;
  }
  const human = decidedByLabel(r);
  return human ? `by ${human}` : null;
}
```

- [ ] **Step 3: Render it** — in all three list surfaces, replace the `decidedBy`-only block with `decisionAttribution(r)`:

`PamRequestsTab.tsx` (status cell, lines ~211-224): replace the `{decidedBy && (...)}` div with the same markup driven by `const attribution = decisionAttribution(r)`; keep `data-testid={`pam-decided-by-${r.id}`}` and the `title` attr. Keep the `denialReason` div but only when `decisionSource === 'human'` or `decisionSource == null` (policy/rule denials already name their source — the raw "Blocked by..." string is then redundant). Also update the row-map prelude (`const decidedBy = decidedByLabel(r);` → `const attribution = decisionAttribution(r);`).

`PamOverviewTab.tsx` Recent-decisions list and `PamAuditTab.tsx` status cell: same substitution (their blocks are near-identical; keep their testids).

- [ ] **Step 4: Run** `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/pam/` — all pass (fix any existing tests that asserted the old `by …` rendering for auto rows). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/pam/types.ts apps/web/src/components/pam/PamRequestsTab.tsx apps/web/src/components/pam/PamOverviewTab.tsx apps/web/src/components/pam/PamAuditTab.tsx apps/web/src/components/pam/PamRequestsTab.test.tsx
git commit -m "feat(pam): show decision provenance (policy/rule/human) on request rows

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Web — create a rule from a request

**Files:**
- Modify: `apps/web/src/components/pam/types.ts` (add `requestToRuleDraft`)
- Modify: `apps/web/src/components/pam/PamRuleModal.tsx` (accept `initial` draft)
- Modify: `apps/web/src/components/pam/PamRequestsTab.tsx` (row action + modal mount)
- Modify: `apps/web/src/components/pam/PamRespondModal.tsx` (tertiary path)
- Test: `apps/web/src/components/pam/PamRuleModal.test.tsx` / `PamRequestsTab.test.tsx` (extend)

- [ ] **Step 1: Failing tests**
  - `PamRuleModal.test.tsx`: rendering with `rule={null}` and `initial={{ shape: 'executable', matchSigner: 'Acme Corp', name: 'Allow installer.exe', siteId: 'site-1' }}` shows those values pre-filled (assert input values).
  - `PamRequestsTab.test.tsx`: each row has a `pam-create-rule-btn-${id}` button; clicking it opens the rule modal (assert the dialog title appears).

- [ ] **Step 2: `requestToRuleDraft` in types.ts**

```typescript
export interface PamRuleDraft {
  shape: 'executable' | 'tool';
  name?: string;
  siteId?: string | null;
  matchSigner?: string | null;
  matchHash?: string | null;
  matchPathGlob?: string | null;
  matchUser?: string | null;
  matchToolName?: string | null;
  matchRiskTier?: number | null;
}

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Seed a rule draft from a request. Prefers the stable criterion: signer
 * over hash (hashes churn with updates) over path; tool actions seed
 * toolName + riskTier; JIT admin seeds the subject user.
 */
export function requestToRuleDraft(r: ElevationRequest): PamRuleDraft {
  if (r.flowType === 'ai_tool_action') {
    return {
      shape: 'tool',
      name: r.toolName ? `Rule for ${r.toolName}` : undefined,
      siteId: r.siteId ?? null,
      matchToolName: r.toolName ?? null,
      matchRiskTier: r.riskTier ?? null,
    };
  }
  if (r.flowType === 'tech_jit_admin') {
    return { shape: 'executable', siteId: r.siteId ?? null, matchUser: r.subjectUsername };
  }
  const name = r.targetExecutablePath ? `Rule for ${baseName(r.targetExecutablePath)}` : undefined;
  if (r.targetExecutableSigner) {
    return { shape: 'executable', name, siteId: r.siteId ?? null, matchSigner: r.targetExecutableSigner };
  }
  if (r.targetExecutableHash) {
    return { shape: 'executable', name, siteId: r.siteId ?? null, matchHash: r.targetExecutableHash };
  }
  return { shape: 'executable', name, siteId: r.siteId ?? null, matchPathGlob: r.targetExecutablePath ?? null };
}
```

- [ ] **Step 3: `PamRuleModal` accepts `initial`** — add optional prop `initial?: PamRuleDraft` and seed the create-mode state initializers (only when `rule === null`):

```typescript
export default function PamRuleModal({ rule, initial, onClose, onSaved }: {
  rule: PamRule | null;
  initial?: PamRuleDraft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const seed = rule === null ? initial : undefined;
  const [name, setName] = useState(rule?.name ?? seed?.name ?? '');
  // ... shape: rule ? (existing logic) : (seed?.shape ?? 'executable')
  // ... matchSigner: rule?.matchSigner ?? seed?.matchSigner ?? ''
  // ... matchHash / matchPathGlob / matchUser / matchToolName analogous
  // ... matchRiskTier: rule?.matchRiskTier ?? seed?.matchRiskTier (stringified as existing)
  // ... siteId: rule?.siteId ?? seed?.siteId ?? ''
```

(Apply the `?? seed?.X ??` middle term to each existing `useState(rule?.X ?? fallback)` initializer for the seeded fields; leave verdict/priority/timeWindow untouched.)

- [ ] **Step 4: Requests-tab action + RespondModal path**

`PamRequestsTab.tsx`: add state `const [ruleDraft, setRuleDraft] = useState<ElevationRequest | null>(null);`, import `PamRuleModal` and `requestToRuleDraft`. In the actions cell (after the Revoke button, lines ~237-246) add for ALL rows:

```tsx
<button
  type="button"
  onClick={() => setRuleDraft(r)}
  data-testid={`pam-create-rule-btn-${r.id}`}
  title="Create a PAM rule pre-filled from this request"
  className="ml-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent"
>
  Rule…
</button>
```

Mount next to the other modals (lines ~280-299):

```tsx
{ruleDraft && (
  <PamRuleModal
    rule={null}
    initial={requestToRuleDraft(ruleDraft)}
    onClose={() => setRuleDraft(null)}
    onSaved={() => {
      setRuleDraft(null);
      void fetchRequests();
    }}
  />
)}
```

`PamRespondModal.tsx`: add optional prop `onCreateRule?: () => void`; render a quiet link-button on the LEFT of the footer (line ~154, inside the flex, before Cancel — change `justify-end` to `justify-between` with a left group):

```tsx
<div className="flex items-center justify-between gap-2">
  {onCreateRule ? (
    <button
      type="button"
      onClick={onCreateRule}
      data-testid="pam-respond-create-rule"
      className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
    >
      Create rule from this request…
    </button>
  ) : <span />}
  <div className="flex gap-2">
    {/* existing Cancel + submit buttons unchanged */}
  </div>
</div>
```

In `PamRequestsTab.tsx`, pass `onCreateRule={() => { setRuleDraft(responding); setResponding(null); }}` to `PamRespondModal`.

- [ ] **Step 5: Run** pam web tests + tsc — green. **Step 6: Commit**

```bash
git add apps/web/src/components/pam/
git commit -m "feat(pam): create rule pre-filled from an elevation request (row action + respond modal)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Web — rule preview in PamRuleModal

**Files:**
- Modify: `apps/web/src/components/pam/PamRuleModal.tsx`
- Test: `apps/web/src/components/pam/PamRuleModal.test.tsx` (extend)

- [ ] **Step 1: Failing test** — mock `fetchWithAuth` for `/pam/rules/preview` returning `{ success: true, totalMatched: 14, totalScanned: 240, windowDays: 30, truncated: false, statusBreakdown: { pending: 9, auto_approved: 5, approved: 0, denied: 0, expired: 0, revoked: 0, actuating: 0 }, sample: [ ...two rows... ] }`. Fill `matchSigner`, click the `pam-rule-preview-btn`, assert the result text `Would have matched 14 of 240 requests in the last 30 days` appears and the breakdown mentions `9 pending`.

- [ ] **Step 2: Implement** — in `PamRuleModal.tsx`:

State: `const [preview, setPreview] = useState<PreviewResult | null>(null);` `const [previewing, setPreviewing] = useState(false);` (local `type PreviewResult` mirroring the response). Stale-guard: clear `setPreview(null)` whenever any criteria/timeWindow/siteId state changes (a small `useEffect` over those deps).

Handler (reuses the same criteria assembly as `handleSubmit` — extract the `activeCriteria`/window construction into a local `buildCriteria()` used by both):

```typescript
const handlePreview = async () => {
  const built = buildCriteria();           // { activeCriteria, timeWindow } or sets error + returns null
  if (!built) return;
  setPreviewing(true);
  setPreview(null);
  try {
    const res = await fetchWithAuth('/pam/rules/preview', {
      method: 'POST',
      body: JSON.stringify({
        ...built.activeCriteria,
        timeWindow: built.timeWindow,
        siteId: siteId || null,
      }),
    });
    if (!res.ok) throw new Error(`Preview failed (HTTP ${res.status})`);
    setPreview(await res.json());
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Preview failed');
  } finally {
    setPreviewing(false);
  }
};
```

(Read-only fetch — `runAction` is for mutations; a failed preview sets the modal's existing inline `error`, no toast.)

UI, placed directly above the modal's footer buttons:

```tsx
<div className="rounded-md border bg-muted/20 p-3">
  <div className="flex items-center justify-between">
    <p className="text-sm font-medium">Preview against recent requests</p>
    <button
      type="button"
      onClick={() => void handlePreview()}
      disabled={previewing}
      data-testid="pam-rule-preview-btn"
      className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
    >
      {previewing ? 'Previewing…' : 'Preview matches'}
    </button>
  </div>
  {preview && (
    <div className="mt-2 space-y-2 text-sm" data-testid="pam-rule-preview-result">
      <p>
        Would have matched <span className="font-semibold">{preview.totalMatched}</span> of{' '}
        {preview.totalScanned} requests in the last {preview.windowDays} days
        {preview.truncated ? ' (newest 5000 scanned)' : ''}.
      </p>
      {preview.totalMatched > 0 && (
        <p className="text-xs text-muted-foreground">
          {Object.entries(preview.statusBreakdown)
            .filter(([, n]) => n > 0)
            .map(([s, n]) => `${n} ${STATUS_LABELS[s as ElevationStatus].toLowerCase()}`)
            .join(' · ')}
        </p>
      )}
      <ul className="space-y-1">
        {preview.sample.slice(0, 5).map((s) => (
          <li key={s.id} className="truncate text-xs text-muted-foreground">
            {new Date(s.requestedAt).toLocaleString()} · {s.subjectUsername} ·{' '}
            {s.targetExecutablePath ?? s.toolName ?? '—'}
          </li>
        ))}
      </ul>
      {/* AD-group caveat: historical rows lack group data */}
      {matchAdGroup.trim() && (
        <p className="text-xs text-muted-foreground">
          Note: historical requests don't record AD groups, so group criteria preview as 0.
        </p>
      )}
    </div>
  )}
</div>
```

Imports: `STATUS_LABELS`, `type ElevationStatus` from `./types`.

- [ ] **Step 3: Run** tests + tsc — green. **Step 4: Commit**

```bash
git add apps/web/src/components/pam/PamRuleModal.tsx apps/web/src/components/pam/PamRuleModal.test.tsx
git commit -m "feat(pam): preview draft rule matches against recent requests in rule modal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Web — teaching states, evaluation-order copy, flow icons, live fixes

**Files:**
- Modify: `apps/web/src/components/pam/types.ts` (FLOW_ICONS)
- Modify: `apps/web/src/components/pam/PamRequestsTab.tsx` (empty state, flow cell)
- Modify: `apps/web/src/components/pam/PamOverviewTab.tsx` (first-run state)
- Modify: `apps/web/src/components/pam/PamAuditTab.tsx` (flow cell)
- Modify: `apps/web/src/components/pam/PamRulesTab.tsx` (header copy + liveTick)
- Modify: `apps/web/src/components/pam/PamPage.tsx` (pass liveTick)
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/SoftwarePolicyTab.tsx` (UAC note)
- Tests: extend `PamRulesTab.test.tsx`, `PamOverviewTab.test.tsx`

- [ ] **Step 1: Failing tests** — (a) `PamRulesTab.test.tsx`: component accepts `liveTick` and re-fetches when it changes (mock fetch, rerender with bumped prop, assert second call); header contains "Software policies are evaluated first". (b) `PamOverviewTab.test.tsx`: with all-zero data, the first-run block (`pam-setup-steps` testid) renders and mentions "Configuration Policies".

- [ ] **Step 2: Flow icons** — `types.ts`: PAM components import lucide directly, so export a mapping component-side:

```typescript
import { Bot, MonitorCog, UserCog, type LucideIcon } from 'lucide-react';

export const FLOW_ICONS: Record<ElevationFlowType, LucideIcon> = {
  uac_intercept: MonitorCog,
  tech_jit_admin: UserCog,
  ai_tool_action: Bot,
};
```

In `PamRequestsTab.tsx` (flow cell, line ~204) and `PamAuditTab.tsx` flow cell:

```tsx
<td className="whitespace-nowrap px-3 py-2">
  {(() => {
    const FlowIcon = FLOW_ICONS[r.flowType];
    return (
      <span className="inline-flex items-center gap-1.5">
        <FlowIcon className="h-3.5 w-3.5 text-muted-foreground" />
        {FLOW_LABELS[r.flowType]}
      </span>
    );
  })()}
</td>
```

(If `lucide-react` exports differ — `MonitorCog` missing — use `Monitor`. Verify with a grep in node_modules or existing usages.)

- [ ] **Step 3: Requests empty state** — replace lines 140-147 block: keep icon + "No elevation requests"; the sub-copy becomes status-aware:

```tsx
<p className="mt-1 text-xs text-muted-foreground">
  {status === 'pending'
    ? 'Nothing waiting on you. New UAC prompts, JIT admin requests, and AI tool actions queue here.'
    : 'Requests matching the current filters will appear here.'}
</p>
<p className="mt-2 text-xs text-muted-foreground">
  Not seeing expected requests? UAC capture is controlled per device by{' '}
  <a href="/configuration-policies" className="underline underline-offset-2 hover:text-foreground">
    Configuration Policies → Privileged Access
  </a>.
</p>
```

- [ ] **Step 4: Overview first-run block** — in `PamOverviewTab.tsx`, when `data` is loaded and `data.active.length === 0 && data.pendingTotal === 0 && data.recent.length === 0`, render ABOVE the stat cards:

```tsx
<div className="rounded-md border bg-muted/20 p-4" data-testid="pam-setup-steps">
  <p className="text-sm font-medium">Getting started with Privileged Access</p>
  <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
    <li>
      UAC prompt capture is on by default. Scope it per device with a{' '}
      <a href="/configuration-policies" className="underline underline-offset-2 hover:text-foreground">
        Configuration Policy → Privileged Access
      </a>{' '}
      feature link.
    </li>
    <li>Elevation prompts, JIT admin requests, and AI tool actions queue in the Requests tab.</li>
    <li>Approve or deny each request — or create a rule from it so the decision is automatic next time.</li>
  </ol>
</div>
```

- [ ] **Step 5: Rules header + liveTick** — `PamRulesTab.tsx`: header paragraph (line ~125) becomes:

```tsx
<p className="text-sm text-muted-foreground">
  Software policies are evaluated first — an allowlist/blocklist match decides before these rules.
  Rules then run in priority order (lowest first); the first match decides.
</p>
```

Accept and consume `liveTick`: `export default function PamRulesTab({ liveTick = 0 }: { liveTick?: number })` and add it to the fetch effect deps (line 73-77: `}, [fetchRules, liveTick]);`). `PamPage.tsx`: `<PamRulesTab liveTick={liveTick} />`.

- [ ] **Step 6: SoftwarePolicyTab note** — in the linked-policy summary block (after the `Mode:` paragraph, ~line 134):

```tsx
<p className="mt-1 text-xs text-muted-foreground">
  Executable rules in this policy also gate UAC elevation requests on assigned devices —
  an allowlist match auto-approves, a blocklist match auto-denies, before any PAM rules run.
</p>
```

- [ ] **Step 7: Run** all pam web tests + featureTabs tests + `npx tsc --noEmit` — green. **Step 8: Commit**

```bash
git add apps/web/src/components/pam/ apps/web/src/components/configurationPolicies/featureTabs/SoftwarePolicyTab.tsx
git commit -m "feat(pam): teaching empty states, evaluation-order copy, flow icons, rules live-refresh

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Verification checklist (post-implementation)

- [ ] `apps/api`: `npx vitest run src/routes/pam.test.ts` green (provenance + 6 preview cases)
- [ ] `apps/web`: `npx vitest run src/components/pam/ src/components/configurationPolicies/featureTabs/` green; `npx tsc --noEmit` clean both apps
- [ ] No migrations added; no new tables (RLS untouched)
- [ ] Spot-check copy: no raw `denialReason` shown for policy/rule denials; evaluation-order sentences present on Rules tab + SoftwarePolicyTab
- [ ] Visual pass (optional, needs dev stack): provenance chips legible at a glance; "Rule…" action doesn't crowd the actions cell on narrow widths

## Design rationale

- **Provenance pattern `{Source} · {name}`** replaces both the silent auto-decisions and raw `denialReason` strings — Stripe-Radar anchor: every decision names its decider.
- **Preview is pure per-rule matching, not chain replay** — deterministic, reuses `evaluatePamRules` with a single-element array; chain replay (priority shadowing + software-policy bridge replay, with `excludeRuleId`) is explicitly future work.
- **`requestToRuleDraft` prefers signer > hash > path** — signers survive app updates; hashes churn.
- **Preview has no MFA** — read-only dry-run; MFA stays on the mutating rule CRUD.
- **AD-group caveat** surfaced in the preview UI because historical rows don't store groups (mirrors the live ingest gap).
