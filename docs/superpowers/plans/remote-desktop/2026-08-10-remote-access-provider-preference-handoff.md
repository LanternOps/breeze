# Remote-access provider preference — handoff

**Date:** 2026-08-10
**Trigger:** PR #3391 (bdunncompany, draft) / issue #3389
**Status:** decisions made, nothing implemented beyond Billy's backend. Nothing merged.

---

## TL;DR

Billy built the backend half of a per-technician remote-access tool preference. It's correct and ships as-is. The only thing left for that feature is a UI in the user profile.

Along the way three separate problems surfaced that are **not** Billy's and should be their own work: a wasteful/leaky device-detail path, missing validation on provider IDs, and the fact that remote-access providers live in a JSON blob keyed by a hand-typed string.

---

## 1. What Billy actually built (#3391)

4 files, +137/−4, **backend only**. Two commits — the original, plus a fix pushed in response to review.

- **`apps/api/src/services/remoteAccessLauncher.ts`** — `resolveRemoteAccessLaunch()` takes an optional third arg `preferredProviderId`. If it names a provider the tenant has *and* that provider is enabled, use it; otherwise fall through to `defaultProviderId`.
- **`apps/api/src/routes/devices/core.ts`** — new `readPreferredProviderId(auth)` reads `users.preferences.remoteAccessProviderId`, gated on `isInteractiveUserSession`. Threaded into `resolveRemoteAccessLauncherForDevice`, which both the device-detail GET and the launch POST call.
- Two test files. **No migration, no new table, no UI.**

### Why it's a good PR

- **The preference is an ID and nothing else.** It *selects* from the tenant's provider list; it never *supplies* one. `urlTemplate`, `password` and `customFieldKey` still come from the tenant record. That's what keeps the post-substitution `javascript:` guard meaningful — a per-user field that could carry a template would reopen exactly that hole.
- **Gated on `isInteractiveUserSession`, not `auth.user.id`.** An MCP API key is built with `user.id = apiKey.createdBy`, so keying off identity alone would make a machine caller silently inherit the preferences of whoever minted the key. Good catch; would have shipped otherwise.
- **Stale preference degrades quietly.** Unknown ID, foreign ID, or since-disabled provider all fall back to the default rather than failing the launch. A broken *default*, by contrast, hard-fails with `provider_disabled` (`remoteAccessLauncher.ts:69`). Quiet for user error, loud for tenant misconfiguration — correct asymmetry.

### The catch

**Nothing writes the preference.** `remoteAccessProviderId` appears twice in the diff, both on the read side. The value *can* be set — `PATCH /users` accepts `preferences` as an open `z.record(z.string().max(64), z.unknown())`, merged, 64KB cap (`routes/users.ts:415, 493-533`) — but no UI writes it. **Merged alone, the PR changes nothing for any user.**

This is deliberate and declared (draft, "What is deliberately not here" section, two questions asked rather than guessed), which distinguishes it from the built-but-unwired pattern on #789/#778.

### Review outcome

One finding raised: `readPreferredProviderId` originally wrapped the `users` read in `withSystemDbAccessContext`. **Billy pushed a fix (`3bd437ea5`) and corrected the mechanism, and he was right:** `withDbAccessContext` early-returns when a store already exists (`db/index.ts:440`), so the nested call retained the request's scope — it was inert ceremony, not a self-deadlock risk. The second reason stood and is why he changed it: reading under the caller's own scope is the narrower privilege, and `users` policy already carries an `id = breeze_current_user_id()` branch, so no escalation was ever needed.

---

## 2. Decisions made

| Question | Decision |
|---|---|
| Where the chooser lives | **User profile.** Not inline on Connect. |
| Split button (default + dropdown arrow) | **Dropped.** |
| Remembered per device | **No.** Per-user only. |
| Billy's backend | **Ships as-is.** No changes requested. |

### What was considered and rejected

**Split button on Connect** — a default on the main button with a dropdown arrow for other enabled providers. Would have needed ~25 lines of backend (device GET must return the eligible provider list, not just a `hasRemoteAccessLauncher` boolean; launch POST must accept a `providerId`, re-validated server-side) plus 2–3 days of frontend. `ConnectDesktopButton.tsx` is 816 lines already multiplexing WebRTC desktop, VNC relay, the launcher path, helper lifecycle, entitlement and ~10 unavailable reasons — and **there is no shared dropdown/menu primitive in the codebase** (Header, OrgSwitcher, NotificationCenter and AlertList each hand-roll their own).

**Per-device / per-device-role memory** — needs a real table: migration, RLS, four registration lists (org cascade order, device cascade, device-org-denormalized, export policy), contract tests, and a partner-wide-vs-org ownership decision. 5–10x the cost of the alternatives.

**Refactoring Billy's call site to resolve an "effective provider set"** — I asked for this, then withdrew it. See §5.

---

## 3. Remaining work

