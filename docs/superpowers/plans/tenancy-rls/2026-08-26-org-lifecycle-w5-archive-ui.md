---
tracking_issue: LanternOps/breeze#4074
wave: LanternOps/breeze#4079
---

# Org Lifecycle Wave 5: Archive Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Organizations page's destructive action becomes **Archive** (retention picker, clear consequences copy); archived orgs get a collapsed read-only section with purge countdown and Restore.

**Architecture:** Replace the delete confirm modal path with an `ArchiveOrgModal`; add an "Archived" list section fed by `includeArchived=true`; archived detail renders read-only with Restore. All mutations via `runAction`.

**Tech Stack:** React islands, patterns from `OrganizationsPage.tsx` + Wave 3's `MergeOrgModal.tsx`, vitest+jsdom.

**Spec:** `docs/superpowers/specs/tenancy-rls/2026-08-26-org-lifecycle-merge-archive-design.md` (Part 2 → Hidden+read-only, Relation to existing delete)

## Global Constraints

- API (Wave 4): `POST /orgs/organizations/:id/archive {retentionDays?: number|null}` → 202 `{status, purgeAt}`; `POST /orgs/organizations/:id/restore` → 200 `{status:'active', recreateRequired: string[]}` | 410 purging; org list `?includeArchived=true` returns archived orgs flagged `archived: true`; archived detail GET serves read-only.
- The old `DELETE` flow is REPLACED in the UI (API route untouched). Remove the delete modal path for orgs (sites keep theirs); the destructive button becomes Archive with the same destructive styling.
- Archive modal copy must state: hidden from lists, data kept read-only, agents uninstalled, billing stops, auto-purge after the retention period (or "kept until you delete it" for never) — no "cannot be undone" lie; restore is the undo.
- Retention picker options: 30 / 90 (default) / 365 days / Never / custom number input (1–3650).
- Purge countdown on archived rows/detail from `purgeAt`; `null` renders "kept indefinitely".
- Restore surfaces `recreateRequired` items in the success toast/panel.
- i18n keys in all 8 locales; locale-parity suite green. `data-testid` on every interactive element. `runAction` + catch pattern per CLAUDE.md.
- Branch: stacked; manual CI dispatch before merge.

---

### Task 1: `ArchiveOrgModal` replacing the delete flow

**Files:** Create `apps/web/src/components/settings/ArchiveOrgModal.tsx`; Modify `OrganizationsPage.tsx` (replace org-delete modal mode + both delete buttons' wiring; keep site delete untouched); Modify all 8 `locales/*/settings.json`; Test `ArchiveOrgModal.test.tsx`.

**Steps (TDD):** failing tests — retention picker defaults 90/renders all options/custom validates 1-3650; consequences copy present; archive POST body `{retentionDays}` (null for Never); 202 → `onArchived(orgId)` removes org from active list; error path leaves modal open with toast. Then implement, i18n, green (`npx vitest run` on the new test + OrganizationsPage suites + locale parity), commit `feat(web): archive replaces org delete — retention picker + consequences copy`.

---

### Task 2: Archived section + read-only detail + Restore

**Files:** Modify `OrganizationsPage.tsx` (+`OrganizationList.tsx` if the section lives there): collapsed "Archived" section fetching with `includeArchived=true` on expand; rows show name + archived badge + purge countdown (`data-testid="org-archived-row"`); selecting one renders the detail pane read-only (no edit/merge/archive buttons; archived badge; countdown; `data-testid="org-restore"` button). Restore → `runAction` POST → on 200 move org to active list + surface `recreateRequired`; on 410 show the purging-refusal copy. Test file covers: section hidden when empty/collapsed fetch-on-expand, countdown rendering (fixed dates via fake timers), restore happy + 410 paths, read-only pane hides mutation buttons. i18n all locales. Commit `feat(web): archived org section with purge countdown and restore`.

---

### Task 3: Wave wrap

Full web suite + tsc + eslint; whole-branch review (controller dispatches); push; `gh workflow run CI --ref <branch>`; PR `feat(web): org lifecycle wave 5 — archive UI`, `Closes #4079`; release-note flag: org Delete became Archive. **Stop at the open PR.**
