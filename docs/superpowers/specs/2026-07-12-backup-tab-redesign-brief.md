# Design Brief: Config Policy — Backup Tab Redesign

Confirmed 2026-07-12 via `/impeccable shape`. Hand to `/impeccable craft` or implement directly.

## 1. Feature Summary

The Backup feature tab inside Config Policy detail (`apps/web/src/components/configurationPolicies/featureTabs/BackupTab.tsx`, 2,325 lines) is where an MSP tech defines what gets backed up, where it goes, when it runs, and how long it's kept. Today it's a single scroll of eight undifferentiated sections that interleaves policy intent with storage infrastructure setup. The redesign reorganizes it **within the tab** — same flows, same API calls, same `FeatureTabShell` contract — around the tech's actual mental model.

## 2. Primary User Action

Confirm at a glance that the policy does the right thing: *what → where → when → how long*. Everything else (GFS, immutability, windows) is secondary — reachable but not ambient.

## 3. Design Direction

- **Color strategy:** Restrained. Existing token vocabulary (`bg-background`, `muted`, `primary`); status colors reserved for status.
- **Scene:** A tech at their desk mid-afternoon, setting up a new client's workstation policy between tickets. Light mode primary, dark supported (per PRODUCT.md).
- **Anchors:** NinjaOne (clarity/hierarchy); Veeam's job-wizard mental model (Source → Destination → Schedule → Retention) *as grouping logic only, not a stepper*; Stripe dashboard forms (restrained form craft, inline validation).

## 4. Scope

Production-ready fidelity; one surface (the tab); shipped-quality interactive component; polish until it ships. `FeatureTabShell` and the save/inherit/override contract are untouched.

## 5. Layout Strategy

Reorganize the eight sections into **four titled groups**, required-first order, each with a one-line purpose subtitle:

1. **Source — what to back up.** Backup-type segmented control first. Type-specific fields (paths + exclusions for File; consistency/excludes for Hyper-V; backup type/excludes for SQL; system-state toggle) render *inside* the Source group so scoping is unambiguous. Switching type with edited targets asks before discarding (today it silently resets).

   **OS presets (File mode).** When the path list is empty, lead with three opinionated preset cards instead of a bare input — one click seeds both paths and exclusions, and everything lands as ordinary editable chips (presets are starting points, not locked templates):
   - **Windows user data** — paths: `C:\Users`. Excludes: `**/AppData/Local/Temp/**`, `**/AppData/Local/Microsoft/Windows/INetCache/**`, `$RECYCLE.BIN/**`, `Thumbs.db`, `*.tmp`.
   - **macOS user data** — paths: `/Users`. Excludes: `**/Library/Caches/**`, `**/.Trash/**`, `.DS_Store`, `**/Library/Application Support/MobileSync/Backup/**` (local iPhone backups; large and re-syncable).
   - **Linux home + config** — paths: `/home`, `/etc`. Excludes: `**/.cache/**`, `**/.local/share/Trash/**`, `*.tmp`.

   Presets are additive and combinable — the agent stat-skips paths that don't exist on a device and proceeds with the rest (`agent/internal/backup/backup.go:269-284`, job only "skipped" at zero files total), so one policy can serve a mixed-OS fleet; a one-line hint says so ("Paths that don't exist on a device are skipped"). When paths already exist, the presets collapse to a compact "Add preset" affordance. Cloud-synced folders (OneDrive, Dropbox) are offered as suggested-exclusion chips, not baked into the preset — excluding already-replicated data is opinionated enough to want a visible opt-in.

   The existing flat exclusion-suggestion chips regroup by OS + General, shown contextually after a preset is applied.
2. **Destination — where it goes.** Existing configs become radio **cards** (provider icon, name, bucket/path, enabled badge, object-lock state, Test + Edit actions) instead of a bare `<select>` + separate summary card. "New destination" expands an inset, visually distinct panel — clearly framed as infrastructure, not policy. `s3Prefix` moves fully into this sub-form's state (it's a config detail; its current home in policy-settings state caused the bug fixed in `7db8b7c14`). **Compression and encryption toggles surface here** — they're `backup_configs` columns.
3. **Schedule & retention — when and how long.** Schedule row + plain-language readback sentence (exists today, keep). Retention preset cards stay. **GFS and backup window collapse into an "Advanced retention & timing" disclosure**, closed by default.
4. **Protection — compliance guarantees.** Immutability + legal hold, tied visually to the selected destination's object-lock capability. Keep the existing amber "downgrade to application protection" recovery flow.

Length drops roughly by half at rest via the disclosure.

**Dead-field disposition** (verified against `apps/api/src/db/schema/backup.ts` and `apps/api/src/routes/backup/schemas.ts`):
- `encryption` — accepted top-level by the config create/update API → surfaced as a toggle in the Destination create/edit sub-form. **Implemented.**
- `compression` — column exists but the API's `configSchema`/`configUpdateSchema` do not accept it → NOT surfaced (would be a silent no-op); stays a server-side default. *Deviation from the original brief, verified during craft.*
- `notifyOn*` — no backend storage on the config-policy path → **dropped** (backup-failure alerting belongs to the `alert_rule` feature type).
- `bandwidthLimitMbps` / `priority` — columns only on the legacy standalone `backup_policies` table; `featureConfigResolver`/workers never read them from feature-link inlineSettings → **dropped**.

## 6. Key States

- **No storage configs yet:** empty state inside Destination that teaches ("Backups need a destination first") with the create panel auto-expanded.
- **Configs loading:** skeleton cards, not a spinner line.
- **Inherited:** existing dim + Override contract, unchanged.
- **Test connection:** idle / testing / success / failed on the card; result message inline under the card.
- **Provider-immutability invalid:** existing amber recovery banner, relocated into Protection.
- **Validation:** field-level inline errors (required path, bucket, region) at the field; shell banner reserved for save-time/server errors.
- **Unsaved type-switch:** confirm-discard prompt only when targets were edited.

## 7. Interaction Model

Single save via the shell footer (unchanged contract). Radio-card selection for destination and retention presets; disclosure toggle for advanced timing; pending-path flush on save (keep). Existing form vocabulary throughout (h-10 inputs, rounded-md borders, focus-ring).

## 8. Content Requirements

All strings through i18n with **literal keys** (repo gate, #2340 regression class). New copy: four group titles + subtitles, destination empty state, confirm-discard prompt, field-level error messages, disclosure label, compression/encryption toggle labels + descriptions, three OS-preset card titles + one-line summaries of what each seeds, mixed-fleet skip hint, OS group labels for exclusion chips. Realistic ranges: 0–10 storage configs, 0–20 paths, 0–15 exclusions.

## 9. Recommended References

impeccable `layout.md` (grouping/rhythm), `clarify.md` (labels, error copy, readback sentence), `distill.md` (what the disclosure hides).

## 10. Open Questions

None. Only craft-time verification: whether the scheduler reads `bandwidthLimitMbps`/`priority` from feature-link inlineSettings (evidence says no → delete).

## Deferred (explicitly out of scope)

- **Multi-drive / drive-letter enumeration on Windows** (e.g. "back up all fixed volumes" or per-device drive discovery). Needs agent-side volume enumeration surfaced to the UI; `extractVolumes` in `agent/internal/backup/backup.go` exists for VSS but isn't reported to the API. Presets stay `C:`-rooted until then.