**A. Profile UI — the only thing needed to ship the feature.**
A "preferred remote tool" control in user settings, writing `users.preferences.remoteAccessProviderId` via the existing `PATCH /users`. No backend work. Needs the list of the tenant's enabled providers to populate the control — check whether an existing endpoint exposes that, or whether it needs adding.

**B. Provider ID validation — small, separate PR.**
Two `.refine()` calls on the schema at `routes/orgs.ts:585-616`: provider IDs must be unique, and `defaultProviderId` must name one that exists. See §4.

**C. Availability check vs credential issuance — separate issue.**
See §4.

**D. Providers out of the JSON blob — separate initiative.**
See §6.

**E. Org-level provider scoping — separate initiative.**
See §7.

---

## 4. Bugs found (none are Billy's)

### Provider IDs have no uniqueness constraint

`routes/orgs.ts:585-616` validates each provider's fields and caps the array at 50, but nothing asserts IDs are distinct, and nothing asserts `defaultProviderId` names a provider in the list.

- **Dangling default** → silently resolves to `no_provider_configured`. The Connect button just doesn't appear, with no hint the default points at nothing.
- **Duplicate IDs** → credential selection becomes order-dependent. Each provider carries its own `urlTemplate` and `password`, and resolution is `providers.find(p => p.id === targetId)` (`remoteAccessLauncher.ts:63`) — first match wins. Two entries sharing an ID means reordering the array changes which endpoint and which password get substituted, with no error anywhere.
- **The two paths disagree once #3391 lands.** The preference lookup is `find(p => p.id === preferredProviderId && p.enabled)` — it skips disabled duplicates. The default path's `find` has no `enabled` filter; it takes the first ID match and *then* fails `provider_disabled`. So with a duplicated ID where one copy is disabled, the same provider works via preference but errors via tenant default.

Not exploitable — only partner admins write this list, and the scheme guard still applies to whichever template wins. It's a misconfiguration trap that would be painful to diagnose.

### Device detail decrypts a password to compute a boolean

`GET /devices/:id` calls `resolveRemoteAccessLauncherForDevice` (`core.ts:993`) purely to set `hasRemoteAccessLauncher`. That path decrypts the provider password and builds the full substituted launch URL (`remoteAccessLauncher.ts:87-89`), then discards it. Every device-detail load does this. Availability checking should be separated from credential-bearing issuance.

*(Found by Codex, verified against source.)*

---

## 5. The design question: does the preference belong in the inheritance chain?

**Context:** the repo already has a partner→org inheritance model — `getEffectiveOrgSettings` + `mergeCategory` + `locked` + `assertNotLocked` (`services/effectiveSettings.ts`). Security, notifications, eventLogs, defaults, branding and aiBudgets all go through it. `remoteAccessProviders` is *typed* `InheritableRemoteAccessSettings` but is **not** in `EffectiveOrgSettings` — the "Inheritable" prefix is aspirational. It's read straight off `partners.settings`.

**Conclusion: keep the axes separate.**

- **Config/policy** — which providers exist and are permitted. Partner → org. Belongs in an inheritance model.
- **Preference** — which *permitted* provider I pick. Per-user. A selection over the resolved set, not a configuration tier.

Collapsing them would be unsafe: if the user preference sat in the same merge chain it could enable something an org disallowed, or inject provider definitions. Billy's "selects, never supplies" shape is correct *because* it sits outside the chain.

Codex's refinement, which is fair: "never a tier" is too categorical. It can be the final **selection** tier (`partner catalog → org restriction/default → user preferred ID`) as long as the user tier is a narrow `{ preferredProviderId?: string }` type that never shares `InheritableRemoteAccessSettings`.

### The thing I got wrong

I asked Billy to resolve against an "effective provider set" rather than `partners.settings` directly, so a future org tier would be a one-line change. **Withdrawn — the seam already exists.** Both GET and POST go through `resolveRemoteAccessLauncherForDevice` (`core.ts:993`, `core.ts:1082`), so org resolution can be introduced inside that single function without a call-site hunt. And it wouldn't be one line regardless: org settings accept `z.any()` (`orgs.ts:179`) and lock enforcement hardcodes five categories (`orgs.ts:1609`), so validation, authz and tests all change.

---

## 6. Design debt: providers are keyed on a hand-typed string in a JSON blob

There is **no partner settings table.** `partners.settings` is a single `jsonb` column on `partners` (`db/schema/orgs.ts:33`) holding timezone, business hours, ticketing, branding, remote-access providers — everything.

Providers are an array of objects in that blob, each with a self-assigned `id` string, referenced from two other places (`defaultProviderId`, and now the user preference), with nothing enforcing uniqueness or referential integrity. That's a foreign key without a foreign key, and org restriction lists would make it a third referrer.

**Right shape:** a real `remote_access_providers` table, UUID primary key, with the default and the preference holding actual FKs. Uniqueness free, dangling references impossible, ordering ambiguity gone.

**Real cost to know before committing:**
- Provider passwords are encrypted with the AAD binding tied to the `partners.settings` column (`decryptForColumn('partners', 'settings', ...)`, `remoteAccessLauncher.ts:81-88`). Moving to a new table changes that binding — existing ciphertext must be re-encrypted.
- Plus the usual: partner-axis RLS, cascade lists, `password` classified `excludedSensitive` in the export policy.
- Call it a few days, not an afternoon.

