# UI / UX Improvement Backlog

Consolidated UX papercuts and improvement opportunities surfaced by internal Playwright UI QA sweeps.
These are **improvements**, distinct from functional bugs (which are filed as `[UI]` issues or fixed directly).
Status reflects the most recent verification date noted.

Legend: 🔴 high friction · 🟠 medium · 🟡 low/papercut · ✅ appears resolved since first noted

---

## From the 2026-06-15 sweep

| # | Area | Observation | Sev | Status |
|---|---|---|---|---|
| 1 | Global chrome | Footer reads **"Web dev · API 0.63.5"** on every page — stale/incorrect version (branch is past v0.70.0). The "Web dev" prefix suggests a dev-only indicator; **verify prod shows the real version** before treating as a bug. | 🟡 | open (verify prod) |
| 2 | Global chrome | **Breeze AI + Documentation side panels render docked open** and sit off the right edge at 1680px — the AI panel's Close button was off-viewport (unclickable). They also intercept clicks on the right side of wide pages. | 🟠 | open (filed) |
| 3 | Billing / invoice | Issued invoice **"Record payment" is disabled with no tooltip** explaining why (org billing not configured?). | 🟡 | open |
| 4 | Billing / invoice | Issued-invoice "Bill to" shows a good empty-state nudge ("Set on the organization billing settings.") — positive, keep. | — | good |
| 5 | Code quality | **Systemic:** the web sends `null`/`Number()` where Zod schemas expect `undefined`/money-strings (root cause of the contract 400s). Worth a validator↔UI-contract audit across billing routes + a test convention that asserts the *actual* client payload. | 🟠 | partially fixed (#1411) |
| 6 | Software library | Delete control only appears in the package **detail** view, not on the grid card — reasonable (avoids accidental deletes); noted, no change needed. | — | by design |

## From the 2026-05-15 extended UI QA sweep (revisit status)

| # | Area | Observation | Sev | Status |
|---|---|---|---|---|
| 7 | Global chrome | Always-mounted Documentation iframe loaded `docs.breezermm.com` on **every page even collapsed** → site-wide CSP console spam + a cross-origin request per navigation. | 🔴→ | ✅ **appears resolved** — 2026-06-15: 0 iframes while collapsed, 0 CSP console errors across ~10 pages. The iframe is now lazy-loaded. (Panel-layout half remains — see #2.) |
| 8 | Error feedback | Partner-settings save collapses a detailed ZodError → generic **"Failed to save settings"**; user can't tell *what* to fix (bad scheme vs missing `{id}`). | 🟠 | open (not re-verified) |
| 9 | Error feedback | Third-party catalog 403 → generic **"Failed to load catalog"** — hides "platform admin required" (looks like an outage, not authz). | 🟠 | open (not re-verified) |
| 10 | Action feedback | Wake (#703) and Pushover-Test (#676) action handlers surface **nothing** on success/failure — silent. Distinct from the `[object Object]` class fixed in #689. | 🟠 | open (not re-verified) |
| 11 | Accessibility | Notification channel-card edit/delete buttons are **icon-only with no `aria-label`/`title`** — unlabeled for screen readers; also hard to target in automation. | 🟠 | open |
| 12 | Convention | Patches & Discovery use **`?tab=` query params** for tab state, contradicting the CLAUDE.md `#hash` convention (device-detail does it right). | 🟡 | open |
| 13 | Onboarding | "Add the first site for <org>" nag shows even when the org already has an **auto-created Default Site** (1 of 1). | 🟡 | open |
| 14 | Search | Global-search placeholder ("Search devices, scripts, alerts, users, settings") implies nav-section search, but it's **entity-only** — typing "devices"/"scripts" → "No results found." Reword or index nav destinations. | 🟡 | open |
| 15 | Auth | `/auth#signup` renders a **full registration form even when registration is disabled** (`PUBLIC_ENABLE_REGISTRATION=false`) — submits then redirects; dead-end UX. Add an "invite-only" message or hide the form. | 🟡 | open (env-specific) |
| 16 | Notification channels | Channel test (`POST .../test`) returns an ephemeral `testedAt` but never persists it; the row always shows **"Never tested"** even after a successful test. Needs a `last_tested_at` column. | 🟡 | open |
| 17 | Device detail | "More" dropdown chevron stays "^" (open-looking) even after the menu visually closes in some states. | 🟡 | open |

---

## Suggested priority order
1. **#2 / #7** docked side-panels — click interception + off-viewport controls (the CSP half is already fixed; the layout half remains). _Filed._
2. **#8 / #9 / #10** error- & action-feedback specificity — these directly affect whether MSP techs can tell what went wrong (re-verify current state first; several may have shifted since May).
3. **#11 / #14** accessibility + search-placeholder — cheap, broad-reach wins.
4. **#12 / #13 / #16 / #17** convention & papercut cleanups.

_Source evidence: `docs/testing/FEATURE_TEST_LOG.md` (sections dated 2026-05-15 and 2026-06-15)._
