# PAM Signer-Group Matching — Certificate Thumbprint Pinning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Source issue:** #1776 — *[PAM] Signer-group matching should pin certificate thumbprint, not just subject CN.* Surfaced reviewing #1771 (reusable signer-group / trusted-publisher catalog).

**Why this is a PLAN, not a PR:** This is a security control that spans **agent (Go) + API (TS) + DB schema** and **cannot be shipped safely piecemeal**. The blocking fact: the Go agent does **not** extract the Authenticode certificate thumbprint today — it explicitly defers WinTrust/CryptoAPI extraction (`agent/internal/etwlua/etwlua_windows.go:190-195`, "A follow-up PR can wire it in once we have a Windows CI runner to validate"). The API can only match on data the agent supplies. Pinning a thumbprint in schema/API before the fleet's agents send one would make every thumbprint-pinned rule **fail closed** in the engine's `present` check — which for `verdict=auto_approve` rules **silently breaks PAM auto-approval** across a fleet until 100% of agents roll over. That is a worse-than-CN availability + security regression, exactly the half-PR a security control must not be forced into. See **Sequencing & Safety** below.

## Security framing (security-review mindset)

- **Threat being closed:** subject CN (`"Acme Corp"`) is attacker-chosen — anyone can mint a self-signed or unrelated cert bearing any CN. With #1771, a matched signer can be a basis for **auto-approving privilege elevation**, so CN-only matching lets a forged publisher → unauthorized local elevation. Thumbprint pinning (SHA-256 of the leaf cert, optionally requiring a chain validated to a trusted root) binds the match to a specific key, which is not forgeable without the private key.
- **Tenant isolation:** `pam_signer_groups` and `pam_rules` are already **shape 1** (direct `org_id`, RLS enabled+forced, auto-discovered by rls-coverage). This plan adds **no new tables** and does not change the tenancy shape, so RLS coverage is unaffected — but any new column on these tables must still ship under the same forced-RLS table, and the functional `breeze_app` forge test must continue to pass.
- **Trust boundary:** the thumbprint is computed/validated **agent-side** from the on-disk binary's signature. The agent is the trusted measurer; the API must treat a missing/empty thumbprint as **"not present" (fail closed)**, never as a wildcard.
- **Defense in depth:** thumbprint match is the **strong tier**; CN match stays as a clearly-labeled **weak tier**. A signer-group entry should be able to require *thumbprint* (strong), *CN* (weak/legacy), or *both*. This plan does NOT remove CN matching (that would break every existing group), it adds a stronger tier alongside it and surfaces the weakness in the UI.

---

## Sequencing & Safety (the crux — why piecemeal is unsafe)

The agent is the only component that can produce a real thumbprint. The three layers must roll out in this order, each backward-compatible:

1. **Agent first (produce the signal).** Add Authenticode leaf-cert SHA-256 extraction in the agent and emit it as a new optional payload field (`target_executable_signer_thumbprint`). Until agents are upgraded fleet-wide, the API will simply not receive it. The agent change is independently shippable and a strict superset of today's payload.
2. **API/schema second (accept + store, match only when present).** Add the column(s) and extend the engine so a thumbprint criterion matches **only when the candidate carries a thumbprint** (`present` gate), and a CN criterion keeps working unchanged. Crucially: a signer-group entry that pins a thumbprint must **fail closed** (no match) when the candidate has no thumbprint — it must NOT silently fall through to CN. Existing CN-only groups are untouched.
3. **UI/admin last (let admins pin).** Only expose "pin thumbprint" in the signer-group editor **after** agent rollout is broad enough, and surface a clear warning that thumbprint-pinned entries won't match elevations from older agents. A signer-group entry should allow *CN-only*, *thumbprint-only*, or *CN+thumbprint*.

**The trap to avoid:** shipping (3) before (1) is fleet-wide is a foot-gun. If an admin pins a thumbprint on an `auto_approve` group while some agents still send CN-only, those agents' legitimate elevations stop matching → either fall to manual approval (annoying) or, worse, match a *different* `auto_deny`/default rule. The plan mitigates by making thumbprint an **additive optional criterion per group entry** with the editor gated/warned, never a silent global flip.

**Backward-compat invariant (do not regress):** an existing signer-group whose entries carry only a CN must keep matching exactly as today. The migration must not require a thumbprint on existing rows, and the JSONB shape change must be read-compatible with the legacy `string[]` form (see Schema below).

---

## Global Constraints

