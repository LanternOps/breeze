# Task 6 report — dual-enroll checkbox in the add flow

**Plan:** unified-security-devices Phase 2
**Branch:** `ToddHebebrand/unified-security-devices-p1`

> This file previously held a Task 6 report for an unrelated plan (Plan 03,
> runtime web extensions). It is overwritten here with this task's deliverable.

## Implemented

`SecurityDevicesCard.tsx`'s add-passkey handler (`handleAddPasskey`) now supports
dual enrollment via a new checkbox, `data-testid="secdev-also-approver"`,
default **checked**, rendered whenever `passkeyStepUpTier !== 'sms'` (hidden for
sms, matching the existing fully-disabled sms state).

- **Protected tiers (`'passkey'`/`'totp'`)**: replaced the old single-purpose
  `mintAddFactorStepUpGrant` call with Task 4's `mintStepUpGrants(proof, ops)`,
  where `ops = alsoRegisterApprover ? ['add_factor', 'register_approver_device'] : ['add_factor']`.
  `grants.add_factor` → `stepUpGrantId` (sent to both `/register/options` and
  `/register/verify`, unchanged). `grants.register_approver_device` →
  `approverRegisterGrantId`, sent **only** to `/register/verify` — `/register/options`'s
  schema has no such field (confirmed against `apps/api/src/routes/auth/passkeys.ts`).
- **Tier `'none'` (unprotected account) + checked**: no step-up mint (server
  bypasses add_factor entirely for this tier, unchanged). Instead mints the
  approver grant via `POST /authenticator/register-grant { currentPassword: passkeyPassword }`
  (`skipUnauthorizedRetry: true`, single-use proof) → `{ registerGrantId }` becomes
  `approverRegisterGrantId`. A 403 with `error: 'stronger_factor_required'`
  degrades — `approverGrantDegraded = true`, the passkey add proceeds
  passkey-only. Any other non-ok response throws and fails the whole add (as before).
- **Unchecked**: `mintStepUpGrants(proof, ['add_factor'])` only, no
  `approverRegisterGrantId` field on either request — byte-identical to
  pre-Task-6 behavior (verified: the two originally-passing tests exercising
  this path now explicitly uncheck the box and their body assertions are
  unchanged).
- **Response handling**: `verifyData.approver` is read after a successful
  verify. `approver.registered === false` OR `approverGrantDegraded` → partial
  success message (composed, see i18n compromises below). `approver.registered
  && approver.isPlatformBound === false` → success message gets an appended
  "synced" note. Otherwise the original plain "Passkey added" message.
