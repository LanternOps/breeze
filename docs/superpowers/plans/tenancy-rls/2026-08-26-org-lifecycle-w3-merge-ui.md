---
tracking_issue: LanternOps/breeze#4074
wave: LanternOps/breeze#4077
---

# Org Lifecycle Wave 3: Merge Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Partner admins can merge a duplicate org into its survivor from the Organizations page: survivor picker → preview (counts, drops, warnings) → typed-name confirm → progress → result summary.

**Architecture:** One new modal component (`MergeOrgModal.tsx`) driven by the Wave-2 endpoints, launched from the OrganizationsPage detail header. All mutations via `runAction`. Client polls the merge-runs endpoint until terminal. On success the loser vanishes from the list (it is `merging`+deleted, excluded from `accessibleOrgIds`).

**Tech Stack:** React (Astro island), existing modal/form patterns in `apps/web/src/components/settings/OrganizationsPage.tsx`, `runAction` (`apps/web/src/lib/runAction.ts`), vitest+jsdom.

**Spec:** `docs/superpowers/specs/tenancy-rls/2026-08-26-org-lifecycle-merge-archive-design.md` (Part 1 → Web UI)

## Global Constraints

- API (Wave 2, all under `/api/v1/orgs`): `POST /organizations/:loserId/merge-preview` `{survivorId}` → `{tables: [{table, policy, loserRows, wouldDrop}], totalMovableRows, verdict: 'ok'|'too-large', warnings: string[]}`; `POST /organizations/:loserId/merge` `{survivorId, confirmName}` → 202 `{jobId}` (400 confirmName mismatch, 422 too-large); `GET /organizations/merge-runs/:jobId` → `{state: 'waiting'|'active'|'completed'|'failed', result?: {tables: Record<string,{moved,dropped}>, warnings: string[], mergeEventId}, failedReason?}`.
- Mutations wrapped in `runAction`; catch pattern per CLAUDE.md (401 → return; non-ActionError → toast). The `no-silent-mutations` test guards the adopted set — if it flags the new handlers, wire them properly rather than allowlisting.
- `fetchWithAuth` auto-injects orgId (repo memory) — verify how OrganizationsPage calls the API and use the same client so partner-scoped calls hit the right base; the merge endpoints are partner-scoped (loser id in the path, NOT the ambient org).
- DOM queries in tests and E2E use `data-testid` attributes.
- i18n: every string via the settings namespace; keys added to ALL 8 locales (`ls apps/web/src/locales/`); run the locale-parity suite.
- Survivor picker: same-partner orgs, `status ∈ {active, trial}`, excluding the loser and `type === 'quick_support'`.
- MFA: the API enforces it; the UI should surface a 403 MFA failure as the standard re-auth toast (whatever pattern existing MFA-gated actions use in this page — copy it).
- Branch: stacked on wave-4076. Stacked PRs get NO automatic CI — dispatch `gh workflow run CI --ref <branch>` before merge.

---

### Task 1: `MergeOrgModal` + OrganizationsPage wiring + i18n

**Files:**
- Create: `apps/web/src/components/settings/MergeOrgModal.tsx`
- Modify: `apps/web/src/components/settings/OrganizationsPage.tsx` (detail-header action + modal mount; follow the existing edit/delete button + `ModalMode` patterns)
- Modify: `apps/web/src/locales/*/settings.json` (all 8)
- Test: `apps/web/src/components/settings/MergeOrgModal.test.tsx`

**Interfaces:**
- Consumes: the three Wave-2 endpoints (shapes in Global Constraints), `runAction`, the page's org list state (for the survivor picker options + removing the loser on success).
- Produces: `<MergeOrgModal loserOrg={Organization} orgs={Organization[]} onClose={() => void} onMerged={(loserId: string) => void} />`.

- [ ] **Step 1 (TDD): write the failing component tests** — `MergeOrgModal.test.tsx`, jsdom, mocked fetch/`runAction` module per the page's existing test conventions (grep `OrganizationsPage` tests for the harness). Cases:
  1. Survivor picker excludes the loser, quick_support orgs, and non-active/trial orgs.
  2. Selecting a survivor triggers preview fetch; renders `totalMovableRows`, per-table rows (collapsed to a domain summary is fine — assert at least the table count and the warnings list), and every warning string.
  3. `verdict: 'too-large'` disables the confirm path and shows the refusal copy.
  4. Confirm button stays disabled until the typed name equals `loserOrg.name` exactly (case-sensitive).
  5. Submitting calls POST merge with `{survivorId, confirmName}`; on 202 the modal enters progress state and polls merge-runs (fake timers) until `completed`, then renders the result summary (moved/dropped totals + warnings) and calls `onMerged(loserId)`.
  6. `failed` state renders `failedReason` with a retry affordance (re-POST merge — Wave 2 unwedged retry).
  7. 400 confirmName mismatch surfaces the server error without closing the modal.
- [ ] **Step 2: run to verify failure** — `cd apps/web && npx vitest run src/components/settings/MergeOrgModal.test.tsx` → FAIL (module missing).
- [ ] **Step 3: implement the modal** — three internal phases (`pick+preview` → `progress` → `done|failed`), destructive-action styling consistent with the delete modal, warnings rendered prominently (esp. the audit-trail-destruction and key-revocation warnings), poll interval ~2s with cleanup on unmount. Wire the launcher button (`data-testid="org-merge-open"`) into the detail header next to Edit/Delete, gated to partner scope the same way the page gates its other partner-only actions (grep how it decides). On `onMerged`: remove the loser from local list state and close, matching `handleConfirmDelete`'s state update.
- [ ] **Step 4: i18n** — add keys under `organizationsPage.merge.*` in `en/settings.json` + the other 7 locales, matching each file's style; run the locale-parity suite.
- [ ] **Step 5: green** — component tests + `OrganizationsPage` existing tests + locale parity + `npx tsc --noEmit` (web) + eslint on touched files.
- [ ] **Step 6: commit** — `feat(web): org merge UI — survivor picker, preview, typed-name confirm, progress`.

---

### Task 2: Wave wrap — full web verification + review + PR

- [ ] **Step 1:** `cd apps/web && pnpm test` (full web suite; known pre-existing failures per ledger notes stay red), `tsc --noEmit`, eslint.
- [ ] **Step 2:** Whole-branch review (controller dispatches; not the implementer).
- [ ] **Step 3:** Push, `gh workflow run CI --ref <branch>`, PR titled `feat(web): org lifecycle wave 3 — merge UI`, body links spec+plan, `Closes #4077`, generated-with footer. **Stop at the open PR.**
