# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.122.1** (2026-10-12). v0.122.0 was tagged but never released.

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

## Self-Hosting / Upgrade Notes (fold into the release body)

## Features / API

- **Mobile: arrival suggestions (#8209, W2).** With the partner's *Location suggestions* setting on (off by default) and the technician's own opt-in, the app suggests starting a timer when opened at a pinned client site. Foreground only; the phone's position is compared on the device and never sent. Adds the `expo-location` dependency and iOS/Android location permission strings, so it ships with the next **mobile app build** (not an API/web deploy). Technicians with the *Set site location* permission can pin a site from the phone. Docs: Mobile app > Arrival suggestions.

## Migrations
