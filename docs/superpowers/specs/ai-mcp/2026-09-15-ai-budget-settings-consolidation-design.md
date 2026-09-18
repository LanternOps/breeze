# AI budget settings consolidation

**Date:** 2026-09-15
**Status:** approved (Todd, 2026-09-15) — single PR, no waves
**Related:** #4388 (budget alerts), #5592 (first-save drops approvalMode), breeze-billing#20 (included credits by plan)

## Problem

The same eight AI budget fields (`enabled`, `monthlyBudgetCents`, `dailyBudgetCents`,
`approvalMode`, `maxTurnsPerSession`, `messagesPerMinutePerUser`,
`messagesPerHourPerOrg`, `alertThresholdPercents` — `AI_BUDGET_FIELDS` in
`apps/api/src/services/effectiveSettings.ts`) are editable in two places that
write two different stores, and a third page looks like a budget page but is not:

| Surface | URL | Writes | Scope |
|---|---|---|---|
| `AiUsagePage` "Budget Configuration" | `/settings/ai-usage` | one `ai_budgets` row per org via `PUT /ai/budget` | selected org |
| `PartnerAiBudgetsTab` | `/settings/partner#ai-budgets` | `partners.settings.aiBudgets` JSONB via `PATCH /orgs/partners/me` | every org under the partner; each set field **locks** the org field |
| `UsageTab` | `/ai/usage` | nothing (read-only AI-for-Office report over `client_ai_usage`) | — |

Runtime resolution is `getEffectiveAiBudget`: defaults ← org row ← partner JSONB
(partner wins, adds `aiBudgets.<field>` to `locked`). That contract is correct
and matches every other partner-enforced feature (security, event logs,
notifications, defaults). What is wrong is *where the org editor lives*:

1. **It sits on a usage page, not in org settings.** Every other partner-enforced
   feature pairs a `PartnerSettingsPage` tab (`enforced: true`) with an
   `OrgSettingsPage` tab (`OrgSecuritySettings`, `OrgEventLogSettings`,
   `OrgNotificationSettings`). AI budgets alone put the org editor on
   `/settings/ai-usage`, so a partner admin sees the "same form twice" with no
   visible relationship between them.
2. **"All organizations" renders an editable org form that cannot save.** With the
   switcher on All organizations, `GET /ai/usage` returns `budget: null`, the
   form renders defaults as if they were settings, and Save hits the inline
   `if (!orgId) return 400 'Organization context required'` in
   `apps/api/src/routes/ai.ts` (`PUT /ai/budget`). That is the red banner in the
   report.
3. **Locks point nowhere.** "Managed by partner" tells an org admin a field is
   locked but not where it is set; the partner admin who set it sees no hint on
   the org form either.
4. **`alertThresholdPercents` has a dirty-tracking workaround** (`thresholdsDirty`)
   solely because the form cannot tell an inherited value from an org-set one.

## Design

Keep the data model and `getEffectiveAiBudget` exactly as they are. Move the org
editor to where the pattern says it belongs, make the usage page usage-only, and
make inheritance legible.

### 1. `OrgSettingsPage` gains an **AI** tab (`#ai`)

- New `OrgAiBudgetSettings.tsx` hosting the existing Budget Configuration form
  (fields, validation, `PUT /ai/budget?orgId=<id>` — the route already accepts
  an explicit `orgId` override for partner callers).
- Reads `GET /orgs/organizations/:id/effective-settings`; a field in `locked`
  renders disabled with the amber "Managed by partner" note **plus a link** to
  `/settings/partner#ai-budgets` for users with `canManagePartnerWidePolicies`,
  and the partner value shown as the effective value.
- Unlocked fields show the org value if the org row has one, otherwise the
  placeholder "Default (<value>)" so an inherited default is never mistaken for
  an org setting. Save sends only fields the user touched (generalise the
  existing `thresholdsDirty` approach to every field), which also removes the
  #5592 class of "first save pins defaults into the org row".
- Tab metadata: `{ key: 'ai', hash: 'ai', label: orgSettingsPage.nav.ai, icon: Wallet }`
  placed next to `approval-security`. i18n keys in every locale (coverage test).

### 2. `AiUsagePage` becomes usage-only

- Remove the Budget Configuration form. Keep: stat cards, credits tile,
  threshold rung status, Recent Sessions.
- Add a read-only **Effective budget** panel: each of the eight fields with its
  effective value and a source chip — *Partner* (links to
  `/settings/partner#ai-budgets`), *Organization* (links to
  `/settings/organizations/<id>#ai`), or *Default*. Source comes from
  `effective-settings` (`locked` ⇒ Partner; org row has the field ⇒
  Organization; else Default). Rendered only when an org is selected.
- **All organizations** state: stat cards aggregate across the partner (the
  `/ai/usage` route already accepts no org for reads); the Effective budget
  panel is replaced by one line, "Select an organization to see its effective
  budget, or edit partner-wide defaults" with the partner link. No form, no
  400.
- Page subtitle changes from "Monitor AI assistant usage and configure budget
  limits" to "Monitor AI assistant usage"; sidebar label stays "AI Usage" (drop
  "& Budget").

### 3. `PartnerAiBudgetsTab`

- Unchanged fields and storage. Add one sentence under the tab description:
  "Fields you set here override and lock the same field on every organization's
  AI tab." plus a count of orgs with their own overrides for each field is
  **out of scope** (would need a new aggregate endpoint).

### 4. Naming

- `/ai/usage` (`UsageTab`) is renamed in the AI-for-Office admin nav to
  **"Office add-in usage"** so it stops reading as a third budget page. No
  route change.

## API

No new endpoints. `PUT /ai/budget` keeps its inline org check; the web no longer
reaches it without an org. `GET /orgs/organizations/:id/effective-settings`
already returns `aiBudgets` + `locked`. Optional follow-up: have
`/ai/usage` echo `effectiveSource` per field to spare the second fetch — not
required for this PR.

## Tests

- `OrgAiBudgetSettings.test.tsx`: locked field disabled with link; untouched
  fields absent from the PUT body; placeholder shows inherited default.
- `AiUsagePage.test.tsx`: no form rendered; Effective budget panel shows
  Partner/Organization/Default chips from a mocked effective-settings response;
  All-organizations state renders the prompt line and never calls
  `PUT /ai/budget`.
- `OrgSettingsPage` tab registration + i18n coverage.
- Existing `ai.test.ts` route tests unchanged.

## Out of scope

- Per-org override counts on the partner tab.
- Any change to `getEffectiveAiBudget`, `ai_budgets`, or the partner JSONB shape.
- Credits allowance per plan (breeze-billing#20).
