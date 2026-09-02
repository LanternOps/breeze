# Location-Aware Time Suggestions (Mobile) — Design Spec

**Date:** 2026-08-28
**Source:** Todd, 2026-08-28 — "the app can know their location, the address of the clients, and just simply enters the time against the client." Refined in discussion to one-tap confirm + a selector when several sites match.
**Status:** Drafted — awaiting plan. Roadmap item `LanternOps/breeze#4186`. Depends on `LanternOps/breeze#3206` W03 (time-entry client) and W05 (timer bar).
**Parent feature:** Mobile ticketing & time entry (`#3206`). This is a follow-on, not a wave of that plan — it needs backend changes that plan deliberately excludes.

## 1. Problem & positioning

A field tech walks into a client's office, fixes things for two hours, and forgets to start the timer — or starts it 40 minutes late and guesses the rest. Every RMM/PSA with a mobile app has a timer button; none of them notice you arrived. The phone already knows where the tech is and Breeze already knows where the sites are, so the app should do the noticing.

**Opinionated framing decisions:**

- **Suggest, never write.** Location produces a *prompt*, and a tap produces a *time entry*. There is no code path that creates or stops a time entry without a technician tap. This is what keeps geofence inaccuracy (~100 m at best, 2–5 min exit lag on iOS) from becoming a billing dispute, and it is what makes the App Store "Always location" justification straightforward.
- **The phone's position never leaves the phone.** No server table stores technician coordinates, no location history, no "where is my tech" map. The only coordinate that is ever written server-side is a *site pin* (§2.1), and that is written deliberately by a user with site-write permission. This is the privacy line; the spec does not revisit it.
- **Coordinates come from the people who go there.** `sites.address` is a free-form jsonb blob with no lat/lng; most rows are empty or approximate and geocoding them would silently pin some sites to the wrong parking lot. Instead the primary source is the technician standing on-site tapping "save this as Acme's location". Address geocoding is an *optional accelerator* (§6, wave 4), never a dependency — self-hosters must get the full feature with zero third-party keys.
- **Ambiguity is a list, not a guess.** Two clients in one office park are indistinguishable at geofence resolution. When more than one site matches, the prompt is a picker sorted by distance. One extra tap beats one wrong org on an invoice.
- **Reuse the timer, don't add a parallel entry type.** A location-started entry is an ordinary `time_entries` row started through the existing `/api/v1/time-entries/start` path with a `source` stamp. Approval, billing, timesheet, and the #3206 offline queue all work unchanged.

## 2. Data model

### 2.1 `sites` — location columns (add to existing table)

```
latitude            numeric(9,6)  null
longitude           numeric(9,6)  null
geofence_radius_m   integer       null   -- null = partner default (§2.3); clamp 50..1000
location_source     varchar(16)   null   -- 'technician' | 'manual' | 'geocoded'
location_set_by     uuid          null → users(id)
location_set_at     timestamptz   null
CHECK sites_location_pair_chk ((latitude IS NULL) = (longitude IS NULL))
```

- `sites` is already org-scoped (RLS shape 1, `org_id` column) and already in `CORE_ORG_CASCADE_DELETE_ORDER`. **Adding columns still requires classifying them in `CORE_TENANT_EXPORT_POLICY`** (`services/tenantExportPolicyRegistry.ts`) — all six are `included` (numeric/text/uuid/timestamp; no open containers).
- No index: sites per partner are hundreds at most and the phone matches client-side against a cached list.
- `location_source='technician'` rows are the honest ones; `'geocoded'` rows are shown with a "verify" affordance in the web UI (§6) until a human confirms.

### 2.2 `time_entries` — provenance columns (add to existing table)

```
site_id   uuid          null → sites(id) ON DELETE SET NULL
source    varchar(24)   not null default 'manual'
          -- 'manual' | 'timer' | 'location' | 'remote_session'
```

- **Reconciliation (2026-08-30):** #3206 W06 (#3900) creates this column in migration `2026-09-25-time-entry-source-and-suggestion-decisions.sql` and adds a fifth value `support_session` (a confirmed Quick Support entry with `org_id NULL`). Values are otherwise unchanged; this wave reuses the column. `site_id` is still unbuilt and remains this spec's to add.
- `time_entries` is partner-axis (RLS shape 3) with a denormalised `org_id`; already registered in the cascade and export lists. **New columns → export-policy classification**: both `included`.
- `source` is defined here once and shared with #3206 **W06** (auto-suggest from `remote_sessions`), which needs the same column. Whichever wave lands first creates it; the other reuses it. Do not let each wave invent its own.
- `site_id` is informational (timesheet/report grouping, "which site was this"). It does not participate in RLS or cascade ordering beyond the FK.
- Existing rows backfill `source='manual'` via the column default; entries created through `/start` get `'timer'` from now on so the historical "how much time is timer vs typed" question becomes answerable for free.

### 2.3 Partner setting (jsonb on `partners.settings`, pattern: `services/enrollmentDefaults.ts`)

