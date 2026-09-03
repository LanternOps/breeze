---
tracking_issue: LanternOps/breeze#3207
---

# End-User Reboot Prompts with Deferral Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan wave-by-wave, task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the signed-in user postpone a Breeze-scheduled reboot a bounded number of times, within a hard deadline, on Windows and macOS (and Linux in W4) — controlled by a partner-wide-capable Configuration Policy setting that is **off by default**.

**Architecture:** The deferral budget is policy data resolved server-side and shipped on the existing `schedule_reboot` command payload; the agent's untagged `RebootManager` gains a deferral state machine that re-plans the reboot and clamps every deferral against a hard deadline (which is what finally makes #3253's `deadline` field load-bearing). The user's *decision* travels over the IPC channel that already exists — `ipc.NotifyRequest.Actions` / `ipc.NotifyResult.ActionClicked`, correlated by envelope id — via a new **request/response** broker call alongside the existing fire-and-forget `BroadcastNotification`. The prompt itself is rendered by the platform's proven native dialog (`MessageBoxTimeoutW` / `osascript display dialog`), reusing the exact vehicles `consent_dialog_*.go` already ships, rather than by toast action buttons.

**Tech Stack:** Hand-written SQL migrations + Drizzle, Hono + zod (`packages/shared` validators), Go agent (untagged files, table-driven tests), Astro/React + Vitest, BullMQ workers.

**Spec:** No standalone spec doc. This plan is authored directly from GitHub issue **LanternOps/breeze#3207** and from the shipped design of its predecessor **#3197 / PR #3421** (`fix(patching): make the patch-reboot user warning an invariant, not a coincidence`), whose PR body is the de facto design record for the reboot subsystem. Read the #3421 PR body before starting: it explains why the manager is untagged, why the lead notification is unconditional, and why `config_policy_patch_settings` is the right home for reboot policy.

**Tracking issue:** LanternOps/breeze#3207 (register waves via `feature-lifecycle` after approval).

---

## Global Constraints

- **Default must preserve today's behaviour exactly.** `reboot_allow_deferral` defaults to `false`. With it false, nothing about the reboot path changes: same ladder, same timings, same toasts, no prompt, no dialog. Every wave's acceptance criteria include "with deferral disabled, the #3197 invariants still hold" (`agent/internal/patching/reboot_plan_test.go`, `reboot_manager_test.go` must stay green unmodified except for additive cases).
- **Agent-shipped code = high blast radius.** Both compatibility directions must be handled explicitly and tested:
  - *Old agent, new API*: the new `schedule_reboot` payload keys (`allowDeferral`, `maxDeferrals`, `deferralMinutes`, `deadline`) are read via `tools.GetPayload*` on a `map[string]any`; unknown keys are ignored by construction. An old agent behaves exactly as today.
  - *New agent, old API*: the keys are absent; `tools.GetPayloadBool(payload, "allowDeferral", false)` yields `false` → deferral off → today's behaviour. **Never make an absent key mean "enabled".**
  - *New daemon, old user helper*: `ipc.NotifyRequest` keeps `Actions []string` (do **not** change it to a struct slice — an old helper would fail to unmarshal the whole request and render no toast at all). New fields on `NotifyRequest` must be additive optional scalars.
  - *Old daemon, new user helper*: `Actions` is empty → the helper takes the existing toast path.
- **Migrations:** hand-written SQL in `apps/api/migrations/`, `YYYY-MM-DD-HHMMSS-<slug>.sql`, idempotent (`ADD COLUMN IF NOT EXISTS`, `DO $$` guards on `pg_constraint`), **no inner `BEGIN`/`COMMIT`**, never edit a shipped migration, never touch the closed `2026-08-06` block. **Filenames run ahead of real time** — at execution time run `ls apps/api/migrations | grep '\.sql$' | sort | tail -3` and name the file to sort *after* the newest committed one. As of plan authoring the newest is `2026-10-04-100003-portal-visibility-indexes.sql`, so W1 uses `2026-10-05-100100-patch-reboot-deferral-settings.sql` and W5 uses `2026-10-05-100200-devices-reboot-schedule-columns.sql`.
- **Tenancy — verified, not assumed.** `config_policy_patch_settings` (`apps/api/src/db/schema/configurationPolicies.ts:191-212`) has **no `org_id` and no `partner_id`**. Tenancy is transitive: `feature_link_id` → `config_policy_feature_links` → `configuration_policies`, and *that* table already carries the dual-ownership `org_id XOR partner_id` shape. `'patch'` is already in `PARTNER_LINKABLE_FEATURE_TYPES`. Consequences, all confirmed by grep against `origin/main`:
  - **Partner-Wide First is satisfied by inheritance.** No new `one_owner_chk`, no new dual-axis RLS policy, no `<table>PartnerRls.integration.test.ts` suite, no `DUAL_AXIS_TENANT_TABLES` entry.
  - `config_policy_patch_settings` appears in **neither** `apps/api/src/services/tenantCascade.ts` (1254 lines, searched in full) **nor** `apps/api/src/services/tenantExportPolicyRegistry.ts` (466 lines, searched in full). Both lists key on `org_id` columns. **W1 therefore requires no cascade or export-policy registration.**
  - **W5 is different and this is the trap.** W5 adds columns to `devices`, which *is* in `CORE_ORG_CASCADE_DELETE_ORDER`. Per CLAUDE.md, *adding a COLUMN to an org-cascade table requires classifying that column in `CORE_TENANT_EXPORT_POLICY`* (`apps/api/src/services/tenantExportPolicyRegistry.ts`). W5's columns are deliberately scalars (timestamptz / integer / varchar) so they classify as `included`; **a `jsonb` reboot-status blob would have been forced into `excludedOpen` and would then not export at all**, which is why this plan does not use one.
- **The canonical partner export is the contract that *does* fire in W1.** The patch branch of `public.breeze_partner_export_policy_settings_pre_patch(uuid, text, jsonb)` is a **hand-enumerated `jsonb_build_object`** — a new column does not export itself. W1 must, in the same migration + same PR:
  1. `CREATE OR REPLACE` that function re-emitting its **entire ~170-line body** (copy the currently authoritative definition from `apps/api/migrations/2026-08-21-patch-reboot-delay-minutes.sql:54-223`, which itself fix-forwarded `2026-07-30-alert-rule-ownership-consolidation.sql`) with the three new keys added next to `'rebootDelayMinutes', settings.reboot_delay_minutes` (line 138 of that file);
  2. re-emit the trailing `REVOKE ALL ... FROM PUBLIC` + guarded `GRANT EXECUTE ... TO breeze_app` (`:225-230`) — `partnerApiConfigurationWatermark.integration.test.ts:240-278` asserts those ACLs and a bare `CREATE OR REPLACE` resets them;
  3. add the three keys to `PATCH_NORMALIZED_MATERIAL_KEYS` (`apps/api/src/routes/partnerApi/configuration.ts:46-58`). That allowlist **fails closed on an exact count mismatch** (`:106-118`): SQL-without-TS or TS-without-SQL both make every `patch` partner export silently `blocked`.
- **CI reality.** Integration suites do **not** run under `pnpm test` (separate `vitest.integration.config.ts`). `partnerApiConfigurationWatermark.integration.test.ts:515-522` is an explicit `toEqual({...})` key list and **will go red the moment W1's columns land** — that is the intended contract failure; update it in the same PR. Windows-tagged Go files are tested nowhere in CI (#3019, #3046), so **every new Go test in this plan must live in an untagged file**. Stacked PRs get **no CI** (`ci.yml` triggers on `pull_request: branches: [main]`) — base each wave PR on `main`, or `gh workflow run CI --ref <branch>` before merging.
- **Go tests:** `cd agent && go test -race ./...` before every agent commit; cross-compile check `GOOS=windows go build ./... && GOOS=darwin go build ./... && GOOS=linux go build ./...`.
- **Web:** all mutation handlers go through `runAction`; all copy goes through i18n in **all 8 locales** (`en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR`) — `apps/web/src/lib/i18n/localeParity.test.ts` enforces it. Non-English locales carry the English string verbatim except `tr-TR`, which is genuinely translated (follow the existing convention in `policies.json`).
- **Commit after every task** (checkpoint commits). One PR per wave, `Closes #<wave sub-issue>` in the body.

---

## Design decisions taken up front (and why)

These are settled; do not re-litigate during execution. Each one is a place where the issue body's proposed fix has been overridden by what the code actually says.

### D1 — Deferral settings ride the `schedule_reboot` command payload, not a heartbeat config block

Two delivery channels exist. The heartbeat carries a `patchSourceSettings` block (`apps/api/src/routes/agents/helpers.ts:2770-2796` → `heartbeat.ts:1656,1669` → `agent/internal/heartbeat/patch_source.go`), and the command payload carries `delayMinutes` resolved server-side (`apps/api/src/services/patchRebootHandler.ts:199-210`).

**Command payload wins.** The deferral budget must be *fixed for the life of one scheduled reboot*: an admin editing the policy mid-countdown must not be able to shrink a user's remaining deferrals out from under them, and a heartbeat block would do exactly that. The payload also inherits `resolvePatchConfigForDevice`'s partner-wide-aware resolution for free (`apps/api/src/services/featureConfigResolver.ts:479-497` returns the whole row, so new columns flow through with no resolver change).

### D2 — Scalar columns, not a jsonb "allowed defer choices" list

A choice list (`["15m","1h","4h"]`) is the more flexible product surface, but: `sanitizeNotifyRequest` caps `Actions` at 4 (`agent/internal/userhelper/notify_common.go:31-33`), and a "Restart now" button plus three defer options already fills it. More importantly, a jsonb column on a table that *did* have `org_id` would be forced into `excludedOpen`, and jsonb here buys nothing a scalar cannot do. **One scalar defer duration** (`reboot_deferral_minutes`) plus a count (`reboot_max_deferrals`). A choice list remains addable later as a jsonb column without disturbing anything in this plan.

### D3 — No `reboot_notify_user` toggle

The issue body's item 5 asks for one. **Do not add it.** #3197's whole thesis is that "at least one warning fires" is an *invariant*, asserted in `reboot_plan_test.go` (`Notifications[0].After == 0`, `Notifications` never empty). A `reboot_notify_user=false` column would hand an admin a switch that re-creates the exact customer-facing defect #3421 fixed. Deferral is opt-in via `reboot_allow_deferral`; silence stays impossible. (Raised as Open Question 3 in case Todd wants the escape hatch anyway.)

### D4 — The prompt is a native modal dialog, not a toast with action buttons

The issue body's item 2 asks for toast `<actions>`. The code says a dialog is both cheaper and lower-risk:

- **The decision channel already exists and is unused.** `ipc.NotifyRequest.Actions []string` and `ipc.NotifyResult.ActionClicked` are declared (`agent/internal/ipc/message.go:245,251`), `sanitizeNotifyRequest` already trims and caps `Actions`, `expectedResponseType(ipc.TypeNotify)` already maps to `ipc.TypeNotifyResult` (`agent/internal/sessionbroker/broker.go`), and `Client.handleNotify` already replies on the same envelope id (`agent/internal/userhelper/client.go:911-927`). The only thing missing daemon-side is a **correlated** send: `BroadcastNotification` calls `s.SendNotify("", ...)` with an **empty envelope id** (`broker.go:1304-1324`), so the helper's reply is orphaned.
- **A proven cross-platform dialog already ships.** `consent.go` + `consent_dialog_windows.go` (`MessageBoxTimeoutW`, undocumented-but-stable user32 export, has a real countdown) + `consent_dialog_darwin.go` (`osascript display dialog ... giving up after N`) + `consent_dialog_linux.go` (zenity) is *exactly* notify-plus-choice-plus-timeout-default, with the fail-closed reply discipline already worked out.
- **Toast activation is the riskiest thing in the feature.** `notify_windows.go` raises the toast from a short-lived PowerShell process under AUMID `Breeze.Agent`. Once that process exits there is nothing to receive `ToastActivated`; making buttons work needs either a registered COM activator (packaged-identity territory) or a custom `breeze-agent:` URI protocol handler in HKCU plus a single-use nonce so a local user cannot forge another session's deferral. On macOS, `osascript display notification` has **no** button support at all and `UNUserNotificationCenter` needs a signed bundle. That is a lot of platform risk on the critical path of a P1 feature.

So: dialog now (W3/W4), **toast action buttons are an explicit non-goal of this plan** and are filed as a follow-up. Same IPC contract either way, so the upgrade is a helper-side change only.

### D5 — The hard deadline, not the counter, is the real enforcement

