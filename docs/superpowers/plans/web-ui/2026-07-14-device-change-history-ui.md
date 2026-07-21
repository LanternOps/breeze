# Plan: Device Change History UI (Phase 1 of #2502)

Surface the EXISTING `device_change_log` subsystem in the web UI as a new "Change History"
tab on the device-detail page. Backend, DB, retention, and the `GET /api/v1/changes`
endpoint already exist and need NO changes. This is web-only.

## Global Constraints (bind every task; reviewers get these verbatim)

- **No API/DB/agent changes.** Consume the existing `GET /api/v1/changes` endpoint only.
- **Fetching:** use `fetchWithAuth` from `apps/web/src/stores/auth.ts` with a RELATIVE url
  (`/changes?deviceId=...`). It auto-injects API origin, `orgId`, and the Bearer token — do
  NOT add origin or orgId yourself. Follow the `DeviceIpHistoryTab` pattern:
  `useState` + `useCallback` + `useEffect(fetch)`. Do NOT introduce react-query.
- **Endpoint response shape:** `{ changes: Item[], total: number, showing: number,
  hasMore: boolean, nextCursor: string | null }`. Each `Item` =
  `{ id, deviceId, hostname, timestamp (ISO string), changeType, changeAction, subject,
  beforeValue (obj|null), afterValue (obj|null), details (obj|null) }`.
- **Query params:** `deviceId` (uuid), `startTime`/`endTime` (ISO w/ offset), `changeType`,
  `changeAction`, `limit` (1–500, default 100), `cursor` (opaque base64url from
  `nextCursor`). Pagination is KEYSET/cursor forward-only — use a "Load more" that appends
  the next page via `?cursor=<nextCursor>`; changing a filter resets and refetches page 1.
- **Enum values (exact, for filter dropdowns):**
  - `changeType`: `software`, `service`, `startup`, `network`, `scheduled_task`, `user_account`
  - `changeAction`: `added`, `removed`, `modified`, `updated`
- **i18n (CI-critical):** all UI strings go through `t()` in the `devices` namespace under a
  new `deviceChangeHistoryTab` key block. The 5 locales `en`, `es-419`, `fr-FR`, `de-DE`,
  `pt-BR` MUST stay in exact key parity (guard: `apps/web/src/lib/i18n/localeParity.test.ts`).
  Same key paths, same `{{interpolation}}` tokens, string leaves. `keyUsage.test.ts` requires
  every added key to be referenced by an actual `t(...)` call (no orphan keys).
- **Permission:** endpoint is gated `devices:read`; no client-side gating change needed
  (tab renders for anyone who can view the device).
- **Hash routing:** active tab is hash-based via `useHashState`; `switchTab` writes
  `window.location.hash`. Adding the id to `Tab`/`VALID_TABS` makes `#change-history`
  deep-linkable automatically.
