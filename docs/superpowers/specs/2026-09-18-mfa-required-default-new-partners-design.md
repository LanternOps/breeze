---
title: Require MFA by default for new partners
date: 2026-09-18
status: approved (Todd, 2026-09-18 — "default on yes")
rigor: HIGH (auth posture, signup flow, seeds/e2e)
origin: Strix dynamic scan 2026-09-18, Finding 1 follow-up; PR #6299, issue #6298
---

# Require MFA by default for new partners

## Goal

Every partner created from now on starts with `security.requireMfa = true`. Existing partners are
untouched. Partner admins of partners that still have it off see a persistent in-app nudge until
they turn it on or explicitly acknowledge it.

This closes the exposure the scan called "vacuous MFA": in a tenant that does not require MFA, a
password-only session passes every `requireMfa()` gate by design (see
`apps/api/src/middleware/auth.ts` `requireMfa()` contract, PR #6299). The tenant knob is the
enforcement lever; this spec flips its default.

## Non-goals

- No change to `combineMfaPolicyFacts` / `getEffectiveMfaPolicy` (`services/mfaPolicy.ts:126,139`).
  "Absent key ⇒ not required" stays. The default is applied **at partner creation**, not at read.
  A read-time default would flip every existing tenant on upgrade — exactly the R1 lockout from the
  2026-09-08 release sweep (`docs/testing/release-sweeps/2026-09-08-v0.110.0-to-main.md:13`).
- No change to `MFA_FORCE_FOR_PARTNER_ADMIN` (role axis, default OFF, `config/env.ts:643`). The
  settings axis is enforced regardless of that kill switch (`mfaPolicy.ts:141-143`).
- No grace window for the settings axis. `#5306` grace applies to the role axis only
  (`mfaPolicy.ts:146-159`). For a new partner nobody pre-exists, so immediate enforcement is
  correct; invited users enrol at first login, which the invite/accept flow already handles.
- No per-op step-up work — that is #6298.
- No server-side "dismissed nudges" store. Banner dismissal stays client-side, per the existing
  `MfaEnrollmentGraceBanner` pattern.

## Verified facts

| # | Fact | Evidence |
|---|---|---|
| F1 | Partner settings are one jsonb: `partners.settings`, `settings.security.requireMfa`. | `db/schema/orgs.ts:39`; type `InheritableSecuritySettings` `packages/shared/src/types/index.ts:600-609` |
| F2 | A field set on the partner **locks** it for every child org (`mergeCategory`, `locked: ["security.requireMfa"]`); org admins see the toggle disabled. | `services/effectiveSettings.ts:89-112,181`; `apps/web/src/components/settings/OrgSecuritySettings.tsx:206-221` |
| F3 | Exactly three product-code partner inserts, all already routed through `applyNewPartnerDefaultSettings()`: signup `services/partnerCreate.ts:98`, platform-admin `routes/orgs.ts:513`, dev seed `db/seed.ts:1267`. `register-partner` writes no rows (Redis-parked until `verifyEmail.ts:423`). SSO/CF-Access JIT create users, never partners. | grep `insert(partners)` / `INSERT INTO partners` |
| F4 | `applyNewPartnerDefaultSettings` (`services/partnerDefaultSettings.ts:46`) is import-free by design (no db/config imports; partial-schema test mocks import it) and only fills absent keys. | file header `:5-10` |
| F5 | Signup already forces the first admin to enrol: `verifyEmail` mints `mfa:false` for a brand-new partner admin (RMM-QA-164 / SR2-21) and the grace service is deliberately not wired into registration. | `services/mfaEnrollmentGrace.ts:37-45`; `__tests__/integration/registerPartnerMfaPolicy.integration.test.ts` |
| F6 | That integration test simulates the settings axis with a `BEFORE INSERT` trigger injecting `{"security":{"requireMfa":true}}` because `createPartner` does not write it today. | `registerPartnerMfaPolicy.integration.test.ts:237,246` |
| F7 | Integration fixture `db-utils.createPartner()` writes **no** settings and does not call the helper; `setupTestEnvironment` mints `mfa:false` tokens. ~30 suites insert `partners` inline. | `__tests__/integration/db-utils.ts:176-198,520` |
| F8 | e2e forces `MFA_FORCE_FOR_PARTNER_ADMIN=false` and logs seeded admins in without MFA. | `e2e-tests/global-setup.ts:119`, `e2e-tests/README.md:156-162` |
| F9 | Toggle: `PATCH /orgs/partners/me` deep-merges `settings.security` under an advisory lock (`routes/orgs.ts:884-1000`, `services/mfaPolicyActivation.ts:11`); read via `GET /orgs/partners/me` which returns `settings`. Web: `PartnerSecurityTab.tsx:119-127`, i18n `partnerSecurity.requireMfa` (`locales/en/settings.json:445`), client default `?? false`. | as cited |
| F10 | Banner precedents mount in `layouts/DashboardLayout.astro:57-62`. `MfaEnrollmentGraceBanner.tsx` = fetch-gated, per-day localStorage dismiss (`breeze.mfaGraceBannerDismissedOn`), `data-testid`, `role="status"`, warning styling, tests pin dismissal. `MigrationRequiredBanner.tsx` = non-dismissible, admin-gated, self-host proxy `!features.billing && !features.support`. | as cited |
| F11 | `canManagePartnerWidePolicies` is exposed client-side in `stores/auth.ts:68-71`. | as cited |

## Design

### D1 — Default lives in `applyNewPartnerDefaultSettings`, unconditional

Add, alongside the existing `ticketing.inbound.enabled` fill:

```ts
const security = isPlainObject(base.security) ? { ...base.security } : {};
if (security.requireMfa === undefined) security.requireMfa = true;
base.security = security;
```

- Only absent keys are filled; a caller that passes `requireMfa: false` (dev seed, a platform admin
  creating a partner for a customer that opted out) keeps it. Malformed `security` is replaced by a
  fresh object, matching the helper's existing malformed-shape rule.
- **Not hosted-conditional.** The helper stays import-free (F4). Self-hosters get the same secure
  default and can switch it off in Partner Settings → Security with one toggle. A hosted/self-host
  fork would need a flag argument threaded through three call sites for a default that is right in
  both cases; rejected as complexity without a customer asking for it.
- All three insert sites (F3) pick it up with no further change.

### D2 — Dev seed and e2e opt out explicitly

`db/seed.ts:1267` passes `applyNewPartnerDefaultSettings({ security: { requireMfa: false } })` with a
comment naming this spec. Reason: seeded dev/e2e admins log in without a factor (F8); a forced
enrolment wall on every fresh stack is the R1 lockout replayed locally. e2e keeps its existing
`MFA_FORCE_FOR_PARTNER_ADMIN=false`; nothing else changes there. `e2e-tests/README.md:156-162` gets
one sentence saying the seeded partner opts out of the new default and why.

### D3 — Integration fixtures do NOT adopt the default

`db-utils.createPartner()` keeps writing no settings. Hundreds of integration cases authenticate with
`mfa:false` tokens (F7); adopting the default there would 428 them all off the API. A fixture that
wants the real default passes `settings: applyNewPartnerDefaultSettings()` itself. The
`registerPartnerMfaPolicy` trigger scaffolding (F6) is deleted: the real creation path now writes the
setting, and the test asserts it from the row instead of injecting it.

### D4 — Banner for partners still off: `MfaPolicyOffBanner`

- Mounts in `DashboardLayout.astro` next to `MfaEnrollmentGraceBanner`, `client:load transition:persist`.
- Shows when **all** hold: auth store has a user, `scope === 'partner'`,
  `canManagePartnerWidePolicies`, and `GET /orgs/partners/me` returns
  `settings.security.requireMfa !== true`. Org-scoped users never see it (they cannot change it and
  `GET /orgs/partners/me` 403s them). One fetch per mount; no polling.
- Copy (en, `common.json`, key block `mfaPolicyOffBanner.*`): message "Multi-factor authentication
  is not required for your team. Password-only sessions can run scripts, move devices and change
  policies." CTA "Require MFA" → `/settings/partner#security`. Dismiss "Remind me later".
- Dismissal: per-day localStorage key `breeze.mfaPolicyOffBannerDismissedOn` (same `YYYY-MM-DD`
  local-date scheme as the grace banner, F10) — it comes back the next day. Not permanent: the
  point is a standing nudge, and there is no server-side dismissal store to make "never again"
  survive devices. Not non-dismissible: unlike `MigrationRequiredBanner` this is a policy choice
  the partner is allowed to make, and an un-dismissable banner for an allowed choice is hostile.
- Disappears on its own once the toggle is saved (the settings page re-fetch flips the condition;
  the banner re-checks on mount and on the `partner-settings-saved` window event the settings page
  will dispatch after a successful PATCH — one line added to `PartnerSettingsPage.tsx:168`).
- Reuses the grace banner's markup: `role="status"`, `data-testid="mfa-policy-off-banner"`,
  warning border/background, `ShieldAlert` icon.

### D5 — Web toggle default

`PartnerSecurityTab.tsx:119-127` keeps rendering the server value (`data.requireMfa ?? false`). The
fallback only matters for a partner with no `security` key, which after this change is only a
pre-existing partner, where `false` is the truthful state.

### D6 — Docs

- `apps/docs/src/content/docs/security/hardening.mdx`: new partners require MFA by default; how to
  turn it off; that the partner setting locks the org toggle (F2).
- `apps/docs/.../features/scripts.mdx` "MFA enforcement" already points at the setting (PR #6299);
  add "on by default for partners created after v0.115".
- Release notes entry under Security.

## Rollout / upgrade

- Existing partners: no change; they get the banner (D4) on next load.
- New hosted signups: first admin already lands on enrolment (F5); unchanged experience, now
  policy-backed regardless of the kill switch.
- New self-hosted installs: the seeded Default Partner opts out (D2); a partner created through the
  UI gets the default.
- No migration. No schema change. No new env var.

## Tests (red first)

| Test | Asserts |
|---|---|
| `services/partnerDefaultSettings.test.ts` | absent → `security.requireMfa: true`; explicit `false` preserved; unrelated `security.*` keys preserved; malformed `security` replaced; `ticketing` fill unchanged |
| `routes/orgs.test.ts` (`POST /orgs/partners`) | created row carries `requireMfa: true` when the caller omits it; caller's explicit `false` wins |
| `__tests__/integration/registerPartnerMfaPolicy.integration.test.ts` | trigger removed; the partner row created by real signup has `requireMfa: true`; the auto-login mint is `mfa:false` (existing assertion now backed by the row) |
| `db/seed.test.ts` or equivalent | seed's partner has `requireMfa: false` (guards D2 against a future "cleanup") |
| `MfaPolicyOffBanner.test.tsx` | shows for partner-scope policy manager with `requireMfa` absent/false; hidden for org scope, for non-manager, for `true`; dismiss hides for the day and returns next day; hides after `partner-settings-saved` |
| `mfaPolicy.test.ts` | unchanged — read-time semantics are explicitly not touched |

## Risks

- **A future refactor "simplifies" the seed to plain `applyNewPartnerDefaultSettings()`** and locks
  every dev out. Mitigated by the seed test and the comment.
- **Platform admins creating partners on behalf of customers** now get `requireMfa: true` unless
  they pass `false`. Intended; documented in the admin create route's OpenAPI description.
- **Banner fetch cost**: one extra `GET /orgs/partners/me` per dashboard mount for partner
  policy-managers only. Acceptable; the settings page already does this.
