# Partner settings: one save model, panel structure, inheritance panel

**Date:** 2026-10-18
**Status:** Draft — awaiting Todd's decisions (§9)
**Issues:** #9170 (anchor), #9169 (co-anchor), #9171 and #9172 (referenced). Part of epic #8985.
**Scope:** `/settings/partner` (`apps/web/src/components/settings/PartnerSettingsPage.tsx` and its tabs), plus one
new read-only API surface for the inheritance panel. This document decides intent; it does not contain plans or
code. Each wave in §8 gets its own plan or fast-track PR.

Evidence labels follow the 2026-09-17 settings audit: **verified** means the author re-read the code on
`origin/main` at `fc6900d8bd`; **reported** means an inventory pass cited file:line and the author did not re-read it.

**Design quorum (CLAUDE.md):** the author's positions on D1–D6 went to an independent `codex exec` review
(read-only, `xhigh`). It agreed with every decision, with changes. All of its changes are folded in, and each one
was checked against the code first:

- §3.3: persistence units, adapter state lifetime, explicit outcomes, conflict handling, and removing the
  refetch after autosave
- §3.4: the AI data-policy card becomes a form
- §4.1: no forced titled cards
- §5.2–5.6: the catalog split across shared and api, qualifiers and consumers, the extra org sources, defined
  count terms, and MCP as a capability decision
- §6: rail height measured against `<main>`, and banner island ownership
- §8: shared contracts settled before waves diverge

No disagreement was left open.

---

## 1. Problem

