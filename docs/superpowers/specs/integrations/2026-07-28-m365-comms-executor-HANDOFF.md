# Handoff — M365 communications-delegated executor & session state

**Date:** 2026-07-28 (updated same day)
**Status:** Design at **v3**, approved for implementation. All three prerequisites shipped (#2915 principal kind; #2917 release funnel + persisted origin principal). All three blocking decisions made 2026-07-29 (§6). **Nothing blocks task 1.**

> ## Latest state (read this first)
>
> - **Design doc is v3.** §0.a of the design is the single most important thing in it.
> - **PR #2915 open** — principal-kind discriminator, no behaviour change, full suite green.
> - **The v2 re-review found a bypass that two revisions missed:** approved intents are released by **two** paths — the durable worker *and* the live chat session (`aiAgentSdk.ts:755-828`), which race for the same CAS. The inline path revalidates authorization correctly but then runs the **ordinary tool handler**, never the headless transport. So every binding guarantee (stored envelope, pinned sender, digest claim, executor recomputation) is simply absent on that path. Verified directly. v3 §0.a closes it by making comms Tier-3 tools inline-ineligible before the CAS and funnelling every send through `releaseCommsSend(intentId)`.
> - **One latent shipped issue worth knowing about, independent of comms:** `approval_requests.action_arguments` is a *copy* of the intent's arguments that the approval UI displays, and the decide path compares digest-to-digest without re-deriving from that copy. The intent's copy is trigger-protected; the displayed copy is not. Nothing writes it today, so this is latent rather than live — but for mail the displayed content *is* the effect. v3 task 15b adds the trigger for every intent-backed approval.
>
> ### v2 revision (superseded by v3, kept for the audit trail)
>
> §3 below is the *record of what the first review found* — input to the v2 revision, not an open work list. What changed, in one line each:
>
> | §3 item | Resolution in v2 |
> |---|---|
> | 1 effect digest | §5 — canonical effect envelope; digest recomputed **inside the executor** before credential access; mapper no longer rebuilds; shared canonicalizer |
> | 2 sender binding | §5.2 — connection/tenant/sender/**consent generation** pinned at creation. Generation is the load-bearing part: reconnect reuses the same row, so `connectionId` alone cannot detect it |
> | 3 principal kind | §6 — carved out as **task 0, its own PR**, before any comms code |
> | 4 delegated consent | §4.2 — new `delegated_consent` phase, `/common` authorize, tenant learned from the ID token, **verify-then-persist** (v1 had the ordering backwards) |
> | 5 bootstrap constraint | §4.1 — status-aware `credential_location_check` + single atomic promotion UPDATE |
> | 6 Key Vault as token store | §3.1/§3.2 — **replaced**. MSAL confidential client + encrypted CAS token cache; Key Vault reverts to `get`-only on two immutable secrets; the single-replica constraint is gone (no rolling deploy can honour it) |
>
> **Both prerequisites are merged** — #2915 (`9e346eee9`) and #2917 (`fd32f8e73`) — and **all three open decisions were made 2026-07-29**; see §6 for what was decided and why. Nothing in this design is waiting on Todd. What is still waiting on him is unchanged and unrelated: §5 (release, Azure provisioning, executor runtime, real-tenant acceptance run).

---

## 1. What shipped today

All merged to `main`, all green:

| PR | Squash | What |
|---|---|---|
| #2873 | `6357757ab` | tier-3 plan-mode approval parity (security fix) |
| #2880 | `cb7621b19` | M365 customer-graph-actions consent & onboarding |
| #2893 | `f91dc5a5d` | actions-executor CI wiring (test/build/Trivy/Dependabot/release) |
| #2910 | — | actions signing-secret runtime smoke + hardening-guard parity |

Notes worth carrying forward:

- **#2893 existed because the actions executor shipped in #2628 with zero CI.** Its `src/` held 11 test files / 222 tests that no CI job had ever run. `pnpm lint` (= `turbo run lint`) and the root npm Dependabot entry *did* already cover it; the gap was tests, typecheck, image build, Trivy, and the release image.
- **`deploy/.env.example` told operators to pin `m365-graph-actions-executor@sha256:<digest>` — an image the release pipeline never built.** #2893 added that job, so **the next release tag publishes that image for the first time ever.** Watch it; it is the one part of #2893 CI could not prove.
- **#2910 also closed a meta-gap:** `check-supply-chain-hardening.sh` pinned the *read* executor's whole posture by name and was silent about actions, so #2893's wiring was removable without CI noticing. It now pins both.

## 2. Where the M365 control plane actually stands

Master spec: `docs/superpowers/specs/integrations/2026-07-13-breeze-m365-control-plane-design.md` §17 (8 delivery stages).

| Stage | State |
|---|---|
| 1 Foundation | shipped (#2495) |
| 2 Consent & verification | shipped — read #2511, actions #2880 |
| 3 Intent & approval | shipped; #2873 closed the tier-3 plan-mode gap |
| 4 Read executors | Graph read done (#2615); **communications executor never built** ← this handoff |
| 5 Mutation executors | Graph actions built (#2628) + consent (#2880) |
| 6 PowerShell executor | not started |
| 7 Consumer migration | not started |
| 8 Delegant removal | not started |

**Everything M365 is dark.** `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED` defaults false (`env.ts:105`); `M365_GRAPH_ACTIONS_TOOLS_ENABLED=false`. Stage 5 is code-complete but has never satisfied §17's "validate in production" gate, which is what formally blocks stages 6–8.

⚠️ **The actions-consent plan doc (`plans/integrations/2026-07-22-m365-customer-graph-actions-consent.md`) has 0 of 88 checkboxes ticked despite all 15 tasks being done and merged.** Do not read it as a status source. Verified task-by-task against merged code on 2026-07-28.

## 3. The communications-delegated design — READ BEFORE IMPLEMENTING

- **Design doc:** `docs/superpowers/specs/integrations/2026-07-28-breeze-m365-communications-delegated-design.md` (drafted by Fable).
- **Review:** Codex `gpt-5.6-sol` at `xhigh`, read-only, 18 findings.

**Verdict: revise before implementing.** The doc is a good skeleton — the trust-boundary mirroring, the ruthless 5-action first cut, and the tenancy analysis are sound. The credential and binding layers are not.

### The core insight that is correct and load-bearing

This **cannot** be a re-key of the read/actions executors. Those use one immutable org-consented app certificate, version-pinned in env. Communications uses **per-user delegated refresh tokens** that Microsoft rotates on redemption and can invalidate at any time (revocation, password reset, CA policy, ~90-day inactivity). Owner axis is `user`, not `organization`. Every downstream difference follows from that.

### What must change before task 1

1. **Effect-digest binding is not end-to-end.** `revalidateApprovedIntentForRelease` compares two *stored* digest strings (`revalidateRelease.ts:36-45`) and never recomputes from `intent.arguments`; the headless mapper rebuilds a fresh typed request (`m365ToolsHeadless.ts:55-76`); `bodySha256` then hashes *that new body* (`graphActionsExecutorClient.ts:153-192`). The executor never sees the approval digest. Low surface today (the 2 shipped actions map only `userIdentifier`) — **unacceptable for mail**, where recipients/subject/body ride through that mapper. Fix: one canonical effect envelope (action+version, sender identity, recipients, subject, body, connection, tenant), persist and approve *its* digest, carry it in the executor request, recompute inside the executor.
2. **Intents are not bound to a sender mailbox.** `action_intents` already has immutable `connection_id`/`tenant_id` with a protecting trigger (`2026-07-18-action-intents.sql:95-115`), but `CreateActionIntentInput` cannot set them and creation leaves both null (`intentService.ts:65-75, 293-312`). Resolving the connection at *release* time means a reconnect between approval and release could send approved content from a different mailbox. Pin connection id, tenant id, delegated object id, and a consent generation at creation.
3. **Principal kind must exist before any user-axis authorization.** See §4 — this is the blocking objection.
4. **Delegated consent cannot reuse the existing identity-verification machinery.** It requires a tenant GUID *before* authorization (`m365.ts:140-152`, `browserBinding.ts:39-55`, `consentSessionService.ts:119-146`, which states it is certificate-profile-only). A first `/common` delegated sign-in only learns `tid` from the ID token. Needs a delegated-specific consent phase.
5. **A delegated connection cannot be bootstrapped under the current constraint.** `m365_connections_credential_location_check` (`foundation migration:105-110`) demands non-null `vault_ref`/`credential_version` immediately, but neither exists until OAuth callback completes. Needs a status-aware constraint allowing null only for delegated `pending-consent`/`verifying`, then atomic promotion.
6. **Key Vault write-back is the weakest proposal.** AKV `setSecret` always creates a new version — it is not a CAS store and has no lease. The single-replica mutex covers one process lifetime only (and `intentReleaseWorker` already runs concurrency 5, `intentReleaseWorker.ts:523-530`). Codex recommends a confidential MSAL client with an encrypted distributed per-user token cache, using Key Vault for the wrapping key / client credential rather than as a mutable token database. **Take this seriously.**
7. **Also flagged:** the design omits the confidential-client credential entirely (PKCE ≠ client auth; the sibling uses a cert assertion, `tokenClient.ts:166-204`); `appid` is a v1 claim while the siblings use the v2 endpoint (`azp` is correct); the `/me/mailboxSettings` probe needs `MailboxSettings.Read`, absent from the profile; consent persists the refresh token *before* identity/scope verification; retained old RT versions are **not** harmless (Microsoft does not revoke on redemption).

### Where Codex was wrong or overstated

Do not accept the review wholesale:

- It claims the `breeze_current_user_id` RLS branch is untested. **False** — `m365ConnectionsRls.integration.test.ts:160-235` already covers same-partner/same-org peer denial, owner CRUD, and forged insert.
- The design's proposed assertion "an org-scoped token must not see any user-owned row" is itself wrong: human org contexts still set `breeze.user_id`, so an org-scoped owner *can* see their own row. The correct assertion is that another user, or a keyed/no-user DB context, cannot.
- "MATCH SIMPLE forces a second consent-sessions table" is a design preference, not a Postgres necessity — a unified table with per-axis composite FKs would work.
- Minor: owner-axis literal is `'organization'` not `'org'`; the status list omits `suspended`.

**Real gap Codex found in the plan:** `m365_connections` is absent from `USER_ID_SCOPED_TABLES` (`rls-coverage.integration.test.ts:507-541`) and the task list never adds it. A system-only table with no `org_id` is invisible to both the RLS FORCE sweep and the cascade suite, so those contracts cannot serve as the proof the design claims — dedicated behavioural tests are required.

## 4. Verified findings about **shipped** code (independent of this design)

Spot-checked directly, not taken from the reviewer:

1. **MCP auto-executes Tier-3 tools with no approval.** Explicit comment at `mcpServer.ts:~998`: *"MCP server auto-executes Tier 3 tools without approval — the API key holder is trusted at the scope level. Approval flow is for interactive UI only."* So shipped `m365_disable_user` / `m365_reset_password` run straight through for any API key with the scopes. The `action_intents` chain guards the **interactive** path only.
2. **API keys inherit their creator's identity.** `buildAuthFromApiKey` sets `user.id = apiKey.createdBy` (`mcpServer.ts:~1869`), and `AuthContext` carries **no principal/transport discriminator** (`middleware/auth.ts:18-88`).
3. **Executor requests are replayable.** `jti` is UUID-shape-validated but never consumed; no replay cache (`internalAuth.ts:85-103`). 60-second window, inside the private API↔executor boundary.

(1)+(2) together are the blocking objection to the comms executor: an API key minted by the mailbox owner would satisfy a user allowlist, a connection-owner check, and user-axis RLS — then auto-execute a Tier-3 **send as that human** with no approval. Fix is an explicit principal kind (`user_session | api_key | oauth_grant | helper`), required to be `user_session`, plus suppression from MCP `tools/list` **and** denial in `tools/call`.

**Decided 2026-07-29 — auto-execute stays; see §6 for the reasoning and the general rule it produced.** In short: "mutation" is the wrong line, because unattended mutation is what MCP is *for*. The line is whether the effect carries an individual human's authority. Comms sends do and are `user_session`-only; `m365_disable_user`/`m365_reset_password` carry org authority and are unchanged, with the password-reset exposure recorded as its own control-plane question.

## 5. Open items needing Todd (no code unblocks these)

1. **Cut a release.** 56 commits on `main` since `v0.102.0`, including the #2873 security fix. Nothing today is in production. Remember the deploy service list is hand-maintained — assert version parity after.
2. **Azure/Entra provisioning**, if M365 actions are to go live: dedicated multitenant Entra app (**not** the read app) with exactly `User.ReadWrite.All` + `User-PasswordProfile.ReadWrite.All` (the four roadmap scopes stay unconsented); a client certificate as a dedicated Key Vault secret `m365-customer-graph-actions`; a dedicated managed/workload identity scoped to only that secret; an Ed25519 signing keypair; `APP_ENCRYPTION_KEY_ID` set **and** mapped in the compose `environment:` block (boot hard-refuses without it when tools are enabled).
3. **Somewhere to run the executors.** Neither executor is a compose service — by design, and enforced by `check-supply-chain-hardening.sh`. They need an identity-capable runtime with private HTTPS ingress. This is an infrastructure decision, not a code task.
4. **Real-tenant acceptance run** — the formal gate blocking stages 6–8. Runbook: `docs/deploy/m365-customer-graph-actions-executor.md`.

## 6. Recommended next step

**Done:** v2 revision → re-review → v3 revision. Task 0 shipped (#2915). Tasks 0a + 0b shipped (#2917, squash `fd32f8e73`). **All three of Todd's decisions made 2026-07-29.**

**The three decisions, as recorded in the design doc:**

| Question | Decision | Where |
|---|---|---|
| Token-cache store placement | **Executor-owned dedicated store.** Breeze Postgres fallback is *closed*, not deprioritized — reversing it requires re-deciding, not improvising under deploy pressure. | design §3.2, risk #9 retired |
| Master-spec §6.1 amendment | **Applied.** Restated as *no component may hold credential material it can decrypt outside its own credential domain*; plaintext forbidden everywhere; per-domain cardinality named. Note the ordering — the amendment was not needed to unblock the design, since the cache never enters Breeze Postgres. | master §6.1; design §12 flags 5+6 resolved |
| Tier-3 auto-execute over MCP | **Stays.** A blanket "mutations need approval" rule would block `execute_command`, patch install, invoicing and org lifecycle — the automation MSPs buy MCP for. The line is *whose authority the effect carries*: **effects attributable to an individual human identity require `user_session`, regardless of transport.** Comms is the first instance of a general rule, not an exception. | design §6 |

**Carried out of that third decision, deliberately not bundled:** `m365_disable_user`/`m365_reset_password` act *on* a human but with org authority, so they keep auto-executing over an API key. Password reset is the classic account-takeover primitive and deserves its own decision — likely an opt-in grant on the key. Control-plane scope, not comms; both tools are dark today.

**Now, in order:**

1. **Implement tasks 1 → 18** (design §14). Task 1 (shared canonicalizer) is a pure move plus test vectors and unblocks task 2.
2. **Optional third adversarial review, scoped.** If one is run, the remaining risk is concentrated in §3.2 (the token cache's fencing/keyring/tombstone semantics) and §5.3 (the operation-plan digest). The rest of v3 is mechanical enough to review in the PRs. A third *full*-design round has diminishing returns — the last one earned its keep almost entirely on §0.a, which is now closed.

Everything in §5 (release, Azure provisioning, executor runtime, acceptance run) is unchanged and still blocking production, independent of this design.

## 7. Environment notes

- **macOS Docker Desktop remaps bind-mount ownership** to the accessing container uid. The runtime-smoke probes' `uid/gid !== 1001` assertion therefore **cannot fail locally** — only the mode assertion is falsifiable on macOS; ownership is real only on the Linux CI runner. Confirmed by mounting a root-owned file and reading back `uid=1001`. Noted in both smoke scripts. A green local run does not prove that half.
- **CI uses `cancel-in-progress` on `CI-refs/heads/main`.** Staggered merges cancel each other's main runs, so only the last merge's run completes. Per-PR "main stayed green" is weaker than it looks — check the run that actually finished.