`RebootState.Deadline` is stored and reported but never enforced (#3253, open). Deferral gives it a job: every deferral is clamped to `min(now + deferralMinutes, hardDeadline)`, and a deferral that would leave less than `patching.MinRebootDelay` is refused. The counter is a UX affordance; the deadline is the guarantee. Consequence: **the API must start sending `deadline`** (W1) — `handleScheduleReboot` already parses it (`agent/internal/heartbeat/handlers_patch.go:231-236`) and today nobody sends it, so the agent silently defaults `deadline = now + delay` and every deferral would be refused.

### D6 — Deferral does not consume circuit-breaker budget

`rebootHistory` is appended only inside `runOSReboot`, immediately before the OS invocation (`reboot_manager.go`). Deferring re-arms timers and never reaches that path, so the `maxRebootsPerDay` breaker is untouched by construction. Pin it with a test rather than leaving it to inspection.

### D7 — Linux has no helper binary today. This is a real gap, not an oversight

`release.yml:220-240` builds `breeze-desktop-helper` under `if: matrix.goos == 'darwin'`; `breeze-user-helper` is built only for Windows (`release.yml:377`); `agent/Makefile:27-29` matches. **No helper ships for Linux**, so no Linux session ever holds the `notify` scope, `BroadcastNotification` reaches nobody, and Linux's only user-facing reboot warning is the `shutdown -r +N` wall message. W4 closes this daemon-side (enumerate logind graphical sessions, run the dialog as the session user) rather than by adding a fourth shipped binary and a per-user autostart mechanism to the installer.

### D8 — The Tauri helper (`apps/helper`) is not the vehicle

It has consent and banner windows (`apps/helper/src-tauri/src/ipc/desktop.rs`) and a correct request/response consent round-trip, but **no `notify` handler** (`client.rs` handles `pre_auth_reject`, `auth_response`, `helper_token_update`, `consent_request`, `banner_show`, `banner_hide`, `ping`, `pong`, `disconnect`), and `assistHelperScopes` deliberately excludes `notify` (`broker.go:222-226`). Routing reboot prompts through it would mean a new scope grant, a new Rust handler, a new React route, and a second implementation of the same decision. The Go user/desktop helper already has the scope and the dialog code. Revisit only if Breeze Assist becomes the universal end-user surface.

---

## File structure

**W1 — policy surface (API + web)**
| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-05-100100-patch-reboot-deferral-settings.sql` | 3 columns + 3 CHECKs + full re-emit of `breeze_partner_export_policy_settings_pre_patch` + ACL re-emit |
| `apps/api/src/db/schema/configurationPolicies.ts` | Drizzle column definitions |
| `packages/shared/src/validators/index.ts` | `patchInlineSettingsSchema` fields + a `superRefine` coherence rule |
| `apps/api/src/services/configurationPolicy.ts` | write path (`:516-532`) and read path (`:979-1000`) column enumerations |
| `apps/api/src/services/configPolicyPatching.ts` | inventory read (`:315-337`) + backfill insert (`:388-402`) |
| `apps/api/src/routes/partnerApi/configuration.ts` | `PATCH_NORMALIZED_MATERIAL_KEYS` (`:46-58`) |
| `apps/api/src/services/patchRebootHandler.ts` | resolve deferral settings + emit new payload keys and `deadline` |
| `apps/api/src/jobs/maintenanceRebootWorker.ts` | send `deadline` = maintenance window end |
| `apps/web/.../featureTabs/PatchTab.tsx` | three new fields in the reboot section (`:680-743`) |
| `apps/web/src/locales/*/policies.json` × 8 | i18n keys |

**W2 — agent deferral state machine**
| File | Responsibility |
|---|---|
| `agent/internal/patching/reboot_deferral.go` *(new, untagged)* | `DeferralPolicy`, `DeferralLedger` (persistence), `ComputeDeferral` (pure clamp arithmetic) |
| `agent/internal/patching/reboot_deferral_test.go` *(new)* | table-driven tests for the clamp + ledger |
| `agent/internal/patching/reboot_manager.go` | `RebootOptions`, `ScheduleWithOptions`, `Defer()`, deferral fields on `RebootState` |
| `agent/internal/patching/reboot_manager_test.go` | additive cases |
| `agent/internal/heartbeat/handlers_patch.go` | parse the new payload keys (`:209-246`) |
| `agent/internal/remote/tools/` | add `GetPayloadBool(payload, key, def)` if no boolean payload helper exists — check first with `grep -rn "func GetPayloadBool\|func ParsePayloadBool" agent/internal/remote/tools/` and use whatever is already there rather than adding a near-duplicate |

**W3 — interactive prompt (Windows + macOS)**
| File | Responsibility |
|---|---|
| `agent/internal/ipc/message.go` | additive optional fields on `NotifyRequest` |
| `agent/internal/sessionbroker/broker.go` | `RequestNotificationDecision` (correlated fan-out) |
| `agent/internal/sessionbroker/broker_notify_test.go` | fan-out / first-answer / timeout cases |
| `agent/internal/userhelper/notify.go`, `notify_prompt.go` *(new, untagged)* | route actions-bearing notifies to the dialog seam; shared copy builder |
| `agent/internal/userhelper/notify_prompt_windows.go` / `_darwin.go` / `_other.go` *(new)* | platform dialog with buttons |
| `agent/internal/userhelper/client.go` | `handleNotify` returns `ActionClicked` |
| `agent/internal/patching/reboot_manager.go` | `promptFn` seam; prompt on the lead + reminder rungs |
| `agent/internal/heartbeat/heartbeat.go` | wire `promptFn` to the broker (`:1006-1010` area) |

**W4 — Linux parity**
| File | Responsibility |
|---|---|
| `agent/internal/userhelper/linuxsession/` *(new package, untagged core + `_linux` exec)* | enumerate logind graphical sessions, build a `su`-style command with `DISPLAY`/`DBUS_SESSION_BUS_ADDRESS` |
| `agent/internal/patching/reboot_prompt_linux.go` *(new)* | daemon-side Linux notify + prompt fallback used when no `notify`-scoped session exists |
| `agent/internal/heartbeat/heartbeat.go` | chain the Linux fallback behind the broker path |

**W5 — console visibility + docs**
| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-05-100200-devices-reboot-schedule-columns.sql` | 4 scalar columns on `devices` |
| `apps/api/src/db/schema/devices.ts` | Drizzle columns |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | **classify the 4 new `devices` columns** |
| `agent/internal/heartbeat/heartbeat.go` | `RebootStatus` on `HeartbeatPayload` |
| `apps/api/src/routes/agents/schemas.ts`, `heartbeat.ts` | optional zod field + persist |
| `apps/web/.../devices/DeviceDetails.tsx` | pending-reboot / deferred badge |
| `apps/docs/src/content/docs/features/patch-management.mdx`, `agents/commands.mdx` | settings table + payload docs |

---

## Wave 1 — Policy surface end-to-end (default off)

**Ships:** three new Configuration Policy settings, settable via UI and partner API, resolved per device and emitted on the `schedule_reboot` payload. No agent honours them yet, so behaviour is unchanged in production.

**Why one PR and not two:** PR #3421 established the precedent that the whole trail for one patch setting — migration, validator, services, partner allowlist, canonical export, `PatchTab`, all locales, docs — lands together. Splitting it means a half-wired column, and the `PATCH_NORMALIZED_MATERIAL_KEYS` count check fails closed across the split.

### Task 1.1: Migration + Drizzle columns

**Files:**
- Create: `apps/api/migrations/2026-10-05-100100-patch-reboot-deferral-settings.sql`
- Modify: `apps/api/src/db/schema/configurationPolicies.ts:201-209`
- Reference (copy the function body from): `apps/api/migrations/2026-08-21-patch-reboot-delay-minutes.sql:54-230`

**Interfaces:**
- Produces: columns `reboot_allow_deferral boolean NOT NULL DEFAULT false`, `reboot_max_deferrals integer NOT NULL DEFAULT 3`, `reboot_deferral_minutes integer NOT NULL DEFAULT 60`; Drizzle names `rebootAllowDeferral`, `rebootMaxDeferrals`, `rebootDeferralMinutes`; canonical export keys `rebootAllowDeferral`, `rebootMaxDeferrals`, `rebootDeferralMinutes`.

- [ ] **Step 1: Confirm the migration filename sorts last**

```bash
ls apps/api/migrations | grep '\.sql$' | sort | tail -3
```
Expected at authoring time: last line is `2026-10-04-100003-portal-visibility-indexes.sql`. If a newer file exists, bump the plan's chosen name so it still sorts last. Never reuse a date/time already present.

- [ ] **Step 2: Write the migration header + columns + CHECKs**

```sql
-- Patch reboot deferral settings (#3207)
--
-- Adds the end-user deferral budget to config_policy_patch_settings, alongside
-- reboot_delay_minutes (#3197 / 2026-08-21-patch-reboot-delay-minutes.sql).
--
-- Tenancy: this table has NO org_id. Ownership and tenancy come transitively
-- through feature_link_id -> config_policy_feature_links -> configuration_policies,
-- which already carries org_id XOR partner_id, and 'patch' is already in
-- PARTNER_LINKABLE_FEATURE_TYPES. So partner-wide-first is satisfied by
-- inheritance: no new one_owner_chk, no new RLS policy, no dual-axis suite, and
-- no cascade or export-policy registration (those lists key on org_id columns,
-- which this table does not have). Verified against tenantCascade.ts and
-- tenantExportPolicyRegistry.ts rather than assumed.
--
-- Defaults are deliberately OFF: reboot_allow_deferral=false reproduces today's
-- behaviour exactly, so this migration is behaviour-neutral on every existing row.

ALTER TABLE config_policy_patch_settings
  ADD COLUMN IF NOT EXISTS reboot_allow_deferral boolean NOT NULL DEFAULT false;

ALTER TABLE config_policy_patch_settings
  ADD COLUMN IF NOT EXISTS reboot_max_deferrals integer NOT NULL DEFAULT 3;

ALTER TABLE config_policy_patch_settings
  ADD COLUMN IF NOT EXISTS reboot_deferral_minutes integer NOT NULL DEFAULT 60;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'config_policy_patch_settings_reboot_max_deferrals_chk'
  ) THEN
    ALTER TABLE config_policy_patch_settings
      ADD CONSTRAINT config_policy_patch_settings_reboot_max_deferrals_chk
      CHECK (reboot_max_deferrals BETWEEN 0 AND 10);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'config_policy_patch_settings_reboot_deferral_minutes_chk'
  ) THEN
    ALTER TABLE config_policy_patch_settings
      ADD CONSTRAINT config_policy_patch_settings_reboot_deferral_minutes_chk
      CHECK (reboot_deferral_minutes BETWEEN 5 AND 1440);
  END IF;
END $$;
```

- [ ] **Step 3: Re-emit the canonical export function with the three new keys**

Copy `apps/api/migrations/2026-08-21-patch-reboot-delay-minutes.sql:44-230` **verbatim** into the new file, then make exactly one edit inside the patch branch — after the `'rebootDelayMinutes', settings.reboot_delay_minutes,` line (line 138 of the source file) insert:

```sql
        'rebootAllowDeferral', settings.reboot_allow_deferral,
        'rebootMaxDeferrals', settings.reboot_max_deferrals,
        'rebootDeferralMinutes', settings.reboot_deferral_minutes,
```

Keep the trailing `REVOKE ALL ON FUNCTION ... FROM PUBLIC;` and the guarded `GRANT EXECUTE ... TO breeze_app;` block (source `:225-230`). **Do not skip the ACL re-emit** — `CREATE OR REPLACE` resets function ACLs and `partnerApiConfigurationWatermark.integration.test.ts:240-278` asserts `patchPreMaterializerPublic: false, patchPreMaterializerApp: true`.

Sanity-check the copy before moving on:

```bash
diff <(sed -n '54,230p' apps/api/migrations/2026-08-21-patch-reboot-delay-minutes.sql) \
     <(sed -n '/CREATE OR REPLACE FUNCTION public.breeze_partner_export_policy_settings_pre_patch/,$p' \
          apps/api/migrations/2026-10-05-100100-patch-reboot-deferral-settings.sql)
```
Expected: exactly the three added lines, nothing else.

- [ ] **Step 4: Add the Drizzle columns**

In `apps/api/src/db/schema/configurationPolicies.ts`, immediately after `rebootDelayMinutes` (`:205`):

```ts
  // #3207: end-user reboot deferral budget. Off by default so the shipped
  // behaviour (warn-then-reboot, #3197) is unchanged until an admin opts in.
  rebootAllowDeferral: boolean('reboot_allow_deferral').notNull().default(false),
  rebootMaxDeferrals: integer('reboot_max_deferrals').notNull().default(3),
  rebootDeferralMinutes: integer('reboot_deferral_minutes').notNull().default(60),
```

- [ ] **Step 5: Apply and verify no drift**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
```
Expected: migration applies, drift check clean. Re-run `pnpm db:migrate` once more — expected: no-op (idempotency proof).

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-10-05-100100-patch-reboot-deferral-settings.sql apps/api/src/db/schema/configurationPolicies.ts
git commit -m "feat(patching): add reboot deferral columns to patch policy settings (#3207)"
```

### Task 1.2: Validator + service plumbing + partner allowlist

**Files:**
- Modify: `packages/shared/src/validators/index.ts:736-760` (`patchInlineSettingsSchema`)
- Modify: `apps/api/src/services/configurationPolicy.ts:516-532` (write), `:979-1000` (read)
- Modify: `apps/api/src/services/configPolicyPatching.ts:315-337`, `:388-402`
- Modify: `apps/api/src/routes/partnerApi/configuration.ts:46-58`
- Test: `packages/shared/src/validators/patchInlineSettings.test.ts` (add cases to the existing file if one covers this schema; otherwise create)

**Interfaces:**
- Consumes: the Drizzle column names from Task 1.1.
- Produces: `patchInlineSettingsSchema` output type gains `rebootAllowDeferral: boolean`, `rebootMaxDeferrals: number`, `rebootDeferralMinutes: number` (all with defaults, so every existing caller keeps compiling).

- [ ] **Step 1: Write the failing validator tests**

```ts
describe('patchInlineSettings reboot deferral (#3207)', () => {
  it('defaults deferral off so existing policies are unchanged', () => {
    const parsed = patchInlineSettingsSchema.parse({});
    expect(parsed.rebootAllowDeferral).toBe(false);
    expect(parsed.rebootMaxDeferrals).toBe(3);
    expect(parsed.rebootDeferralMinutes).toBe(60);
  });

  it('rejects a deferral window below 5 minutes', () => {
    expect(() => patchInlineSettingsSchema.parse({ rebootDeferralMinutes: 4 })).toThrow();
  });

  it('rejects more than 10 deferrals', () => {
    expect(() => patchInlineSettingsSchema.parse({ rebootMaxDeferrals: 11 })).toThrow();
  });

  it('rejects deferral enabled with a zero budget — that is a UI lie, not a policy', () => {
    expect(() =>
      patchInlineSettingsSchema.parse({ rebootAllowDeferral: true, rebootMaxDeferrals: 0 }),
    ).toThrow(/rebootMaxDeferrals/);
  });

  it('rejects a total deferral budget that cannot fit before the 7-day agent ceiling', () => {
    // 10 x 1440 = 14400 minutes = 10 days; handleScheduleReboot caps delay at 10080.
    expect(() =>
      patchInlineSettingsSchema.parse({
        rebootAllowDeferral: true, rebootMaxDeferrals: 10, rebootDeferralMinutes: 1440,
      }),
    ).toThrow(/10080/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd packages/shared && npx vitest run src/validators/patchInlineSettings.test.ts
```
Expected: FAIL — the properties are `undefined` and no error is thrown.

- [ ] **Step 3: Add the schema fields and the coherence refinement**

In `patchInlineSettingsSchema`, after `rebootDelayMinutes` (`:749`):

```ts
  rebootAllowDeferral: z.boolean().default(false),
  rebootMaxDeferrals: z.number().int().min(0).max(10).default(3),
  rebootDeferralMinutes: z.number().int().min(5).max(1440).default(60),
```

Inside the existing `.superRefine((value, ctx) => { ... })` at `:754+`, append:

```ts
    if (value.rebootAllowDeferral && value.rebootMaxDeferrals === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rebootMaxDeferrals'],
        message: 'rebootMaxDeferrals must be at least 1 when deferral is enabled',
      });
    }
    // The agent refuses any schedule_reboot delay above 10080 minutes
    // (handlers_patch.go). A budget that cannot fit inside that ceiling would
    // let the UI promise deferrals the agent will always refuse.
    if (value.rebootAllowDeferral
        && value.rebootMaxDeferrals * value.rebootDeferralMinutes > 10080) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rebootDeferralMinutes'],
        message: 'rebootMaxDeferrals x rebootDeferralMinutes must not exceed 10080 minutes (7 days)',
      });
    }
```

- [ ] **Step 4: Run to verify they pass**

```bash
cd packages/shared && npx vitest run src/validators/patchInlineSettings.test.ts
```
Expected: PASS.

- [ ] **Step 5: Thread the columns through the four service enumerations**

Each of these is a hand-enumerated object; add the three fields in the same relative position as `rebootDelayMinutes`:

- `apps/api/src/services/configurationPolicy.ts:528` (insert values) — `rebootAllowDeferral: parsed.rebootAllowDeferral,` etc.
- `apps/api/src/services/configurationPolicy.ts:996` (read projection) — `rebootAllowDeferral: row.rebootAllowDeferral,` etc.
- `apps/api/src/services/configPolicyPatching.ts:333` — `rebootAllowDeferral: row.patchSettings.rebootAllowDeferral,` etc.
- `apps/api/src/services/configPolicyPatching.ts:400` — `rebootAllowDeferral: normalized.settings.rebootAllowDeferral,` etc.

Then add the three keys to `PATCH_NORMALIZED_MATERIAL_KEYS` (`apps/api/src/routes/partnerApi/configuration.ts:46-58`), after `'rebootDelayMinutes'`:

```ts
  'rebootAllowDeferral',
  'rebootMaxDeferrals',
  'rebootDeferralMinutes',
```

- [ ] **Step 6: Grep-verify no enumeration was missed**

```bash
grep -rn "rebootDelayMinutes" apps/api/src packages/shared apps/web \
  | grep -v '\.test\.' | grep -v locales
```
Every file listed must also contain `rebootAllowDeferral`. This is a mechanical check, not a judgement call — the `PATCH_NORMALIZED_MATERIAL_KEYS` count guard fails closed on any miss.

- [ ] **Step 7: Run the API unit suite for the touched files, then commit**

```bash
pnpm --filter @breeze/api test --run src/routes/partnerApi/configuration.test.ts
pnpm --filter @breeze/shared test --run
git add -A && git commit -m "feat(patching): thread reboot deferral settings through validators, services and partner API (#3207)"
```

### Task 1.3: Emit the deferral budget and a real `deadline` on `schedule_reboot`

**Files:**
- Modify: `apps/api/src/services/patchRebootHandler.ts:73-110` (`resolveRebootDelayMinutes`), `:177-217` (`executeReboot`)
- Modify: `apps/api/src/jobs/maintenanceRebootWorker.ts:66-128`, `:195-215`
- Test: `apps/api/src/services/patchRebootHandler.test.ts`, `apps/api/src/jobs/maintenanceRebootWorker.test.ts`

**Interfaces:**
- Produces: the `schedule_reboot` payload contract that W2 parses —
  ```ts
  {
    delayMinutes: number;      // existing
    reason: string;            // existing
    source: 'patch_job' | 'maintenance_window' | 'manual';  // existing
    deadline: string;          // NEW — RFC3339 hard stop, always sent
    allowDeferral: boolean;    // NEW
    maxDeferrals: number;      // NEW
    deferralMinutes: number;   // NEW
  }
  ```
- Produces (TS): `resolveRebootDeferralSettings(deviceId, deps?)` and `computeRebootDeadline(now, delayMinutes, deferral, windowEndsAt?)`, both exported from `patchRebootHandler.ts`.
- **Signature note:** `executeReboot(deviceId, reason, options)` today takes three arguments (`:177`). Give it a fourth optional `deps` parameter following the convention `resolveRebootDelayMinutes(deviceId, deps)` already uses (`:73`), defaulting to the real implementations, so the tests below can inject `resolvePatchConfigForDevice` and `queueCommandForExecution`. `options` also gains optional `deferral?: RebootDeferralSettings` and `windowEndsAt?: Date`, which the maintenance worker passes and the patch path leaves unset.

- [ ] **Step 1: Write the failing tests**

```ts
describe('executeReboot deferral payload (#3207)', () => {
  it('sends deferral settings resolved from the device patch policy', async () => {
    const queued = vi.fn().mockResolvedValue({ success: true });
    await executeReboot('device-1', 'Patch install', {}, {
      resolvePatchConfigForDevice: async () => ({
        rebootDelayMinutes: 15, rebootAllowDeferral: true,
        rebootMaxDeferrals: 2, rebootDeferralMinutes: 60,
      }),
      queueCommandForExecution: queued,
    });
    const payload = queued.mock.calls[0][2];
    expect(payload.allowDeferral).toBe(true);
    expect(payload.maxDeferrals).toBe(2);
    expect(payload.deferralMinutes).toBe(60);
  });

  it('always sends a deadline, and sets it to delay + the full deferral budget', async () => {
    // 15 + (2 x 60) = 135 minutes out. Without a deadline the agent defaults it
    // to now+delay and refuses every deferral (#3253).
    const queued = vi.fn().mockResolvedValue({ success: true });
    await executeReboot('device-1', 'Patch install', {}, {
      resolvePatchConfigForDevice: async () => ({
        rebootDelayMinutes: 15, rebootAllowDeferral: true,
        rebootMaxDeferrals: 2, rebootDeferralMinutes: 60,
      }),
      queueCommandForExecution: queued,
    });
    const payload = queued.mock.calls[0][2];
    const minutesOut = (Date.parse(payload.deadline) - Date.now()) / 60000;
    expect(minutesOut).toBeGreaterThan(134);
    expect(minutesOut).toBeLessThan(136);
  });

  it('with deferral disabled, deadline is exactly the scheduled reboot time', async () => {
    const queued = vi.fn().mockResolvedValue({ success: true });
    await executeReboot('device-1', 'Patch install', {}, {
      resolvePatchConfigForDevice: async () => ({
        rebootDelayMinutes: 15, rebootAllowDeferral: false,
        rebootMaxDeferrals: 3, rebootDeferralMinutes: 60,
      }),
      queueCommandForExecution: queued,
    });
    const payload = queued.mock.calls[0][2];
    expect(payload.allowDeferral).toBe(false);
    const minutesOut = (Date.parse(payload.deadline) - Date.now()) / 60000;
    expect(minutesOut).toBeLessThan(16);
  });

  it('falls back to deferral-off when the policy cannot be resolved', async () => {
    const queued = vi.fn().mockResolvedValue({ success: true });
    await executeReboot('device-1', 'Patch install', {}, {
      resolvePatchConfigForDevice: async () => { throw new Error('db down'); },
      queueCommandForExecution: queued,
    });
    expect(queued.mock.calls[0][2].allowDeferral).toBe(false);
  });
});
```

And in `maintenanceRebootWorker.test.ts`:

```ts
it('clamps the maintenance-window deadline to the end of the window', () => {
  const cmd = decideRebootCommand({
    rebootIfPending: true, windowActive: true, osType: 'windows',
    delayMinutes: 15,
    deferral: { allowDeferral: true, maxDeferrals: 4, deferralMinutes: 60 },
    windowEndsAt: new Date(Date.now() + 45 * 60_000),
  });
  // Budget would allow 15 + 240 = 255 minutes; the window closes in 45.
  const minutesOut = (Date.parse(cmd!.payload.deadline) - Date.now()) / 60000;
  expect(minutesOut).toBeLessThanOrEqual(45);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm --filter @breeze/api test --run src/services/patchRebootHandler.test.ts src/jobs/maintenanceRebootWorker.test.ts
```
Expected: FAIL — `payload.allowDeferral` and `payload.deadline` are `undefined`.

- [ ] **Step 3: Implement**

Add alongside `resolveRebootDelayMinutes` in `patchRebootHandler.ts`:

```ts
export type RebootDeferralSettings = {
  allowDeferral: boolean;
  maxDeferrals: number;
  deferralMinutes: number;
};

export const DEFERRAL_OFF: RebootDeferralSettings = {
  allowDeferral: false, maxDeferrals: 0, deferralMinutes: 0,
};

/**
 * Resolve the deferral budget for a device. Mirrors resolveRebootDelayMinutes:
 * a resolution failure falls back to the SAFE value, which here means
 * deferral OFF — never "let the user postpone indefinitely because we could
 * not read the policy".
 */
export async function resolveRebootDeferralSettings(
  deviceId: string,
  deps = { resolvePatchConfigForDevice },
): Promise<RebootDeferralSettings> {
  try {
    const cfg = await deps.resolvePatchConfigForDevice(deviceId);
    if (!cfg || cfg.rebootAllowDeferral !== true) return DEFERRAL_OFF;
    const maxDeferrals = clampInt(cfg.rebootMaxDeferrals, 0, 10, 0);
    const deferralMinutes = clampInt(cfg.rebootDeferralMinutes, 5, 1440, 60);
    if (maxDeferrals === 0) return DEFERRAL_OFF;
    return { allowDeferral: true, maxDeferrals, deferralMinutes };
  } catch (err) {
    captureException(err, { tags: { area: 'patchRebootHandler.deferral' } });
    return DEFERRAL_OFF;
  }
}

/**
 * The hard stop the agent clamps every deferral against (#3253 — `deadline`
 * has been stored and reported but never enforced; this is what gives it a
 * job). With deferral off it is exactly the scheduled reboot time, so an old
 * or non-deferring agent sees a deadline that changes nothing.
 */
export function computeRebootDeadline(
  now: Date, delayMinutes: number, deferral: RebootDeferralSettings, windowEndsAt?: Date,
): Date {
  const budget = deferral.allowDeferral
    ? deferral.maxDeferrals * deferral.deferralMinutes
    : 0;
  const derived = new Date(now.getTime() + (delayMinutes + budget) * 60_000);
  if (windowEndsAt && windowEndsAt < derived) return windowEndsAt;
  return derived;
}
```

Then in `executeReboot` (`:199-210`), extend the queued payload:

```ts
  const deferral = options.deferral ?? await resolveRebootDeferralSettings(deviceId);
  const deadline = computeRebootDeadline(new Date(), delayMinutes, deferral, options.windowEndsAt);
  const result = await queueCommandForExecution(deviceId, 'schedule_reboot', {
    delayMinutes,
    reason,
    source: 'patch_job',
    deadline: deadline.toISOString(),
    allowDeferral: deferral.allowDeferral,
    maxDeferrals: deferral.maxDeferrals,
    deferralMinutes: deferral.deferralMinutes,
  }, { expectedOrgId: options.expectedOrgId });
```

In `maintenanceRebootWorker.ts`, extend `WindowsRebootPayload` (`:66`) with the same four keys, give `decideRebootCommand` (`:100-128`) the extra `deferral` and `windowEndsAt` arguments, and resolve both lazily next to the existing `deps.resolveRebootDelayMinutes(device.id)` call (`:202-204`). The **Linux** `reboot` payload keeps its `{ delay }` wire key untouched — see the comment at `:67-69`; it is a different command and a different contract.

- [ ] **Step 4: Run to verify they pass**

```bash
pnpm --filter @breeze/api test --run src/services/patchRebootHandler.test.ts src/jobs/maintenanceRebootWorker.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(patching): send reboot deferral budget and an enforced deadline on schedule_reboot (#3207)"
```

### Task 1.4: PatchTab UI + 8 locales + docs

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/PatchTab.tsx:35-51`, `:715-743`
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/PatchTab.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/policies.json:888` (insert after `rebootDelayMinutesDescription`)
- Modify: `apps/docs/src/content/docs/features/patch-management.mdx:394-396`

- [ ] **Step 1: Write the failing component test**

```tsx
it('hides the deferral budget fields until deferral is enabled', () => {
  render(<PatchTab settings={{ ...defaults, rebootPolicy: 'if_required' }} onChange={vi.fn()} />);
  expect(screen.getByTestId('patch-reboot-allow-deferral')).toBeInTheDocument();
  expect(screen.queryByTestId('patch-reboot-max-deferrals')).not.toBeInTheDocument();
});

it('shows max deferrals and the deferral window once enabled', () => {
  render(<PatchTab settings={{ ...defaults, rebootPolicy: 'if_required', rebootAllowDeferral: true }} onChange={vi.fn()} />);
  expect(screen.getByTestId('patch-reboot-max-deferrals')).toHaveValue(3);
  expect(screen.getByTestId('patch-reboot-deferral-minutes')).toHaveValue(60);
});

it('hides the whole deferral block when the reboot policy is never', () => {
  render(<PatchTab settings={{ ...defaults, rebootPolicy: 'never' }} onChange={vi.fn()} />);
  expect(screen.queryByTestId('patch-reboot-allow-deferral')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/PatchTab.test.tsx
```
Expected: FAIL — `patch-reboot-allow-deferral` not found.

- [ ] **Step 3: Add the fields**

Extend the settings interface (`:35-37`) and defaults (`:49-51`) with `rebootAllowDeferral: false`, `rebootMaxDeferrals: 3`, `rebootDeferralMinutes: 60`. Render inside the same `settings.rebootPolicy !== 'never'` guard that wraps the delay field (`:715`), directly below it: a checkbox `patch-reboot-allow-deferral` (styled like the `exclusiveWindowsUpdate` toggle at `:745-790`), and — nested under `settings.rebootAllowDeferral` — two `<input type="number">` fields `patch-reboot-max-deferrals` (min 1, max 10) and `patch-reboot-deferral-minutes` (min 5, max 1440), each with a description `<p>`. Follow the delay field's `onChange` shape: `update('rebootMaxDeferrals', Number(e.target.value) || 3)`.

- [ ] **Step 4: Add the i18n keys to all 8 locales**

Insert after `rebootDelayMinutesDescription` (line 888) in each `policies.json`, under `configurationPolicies.featureTabs.patchTab`:

```json
        "rebootAllowDeferral": "Let users postpone the restart",
        "rebootAllowDeferralDescription": "Show the signed-in user a prompt with a Postpone button. Requires the Breeze helper to be running in the user's session; Linux devices fall back to the terminal warning. The restart still happens at the deadline once the postponements run out.",
        "rebootMaxDeferrals": "Maximum postponements",
        "rebootMaxDeferralsDescription": "How many times one user may postpone a single restart before it proceeds.",
        "rebootDeferralMinutes": "Postpone by (minutes)",
        "rebootDeferralMinutesDescription": "How far each postponement pushes the restart out.",
```

English verbatim in the six non-English European locales; translate `tr-TR` (the only locale that carries real translations).

- [ ] **Step 5: Run web tests + locale parity**

```bash
cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/PatchTab.test.tsx src/lib/i18n/localeParity.test.ts
```
Expected: PASS, 2 files.

- [ ] **Step 6: Document the settings**

Add three rows to the patch-policy settings table at `apps/docs/src/content/docs/features/patch-management.mdx:394-396`, matching the `rebootDelayMinutes` row's tone, and note explicitly that deferral needs a signed-in user with the Breeze helper running and that Linux is not covered until W4 ships.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(web): reboot deferral policy fields in PatchTab (#3207)"
```

### Task 1.5: Fix the contract suites that this wave deliberately reddens

**Files:**
- Modify: `apps/api/src/__tests__/integration/partnerApiConfigurationWatermark.integration.test.ts:515-522`
- Modify: `apps/api/src/__tests__/integration/patchCanonicalExportParity.integration.test.ts:221-236`

- [ ] **Step 1: Update the watermark key list**

Add `rebootAllowDeferral: false, rebootMaxDeferrals: 3, rebootDeferralMinutes: 60,` to the `expect(settings.patch).toEqual({...})` block. This assertion is *supposed* to fail on a new column — that is the only structural coverage the export has.

- [ ] **Step 2: Add parity cases**

Mirror the four existing `rebootDelayMinutes` cases (`:221-236`) for `rebootMaxDeferrals` (non-numeric string, non-integral, `-1`, `11`) and `rebootDeferralMinutes` (`4`, `1441`), each expecting a fall back to the schema default.

- [ ] **Step 3: Run the integration suites**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm --filter @breeze/api test:integration -- --run src/__tests__/integration/partnerApiConfigurationWatermark.integration.test.ts
```
**Note the trap:** `test:integration -- <paths>` runs the *whole* suite regardless. Prefer `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerApiConfigurationWatermark.integration.test.ts`. Expected: PASS. Repeat for `patchCanonicalExportParity`.

- [ ] **Step 4: Commit and open the W1 PR**

```bash
git add -A && git commit -m "test(patching): update patch export contract suites for deferral columns (#3207)"
gh pr create --base main \
  --title "feat(patching): reboot deferral policy settings (#3207 W1)" \
  --body "Closes #<W1 sub-issue>. Covers: migration + Drizzle columns, the canonical-export re-emit and its ACL restore, PATCH_NORMALIZED_MATERIAL_KEYS, validator + service enumerations, the schedule_reboot payload gaining deadline/allowDeferral/maxDeferrals/deferralMinutes, PatchTab + 8 locales, docs. State explicitly that defaults keep behaviour identical and that partnerApiConfigurationWatermark was updated because the new columns are SUPPOSED to red it."
```

**W1 acceptance criteria**
- [ ] `pnpm db:migrate` twice in a row is a no-op the second time.
- [ ] `pnpm db:check-drift` clean.
- [ ] A partner-wide patch policy (`org_id NULL`, `partner_id` set) round-trips the three settings through `GET /partner-api/v1/configuration` — proving partner-wide-by-inheritance, not just asserted.
- [ ] `PATCH_NORMALIZED_MATERIAL_KEYS.length` matches the SQL `jsonb_build_object` key count (any drift makes patch exports `blocked`).
- [ ] With `rebootAllowDeferral` left at its default, a patch job dispatches a `schedule_reboot` payload whose only new key that matters is `deadline == scheduledAt` — behaviour-identical to today.
- [ ] `Test API`, `Test Web`, and `Integration Tests` green on a PR based on `main`.

---

## Wave 2 — Agent deferral state machine

**Ships:** `RebootManager` understands a deferral budget, can execute a deferral, clamps it against the hard deadline, and persists the count best-effort. No user can trigger a deferral yet (that is W3), but the whole state machine is unit-tested and visible through `get_reboot_status`.

**Why this is a separate wave:** it is the only part with genuinely tricky concurrency (timer generations, the `osInvoked` window), it is entirely testable without any platform UI, and it must be provably inert when the policy is off before any prompt code exists to trigger it.

### Task 2.1: The pure deferral arithmetic and ledger

**Files:**
- Create: `agent/internal/patching/reboot_deferral.go` *(untagged — it must run in the `test-agent` linux job)*
- Test: `agent/internal/patching/reboot_deferral_test.go`

**Interfaces:**
- Produces:
  ```go
  type DeferralPolicy struct {
      Allowed         bool
      MaxDeferrals    int
      DeferralMinutes int
  }

  type DeferralOutcome struct {
      Granted   bool
      NewDelay  time.Duration // only meaningful when Granted
      Reason    string        // why it was refused, for the user-facing message
  }

  // ComputeDeferral is pure: no clock, no disk, no locks.
  func ComputeDeferral(policy DeferralPolicy, used int, now, deadline time.Time) DeferralOutcome

  type DeferralLedger struct { Deadline time.Time; Used int }
  func LoadDeferralLedger(path string, deadline time.Time, now time.Time) int
  func SaveDeferralLedger(path string, deadline time.Time, used int) error
  ```

- [ ] **Step 1: Write the failing table-driven test**

```go
func TestComputeDeferral(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	pol := DeferralPolicy{Allowed: true, MaxDeferrals: 2, DeferralMinutes: 60}

	cases := []struct {
		name     string
		policy   DeferralPolicy
		used     int
		deadline time.Time
		want     DeferralOutcome
	}{
		{
			name: "policy disabled refuses",
			policy: DeferralPolicy{Allowed: false, MaxDeferrals: 5, DeferralMinutes: 60},
			used: 0, deadline: now.Add(9 * time.Hour),
			want: DeferralOutcome{Granted: false, Reason: "deferral is not enabled by policy"},
		},
		{
			name: "budget exhausted refuses", policy: pol, used: 2,
			deadline: now.Add(9 * time.Hour),
			want: DeferralOutcome{Granted: false, Reason: "no postponements remaining"},
		},
		{
			name: "grants the full window when the deadline is far away",
			policy: pol, used: 0, deadline: now.Add(9 * time.Hour),
			want: DeferralOutcome{Granted: true, NewDelay: 60 * time.Minute},
		},
		{
			// #3253: the deadline is what actually bounds a deferral. A 60-minute
			// window with 20 minutes left must yield 20, not 60.
			name: "clamps the window to the hard deadline",
			policy: pol, used: 1, deadline: now.Add(20 * time.Minute),
			want: DeferralOutcome{Granted: true, NewDelay: 20 * time.Minute},
		},
		{
			name: "refuses when the clamp leaves less than MinRebootDelay",
			policy: pol, used: 0, deadline: now.Add(30 * time.Second),
			want: DeferralOutcome{Granted: false, Reason: "the restart deadline has been reached"},
		},
		{
			name: "refuses a deadline already in the past",
			policy: pol, used: 0, deadline: now.Add(-time.Minute),
			want: DeferralOutcome{Granted: false, Reason: "the restart deadline has been reached"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ComputeDeferral(tc.policy, tc.used, now, tc.deadline)
			if got.Granted != tc.want.Granted || got.NewDelay != tc.want.NewDelay {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
			if !got.Granted && got.Reason != tc.want.Reason {
				t.Errorf("reason = %q, want %q", got.Reason, tc.want.Reason)
			}
		})
	}
}

func TestDeferralLedgerRoundTripsOnMatchingDeadline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reboot_deferrals.json")
	now := time.Now()
	deadline := now.Add(2 * time.Hour).Truncate(time.Minute)

	if err := SaveDeferralLedger(path, deadline, 2); err != nil {
		t.Fatalf("save: %v", err)
	}
	if got := LoadDeferralLedger(path, deadline, now); got != 2 {
		t.Errorf("same-deadline reload = %d, want 2 (the budget must survive an agent restart)", got)
	}
	// A different deadline is a different administrator decision: fresh budget.
	if got := LoadDeferralLedger(path, deadline.Add(time.Hour), now); got != 0 {
		t.Errorf("different-deadline reload = %d, want 0", got)
	}
	// An expired ledger never resurrects.
	if got := LoadDeferralLedger(path, deadline, deadline.Add(time.Minute)); got != 0 {
		t.Errorf("expired reload = %d, want 0", got)
	}
}

func TestDeferralLedgerMissingOrCorruptFileMeansZero(t *testing.T) {
	dir := t.TempDir()
	if got := LoadDeferralLedger(filepath.Join(dir, "nope.json"), time.Now().Add(time.Hour), time.Now()); got != 0 {
		t.Errorf("missing file = %d, want 0", got)
	}
	bad := filepath.Join(dir, "bad.json")
	_ = os.WriteFile(bad, []byte("{not json"), 0o600)
	if got := LoadDeferralLedger(bad, time.Now().Add(time.Hour), time.Now()); got != 0 {
		t.Errorf("corrupt file = %d, want 0", got)
	}
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd agent && go test -race ./internal/patching/ -run 'Deferral'
```
Expected: FAIL to compile — `ComputeDeferral` undefined.

- [ ] **Step 3: Implement**

```go
// Deferral arithmetic and its on-disk ledger.
//
// Untagged on purpose, for the same reason reboot_plan.go is: ./internal/patching
// is not in the test-agent-windows package allowlist (#3019, #3046), so anything
// behind a build tag is tested nowhere in CI.
//
// The COUNTER is a UX affordance; the DEADLINE is the guarantee. A deferral is
// always clamped to the deadline the API sent, and refused outright when the
// clamp leaves less room than MinRebootDelay. That is what finally gives
// RebootState.Deadline a job (#3253: stored and reported, never enforced).
package patching

const deferralLedgerFile = "reboot_deferrals.json"

type DeferralPolicy struct {
	Allowed         bool
	MaxDeferrals    int
	DeferralMinutes int
}

type DeferralOutcome struct {
	Granted  bool
	NewDelay time.Duration
	Reason   string
}

func ComputeDeferral(policy DeferralPolicy, used int, now, deadline time.Time) DeferralOutcome {
	if !policy.Allowed || policy.MaxDeferrals <= 0 || policy.DeferralMinutes <= 0 {
		return DeferralOutcome{Reason: "deferral is not enabled by policy"}
	}
	if used >= policy.MaxDeferrals {
		return DeferralOutcome{Reason: "no postponements remaining"}
	}
	want := time.Duration(policy.DeferralMinutes) * time.Minute
	remaining := deadline.Sub(now)
	if remaining < want {
		want = remaining
	}
	if want < MinRebootDelay {
		return DeferralOutcome{Reason: "the restart deadline has been reached"}
	}
	return DeferralOutcome{Granted: true, NewDelay: want}
}

// DeferralLedger persists the count for ONE reboot campaign, keyed by its hard
// deadline truncated to the minute. A schedule carrying a different deadline is
// a different administrator decision (Schedule is documented last-writer-wins),
// so it legitimately starts a fresh budget — the deadline still bounds it.
// Best-effort by design: a missing, corrupt, or expired ledger means zero
// deferrals used, never an error that blocks a reboot.
type DeferralLedger struct {
	Deadline time.Time `json:"deadline"`
	Used     int       `json:"used"`
}

func deferralLedgerPath() string {
	return filepath.Join(config.GetDataDir(), deferralLedgerFile)
}

func LoadDeferralLedger(path string, deadline, now time.Time) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	var ledger DeferralLedger
	if err := json.Unmarshal(data, &ledger); err != nil {
		log.Warn("reboot deferral ledger unreadable; postponement count resets to zero", "path", path, "error", err)
		return 0
	}
	if !ledger.Deadline.Truncate(time.Minute).Equal(deadline.Truncate(time.Minute)) {
		return 0
	}
	if !ledger.Deadline.After(now) {
		return 0
	}
	if ledger.Used < 0 {
		return 0
	}
	return ledger.Used
}

func SaveDeferralLedger(path string, deadline time.Time, used int) error {
	data, err := json.Marshal(DeferralLedger{Deadline: deadline, Used: used})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}
```

- [ ] **Step 4: Run to verify pass**

```bash
cd agent && go test -race ./internal/patching/ -run 'Deferral' -v
```
Expected: PASS, all sub-tests.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/patching/reboot_deferral.go agent/internal/patching/reboot_deferral_test.go
git commit -m "feat(agent): reboot deferral arithmetic and persistence ledger (#3207)"
```

### Task 2.2: Wire deferral into `RebootManager`

**Files:**
- Modify: `agent/internal/patching/reboot_manager.go`
- Modify: `agent/internal/patching/reboot_manager_test.go`

**Interfaces:**
- Consumes: `DeferralPolicy`, `ComputeDeferral`, `LoadDeferralLedger`, `SaveDeferralLedger` from Task 2.1.
- Produces:
  ```go
  type RebootOptions struct { Deferral DeferralPolicy }
  func (r *RebootManager) ScheduleWithOptions(delay time.Duration, deadline time.Time, reason, source string, opts RebootOptions) error
  func (r *RebootManager) Defer() (time.Duration, error)   // new fire delay, or an error whose message is user-facing
  ```
  `RebootState` gains `DeferralsUsed int`, `MaxDeferrals int`, `DeferralMinutes int`, `DeferralAllowed bool` (all `json:"..."`, so `get_reboot_status` surfaces them with no handler change — `rebootStateToMap` marshals the whole struct).

- [ ] **Step 1: Write the failing manager tests**

```go
func TestScheduleKeepsDeferralOffByDefault(t *testing.T) {
	rm, _, _, _ := newTestManager(t, 3)
	if err := rm.Schedule(15*time.Minute, time.Now().Add(15*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	if rm.State().DeferralAllowed {
		t.Fatal("plain Schedule must not enable deferral — old call sites keep today's behaviour")
	}
	if _, err := rm.Defer(); err == nil {
		t.Fatal("Defer must refuse when the policy did not enable it")
	}
}

func TestDeferReschedulesAndReNotifies(t *testing.T) {
	rm, timers, notifications, osCalls := newTestManager(t, 3)
	deadline := time.Now().Add(3 * time.Hour)
	opts := RebootOptions{Deferral: DeferralPolicy{Allowed: true, MaxDeferrals: 2, DeferralMinutes: 60}}
	if err := rm.ScheduleWithOptions(15*time.Minute, deadline, "Patch", "patch_job", opts); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	timers.runAt(0)
	before := len(*notifications)

	newDelay, err := rm.Defer()
	if err != nil {
		t.Fatalf("Defer: %v", err)
	}
	if newDelay != 60*time.Minute {
		t.Errorf("newDelay = %v, want 60m", newDelay)
	}
	if got := rm.State().DeferralsUsed; got != 1 {
		t.Errorf("DeferralsUsed = %d, want 1", got)
	}
	// The re-schedule must emit its own lead notification (#3197 invariant:
	// the user is told, at offset 0, every time the countdown changes).
	timers.runAt(0)
	if len(*notifications) <= before {
		t.Error("deferral did not re-announce the new restart time")
	}
	if len(*osCalls) != 0 {
		t.Fatal("deferral must not invoke the OS reboot")
	}
}

func TestDeferRefusesPastTheBudget(t *testing.T) {
	rm, timers, _, _ := newTestManager(t, 3)
	opts := RebootOptions{Deferral: DeferralPolicy{Allowed: true, MaxDeferrals: 1, DeferralMinutes: 60}}
	_ = rm.ScheduleWithOptions(15*time.Minute, time.Now().Add(3*time.Hour), "Patch", "patch_job", opts)
	timers.runAt(0)
	if _, err := rm.Defer(); err != nil {
		t.Fatalf("first Defer: %v", err)
	}
	if _, err := rm.Defer(); err == nil {
		t.Fatal("second Defer must be refused at MaxDeferrals=1")
	}
}

func TestDeferDoesNotConsumeCircuitBreakerBudget(t *testing.T) {
	// D6: rebootHistory is appended only inside runOSReboot. Deferring must
	// leave the maxRebootsPerDay breaker completely untouched.
	rm, timers, _, osCalls := newTestManager(t, 1)
	opts := RebootOptions{Deferral: DeferralPolicy{Allowed: true, MaxDeferrals: 3, DeferralMinutes: 60}}
	_ = rm.ScheduleWithOptions(15*time.Minute, time.Now().Add(5*time.Hour), "Patch", "patch_job", opts)
	timers.runAt(0)
	for i := 0; i < 3; i++ {
		if _, err := rm.Defer(); err != nil {
			t.Fatalf("Defer %d: %v", i, err)
		}
	}
	// Budget exhausted; let the final schedule run to completion.
	plan := PlanReboot(60 * time.Minute)
	timers.runAt(plan.OSInvokeAt)
	if len(*osCalls) != 1 {
		t.Fatalf("osCalls = %d, want 1 — three deferrals must not have burned the breaker", len(*osCalls))
	}
}

func TestDeferIsRefusedOnceTheOSCountdownHasStarted(t *testing.T) {
	// After OSInvokeAt the countdown lives in the OS, not this process. Granting
	// a deferral there would report success while the machine still went down.
	rm, timers, _, _ := newTestManager(t, 3)
	opts := RebootOptions{Deferral: DeferralPolicy{Allowed: true, MaxDeferrals: 3, DeferralMinutes: 60}}
	_ = rm.ScheduleWithOptions(5*time.Minute, time.Now().Add(3*time.Hour), "Patch", "patch_job", opts)
	plan := PlanReboot(5 * time.Minute)
	timers.runAt(plan.OSInvokeAt)
	if _, err := rm.Defer(); err == nil {
		t.Fatal("Defer must be refused once the OS countdown is running")
	}
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd agent && go test -race ./internal/patching/ -run 'Defer|DeferralOff'
```
Expected: FAIL to compile — `ScheduleWithOptions`, `RebootOptions`, `Defer` undefined.

- [ ] **Step 3: Implement**

Add to `RebootState`:

```go
	// Deferral budget for the current schedule (#3207). Zero-valued when the
	// policy did not enable it, which is the default and reproduces the
	// pre-#3207 behaviour exactly.
	DeferralAllowed bool `json:"deferralAllowed"`
	DeferralsUsed   int  `json:"deferralsUsed"`
	MaxDeferrals    int  `json:"maxDeferrals"`
	DeferralMinutes int  `json:"deferralMinutes"`
```

Add to `RebootManager`: `deferral DeferralPolicy`, `deferralsUsed int`, `deferralLedger func() string` (seam, default `deferralLedgerPath`).

```go
// Schedule keeps its exact pre-#3207 signature and semantics: no deferral.
// Every existing caller (and every old test) therefore keeps today's behaviour
// with no edit, which is the point — an absent policy must never mean "enabled".
func (r *RebootManager) Schedule(delay time.Duration, deadline time.Time, reason, source string) error {
	return r.ScheduleWithOptions(delay, deadline, reason, source, RebootOptions{})
}

type RebootOptions struct {
	Deferral DeferralPolicy
}

func (r *RebootManager) ScheduleWithOptions(delay time.Duration, deadline time.Time, reason, source string, opts RebootOptions) error {
	// ... existing body up to and including r.cancelLocked() / gen := r.generation ...

	r.deferral = opts.Deferral
	r.deferralsUsed = 0
	if opts.Deferral.Allowed {
		// Resume a count from a previous process lifetime, but only for THIS
		// campaign (same deadline). Best-effort: a missing ledger means zero.
		r.deferralsUsed = LoadDeferralLedger(r.deferralLedger(), deadline, r.nowFn())
	}

	// ... existing plan/state/timer construction, plus these state fields ...
	r.state.DeferralAllowed = opts.Deferral.Allowed
	r.state.DeferralsUsed = r.deferralsUsed
	r.state.MaxDeferrals = opts.Deferral.MaxDeferrals
	r.state.DeferralMinutes = opts.Deferral.DeferralMinutes
	return nil
}

// Defer postpones the scheduled reboot by the policy's deferral window, clamped
// to the hard deadline. Returns the new delay, or an error whose message is
// intended to be shown to the user.
//
// Refused once osInvoked is true: past OSInvokeAt the countdown lives in the OS
// and abortOSReboot cannot be honoured on every platform (macOS BSD shutdown(8)
// has no cancel flag), so granting a deferral there would report success while
// the machine still went down — the same class of lie Cancel() documents.
func (r *RebootManager) Defer() (time.Duration, error) {
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return 0, fmt.Errorf("reboot manager is stopped")
	}
	if r.osInvoked {
		r.mu.Unlock()
		return 0, fmt.Errorf("the restart countdown has already started and cannot be postponed")
	}
	if !r.state.RebootScheduled {
		r.mu.Unlock()
		return 0, fmt.Errorf("no reboot scheduled")
	}
	outcome := ComputeDeferral(r.deferral, r.deferralsUsed, r.nowFn(), r.state.Deadline)
	if !outcome.Granted {
		r.mu.Unlock()
		return 0, fmt.Errorf("%s", outcome.Reason)
	}
	deadline, reason, source := r.state.Deadline, r.state.Reason, r.state.Source
	used := r.deferralsUsed + 1
	policy := r.deferral
	r.mu.Unlock()

	// Re-Schedule under the same options; it cancels the in-flight timers,
	// bumps the generation and emits a fresh lead notification quoting the new
	// time — which is exactly how the user learns the countdown moved.
	if err := r.ScheduleWithOptions(outcome.NewDelay, deadline, reason, source, RebootOptions{Deferral: policy}); err != nil {
		return 0, err
	}

	r.mu.Lock()
	r.deferralsUsed = used
	r.state.DeferralsUsed = used
	path := r.deferralLedger()
	r.mu.Unlock()

	if err := SaveDeferralLedger(path, deadline, used); err != nil {
		// Best-effort: losing the ledger costs the user an extra postponement
		// after an agent restart, it never lets them exceed the DEADLINE.
		log.Warn("failed to persist reboot deferral ledger", "error", err)
	}
	log.Info("reboot postponed by user", "newDelay", outcome.NewDelay.String(), "used", used, "max", policy.MaxDeferrals)
	return outcome.NewDelay, nil
}
```

Note the ordering: `ScheduleWithOptions` resets `deferralsUsed` from the ledger, so `Defer` re-applies the incremented count *after* the re-schedule. Keep it that way and keep the test that pins it.

- [ ] **Step 4: Run the whole patching suite**

```bash
cd agent && go test -race ./internal/patching/
```
Expected: PASS, including every pre-existing #3197 test unmodified.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/patching/
git commit -m "feat(agent): deferral state machine in RebootManager (#3207)"
```

### Task 2.3: Parse the new payload keys in `handleScheduleReboot`

**Files:**
- Modify: `agent/internal/heartbeat/handlers_patch.go:209-246`
- Test: `agent/internal/heartbeat/handlers_patch_test.go` (create if absent)
- Possibly modify: `agent/internal/remote/tools/` — add `ParsePayloadBool` if there is no boolean payload helper (`grep -rn "func GetPayloadBool\|func ParsePayloadBool" agent/internal/remote/tools/`).

- [ ] **Step 1: Write the failing tests**

```go
func TestScheduleRebootDefaultsDeferralOffWhenTheApiOmitsIt(t *testing.T) {
	// An OLD API sends only delayMinutes/reason/source. The absent keys must
	// mean deferral OFF — never "enabled".
	h := newTestHeartbeatWithRebootManager(t)
	res := handleScheduleReboot(h, Command{Payload: map[string]any{
		"delayMinutes": float64(15), "reason": "Patch", "source": "patch_job",
	}})
	if res.Status != "success" {
		t.Fatalf("status = %q", res.Status)
	}
	if h.rebootMgr.State().DeferralAllowed {
		t.Error("deferral enabled from a payload that never mentioned it")
	}
}

func TestScheduleRebootHonoursTheDeferralBudget(t *testing.T) {
	h := newTestHeartbeatWithRebootManager(t)
	deadline := time.Now().Add(3 * time.Hour).UTC().Format(time.RFC3339)
	res := handleScheduleReboot(h, Command{Payload: map[string]any{
		"delayMinutes": float64(15), "reason": "Patch", "source": "patch_job",
		"deadline": deadline,
		"allowDeferral": true, "maxDeferrals": float64(2), "deferralMinutes": float64(60),
	}})
	if res.Status != "success" {
		t.Fatalf("status = %q", res.Status)
	}
	st := h.rebootMgr.State()
	if !st.DeferralAllowed || st.MaxDeferrals != 2 || st.DeferralMinutes != 60 {
		t.Fatalf("state = %+v", st)
	}
}

func TestScheduleRebootRejectsAnOutOfRangeDeferralBudget(t *testing.T) {
	h := newTestHeartbeatWithRebootManager(t)
	res := handleScheduleReboot(h, Command{Payload: map[string]any{
		"delayMinutes": float64(15), "allowDeferral": true,
		"maxDeferrals": float64(99), "deferralMinutes": float64(60),
	}})
	if res.Status == "success" {
		t.Fatal("maxDeferrals=99 must be rejected, not silently clamped into a 99-hour window")
	}
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd agent && go test -race ./internal/heartbeat/ -run 'ScheduleReboot'
```
Expected: FAIL.

- [ ] **Step 3: Implement**

In `handleScheduleReboot`, after the existing `deadline` parse (`:231-236`), add:

```go
	// Deferral budget (#3207). Absent keys mean OFF: an old API never sends
	// them, and "not mentioned" must never widen what the agent will do.
	// Ranges mirror the API-side CHECK constraints so a forged or corrupted
	// payload is REJECTED rather than clamped — a silent clamp is how #3373
	// turned a malformed delayMinutes into a 60-minute reboot.
	opts := patching.RebootOptions{}
	if tools.GetPayloadBool(cmd.Payload, "allowDeferral", false) {
		maxDeferrals, err := tools.ParsePayloadInt(cmd.Payload, "maxDeferrals", 0)
		if err != nil {
			return tools.NewErrorResult(err, time.Since(start).Milliseconds())
		}
		deferralMinutes, err := tools.ParsePayloadInt(cmd.Payload, "deferralMinutes", 0)
		if err != nil {
			return tools.NewErrorResult(err, time.Since(start).Milliseconds())
		}
		if maxDeferrals < 1 || maxDeferrals > 10 {
			return tools.NewErrorResult(fmt.Errorf("maxDeferrals must be 1-10, got %d", maxDeferrals), time.Since(start).Milliseconds())
		}
		if deferralMinutes < 5 || deferralMinutes > 1440 {
			return tools.NewErrorResult(fmt.Errorf("deferralMinutes must be 5-1440, got %d", deferralMinutes), time.Since(start).Milliseconds())
		}
		opts.Deferral = patching.DeferralPolicy{
			Allowed: true, MaxDeferrals: maxDeferrals, DeferralMinutes: deferralMinutes,
		}
	}

	if err := h.rebootMgr.ScheduleWithOptions(delay, deadline, reason, source, opts); err != nil {
```

Also harden the existing `deadline` parse while you are here: a malformed `deadline` is currently swallowed (`if parsed, err := ...; err == nil`), noted but not fixed in #3421. With deferral live, a swallowed deadline silently collapses the budget. Return an error instead:

```go
	if deadlineStr := tools.GetPayloadString(cmd.Payload, "deadline", ""); deadlineStr != "" {
		parsed, err := time.Parse(time.RFC3339, deadlineStr)
		if err != nil {
			return tools.NewErrorResult(fmt.Errorf("invalid deadline %q: %w", deadlineStr, err), time.Since(start).Milliseconds())
		}
		deadline = parsed
	}
```

- [ ] **Step 4: Run to verify pass, then cross-compile**

```bash
cd agent && go test -race ./internal/heartbeat/ ./internal/patching/ && \
  GOOS=windows go build ./... && GOOS=darwin go build ./... && GOOS=linux go build ./... && go vet ./...
```
Expected: all PASS/clean.

- [ ] **Step 5: Commit and open the W2 PR**

```bash
git add -A && git commit -m "feat(agent): parse the reboot deferral budget from schedule_reboot (#3207)"
gh pr create --base main \
  --title "feat(agent): reboot deferral state machine (#3207 W2)" \
  --body "Closes #<W2 sub-issue>. State the backward-compat matrix (old agent/new API, new agent/old API), that Schedule() keeps its old signature and semantics, that deferral does not touch the circuit breaker, that this is what finally makes RebootState.Deadline load-bearing (cross-ref #3253 without closing it), and that no user can trigger a deferral until W3."
```

**W2 acceptance criteria**
- [ ] Every pre-existing test in `reboot_manager_test.go` and `reboot_plan_test.go` passes **unmodified**.
- [ ] `Schedule(...)` (the old 4-arg form) provably leaves deferral off.
- [ ] A payload with no deferral keys produces `DeferralAllowed == false`.
- [ ] Three deferrals do not add a single entry to `rebootHistory` (circuit breaker untouched).
- [ ] `Defer()` after `OSInvokeAt` is refused.
- [ ] A deferral is clamped to the deadline, and refused when the clamp leaves `< MinRebootDelay`.
- [ ] `go test -race ./...` green; `GOOS=windows|darwin|linux go build ./...` clean; `go vet ./...` clean.
- [ ] Every new Go test lives in an **untagged** file (`grep -L 'go:build' <new test files>` returns them all).

---

## Wave 3 — The user prompt (Windows + macOS)

**Ships:** the feature becomes real. When policy allows it and a helper session is present, the reboot's lead and reminder notifications become a native dialog with **Restart now** / **Postpone N minutes**, and the answer drives `RebootManager.Defer()`.

### Task 3.1: A correlated notification request in the broker

**Files:**
- Modify: `agent/internal/ipc/message.go:239-252`
- Modify: `agent/internal/sessionbroker/broker.go` (add next to `BroadcastNotification`, `:1285-1324`)
- Test: `agent/internal/sessionbroker/broker_notify_test.go`

**Interfaces:**
- Produces:
  ```go
  // Additive optional fields only — Actions stays []string so an OLD helper
  // still unmarshals the request and renders the plain toast.
  type NotifyRequest struct {
      Title, Body, Icon, Urgency string
      Actions   []string `json:"actions,omitempty"`
      TimeoutMs int      `json:"timeoutMs,omitempty"` // NEW: how long to hold an interactive prompt
  }

  func (b *Broker) RequestNotificationDecision(req ipc.NotifyRequest, timeout time.Duration) (ipc.NotifyResult, error)
  ```

- [ ] **Step 1: Write the failing broker tests**

```go
func TestRequestNotificationDecisionReturnsTheFirstAnswer(t *testing.T) {
	// Two notify-scoped sessions; the second answers first. Whichever real
	// human clicks first wins — there is one machine and one reboot.
}

func TestRequestNotificationDecisionSkipsNonNotifyScopedSessions(t *testing.T) {
	// The assist helper (assist/consent_ui) and the watchdog must never be
	// asked. This is the same filter BroadcastNotification documents at
	// broker.go:1285-1303, and weakening it is explicitly forbidden there.
}

func TestRequestNotificationDecisionTimesOutWithNoAnswer(t *testing.T) {
	// No answer must be indistinguishable from "the user did nothing":
	// Delivered may be true, ActionClicked must be empty, error must be nil-safe
	// for the caller to treat as "proceed as scheduled".
}

func TestRequestNotificationDecisionWithNoSessionsIsNotAnError(t *testing.T) {
	// Linux today, or a Windows box at the logon screen. The reboot must still
	// proceed on schedule; the caller falls back to BroadcastNotification.
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd agent && go test -race ./internal/sessionbroker/ -run 'RequestNotificationDecision'
```
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

Add `TimeoutMs` to `ipc.NotifyRequest` (additive, `omitempty`). Then:

```go
// RequestNotificationDecision sends an interactive notification to every
// notify-scoped session and returns the first answer.
//
// This is the response-bearing sibling of BroadcastNotification, which is
// deliberately left alone: the reboot warning LADDER stays fire-and-forget
// (#3197 guarantees the user is TOLD; it does not need an answer). Only the
// rungs that offer a postponement come through here.
//
// The plumbing already existed and was simply never used end to end:
// NotifyRequest.Actions / NotifyResult.ActionClicked are declared in
// ipc/message.go, expectedResponseType maps TypeNotify -> TypeNotifyResult, and
// Client.handleNotify already replies on the same envelope id. What was missing
// is that BroadcastNotification calls SendNotify with an EMPTY envelope id, so
// the helper's reply is orphaned. Here the id is real and per-session.
//
// Fan-out is concurrent and first-answer-wins: there is one machine and one
// reboot, so the first human to click decides. Sessions that time out or error
// are not failures — an unanswered prompt means "proceed as scheduled", which
// is the fail-safe direction (the reboot still happens; it is never cancelled
// by silence).
func (b *Broker) RequestNotificationDecision(req ipc.NotifyRequest, timeout time.Duration) (ipc.NotifyResult, error) {
	b.mu.RLock()
	sessions := make([]*Session, 0, len(b.sessions))
	for _, s := range b.sessions {
		if s.HasScope("notify") {
			sessions = append(sessions, s)
		}
	}
	b.mu.RUnlock()

	if len(sessions) == 0 {
		return ipc.NotifyResult{}, nil // not an error: no interactive user
	}

	type answer struct {
		res ipc.NotifyResult
		err error
	}
	results := make(chan answer, len(sessions))
	for _, s := range sessions {
		go func(s *Session) {
			// A REAL, per-session envelope id — this is the whole difference from
			// BroadcastNotification, which passes "" and orphans the reply.
			// SendCommand rejects a duplicate in-flight id (ErrDuplicateCommand),
			// so it must be unique per call; use whatever id generator the
			// package already imports rather than adding a new dependency.
			id := "notify-" + newEnvelopeID()
			resp, err := s.SendCommand(id, ipc.TypeNotify, &req, timeout)
			if err != nil {
				results <- answer{err: err}
				return
			}
			if resp.Error != "" {
				results <- answer{err: fmt.Errorf("notify helper error: %s", resp.Error)}
				return
			}
			var out ipc.NotifyResult
			if err := json.Unmarshal(resp.Payload, &out); err != nil {
				results <- answer{err: fmt.Errorf("decode notify result: %w", err)}
				return
			}
			results <- answer{res: out}
		}(s)
	}

	var best ipc.NotifyResult
	var lastErr error
	for range sessions {
		a := <-results
		if a.err != nil {
			lastErr = a.err
			continue
		}
		if a.res.ActionClicked != "" {
			return a.res, nil // first real decision wins
		}
		if a.res.Delivered {
			best.Delivered = true
		}
	}
	if !best.Delivered && lastErr != nil {
		return best, lastErr
	}
	return best, nil
}
```

- [ ] **Step 4: Run to verify pass, then commit**

```bash
cd agent && go test -race ./internal/sessionbroker/
git add -A && git commit -m "feat(agent): response-bearing notification request in the session broker (#3207)"
```

### Task 3.2: The helper-side prompt dialog

**Files:**
- Create: `agent/internal/userhelper/notify_prompt.go` *(untagged — copy builder + the `showNotifyPromptFn` seam)*
- Create: `agent/internal/userhelper/notify_prompt_windows.go`, `notify_prompt_darwin.go`, `notify_prompt_other.go`
- Create: `agent/internal/userhelper/notify_prompt_test.go` *(untagged)*
- Modify: `agent/internal/userhelper/notify.go`, `agent/internal/userhelper/client.go:911-927`

**Interfaces:**
- Produces:
  ```go
  // showNotifyPromptOS renders a modal prompt with the given buttons and returns
  // the LABEL of the clicked button, or "" if the countdown expired / no
  // decision was made. Never blocks past timeout.
  func showNotifyPromptOS(req ipc.NotifyRequest) (clicked string)
  ```
  `handleNotify` returns `ipc.NotifyResult{Delivered, ActionClicked}`.

- [ ] **Step 1: Write the failing tests**

```go
// swapNotifyPrompt installs a fake dialog and restores the real one.
func swapNotifyPrompt(t *testing.T, fn func(ipc.NotifyRequest) string) *[]ipc.NotifyRequest {
	t.Helper()
	seen := []ipc.NotifyRequest{}
	prev := showNotifyPromptFn
	showNotifyPromptFn = func(req ipc.NotifyRequest) string {
		seen = append(seen, req)
		return fn(req)
	}
	t.Cleanup(func() { showNotifyPromptFn = prev })
	return &seen
}

func TestHandleNotifyRoutesActionsToThePromptSeam(t *testing.T) {
	seen := swapNotifyPrompt(t, func(ipc.NotifyRequest) string { return "Postpone 1 hour" })
	conn := newFakeConn(t)
	c := &Client{conn: conn}

	c.handleNotify(notifyEnvelope(t, "env-1", ipc.NotifyRequest{
		Title: "Restart Scheduled", Body: "in 15 minutes",
		Actions: []string{"Restart now", "Postpone 1 hour"}, TimeoutMs: 120000,
	}))

	if len(*seen) != 1 {
		t.Fatalf("prompt seam called %d times, want 1", len(*seen))
	}
	res := conn.lastNotifyResult(t, "env-1")
	if res.ActionClicked != "Postpone 1 hour" {
		t.Errorf("ActionClicked = %q, want %q", res.ActionClicked, "Postpone 1 hour")
	}
	if !res.Delivered {
		t.Error("Delivered = false after a dialog the user answered")
	}
}

func TestHandleNotifyWithoutActionsKeepsTheToastPath(t *testing.T) {
	// Regression guard for the #3197 warning ladder: an actionless notify must
	// stay a fire-and-forget toast, not a modal dialog in the user's face.
	seen := swapNotifyPrompt(t, func(ipc.NotifyRequest) string { return "boom" })
	conn := newFakeConn(t)
	c := &Client{conn: conn}

	c.handleNotify(notifyEnvelope(t, "env-2", ipc.NotifyRequest{
		Title: "Restart Soon", Body: "in 15 minutes",
	}))

	if len(*seen) != 0 {
		t.Fatal("an actionless notify must never open a modal dialog")
	}
	if got := conn.lastNotifyResult(t, "env-2").ActionClicked; got != "" {
		t.Errorf("ActionClicked = %q, want empty", got)
	}
}

func TestNotifyPromptTimeoutReportsNoAction(t *testing.T) {
	// An expired countdown is "the user did nothing", NOT a postponement.
	// Silence must never grant a deferral.
	swapNotifyPrompt(t, func(ipc.NotifyRequest) string { return "" })
	conn := newFakeConn(t)
	c := &Client{conn: conn}

	c.handleNotify(notifyEnvelope(t, "env-3", ipc.NotifyRequest{
		Title: "Restart Scheduled", Body: "in 15 minutes",
		Actions: []string{"Restart now", "Postpone 1 hour"},
	}))

	res := conn.lastNotifyResult(t, "env-3")
	if res.ActionClicked != "" {
		t.Errorf("ActionClicked = %q, want empty on timeout", res.ActionClicked)
	}
}

func TestNotifyPromptTimeoutMsIsBounded(t *testing.T) {
	cases := []struct{ in, want int }{
		{0, defaultNotifyPromptTimeoutMs},
		{-1, defaultNotifyPromptTimeoutMs},
		{30_000, 30_000},
		{maxNotifyPromptTimeoutMs + 1, maxNotifyPromptTimeoutMs},
	}
	for _, tc := range cases {
		if got := notifyPromptTimeoutMs(ipc.NotifyRequest{TimeoutMs: tc.in}); got != tc.want {
			t.Errorf("notifyPromptTimeoutMs(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestSanitizeNotifyRequestCapsActions(t *testing.T) {
	// Already implemented (notify_common.go:31-35) but unpinned. The prompt path
	// makes the cap load-bearing: it bounds the dialog's button row.
	req := sanitizeNotifyRequest(ipc.NotifyRequest{
		Actions: []string{"a", "b", "c", "d", "e", "f"},
	})
	if len(req.Actions) != 4 {
		t.Fatalf("len(Actions) = %d, want 4", len(req.Actions))
	}
}
```

`newFakeConn` / `notifyEnvelope` / `lastNotifyResult` are small local helpers: a `conn` stub recording every `SendTyped(id, msgType, payload)` call, a helper that JSON-marshals a `NotifyRequest` into an `*ipc.Envelope`, and an accessor that unmarshals the recorded `notify_result` payload. Follow the fixture style already in `agent/internal/userhelper/consent_test.go`.

- [ ] **Step 2: Run to verify failure**

```bash
cd agent && go test -race ./internal/userhelper/ -run 'NotifyPrompt|HandleNotify'
```
Expected: FAIL.

- [ ] **Step 3: Implement the shared seam and route `handleNotify`**

`notify_prompt.go`:

```go
package userhelper

// showNotifyPromptFn is the platform dialog seam; tests swap it for a fake.
// It blocks until the user answers or the countdown expires, mirroring
// showConsentDialogFn (consent.go) — the same request/response-with-timeout
// shape, which is why this reuses those platform vehicles rather than
// inventing toast activation (see the plan's D4).
var showNotifyPromptFn = showNotifyPromptOS

const (
	defaultNotifyPromptTimeoutMs = 120_000
	maxNotifyPromptTimeoutMs     = 600_000
)

func notifyPromptTimeoutMs(req ipc.NotifyRequest) int {
	if req.TimeoutMs <= 0 {
		return defaultNotifyPromptTimeoutMs
	}
	if req.TimeoutMs > maxNotifyPromptTimeoutMs {
		return maxNotifyPromptTimeoutMs
	}
	return req.TimeoutMs
}
```

`client.go` `handleNotify` becomes:

```go
	req = sanitizeNotifyRequest(req)
	var result ipc.NotifyResult
	if len(req.Actions) > 0 {
		// Interactive: a modal prompt whose answer the daemon is waiting on.
		clicked := showNotifyPromptFn(req)
		result = ipc.NotifyResult{Delivered: true, ActionClicked: clicked}
	} else {
		result = ipc.NotifyResult{Delivered: showNotification(req)}
	}
	if err := c.conn.SendTyped(env.ID, ipc.TypeNotifyResult, result); err != nil {
```

Note `handleNotify` is dispatched via `safeGo` (`client.go:384-385`), which recovers panics but sends nothing back. Because the daemon now *waits*, add the same guaranteed-reply defer that `handleConsentRequest` uses (`consent.go:36-58`): on panic or fall-through, send a `NotifyResult{Delivered:false}` rather than letting the daemon block to timeout. A missing reply is not fatal here (silence means "proceed"), but the timeout is 2 minutes of an unnecessary wait.

`notify_prompt_windows.go` — reuse the `MessageBoxTimeoutW` proc already declared in `consent_dialog_windows.go`:

```go
//go:build windows

// Buttons come from MB_YESNO: Yes = Actions[0] (Restart now), No = Actions[1]
// (Postpone). MessageBoxTimeoutW is the only Win32 message box with a real
// countdown, which is why consent_dialog_windows.go already uses it; the
// timeout return (32000) maps to "" — no decision, proceed as scheduled.
func showNotifyPromptOS(req ipc.NotifyRequest) string {
	// ... build body as req.Body + "\r\n\r\n" + "Yes = <Actions[0]>, No = <Actions[1]>"
	// ... call procMessageBoxTimeoutW with MB_YESNO|MB_ICONWARNING|MB_TOPMOST|MB_SYSTEMMODAL|MB_SETFOREGROUND
	// ... consentIDYes -> req.Actions[0]; consentIDNo -> req.Actions[1]; anything else -> ""
}
```

`notify_prompt_darwin.go` — mirror `consent_dialog_darwin.go`:

```go
//go:build darwin

// osascript `display dialog ... buttons {...} giving up after N`. "gave up:true"
// maps to "" (no decision). A -128 cancel maps to the LAST button, which is the
// "Restart now" default — cancelling a restart warning must never be read as a
// postponement (see the plan's fail-safe direction).
```

`notify_prompt_other.go` — `//go:build !windows && !darwin`, returns `""`. Linux gets its prompt from the daemon side in W4, not from a helper that does not ship (D7).

- [ ] **Step 4: Run to verify pass**

```bash
cd agent && go test -race ./internal/userhelper/ && \
  GOOS=windows go build ./... && GOOS=darwin go build ./... && GOOS=linux go build ./...
```
Expected: PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(agent): native prompt dialog for actions-bearing notifications (#3207)"
```

### Task 3.3: Manager prompts, and the answer drives `Defer()`

**Files:**
- Modify: `agent/internal/patching/reboot_manager.go` (add the `promptFn` seam and prompt on the deferrable rungs)
- Modify: `agent/internal/patching/reboot_manager_test.go`
- Modify: `agent/internal/heartbeat/heartbeat.go:1006-1010`

**Interfaces:**
- Produces:
  ```go
  // PromptFunc shows an interactive notification and returns the clicked label
  // ("" = no decision). Nil = no interactive surface on this platform.
  type PromptFunc func(title, body, urgency string, actions []string, timeout time.Duration) string

  func NewRebootManagerWithPrompt(notifyFn NotifyFunc, promptFn PromptFunc, maxRebootsPerDay int) *RebootManager
  ```
  Button labels are constants so the manager can compare what came back:
  ```go
  const RebootActionRestartNow = "Restart now"
  func rebootActionPostpone(d time.Duration) string // "Postpone 1 hour" / "Postpone 30 minutes"
  ```

- [ ] **Step 1: Write the failing tests**

```go
type promptCall struct {
	title   string
	urgency string
	actions []string
}

// newTestManagerWithPrompt extends newTestManager (already in this file) with a
// scripted prompt seam. reply is consulted per call, in order; a short list
// means every later call returns "" (no decision).
func newTestManagerWithPrompt(t *testing.T, maxPerDay int, replies ...string) (
	*RebootManager, *fakeTimers, *[]notifyCall, *[]time.Duration, *[]promptCall,
) {
	t.Helper()
	rm, timers, notifications, osCalls := newTestManager(t, maxPerDay)
	var mu sync.Mutex
	prompts := []promptCall{}
	rm.promptFn = func(title, body, urgency string, actions []string, _ time.Duration) string {
		mu.Lock()
		i := len(prompts)
		prompts = append(prompts, promptCall{title, urgency, append([]string{}, actions...)})
		mu.Unlock()
		if i < len(replies) {
			return replies[i]
		}
		return ""
	}
	return rm, timers, notifications, osCalls, &prompts
}

func TestPromptOfferedOnlyWhileDeferralsRemain(t *testing.T) {
	// Offering a button that Defer() will refuse is worse than offering none.
	rm, timers, _, _, prompts := newTestManagerWithPrompt(t, 3, "Postpone 1 hour")
	opts := RebootOptions{Deferral: DeferralPolicy{Allowed: true, MaxDeferrals: 1, DeferralMinutes: 60}}
	if err := rm.ScheduleWithOptions(15*time.Minute, time.Now().Add(5*time.Hour), "Patch", "patch_job", opts); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}

	timers.runAt(0) // lead rung: budget available -> prompt with two buttons
	if len(*prompts) != 1 {
		t.Fatalf("prompts = %d, want 1", len(*prompts))
	}
	if len((*prompts)[0].actions) != 2 {
		t.Fatalf("actions = %v, want 2 buttons", (*prompts)[0].actions)
	}
	if rm.State().DeferralsUsed != 1 {
		t.Fatalf("DeferralsUsed = %d, want 1", rm.State().DeferralsUsed)
	}

	before := len(*prompts)
	timers.runAt(0) // the re-scheduled lead rung: budget now exhausted
	if len(*prompts) != before {
		t.Errorf("a prompt was offered with zero deferrals remaining: %v", (*prompts)[before].actions)
	}
}

func TestPostponeClickDefersTheSchedule(t *testing.T) {
	rm, timers, _, osCalls, _ := newTestManagerWithPrompt(t, 3, "Postpone 1 hour")
	opts := RebootOptions{Deferral: DeferralPolicy{Allowed: true, MaxDeferrals: 2, DeferralMinutes: 60}}
	_ = rm.ScheduleWithOptions(15*time.Minute, time.Now().Add(5*time.Hour), "Patch", "patch_job", opts)

	timers.runAt(0)

	st := rm.State()
	if st.DeferralsUsed != 1 {
		t.Errorf("DeferralsUsed = %d, want 1", st.DeferralsUsed)
	}
	if !st.RebootScheduled {
		t.Error("RebootScheduled = false after a postponement")
	}
	if len(*osCalls) != 0 {
		t.Fatal("a postponement must not invoke the OS reboot")
	}
	// The new schedule is a full 60-minute plan, so its OS invocation sits at
	// PlanReboot(60m).OSInvokeAt — proof the countdown really moved.
	want := PlanReboot(60 * time.Minute).OSInvokeAt
	found := false
	for _, off := range timers.offsets() {
		if off == want {
			found = true
		}
	}
	if !found {
		t.Errorf("no timer armed at %v after the postponement; offsets = %v", want, timers.offsets())
	}
}

func TestRestartNowShortensTheCountdownWithoutSkippingTheClosingNotice(t *testing.T) {
	// "Restart now" must NOT reboot instantly: the closing notice still has to
	// render before the session goes away, which is the exact race #3197 fixed.
	rm, timers, _, osCalls, _ := newTestManagerWithPrompt(t, 3, RebootActionRestartNow)
	opts := RebootOptions{Deferral: DeferralPolicy{Allowed: true, MaxDeferrals: 2, DeferralMinutes: 60}}
	_ = rm.ScheduleWithOptions(60*time.Minute, time.Now().Add(5*time.Hour), "Patch", "patch_job", opts)

	timers.runAt(0)

	if len(*osCalls) != 0 {
		t.Fatal("Restart now must not invoke the OS reboot synchronously")
	}
	plan := PlanReboot(MinRebootDelay)
	timers.runAt(plan.OSInvokeAt)
	if len(*osCalls) != 1 {
		t.Fatalf("osCalls = %d, want 1 after the shortened countdown elapsed", len(*osCalls))
	}
	if (*osCalls)[0] < time.Minute {
		t.Errorf("OS grace = %v, want at least a minute so the closing toast renders", (*osCalls)[0])
	}
}

func TestNoAnswerLeavesTheScheduleExactlyAsItWas(t *testing.T) {
	rm, timers, _, _, prompts := newTestManagerWithPrompt(t, 3) // no replies -> ""
	opts := RebootOptions{Deferral: DeferralPolicy{Allowed: true, MaxDeferrals: 2, DeferralMinutes: 60}}
	_ = rm.ScheduleWithOptions(60*time.Minute, time.Now().Add(5*time.Hour), "Patch", "patch_job", opts)
	scheduledAt := rm.State().ScheduledAt

	timers.runAt(0)

	if len(*prompts) != 1 {
		t.Fatalf("prompts = %d, want 1", len(*prompts))
	}
	st := rm.State()
	if st.DeferralsUsed != 0 {
		t.Error("silence granted a postponement")
	}
	if !st.ScheduledAt.Equal(scheduledAt) {
		t.Errorf("ScheduledAt moved from %v to %v on no answer", scheduledAt, st.ScheduledAt)
	}
}

func TestPromptIsNeverOfferedOnTheClosingRung(t *testing.T) {
	// The critical notice fires at OSInvokeAt, and Defer() is refused from that
	// moment on (the countdown is in the OS). A button there would always fail.
	rm, timers, notifications, _, prompts := newTestManagerWithPrompt(t, 3, "Postpone 1 hour")
	opts := RebootOptions{Deferral: DeferralPolicy{Allowed: true, MaxDeferrals: 2, DeferralMinutes: 60}}
	_ = rm.ScheduleWithOptions(60*time.Minute, time.Now().Add(5*time.Hour), "Patch", "patch_job", opts)

	plan := PlanReboot(60 * time.Minute)
	timers.runAt(plan.OSInvokeAt)

	if len(*prompts) != 0 {
		t.Fatalf("the closing rung offered a button: %v", (*prompts)[0].actions)
	}
	if len(*notifications) == 0 {
		t.Fatal("the closing rung emitted no notification at all")
	}
}

func TestPromptAbsentFallsBackToAPlainNotification(t *testing.T) {
	// No helper session (every Linux box before W4, and Windows at the logon
	// screen). The #3197 invariant does not depend on the prompt.
	rm, timers, notifications, _ := newTestManager(t, 3) // promptFn stays nil
	opts := RebootOptions{Deferral: DeferralPolicy{Allowed: true, MaxDeferrals: 2, DeferralMinutes: 60}}
	_ = rm.ScheduleWithOptions(15*time.Minute, time.Now().Add(5*time.Hour), "Patch", "patch_job", opts)

	timers.runAt(0)

	if len(*notifications) != 1 {
		t.Fatalf("notifications = %d, want 1 — the user must still be warned", len(*notifications))
	}
	if rm.State().DeferralsUsed != 0 {
		t.Error("a nil prompt seam must not defer anything")
	}
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd agent && go test -race ./internal/patching/ -run 'Prompt|Postpone'
```
Expected: FAIL.

- [ ] **Step 3: Implement**

In `emitNotification`, branch: if `r.deferral.Allowed`, `r.promptFn != nil`, this is **not** the closing rung (`n.After != plan.OSInvokeAt`; capture that in the closure alongside `gen`) **and** `ComputeDeferral(r.deferral, r.deferralsUsed, now, deadline).Granted`, then build

```go
actions := []string{
	RebootActionRestartNow,
	rebootActionPostpone(time.Duration(r.deferral.DeferralMinutes) * time.Minute),
}
```

call `r.promptFn(n.Title, n.Body, n.Urgency, actions, promptTimeout)` with `promptTimeout = min(time until the next rung, 2*time.Minute)`, and dispatch on the returned label:

```go
switch clicked {
case RebootActionRestartNow:
	// Collapse the countdown to the shortest schedule the planner allows.
	// NOT an immediate reboot: PlanReboot(MinRebootDelay) still emits the
	// closing notice and hands the OS a non-zero grace, which is the race
	// #3197 exists to prevent. Deferral policy is carried over so a user who
	// changes their mind at the new lead rung is not silently locked out.
	if err := r.ScheduleWithOptions(MinRebootDelay, deadline, reason, source,
		RebootOptions{Deferral: policy}); err != nil {
		log.Warn("could not honour Restart now", "error", err)
	}
case "":
	// No decision. Proceed exactly as scheduled — silence is never a
	// postponement and never an acceleration.
default:
	// Any postpone label. Compare against the label we sent rather than
	// trusting the helper to echo a well-known constant.
	if clicked == actions[1] {
		if _, err := r.Defer(); err != nil {
			// Refused (budget or deadline). Tell the user why rather than
			// leaving the click looking like it worked.
			r.notifyFn("Restart Cannot Be Postponed", err.Error(), "critical")
		}
	}
}
```

Otherwise call `notifyFn` exactly as today. The closing (critical) rung always uses `notifyFn` — see `TestPromptIsNeverOfferedOnTheClosingRung`.

**Do not hold `r.mu` across `promptFn`.** It blocks for up to two minutes; holding the mutex would stall `State()`, `Cancel()`, and the OS timer callback. Snapshot what you need, unlock, prompt, then re-lock (`emitNotification` already has this shape for `notifyFn`).

In `heartbeat.go:1006-1010`, construct with the prompt seam:

```go
	h.rebootMgr = patching.NewRebootManagerWithPrompt(
		func(title, body, urgency string) {
			if h.sessionBroker != nil {
				h.sessionBroker.BroadcastNotification(title, body, urgency)
			}
		},
		func(title, body, urgency string, actions []string, timeout time.Duration) string {
			if h.sessionBroker == nil {
				return ""
			}
			res, err := h.sessionBroker.RequestNotificationDecision(ipc.NotifyRequest{
				Title: title, Body: body, Urgency: urgency,
				Actions: actions, TimeoutMs: int(timeout.Milliseconds()),
			}, timeout)
			if err != nil {
				log.Debug("reboot prompt failed; proceeding as scheduled", "error", err.Error())
				return ""
			}
			return res.ActionClicked
		},
		cfg.PatchRebootMaxPerDay,
	)
```

- [ ] **Step 4: Run everything, then commit and open the W3 PR**

```bash
cd agent && go test -race ./... && go vet ./... && \
  GOOS=windows go build ./... && GOOS=darwin go build ./... && GOOS=linux go build ./...
git add -A && git commit -m "feat(agent): offer the user a postponement on deferrable reboot warnings (#3207)"
gh pr create --base main \
  --title "feat(agent): end-user reboot prompt with deferral, Windows + macOS (#3207 W3)" \
  --body "Closes #<W3 sub-issue>. Explain why the prompt is a native dialog rather than toast actions (plan decision D4), that BroadcastNotification is untouched and the scope filter is not weakened (#3255), and list the manual Windows/macOS verification under a Needs a real box heading rather than claiming it as verified."
```

**W3 acceptance criteria**
- [ ] With deferral off, `emitNotification` provably takes the identical path it takes today (assert `promptFn` is never called).
- [ ] With deferral on and no helper session, the user is still warned and the reboot still fires on time.
- [ ] `BroadcastNotification` is unchanged; the assist helper and watchdog are still excluded from both paths.
- [ ] An unanswered prompt neither defers nor accelerates.
- [ ] The critical/closing rung never offers a button.
- [ ] `go test -race ./...` green; three-GOOS build clean.
- [ ] **Manual verification, stated as required and not claimable from CI** (windows-tagged code is tested nowhere — #3019, #3046): on a real Windows box, a patch-triggered reboot with deferral on shows the dialog, "Postpone" moves the countdown, and `get_reboot_status` reports `deferralsUsed: 1`; on a real Mac with the desktop helper running, the same via `osascript`.

---

## Wave 4 — Linux parity

**Ships:** Linux devices get the same warning ladder and the same postponement prompt, closing the gap that #3421 could not (it granted the macOS desktop helper the `notify` scope, but **no helper binary ships for Linux at all** — D7).

### Task 4.1: Enumerate the graphical session

**Files:**
- Create: `agent/internal/patching/linuxsession/session.go` *(untagged core: parse `loginctl` output, build the env)*
- Create: `agent/internal/patching/linuxsession/session_test.go`
- Create: `agent/internal/patching/linuxsession/exec_linux.go`, `exec_other.go`

**Interfaces:**
- Produces:
  ```go
  type GraphicalSession struct {
      Username string
      UID      string
      Display  string // DISPLAY or WAYLAND_DISPLAY
      DBusAddr string // DBUS_SESSION_BUS_ADDRESS
  }
  // ParseLoginctlSessions is pure: it takes loginctl's output and returns the
  // active graphical sessions, so the parsing is testable without systemd.
  func ParseLoginctlSessions(showSessionOutput string) []GraphicalSession
  func (s GraphicalSession) CommandEnv() []string
  ```

- [ ] **Step 1: Write the failing table-driven parser test**

```go
package linuxsession

const waylandSession = `Name=alice
User=1000
Type=wayland
State=active
Display=
Remote=no
`

const x11Session = `Name=bob
User=1001
Type=x11
State=active
Display=:0
Remote=no
`

const ttySession = `Name=carol
User=1002
Type=tty
State=active
Display=
Remote=no
`

const closingSession = `Name=dave
User=1003
Type=x11
State=closing
Display=:0
Remote=no
`

const remoteSession = `Name=eve
User=1004
Type=x11
State=active
Display=:0
Remote=yes
`

func TestParseLoginctlSessions(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  []GraphicalSession
	}{
		{
			name:  "wayland session is graphical",
			input: waylandSession,
			want:  []GraphicalSession{{Username: "alice", UID: "1000", Display: "wayland-0"}},
		},
		{
			name:  "x11 session carries its DISPLAY",
			input: x11Session,
			want:  []GraphicalSession{{Username: "bob", UID: "1001", Display: ":0"}},
		},
		{name: "tty session is excluded", input: ttySession, want: nil},
		{name: "closing session is excluded", input: closingSession, want: nil},
		{
			// A remote (SSH/RDP) session has no local display to draw on; a
			// dialog there would render nowhere and block the reboot ladder.
			name: "remote session is excluded", input: remoteSession, want: nil,
		},
		{name: "empty input yields nothing", input: "", want: nil},
		{name: "malformed input yields nothing and does not panic", input: "=\n==\nType\n", want: nil},
		{
			name:  "multiple sessions are all returned",
			input: x11Session + "\n" + waylandSession,
			want: []GraphicalSession{
				{Username: "bob", UID: "1001", Display: ":0"},
				{Username: "alice", UID: "1000", Display: "wayland-0"},
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseLoginctlSessions(tc.input)
			if len(got) != len(tc.want) {
				t.Fatalf("got %d sessions %+v, want %d", len(got), got, len(tc.want))
			}
			for i := range got {
				if got[i].Username != tc.want[i].Username || got[i].UID != tc.want[i].UID {
					t.Errorf("session %d = %+v, want %+v", i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestCommandEnvCarriesDisplayAndBus(t *testing.T) {
	s := GraphicalSession{Username: "alice", UID: "1000", Display: ":0"}
	env := s.CommandEnv()
	assertHasEnv(t, env, "DISPLAY=:0")
	// The session bus address is derived from the UID when logind does not
	// report one; without it notify-send and zenity talk to root's bus and
	// render nothing.
	assertHasEnv(t, env, "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus")
	assertHasEnv(t, env, "XDG_RUNTIME_DIR=/run/user/1000")
}
```

`assertHasEnv` is a two-line helper scanning the slice for an exact string.

- [ ] **Step 2: Run to verify failure.** `cd agent && go test -race ./internal/patching/linuxsession/` — expected: FAIL to compile, `ParseLoginctlSessions` undefined.

- [ ] **Step 3: Implement.** Keep every `exec.Command` behind `exec_linux.go`; `ParseLoginctlSessions` and `CommandEnv` stay untagged so the `test-agent` linux job covers them. For a wayland session with an empty `Display=`, default to `wayland-0` and set `WAYLAND_DISPLAY` rather than `DISPLAY`.

- [ ] **Step 4: Run to verify pass.** `cd agent && go test -race ./internal/patching/linuxsession/ -v` — expected: PASS, all sub-tests.

- [ ] **Step 5: Commit.**

```bash
git add agent/internal/patching/linuxsession/
git commit -m "feat(agent): enumerate Linux graphical sessions for reboot prompts (#3207)"
```

### Task 4.2: Daemon-side Linux notify + prompt

**Files:**
- Create: `agent/internal/patching/reboot_prompt_linux.go`, `reboot_prompt_other.go`
- Modify: `agent/internal/heartbeat/heartbeat.go` (chain the fallback behind the broker path)

- [ ] **Step 1: Write the failing tests**

The command *construction* and the exit-code mapping are what is testable without a display; keep both builders untagged and pure.

```go
func TestLinuxNotifyArgs(t *testing.T) {
	got := linuxNotifyArgs("Restart Scheduled", "A system restart is scheduled in 15 minutes.", "critical")
	want := []string{"-u", "critical", "Restart Scheduled", "A system restart is scheduled in 15 minutes."}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("linuxNotifyArgs = %v, want %v", got, want)
	}
}

func TestLinuxPromptArgs(t *testing.T) {
	got := linuxPromptArgs("Restart Scheduled", "in 15 minutes",
		[]string{"Restart now", "Postpone 1 hour"}, 120*time.Second)
	want := []string{
		"--question", "--title", "Restart Scheduled", "--text", "in 15 minutes",
		"--ok-label", "Restart now", "--cancel-label", "Postpone 1 hour",
		"--timeout=120",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("linuxPromptArgs = %v, want %v", got, want)
	}
}

func TestLinuxPromptExitCodeMapping(t *testing.T) {
	// Mirrors consent_dialog_linux.go's contract exactly: 0=OK, 1=Cancel,
	// 5=timeout. A crashed or missing zenity must map to "" (no decision), not
	// to a postponement — silence never buys the user time.
	actions := []string{"Restart now", "Postpone 1 hour"}
	cases := []struct {
		name     string
		exitCode int
		runErr   bool
		want     string
	}{
		{name: "ok button", exitCode: 0, want: "Restart now"},
		{name: "cancel button", exitCode: 1, want: "Postpone 1 hour"},
		{name: "timeout", exitCode: 5, want: ""},
		{name: "zenity missing or crashed", runErr: true, want: ""},
		{name: "unknown exit code", exitCode: 3, want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := linuxPromptResult(tc.exitCode, tc.runErr, actions); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestLinuxPromptRefusedWithoutAGraphicalSession(t *testing.T) {
	// Headless box: no prompt, no error, and the reboot still proceeds. The
	// wall message from `shutdown -r +N` remains the only warning.
	prev := listGraphicalSessionsFn
	listGraphicalSessionsFn = func() []linuxsession.GraphicalSession { return nil }
	t.Cleanup(func() { listGraphicalSessionsFn = prev })

	if got := promptLinuxUser("t", "b", "critical", []string{"a", "b"}, time.Minute); got != "" {
		t.Errorf("got %q, want empty on a headless box", got)
	}
}
```

- [ ] **Step 2: Run to verify failure.** `cd agent && go test -race ./internal/patching/ -run 'Linux'` — expected: FAIL to compile.

- [ ] **Step 3: Implement.**

The daemon runs as root, so it must drop to the session user (`sudo -u`/`setuid` via `SysProcAttr.Credential`) — never run zenity as root against a user's display. Guard on `zenity` being present (mirror `consentUISupported`, `consent_supported_linux.go:16-27`); absent → notify-only, no prompt. **This also retroactively fixes #3197's Linux gap**: the warning ladder now reaches a Linux desktop user instead of relying solely on the `shutdown -r +N` wall message. Say so in the PR body.

- [ ] **Step 4: Chain it in `heartbeat.go`** — the broker path first (in case a Linux helper ever ships), then the Linux daemon path, then give up (`""`).

- [ ] **Step 5: Run everything. Step 6: Commit and open the W4 PR.**

**W4 acceptance criteria**
- [ ] `ParseLoginctlSessions` covers wayland/x11/tty/closing/remote/malformed, all untagged and running in `test-agent`.
- [ ] zenity/notify-send are invoked as the session user with the session's `DISPLAY` and `DBUS_SESSION_BUS_ADDRESS`, never as root.
- [ ] A headless Linux box (no graphical session, no zenity) warns via the existing wall message and reboots on schedule — no hang, no error spam.
- [ ] macOS and Windows behaviour is byte-identical to W3 (the Linux path is behind `//go:build linux`).
- [ ] **Manual verification required:** a real Linux desktop (GNOME/Wayland and XFCE/X11) shows the zenity prompt and postpones.

---

## Wave 5 — Console visibility and docs

**Ships:** a tech can see, in the console, that a device has a reboot scheduled, when it will fire, and how many times the user has postponed it.

**Relationship to #3254:** that issue asks for console visibility into a scheduled reboot generally (`get_reboot_status` / `cancel_reboot` have no server-side caller). This wave delivers the *read* half via the heartbeat, which is the cheap and always-fresh path, and deliberately does **not** absorb #3254's `cancel_reboot` UI. Cross-reference it; do not close it.

### Task 5.1: Report reboot status on the heartbeat

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go:83-110` (`HeartbeatPayload`), `:4097-4098`
- Modify: `apps/api/src/routes/agents/schemas.ts:176` area, `apps/api/src/routes/agents/heartbeat.ts:752` area
- Create: `apps/api/migrations/2026-10-05-100200-devices-reboot-schedule-columns.sql`
- Modify: `apps/api/src/db/schema/devices.ts:116-120`
- Modify: **`apps/api/src/services/tenantExportPolicyRegistry.ts`**

**Interfaces:**
- Produces: heartbeat field `rebootStatus?: { scheduledAt: string; deadline: string; source: string; deferralsUsed: number; maxDeferrals: number }`, persisted to `devices.reboot_scheduled_at`, `reboot_deadline`, `reboot_source`, `reboot_deferrals_used`.

- [ ] **Step 1: Write the failing API test**

```ts
describe('heartbeat rebootStatus (#3207)', () => {
  it('persists reboot status from the heartbeat', async () => {
    const update = vi.fn();
    await applyHeartbeat(deviceId, {
      status: 'online',
      pendingReboot: true,
      rebootStatus: {
        scheduledAt: '2026-09-02T13:00:00.000Z',
        deadline: '2026-09-02T16:00:00.000Z',
        source: 'patch_job',
        deferralsUsed: 1,
        maxDeferrals: 3,
      },
    }, { update });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      rebootScheduledAt: new Date('2026-09-02T13:00:00.000Z'),
      rebootDeadline: new Date('2026-09-02T16:00:00.000Z'),
      rebootSource: 'patch_job',
      rebootDeferralsUsed: 1,
    }));
  });

  it('leaves stored values alone when rebootStatus is absent (old agent)', async () => {
    // Absent must mean "no news", not "cancelled" — otherwise every old agent
    // in the fleet wipes the console's view on its next heartbeat.
    const update = vi.fn();
    await applyHeartbeat(deviceId, { status: 'online', pendingReboot: true }, { update });
    const patch = update.mock.calls[0][0];
    expect(patch).not.toHaveProperty('rebootScheduledAt');
    expect(patch).not.toHaveProperty('rebootDeferralsUsed');
  });

  it('clears reboot status when the agent reports rebootStatus: null', async () => {
    // An explicit null IS news: the reboot was cancelled or has already fired.
    const update = vi.fn();
    await applyHeartbeat(deviceId, { status: 'online', rebootStatus: null }, { update });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      rebootScheduledAt: null,
      rebootDeadline: null,
      rebootSource: null,
      rebootDeferralsUsed: null,
    }));
  });

  it('drops a malformed rebootStatus without failing the whole heartbeat', async () => {
    // schemas.ts:176's `.catch(undefined)` convention: one bad optional field
    // must never cost the device its metrics, uptime and lastSeenAt update.
    const update = vi.fn();
    await applyHeartbeat(deviceId, {
      status: 'online',
      rebootStatus: { scheduledAt: 'not-a-date', deferralsUsed: 'lots' },
    }, { update });
    expect(update).toHaveBeenCalled();
    expect(update.mock.calls[0][0]).not.toHaveProperty('rebootScheduledAt');
  });
});
```

`applyHeartbeat` stands for whichever function in `apps/api/src/routes/agents/heartbeat.ts` owns the device-row update around `:752`; name the test after the real symbol once you have opened the file.

- [ ] **Step 2: Run to verify failure.** `pnpm --filter @breeze/api test --run src/routes/agents/heartbeat.test.ts`

- [ ] **Step 3: Write the migration**

Four **scalar** columns on `devices`, all nullable:

```sql
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reboot_scheduled_at timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reboot_deadline timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reboot_source varchar(32);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reboot_deferrals_used integer;
```

Scalars deliberately, not one `jsonb` blob: `devices` is in `CORE_ORG_CASCADE_DELETE_ORDER`, so every column must be classified in `CORE_TENANT_EXPORT_POLICY`, and **any `json`/`jsonb`/`bytea` column is forced into `excludedOpen`** — which would mean the reboot status never appears in a tenant export at all. Scalars classify as `included`.

- [ ] **Step 4: Register the columns in the export policy — this is the step that gets missed**

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, add all four column names to the `devices` entry's `included` group. Then prove it:

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```
Expected: PASS. Skipping this is a latent GDPR org-erasure bug; code review has caught this class 0/5 times and the contract tests 5/5.

No cascade-list change is needed (`devices` is already registered; this adds columns, not a table). Confirm mechanically anyway:

```bash
grep -n "'devices'" apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts
```

- [ ] **Step 5: Implement the agent + API sides.** `HeartbeatPayload.RebootStatus *RebootStatusReport` with `json:"rebootStatus,omitempty"`; populate next to `payload.PendingReboot` (`:4097-4098`) from `h.rebootMgr.State()` when `RebootScheduled` is true. API: an optional zod object with `.catch(undefined)` (matching the `pendingReboot` convention at `schemas.ts:176`), and a persist path that distinguishes absent (no news) from explicit null (clear).

- [ ] **Step 6: Run to verify pass. Step 7: Commit.**

### Task 5.2: Surface it in the device UI and the docs

**Files:**
- Modify: `apps/api/src/routes/devices/core.ts:746`, `:924` (add the four fields to the device projections)
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx`
- Modify: `apps/web/src/locales/*/devices.json` × 8
- Modify: `apps/docs/src/content/docs/features/patch-management.mdx`, `apps/docs/src/content/docs/agents/commands.mdx`

- [ ] **Step 1: Write the failing component test**

```tsx
it('renders a scheduled-restart badge when the device reports one', () => {
  render(<DeviceDetails device={{ ...baseDevice,
    rebootScheduledAt: '2026-09-02T13:00:00.000Z',
    rebootSource: 'patch_job',
    rebootDeferralsUsed: 0,
  }} />);
  expect(screen.getByTestId('device-reboot-scheduled')).toBeInTheDocument();
});

it('shows the postponement count once the user has deferred', () => {
  render(<DeviceDetails device={{ ...baseDevice,
    rebootScheduledAt: '2026-09-02T13:00:00.000Z',
    rebootSource: 'patch_job',
    rebootDeferralsUsed: 2,
  }} />);
  expect(screen.getByTestId('device-reboot-deferrals')).toHaveTextContent('2');
});

it('renders no badge when no restart is scheduled', () => {
  render(<DeviceDetails device={{ ...baseDevice, rebootScheduledAt: null }} />);
  expect(screen.queryByTestId('device-reboot-scheduled')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure.** `cd apps/web && npx vitest run src/components/devices/DeviceDetails.test.tsx` — expected: FAIL, `device-reboot-scheduled` not found.
- [ ] **Step 3: Implement** the badge next to the existing pending-reboot indicator; i18n keys in all 8 locales.
- [ ] **Step 4: Document** — extend the `schedule_reboot` payload table in `agents/commands.mdx` with `deadline`, `allowDeferral`, `maxDeferrals`, `deferralMinutes`, and add a short "End-user restart prompts" section to `patch-management.mdx` covering what the user sees, the platform matrix (Windows dialog / macOS dialog / Linux zenity when a graphical session exists, else the terminal wall message), and that the deadline is absolute.
- [ ] **Step 5: Run web + locale parity. Step 6: Commit and open the W5 PR.**

**W5 acceptance criteria**
- [ ] `tenant-export-policy.integration.test.ts` and `tenantExportErasureRoundtrip.integration.test.ts` both pass with the four new `devices` columns classified.
- [ ] A heartbeat with no `rebootStatus` does not clear stored values; an explicit `null` does.
- [ ] `pnpm db:check-drift` clean; migration idempotent on a second `pnpm db:migrate`.
- [ ] `localeParity.test.ts` green.
- [ ] `Integration Tests` green on a PR based on `main`.

---

## Deliberately NOT in this plan

Cross-referenced, not absorbed. Each is a real follow-up; file them rather than letting them creep into a wave.

- **Windows toast `<actions>` + protocol activation** (issue body item 2). See D4. The IPC contract is identical, so this is a helper-side change that can land any time after W3. It needs: a `breeze-agent:` URI handler in HKCU, a single-use nonce so a local user cannot forge another session's decision, and a real Windows box to verify — none of which CI can cover.
- **#3253 — `deadline` enforcement.** W2 enforces it *for deferrals*. The broader "an unreachable device that comes back after its deadline should reboot immediately" behaviour is still unimplemented. W2's clamp makes the field load-bearing for the first time; note that on #3253 rather than closing it.
- **#3254 — console `cancel_reboot`.** W5 delivers the read half only.
- **Migrating the Linux maintenance path onto `schedule_reboot`.** `maintenanceRebootWorker` still sends the bare `reboot` command with `{ delay }` on Linux (`:66-69`, `:100-128`), so Linux maintenance reboots bypass `RebootManager` and therefore bypass deferral entirely. #3421 deliberately held this back; W4 makes it finally worthwhile. **Call this out in the W4 PR body** — otherwise "Linux users can postpone" is true for patch reboots and false for maintenance reboots, which is exactly the kind of split an MSP will hit and report.
- **Deferral for `reboot_safe_mode`** (`handlers.go:305`) — a safe-mode reboot is a remediation action, not routine patching. Out of scope on purpose.
- **A scheduled reboot surviving an agent restart.** Timers are in-memory today; a daemon restart mid-countdown loses the schedule entirely (pre-existing, not introduced here). The 10-minute maintenance sweep re-dispatches for the maintenance path; the patch path does not. Worth its own issue.

---

## Open questions

Three product calls the code cannot settle. Each has a recommendation; implementation can proceed on the recommendation if no answer arrives.

**1. Modal dialog or toast buttons for the prompt?**
- **A — native modal dialog** (`MessageBoxTimeoutW` / `osascript` / zenity): pro — the vehicles already ship and are proven by the consent flow, cross-platform in one wave, no AUMID/COM/protocol-handler/nonce surface; con — more intrusive than a toast, and a modal steals focus from whatever the user is doing.
- **B — toast with action buttons**: pro — the least intrusive surface, matches what Windows users expect; con — activation needs a COM activator or a custom URI handler plus a forgery nonce, macOS `display notification` has no buttons at all, and none of it is CI-verifiable.

**Recommend A** — a restart notice is exactly the class of message that *should* interrupt, and B can be added later behind the same IPC contract without touching the server, the policy, or the state machine.

**2. Should Linux parity (W4) be in this feature or a follow-up?**
- **A — in this feature (W4)**: pro — the issue title says "Windows, macOS, and Linux", and a daemon-side prompt also fixes #3197's undelivered Linux warning; con — a new `linuxsession` package and a root-drops-to-user exec path, on the smallest slice of the fleet.
- **B — follow-up issue**: pro — W1–W3 ship the feature to ~99% of managed endpoints sooner; con — the issue closes without doing what its title says.

**Recommend A**, but as the **last** wave so it can slip without blocking W1–W3.

**3. Add a `reboot_notify_user` off switch after all?** The issue body asks for one; D3 argues against it.
- **A — do not add it**: pro — "the user is always warned" stays a tested invariant (#3197/#3421), and no admin can re-create the customer-facing defect that started this whole thread; con — an MSP running unattended servers cannot suppress a toast nobody will see.
- **B — add it**: pro — genuine control for headless fleets; con — hands an admin one checkbox that undoes #3421, and it will be found and ticked.

**Recommend A** — the headless case is already handled for free: with no logged-in session there is no helper, so no toast renders and nothing is suppressed to begin with.