The 2026-10-18 `/impeccable critique` of `/settings/partner` (summarised in #9169–#9172; no snapshot file exists)
found three structural problems that small fixes cannot solve one at a time.

### 1.1 Three persistence models on one page, two of them mixed inside one tab

- **Header Save** (`PartnerSettingsPage.tsx:639-649`) sends one `PATCH /orgs/partners/me` for ten tabs and tracks
  dirty state across all of them (`:262-302`). *verified*
- **In-card Save** on Login Branding (`LoginBrandingCard.tsx`), Trust Center (`TrustTemplateSettings.tsx`), caller
  verification (`CallerVerificationPolicyForm.tsx`), the AI feature-defaults card inside AI Providers, and each email
  template editor. *reported*
- **Autosave** on Modules (`PartnerModulesCard.tsx`) and AI Features (`PartnerAiDataPolicyCard.tsx`,
  `PartnerMlFeaturesCard.tsx`). *reported*
- **Mixed inside one tab.** Security is a header-Save tab, but caller verification renders under it with its own
  `<form>` and Save (`PartnerSettingsPage.tsx:736-742`). Regional is a header-Save tab, but it ends with the
  Known Guests list, which adds and deletes rows immediately (`PartnerRegionalTab.tsx:177`). *verified*
- **A control that lies about its model.** The Remote Access "dedicated tunnel origin" control
  (`PartnerRemoteAccessTab.tsx:268-300`) is a `role="switch"` with the same track and thumb classes as the Modules
  autosave switch (`PartnerModulesCard.tsx:287-308`), but it only persists on header Save. *reported*
- On self-saving tabs the header prints "This section saves its own changes." (`partnerSettingsPage.selfSaving`).
  Ticketing is one of those tabs, yet it saves nothing: it is a link to `/settings/ticketing`
  (`PartnerSettingsPage.tsx:141, 816-828`). *verified*
- Save only gates on `aiBudgetsValid` (`:644`). An invalid website is caught only after the click, in a page-top
  box far from the field (`:452-468`). (#9172) *verified*
- Unsaved-change protection is `beforeunload` only (`:305-310`). The dashboard runs Astro's `<ClientRouter />`
  (`apps/web/src/layouts/Layout.astro:40`), so a sidebar click is a soft navigation that never fires `beforeunload`
  and drops the edits silently. `components/scripts/ScriptForm.tsx:380` already guards `astro:before-preparation`.
  *verified*
- `KnownGuestsSettings.tsx` mutates with bare `fetchWithAuth` and an inline error, not `runAction`, and is outside
  the `no-silent-mutations` guard's target list. *reported*
- **An autosave can wipe unsaved form edits.** After an ML feature switch saves, the page calls `fetchPartner()`
  (`PartnerSettingsPage.tsx:799`). That refetch resets every form field and the dirty baseline (`:323-358`), so
  unsaved edits on Security or Defaults are silently replaced. *verified*

This breaks settings rule 7 ("one save pattern per screen type … never mixed in a card"). The 2026-09-17 audit
(finding 29, move M13) named the partner hub. The M13 plan deferred it as out of the billing/ticketing domain
(`docs/superpowers/plans/web-ui/2026-09-17-settings-consolidation-w02-inheritance.md`, Task 19). This spec takes it up.

### 1.2 Headless panels and a flat type ladder

- Security, Notifications, Event Logs, Defaults, Branding, AI Budgets and AI Approvals render straight into
  fields with no heading. The page goes from `h1` to the first `h3` (the critique's `skipped-heading` flag on
  Security). *reported*
- The type ladder is `text-xl` / `text-lg` / `text-base` (20/18/16 px). The largest step is 1.13:1, so nothing
  reads as a title. *verified (h1 `text-xl`, `:634`)*
- Nested cards: three `rounded-lg border bg-muted/40` blocks inside the Notifications panel card, two in Defaults,
  one in Branding, three in Remote Access. Subsection titles are `<p className="text-sm font-medium">`, not
  headings. *reported*
- Helper lines run to ~125 characters of `text-xs` on Security. *reported (critique)*
- The rail's Communications group has eight entries, four of them AI (`:137-151`). Known Guests (a partner-wide MAC
  list) sits on Regional. The Event Logs blurb promises "Forwarding and retention" and the tab has no retention
  setting. The Notifications blurb promises "Email and webhook alerts" and the tab has no webhook setting
  (`en/settings.json` `partnerSettingsPage.tabs.*.description`). *reported*

### 1.3 "Enforced" is a per-tab flag. The truth is per field, and it is mixed.

Seven tabs carry `enforced: true` and show one blue banner: "Values you set here are enforced across all
organizations…" (`partnerSettingsPage.enforcedDescription`, `PartnerSettingsPage.tsx:671-675`). The resolver says
otherwise, field by field:

| Behaviour at runtime | Fields (examples) | In `getEffectiveOrgSettings().locked[]`? |
|---|---|---|
| **Partner value locks the org** | `security.requireMfa`, `security.sessionTimeout`, `defaults.agentUpdatePolicy`, `defaults.maintenanceWindow`, `aiBudgets.*` | yes |
| **Org value wins; partner is the default** | `defaults.agentVersionPins`, `defaults.defaultEnrollmentTtlMinutes`, `defaults.defaultEnrollmentDeviceCount` (exempt from the lock check, `orgs.ts:2640-2664`); `aiApprovals.interactiveTimeoutMinutes` (`aiApprovalTimeout.ts`) | **yes** for the three `defaults` fields; no for `aiApprovals` |
| **Partner fills blanks in an org-side config** | `notifications.pushover*` (`partnerPushoverDefaults.ts:55-66`) | yes |
| **All-or-nothing group** | `eventLogs.*`: the partner destination replaces the org's only when `enabled && elasticsearchUrl` (`logForwarding.ts:71`); otherwise the org's `settings.logForwarding` applies | yes, per field, even when the group is not in force |
| **Partner-only; orgs have no value** | `remoteAccessProviders.*`, `networkProxy.dedicatedTunnelOrigin`, `defaults.maxEnrollmentLinkTtlMinutes` (a ceiling on the org value) | no / yes (cap) |

*Verified:* the `defaults` exemption, `aiApprovals`, `logForwarding.ts:71`, `partnerPushoverDefaults.ts`.
*Reported:* the rest of the field inventory. The code itself asks for this design. The exemption comment in
`orgs.ts` reads: "Do NOT 'fix' this back to a lock without a per-field enforcement flag."

The Defaults tab therefore says "enforced across all organizations" above three hints that say "an organization can
override it" (#9169). Separately, "Not set — orgs configure individually" is only a placeholder. It disappears on
typing and never shows what orgs resolve to today, which rule 4 requires ("the field always shows the inherited
value and where it comes from").

### 1.4 Wide screens (#9171)

The container is capped at `max-w-6xl` (`:631`). The layout's MFA banner (`DashboardLayout.astro:64`) spans the
full `main` width. At 2560 px it is ~1100 px wider than the page, and 576 px is dead on each side. The rail is
`lg:sticky lg:top-6` with no max height (`SettingsSectionNav.tsx:70`) and is ~1250 px tall, so at 1080 px tall
the Branding group is unreachable until a long tab is scrolled to its end. *reported (measured live in the critique)*

## 2. Users and scope

- **Who edits this page:** partner (MSP) users in partner scope. Saving requires `canManagePartnerWidePolicies`,
  meaning `orgAccess = 'all'` (`PATCH /orgs/partners/me`, `orgs.ts:1096+`). Partner users with selected-org access
  can open the page (the GET needs only `requireOrgRead`) but every save 403s.
- **Who never sees it:** org-scoped users. The page renders "access required" without a partner context.
- **What is new:** the inheritance read model (§5) exposes **org-level** data, meaning each org's own value for a
  setting, to **partner** users. It is a partner-scope-only read. It never returns secret values. It counts and
  lists only orgs the caller can already see. Org users get nothing new. Their own resolved values stay on the
  existing per-org `GET /orgs/organizations/:id/effective-settings`.
- **In scope:** the partner page's structure, save behaviour, enforcement copy and wide-screen layout, plus the
  read-only API the inheritance panel needs.
- **Not in scope:** the org-side settings pages (except where §5.6 notes they read the same catalog later), and
  changing what any setting *does* at runtime.

## 3. Decision D1: one save model

### 3.1 The rule

Every control on the page is one of three kinds. Each kind saves one way:

| Kind | Saves via | Feedback |
|---|---|---|
| **Form field** (text, select, checkbox, radio inside a form, textarea) | **The header Save.** This is the only *page-level* Save. List drawers keep their own Save (see the third row). | `runAction` toast + header status line |
| **Switch with immediate effect** (rendered as a toggle switch) | Autosave on change, optimistic with revert on failure | `runAction` toast + status line ("Saved · 10:58") |
| **List row** (add, edit, delete an item in a collection) | The row's own action or its drawer's Save | `runAction` toast |

The kind belongs to the **card**, not the tab. A tab may hold cards of different kinds, as AI features does with a
data-policy form card and an ML autosave card. One card never mixes kinds, which is rule 7's "never mixed in a
card". The header Save covers every form card on every tab, so a tab with a form card always saves the same way
wherever that card sits.

Two corollaries:

- **The toggle-switch visual is reserved for autosave.** A boolean in a form is a checkbox. The Remote Access
  dedicated-origin control becomes a checkbox with its existing label and help. It stays a header-saved form field,
  because it is a partner-wide infrastructure choice and should not flip on a misclick.
- **No in-card Save buttons.** Forms that have their own endpoint (caller verification, Login page, Trust Center,
  the AI feature-defaults card) stop rendering a Save button. Each registers a **save adapter** with the page shell
  (§3.3), and the header Save runs it.

### 3.2 The header becomes a status region on every tab

The right side of the page header always shows a status line and the Save button. The button is visible on every
tab and enabled when any form tab is dirty and valid, because one Save covers all form tabs.

| State | Status line (examples; final copy in the plan) | Save |
|---|---|---|
| Clean | "All changes saved · 10:58" (the time of the last successful save or autosave this session; without one, no time is shown) | disabled |
| Dirty | "Unsaved changes in Security, Defaults." Each tab name links to its tab. | enabled |
| Dirty and invalid | "Fix 1 field in Company to save." The link opens the tab and focuses the first invalid field. | disabled |
| Saving | "Saving…" | spinner |
| Partial failure | "Couldn't save Login page. Other changes saved." The failed tab keeps its dirty dot. | enabled |

On an autosave or list tab with nothing dirty elsewhere, the line reports that tab's last outcome ("Saved · 10:58",
or "Couldn't save — try again"). The string "This section saves its own changes." is deleted.

### 3.3 Save adapters

The page shell owns a small registry of **persistence units**. A unit is one endpoint that saves atomically. The
ten tabs behind `PATCH /orgs/partners/me` are one unit, because one request saves them all and they cannot succeed
separately. Caller verification, Login page, Trust Center, the AI feature-defaults card and the AI data-policy card
are one unit each. Outcomes are *displayed* per tab, but saves are *grouped* per unit.

The adapter contract is more than `{dirty, valid, save}`:

- **State lives above the panel.** Drafts, raw invalid text, the baseline, the loaded revision and the caller's
  permission are held by the shell or a store, not by the panel component. Panels unmount on every tab switch.
  Today `AiBudgetThresholdsInput` deliberately reports "valid" on unmount (`AiBudgetThresholdsInput.tsx:52`), and
  under adapters that would hide an invalid draft on another tab.
- **`save()` returns an explicit outcome** (`saved` | `failed` | `conflict`) instead of swallowing errors. Each
  request still goes through `runAction`, which shows error toasts. Successes are summarised by the status line and
  one aggregate toast, not one toast per unit.
- **Re-baseline only what was saved.** After a partial failure, only the units that succeeded take a new baseline.
  Retry re-sends only the failed units.
- **Conflicts keep the draft.** Trust Center reloads the server copy on `REVISION_MISMATCH` today and discards the
  draft (`components/trustCenter/TrustTemplateSettings.tsx:121-124`). Its adapter reports `conflict`, the tab keeps its dirty dot, and the
  panel offers "Reload theirs" or "Keep editing". It never silently drops the draft.
- **No whole-page refetch after an autosave.** Autosave controls update only their own slice of state. The ML
  card's `onSaved={() => void fetchPartner()}` is removed, because that refetch is the draft-wiping bug in §1.1.

Header Save runs every dirty, valid unit sequentially, in rail order, so MFA step-up prompts and error toasts appear
one at a time. A failure leaves that unit's tabs dirty and does not roll back the others. That matches what the
endpoints already allow, since none of them is transactional with another, and the status line says which part
failed.

**Rejected alternative:** keep an in-card Save on each self-contained form and give it its own tab. That satisfies
rule 7 literally, one pattern per screen, but leaves two Save locations and two dirty models on one page. See
Open Decision 1.

### 3.4 Where things move

| Today | After |
|---|---|
| Caller verification, embedded under Security | Its own tab, **Caller verification**, in the Security group. While the `callerVerification` feature flag is off, the rail entry is hidden and `#caller-verification` falls back to Security, following the Sender addresses pattern (`PartnerSettingsPage.tsx:432-450`). It registers a save adapter, and its `<form>` element becomes a fieldset (forms cannot nest; see §3.6). |
| Known Guests, at the bottom of Regional | Its own tab, **Known guests**, in the Devices group (§4.3). List kind. Mutations move to `runAction`, and the file joins the `no-silent-mutations` target list (bump the pinned count in that test). |
| Remote Access dedicated-origin switch | A checkbox, header-saved (§3.1) |
| Ticketing tab ("saves its own changes") | A **rail link item**: it navigates to `/settings/ticketing` and has an external-page icon. `SettingsSectionNav` gains an `href` item kind in both the anchor list and the mobile `<select>`. The `#ticketing` hash keeps rendering a static link-out panel and **must not auto-redirect**: browsers that cached the old `/settings/ticketing → #ticketing` 301 would loop (#7985, see `getTabFromHash`'s comment). |
| AI Features: data-policy card (autosave radios and a retention-days input committed on blur, `PartnerAiDataPolicyCard.tsx:125`) | Becomes a form unit with an adapter: the radios and the days input save on header Save. A number input that saves on blur is a form field under §3.1, not a switch. |
| AI Features: ML feature checkboxes (autosave) | Stay autosave, rendered as switches so they look like autosave controls. They stop refetching the page (§3.3). |
| Modules | Unchanged (autosave). |
| Login page, Trust Center | They keep their own tabs. Their in-card Save buttons are replaced by adapters. |
| Email templates, Sender addresses, AI Providers' connection and model rows | List kind, unchanged. The AI feature-defaults card on the AI Providers tab is a form: it registers an adapter and loses its in-card Save. |

### 3.5 Validity

A per-tab validity map replaces the single `aiBudgetsValid` flag. Every form panel reports `isValid` and
`firstInvalidFieldId`. Field-level checks that today run only inside `handleSave` must run as the user edits and
show inline on the field (`aria-invalid` + `aria-describedby`): the website URL (`isHttpUrl`) and the maintenance
window (`isValidMaintenanceWindow`). The page-top error box stays only for failures that are not `ActionError`s.
This closes #9172's invalid-website item.

### 3.6 Form semantics and navigation guard

- Each form card renders inside a `<form>` whose submit runs the header Save, so Enter submits. This also removes
  Chrome's "Password field is not contained in a form" warning on Notifications (#9172). List rows and drawers keep
  their own forms, and because the wrapper is per card, forms never nest. Inside a form card every `<button>` must
  carry an explicit `type`; an untyped button would submit. W2 adds a test that fails on an untyped button in a
  form card.
- The unsaved-change guard adds `astro:before-preparation`, following the `ScriptForm.tsx` precedent, next to
  `beforeunload`. The Ticketing rail link and every sidebar link are covered.

### 3.7 Contracts every D1 PR keeps

- Every mutation goes through `runAction`, and nothing is added to `runActionAllowlist.ts`. The caller catch
  pattern from CLAUDE.md applies.
- `PARTNER_SETTINGS_SAVED_EVENT` still fires after a successful partners/me adapter save, because
  `MfaPolicyOffBanner` listens for it.
- Hash URL state is unchanged: canonical kebab-case hashes, legacy camelCase aliases kept, and `#ai-models` kept.
  New tabs get new kebab-case hashes: `#caller-verification`, `#known-guests`.

## 4. Decision D2: panel structure, headings, type, rail

### 4.1 Panel anatomy

```
<h2 text-lg font-semibold>  activeDef.label
<p text-sm muted max-w-prose> activeDef.description (the same string as the rail blurb, corrected per 4.4)
[inline badges legend, D3 — only on tabs that have badged fields]
card (rounded-lg border bg-card p-6)
  [<h3 text-sm font-semibold> section title]  ← only where the card is a real subdivision; replaces <p font-medium>
  fields …
[card …]
```

A panel with a single section is one untitled card, because an `h3` that repeats the panel `h2` is noise. Cards and
`h3`s appear only where the panel has meaningful subdivisions.

- The panel heading is rendered by the page shell from `activeDef` for **every** tab, so no tab can ship
  headless. Tabs that render their own top-level `h2` today (Company, Regional, Remote Access, Modules, Login
  Branding, AI Providers, Known Guests) drop it, and their section titles become `h3`.
- **Never a card inside a card.** A panel body is one or more sibling cards. A grouped block inside a card is a
  `h3` section separated by `border-t pt-6`, not a nested bordered box. Option rows inside a radio group, as in
  Modules, are controls, not cards, and are exempt.
- The page `h1` becomes `text-2xl` (24 px). The ladder is h1 24 / h2 18 / h3 14 semibold, with steps of 1.33 and
  1.29. Body text stays `text-sm`.
- Helper and description text is capped at `max-w-prose` (~65ch).

### 4.2 Heading order

h1 (page) → h2 (panel) → h3 (section). No `h4` is needed on this page. The a11y test (§7) asserts the order for
every tab.

### 4.3 Rail map

| Tab (hash) | Group | Save kind | Enforcement shown (D3) |
|---|---|---|---|
| Company (`#company`) | Company | form | none (the MSP's own data) |
| Regional (`#regional`) | Company | form | per field: timezone and language are org-overridable; the rest are partner defaults with no org level today |
| Modules (`#modules`) | Company | autosave | none (partner-wide switch) |
| Defaults (`#defaults`) | Devices & agents | form | per field (locks / org can override / cap) |
| Event logs (`#event-logs`) | Devices & agents | form | one group badge: "Locks orgs when enabled" (in force only when enabled with a URL) |
| Remote access (`#remote-access`) | Devices & agents | form | Partner-wide |
| Known guests (`#known-guests`, new) | Devices & agents | list | none (partner-wide list) |
| Security (`#security`) | Security | form | per field |
| Caller verification (`#caller-verification`, new) | Security | form (adapter) | keeps its existing per-field source chips (default / partner / org) |
| Notifications (`#notifications`) | Communications | form | per field (Pushover: org can override) |
| Email templates (`#email-templates`) | Communications | list | none |
| Sender addresses (`#sending-domains`) | Communications | list | none |
| Ticketing ↗ (link to `/settings/ticketing`) | Communications | link | n/a |
| AI providers & models (`#ai-provider`) | AI | list rows + one form card (feature defaults, adapter) | none |
| AI features (`#ai-features`) | AI | one form card (data policy, adapter) + one autosave card (ML switches) | existing inherit radio on data policy |
| AI budgets (`#ai-budgets`) | AI | form | per field (locks) |
| AI approvals (`#ai-approvals`) | AI | form | org can override |
| Branding (`#branding`) | Branding | form | per field |
| Login page (`#login-branding`) | Branding | form (adapter) | none |
| Trust center (`#trust-center`) | Branding | form (adapter) | existing tri-state inherit model |

Six groups and 20 entries (one of them conditional: Sender addresses appears only when a provider is configured).
The rail gets taller, which is why §6's scrollable sticky rail is a prerequisite.

### 4.4 Blurb corrections

- Event logs: "Forwarding and retention" becomes "Forward device event logs to Elasticsearch" (or similar). There is
  no retention setting.
- Notifications: "Email and webhook alerts" becomes "Sender address, SMTP, Slack and Pushover defaults". There is no
  webhook setting.
- Every blurb is re-checked against its tab's actual fields in the W1 PR. The PR description lists each old and
  new string.

## 5. Decision D3: the inheritance panel

### 5.1 Drop the per-tab flag

`TabDef.enforced`, the blue banner, and the `partnerSettingsPage.enforcedDescription` key (all locales) are
removed. Enforcement is shown per field, or per field group, and is derived from a catalog that mirrors the runtime
resolvers. A per-tab flag cannot be right when one tab mixes three behaviours.

### 5.2 The field catalog (one declarative source, split by layer)

The catalog has two halves, following the precedent of the shared agent-version-pin resolver that serves both
single and batch reads (`packages/shared/src/validators/agentVersionPins.ts:121`):

- **`packages/shared`** (proposed: `src/settings/partnerSettingsCatalog.ts`) holds the stable field and group ids,
  the kind, the presentation metadata (badge and qualifier), the read-model DTO types, and any *pure* resolver
  functions both sides call. Web badges and the API response both use these ids.
- **`apps/api`** holds the bindings that must not leave the server: where each field's org value is stored, the
  aggregation queries, secret handling, and the adapters onto the runtime resolvers.

Each shared entry is a field or a group of paths that resolve together:

- `id`, `paths`: a stable id and the dot paths in `partners.settings`
- `kind`: `locks` (the partner value wins over the org's), `overridable` (the org value wins and the partner value is
  the default, including fill-blank), `partnerOnly` (orgs have no value of their own; the setting is partner-wide),
  or `unclassified` (no badge and no counts; see below)
- `qualifier` (optional): `cap` (an org may override, but only up to a partner ceiling, as with the enrollment TTL
  against `maxEnrollmentLinkTtlMinutes`, `packages/shared/src/validators/enrollmentDefaults.ts:155`) or
  `conditional` (the lock is in force only in a stated state, as with the Event Logs destination, which locks only
  when enabled with a URL, `logForwarding.ts:71`)
- `consumers`: which runtime readers honour the value. This matters where they disagree. Reports use partner
  branding only (`reportBranding.ts`), while quote and document rendering let an org's `portal_branding` row win
  (`partnerDocumentBrand.ts:59`). Such a field cannot claim one effective value, so its line names the consumer
  ("Reports: applies to all orgs · Documents: 3 orgs use their own logo") or it is `unclassified`.
- `platformDefault`: what applies when neither level sets the value. `AI_BUDGET_DEFAULTS` and similar values are
  re-exported from their owner, never copied.
- `secret`: true for every path `settingsSecretMasking` masks

API-side bindings give each field an `orgSource`. It can be an `organizations.settings` JSON path, which may differ
from the partner path (the Event Logs org side is `settings.logForwarding`); an `ai_budgets` column; a
`portal_branding` column; per-channel `notification_channel_configs` rows (Pushover; one org can have several
channels); or `null` when no comparable org value exists.

**Capability is separate from current state.** The badge says what the setting *can* do (`locks`, `overridable`).
The inline line (§5.4) says whether it is in force *now* ("Not enabled, so orgs use their own destination").

**The catalog does not change behaviour.** It describes the resolvers that exist. The W3 contract test runs the
**actual runtime resolvers** (`getOrgAgentUpdateConfig`, `resolveEnrollmentDefaults`, `resolveAiApprovalTimeout`,
the log-forwarding resolver, `applyPartnerPushoverDefaults`, `getEffectiveAiBudget`) over fixture partner and org
rows, and asserts that the aggregate read model classifies each fixture org the same way. That includes the edge
cases: a blank value, a partial Event Logs destination, a capped TTL, and an org with two Pushover channels.
Matching exemption lists alone would not satisfy rule 5. Adding a field to a settings category without a catalog
entry fails that test. That is the per-field enforcement flag the `orgs.ts` comment asks for.

`unclassified` exists because the W3 inventory may find fields whose runtime consumer it cannot confirm. Such a
field gets no badge and no counts until a maintainer classifies it, because a field without a verified consumer
cannot claim that it "applies". The inventory for that wave is tracked with the maintainer, not in this document.

`getEffectiveOrgSettings().locked[]` is **not** changed by this work. Org UIs depend on its current shape:
`OrgSettingsPage` reads a `defaults.agentVersionPins` entry as "the partner has a pin", and the org editors disable
fields from it. Its over-reporting is Open Decision 3.

### 5.3 Badges

Three badges with optional qualifiers, plus no badge. Two badges alone are not enough: a ceiling and a conditional
lock change what "can override" and "locks" mean.

| Badge | When | Example copy (final in the plan) |
|---|---|---|
| **Locks orgs** | `locks` | "Locks orgs": the org cannot choose differently. With `conditional`: "Locks orgs when enabled" |
| **Org can override** | `overridable` | "Org can override": this is the default, and an org's own value wins. With `cap`: "Org can override, up to 30 days" |
| **Partner-wide** | `partnerOnly` | "Partner-wide": there is no org-level value; this applies to every org |
| none | the MSP's own data (company, contact), `unclassified`, list and autosave tabs | — |

The badge states capability and shows whether or not the field is set. Whether the lock is in force *now* is the
inline line's job (§5.4). The badge is a small pill next to the label, with a tooltip explaining it and a
`data-testid`. Field hints that restate the model ("an organization can override it", "organizations cannot
override it") are deleted in favour of the badge, so the copy cannot drift from the catalog again.

### 5.4 What "effective value" means at partner level

At org level the effective value is one value. At partner level there are N orgs, so the line under each field
summarises the distribution. It always names the value that applies when the field is blank, which is rule 4 at
partner level.

| Kind | Partner value | Inline line (examples) |
|---|---|---|
| locks | set | "Applies to all 42 orgs." If some orgs stored their own value that is now shadowed: "· 3 had their own value" (opens the list) |
| locks | blank | "Not set. 5 of 42 orgs set their own; the rest use the platform default (480 min)." |
| overridable | set | "Default for 42 orgs · 4 override" (opens the list) |
| overridable | blank | "Not set. Orgs use the platform default (7 days) · 4 set their own" |
| locks + conditional | set but not in force | "Not in force (destination disabled). Orgs use their own destination · 6 have one" |
| overridable + cap | set | "Default for 42 orgs · 4 override · 2 are clamped to your ceiling" |
| partnerOnly | either | "Applies to all 42 orgs" when set, or "Platform default (on) applies to all orgs" when blank |

The words have fixed meanings, defined once in the catalog module and used in the copy:

- **Has its own value:** the org has stored something at its `orgSource`.
- **Overrides:** it has its own value, the value differs from the partner's, and the resolver lets the org's value
  win.
- **Shadowed:** it has its own value, but the partner's value wins, so the org's value is not in effect.
- **In effect:** the value the runtime resolver would use for that org right now.

Pushover's per-channel source counts an org once if any of its channels sets its own value; the drill-down lists
channels per org. The lines describe **saved** configuration only. While the field has an unsaved draft, the line
says "Saved value: …" so the user does not read a draft as live.

"42" means the orgs the caller can see. For a full-access partner user that is every active or trial org under the
partner, since partner visibility excludes suspended orgs (see the #2879 note in `orgs.ts`).

The **drill-down** is the list of orgs behind a count: org name (linking to the org's settings tab), its own value,
and whether that value is in effect. Secret paths never show a value, only "set" or "not set".

### 5.5 Where it renders

- **Inline, at every width:** the badge and the one-line summary under each field. This is the source of truth, so
  narrow screens lose nothing essential.
- **Drill-down:** at `min-width: 1920px`, a right-hand side panel, sticky, with its own scroll. Below 1920, a
  drawer opened from the count link. With no field selected, the side panel shows a summary for the tab ("3
  settings lock orgs · 2 can be overridden · 7 orgs differ from your defaults") with links to those fields.

### 5.6 Read API

Two read-only routes, next to `GET /orgs/partners/me` in `apps/api/src/routes/orgs.ts` (or in a new route file;
the plan decides):

1. `GET /orgs/partners/me/settings-inheritance?tab=<tabKey>` returns
   `{ orgCount, fields: [{ id, kind, qualifier, partnerSet, inForce, platformDefault, counts: { ownValue, overrides, shadowed } }] }`.
   The counts come from a **small, bounded set of set-based queries per tab**, one per `orgSource` kind the tab
   uses, over caller-visible rows. For example, `COUNT(*) FILTER (WHERE settings #> '{…}' IS NOT NULL)` per field
   on `organizations`, and a pre-aggregated join for `ai_budgets`, `portal_branding` or
   `notification_channel_configs` that counts each org once even when it has several channels. There is no per-org
   loop and no per-org `getEffectiveOrgSettings` call. Cost is O(orgs) per tab view. `field` and `tab` are
   whitelisted against the catalog ids, never interpolated as paths.
2. `GET /orgs/partners/me/settings-inheritance/orgs?field=<id>&cursor=&limit=50` returns the drill-down list with
   keyset pagination on (name, id).

**Values are allowlisted, not masked.** `maskSettingsSecrets` covers settings JSON paths only, and the org sources
here include `notification_channel_configs`, `portal_branding` and `ai_budgets`. A deny-list would leak the next
secret column someone adds. Instead, each catalog field declares a **non-secret value projection** (for example,
the number of minutes, or a colour hex). The API returns only that projection, and every other field, plus every
`secret` field, returns presence only ("set" / "not set"). A W3 test fails when a catalog entry has neither a
projection nor presence-only, and another runs every response through `isSecretJsonPath` as a backstop.

**Which orgs are counted is explicit.** RLS limits rows to orgs the caller can access, but the queries do not rely
on RLS alone to define the population. They filter to the same set the org list shows the caller (active or trial,
not deleted, per `computeAccessibleOrgIds`). A W3 test checks that `orgCount` equals the size of the caller's
`GET /orgs/organizations` result.

Both routes:

- `requireScope('partner')`, `requirePartner`, `requireOrgRead`, and `canManagePartnerWidePolicies` (see Open
  Decision 2). System scope is deliberately excluded: this is a partner-console read model, and platform admins
  have their own tools. A selected-access user does not qualify even when their selection happens to cover every org,
  which is how that gate is defined (`partnerWideAccess.ts:19-28`). This gate guards fleet analysis only.
  Selected-access users keep every read they have today. Read eligibility here does not imply write eligibility.
- Org tokens carry a `partnerId` but are rejected by scope, so the app-layer gate is not the only control. The
  reads also run in the caller's request DB context (`withDbAccessContext`), so RLS limits rows to orgs the caller
  can access. Never use a bare pool or a system context here.
- **MCP coverage is a capability decision, not a file lookup.** `mcpCoverage.ts` says outright that file coverage
  does not establish endpoint parity. "Which orgs override this partner setting?" is a reasonable AI question, so
  the W3 plan either adds a read tool or records a justified exemption (`tool_in_later_wave` with an issue
  reference is the expected default). Placing the routes in `orgs.ts` does not settle it.
- The web fetches lazily for the active tab, caches per tab for the page session, and refetches the affected tabs
  after a successful Save.

`GET /orgs/organizations/:id/effective-settings` stays the per-org resolver and is not used for this view, because
that would be N calls per tab.

### 5.7 Out of D3

- Editing an org's value from the drill-down. It links to the org's settings instead (one home per level, rule 1).
- Bulk "reset all orgs to my default". That is a destructive fan-out and would need its own spec.

## 6. Decision D4: wide-screen layout (#9171 implements)

- **≥ 1920 px** (`min-[1920px]:`): three columns. The rail is 240 px, the panel is capped at ~840 px (the current
  widest input), and the inheritance side panel is ~360 px. The container widens from `max-w-6xl` to fit (~1500 px)
  and stays centred. The third column appears together with the side panel (W4). It is not reserved empty in
  advance.
- **lg to 1919 px:** today's two columns at `max-w-6xl`. The drill-down opens as a drawer.
- **Below lg:** the existing `<select>` rail. The drawer becomes a full-height sheet.
- **Rail:** stays sticky, gets a max height and `overflow-y-auto`, and scrolls the active item into view
  (`block: 'nearest'`, inside the rail only, so the form does not jump) on tab change. It is not un-stuck: with 20
  entries it is the main navigation of the page. The max height is measured against the real scroll container,
  not the viewport. The dashboard `<main>` scrolls below the app header and has its own padding
  (`DashboardLayout.astro:53-54`), so `100vh - 3rem` overstates the space. Use the header height plus the sticky
  offset, or size it from `<main>`.
- **MFA banner:** on this page it aligns to the page container's edges and sits below the page header, not above
  the title. Its dismiss button lines up with the Save button. The banner is a persisted global island
  (`<MfaPolicyOffBanner client:load transition:persist />`, `DashboardLayout.astro:64`), so ownership must be
  coordinated: a soft navigation into or out of `/settings/partner` must neither show two banners nor lose the
  dismissed state. The #9171 PR picks the mechanism: suppress the layout instance on this route and render it in
  the page, or let the layout banner take the page container's width.

## 7. Constraints every follow-up PR inherits

- **i18n:** every new or changed `en` key goes into all eight locale directories (`de-DE en es-419 fr-CA fr-FR
  it-IT pt-BR tr-TR`). Enforced by `apps/web/src/lib/i18n/localeParity.test.ts`. Removed keys
  (`enforcedDescription`, `selfSaving`, the deleted override hints) are removed from all locales. The seven missing
  `settings:emailTemplates.labels.*` ids (`ticket_comment_notification`, `ticket_autoresponse`, `ticket_resolved`,
  `quote_send`, `invoice_send`, `portal_invite`, `staff_invite`) are added in all locales (#9172).
- **Test ids:** every new control, badge, status line, drill-down row and rail link carries a `data-testid` with
  the `partner-settings-` prefix (for example `partner-settings-status`, `partner-settings-badge-<fieldId>`,
  `partner-settings-tab-<key>`, which `SettingsSectionNav` already emits).
- **Mutations:** `runAction` for every POST/PUT/PATCH/DELETE. No additions to `runActionAllowlist.ts`. Newly guarded
  files are added to `no-silent-mutations.test.ts`'s target list, and its pinned file count (247 today, `:955`)
  is bumped.
- **a11y:** extend `PartnerSettingsTabs.a11y.test.tsx` to every tab (it covers six today). Assert that every
  control has an accessible name, that the heading order is h1 → h2 → h3 with no skips, that badges have a
  text-equivalent, and that the status line is a polite live region.
- **URL state:** `window.location.hash` only (CLAUDE.md). Legacy aliases kept.
- **No new settings pages.** If one is added, `settingsPageRegistry.test.ts` applies (settings rule 8).
- **PR description, rule 9:** each PR touching this page states each affected setting's home, level, resolver and
  the configured-in count before and after. Moving caller verification and Known Guests to their own tabs keeps the
  count at 1 (they move; nothing is duplicated).
- **File size:** `PartnerSettingsPage.tsx` is 845 lines. The save-adapter registry and status line go in their own
  modules (for example `partnerSettings/saveRegistry.ts` and `PartnerSettingsStatus.tsx`). `TAB_GROUPS` may move to
  its own file.

## 8. Waves (sketch only; no plans here)

| # | Track | Content | Depends on |
|---|---|---|---|
| F1 | fast-track (#9171, part 1) | Scrollable sticky rail with active item scrolled into view; MFA banner aligned to the container and placed below the header (also #9172's last item) | — |
| F2 | fast-track (#9172 independent items) | `block` on the Defaults lifetime select; auto-enrollment sub-options disabled while auto-enrollment is off; email-template label keys in all locales + a visible row affordance; Remote Access Connections empty-state row; AI Budgets at-rest description; unit and format on "Default Alert Threshold"; short explanations for "Tier 2/3", "Hybrid Plan", "`_bulk` store", Pushover sound names | — |
| W1 | plan | Panel anatomy (§4.1–4.2), type ladder, flatten nested cards, helper width, rail regroup and blurbs (§4.3–4.4), Caller verification and Known Guests as their own tabs (keeping their current save mechanics for now), Ticketing as a rail link | — |
| W2 | plan | The save model (§3): status line, adapter registry, removal of in-card Saves, checkbox for dedicated origin, AI Features switches, validity map and inline errors (#9172 website item), `<form>` and Enter, `astro:before-preparation` guard, Known Guests via `runAction`, de-duplicating the initial `orgs/partners/me` reads (#9172 fetch item: the page, `Sidebar`, `MfaPolicyOffBanner` and `AdminSessionManager` each fetch it; measure in a production build first, because dev StrictMode doubles effects) | W1 |
| W3 | plan, **full rigor** (new partner-scope read of org data) | Shared catalog + contract test against the runtime resolvers; the two read routes; RLS/scope tests (org token rejected, selected-access user rejected, cross-partner invisible); MCP coverage entry | — (parallel with W1) |
| W4 | plan | Badges, inline effective lines, drill-down drawer and ≥1920 side panel (#9171 part 2); removal of `enforced` and its banner/key | W1, W2, W3 |

The remaining #9172 items:

- **F2 additions:** Branding colour inputs show "Not set" instead of a filled swatch, because native colour inputs
  always hold a value. This is independent of inheritance. The AI Providers tab gets sub-navigation and real model
  groups instead of "OTHER".
- **W2 additions:** the initial-load duplicates of `partner/caller-verification-policy` and `ai/models` are
  de-duplicated alongside `orgs/partners/me`. The new caller-verification rail visibility reads the existing
  `features.callerVerification` flag from the `/config` features store (`useCallerVerificationEnabled`), which adds
  no fetch.

**Order:** F1 and F2 at any time. W1 and W3 run in parallel, then W2, then W4. Two contracts must be fixed early:

- **Adapter state lifetime (§3.3):** the W1 plan must not add new panel-local state that W2 would have to lift.
- **Stable field and group ids:** set in the W3 plan, before any W4 work. The W4 badges key on them.

W4 also depends on W2's saved-versus-draft and refetch-after-save contract.

## 9. Open decisions (Todd-gated first)

1. **One Save button (save adapters) vs one save pattern per tab.** *(Todd-gated: the page's core UX.)*
   *Options:* (a) The header Save is the only Save. Self-contained forms register adapters, and Save runs every
   dirty one (§3.3). (b) The header Save covers only the `partners/me` tabs. Self-contained forms keep an in-card
   Save on their own tab, and the header shows a status line there.
   *Trade-off:* (a) gives one place to save and one dirty model, at the cost of multi-endpoint partial failure,
   which must be shown per tab. (b) is less work and has no multi-endpoint semantics, but leaves two Save locations.
   **Recommend (a).** Partial failure is already per tab, and the status line makes it visible.
2. **Who may read the inheritance data?** *(Todd-gated: a tenancy read-scope choice.)*
   *Options:* (a) Only full-access partner users (`canManagePartnerWidePolicies`). Others see badges and the
   partner's own value, and the counts are replaced by "Org breakdown requires full partner access". (b) Any
   partner user, with counts over the orgs they can see.
   **Recommend (a).** Selected-access users cannot save the page, and "4 of 12 orgs" over a partial set misstates
   the fleet a partner default reaches.
3. **Fix `locked[]` over-reporting?** *(Todd-gated: it changes org-side behaviour.)*
   `getEffectiveOrgSettings` reports partner-set org-wins fields (pins, enrollment defaults, Pushover, a partially
   configured Event Logs destination) as locked.
   *Options:* (a) Leave it, and let the catalog drive only the partner UI (this spec). (b) Derive `locked[]` from the
   catalog in a later wave. That changes which fields org editors disable, and `OrgSettingsPage`'s pin signal would
   move to a catalog lookup.
   **Recommend (a) now, with (b) filed as its own issue.** It changes org-side behaviour, and the org editors need
   their own review.
4. **Drill-down shows values or counts only?** *(Todd-gated: what org data partner users see.)*
   *Options:* (a) The org name and its own value, through the per-field non-secret projection (§5.6). (b) Counts
   and org names only.
   **Recommend (a).** "Which orgs override, and to what" is the question the panel exists to answer.
5. **Known Guests' home.** *(Todd-gated: product placement.)*
   *Options:* (a) Its own partner-settings tab under Devices & agents (§4.3). (b) Move it to a network-discovery
   settings surface, following settings rule 2 ("settings live with their domain").
   **Recommend (a) now.** It is partner-wide state and there is no partner-level discovery settings home today.
   Revisit if one appears.
6. **Side-panel breakpoint.** *(Plan decides unless Todd objects.)* (a) 1920 px, as measured in #9171. (b)
   Tailwind `2xl` (1536 px), where the three columns do not fit beside the app sidebar without shrinking the form.
   **Recommend (a).**
7. **Rail group names.** *(Plan decides unless Todd objects.)* "Devices & agents" and "AI" are new. The alternative
   is "Fleet" for the former.
   **Recommend** "Devices & agents" (it matches the product's nav vocabulary).

## 10. Out of scope

- IP allowlist address-format handling (#9172 comment). It is sign-in code and gets its
  own issue and review.
- Labels and translations for the Regional custom business-hours time inputs (#9172 comment). That is a separate
  small i18n fix, not part of the save or structure work.
- Changing any setting's runtime semantics, including making a lock exempt or an exemption a lock.
- Org-side settings pages, apart from Open Decision 3's follow-up.
- Bulk-apply or reset actions across orgs.

## 11. Test and rollout notes

- **No migration, no new table, no persisted state.** The inheritance read model is computed on read from
  `organizations`, `ai_budgets` and `partners`. Nothing needs registering in `CORE_ORG_CASCADE_DELETE_ORDER`,
  `orgMergeRegistry.ts` or `CORE_TENANT_EXPORT_POLICY`. If a later plan proposes caching or persisting counts, it
  must come back here with a tenancy shape.
- **W3 tests:** unit tests for the catalog contract; route tests for scope gating (an org token gets 403/404, a
  selected-access partner gets 403, partner A cannot count partner B's orgs) and secret masking (no secret value in
  either response, checked with `isSecretJsonPath` from `encryptedColumnTransform.ts`); an integration test under real RLS that the aggregate counts
  only caller-visible orgs. The W3 PR runs the integration suites on a per-worktree test stack.
- **W2 acceptance tests:**
  - An invalid draft on one tab still disables Save after the user switches to another tab.
  - An autosave (an ML switch) preserves unrelated unsaved form edits.
  - Partial success re-baselines only the saved units and keeps the failed unit's tabs dirty.
  - A Trust Center revision conflict keeps the draft and offers a reload.
  - The units run sequentially, in rail order.
  - A `runPartnerSave` regression test confirms the payload is unchanged.
  - A navigation-guard test covers `astro:before-preparation`.
  - Legacy and canonical hashes still resolve, including `#ticketing`'s static panel and the
    `#caller-verification` fallback when the flag is off.
  - The `no-silent-mutations` count bump.
- **W3 also tests** that the aggregate counts equal the runtime resolvers' per-org outcomes over the same fixtures
  (§5.2).
- **Playwright:** one flow per save kind (form via header Save, autosave switch, list row), plus the status line
  across tabs, using `data-testid` only.
- **Rollout:** web-only waves (F1, F2, W1, W2, W4) ship behind no flag. They change presentation, not stored data.
  W3 is additive read-only API. W4 should not merge before W3 is deployed, or the inline lines have nothing to
  render. W4 renders badges without counts if the read fails, so it degrades instead of breaking.