**There is precedent for exactly this move.** `timezone` was promoted out of `settings.timezone` to a first-class column under issue #1318 (`db/schema/orgs.ts:28-32`). The comment documents the transition: new column authoritative, legacy JSONB key kept in sync as the UI write target until every call site migrates. Same playbook works here, and the dual-write window is also where the re-encryption happens — no risky single cutover.

**Does not block Billy.** His preference stores whatever the provider's ID is — string today, UUID after. Same shape either way.

---

## 7. Compliance / org-scoping gap (pre-existing)

`remoteAccessProviders` is **partner-wide only**. The launcher walks device → org → partner and reads the partner row (`core.ts:1048`). `EffectiveOrgSettings` carries security, notifications, eventLogs, defaults, branding and aiBudgets — not remote access. So one customer forbidding ScreenConnect while another requires it is not expressible today.

**This predates all of the above and is separable.** Two reasons it doesn't gate the preference work:

1. **The audit trail already covers the compliance question.** Every launch writes `device.remote_access_launch_url.issued` with `details.providerId` (`core.ts:1131`), deliberately excluding the URL and password. "Which tech launched which tool against which machine" is already answerable.
2. **Neither the preference nor a dropdown widens the reachable set.** Both only select from what the partner enabled. The surface is identical to today.

**If/when it's built — orgs restrict only, never add.**

- Store `allowedProviderIds` on the org, not copied provider objects. Optionally an org default chosen from what remains.
- Letting orgs *add* providers transfers control of templates and credentials to the org and breaks the fixed `partners.settings` decryption binding.
- **It cannot use `mergeCategory`.** Verified: partner fields always win wholesale (`effectiveSettings.ts:78-90`), so a partner `providers` array would lock orgs out entirely. Restriction needs set intersection, not shallow field inheritance.
- Don't route it through generic `getEffectiveOrgSettings` — that endpoint is gated only on org-read permission (`orgs.ts:1446`), which is the wrong exposure path for credential-bearing config.
- Estimate: 3–5 days.

---

## 8. Process note — Codex quorum

Ran per the CLAUDE.md advisor-quorum rule (consequential design → independent read from Codex, read-only, `xhigh`). It read the same files, ~132k tokens. Outcome: agreed on the axis separation, **disagreed on the seam** (§5, and it was right), and surfaced the two bugs in §4 plus the `mergeCategory` and exposure-path points in §7. All claims spot-verified against source before being relied on.

**Operational gotcha:** the first run exited **0 with no output** — `codex exec` printed "Reading additional input from stdin..." and consumed inherited stdin instead of the prompt argument. Re-running with `< /dev/null` worked. A zero exit code here looks like success.

---

## 9. What I still owe Billy

A comment on #3391 with:
- Both answers: chooser lives in the user profile; **not** remembered per device.
- Split button is dropped — don't build it.
- Backend ships as-is; the DB-context fix in `3bd437ea5` closed the only review item, and his correction on the mechanism was accepted.
- Note that the PR is inert until the profile UI exists, so the two land together or the UI lands right behind it.
- Provider-ID validation and the availability/issuance split are **not his** — separate issues, don't scope-creep the PR.

**Done 2026-08-10 (follow-up session):** comment posted on #3391; issues filed — #3401 (provider-ID validation), #3402 (availability/issuance split), #3403 (providers → table), #3404 (org scoping, incl. the Partner-Wide-First deviation note and the slim `{id,name,enabled}` provider-list endpoint that also unblocks the profile UI for the §3A scope gap). §B implemented as PR #3406 (superRefine + 5 tests, 206/206 green).

---

## Appendix — session context

This came out of a contributor review round on 2026-08-10. Other outcomes, unrelated to the above:

- **#2826** (obsidiangroup, partner-api enrollment keys) — CHANGES_REQUESTED, round 5. Two blockers: the mint path runs every statement with **no DB access context**, and `breeze_current_scope()` defaults unset→`'system'`, so RLS is fully bypassed — their integration test passes *because* of the bypass. Second: `partner_enrollment_key_idempotency` (`org_id NOT NULL`) missing from `CORE_ORG_CASCADE_DELETE_ORDER` and `CORE_TENANT_EXPORT_POLICY`. PR is CONFLICTING with zero CI runs ever.
- **#3366** (webhook cleartext) — CHANGES_REQUESTED. `workers/webhookDelivery.ts:134` passes neither flag; self-host private webhooks fail every delivery.
- **#3399** (VM warranty exclusion) — CHANGES_REQUESTED. Manual refresh becomes a silent permanent dead-end.
- **#3394** (secrets sealing), **#3396** (process-sample path id) — APPROVED, **not merged**.
- Still open: 18 green dependabot PRs, 18 green own-PRs, 6 incoming issues awaiting first response (including two from a new contributor, cisspUser01).
