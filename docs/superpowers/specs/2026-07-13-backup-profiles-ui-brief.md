# Design Brief: Backup Profiles UI

Confirmed 2026-07-13 via `/impeccable shape`. UX companion to `2026-07-13-backup-profiles-design.md`, which owns the architecture. Confirmed decisions baked in: **templates at creation** (no seeded rows), **flat editor** (all four sources always visible), **phases 1+2 ship together**.

## 1. Feature Summary

Three surfaces: a **Backup Profiles management page** (list + editor) where an MSP defines "what to protect" per device class; the **Backup tab's Source group** swapping to a profile picker with a custom-selection fallback; and a small **Destination addition** ("org default" option + per-org default designation). A profile named "Server" with Files + System State + SQL enabled, assigned once, is the product moment.

## 2. Primary User Action

On the profiles page: define a device class's protection once and see at a glance what each profile does and doesn't cover. In the tab: pick a profile and trust that the card tells the whole story (sources, owner scope).

## 3. Design Direction

Product register, Restrained — same lane as #2415. Anchors: the **Update Rings page** (in-repo Pattern-A precedent for list + editor + link-from-tab), **Cove's selection profiles** (flat source list with per-source options), and the **#2415 destination cards** (the radio-card vocabulary the profile picker reuses). Light primary, dark supported.

## 4. Scope

Production-ready; phases 1+2 (org + partner-wide) in one pass; shipped-quality components with the full RLS/test matrix from the spec.

## 5. Layout Strategy

**Profiles page** (route under the Backup section, sibling to configs): standard list — name, owner badge ("All orgs" for partner-wide), enabled sources as compact chips (`Files · System State · SQL`), in-use count (policies referencing it), active toggle. Row click → editor.

**Editor** — two moments:
- *Creation:* template cards — **Server** (Files `C:\Users` + System State + SQL full), **Windows Workstation** (Files + Windows excludes), **macOS Workstation** (Files `/Users` + mac excludes), **Linux Server** (Files `/home`, `/etc`), **Blank**. Picking one pre-fills the flat editor; the tech names it and saves their own copy. Template contents = the #2415 preset data, promoted.
- *Editing:* header (name, description, owner scope create-only, active) above a **flat list of all four source sections**, each with an enable switch. Enabled sections expand their options: Files → paths + exclusions (reusing #2415's PathList + grouped suggestion chips); System State → switch only, one explanatory line; SQL → backup type + exclude databases; Hyper-V → consistency + exclude VMs. Disabled sections stay visible as one collapsed row each — what a profile does *not* protect is information.
- No `volumes` control in v1 (field reserved in the schema; no disabled UI shipped).

**Tab Source group:** segmented choice at top — "Use a profile" (default when profiles exist) vs "Custom selection" (exactly today's UI). Profile mode shows radio cards: name, owner badge, source chips, plus an inline "New profile" card (org-scoped quick create, links to the full page for partner-wide). **Destination group:** "Org default" appears as the first radio card when a default exists; partner-owned policies show only that card with an explanatory line.

## 6. Key States

- Profiles page empty: teaching empty state + template cards front and center (first-run *is* the template picker).
- Editor validation: ≥1 source enabled; Files enabled ⇒ ≥1 path — field-level errors, save blocked with the offending section highlighted.
- Delete while in-use: friendly 409 listing the referencing policies (update-ring behavior).
- Partner-wide profile seen by an org-scoped viewer: read-only with "Managed at partner level" note.
- Tab with zero profiles: picker collapses to "New profile" + "Custom selection" — never a dead end.
- Org default destination missing on a partner policy: inline warning in Destination + loud job-level error per spec (never silent).

## 7. Interaction Model

Template card → flat editor → save → back to list. Enable switches expand/collapse source options (150–250ms, state-conveying only). Tab picker uses the exact card interaction vocabulary shipped in #2415 (sr-only radio + focus ring). Edit on a selected profile card deep-links to the profile editor rather than editing inline — profiles are shared objects; in-tab editing would invite accidental fleet-wide changes.

## 8. Content Requirements

All literal i18n keys, en + pt-BR. New copy: page title/subtitle + empty state, five template names/descriptions, four source section titles + one-line descriptions, enable-switch labels, validation messages, in-use 409 message, "Managed at partner level", "Org default" card copy, missing-default warning. Ranges: 0–30 profiles, 1–4 sources per profile, 0–20 paths.

## 9. Recommended References

impeccable `layout.md` (list/editor rhythm), `clarify.md` (source descriptions carry the teaching load), `onboard.md` (first-run template moment).

## 10. Open Questions

None — defaults asserted: System State is its own source type; per-selection schedules out of v1; Hyper-V zero-target selections record an informational skip (spec Q3 resolved toward visibility over silence).