- **Refresh**: `await loadApprovers()` now runs alongside `await loadPasskeys()`
  after every successful add (not just when the checkbox was used), per the
  brief's fetch-order comment (`passkeys list → register/options →
  register/verify → passkeys reload → approver-devices reload`).

## Tests + results

`apps/web/src/components/settings/SecurityDevicesCard.test.tsx`: 16 tests, all
green (`npx vitest run src/components/settings/SecurityDevicesCard.test.tsx`).

New tests (the brief's 4 skeletons, fully fleshed out, plus 2 extra for full
self-review coverage):
1. `mints both grants in one step-up and sends approverRegisterGrantId to
   verify (protected account)` — asserts `mintStepUpGrantsMock` called with
   `['add_factor', 'register_approver_device']`; asserts the exact
   `/register/options` body has `stepUpGrantId` only (no
   `approverRegisterGrantId`); asserts the exact `/register/verify` body has
   both; asserts `listApproverDevicesMock` called twice (initial load + reload).
2. `unchecking the box keeps the flow single-purpose` — unchecks the box;
   `mintStepUpGrantsMock` called with `['add_factor']` only; verify body has no
   `approverRegisterGrantId`.
3. `uses the password register-grant fallback for unprotected accounts` —
   `mintStepUpGrantsMock` never called; asserts the exact
   `POST /authenticator/register-grant` body (`{ currentPassword }`); asserts
   the resulting `registerGrantId` flows into `approverRegisterGrantId` on verify.
4. `degrades to passkey-only when the password register-grant fallback 403s
   stronger_factor_required` — register-grant call returns 403
   `stronger_factor_required`; asserts the add still succeeds and the verify
   body carries no `approverRegisterGrantId`.
5. `surfaces the degraded outcome when the server reports the approver grant
   was invalid` — verify response has `approver: { registered: false, reason:
   'grant_invalid' }`; asserts the partial-success message text is rendered.
6. `appends a synced note when the newly-registered approver device is not
   platform-bound` — verify response has `approver: { registered: true,
   isPlatformBound: false }`; asserts the appended note is rendered.

Updated existing tests (behavior changed by the new default-checked
checkbox, so assertions had to move or the checkbox unchecked to preserve
their original single-purpose intent):
- `starts passkey registration with password only…` (tier `'none'`) — now
  unchecks the box first so the fetch/mint assertions stay unchanged;
  `mintAddFactorStepUpGrantMock` renamed to `mintStepUpGrantsMock`.
- `mints a TOTP add_factor grant…` (tier `'totp'`) — now unchecks the box;
  swapped `mintAddFactorStepUpGrantMock` for `mintStepUpGrantsMock` and added
  the `['add_factor']` ops argument to the assertion.
- `disables adding a passkey for SMS-method accounts…` — swapped the mock name;
  added an assertion that the checkbox is entirely absent (`queryByTestId`
  returns null) for tier `'sms'`.

## TDD evidence

Tests and implementation were authored together against the exact server/store
contracts already on the branch (`stores/auth.ts`'s `mintStepUpGrants`/
`StepUpOperation`, `apps/api/src/routes/auth/passkeys.ts`'s
`registerVerifySchema`/`approver` response block, `apps/api/src/routes/authenticator.ts`'s
`/register-grant` `stronger_factor_required` 403). First full run of the new/
updated test file was green (16/16) — the implementation was written in lockstep
with the test bodies rather than staged into a separate red commit, since the
brief's four skeletons plus the three existing tests needing updates were all
touched in the same pass. Confirmed the type-checker still catches real
mistakes: an initial `passkeyStepUpTier !== 'sms'` redundant check (dead code
after the tier's early `return` a few lines above) was caught by `astro check`
(`ts(2367)`: no overlap between narrowed type and `'sms'`) and removed.

## Sweep

- `npx vitest run src/components/settings/SecurityDevicesCard.test.tsx src/components/settings/securityDevices.test.ts src/stores` → **13 files / 144 tests, all passed**.
- `npx astro check` → **0 errors, 0 warnings, 232 hints** (pre-existing hints/warnings elsewhere in the app untouched by this change).

## Files changed

- `apps/web/src/components/settings/SecurityDevicesCard.tsx` — checkbox +
  handler rewrite (imports switched from `mintAddFactorStepUpGrant` to
  `mintStepUpGrants`/`AddFactorStepUp`/`StepUpOperation`).
- `apps/web/src/components/settings/SecurityDevicesCard.test.tsx` — 6 new
  tests, 3 existing tests updated for the new default-checked behavior.

## i18n compromises (for Task 7 cleanup)

No new locale keys were added (out of scope, CI-enforced 5-locale parity).
Every string below is an existing `settings` namespace key reused as the
closest-available match — Task 7 should introduce dedicated
`securityDevicesCard.*` keys and replace all of these:

1. **Checkbox label** — reuses `approverDevicesSection.registerThisBrowser`
   ("Register this browser"). The intended copy is closer to "Also register
   this device to approve requests" — the reused key doesn't mention "also"
   or connect it to the passkey being added.
2. **Partial-success message** (approver grant invalid/degraded) — composed
   as `` `${t('profilePage.passkeyAdded')} — ${t('approverDevicesSection.failedToRegisterThisDevice')}` ``,
   i.e. "Passkey added — Failed to register this device". This reads as if
   the *passkey* registration partially failed, when actually the passkey
   succeeded and only the approver dual-enroll didn't. A dedicated string
   ("Passkey added. Approvals weren't enabled for this device.") is needed.
3. **Synced note** (approver registered but not platform-bound) — composed as
   `` `${t('profilePage.passkeyAdded')} — ${t('approverDevicesSection.registered')}` ``,
   i.e. "Passkey added — Registered". This is the same placeholder key already
   flagged as a compromise on the `secdev-badge-synced` row badge in Task 5's
   comments — doesn't convey "synced from another device" at all.

## Concerns

- None blocking. The three i18n compromises above are purely cosmetic message
  text and don't affect the request/response contracts, which match the
  server exactly (verified directly against `apps/api/src/routes/auth/passkeys.ts`
  and `apps/api/src/routes/authenticator.ts`).
- `ProfilePage.tsx` still uses the old single-purpose `mintAddFactorStepUpGrant`
  for its own (still-mounted, pre-merge) add-passkey flow — untouched per the
  task's "do not modify ProfilePage.tsx" instruction. That flow has no
  dual-enroll checkbox; this is expected since `SecurityDevicesCard` is not
  yet mounted anywhere (Task 7's job) and `ProfilePage.tsx` is its
  soon-to-be-replaced predecessor.