```json
"timeTracking": {
  "locationSuggestions": {
    "enabled": false,
    "defaultRadiusM": 150
  }
}
```

- **Off by default.** Turning it on is the partner's policy decision (the "company policy" half of the concern); the OS location permission on each phone is the individual technician's opt-in. Both must be true for any prompt to appear.
- Surfaced in web Settings → Time Tracking alongside existing time-entry settings. No org-level override in v1.

### 2.4 Validators (`packages/shared`)

- `createSiteSchema` / `updateSiteSchema`: add optional `latitude`, `longitude`, `geofenceRadiusM` (coerced numbers, ranges enforced: lat ±90, lng ±180, radius 50–1000). Rejected when only one of lat/lng is present.
- `startTimerSchema`: add optional `orgId`, `siteId`, `source`. Today `/start` derives `org_id` from `ticketId` only, so a **site visit with no ticket has no way to name its org** — that is the backend change that puts this outside #3206's "no API changes" plan. Server rule: `orgId` required when `ticketId` absent; when both present the ticket's org wins and a mismatch is 422 `ORG_MISMATCH`.
- `stopTimerSchema`: add optional `endedAt` (ISO, must be ≥ `startedAt`, ≤ now + 5 min skew). Used only by background wave (§5) to stop at the geofence exit timestamp instead of the notification-tap timestamp. Server keeps the existing guard that the entry belongs to the caller.
- `source` values validated against the enum above; clients may send `'location'` or `'timer'` only — `'remote_session'` is reserved for W06's server-side path.

## 3. API

| Route | Change |
|---|---|
| `GET /api/v1/orgs/sites` | Return the new location columns (already returns the full row; verify the select list). Mobile caches this list. |
| `PATCH /api/v1/orgs/sites/:id` | Accept location fields. Existing gating stays (`requireSiteWrite` + `requireMfa()`). |
| `POST /api/v1/orgs/sites/:id/location` (**new**) | Body `{latitude, longitude, geofenceRadiusM?}`. `requireScope('organization','partner','system')` + `requireSiteWrite`, **no `requireMfa()`**. Stamps `location_source='technician'`, `location_set_by`, `location_set_at`. This exists so a tech on-site can pin a location from the phone without the MFA step-up that guards the general site PATCH — a coordinate is not credential material and the tech already authenticated with biometrics to open the app. Audit event `site.location_set`. |
| `POST /api/v1/time-entries/start` | Accept `orgId` / `siteId` / `source` per §2.4. |
| `POST /api/v1/time-entries/stop` | Accept `endedAt` per §2.4. |
| `GET /api/v1/time-entries` | Filter by `siteId`; return `source`, `siteId`. |

No new `/api/v1/mobile/*` routes — the phone calls core endpoints with its existing token, as #3206 established.

## 4. Mobile — wave 2: foreground arrival prompt (the v0 that proves demand)

No background permission. Location is read only while the app is in the foreground, so the iOS prompt is the single-step "While Using" one.

**Trigger points**
1. App transitions to `active` (AppState) and the partner setting is on.
2. Tickets tab or Home tab gains focus.
3. Pull-to-refresh on the Tickets tab.

Debounced: at most one position read per 5 minutes unless the tech pulls to refresh.

**Match**
- `expo-location` `getCurrentPositionAsync({ accuracy: Balanced })` — cell/wifi grade, no GPS spin-up, sub-second.
- Candidate sites = cached sites with coordinates where `haversine(pos, site) ≤ max(site.radius ?? partnerDefault, pos.accuracy)`. Sorted by distance.
- Site cache: `GET /orgs/sites` on login and every 24 h, stored in AsyncStorage alongside the tickets cache. Sites without coordinates are dropped from the match set at cache time.

**Suppress the prompt when**
- a timer is already running (any site);
- the same site was dismissed in the last 4 h;
- a timer was stopped at this site in the last 30 min (tech walked to the car and back);
- position accuracy is worse than 500 m (indoor cell-only fix in a dense area — the list would be everyone).

**ArrivalSheet (bottom sheet, dismissible)**
- 1 candidate: *"Looks like you're at **Acme Corp — Main Office**."* → **[Start timer]** [Not now]
- N candidates: *"You're near:"* → list rows `Acme Corp — Main Office · 40 m`, `Beta LLC · 90 m`, tap = pick. [Not now]
- After pick → ticket step: the tech's open tickets for that org (already in the tickets cache; usually 0–3) plus **"Site visit — no ticket"**. Single ticket → preselected, still one confirming tap. Zero tickets → skips straight to the no-ticket start.
- Start = `POST /time-entries/start { ticketId?, orgId, siteId, source:'location' }` through the #3206 W04 offline queue. 409 `ENTRY_RUNNING` → open the timer bar instead of erroring (race with a manual start).
- Remember last pick per site in AsyncStorage; a repeat visit to a two-site office park pre-highlights last time's choice.

