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

## Verified ✓

_(move items here with the date you confirmed them, e.g. `- [x] #NNNN — verified 2026-06-20 in local docker`)_
