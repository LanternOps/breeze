# S0 Track E — rc.3 design: crash-cleanup evidence and synchronous `received` acknowledgement

**Date:** 2026-08-28
**Base:** `fb1731e97` (`v0.109.0-rc.2`, branch `fix/s0-pam-actuation-lifecycle`, PR #4105)
**Inputs:** #4196, the rc.2 matrix findings on #4060 (17/25 executed, 0 invariant
failures, cases 18–24 blocked), plan `2026-08-24-s0-track-e-pam-actuation.md`.
**Scope:** two agent-side defects found by the exact-candidate lab. Nothing here
weakens an earlier invariant; each change is argued against below.

---

## 1. #4196 — agent crash during an active grant pins the device at protocol 0

### Observed (lab, rc.2, case 16 → 17)

Kill `breeze-agent.exe` during an active v2 grant. The Job Object handle dies
with the agent; `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` reaps the elevated target.
Independent inspection: `jobMemberCount 0`, `~breeze_elev` disabled and out of
Administrators, no privileged token, no surviving PID, PID identity confirmed gone.
The restarted agent then runs `cleanupLocked` → `TerminateAndVerifyEmpty` →
`OpenJobObjectW` fails (the named job no longer exists) → `job_cleanup_failed`
**before** `ClearProcessIdentity`. `recordCleanupOutcome` marks the entry
unresolved, `Available()` is false forever, the heartbeat advertises
`pamLifetimeProtocolVersion=0`, and every later actuation on the device fails
`pam_protocol_v2_unsupported`. No retry bound, no terminal state.

### Decision: accept independent endpoint evidence for the job-absent-after-crash case

Reading of the plan's rule ("Unverifiable state is `failed`, never `cleaned`"; "Do
not add a bypass for … unverifiable endpoint state"): the rule forbids *claiming*
what the endpoint cannot *prove*. It does not forbid proving teardown by evidence
other than the job handle. The precedent is already in the code: when
`entry.BootID != bootID` (reboot) `cleanupLocked` skips the job entirely and
emits `cleaned` on account/token evidence alone, because a reboot proves the
process is gone. The same-boot crash case must meet a *stricter* bar than reboot,
because the process could in principle have survived outside the job:

`cleaned` may be emitted on the crash path only when **all** of these hold on the
same boot ID:

1. `TerminateAndVerifyEmpty` failed specifically because the named Job Object
   does not exist (`OpenJobObjectW` → `ERROR_FILE_NOT_FOUND`), and the agent does
   **not** hold an owned job handle for the actuation (`!ownsJob`). Any other
   error (access denied, truncated list, terminate failure, members > 0) remains
   `job_cleanup_failed` exactly as today.
