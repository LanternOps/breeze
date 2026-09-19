---
title: Device move-org behind a fresh-factor step-up grant, plus an assurance-source JWT claim
date: 2026-09-18
status: approved in principle (Todd, 2026-09-18 — "do all as recommended"); design ready for plans
rigor: HIGH (auth, cross-tenant write, JWT claim, shipped API surface)
origin: Strix dynamic scan 2026-09-18 Finding 1 follow-up; issue #6298; PR #6299
template: docs/superpowers/specs/2026-09-01-rmm-qa-176-maintenance-mode-step-up-design.md
---

# Device move-org step-up + `mfa_src` claim

## Goal

1. `POST /devices/:id/move-org` requires an **interactive user session** and a **fresh, operation-bound,
   single-use step-up grant** proving an enrolled factor, regardless of the tenant's MFA policy.
   Accounts with no usable factor are refused with a truthful message, not a password prompt.
2. Give the console a way to perform the move, since none exists today (§F5). Without it the gate
   protects an operation nobody can reach from the product.
3. Add a non-breaking JWT claim `mfa_src` recording **how** the `mfa` claim was earned, so future
   gates can ask "was a factor actually presented" as a predicate rather than a plumbing project.

## Non-goals

- Script execute / script delete / device elevation / tenant erasure — tracked on #6298, decided
  separately. Nothing here changes `requireMfa()` semantics (PR #6299 contract).
- No consumer of `mfa_src` ships in this feature. It is groundwork; the first consumer is a later
  decision.
- No bulk move-org. There is no bulk route today and no client asks for one.
- No mobile surface.
- No change to ticket move-org (`routes/tickets/moveOrg.ts`), a different feature with its own gate.

## Verified facts (all re-read on `origin/main` @ 755c3aff9)

| # | Fact | Evidence |
|---|---|---|
| F1 | Step-up primitive: `StepUpOperation` union, `mintStepUpGrant` (fails closed to `null`), `validateStepUpGrant` (non-consuming), `consumeStepUpGrant` (`GETDEL`), bound to `{ userId, operation, authEpoch, mfaEpoch, sid, resourceDigest }`, TTL 300 s. Digests canonicalise in ONE function both sides import (`maintenanceResourceDigest`). | `services/mfaStepUpGrant.ts:34-70,72-83,101,124-131,163-174,207-287` |
| F2 | Mint route `POST /auth/mfa/step-up`: `RESOURCE_BOUND_OPERATIONS` is the authority on resource shape (400 before any factor check); digest ternary at mint. `STEP_UP_OPERATIONS` in `routes/auth/schemas.ts` uses `Exclude<>` so excluded ops are compile errors; `stepUpResource` union is a coarse pre-filter only. | `routes/auth/mfa.ts:1219-1231,1233,1240-1249,1355-1372`; `routes/auth/schemas.ts:150-169,171-197` |
| F3 | Maintenance route pattern: `requireInteractiveSession()` (machine principals carry `token: {}` and would pass `hasSatisfiedMfa` with 2FA off) → permission → zValidator → conditional MFA gate; preflight with no writes; `getUserEpochs` + `token.sid` or 503; `validateStepUpGrant` before the tx (missing/stale/mismatched = ONE 403, no oracle); inside the tx `lockMaintenanceAssurance(tx, auth, binding)` (actor `FOR SHARE`, status active, live epochs = binding = token) then `consumeStepUpGrant`, else throw `MaintenanceStepUpConsumedError` → 403 `STEP_UP_REQUIRED_BODY`; audit `stepUp: 'grant' \| 'disabled_2fa'`. | `routes/devices/commands.ts:614-650,667-816`; `services/maintenanceAuthorization.ts:11-26` |
| F4 | Bound constants live in a leaf module no suite mocks (`services/maintenanceStepUpLimits.ts`) because ten suites `vi.mock` `mfaStepUpGrant` wholesale; a module-scope constant there is a collection error. | `services/maintenanceStepUpLimits.ts:1-22` |
| F5 | **Device move-org has no client.** `apps/web` has no move-org call for devices (only `TicketWorkbench.tsx` for tickets); `apps/mobile` has zero matches; no AI/MCP tool moves a device's org (`manage_tickets:move_org` is tickets). The only entry point is the route; OpenAPI `moveDeviceOrg` at `openapi.ts:2469-2510` already omits `acceptCurrencyMismatch`. | grep `move-org\|moveOrg\|MoveOrg` across apps/web, apps/mobile, apps/api/src/services/aiTools* |
| F6 | Route today: `requireScope('partner','system')` → `DEVICES_WRITE` → `ORGS_WRITE` → `requireMfa()` → `zValidator(moveOrgSchema)`. **No `requireInteractiveSession()`.** Body `{ orgId, siteId, acceptCurrencyMismatch? }`, not `.strict()`. Handler preflight (no writes): `invoices:write` for currency mismatch, source device+site check, same-org 400, `canAccessOrg(target)`, both orgs read, cross-partner 403 unless system, target site ∈ target org. | `routes/devices/moveOrg.ts:119-204`; `routes/devices/schemas.ts:241-249` |
| F7 | Transaction opens at `:228`; first statement is `SET CONSTRAINTS … DEFERRED` (no locks), first **lock** is `readOrgStampingDefaultsMany` (both orgs `FOR SHARE`, ascending UUID) at `:259`; the route never reads or locks `users`. Refusals that roll back without a failed-move audit: currency-blocked, deliverable-pinned, org-vanished (`:1123-1138`). Audit rows `device.move_org.source/target` with shared `auditDetails` (`:1173-1220`). Post-commit: peripheral policy reschedule, agent disconnect 4040. | `routes/devices/moveOrg.ts:228-1220` |
| F8 | Web step-up client: `lib/mfaStepUp.ts` `mintStepUpGrant({ operation: string, resource?: unknown, reauth })` — untyped operation, no change needed for a new op. `MaintenanceModeDialog.tsx` is the two-phase reference: first submit carries no grant; `403 STEP_UP_REQUIRED` reveals the factor step; factor discovery via `/users/me` + `/auth/passkeys` → `pickReauthTier`; `noUsableFactor` (tier `password`) shows a warning and hides submit; `403 MFA_REQUIRED` gets its own copy and never reveals the step. Canonicaliser shared by mint and body: `lib/maintenanceResource.ts`. Error carrier: `deviceActions.ts` `MaintenanceActionError(message, status, code)`. | as cited |
| F9 | JWT: `TokenPayload` (`services/jwt.ts:198-232`) and `verifyToken` rebuilds the payload field by field (`:314-334`) — a new claim is invisible unless added there. `issueUserSession` (`services/userSession.ts:85-146`) is the sole issuer and enumerates fields by hand at `:121-131`; identity type `UserSessionIdentity` `:21-29`. Refresh carries `mdid` via `carryForwardBinding(payload)` (`login.ts:1115`). | as cited |
| F10 | Mint sites and what `mfa` means at each: password login `:676` (policy); refresh `:1111` (carry); CF Access `middleware/cfAccessLogin.ts:329,364` + `cfAccessRedirectLogin.ts:271,309` (IdP-trusted or policy); SSO `sso.ts:3561,3613,3810` (IdP-trusted or policy); `ssoLinkCompletion.ts:181-182` + 5 mints (`breezeMfaVerified` = Breeze factor, else IdP/policy); passkeys `:378,860,909` (factor), `:448,1030` (carry); `mfa.ts:552,750,1154` (factor), `:938,1469` (carry); `invite.ts:189` (`mfa:false`); `verifyEmail.ts:522→562,604` (policy); `mfaEnrollmentSession.ts:254` (factor). | as cited |
| F11 | No test snapshots the exact claim set on user tokens (all `objectContaining`). The only exact-key assertion is the OAuth provider's own claims (`oauth/provider.test.ts:297`) — a different mint path, left untouched. | as cited |
| F12 | Docs: `features/maintenance-windows.mdx:67-103` is the shipped prose model; `reference/api.mdx:81` is the only user-facing mention of device move-org; `features/devices.mdx` does not cover it. | as cited |

## Decisions

### D1 — Interactive session only; machine principals denied in writing

Add `requireInteractiveSession()` to the chain (reuse the middleware from `commands.ts:624-638`, lifted
to `middleware/auth.ts` as an export so both routes share one definition). Rationale identical to
maintenance: API-key and MCP-OAuth contexts are built with `token: {}` and pass `hasSatisfiedMfa` when
`ENABLE_2FA` is off. A cross-tenant device relocation is an operator decision. There is no AI tool to
mirror (F5), so no guardrail change; the spec records that a future `move_device_org` AI tool must
deny machine principals in-handler the way `aiToolsConfigPolicy.ts:221` does for maintenance links.

### D2 — Operation `device_move_org`, digest over the exact intent

- `StepUpOperation` gains `'device_move_org'`; `STEP_UP_OPERATIONS` gains it (not excluded);
  `RESOURCE_BOUND_OPERATIONS` maps it to `moveOrgStepUpResource`.
- `moveOrgStepUpResource = { deviceId: guid, targetOrgId: guid, targetSiteId: guid, acceptCurrencyMismatch: boolean }`
  — mirrors `moveOrgSchema` plus the path param. `acceptCurrencyMismatch` is part of the intent (it
  is a billing acknowledgement); a grant minted without it cannot authorise a move that sets it.
  The server canonicalises `undefined → false` in ONE function both sides call.
- `moveOrgResourceDigest(input)` in `services/mfaStepUpGrant.ts`, keys emitted in fixed alphabetical
  order, `sha256:<hex>`; unit-tested for key-order independence and sensitivity to each field.
- No new bound constants, so no new leaf-limits module (F4 does not bite).
- `moveOrgSchema` gains `stepUpGrant: z.string().guid().optional()`. It stays non-`.strict()`
  (F6) — tightening it is unrelated and would be the only behaviour change visible to a caller who
  is already succeeding; noted, not done.

### D3 — Route shape (mirror of the single-device maintenance handler)

Chain: `requireScope('partner','system')` → `requireInteractiveSession()` → `DEVICES_WRITE` →
`ORGS_WRITE` → `requireMfa()` → `zValidator`. Handler:

1. Existing preflight (F6) unchanged, still no writes.
2. Under `if (ENABLE_2FA)`: `getUserEpochs(auth.user.id)` + `auth.token?.sid`, either missing → 503;
   binding `{ userId, operation: 'device_move_org', authEpoch, mfaEpoch, sid, resourceDigest }`.
3. `validateStepUpGrant(data.stepUpGrant, binding)` before the transaction; missing, stale,
   mismatched, or wrong-op grants are one `403 { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }`.
   No oracle.
4. Inside the existing transaction, **immediately after `SET CONSTRAINTS` and before the org
   `FOR SHARE` reads at `:259`**: `lockMoveOrgAssurance(tx, auth, binding)` (the maintenance function
   renamed to `lockActorAssurance` in a shared `services/stepUpActorAssurance.ts`, both callers
   updated) then `consumeStepUpGrant`; either false → throw `MoveOrgStepUpConsumedError`.
   **Lock order decision:** actor row first, then organisations, matching maintenance, which takes
   the actor lock as its transaction's first lock. `users` is not in `ticketOrgMoveLockOrder.ts`
   (that list is ticket-child tables) and the ticket mover never locks `users`, so no new deadlock
   pair is introduced. State this in the route's lock-order comment at `:254-258`.
5. `MoveOrgStepUpConsumedError` joins the clean-rollback refusals (F7): 403, no failed-move audit,
   no Sentry.
6. `auditDetails` gains `stepUp: 'grant' | 'disabled_2fa'`.

When `ENABLE_2FA` is off, no grant is required (maintenance parity); D1 still denies machine
principals.

### D4 — No-factor accounts are refused, truthfully

The mint route already refuses accounts with no enrolled factor per method. The route therefore
never sees a grant from such an account and answers `STEP_UP_REQUIRED`; the console (D5) turns that
into the "no usable factor — enrol a factor first" state, as maintenance does. Password is never an
accepted proof for this operation.

### D5 — Console: `MoveDeviceOrgDialog` on the device page (new surface)

Because no client exists (F5), the gate alone would leave the operation reachable only by hand-written
API calls. Ship a dialog in the same feature, second wave:

- Entry: device detail page **Actions** menu, "Move to another organization…", visible when the
  caller is partner/system scope with `devices:write` + `organizations:write` (client-side `can()`;
  the server remains the authority).
- Form: target organisation (partner's active orgs, excluding the current), target site (sites of the
  chosen org), and — only when the API answers the currency-mismatch 409 — a checkbox to accept it
  (enabled only if `can('invoices','write')`).
- Two-phase flow copied from `MaintenanceModeDialog` (F8): first submit carries no grant; on
  `403 STEP_UP_REQUIRED` discover factors, pick tier, render passkey note / TOTP input inline
  (same testids scheme `move-org-stepup-*`), mint `device_move_org` against the **same canonical
  resource object** used for the body (`lib/moveOrgResource.ts`, mirror of
  `maintenanceResource.ts`), resubmit with `stepUpGrant`. `403 MFA_REQUIRED` gets its own copy and
  does not reveal the step. `noUsableFactor` → warning `moveDeviceOrgDialog.noStepUpFactor`, submit
  hidden.
- Service: `deviceActions.moveDeviceOrg(deviceId, body)` throwing a `DeviceActionError(message,
  status, code)` (generalise `MaintenanceActionError` or add a sibling — one shape, not two).
- On success: toast, navigate to the device page under the new org (URL is id-based, so a re-fetch
  suffices), and the page must tolerate the agent reconnect the route triggers.
- i18n keys under `moveDeviceOrgDialog.*` in `devices.json` with real translations for every
  supported locale (coverage test).

### D6 — `mfa_src` claim

- Type: `mfa_src?: 'factor' | 'idp' | 'policy'` on `TokenPayload`, `UserSessionIdentity`
  (`mfaSrc`), threaded through `issueUserSession`'s explicit field list and `verifyToken`'s rebuild
  with membership validation (an unknown string is dropped, not typed).
- Meaning: `factor` = Breeze verified a factor in this session's lineage (TOTP/SMS/recovery/passkey
  login, enrolment mints, `breezeMfaVerified` SSO-link arm); `idp` = `mfa:true` rests on a trusted
  external assertion (CF Access `trustsMfa`, SSO `trustsIdpMfa`); `policy` = `mfa:true` because the
  effective policy did not require a factor (password login, registration auto-login, CF/SSO policy
  arms). Three values, not two: collapsing IdP into either bucket would be a lie one way or the
  other, and the SSO-link site already distinguishes them (F10).
