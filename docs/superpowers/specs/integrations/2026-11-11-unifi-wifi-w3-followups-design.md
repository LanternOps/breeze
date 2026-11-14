---
title: UniFi Wi-Fi monitoring: W3 follow-up fixes
issue: LanternOps/breeze discussion #7690
status: draft for maintainer review; no implementation yet
related:
  - LanternOps/breeze#3208
  - docs/superpowers/specs/integrations/2026-10-16-unifi-wifi-monitoring-design.md
---

# UniFi Wi-Fi monitoring: W3 follow-up fixes

## 1. Origin

Todd approved W3 (#10269, head `2113ff10a`, 2026-11-02) with two non-blocking leftovers, explicitly for a follow-up. Both were confirmed by reading `upstream/main` on 2026-11-11. Neither is covered by a test that fails today.

## 2. Problems

### P1. Details-only AP keeps `wifiCapable` null, so its radio list is hidden

- Evidence: `apps/api/src/services/topology/unifiWifiMaterializer.ts` (around lines 94-101). `row.wifiCapable` is set only from `device_list` through `deriveWifiCapable`. The `device_details` loop adds the device to the `capable` set when its radios are non-empty (spec 6.2), but never sets `row.wifiCapable`.
- Effect: the read model maps `wifiCapable` from the row (`apps/api/src/routes/unifi/telemetryReadModel.ts:78`). `TelemetryViewerCard.tsx` renders radios only when `d.wifiCapable === true`. An AP confirmed only by `device_details` therefore has its statistics stored while its radio list stays hidden.
- Impact: APs whose `device_list` capability sets do not yield `accessPoint`/`radios`, for example unknown-only or missing sets, which normalize to `null` under spec 5.1.

### P2. Online AP with an old statistics row is not labelled as stale

- Evidence: `TelemetryViewerCard.tsx` (around lines 120-200).
  - The "as of" label renders only when `d.isStale === true`.
  - The "last reported" label renders only when `showStale`, which requires `online === false` and a positive uplink rate (spec 9.2).
- `isStale` is not a time-based freshness flag. `apps/api/src/services/unifi/unifiTelemetryService.ts` (around line 327) sets it `true` only when a device is absent from the poll. A device that stays in the poll while its statistics row is preserved by rotation (spec 6.3-6.4) is never labelled.
- Effect: an online AP whose CPU, memory, uptime and rate values come from an earlier poll is shown as current. Spec 9.1 requires the per-family `*_observed_at` to be visible, and spec 9.2 requires that a rate is never presented as current traffic.

## 3. Requirements

- R1. A device whose same-poll `device_details` has non-empty radios is `wifiCapable = true` in the materialized row.
- R2. `wifiCapable` is lowered to `false` only under the spec 5.1 rule. The R1 rule can only raise a `null` or `false` to `true`, and only with radio evidence.
- R3. The UI labels an AP's statistics values "as of `wifiStatisticsObservedAt`" whenever that timestamp is older than the threshold in 4.2, whether or not the AP is online.
- R4. No new table, column, migration, endpoint, flag or setting. No new alert evaluator (spec 11).
- R5. Missing stays `null` and measured `0` stays `0` (spec 9.3).

## 4. Design

### 4.1 P1 fix (materializer)

In `buildUnifiWifiRows`, inside the `device_details` loop, after the radios are stored:

```text
if (detail.radios !== null && detail.radios.length > 0) {
  capable.add(detail.deviceId);
  row.wifiCapable = true;   // direct radio evidence from this poll
}
```

- The details loop runs after the device-list loop, so the list value is overwritten only by positive evidence.
- Only the materializer changes. The read model and the card already gate on `wifiCapable === true`.
- The topology v2 contract and digest do not change.

### 4.2 P2 fix (freshness label)

Add a server-computed read-model field rather than having the client infer staleness from timestamps:

- `wifiStatisticsStale: boolean` on each device row of `GET /unifi/telemetry`, computed in `telemetryReadModel.ts` as `wifiStatisticsObservedAt == null ? false : now - wifiStatisticsObservedAt > threshold`. The `null` case is already rendered as `—`.
- `TelemetryViewerCard.tsx` shows the "as of <time>" label when `wifiStatisticsStale === true`, independent of `online` and `isStale`. The existing offline "last reported" label is kept.

Threshold (open decision D1). Proposed default: the family is stale when its age exceeds the rotation period plus one poll margin:

```text
rotationPeriod ≈ ceil(apCount / statisticsBudgetPerPoll) × pollIntervalSeconds
threshold      = max(2 × rotationPeriod, 5 min)
```

This follows from spec 6.3 and 6.4: under fair rotation each AP is attempted once per rotation period, so a row older than two periods has missed at least one full rotation.

## 5. Test plan

- Unit, `unifiWifiMaterializer.test.ts`:
  - device list `wifiCapable: null` (unknown-only features), details with two radios → row `wifiCapable === true`, statistics written;
  - device list `false` (explicit, no radio evidence) and details with radios → `true`;
  - details with empty radios → unchanged;
  - switch with `radios: []` → unchanged, legacy counts untouched.
- Integration, `topologyUnifiWifi.integration.test.ts`: a details-only AP appears in the telemetry read model with `wifiCapable: true` and a non-null radio overview.
- Read model unit: `wifiStatisticsStale` is `false` for a null timestamp, `false` inside the threshold, `true` outside it, computed from an injected `now`.
- Web, `TelemetryViewerCard.test.tsx`:
  - online AP with `wifiStatisticsStale: true` renders the "as of" label;
  - online AP with `wifiStatisticsStale: false` renders no label;
  - details-only AP renders the radio list.
- Existing W3 tests stay green, including the offline-with-positive-rate label.

## 6. Open decisions (maintainer)

- **D1.** Threshold for `wifiStatisticsStale`. Proposed in 4.2. Alternative: a fixed 15 minutes. Simpler, but wrong for large sites with long rotations.
- **D2.** P1 with an explicit list `false` and radios in details. Proposed: `true` (R2), since radios are direct evidence. Alternative: keep the list value and log a mismatch.

## 7. Out of scope

- Any change to the topology v2 contract or digest.
- Alerting on freshness or AP state (spec 11, #3208).
- Customer-portal views (spec 3).
- Changing rotation or budget constants (spec 6.3).

## 8. Acceptance

- P1 and P2 each have a test that fails on `upstream/main` before the fix and passes after it.
- Changes are limited to the materializer, `telemetryReadModel.ts`, `TelemetryViewerCard*`, their tests, and i18n keys if a label is added.