2. The durable process identity is positively gone: `OpenProcess(PID)` fails
   with `ERROR_INVALID_PARAMETER` (no such PID), **or** the PID exists but its
   creation time differs from the ledger (PID reused), **or** the PID opens with
   the same creation time but `GetExitCodeProcess != STILL_ACTIVE` (zombie held
   open by another handle). If the exact identity is alive (same PID, same
   creation time, still active), that is an **orphaned elevated process**: the
   cleanup must fail with a new, distinct code `job_absent_process_alive`
   (one code must not mean two things — `job_cleanup_failed` stays for
   "could not terminate/verify the job", this code means "the job is gone but the
   process is not").
3. The existing account deprovision, account verification and privileged-token
   verification steps all pass (unchanged).

Evidence on the crash-path `cleaned` result carries the existing fields the server
demands (`jobMemberCount: 0`, `accountEnabled: false`, `accountInAdministrators:
false`, `privilegedTokenPresent: false`) **plus** a new optional
`jobObjectAbsent: true` so the audit trail can distinguish a crash-recovered
cleanup from a normal one. The server evidence schema is `.strict()`; add
`jobObjectAbsent: z.boolean().optional()` to `pamEvidenceSchema` in
`apps/api/src/services/pamActuationResult.ts`. `hasIndependentCleanEvidence`
is unchanged (it already demands exactly this evidence).

Argued against: "just bound the retries / add a terminal state and keep fail-closed".
That leaves every agent crash during a grant as a manual-remediation ticket on a
device that is provably clean, and a bounded retry that ends in a terminal
`failed` still never produces the `cleaned` the server needs to close the
actuation. It converts a proof problem into an operator toil problem without
adding safety, since containment already held. Rejected. The genuinely
unverifiable case (job absent, exact process alive) stays fail-closed under the
new distinct code, and nothing bounds or bypasses it.

Not in scope: bounding retries for other unverifiable states, or un-pinning the
protocol version while an entry is unresolved. Those remain fail-closed by design;
if Product wants a terminal `blocked_manual_remediation` for them it is a separate
decision.

### Implementation surface

- `agent/internal/pamlifetime/job_windows.go`: `openOwnedJob` must return a
  sentinel `ErrJobObjectAbsent` (wrapping the syscall error) only for
  `ERROR_FILE_NOT_FOUND` from `OpenJobObjectW`; new primitive
  `VerifyProcessIdentityGone(ctx, ProcessIdentity) (gone bool, err error)`
  implementing rule 2 above. Add to the `windowsPrimitives` interface and to the
  stub/fake implementations (`manager_stub.go`, `job_contract_test.go` fake).
- `agent/internal/pamlifetime/manager.go` `cleanupLocked`: on
  `errors.Is(err, ErrJobObjectAbsent) && !ownsJob` call the new primitive; on
  `gone` continue with `members = 0` and set `evidence.JobObjectAbsent = boolPtr(true)`
  after the account/token checks; on `!gone` (nil error) return
  `job_absent_process_alive`; on error return `job_cleanup_failed`.
- `agent/internal/pamlifetime/types.go`: `JobObjectAbsent *bool
  \`json:"jobObjectAbsent,omitempty"\`` on `ResultEvidence`.
- `apps/api/src/services/pamActuationResult.ts`: schema field as above.

### Tests (write red first, confirm the *named* test fails, then green)

Unit (portable, fake primitives):
- crash path → `cleaned`, `JobObjectAbsent=true`, `JobMemberCount=0`,
  `ClearProcessIdentity` called, entry no longer unresolved, `Available()` true
  after the cleanup, subsequent `Apply` admitted.
- job absent + identity alive → `failed` `job_absent_process_alive`,
  `ClearProcessIdentity` **not** called, still unresolved.
- job absent + `VerifyProcessIdentityGone` error → `failed` `job_cleanup_failed`.
- job absent but `ownsJob` → unchanged (`job_cleanup_failed`), primitive not called.
- non-absent terminate error → unchanged `job_cleanup_failed`, primitive not called.
- `Reconcile` with a `DesiredCleanup` ledger entry on the crash path → `cleaned`
  and `Available()` true (this is the exact restart shape from case 17).

Windows (`GOOS=windows go test -c ./internal/pamlifetime`, run on a lab VM):
- `openOwnedJob` on a never-created name → `errors.Is(err, ErrJobObjectAbsent)`.
- `VerifyProcessIdentityGone`: exited child → true; live child with matching
  creation time → false; live PID with a wrong creation time → true.

API: `pamActuationResult.test.ts` — a `cleaned` result carrying
`jobObjectAbsent: true` plus the four independent-evidence fields is `applied`;
the schema still rejects an unknown evidence key.

---

## 2. `received` observation lost or classified stale on fast endpoints

### Observed (lab, rc.2)

`handlePamApplyV2` enqueues the `received` observation to the durable outbox and
wakes the reconciliation worker, then returns the `verified_active` command
result. The command result reaches the server through the command-result
transport before the worker posts the observation over REST. The server's
`isReordered` correctly classifies the late `received` as `stale`; on ~53% of
applies it never persisted at all. Consequences: no durable received anchor,
and two of the three replay cases (`duplicate_received_result`,
`reordered_received_after_verified`) could not be exercised.

### Decision: acknowledge `received` synchronously, before the process is resumed

In `pamlifetime.apply`, move the `received` handoff to **before**
`m.windows.Resume(ctx, process)` (after `BindProcess`). The suspended process
already has its durable identity (PID, creation time, job name), which is all the
`received` evidence carries. The handoff in `handlePamApplyV2` becomes:

1. `Enqueue` the observation to the durable outbox (crash safety, unchanged).
2. Submit it synchronously through `h.pamResultSubmitter()` for `cmd.ID` and
   wait for the acknowledgement.
3. `applied` or `duplicate` → remove the pending outbox entry, recompute
   readiness, return nil. The apply proceeds to `Resume`.
4. `stale` or `rejected` → the server has moved on (revoked/re-dispatched) or
   refuses this envelope; remove the pending outbox entry and return an error
   that the manager maps to a distinct failure code
   `received_observation_rejected`. The process is never resumed; the existing
   failure path closes the job (`KILL_ON_JOB_CLOSE` kills the suspended process)
   and deprovisions the account.
5. Transport error → remove the pending outbox entry and return the error; the
   manager keeps `received_observation_handoff_failed`. Same containment as 4.

Reuse `submitPendingPamReconciliation`'s disposition logic rather than duplicating
it: refactor it to return the acknowledgement classification (or add a sibling
that does) so the sync path and the worker path share one classification switch.
Do not add a new server route, a WebSocket path, or an alternate result
transaction — the existing acknowledged REST route
`/api/v1/agents/:agentId/commands/:commandId/pam-observations` is the transport.

Argued against: "post after `Resume` but before returning the result" (the
minimal change). It still opens a window in which privilege has been exercised
before the server has durably recorded receipt, and a `stale` acknowledgement
would then require terminating a running elevated process instead of never
starting it. Moving the handoff before `Resume` costs nothing (identity is
already bound) and makes a stale/rejected acknowledgement a non-event for
containment. Adopted.

Argued against: "leave the outbox entry pending on failure so the worker retries
it". A late `received` after the command result reported `failed` would be
classified `applied` by the server and regress `observed_state` from `failed` to
`received`. The apply is failing and the process never ran; there is nothing to
reconcile, so the entry is removed. The ledger reconcile on restart covers the
crash-between-enqueue-and-submit window on its own.

Why `pamReceivedObservationReady` must not be forced false on the success path:
today `handlePamApplyV2` stores `false` after enqueue and relies on the worker to
drain and recompute. With a synchronous ack the entry is already gone; call
`recomputePamReconciliationReadiness()` instead so back-to-back applies are not
refused with "received observation transport unavailable".

### Tests (red first)

- `job_contract_test.go` order assertions: `received` handoff is now recorded
  before `resume`, and `VerifyActive` after it; a handoff error leaves the
  process unresumed and the job closed.
- `handlers_actuate_test.go`: the handoff submits through the injected
  `pamSubmitResultFn` for the exact command ID before the manager verifies;
  `applied`/`duplicate` → apply proceeds and the outbox pending set is empty and
  `pamReceivedObservationReady` stays true; `stale`/`rejected` →
  `received_observation_rejected`, outbox empty; transport error →
  `received_observation_handoff_failed`, outbox empty.
- Existing `TestPamApplyV2EnqueuesExactEnvelopeCommandBeforeVerification` must
  still hold (enqueue precedes submit precedes verification).

---

## 3. Verification and evidence requirements for both

- Every new test is run red first against the unpatched line and the failing
  test is named in the commit body or PR comment; then green.
- `cd agent && go test ./internal/pamlifetime/... ./internal/heartbeat/...`
  and `GOOS=windows GOARCH=amd64 go vet ./...` pass locally; the Windows test
  executables for `internal/pamlifetime` and `internal/heartbeat` pass on a lab
  VM (`administrator@100.101.28.70`, scp then `.\x.test.exe -test.v`).
- API: `pnpm --filter @breeze/api vitest run src/services/pamActuationResult.test.ts`
  (or the repo's equivalent) passes.
- Label every claim verified / inferred / not-checked in the hand-back.