- `mfa:false` tokens (invite accept, policy-locked login) carry no `mfa_src`.
- Carry-forward sites (refresh, passkey re-mints, factor-removal and recovery-rotation re-mints)
  propagate the incoming value verbatim, never recompute, exactly like `mdid` — refresh reads
  `payload.mfa_src` beside `carryForwardBinding`.
- Absent claim (tokens minted before this ships) = legacy; any future consumer must treat absent as
  `policy` (the conservative reading). Documented on the type.
- OAuth provider access tokens and viewer tokens are untouched; `oauth/provider.test.ts:297` stays
  as is.
- No consumer. `requireMfa()` does not read it. Tests pin each mint site's value and the
  carry-forward rule with mutation checks.

### D7 — Breaking-change stance for API callers

Existing bearer-JWT scripts that call move-org without a grant will receive `403 STEP_UP_REQUIRED`
after this ships. There is no released client (F5), so this mirrors the maintenance precedent's
"no client to protect" reasoning. Release notes carry a **Breaking** line; the OpenAPI entry gets
`stepUpGrant`, the 403 contract, and the pre-existing gaps (`acceptCurrencyMismatch`, 409).

## Waves

| Wave | Scope | Ships alone? |
|---|---|---|
| W01 | API: D1 (`requireInteractiveSession` shared), D2, D3, D4; `lockActorAssurance` extraction; OpenAPI; integration suite; docs `reference/api.mdx` row + `security/overview.mdx` step-up line | Yes — the gate is correct without a client; release notes mark it breaking |
| W02 | Console: D5 dialog + canonicaliser + service + tests + `features/devices.mdx` section | Depends on W01 |
| W03 | JWT: D6 `mfa_src` across all 14 mint sites + carry-forward + verify + tests | Independent of W01/W02; can land first or last |

