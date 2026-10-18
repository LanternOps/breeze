# Restore-Point Outcome Durability Across Agent Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the agent restarts, crashes, or the host shuts down while a command with a System Restore checkpoint request is in flight, the ledger row in `device_restore_point_attempts` still gets a truthful terminal outcome instead of sitting in `requested`.

**Architecture:** The agent already has a durable in-flight **command journal** (#8296, `agent/internal/heartbeat/command_journal.go`). On restart it reports every journaled command as failed through the result outbox, and graceful shutdown produces synthetic results too. None of those synthetic results carries the `restorePoint` key, so the API's ledger ingest never runs. This plan writes the checkpoint outcome into the journal entry at the checkpoint boundary. Every synthetic result then attaches it, or a new agent-reported terminal status `interrupted` when no outcome was recorded. No new wire message, no new outbox, no server reconcile protocol. The API changes only by learning one status value (CHECK-constraint migration, shared union, Zod enum, badge copy).

**Tech Stack:** Go agent (`internal/heartbeat`, `internal/systemrestore`), Hono + Drizzle + PostgreSQL, `@breeze/shared`, React web, Vitest + `go test -race`.

**Spec:** `docs/superpowers/specs/agent/2026-09-02-windows-restore-checkpoint-policy-spec.md` (parent feature #4751/#4609; W07 contract "an enabled request never vanishes without an outcome"). This plan's own decisions are in **Decisions** below. They passed an advisor quorum (own position + `codex exec` xhigh read-only). The outcome is recorded under each decision.

**Issue:** LanternOps/breeze#9163 (follow-up of W07 #4758 / PR #9160). Siblings: #9162 (PR #9190, merged) and #9165 (PR #9195, merged) are excluded. #8582 (stale `requested` sweep/UI) is a sibling spec: referenced, not duplicated.

---

## Global Constraints

1. **Ledger language.** Every surface records observations, never recoverability. The badge copy for `interrupted` must pass `apps/web/src/locales/restorePointsLanguage.test.ts` (no "restorable", "recoverable", "protected", "roll back", "safe to restore").
2. **First terminal wins.** Ingest stays an UPDATE with compare-and-set on `status = 'requested'` (`services/restorePointIngest.ts`). `interrupted` is terminal and absorbing like every other non-`requested` status. No status ever moves a row out of a terminal state.
3. **The agent never claims `created` it did not observe.** An outcome recovered after a restart is either the outcome recorded before the crash, or `interrupted`. Not `created` and not `skipped_no_mutation`, because neither the point nor the absence of a mutation was observed.
4. **Protection beats bookkeeping.** A journal write failure never blocks or skips a checkpoint, and never fails the command. The fallback is today's behavior: the row stays `requested` and #8582 handles it.
5. **Do not touch** `apps/api/src/services/commandTimeouts.ts`, the stamp logic in `apps/api/src/jobs/staleCommandReaper.ts`, or `agent/internal/remote/tools/software_install_restorepoint.go` (#9162/#9165 files). The design deliberately reaches the software-install path through package `systemrestore`, so that file needs no edit.
6. **Migration naming:** slot `apps/api/migrations/2026-12-31-234500-restore-point-interrupted.sql`. The newest committed migration is `2026-12-31-170000-m365-consent-sessions-v2-only.sql`, and slots 210000/220000/230000/233000/234000 are reserved. Re-run `ls apps/api/migrations/*.sql | sort | tail -3` on fresh `origin/main` before every push. If the pre-push `scripts/check-migration-naming.sh` rejects the slot, take the next free `HHMMSS` and note it in the PR. Idempotent, no inner `BEGIN;`/`COMMIT;`, no row writes (so no `breeze.scope` election is needed). Never edit `2026-12-24-160000-device-restore-point-attempts.sql` or `2026-12-31-110000-restore-point-skipped-no-mutation.sql`.
7. **Tenancy:** a status-only CHECK change adds **no column**. That means no `CORE_TENANT_EXPORT_POLICY` edit (`services/tenantExportPolicyRegistry.ts` L410 already lists every column as `included`). The cascade/merge lists already cover the table (`services/tenantCascade.ts` L603, `routes/devices/core.ts` L351/449/696, `services/orgMergeRegistry.ts` L967). Re-grep them in Task 1 and state it in the PR. If any task adds a column, it must classify that column (typed → `included`, never jsonb).
8. **CI traps.** `pnpm test` skips the RLS/integration suites. Run `restorePointIngest.integration.test.ts` and `deviceRestorePointAttemptsRls.integration.test.ts` on a per-worktree test stack (`docs/agents/testing.md`). Never `pnpm --filter <pkg> test -- --run <path>`. Vitest path filters are substring matches, so list files explicitly and check the file count. Run `tsc --noEmit` with `NODE_OPTIONS=--max-old-space-size=12288` and read the exit code; never pipe it to `tail`.
9. **New locale key → all 8 locales** (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`). Web parity lives in `apps/web/src/lib/i18n/localeParity.test.ts`; API parity in `apps/api/src/i18n/localeParity.test.ts` is unaffected.
10. **Release coupling.** W07 (#9160, merged 2026-10-18) is unreleased. The agent half of this plan should ship in the **same agent release** as W07, so no released agent reports outcomes without the journal. The residual transport gaps W5/S1/O1 remain. **HARD:** the API half must be deployed before that agent release is promoted (see D4).

## Decisions

### D1. Mechanism: extend the #8296 command journal (agent-durable), no server reconcile-on-start

**Chosen:** persist the checkpoint outcome in the existing in-flight journal entry and attach it to every synthetic result. Rejected alternatives:

- *A new restore-point outbox* (the backup/PAM pattern). The result outbox already exists (`backup_result_outbox.go`, keyed by command id, flushed on every connect). So does the journal's restart recovery (`Recover`, run in `New` before the first connect, `heartbeat.go` ~L1158). A second store would duplicate both and race them on the same command id.
- *Server reconcile-on-start* (the agent says "I have no record of attempt X"). This needs a new message and a server-side list of expected request ids per device. "No record" is also ambiguous: old agent, wiped state dir, reinstall. The journal already turns "the previous process died running command C" into a synthetic result for C. The missing piece is only that the result omits the outcome.

**How the outcome reaches the journal:** package `systemrestore` gets a process-wide `Observer` that `Checkpoint.Take`/`Skip` (and `Report`'s first `skipped_no_mutation` synthesis) call. Heartbeat installs it once in `New`. It routes by request id to the journal entry that `Begin` indexed from the payload's `restorePoint` block. A package-level observer means the software-install path in `remote/tools` (which cannot import `heartbeat`) is covered without editing its files.

**Crash windows** (the "Then" column is what the ledger row ends as):

| Window | What exists on disk at restart | Then |
|---|---|---|
| W0: before `journal.Begin` writes (or the Begin write failed) | nothing | unchanged: no result, command reaped, row `requested` → #8582 |
| W1: after Begin, before `Take` calls the OS | journal entry with request id, no outcome | `Recover` looks the point up by description: none → `interrupted` |
| W2: inside `SRSetRestorePointW` / verification, before the outcome is persisted | same as W1 | lookup finds our description → `interrupted` with `sequenceNumber` + `description`; not found / lookup failed → `interrupted` |
| W3: outcome persisted, result not yet handed off | journal entry with outcome | synthetic failure carries the recorded outcome (e.g. `created`) |
| W4: real result written to the outbox, journal not yet ended | outbox entry (carries `Report()`) | real result wins (existing `outbox.has` check). `has` is existence-only, so if the entry turns out corrupt it is dropped at flush and the command is reaped → #8582. Task 5 adds fsync to `Enqueue` so a power cut cannot leave a zero-length entry |
| W5: result queued on the WS channel then hard crash, or frame written but never committed server-side | journal ended, nothing | whole command result lost. This is a pre-existing #8296 gap for every command type, out of scope. Row `requested` → #8582 |
| G1: graceful stop, handler still running | synthetic "agent is shutting down" result (refused by the stopped client → outboxed under the command id; journal entry **not** ended because `executed=false`) | the synthetic result carries the in-memory recorded outcome or `interrupted`. If the handler then finishes before exit, its real result overwrites the same outbox file (`entryPath(commandID)`) and wins. If the process exits first, `Recover` (D3) **amends** the outboxed synthetic result with an outcome the journal recorded after it was written |
| G2: host reboot mid-command | as W1–W3 | as W1–W3. Journal restore-point writes are fsync'd so a power-cut does not lose them |

Two further windows are recorded for #8582, not fixed here:

- **S1 (server):** the `device_commands` CAS commits, then the API crashes or the ledger write fails before ingest (`routes/agentWs.ts` ~L2708–2735). A replay then exits as `stale` before ingest, and the row stays `requested`.
- **O1 (outbox bounds):** the result outbox caps at 20 pending entries and expires them at 48 h (`backup_result_outbox.go`). A device offline that long can still drop a synthetic result. Task 5 makes the journal→outbox transfer fsync'd, but the caps stay.

**Ordering and locking rules (Task 4 owns them):**

- Observer callbacks take only `j.mu`. The journal never takes the checkpoint's mutex, so there is no lock inversion with `Take`, which holds `c.mu` across the uncancellable native call.
- The shutdown path reads the **journal snapshot** (`syntheticRestorePoint`). It never calls `cp.Report()`, because `Report` would block on `c.mu` behind `SRSetRestorePointW` and hang shutdown.
- A late callback for an ended entry is a no-op and never re-creates the file.
- A request id already bound to a different command id is refused (Warn), so the first binding wins.

**Quorum:** AGREE. Codex (gpt-6-astra, xhigh, read-only) agreed with the journal extension and added safeguards, all adopted:

- serialize the observer against `End`;
- reject conflicting bindings;
- observe `Report()`'s synthesized `skipped_no_mutation` too;
- use one aggregate lookup deadline;
- rebuild descriptions only through `buildDescription`;
- fsync the outbox transfer.

Its strongest objection was the G1 race. It is accepted and documented: `interrupted` means "the outcome was unknown when reporting was abandoned", even if the checkpoint completes later and the command CAS then suppresses the real result.

### D2. Status: one new agent-reported terminal status `interrupted`; no `lost`; do not reuse `failed`

- `interrupted` means: "the agent stopped (restart, crash, shutdown) before it reported this checkpoint's outcome. Whether a restore point exists is unknown unless a sequence number is attached." Badge tone `warning` (actionable: check the device), copy in Task 2.
- **Not `failed` + message.** `failed` means the native call failed or state was unreadable. A tech reading it chases the System Restore service, which is the wrong action. `failed` + `RESTORE_POINT_SUPERSEDED_MESSAGE` already overloads the status, and ingest has to string-match it to explain a discard (`restorePointIngest.ts`). That is the anti-pattern not to repeat. `skipped_no_mutation` (#9160) was added as a distinct status for exactly this mislabel reason.
- **No `lost` here.** A server-derived "agent has no record" status would come from either (a) a terminal result that lacks the `restorePoint` key, or (b) the command being reaped with no result. Both are inferences about stale `requested` rows, which is #8582's decision. Recommendation recorded for #8582: **do not infer from key absence alone, even with a version gate.** The device's *current* version does not prove which version ran a historical command, and some synthetic results legitimately carry no outcome (a pool-full rejection of a duplicate delivery, S1). A time- or reaper-based treatment is safer.
- **Precedence.** All terminal statuses are absorbing (CAS on `requested`). Interactions:
  - `supersedeStaleRestorePoint` writes `failed` only on a still-`requested` row at delivery time. The agent never saw that request id, so it cannot report on it.
  - The stale-command reaper does not write the ledger.
  - `existing_accepted` recorded before a crash is replayed as `existing_accepted`. Recorded outcomes always beat `interrupted` on the agent side (D3 amend), never on the server side.
- **Exposure:**
  - The AI tool `services/aiToolsRestorePoints.ts` builds its `status` filter enum from `RESTORE_POINT_ATTEMPT_STATUSES`, so it picks the value up automatically. A test pins it. No route or tool shape changes, so `mcp-coverage` is not affected.
  - Retention (`jobs/restorePointAttemptRetention.ts`) treats every non-`requested` status as terminal, so no change.
  - `routes/devices/restorePoints.ts` and `services/restorePointInline.ts` pass `status` through untyped, so no change. A test confirms.

### D3. Idempotency and dedupe

- **Server:** unchanged. A replayed or duplicate synthetic result loses the `device_commands` terminal CAS (`finalized === 'stale'`) and never reaches ingest. If it does reach ingest, the ledger CAS on `requested` matches 0 rows (`already_terminal`).
- **Agent, one request id → no second OS checkpoint while Windows still lists the first.**
  - **The suffix carries the full request id.** `buildDescription` for a **stamped** request changes from the first 8 characters to the **full request UUID**: `" [" + requestId + "]"`, 39 of the 200-rune budget, with the label truncated to fit. Eight hex characters are only 32 bits of identity, so two requests with the same label and a colliding prefix would be falsely deduped. W07 is unreleased, so no fielded point uses the short form. The legacy nonce path is unchanged.
  - **The dedupe check.** In `systemrestore.createWith`, the pre-call snapshot (`before`, already read under the VSS gate) is checked for a point whose description **exactly equals** `buildDescription(req)`. If one exists, **do not call `SRSetRestorePointW`**. Report **`interrupted`** carrying that point's `sequenceNumber` and `description`, with the message "a restore point for this request already exists from an earlier attempt whose completion was not confirmed; no new point was created".
  - **Not `existing_accepted`** (quorum correction). A matching point can survive a failed or never-issued END_SYSTEM_CHANGE, and `Create` itself reports `failed` when END fails even if WMI finds the point (`create.go` ~L158). A retry must not upgrade that to an accepted observation.
  - **Why Windows' gate is no substitute.** Windows' frequency gate (`SystemRestorePointCreationFrequency`, default 1440 min) is not a dedupe: an admin can set it to 0, and inside the window Windows reuses *some* point, not ours.
  - **Limits.** This dedupe is bounded by Windows retention: VSS can purge the earlier point, and then a redelivery creates a new one. That is acceptable, because the earlier point is gone. In practice the ledger row is usually already terminal from `Recover`, so this outcome is a CAS no-op; its job is to avoid the duplicate point.
- **Quorum:** Codex DISAGREED with the first draft, which reported `existing_accepted` and kept the 8-char suffix. Both corrections were adopted on the merits (above). No open disagreement remains for Todd.
- **Agent, journal recovery amend:** in `Recover`, when `outbox.has(commandID)` and the journal entry holds a recorded outcome, rewrite the outboxed result's `restorePoint` **only if** it is absent or `interrupted` (G1). Never overwrite a non-`interrupted` outcome.

### D4. Wire and version skew

- **Wire:** no new message, no new field. `Outcome.Status` gains one value, `"interrupted"`. `sequenceNumber`/`description` are already optional fields.
- **No `MIN_AGENT_VERSION_*` constant in this plan.** No server behavior is conditioned on agent version, and stamping is unchanged. (Pattern if #8582 needs one: `MIN_AGENT_VERSION_YARA_SCAN` in `services/yaraScanRefs.ts`.)
- **New API + old agent:** unchanged. Pre-W07 agents never report. A W07-without-this agent omits the key on synthetic results, so the row stays `requested` → #8582.
- **Old API + new agent:** `interrupted` fails `classifyRestorePointOutcome` as `unknown_status`. Sentry gets `restore_point_outcome_unknown_status`, but the outer command result is still accepted and the command goes terminal. **Upgrading the API afterward does not repair the row**, because a replay then loses the command CAS. **API-first is therefore a HARD sequencing requirement** (Global Constraint 10): PR 1 deployed to every hosted environment before the agent release carrying PR 2 is promoted. Self-hosters get the agent from their own API's promote, so they cannot normally run ahead.
- **Agent upgrade/downgrade with journal files on disk:** the new journal fields are `omitempty` JSON. An old binary reading a new entry ignores them. A new binary reading an old entry sees no request id and attaches nothing (today's behavior).

### D5. Windows lab gate (owner-run, NOT part of this plan's execution)

Before promoting the agent release, on a Windows VM with System Protection on and a `system_protection` policy enabling "before scripts":

1. Kill the agent (`taskkill /F`) while a script command's checkpoint is inside `SRSetRestorePointW` (W2). After restart the row is `interrupted` with the sequence number Windows lists.
2. Kill it after the checkpoint and before the script finishes (W3). The row shows the true outcome (`created`/`existing_accepted`).
3. Reboot the host mid-patch-install (G2). After boot the row is not `requested`.
4. Graceful `sc stop` mid-script (G1). The row is the real outcome if the handler finished, else `interrupted`.
5. Replay: block the API during restart, reconnect, and confirm one ledger write and no duplicate checkpoint (`Get-ComputerRestorePoint` count is unchanged on a second delivery of the same request id).
6. Replay after the earlier point was deleted (`vssadmin delete shadows` / System Protection "Delete"). A new point is created and reported normally.

The deterministic races are covered by fault-injection unit tests in Tasks 4–6, not by the lab: shutdown during BEGIN/END (a blocking fake `create`), persistence racing `End`, simultaneous duplicate delivery, lookup timeout, and failed journal/outbox writes.

Record results on #9163. Lab recipe: `docs/superpowers/plans/agent/2026-09-02-windows-restore-checkpoint-policy.md` W01.

## Review Focus

1. **Graceful stop while `SRSetRestorePointW` is still running** (G1): the outboxed synthetic result must carry `interrupted`, and a later recorded outcome must replace it at the next start. Pinned in Task 5 (`TestCommandJournal_RecoverAmendsOutboxedInterruptedWithRecordedOutcome`).
2. **A journal write that fails** (full disk, permissions) must not skip the checkpoint or fail the command. Pinned in Task 4 (`TestJournalObserver_PersistFailureStillTakesCheckpoint`).
3. **A second delivery of the same command** (duplicate, `Abandon`ed checkpoint) must not overwrite the running execution's journal outcome. Pinned in Task 4 (`TestJournalObserver_AbandonedCheckpointRecordsNothing`).
4. **Recover's WMI lookup hanging** must not hold agent startup past its budget. Pinned in Task 5 (`TestCommandJournal_RecoverLookupIsBounded`).
5. **Pool-full synthetic results.** When the journal has an **active** entry for the command id, this is a duplicate delivery of a running execution, so attach **no** outcome (it would race the real one). When there is no active entry, the command never ran in this process, so attach `skipped_no_mutation` for a stamped, enabled block (truthful: nothing was changed). Pinned in Task 5 (`TestExecuteViaPool_PoolFullDuplicateAttachesNothing`, `TestExecuteViaPool_PoolFullFirstDeliveryReportsSkippedNoMutation`).

---

## File Structure

**PR 1: server half** (`feat(restore-point): interrupted outcome status (#9163)`). The shared union is exhaustively mapped in `RestorePointBadge.tsx` (`Record<RestorePointStatus, …>`), so shared + web must land together, or web typecheck breaks. That is why this is one PR, not separate API and web PRs. Tasks 1 and 2 are still file-disjoint and can be done by different implementers.

| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-12-31-234500-restore-point-interrupted.sql` (create) | drop + re-add `device_restore_point_attempts_status_chk` with `'interrupted'` |
| `apps/api/src/db/schema/deviceRestorePointAttempts.ts` | `RESTORE_POINT_ATTEMPT_STATUSES` + the `check()` SQL |
| `packages/shared/src/types/restorePoint.ts` | `RESTORE_POINT_STATUSES` |
| `apps/api/src/routes/agents/schemas.ts` (~L634) | `RESTORE_POINT_OUTCOME_STATUSES` |
| `apps/web/src/components/restorePoints/RestorePointBadge.tsx` + 8× `apps/web/src/locales/*/restorePoints.json` | `interrupted` entry + `badge.interrupted` copy |

**PR 2: agent half** (`fix(agent): restore-point outcome survives agent restart (#9163)`). File-disjoint from PR 1 and independently mergeable (Go has no compile dependency on the TS union). It must not be **released** before PR 1 is **deployed**.

| File | Responsibility |
|---|---|
| `agent/internal/systemrestore/types.go` | `StatusInterrupted` + `Terminal()` |
| `agent/internal/systemrestore/observer.go` (create) | `Observer` interface, `SetObserver`, `notifyStarting`/`notifyRecorded` |
| `agent/internal/systemrestore/checkpoint.go` | call the observer from `Take`/`Skip`; exported `Interrupted(...)` constructor |
| `agent/internal/systemrestore/create.go` | same-description dedupe in `createWith` |
| `agent/internal/systemrestore/lookup.go` (create) | `FindByDescription` for Recover |
| `agent/internal/heartbeat/command_journal_restorepoint.go` (create) | journal ↔ observer bridge: request-id index, persisted outcome, `syntheticRestorePoint` |
| `agent/internal/heartbeat/command_journal.go` | entry fields; `Recover` attaches/amends outcome |
| `agent/internal/heartbeat/backup_result_outbox.go` | `amendRestorePoint(commandID, outcome)` |
| `agent/internal/heartbeat/heartbeat.go` (~L1158, ~L7268–7290) | install observer before `Recover`; attach outcome on the two shutdown synthetic results |

`command_journal.go` is 287 lines today. The restore-point bridge goes in its own file to keep both under ~500.

---

## Task 1: `interrupted` in the ledger (migration, schema, shared, Zod)

**Files:**
- Create: `apps/api/migrations/2026-12-31-234500-restore-point-interrupted.sql`
- Modify: `apps/api/src/db/schema/deviceRestorePointAttempts.ts`, `packages/shared/src/types/restorePoint.ts`, `apps/api/src/routes/agents/schemas.ts`
- Test: `packages/shared/src/types/restorePoint.test.ts`, `apps/api/src/routes/agents/restorePointResultSchema.test.ts`, `apps/api/src/services/restorePointIngest.test.ts`, `apps/api/src/services/aiToolsRestorePoints.test.ts` (extend `applies optional trigger and status filters`), `apps/api/src/__tests__/integration/restorePointIngest.integration.test.ts`

**Interfaces:**
- Produces: `'interrupted'` as a member of `RestorePointStatus`, `RestorePointAttemptStatus`, and `RestorePointOutcome['status']`. Task 2 renders it and Task 3 emits it.

- [ ] **Step 1: Write the failing tests**
  - shared: in `restorePoint.test.ts`, update the existing `toHaveLength(11)` to `12` and add `'interrupted'` after `'failed'` in its `toEqual` list. `'requested'` stays first.
  - `restorePointResultSchema.test.ts`: `classifyRestorePointOutcome({status:'interrupted', requestId:<uuid>, attemptedAt:'2026-10-18T00:00:00Z', durationMs:0})` → `{ok:true}`. The same with `sequenceNumber:'42', description:'Breeze: x [abcd1234]'` keeps both fields.
  - `restorePointIngest.test.ts`: an `interrupted` outcome sets `status:'interrupted'`, `acceptedExistingPoint:false`, `sequenceNumber: 42n` when supplied, and the WHERE still includes `status = 'requested'`.
  - Schema parity: the existing check in `restorePointResultSchema.test.ts` pinning `RESTORE_POINT_ATTEMPT_STATUSES` and `RESTORE_POINT_OUTCOME_STATUSES` against the shared list passes with all three lists updated.
  - AI tool: the `status` enum in the tool's input schema includes `'interrupted'`.
  - Integration: inserting a row with `status='interrupted'` succeeds. `status='lost'` still violates `device_restore_point_attempts_status_chk`. Ingest of an `interrupted` outcome terminalises a `requested` row, and a second ingest returns `{outcome:'discarded', reason:'already_terminal'}`.

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/routes/agents/restorePointResultSchema.test.ts src/services/restorePointIngest.test.ts` (2 files reported) and `cd packages/shared && npx vitest run src/types/restorePoint.test.ts`. Expected: unknown-status and enum assertions fail.

- [ ] **Step 3: Implement.** Append `'interrupted'` after `'failed'` in all three constant lists and in the Drizzle `check()` SQL. Migration header: `-- Add 'interrupted' to the device_restore_point_attempts status CHECK (#9163). Fix-forward; no column, no table: no cascade/export-policy change.` The body is the `2026-12-31-110000` shape (`DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT … CHECK (status IN (…, 'failed', 'interrupted'))`). Update the doc comment on `RESTORE_POINT_STATUSES` to name `interrupted` as agent-reported, "outcome unknown after an agent restart".

- [ ] **Step 4: Run unit tests, expect PASS.** Then `pnpm db:check-drift` (expect no drift), `scripts/check-migration-naming.sh --against-ref origin/main` (expect exit 0), and re-grep the cascade lists (Global Constraint 7) and paste the hits into the PR body.

- [ ] **Step 5: Integration on a wt-stack** — `restorePointIngest.integration.test.ts` and `deviceRestorePointAttemptsRls.integration.test.ts` (commands per `docs/agents/testing.md`). Expected: both green, counts quoted in the PR.

- [ ] **Step 6: Commit** `feat(restore-point): interrupted ledger status (#9163)`.

## Task 2: Badge copy for `interrupted` (PR 1, web; file-disjoint from Task 1)

**Files:**
- Modify: `apps/web/src/components/restorePoints/RestorePointBadge.tsx`, `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/restorePoints.json`
- Test: `apps/web/src/components/restorePoints/RestorePointBadge.test.tsx`, `apps/web/src/components/devices/DeviceRestorePointAttempts.test.tsx`

**Interfaces:** Consumes `'interrupted'` from Task 1.

- [ ] **Step 1: Failing tests.** The badge with `{status:'interrupted'}` renders `data-tone="warning"` and the text `Unknown — the agent stopped before it could report this restore point`. The attempts list renders a row with status `interrupted` using the same text, not the `badge.unknown` fallback.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/restorePoints/RestorePointBadge.test.tsx src/components/devices/DeviceRestorePointAttempts.test.tsx`. Expect FAIL (typecheck already fails once Task 1 lands: `STATUS_MAP` is not exhaustive).
- [ ] **Step 3: Implement** `interrupted: { tone: 'warning', text: (t) => t('badge.interrupted') }` and the `badge.interrupted` key. en: **"Unknown — the agent stopped before it could report this restore point"**. Translate the same meaning into the 7 other locales, with no recoverability wording.
- [ ] **Step 4: Run** the two tests plus `src/lib/i18n/localeParity.test.ts` and `src/locales/restorePointsLanguage.test.ts`, then `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p apps/web`. Read the exit code (expect 0).
- [ ] **Step 5: Commit** `feat(web): interrupted restore-point badge (#9163)`.

## Task 3: `interrupted` status and the observer seam in `systemrestore` (PR 2)

**Files:**
- Modify: `agent/internal/systemrestore/types.go`, `agent/internal/systemrestore/checkpoint.go`, `agent/internal/systemrestore/create.go` (`buildDescription` suffix only)
- Create: `agent/internal/systemrestore/observer.go`
- Test: `agent/internal/systemrestore/types_test.go`, `agent/internal/systemrestore/checkpoint_test.go`, `agent/internal/systemrestore/observer_test.go` (create)

**Interfaces:**
- Produces:
  - `const StatusInterrupted Status = "interrupted"`, included in `Terminal()`.
  - `type Observer interface { Starting(req Request); Recorded(o Outcome) }`.
  - `func SetObserver(o Observer)`: process-wide, set once at startup; nil = no-op. The value is held in an `atomic.Pointer`; tests restore it with `t.Cleanup`.
  - `func Interrupted(requestID, message string, now time.Time) Outcome`: `Status: StatusInterrupted`, `AttemptedAt` = now RFC3339Nano, `DurationMs: 0`.
  - `func DescriptionFor(req Request) string`: exported wrapper of `buildDescription` for a **stamped** request (empty when `RequestID == ""`).
  - `func (c *Checkpoint) RequestID() string`: empty unless requested **and** stamped.

- [ ] **Step 1: Failing tests.**
  - `TestStatusInterruptedIsTerminal`.
  - `TestCheckpoint_TakeNotifiesStartingThenRecordedOnce`: a fake observer sees `Starting` (with the request) before `create` runs, then exactly one `Recorded` with the created outcome. A second `Take` notifies nothing.
  - `TestCheckpoint_SkipNotifiesRecorded`.
  - `TestCheckpoint_UnstampedOrAbandonedNotifiesNothing`: an unstamped legacy patch request and an `Abandon`ed checkpoint produce zero calls.
  - `TestCheckpoint_ReportSynthesisNotifiesRecordedOnce`: the first `Report()` that synthesizes `skipped_no_mutation` stores it as the outcome and calls `Recorded` once. A crash between the handler returning and the hand-off then replays `skipped_no_mutation`, not `interrupted` (quorum). Later `Report()` calls return the stored copy without notifying.
  - `TestDescriptionFor_StampedUsesFullRequestID`: suffix `" [" + requestId + "]"`, total ≤ 200 runes and ≤ 255 UTF-16 units with a 300-rune label. Legacy (empty id) keeps the 8-hex nonce.
- [ ] **Step 2: Run** `cd agent && go test -race ./internal/systemrestore/ -run 'Interrupted|Notif|Observer'`. Expect FAIL (undefined).
- [ ] **Step 3: Implement.**
  - In `Take`, call `Starting` **before** `c.create`, and `Recorded` after the outcome is stored, both under `c.mu` so ordering per checkpoint is total.
  - `Skip`, and `Report`'s first synthesis, call `Recorded` when they store an outcome. `Report` now stores the synthesized outcome in `c.outcome`, so a later `Take` returns it without creating. This is safe because `Report` runs only on the handler's exit path, after its last possible `Take`.
  - No observer call when `!c.stamped` or `c.abandoned`.
  - `buildDescription` takes the full request id for a stamped request (Task 6 relies on this).
  - Observer calls must not block on I/O longer than one fsync'd file write (documented on the interface).
- [ ] **Step 4: Run, expect PASS**, plus the full `go test -race ./internal/systemrestore/...`.
- [ ] **Step 5: Commit** `feat(agent): systemrestore interrupted status and outcome observer (#9163)`.

## Task 4: Journal records the checkpoint outcome (PR 2)

**Files:**
- Create: `agent/internal/heartbeat/command_journal_restorepoint.go`, `agent/internal/heartbeat/command_journal_restorepoint_test.go`
- Modify: `agent/internal/heartbeat/command_journal.go` (entry struct + `Begin`), `agent/internal/heartbeat/heartbeat.go` (~L1158: `systemrestore.SetObserver(h.commandJournal)` **before** `Recover`)

**Interfaces:**
- Consumes: Task 3's `Observer`, `Request`, `Outcome`, `DescriptionFor`, `ParseRequest`.
- Produces:
  - `commandJournalEntry` gains `RestorePoint *journalRestorePoint \`json:"restorePoint,omitempty"\``.
  - `type journalRestorePoint struct { RequestID string \`json:"requestId"\`; Description string \`json:"description,omitempty"\`; Outcome *systemrestore.Outcome \`json:"outcome,omitempty"\` }`.
  - `(*commandJournal).Starting(req)` and `(*commandJournal).Recorded(o)` satisfy `systemrestore.Observer`.
  - `func (j *commandJournal) syntheticRestorePoint(commandID string, why string) *systemrestore.Outcome`: the recorded outcome if any, else `systemrestore.Interrupted(requestID, why, j.nowFn())`. Returns nil when the entry has no request id.

- [ ] **Step 1: Failing tests.**
  - `TestCommandJournal_BeginIndexesStampedRestorePoint`: Begin of a `script` command whose payload carries an enabled v1 block writes `restorePoint.requestId` into the file. No block, `enabled:false`, or `v:2` → no `restorePoint` key.
  - `TestJournalObserver_RecordedPersistsOutcome`: after `Recorded(created outcome)`, the on-disk entry holds the outcome (read the file back).
  - `TestJournalObserver_PersistFailureStillTakesCheckpoint`: with the journal dir read-only, a `Checkpoint.Take` through the observer still calls `create` once and returns its outcome.
  - `TestJournalObserver_AbandonedCheckpointRecordsNothing`.
  - `TestJournalObserver_UnknownRequestIDIsNoop`: `Recorded` for a request id not indexed (an ended entry, a non-UUID software path) touches no file.
  - `TestJournalObserver_LateRecordedAfterEndDoesNotResurrect`: `End(cmd)` then `Recorded(outcome)` → no file exists for `cmd`.
  - `TestJournalObserver_RecordedRacingEnd`: 100 iterations of concurrent `Recorded` and `End` under `-race` → the final state is "no file" or "file with the outcome". Never a partial file, and never a file after `End` returned.
  - `TestCommandJournal_ConflictingRequestBindingRefused`: Begin of command B carrying the request id already bound to A → B's entry has no `restorePoint`, and A's binding is unchanged.
  - `TestJournalObserver_ShutdownSnapshotDoesNotBlockOnTake`: a fake `create` blocked inside `Take` → `syntheticRestorePoint` returns `interrupted` within 100 ms.
- [ ] **Step 2: Run** `go test -race ./internal/heartbeat/ -run 'CommandJournal|JournalObserver'`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - `Begin` parses with `systemrestore.ParseRequest(cmd.Payload, false)` and records only when the block is v1, enabled, and has a UUID `requestId`. The `legacyDefaultEnabled` value is irrelevant here because only a stamped block yields an id.
  - Keep `byRequest map[string]string` (requestId → commandID) under `j.mu`, removed in `endLocked`.
  - `Starting` persists `Description`. `Recorded` persists `Outcome`.
  - Both rewrite the entry with temp + `Sync` + rename (the `pamReconciliationOutbox.writeFn`/`syncFn` shape). On error they log at Warn and keep the in-memory copy (Global Constraint 4).
- [ ] **Step 4: Run, expect PASS**, plus the existing `go test -race ./internal/heartbeat/ -run 'CommandJournal|Restorepoint|RestorePoint'` (the W07 handler tests must stay green).
- [ ] **Step 5: Commit** `fix(agent): journal records the restore-point outcome (#9163)`.

## Task 5: Synthetic results carry the outcome; Recover attaches, looks up, and amends (PR 2)

**Files:**
- Modify: `agent/internal/heartbeat/command_journal.go` (`Recover`), `agent/internal/heartbeat/backup_result_outbox.go` (`amendRestorePoint`), `agent/internal/heartbeat/heartbeat.go` (the `stopChan` and `pool.Context().Done()` branches of `executeCommandViaPoolReportingDelivery`)
- Create: `agent/internal/systemrestore/lookup.go`, `agent/internal/systemrestore/lookup_test.go`
- Test: `agent/internal/heartbeat/command_journal_restorepoint_test.go`, `agent/internal/heartbeat/command_journal_test.go`

**Interfaces:**
- Consumes: Task 4's `syntheticRestorePoint`, `journalRestorePoint`.
- Produces:
  - `func FindByDescription(ctx context.Context, description string) (sequence string, createdAt time.Time, found bool, err error)` in `systemrestore`: Windows → `listRestorePoints`; other OS → `found=false, err=ErrUnsupported`.
  - `var recoverLookup = systemrestore.FindByDescription` and `const recoverLookupBudget = 10 * time.Second` (a **total** budget across all entries) in `heartbeat`.
  - `func (o *backupResultOutbox) amendRestorePoint(commandID string, rp *systemrestore.Outcome) bool`: rewrites only when the stored result's `RestorePoint` is nil or `interrupted`.

- [ ] **Step 1: Failing tests.**
  - `TestCommandJournal_RecoverAttachesRecordedOutcome`: an entry with outcome `created` → the outboxed synthetic failure has `RestorePoint.Status == "created"` and the same request id.
  - `TestCommandJournal_RecoverReportsInterruptedWithFoundPoint`: an entry without an outcome, and a lookup fake returning `("42", t0, true, nil)` → `interrupted` with `SequenceNumber "42"` and `Description` set.
  - `TestCommandJournal_RecoverReportsInterruptedWhenLookupFails`: the lookup returns an error → `interrupted` with no sequence. The message says the outcome is unknown.
  - `TestCommandJournal_RecoverLookupIsBounded`: a lookup fake that blocks until ctx is done; `Recover` returns within `recoverLookupBudget` + 1 s.
  - `TestCommandJournal_RecoverAmendsOutboxedInterruptedWithRecordedOutcome`: outbox holds a synthetic result with `interrupted`, journal holds `created` → the outbox now holds `created` and the journal entry is removed.
  - `TestCommandJournal_RecoverNeverOverwritesARealOutcome`: outbox holds `existing_accepted`, journal holds `created` → unchanged.
  - `TestCommandJournal_RecoverOldEntryWithoutRestorePointUnchanged`: an entry without the field → a synthetic failure with no `restorePoint` (today's bytes).
  - `TestExecuteViaPool_ShutdownAttachesRestorePoint`: a running script with a stamped block plus `stopChan` closed → the synthetic result has `RestorePoint.Status == "interrupted"`. With a recorded outcome, it carries that outcome.
  - `TestExecuteViaPool_PoolFullDuplicateAttachesNothing`: journal active for `cmd.ID` → `RestorePoint == nil`.
  - `TestExecuteViaPool_PoolFullFirstDeliveryReportsSkippedNoMutation`: not active, with a stamped enabled block → `skipped_no_mutation` with the block's request id. Unstamped → nil.
  - `TestBackupResultOutbox_EnqueueSyncsBeforeRename`: through a `syncFn` seam, `Sync` is called on the temp file before `Rename`.
  - `TestCommandJournal_RecoverAmendOfCorruptOutboxEntryReenqueues`: an outbox entry that fails to parse → replaced by a fresh synthetic failure carrying the journal outcome.
  - `lookup_test.go`: exact-match only (a description with a different label but the same `[abcd1234]` suffix is not found).
- [ ] **Step 2: Run** `go test -race ./internal/heartbeat/ ./internal/systemrestore/ -run 'Recover|ExecuteViaPool|FindByDescription'`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - In `Recover`: for an `outbox.has` hit, call `amendRestorePoint` when the entry has an outcome. Otherwise build the synthetic result as today, plus `RestorePoint`:
    - recorded outcome → that outcome;
    - otherwise, one `recoverLookup(ctx, Description)` under a single `context.WithTimeout(recoverLookupBudget)` shared by every entry → `Interrupted(...)`, with `SequenceNumber`/`Description` when found.
  - Message copy (agent → ledger `message`): `"the agent restarted before it reported this checkpoint's outcome"` (+ `"; Windows lists restore point <seq> with this request's description"` when found).
  - Shutdown branches: `RestorePoint: h.commandJournal.syntheticRestorePoint(cmd.ID, "the agent shut down before it reported this checkpoint's outcome")`.
  - Pool-full branch: implement the Review Focus 5 rule through `func (j *commandJournal) isActive(commandID string) bool`. The synthesized outcome uses message `"the agent's worker pool was full; the command did not run"`.
  - `backupResultOutbox.Enqueue`: write the temp file, `Sync`, close, rename (the `pamReconciliationOutbox` `syncFn` seam shape). Every outboxed result gets this; the cost is one fsync per outboxed result.
- [ ] **Step 4: Run, expect PASS**, then the whole `go test -race ./internal/heartbeat/... ./internal/systemrestore/...` and `GOOS=windows go vet ./internal/systemrestore/ ./internal/heartbeat/`.
- [ ] **Step 5: Commit** `fix(agent): synthetic results carry the restore-point outcome (#9163)`.

## Task 6: Same-request dedupe in `Create` (PR 2)

**Files:**
- Modify: `agent/internal/systemrestore/create.go`
- Test: `agent/internal/systemrestore/create_test.go`

**Interfaces:** none new. `Create`'s contract gains: "a point already carrying this request's exact description is reported `interrupted` (with its sequence and description) without a native call". This depends on Task 3's full-UUID description.

- [ ] **Step 1: Failing tests.**
  - `TestCreate_SameRequestDescriptionAlreadyPresent_NoNativeCall`: `before` contains `{Seq: 7, Description: buildDescription(req), CreationTime: now-30m}` → `native.begin` call count 0, `Status interrupted`, `SequenceNumber "7"`, `Description` equal to that description, and the message from D3.
  - `TestCreate_UnstampedLegacyNeverDedupes`: empty `RequestID` → begin is called once.
  - `TestCreate_DifferentLabelSameRequestIDStillCreates`: a different label means a different exact description → begin is called once.
  - `TestCreate_SameLabelDifferentRequestIDStillCreates`: two UUIDs sharing the first 8 characters → begin is called once (the full-UUID suffix prevents false dedupe).
- [ ] **Step 2: Run** `go test -race ./internal/systemrestore/ -run TestCreate_`. Expect FAIL.
- [ ] **Step 3: Implement** inside the gated closure, right after `before` is built: when `req.RequestID != ""` and some row's `Description == desc`, return the D3 `interrupted` outcome. Not `existing_accepted`: completion of the earlier attempt's END was never observed.
- [ ] **Step 4: Run, expect PASS** (full package).
- [ ] **Step 5: Commit** `fix(agent): one restore point per request id across restarts (#9163)`.

---

## Exit Checklist

- [ ] PR 1: shared + API unit tests green (file counts quoted). Integration suites green on a wt-stack (Task 1 Step 5). `tsc --noEmit` for `apps/api` and `apps/web` exit 0 with a 12 GB heap. `localeParity` and `restorePointsLanguage` green. `pnpm db:check-drift` clean. The migration name passes the hook. No `workerReadinessCoverage`/`workerEntrypointClosure`/`parkedFanout` change (no job added). No `no-silent-mutations` change (no mutation UI). `mcp-coverage` untouched (no route/tool shape change).
- [ ] PR 2: `go test -race ./internal/heartbeat/... ./internal/systemrestore/...` green. `GOOS=windows go vet` clean. Go lint via `make lint` if available.
- [ ] Both PRs target `main` (not stacked), so CI runs on each.
- [ ] Release note line: "Restore-point outcomes now survive an agent restart; a checkpoint interrupted by a restart is reported as 'Unknown' instead of waiting forever."
- [ ] #8582 comment (orchestrator-owned): the recommendation in D2 about `lost` and `MIN_AGENT_VERSION_RESTORE_POINT_OUTCOME`.
- [ ] D5 lab gate run by the owner before the agent release is promoted.

## Out of Scope

- Stale `requested` rows from W0/W5/S1/O1, pre-W07 agents, reaped commands, and the non-UUID direct software-install path (no `device_commands` row, not journaled) → #8582.
- The general #8296 hand-off-then-crash loss (W5) for every command type.
- Moving `SRSetRestorePointW` into a killable helper (#4609 Open Decision 3).