- **Tests:** add `DeviceChangeHistoryTab.test.tsx` mirroring `DeviceActivityFeed.test.tsx`
  (mock the `../../stores/auth` module's `fetchWithAuth`; stub `{ok,status,json}` Responses).

> **i18n atomicity (why 2 tasks, not 3):** every task that adds an `en` key adds the SAME
> key to all 5 locales in the same task, so `localeParity.test.ts` is green at every task
> boundary. Never leave `en` ahead of the other locales across a task boundary.

## Task 1: DeviceChangeHistoryTab component + test + all-locale keys

Create `apps/web/src/components/devices/DeviceChangeHistoryTab.tsx`.

- `export default function DeviceChangeHistoryTab({ deviceId }: { deviceId: string })`.
- Copy the visual shell / loading / error+retry / empty-state structure from
  `apps/web/src/components/devices/DeviceIpHistoryTab.tsx` (card `rounded-lg border bg-card
  p-6 shadow-xs`, sticky-header scrollable table). But wire pagination to the API's cursor,
  NOT the in-memory slice DeviceIpHistoryTab uses.
- Fetch: `fetchWithAuth('/changes?' + params)` where params always include
  `deviceId=${deviceId}` and `limit=100`, plus `changeType`/`changeAction` when a filter is
  set, plus `cursor` when loading more. On filter change: clear rows, drop cursor, refetch.
- UI:
  - Two filter `<select>`s: Change Type and Change Action, each with an "All …" option
    (value `""`) plus one option per enum value above. Options labeled via `t()`.
  - A timeline/table, newest first (API already orders desc). Each row shows: formatted
    `timestamp`, a `changeType` badge, a `changeAction` badge, the `subject`, and a
    before → after rendering. For before→after: when `beforeValue`/`afterValue` are present,
    render a compact `old → new` (stringify scalar values; for objects show key: val pairs).
    `null` before with an `afterValue` reads as an add; `null` after reads as a removal.
  - "Load more" button shown only when `hasMore`; appends next page via `nextCursor`.
  - Loading spinner (initial), error card with Retry, empty state ("No changes recorded
    yet." / a filtered variant when a filter is active).
- All strings via `t("deviceChangeHistoryTab.<key>", "devices")`. Add the
  `deviceChangeHistoryTab` block to **all 5 locale files**
  (`apps/web/src/locales/{en,es-419,fr-FR,de-DE,pt-BR}/devices.json`) with genuine
  translations — same key set, same `{{interpolation}}` tokens, string leaves — so
  `localeParity.test.ts` stays green. Template: the existing `deviceIpHistoryTab` block in
  `en/devices.json`. Suggested keys: `title`, `loading`, `retry`, `loadError` (with
  `{{status}}`), `empty`, `emptyFiltered`, `loadMore`, `filterType`, `filterAction`,
  `allTypes`, `allActions`, one label per changeType value (`type_software` …
  `type_user_account`), one per changeAction (`action_added` … `action_updated`), column
  headers (`colWhen`, `colType`, `colAction`, `colSubject`, `colChange`). Only add keys you
  actually reference in `t(...)` (keyUsage guard). Non-en values are machine translations
  pending native review (consistent with #2338).
- Do NOT register the tab in DeviceDetails yet (Task 2). Component must be standalone.
- Test `apps/web/src/components/devices/DeviceChangeHistoryTab.test.tsx` (mirror
  `DeviceActivityFeed.test.tsx`): assert (a) initial loading, (b) rows render from a mocked
  `{changes:[…], hasMore:true, nextCursor:'abc'}`, (c) empty state on `{changes:[]}`,
  (d) error+retry on a non-ok Response, (e) changing the type filter refetches with
  `changeType=` in the URL, (f) "Load more" issues a request containing `cursor=abc`.

Files: `DeviceChangeHistoryTab.tsx` (new), `DeviceChangeHistoryTab.test.tsx` (new),
`apps/web/src/locales/{en,es-419,fr-FR,de-DE,pt-BR}/devices.json` (add `deviceChangeHistoryTab` block to each).

## Task 2: Register the tab in DeviceDetails + all-locale nav keys

Wire the Task 1 component into `apps/web/src/components/devices/DeviceDetails.tsx`.

- Add `"change-history"` to the `Tab` string-union (~line 74) and the `VALID_TABS` array
  (~line 150).
- Add a static default import of `DeviceChangeHistoryTab` alongside the other tab imports
  (~lines 38-70).
- Add a `tabs` metadata entry (~line 241) `{ id: "change-history", label:
  t("deviceDetails.changeHistory"), icon: <History className="h-4 w-4" />, title:
  t("deviceDetails.changeHistoryTitle") }`. Pick an existing lucide icon already imported or
  import one (e.g. `History` or `ClipboardList`). Place it sensibly near `activities` /
  `ip-history`.
- Add the render conditional in the tab-body block (~lines 474-731):
  `{activeTab === "change-history" && <DeviceChangeHistoryTab deviceId={device.id} />}`.
- Add the two new `deviceDetails.*` keys (`changeHistory`, `changeHistoryTitle`) to **all 5
  locale files** (`{en,es-419,fr-FR,de-DE,pt-BR}/devices.json`) with genuine translations, so
  `localeParity.test.ts` stays green.

Files: `DeviceDetails.tsx`, `apps/web/src/locales/{en,es-419,fr-FR,de-DE,pt-BR}/devices.json`.

## Verification (whole feature)

- `pnpm --filter @breeze/web test` covering `DeviceChangeHistoryTab.test.tsx` and the i18n
  guards (`localeParity`, `keyUsage`) green.
- `pnpm --filter @breeze/web typecheck` (or `astro check`) green — the `Tab` union edit and
  new component must typecheck.
- Manual/driven check: device detail `#change-history` renders the timeline, filters
  refetch, Load more appends.