- **Node/tooling:** Prefix all `pnpm`/`vitest`/`tsx` commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict). Fresh worktrees need `pnpm install` and the gitignored `.env.test` symlink.
- **API unit tests:** `cd apps/api && PATH=… pnpm exec vitest run <path>` (NOT `pnpm test -- <path>`, which runs the whole suite). The full API suite is flaky in parallel — verify via affected files single-fork.
- **Real-DB tests** (RLS forge, ingest integration) need a real `DATABASE_URL` and the `.env.test` symlink; confirm the DB role is **not** `BYPASSRLS` (`SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user;` must be false) or forge tests pass vacuously.
- **Real-DB test placement:** real-DB tests MUST live in `apps/api/src/__tests__/integration/*.integration.test.ts` (the BLOCKING `Integration Tests` job; `breeze_app`, autoMigrate + TRUNCATE-per-test, seed fresh per `it`). The unit `test-api` job has no `DATABASE_URL`.
- **Migrations:** hand-written SQL under `apps/api/migrations/`, `YYYY-MM-DD-<slug>.sql`, idempotent (`ADD COLUMN IF NOT EXISTS` / `DO $$ … EXCEPTION`), no inner `BEGIN;`/`COMMIT;`, never edit a shipped migration. Applied by `autoMigrate` on boot/test-setup. New file sorts after `2026-06-28-pam-signer-groups.sql` → e.g. `2026-07-NN-pam-signer-thumbprint.sql` (pick the actual implementation date; it must sort after the shipped signer-groups migration).
- **No new tables → no rls-coverage allowlist change.** But re-run rls-coverage + the PAM forge integration test after the column add to prove the forced-RLS table still isolates cross-org.
- **`@breeze/shared`** has no build step — typecheck with `pnpm --filter @breeze/shared exec tsc --noEmit`. Zod validators for the elevation payload + signer-group entry live there.
- **`astro check`** (not plain `tsc`) is required for the web signer-group editor changes.
- **Go agent** code lives under `agent/` (NOT `apps/agent/`). Build/test: `cd agent && go test -race ./internal/etwlua/...`. The thumbprint-extraction path is Windows-only (`etwlua_windows.go`); guard the extraction behind the existing build-tag split and keep a no-op on non-Windows. **Windows CI runner caveat from #1771 still applies** — the extraction code can't be exercised in the current Linux CI, so unit-test the parser/formatter pure functions and validate end-to-end manually on Windows before broad rollout.
- **Constant-time compare:** thumbprint comparison should be a fixed-length, case-normalized exact compare (hex SHA-256). Prefer `crypto.timingSafeEqual` on equal-length buffers (or normalize + length-check first) over `eqCi` string compare for the secret-ish match, matching the issue's "constant-time / exact-match" guidance. (CN stays `eqCi`.)

---

## File Structure

**Create:**
- `apps/api/migrations/2026-07-NN-pam-signer-thumbprint.sql` — `ALTER TABLE pam_rules ADD COLUMN IF NOT EXISTS match_signer_thumbprint varchar(64)`; migrate `pam_signer_groups.signers` reads to the new object shape (see Schema — keep the column, evolve the `$type`, no destructive rewrite). Idempotent, no RLS change (table already forced).
- `apps/api/src/__tests__/integration/pam-signer-thumbprint-rls.integration.test.ts` — `breeze_app` cross-org forge proving the new column is still isolated (BLOCKING job). *(Reuse the existing PAM forge fixture if one exists.)*

**Modify (API):**
- `apps/api/src/db/schema/pam.ts` — add `matchSignerThumbprint: varchar('match_signer_thumbprint', { length: 64 })` to `pamRules`; evolve `pamSignerGroups.signers` `$type` from `string[]` to a discriminated entry type `SignerGroupEntry[]` that is read-compatible with legacy bare strings (a normalizer maps `string` → `{ subjectCn: string }`).
- `apps/api/src/services/pamRuleEngine.ts` — extend `PamRuleCandidate` with `targetExecutableSignerThumbprint?: string`; in `ruleMatches`, add a thumbprint branch for `matchSigner`/`matchSignerGroupId` that (a) is **present-gated**, (b) constant-time/exact-compares hex thumbprints, (c) for a group entry that pins a thumbprint, matches ONLY on thumbprint (no CN fallthrough); keep CN-only entries on `eqCi`. Update `SignerGroupResolver` type to carry entries, not bare strings.
- `apps/api/src/routes/agents/elevationRequests.ts` — add `target_executable_signer_thumbprint: z.string().regex(/^[0-9a-f]{64}$/i).optional()` to `elevationRequestSchema`; thread it into the `PamRuleCandidate` build.
- `apps/api/src/routes/pam.ts` — evolve `signerListSchema` to accept either a bare CN string (legacy, → weak tier) or `{ subjectCn?, thumbprint? }` (at least one required; thumbprint validated as 64-hex); update the signer-group preview/list resolution to pass entries; keep audit-log `signerCount`.
- `packages/shared/src/validators/*` and `packages/shared/src/types/*` — shared `SignerGroupEntry` type + Zod schema if the web editor consumes it.