**Site pin ("0 candidates" path)**
- On TicketDetail and on the Timesheet entry editor, when the entry's org has a site without coordinates *and* the user holds site-write: **"Save my current location as <site>"**. Picks the site if the org has several. Calls `POST /orgs/sites/:id/location` with the current fix; requires accuracy ≤ 100 m, otherwise tells the tech to step outside and try again.
- Hidden entirely without the permission — no "request this" queue in v1.

**Stop side (foreground)**
- When the app foregrounds with a `source='location'` timer running and the current position is > 2× radius from that site for two consecutive reads ≥ 5 min apart: *"Still at Acme? Timer has been running 2h 28m."* → **[Stop]** [Keep running]. Stop uses the tap time; foreground cannot know when they actually left.

**Analytics** — PostHog client events only, no coordinates: `location_prompt_shown {candidates}`, `location_prompt_started`, `location_prompt_dismissed`, `site_pinned`.

## 5. Mobile — wave 3: background geofencing (v1)

Only after wave 2 shows techs use the prompt. Adds `expo-location` geofencing + `expo-task-manager`.

- Requests "Always" (two-step on iOS, with the pre-permission explainer screen Apple expects). Declining leaves wave 2 behaviour intact — the feature degrades, it does not break.
- Registers OS geofences for the **20 nearest sites with coordinates** (iOS hard cap 20 regions/app; Android 100 — use 20 on both for parity). Re-ranked on app foreground and on significant-location-change.
- `enter` → local notification *"You're at Acme Corp — start timer?"*; tapping opens the app on the ArrivalSheet with that site preselected. Same suppression rules as §4. **The notification is the whole action; nothing is written until the tap.**
- `exit` while a `source='location'` timer is running for that site → local notification *"Left Acme Corp — stop timer? (2h 28m)"*. Tap → `POST /stop { endedAt: <exit event timestamp> }` so the entry ends when they actually left, not when they noticed the notification.
- Region monitoring is cell/wifi-driven and low-power; the spec bans continuous `watchPositionAsync` in the background.
- `app.json`: `NSLocationWhenInUseUsageDescription` (wave 2), `NSLocationAlwaysAndWhenInUseUsageDescription`, `UIBackgroundModes: ["location"]`, Android `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION` (wave 3). Copy must say *suggests* time entries — App Review reads these.

## 6. Web — wave 4: site location UI + optional geocoding

- Site edit form: map with a draggable pin (Leaflet + OSM tiles — no key), radius slider, "verified" badge when `location_source='technician'`.
- Optional "Geocode from address" button, active only when the partner has configured a geocoding key (Mapbox or Google, stored via the existing partner-secret pattern). Result lands as `location_source='geocoded'` and is flagged unverified until a tech pins it or an admin drags it. Hosted Breeze does not ship a shared key — per-partner only, so quota and ToS are theirs.
- Bulk view: sites missing coordinates, sortable by ticket volume — tells the MSP which pins are worth setting first.

## 7. Waves (for the plan)

| Wave | Scope | Est. |
|---|---|---|
| W1 | Migration (§2.1, §2.2), validators, `/sites/:id/location`, `/start` + `/stop` changes, export-policy registration, partner setting + web toggle | 2 d |
| W2 | Foreground arrival prompt, site pin from phone, suppression rules, analytics (§4) | 3–4 d |
| W3 | Background geofencing + notifications (§5) | 3–4 d |
| W4 | Web map pin + optional geocoding (§6) | 2–3 d |

W1 can start once #3206 W02 (token scope gate) is answered. W2 needs #3206 W03 + W04 (timer client + offline queue) merged, and W05's timer bar to land the 409 fallback cleanly. W3/W4 are independent of each other.

## 8. Rejected alternatives

- **Silent auto-entry** (the literal ask): rejected for accuracy — a 100 m fence and a 5-minute exit lag are fine for a suggestion and unacceptable as an invoice line. Also the harder App Review conversation.
- **Server-side technician location** (send positions, match on the server): more capable (dispatch, "nearest tech") but crosses the privacy line in §1 and creates a new tenant table holding employee whereabouts. If dispatch ever becomes a feature it gets its own spec with its own consent model.
- **Geocoding all site addresses on day one**: bad source data becomes confidently wrong pins; a third-party key becomes a self-host dependency. Deferred to an opt-in accelerator.
- **A `pending` state on `time_entries`**: needed only if anything wrote without a tap. Nothing does, so the timesheet approval flow already covers review.
- **Per-org override of the partner setting**: no use case surfaced; add if one does.

## 9. Open questions

1. `source` column ownership between this W1 and #3206 W06 — whoever plans first defines it; the other plan must reference it. Flagged in both.
2. Does the mobile token satisfy `requireSiteWrite` for typical techs? If most techs lack `sites:write`, the pin path is dead for them and W1 should add a narrower `sites:set_location` permission instead. Check during W1, not before.
3. Android: does `expo-location` geofencing behave under aggressive OEM battery managers (Samsung, Xiaomi)? Wave 3 needs a real-device test matrix, not simulator-only.
