# UI items to review before release

> Living checklist of **merged-to-main** changes with a user-facing/visual surface that shipped
> *without* a hands-on UI pass from Todd. Walk these in a real browser (or in-host) before cutting
> the next release. Check off + date when verified; remove once it's shipped in a tagged release.
>
> Maintained by the `gh-queue` skill. New merged UI PRs get appended here instead of being held.

## Pending verification

### Round 40 — merged 2026-06-19

- [ ] **#1593** (Billy) — Monaco theme preserved across View-Transition swap. _Fixes #1589 (white text / invisible selection after navigating between scripts)._
  - **Verify:** Scripts list → edit script A → back to list → edit script B. Editor stays themed (no white text, selection highlight visible) without a full page refresh. Repeat a few times.
- [ ] **#1524** (ramphex) — Windows hardware reporting via PowerShell CIM/WMI (replaces deprecated `wmic`) + new motherboard fields. _Fixes #1522 (missing BIOS/GPU on Windows agents)._
  - **Verify:** On a Windows device's detail → Info/Hardware tab: BIOS, GPU(s), and motherboard (manufacturer/model/serial) populate. Confirm multi-GPU machines list all GPUs, placeholder OEM strings ("To be filled by O.E.M." etc.) are filtered, and devices with no motherboard data degrade gracefully (no blank/`undefined`/duplicated rows). _Note: requires a re-reporting agent build; older agents send `null` → fields blank, which is expected._
- [ ] **#1602** (Billy) — FormData uploads get a 10-min timeout (was a blanket 30s). _Fixes #1601 ("signal is aborted without reason" on a ~190 MB MSI that actually uploaded)._
  - **Verify:** Upload a large software-package version (>30s transfer). Upload completes with a success state — no spurious "signal is aborted" error toast. _(Merged pending green re-run — see queue.md.)_

### Round 44 — merged 2026-06-22

- [ ] **#1761** (Billy) — PAM rule matching cluster (command-line / negation / default-unmatched verdict). _Has a rule-config modal/tab in the PAM admin surface._
  - **Verify:** PAM config UI → create a rule with a command-line pattern + a negated criterion; save (uses `runAction`). Confirm an unmatched elevation stays **pending/require-approval** (fail-closed) and that the `auto_deny` default behaves as configured. Backend decisioning verified in review; this is the config-UI eyeball.
- [ ] **#1717** (ramphex) — macOS RAM now reported **pressure-aware** (active+wired+compressed, excluding cached/purgeable) instead of raw resident. _Not a layout change — a metric-value shift._
  - **Verify:** On a macOS device detail + fleet RAM dashboards, used-RAM% should read **lower/more realistic** than before (macOS previously overstated via cached pages). Confirm no macOS device falsely trips/clears a RAM alert surprisingly. `ramUsedMb` on macOS now means pressure-equivalent, diverging slightly from the Linux/Windows resident semantics for the same field.

### Round 45 — merged 2026-06-22

- [ ] **#1718** (ramphex) — Devices list: the "Hostname" column is now **"Device"**, showing the display name as the primary label with hostname as muted secondary text (when distinct); quick search now matches **display name OR hostname**; global search descriptions dedupe hostname and append last user.
  - **Verify:** /devices → a device with a display name set shows the friendly name on top + hostname beneath; the search box (placeholder "Search devices") filters by both display name and hostname; sorting the Device column still works (numeric collation). Global top-bar search shows `hostname · status · user` without duplicating the hostname when it's also the title.
- [ ] **#1771** (Billy) — PAM reusable **signer-group (trusted-publisher) catalog** — a new Signer Groups tab in the PAM admin surface + rule wiring.
  - **Verify:** PAM config UI → Signer Groups tab: create/edit/delete a signer group (save uses `runAction`); reference it from a PAM rule. Backend (Shape-1 RLS, fail-closed foreign-org ingest) verified in review; this is the catalog-UI eyeball. _Note: matching is subject-CN-only — thumbprint pinning tracked as #1776._

## Verified ✓

_(move items here with the date you confirmed them, e.g. `- [x] #NNNN — verified 2026-06-20 in local docker`)_

## PR #2309 — linked device profiles for multi-boot (#2138) — merged 2026-07-10 (62d5032a8)
New UI to eyeball before release:
- Devices list: link two same-org devices (Linked Profiles tab on device detail), then with exactly one online → offline sibling renders as thin muted strip under the online row ("<OS> inactive · Expected offline · last seen · agent vX"); strip clicks through to sibling's detail page and is NOT bulk-selectable.
- All linked profiles offline → both full rows + left-edge group bracket. 2+ online → plain full rows.
- Toolbar toggle "Collapse linked inactive profiles" (default ON, localStorage-persisted) — verify it flips presentation live and persists across reload.
- Check BOTH desktop table and mobile-card (ResponsiveTable) renderings of strips.
- Pagination caveat (accepted): siblings split across pages render ungrouped.