**Modify (Agent — Go, ship FIRST):**
- `agent/internal/etwlua/etwlua.go` — add `TargetExecutableSignerThumbprint string \`json:"target_executable_signer_thumbprint,omitempty"\`` to `Event`.
- `agent/internal/etwlua/etwlua_windows.go` — implement leaf-cert SHA-256 extraction (replace the deferred comment at ~190-195) via WinTrust/CryptoAPI (`golang.org/x/sys/windows`); best-effort, leave empty on failure. Pure helpers (hex formatting, normalization) get unit tests; the WinTrust call is Windows-only.
- `agent/internal/etwlua/etwlua_thumbprint_test.go` (or extend existing) — table-driven tests for the pure formatter/normalizer.

**Modify (Web — ship LAST, gated):**
- `apps/web/src/components/pam/…` signer-group editor — allow adding an entry as CN, thumbprint, or both; label CN-only as the **weak tier**; warn that thumbprint entries won't match elevations from agents that don't yet report thumbprints.

---

## Schema decision (backward-compat)

Keep the `signers jsonb` column; evolve its `$type` from `string[]` to `SignerGroupEntry[]` where:

```ts
type SignerGroupEntry =
  | { subjectCn: string; thumbprint?: string }   // CN (weak) ± thumbprint (strong)
  | { thumbprint: string };                       // thumbprint-only (strong)
```

A read normalizer maps any legacy bare-string element `"Acme Corp"` → `{ subjectCn: "Acme Corp" }`, so **existing rows need no data migration** and old groups keep matching on CN. New writes use the object shape. This avoids a destructive JSONB rewrite and keeps the migration a pure additive column + (optional) a documented read-compat normalizer in app code. `pam_rules.match_signer_thumbprint` is a plain nullable `varchar(64)` alongside the existing `match_signer`.

## Engine matching rules (precise)

For a signer-group entry `e` against candidate `c`:
- `e` has `thumbprint` only → match iff `c.thumbprint` present **and** constant-time-equal (fail closed when absent).
- `e` has `subjectCn` only → match iff `c.signer` present **and** `eqCi` (unchanged legacy behavior).
- `e` has both → match iff thumbprint present-and-equal (strong) **OR**, if you choose AND-semantics for max strength, both equal. **Decision to confirm at implementation:** default to **thumbprint-required when present on the entry** (i.e. AND is the safer default for an auto-approve basis). Document the chosen semantics in the engine and test both branches.
- A group matches if **any** entry matches (unchanged), but a thumbprint-pinned entry never matches a thumbprint-less candidate.

---

## Tasks

- [ ] **T1 (agent, ship first):** Implement Windows Authenticode leaf-cert SHA-256 extraction + new optional payload field; pure-helper unit tests; manual Windows validation. Backward-compatible (older API ignores the extra field).
- [ ] **T2 (schema):** Additive migration — `pam_rules.match_signer_thumbprint`, `signers` `$type` evolution + read normalizer. Idempotent, no RLS change. Drift check (`pnpm db:check-drift`).
- [ ] **T3 (engine):** `PamRuleCandidate.targetExecutableSignerThumbprint`, `SignerGroupResolver` entries, present-gated constant-time thumbprint branch, CN unchanged; unit tests for: thumbprint match, thumbprint-pinned-but-candidate-CN-only fails closed, CN-only still matches, both-semantics.
- [ ] **T4 (ingest):** `elevationRequestSchema` + candidate threading; 64-hex validation; ingest integration test (real DB) that a thumbprint-pinned `auto_approve` group matches only with the thumbprint present.
- [ ] **T5 (routes):** `signerListSchema` accepts entries; preview/list pass entries; audit `signerCount` preserved; RBAC unchanged. Route tests.
- [ ] **T6 (RLS forge):** integration forge test proving cross-org isolation on the evolved table; re-run rls-coverage + `Integration Tests` workflow.
- [ ] **T7 (web, ship last, gated):** signer-group editor entry types + weak-tier labeling + older-agent warning; `astro check`.
- [ ] **T8 (docs):** update PAM docs (`apps/docs/`) describing the strong/weak signer tiers and the agent-version dependency.

## Verification gates

- `cd apps/api && pnpm exec vitest run src/services/pamRuleEngine.test.ts src/routes/pam.test.ts src/routes/agents/elevationRequests*.test.ts` (single-fork).
- `npx tsc --noEmit` (api) + `pnpm --filter @breeze/shared exec tsc --noEmit` + `astro check` (web).
- `cd agent && go test -race ./internal/etwlua/...`.
- `gh workflow run ci.yml --ref <branch>` to force the SKIPPED-on-PR `Integration Tests` job (RLS forge).
- Manual Windows end-to-end: trigger a UAC elevation of a signed binary; confirm the agent reports a thumbprint and a thumbprint-pinned group auto-approves, while CN-only spoof does not.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
