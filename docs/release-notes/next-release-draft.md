# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.128.0** (2026-11-10).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

Lab checks owed before the next tag:

- [ ] **macOS remote desktop double-click** (#11670, #11549). Run on a signed release candidate on the lab Mac (a branch build cannot keep the screen-recording grant). Rows: double-click opens a folder; double-click selects a word; triple-click selects a line; two slow clicks still rename; click-move-click is two clicks; right-then-left is not a double-click; drag-select still works.
- [ ] **Helper branding and localisation** (#11204). Check native window titles and tray labels in Portuguese on Windows and macOS (the contributor tested on Linux only).
- [ ] **Windows sign-in screen capture** (#9583). The RDP-session preference step is still not lab-verified.
- [ ] **Built-in H.264 encoder fallback** (#11639, open). If a fix lands, re-check picture quality after a burst on a static screen.
- [ ] **Windows self-uninstall** (#11349, still open) — on hold for its lab leg.
- [ ] **Viewer clipboard** (#11325, still open) — on hold for its lab leg.
- [ ] **macOS Local Network prompt** (#11311). On a Mac enrolled to a LAN-hosted server, confirm macOS shows "Allow breeze-agent to find devices on local networks?" and that Breeze Assist connecting triggers it. On a Mac enrolled to an internet-hosted server, confirm no prompt appears.


## Self-Hosting / Upgrade Notes (fold into the release body)


## Features / API


## Migrations