## Tests (red first, mutation-checked where a gate is involved)

- `services/mfaStepUpGrant.test.ts`: `moveOrgResourceDigest` order-independence, `acceptCurrencyMismatch` sensitivity, each field's sensitivity, format.
- `routes/auth/schemas.test.ts`: accepts `device_move_org` + resource; rejects missing/rollback-shaped resource.
- `routes/auth.test.ts` step-up describe: mints bound to the canonical digest; 400 before factor verification on bad resource.
- `routes/devices/moveOrg.test.ts`: machine principal 403 before lookup; no grant → 403, no writes, no failed-move audit; stale/mismatched indistinguishable; valid grant consumed with exact binding after actor lock and before org locks (call order); racing consume → 403 no UPDATE; `ENABLE_2FA` off → `stepUp: 'disabled_2fa'` and still denies machine principals.
- `__tests__/integration/deviceMoveOrgStepUp.integration.test.ts` (mirror of `deviceMaintenanceStepUp.integration.test.ts`): non-assured session denied with the row byte-identical across all 64 denormalised tables sampled; X-API-Key never reaches the route; real grant moves the row, replay does not; actor epoch lock held until the tx finishes.
- Web: `MoveDeviceOrgDialog.test.tsx` (the 14-case shape of the maintenance dialog), `moveOrgResource.test.ts`, `deviceActions` error mapping, locale coverage.
- JWT: per-site `mfa_src` assertions in `login.test.ts`, `sso.test.ts`, `ssoLinkCompletion.test.ts`, `auth.passkeys.test.ts`, `cfAccessRedirectLogin.test.ts`, `verifyEmail.test.ts`; `jwt.test.ts` round-trip + unknown-value drop; refresh carry-forward.

## Risks

- **Lock order**: a new `users` → `organizations` order inside the move. Mitigated by matching the
  maintenance precedent and by the integration case that holds the actor lock across the tx.
- **Mocks that stub `mfaStepUpGrant` wholesale** will need `moveOrgResourceDigest` kept real in
  `moveOrg.test.ts` / `devices.endpoints.test.ts` (the maintenance suites show the partial-mock
  pattern).
- **Console dialog is new UI** — stays in-session (Claude), not Codex, per the routing rules.
- **Fourteen mint sites** for `mfa_src`: the miss risk is a site left without the claim, which is
  harmless (absent = policy) but would erode the claim's usefulness. The W03 plan enumerates them.
