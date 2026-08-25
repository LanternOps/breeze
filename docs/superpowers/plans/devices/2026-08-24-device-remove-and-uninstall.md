# Device "Remove" + Durable Agent Uninstall — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offboarding a device becomes one honest action — "Remove" — that asks whether to uninstall the Breeze agent and actually delivers that uninstall to offline machines, while "Delete permanently" becomes a separate data-purge action.

**Architecture:** A removed device's agent keeps a *narrowed* authenticated surface (REST heartbeat only, `self_uninstall`-only command claim, no WebSocket) for exactly as long as it has an undelivered uninstall queued. That drain state is **derived**, never stored — `status='decommissioned' AND EXISTS(pending/sent self_uninstall)` — so there is no new column, no migration, no new status value, no new sweeper job, and nothing that can drift. The existing `tenantDraining` mechanism is mirrored rather than reinvented.

**Tech Stack:** Hono + Drizzle + Postgres (API), Astro + React + i18next (web), Vitest, Playwright. Go agent is **not** modified.

Closes #3986 (API), #3987 (Web).

---

## Global Constraints

- **NEVER write a backfill migration, and never backfill `uninstall_reasons`.** Queuing `self_uninstall` for already-decommissioned devices would uninstall agents fleet-wide on deploy; stamping `device_remove` onto historic rows would arm the same incident. The plan adds exactly ONE migration (Task 5, two nullable columns on `device_commands`) and it backfills nothing — `NULL` reasons mean no exemption and no widened auth, fail-closed by construction.
- **`uninstallAgent` defaults to `false` on the API.** The web UI sends `true` explicitly. PR2 may merge before PR3; the default must never silently start uninstalling agents.
- **Do not modify `apps/api/src/routes/agentWs.ts:749`.** Its independent `decommissioned` check is what keeps the WebSocket control channel shut for a removed device. That asymmetry (REST heartbeat open, WS shut) is the security property this design depends on — see `agentWs.ts:786-793` for why WS cannot be narrowed by command type.
- **Do not modify the Go agent.** Commands ride the heartbeat response body (`heartbeat.go:197`, consumer loop `:4363`); a heartbeat-only agent already receives and executes `self_uninstall`. The Go agent calls `RecordAuthFailure` only on **401**, never 403 (`heartbeat.go:4085` vs the generic branch at `:4094`), so removed agents in the field are at full 60s cadence and will collect a queued uninstall within one interval of deploy.
- **UI labels only.** The DB enum value stays `decommissioned`; the API contract, query params (`includeDecommissioned`), error codes (`DECOMMISSIONED`), props, and every `data-testid` stay exactly as they are. Renaming any of those buys nothing and breaks 30+ assertions.
- **Do not rename locale KEY names**, only their values. Key renames force all 8 locale dirs plus every `t()` call site and redden `localeParity.test.ts:405` and `keyUsage.test.ts:336`.
- File size guideline: aim under 500 lines, use judgement (per CLAUDE.md).

## Terminology (use verbatim in copy)

| Concept | UI word | DB / API (unchanged) |
|---|---|---|
| Offboard, keep history, restorable | **Remove** / **Removed** | `status='decommissioned'` |
| Destroy history, irreversible | **Delete permanently** | `DELETE /devices/:id/permanent` |
| Undo a removal | **Restore** | `POST /devices/:id/restore` |

---

## Why the drain state is derived, not stored

```
deviceDraining(device) :=
      device.status === 'decommissioned'
  AND EXISTS (SELECT 1 FROM device_commands
              WHERE device_id = device.id
                AND type = 'self_uninstall'
                AND status IN ('pending','sent'))
```

Four properties this buys, each of which a stored column or a new status value would cost:

1. **Self-limiting.** When the command reaches any terminal state — `completed` (agent ack), `failed` (reaper timeout closes the drain window), or `cancelled` (restore) — the device stops being drainable and `agentAuth` returns to today's hard 403. No cleanup job, no deadline column, no `offboardingDrainReaper` equivalent.
2. **Cannot go stale.** There is no second source of truth to drift from the commands table.
3. **False for every existing device.** `tenantOffboarding.queueDrainUninstalls` explicitly skips decommissioned devices (`tenantOffboarding.ts:175` `ne(devices.status,'decommissioned')`), and abuse-suspension uninstalls target *active* devices. So no row in the field satisfies the predicate today — deploying PR2 changes behaviour for zero devices.
4. **No `ADD COLUMN` on `devices`.** `devices` has `org_id`, so it is in `CORE_ORG_CASCADE_DELETE_ORDER`; per CLAUDE.md every column of an org-cascade table must be classified in `CORE_TENANT_EXPORT_POLICY`, and that contract fires on `ADD COLUMN`, not just new tables. Deriving sidesteps the whole registration burden.

### The two layers that must both be narrowed

`tenantDraining` is **not one gate**. Mirroring only the command-type allowlist would leave a removed device's agent with the full authenticated route surface — inventory push, BitLocker/FileVault recovery-key ingest (`routes/agents/recoveryKeys.ts:16`), PAM elevation requests, log shipping, and **every third-party extension's `<prefix>/agent/:id/*` namespace** (`extensions/gateway.ts:60-65`). Both layers are required:

| Layer | Mechanism | Where |
|---|---|---|
| Route allowlist | `DRAIN_ALLOWED_ACTIONS` = `{heartbeat, commands, logs, rotate-token}` | `agentAuth.ts:270`, enforced `:595` |
| Command-type allowlist | `typeAllowlist` → `inArray(deviceCommands.type, ...)` | `commandDispatch.ts:78-88`, passed from 3 call sites |
| (WS) | independent `decommissioned` refusal — **leave alone** | `agentWs.ts:749` |

---

## File Structure

**PR1 — web labels + menu parity** (no API dependency, ships alone)

| File | Responsibility |
|---|---|
| `apps/web/src/locales/en/devices.json` | 31 value edits (keys unchanged) |
| `apps/web/src/locales/{de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/devices.json` | matching value edits, 7 locales |
| `apps/web/src/locales/en/common.json` | 1 value edit (`longTail.fleet.FixPicker.skipReasons.decommissioned`) |
| `apps/web/src/components/devices/DecommissionedHiddenHint.tsx` | hard-coded string → `t()` |
| `apps/web/src/components/devices/DeviceDetails.tsx` | `statusLabels` hard-coded label |
| `apps/web/src/components/devices/DeviceDetailPage.tsx` | 3 hard-coded toasts |
| `apps/web/src/components/devices/DeviceActions.tsx` | **menu parity** — the surface with no status branch |
| `apps/web/src/components/devices/DeviceCard.tsx`, `DeviceList.tsx` | add "Delete permanently" to the removed branch |
| `apps/web/src/services/deviceActions.ts` | error-fallback string + `summarize*` reason word |
| `apps/web/src/components/filters/ValueInput.tsx` | enum label map so the filter builder stops deriving "Decommissioned" |

**PR2 — API durable uninstall** (ships alone; behaviour-neutral until PR3 sends `uninstallAgent:true`)

| File | Responsibility |
|---|---|
| `apps/api/src/services/deviceUninstallDrain.ts` | **new** — the single home for the derived predicate, the queue helper, and the cancel helper |
| `apps/api/src/routes/devices/core.ts` | `DELETE /:id` accepts `uninstallAgent`; `POST /:id/restore` cancels; delete the WS best-effort block |
| `apps/api/src/middleware/agentAuth.ts` | `:419` throw → narrow; feed the route allowlist and one derived claim allowlist |
| `apps/api/src/routes/agents/{heartbeat,commands}.ts` | consume the derived allowlist instead of the local ternary |
| `apps/api/src/jobs/staleCommandReaper.ts` | second OR-arm for the device-level drain window |
| `apps/api/src/config/*` | `DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS` (default 72, mirroring `OFFBOARDING_DRAIN_WINDOW_HOURS`) |

**PR3 — web Remove dialog** (depends on PR2 being deployed)

| File | Responsibility |
|---|---|
| `apps/web/src/components/devices/RemoveDeviceDialog.tsx` | **new** — wraps `ConfirmDialog`'s `children` slot with the two-option radio |
| `apps/web/src/services/deviceActions.ts` | `decommissionDevice(id, { uninstallAgent })` |
| `apps/web/src/components/devices/DevicesPage.tsx`, `DeviceDetailPage.tsx` | own the radio state, pass it through |

---

# PR1 — Web: menu parity + label rename

Branch: `feat/3987-device-remove-labels` (off `main`). No API dependency. `Refs #3987` (partial — the Remove dialog is PR3).

---

### Task 1: Menu parity on removed devices

Today three surfaces disagree, and one of them offers an action the API rejects with `400 Device is already decommissioned`. After this task every surface offers **Restore** and **Delete permanently** on a removed device, and none offers Remove.

**Files:**
- Modify: `apps/web/src/components/devices/DeviceActions.tsx:410-415` and `:623-628` (the two overflow menus — neither branches on status today)
- Modify: `apps/web/src/components/devices/DeviceCard.tsx:302-327` (restore branch exists; add Delete permanently)
- Modify: `apps/web/src/components/devices/DeviceList.tsx:2486-2510` (same)
- Test: `apps/web/src/components/devices/DeviceActions.test.tsx`

**Interfaces:**
- Consumes: the existing `onAction?: (action: string, device: Device) => void` prop, already wired to dispatchers that handle `'restore'` (`DevicesPage.tsx:821`, `DeviceDetailPage.tsx:401`) and `'permanent-delete'` (`DevicesPage.tsx:827`, `DeviceDetailPage.tsx:410`).
- Produces: nothing new. **Do not add new action strings** — `'restore'` and `'permanent-delete'` already exist end-to-end.

- [ ] **Step 1: Write the failing test**

In `DeviceActions.test.tsx`:

```tsx
it('offers Restore and Delete permanently — not Remove — on a removed device', async () => {
  const onAction = vi.fn();
  render(<DeviceActions device={{ ...baseDevice, status: 'decommissioned' }} onAction={onAction} />);
  await userEvent.click(screen.getByTestId('device-actions-menu'));

  expect(screen.queryByText('Remove')).not.toBeInTheDocument();
  expect(screen.getByText('Restore')).toBeInTheDocument();
  expect(screen.getByText('Delete permanently')).toBeInTheDocument();

  await userEvent.click(screen.getByText('Restore'));
  expect(onAction).toHaveBeenCalledWith('restore', expect.objectContaining({ status: 'decommissioned' }));
});

it('offers Remove — not Restore — on a live device', async () => {
  const onAction = vi.fn();
  render(<DeviceActions device={{ ...baseDevice, status: 'online' }} onAction={onAction} />);
  await userEvent.click(screen.getByTestId('device-actions-menu'));
  expect(screen.getByText('Remove')).toBeInTheDocument();
  expect(screen.queryByText('Restore')).not.toBeInTheDocument();
});
```

If the menu trigger has no `data-testid` today, add `data-testid="device-actions-menu"` to it as part of this task — a menu that cannot be opened cannot be regression-tested.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceActions.test.tsx
```
Expected: FAIL — "Remove" is absent (the label still reads "Decommission" until Task 2) **and** "Restore" is absent (no status branch exists).

Because Task 2 renames the label, write this test against the **final** wording now and accept that it stays red until Task 2 lands. If you prefer a green commit per task, assert on the `t()` key via the test i18n instance rather than the literal.

- [ ] **Step 3: Implement the status branch**

Mirror the shape already used at `DeviceCard.tsx:302`. In BOTH `DeviceActions.tsx` menus (`:410` and `:623`), replace the unconditional Decommission button with:

```tsx
{device.status === "decommissioned" ? (
  <>
    <button
      type="button"
      onClick={() => handleAction("restore")}
      className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-success hover:bg-success/10"
    >
      <RotateCcw className="h-4 w-4" />
      {t("deviceActions.restore")}
    </button>
    <button
      type="button"
      onClick={() => handleAction("permanent-delete")}
      className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
    >
      <Trash2 className="h-4 w-4" />
      {t("deviceActions.permanentlyDelete")}
    </button>
  </>
) : (
  <button
    type="button"
    onClick={() => handleAction("remove")}
    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
  >
    <Trash2 className="h-4 w-4" />
    {t("deviceActions.decommission")}
  </button>
)}
```

**Keep the action string `"decommission"`, not `"remove"`** — changing it would require touching both dispatchers and `ModalType`. Only the *label* changes. (The snippet above says `handleAction("remove")` to make the point that it is tempting; use `"decommission"`.)

`RotateCcw` must be added to the `lucide-react` import in `DeviceActions.tsx`.

Then in `DeviceCard.tsx` and `DeviceList.tsx`, add the same Delete-permanently button inside the existing `status === "decommissioned"` branch, immediately after Restore.

Two new locale keys are needed — add them in Task 2: `deviceActions.restore`, `deviceActions.permanentlyDelete` (and `deviceCard.permanentlyDelete`, `deviceList.permanentlyDelete`).

- [ ] **Step 4: Confirm the permanent-delete dispatchers actually confirm**

Read `DevicesPage.tsx:827-845` and `DeviceDetailPage.tsx:410`. `DevicesPage` already gates permanent delete behind a ConfirmDialog. **Verify `DeviceDetailPage` does too** — this action is now reachable from a menu for the first time, and an unconfirmed irreversible purge one click from a kebab is a defect. If it does not confirm, add the same ConfirmDialog gate in this task.

- [ ] **Step 5: Run the device component tests**

```bash
pnpm --filter @breeze/web exec vitest run src/components/devices/
```
Expected: the two new tests fail only on wording (fixed by Task 2); no pre-existing test regresses.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/
git commit -m "fix(web): offer Restore + Delete permanently on removed devices in every menu

The device detail page's action menus never branched on status, so an
already-decommissioned device still offered Decommission — which the API
rejects with 400. Permanent delete was reachable only from the Device
Settings modal, behind a status filter.

Refs #3987"
```

---

### Task 2: Rename the labels (English) and localize the hard-coded strings

**Files:**
- Modify: `apps/web/src/locales/en/devices.json` (31 values), `apps/web/src/locales/en/common.json` (1 value)
- Modify: `apps/web/src/components/devices/DecommissionedHiddenHint.tsx:23`, `DeviceDetails.tsx:149`, `DeviceDetailPage.tsx:368,385,394`, `apps/web/src/services/deviceActions.ts:392`
- Modify tests: `DeviceList.test.tsx:944,1109,1169,1220`, `DeviceCard.gating.test.tsx:86,176`, `DevicesPage.test.tsx:772,1057,1125,1380`, `PossibleReplacementBanner.test.tsx:107`, `RunProgressPanel.test.tsx:171`, `FixPickerModal.test.tsx:421`, `services/__tests__/deviceActions.test.ts:464`

**Interfaces:**
- Produces: locale keys `deviceActions.restore`, `deviceActions.permanentlyDelete`, `deviceCard.permanentlyDelete`, `deviceList.permanentlyDelete`, `decommissionedHiddenHint.label`, `decommissionedHiddenHint.show` — consumed by Task 1's markup and Task 3's translations.

- [ ] **Step 1: Rename the English values**

Key names stay. Values change. The full list (verified exhaustive — 29 name-matched + 2 value-only in `devices.json`, 1 in `common.json`):

| Key | New English value |
|---|---|
| `deviceActions.decommission` | `Remove` |
| `deviceActions.unavailable.decommissioned` | `Device is removed` |
| `deviceActions.confirm.decommission.title` | `Remove Device` |
| `deviceActions.confirm.decommission.message` | *(PR3 replaces this entirely — set it to)* `Remove {{hostname}}? It will be taken out of your active fleet and stop being monitored. History is kept and you can restore it later.` |
| `deviceActions.confirm.decommission.confirm` | `Remove` |
| `deviceCard.decommission` | `Remove` |
| `deviceCompare.status.decommissioned` | `Removed` |
| `deviceDetailPage.decommissionCancelled` | `Removal cancelled` |
| `deviceList.statuses.compact.decommissioned` | `Removed` |
| `deviceList.statuses.full.decommissioned` | `Removed` |
| `deviceList.decommissionSelected` | `Remove Selected` |
| `deviceList.decommission` | `Remove` |
| `deviceSettingsModal.decommissionDevice` | `Remove Device` |
| `deviceSettingsModal.decommissionWarning` | `Removing takes this device out of your active fleet. History is kept and you can restore it later.` |
| `deviceSettingsModal.decommissionedDescription` | `This device has been removed. You can restore it or delete it permanently.` |
| `deviceSettingsModal.decommissionedTitle` | `Removed Device` |
| `deviceSettingsModal.permanentlyDelete` | `Delete permanently` |
| `devicesPage.confirmDecommissionedSkip.message` | `{{skipped}} of {{total}} selected devices are removed and will be skipped — they no longer have a managed agent. Continue with the remaining {{eligible}} device(s)? Any that are offline will run this when they next check in.` |
| `devicesPage.confirmDecommissionedSkip.title` | `Some selected devices are removed` |
| `devicesPage.toasts.bulkAllDecommissioned` | `All {{total}} selected device(s) are removed — they no longer have a managed agent to run this.` |
| `devicesPage.toasts.bulkDecommissionFailed` | `Bulk Remove Failed` |
| `devicesPage.toasts.bulkDecommissioned` | `Devices Removed` |
| `devicesPage.toasts.decommissionCancelled` | `Removal Cancelled` |
| `devicesPage.toasts.decommissionFailed` | `Remove Failed` |
| `devicesPage.toasts.decommissioned` | `Removed` |
| `devicesPage.toasts.decommissioning` | `Removing` |
| `possibleReplacementBanner.decommissionFailed` | `Failed to remove the old device` |
| `possibleReplacementBanner.decommissionOldDevice` | `Remove old device` |
| `possibleReplacementBanner.decommissionSucceeded` | `Old device removed` |
| `possibleReplacementBanner.oldDeviceDecommissioned` | `Old device removed — nothing left to review.` |
| `possibleReplacementBanner.message` | `This device may replace {{hostname}} — review and remove the old row.` |
| `fleetPosture.subtitle` | `Which endpoints still run competing management tooling — and whether it is safe to remove it there.` |
| `common.json` → `longTail.fleet.FixPicker.skipReasons.decommissioned` | `Device is removed` |

New keys to add: `deviceActions.restore` = `Restore`, `deviceActions.permanentlyDelete` = `Delete permanently`, `deviceCard.permanentlyDelete` = `Delete permanently`, `deviceList.permanentlyDelete` = `Delete permanently`, `decommissionedHiddenHint.label` = `{{count}} removed hidden`, `decommissionedHiddenHint.show` = `show`.

**Do not touch `apps/web/src/locales/en/admin.json`** (the mTLS quarantine deny flow, keys 33-35). It is a different flow with its own overstated-copy problem; fixing it here would widen this PR's blast radius into admin. File it separately.

- [ ] **Step 2: Localize the hard-coded strings**

These are the strings a locale-only rename silently misses:

| File:line | Today | Change to |
|---|---|---|
| `DecommissionedHiddenHint.tsx:23,31` | JSX text `{count} decommissioned hidden` / `show` | `t('decommissionedHiddenHint.label', { count })` / `t('decommissionedHiddenHint.show')` — component must gain `useTranslation('devices')` |
| `DeviceDetails.tsx:149` | `statusLabels.decommissioned = "Decommissioned"` | `"Removed"` (this map is hard-coded English; converting it to `t()` is out of scope — just fix the word) |
| `DeviceDetailPage.tsx:368` | `` `Decommissioning "${device.hostname}"...` `` | `` `Removing "${device.hostname}"...` `` |
| `DeviceDetailPage.tsx:385` | `` `${device.hostname} has been decommissioned` `` | `` `${device.hostname} has been removed` `` |
| `DeviceDetailPage.tsx:394` | `` `Failed to decommission ${device.hostname}` `` | `` `Failed to remove ${device.hostname}` `` |
| `services/deviceActions.ts:392` | `'Failed to decommission device'` | `'Failed to remove device'` |
| `services/deviceActions.ts:61,323` | reason word `'decommissioned'` in `summarizeBulk*` | `'removed'` — this is user-visible text (`"1 decommissioned"`), asserted at `deviceActions.test.ts:464` |

- [ ] **Step 3: Update the 14 broken assertions**

Each is a literal-string expectation. Update the literal, do **not** loosen the matcher:
`DeviceList.test.tsx:944` (`'1 decommissioned hidden'` → `'1 removed hidden'`), `:1109`/`:1169`/`:1220` (`'Device is decommissioned'` → `'Device is removed'`); `DeviceCard.gating.test.tsx:86,176` (same tooltip); `DevicesPage.test.tsx:772` (`'2 decommissioned hidden'`), `:1057`/`:1380` (regex `are decommissioned` → `are removed`), `:1125` (`/all 2 selected device\(s\) are removed/i`); `PossibleReplacementBanner.test.tsx:107` (`'Decommission'` → `'Remove'`); `RunProgressPanel.test.tsx:171` and `FixPickerModal.test.tsx:421` (`toContain('decommissioned')` → `toContain('removed')`); `deviceActions.test.ts:464` (`/1 decommissioned/` → `/1 removed/`).

**Do not rename any `data-testid`.** `decommissioned-hidden-hint`, `decommissioned-hidden-show`, `possible-replacement-decommission`, `confirm-decommissioned-skip` all stay — 30+ assertions depend on them and nothing user-visible does.

- [ ] **Step 4: Run web tests + the i18n gates**

```bash
pnpm --filter @breeze/web exec vitest run src/components/devices/ src/components/fleet/ src/services/__tests__/deviceActions.test.ts src/lib/i18n/
```
Expected: all pass. `localeParity.test.ts` will **fail** until Task 3 adds the new keys to the other 7 locales — that is expected and is Task 3's gate.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/locales/en apps/web/src/components apps/web/src/services
git commit -m "feat(web): rename device Decommission to Remove (English + hard-coded strings)

UI labels only — the DB enum, API contract, query params, error codes and
every data-testid stay 'decommissioned'.

Refs #3987"
```

---

### Task 3: Locale parity for the 7 translated locales

`localeParity.test.ts:405` asserts every locale matches `en` key-for-key, so the 6 new keys must land in all 7 or CI is red. All 7 locales are at full parity today (verified) — do not let this PR be the one that breaks that.

**Files:** `apps/web/src/locales/{de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/{devices,common}.json`

- [ ] **Step 1: Note the terminology shift**

The existing translations render "decommission" as *retire / put out of service* — `Außer Betrieb nehmen` (de), `Retirar` (es), `Mettre hors service` (fr), `Dismetti` (it), `Descomissionar`/`Desativar` (pt), `Hizmetten Çıkarma` (tr). "Remove" is a **different, plainer word**, and leaving these untouched leaves the product saying "decommission" in 7 languages while English says "Remove".

Translate to the plain-remove equivalent: `Entfernen` (de-DE), `Quitar` (es-419), `Retirer` (fr-CA/fr-FR), `Rimuovi` (it-IT), `Remover` (pt-BR), `Kaldır` (tr-TR). Status label "Removed": `Entfernt`, `Quitado`, `Retiré`, `Rimosso`, `Removido`, `Kaldırıldı`.

- [ ] **Step 2: Apply the same value edits + 6 new keys to each locale**

Mirror the Task-2 table. Preserve every interpolation variable exactly — `localeParity.test.ts:413` asserts `{{hostname}}`, `{{skipped}}`, `{{total}}`, `{{eligible}}`, `{{count}}` survive translation.

- [ ] **Step 3: Run the i18n gates**

```bash
pnpm --filter @breeze/web exec vitest run src/lib/i18n/
```
Expected: PASS — `localeParity` (keys + interpolation), `keyUsage`, `translationCoverage`, `terminologyQuality`.

`translationCoverage.test.ts:417,432` baselines exact-English duplicates per namespace. Do **not** leave an English word as a translation (e.g. `"Remove"` in pt-BR) — that adds a duplicate and reddens the baseline.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/locales
git commit -m "i18n(web): translate device Remove terminology across all 7 locales

Refs #3987"
```

---

### Task 4: The filter builder's derived label

`ValueInput.formatEnumValue()` Title-Cases the raw enum value at runtime, so the advanced filter builder renders "Decommissioned" with no literal to grep. `FilterPreview.StatusBadge` does the same via a `capitalize` class.

**Files:** `apps/web/src/components/filters/ValueInput.tsx:341`, `apps/web/src/components/filters/FilterPreview.tsx:128,158`

- [ ] **Step 1: Write the failing test**

```tsx
it('labels the decommissioned status enum as Removed in the filter builder', () => {
  render(<ValueInput field={statusField} value="" onChange={vi.fn()} />);
  expect(screen.getByRole('option', { name: 'Removed' })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'Decommissioned' })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Add an explicit label override**

Add a small map consulted by `formatEnumValue` before the Title-Case fallback — `{ decommissioned: 'Removed' }`. Keep the raw value `'decommissioned'` as the option's `value`; only the display label changes. Do the same for `FilterPreview`'s badge.

While here, note `FilterPreview.tsx:128` colours the status dot `bg-red-500` while every other surface uses muted grey (`DeviceList.tsx:321`, `DeviceCard.tsx:40`, `DeviceCompare.tsx:74`, `DeviceDetails.tsx:139`). Align it to muted — a removed device is not an error state.

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @breeze/web exec vitest run src/components/filters/
git add apps/web/src/components/filters && git commit -m "fix(web): label the removed device status consistently in the filter builder

Refs #3987"
```

**Out of scope, flag separately:** `apps/web/src/components/devices/DeviceFilters.tsx` is dead code — only the barrel at `components/devices/index.ts:6` references it, nothing imports it. Do not spend effort renaming labels in a component nothing renders; open a cleanup issue instead.

# PR2 — API: durable queued uninstall on Remove

Branch: `feat/3986-device-uninstall-drain` (off `main`, **not** stacked on PR1 — a PR based on a sibling branch runs no CI at all). `Closes #3986`.

> **REVISED after an independent architecture review (2026-08-24).** The first draft of this section defined the drain as `status='decommissioned' AND EXISTS(pending self_uninstall)` and claimed that cleanly separated our rows from abuse-suspension rows. **That claim was false.** `routes/admin/abuse.ts:130-135` selects every device under the partner with **no status filter**, so an abuse suspension queues `self_uninstall` onto already-decommissioned devices too. A source-blind predicate would have exempted those rows from expiry and, on un-suspension inside the window, delivered them to a reinstated fleet — exactly the hazard `staleCommandReaper.ts:191-199` exists to prevent. **Uninstall provenance is therefore mandatory and fail-closed.** Three further corrections from the same review are folded in below (handler-level narrowing, watchdog exclusion, and the purge-block removal moving out of this PR).

Behaviour-neutral until PR3 ships: `uninstallAgent` defaults to `false`.

---

### Task 5: Migration — uninstall provenance on `device_commands`

Provenance cannot live in `payload`: it is the input to a security predicate, and putting it in an open jsonb container that terminalizers rewrite is exactly the kind of load-bearing-value-in-a-soft-field that this codebase has been bitten by before.

`device_commands` is the cheapest possible place for a column, and this is worth stating explicitly because CLAUDE.md's registration contracts are what usually make a column expensive:

- It has **no `org_id`** (`db/schema/devices.ts:455-467`) → not in `CORE_ORG_CASCADE_DELETE_ORDER` → **no `CORE_TENANT_EXPORT_POLICY` entry required.** (A column on `devices` *would* require one — that contract fires on `ADD COLUMN`, not just new tables.)
- It has **no RLS** (intentionally system-scoped per CLAUDE.md; zero policies in any migration) → **no policy to add.**
- It is **already** in `CORE_DEVICE_CASCADE_DELETE_TABLES` (`routes/devices/core.ts:224`) and already pre-cleared by `tenantCascade.ts:413` → **no cascade registration change.**

**Files:**
- Create: `apps/api/migrations/2026-08-24-device-command-uninstall-provenance.sql`
- Modify: `apps/api/src/db/schema/devices.ts:455-467`

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE device_commands
  ADD COLUMN IF NOT EXISTS uninstall_reasons text[],
  ADD COLUMN IF NOT EXISTS device_remove_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_device_commands_device_remove_drain
  ON device_commands (device_id)
  WHERE type = 'self_uninstall'
    AND status IN ('pending', 'sent')
    AND uninstall_reasons @> ARRAY['device_remove']::text[];
```

Naming rules that apply here: plain `YYYY-MM-DD-<slug>.sql` on today's date (which already sorts last — that is the property we want). **Do not** use a `-g-`/`-h-` infix on `2026-08-06`; that date block is closed. Idempotent (`IF NOT EXISTS`). **No inner `BEGIN;`/`COMMIT;`** — `autoMigrate` wraps each file in a transaction.

**Do not backfill.** Existing rows keep `uninstall_reasons = NULL`, which the predicate treats as "no exemption, no widened auth" — fail-closed by construction. A backfill that stamped `device_remove` onto historic rows would arm the exact incident this design prevents.

- [ ] **Step 2: Mirror it in the Drizzle schema, then check drift**

```ts
uninstallReasons: text('uninstall_reasons').array(),
deviceRemoveExpiresAt: timestamp('device_remove_expires_at', { withTimezone: true }),
```

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
```
Note `db:check-drift` compares the Drizzle model to the migrations, **not** to the live DB — a wrong model can still pass. The integration test in Task 12 is what actually proves the column behaves.

- [ ] **Step 3: Commit**

```bash
git add apps/api/migrations/2026-08-24-device-command-uninstall-provenance.sql apps/api/src/db/schema/devices.ts
git commit -m "feat(api): uninstall provenance columns on device_commands

Refs #3986"
```

---

### Task 6: The drain service (reason-scoped)

**Files:**
- Create: `apps/api/src/services/deviceUninstallDrain.ts`, `apps/api/src/services/deviceUninstallDrain.test.ts`

**Interfaces (consumed by Tasks 7-10):**
```ts
export const UNINSTALL_REASON_DEVICE_REMOVE = 'device_remove' as const;
export const DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS: number; // envInt(..., 72), min 1

export async function isDeviceUninstallDraining(deviceId: string): Promise<boolean>;
export async function queueDeviceUninstall(tx, deviceId: string, actorUserId: string | null): Promise<{ queued: boolean; mergedIntoExisting: boolean }>;
export async function releaseDeviceRemoveReason(deviceId: string, reason: string): Promise<{ cancelled: number; retainedOtherOwner: number; alreadyDispatched: number }>;
```

**The predicate — every consumer uses this one definition:**

```
draining(device) :=
      device.status = 'decommissioned'
  AND EXISTS (SELECT 1 FROM device_commands
              WHERE device_id = device.id
                AND type = 'self_uninstall'
                AND status IN ('pending','sent')
                AND uninstall_reasons @> ARRAY['device_remove']
                AND device_remove_expires_at > now())
```

Three clauses beyond the first draft, each load-bearing: the **reason** keeps abuse-suspension and tenant-offboarding rows out; the **deadline** closes the drain without a sweeper; `status='decommissioned'` keeps a live device out.

- [ ] **Step 1: Write the failing tests**

```ts
it('queues one pending self_uninstall stamped device_remove with a deadline', ...);
it('MERGES into an existing tenant-offboarding uninstall instead of inserting a second row', ...);
it('is NOT draining for an abuse-queued uninstall (no device_remove reason)', ...);   // the incident guard
it('is NOT draining once device_remove_expires_at has passed', ...);
it('releases only its own reason, leaving a tenant-owned uninstall live', ...);
it('reports alreadyDispatched for a row already in sent', ...);
```

- [ ] **Step 2: Implement**

Multi-valued reasons, not a single `origin`: a device can be removed while its tenant is *also* offboarding, and one command row then has two lifecycle owners. Each canceller removes only its own reason and cancels the row only when **no destructive reason remains**:

```ts
// release: strip our reason; cancel only if nothing else owns it
uninstall_reasons = array_remove(uninstall_reasons, 'device_remove')
// then, only where cardinality(uninstall_reasons) = 0 AND status = 'pending':
//   status='cancelled', completed_at=now(), result={reason}, ...terminalPayloadErasureSet()
```

`queueDeviceUninstall` must `SELECT ... FROM devices WHERE id = $1 FOR UPDATE` inside the same transaction before it reads-then-writes — mirroring `tenantOffboarding.ts:172-176`. Without the row lock, two concurrent Removes both see "no existing row" and insert duplicates. A unique index was deliberately rejected upstream (`tenantOffboarding.ts:153-163`) because it would break the abuse bulk insert; the lock is the sanctioned pattern.

Other constraints: take `actorUserId` as an explicit parameter (never reach into `auth` inside a service — `queueCommand:492` passes `createdBy` through unguarded, which is #3978's failure mode); do **not** use `queueCommandForExecution` (`commandQueue.ts:673` hard-fails on `status !== 'online'`); include `...terminalPayloadErasureSet()` in every terminal write.

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter=@breeze/api test --run src/services/deviceUninstallDrain.test.ts
git commit -am "feat(api): reason-scoped device uninstall drain service

Refs #3986"
```

---

### Task 7: `DELETE /devices/:id` accepts `uninstallAgent`

**Files:** `apps/api/src/routes/devices/core.ts:1408-1489`, `apps/api/src/routes/devices/schemas.ts`, test `core.decommission.test.ts`

- [ ] **Step 1: Extend the test rig FIRST**

`core.decommission.test.ts` stubs `db.insert` as a bare `vi.fn()` with no chain. The first `db.insert(...).values(...)` throws `Cannot read properties of undefined` and takes every test in the file with it. Extend `rigDecommission()` before writing new tests.

`expect(set).toHaveBeenCalledTimes(2)` counts the status flip + the replacement-linkage clear. This task adds an insert, not an update, so 2 still holds — but if you add a third `db.update()`, fix it by asserting the specific `set` payloads, not by bumping the number.

- [ ] **Step 2: Write the failing tests**

```ts
it('defaults to NOT queueing an uninstall', ...);          // no body at all
it('defaults to NOT queueing when the body omits the field', ...);
it('queues a device_remove-stamped uninstall when uninstallAgent is true', ...);
it('audits uninstallQueued either way', ...);
```

- [ ] **Step 3: Implement**

`uninstallAgent: z.boolean().optional().default(false)` on an **optional** body (the route takes none today; existing callers must keep working). Queue inside the **same transaction** as the status write — the route already runs in an org-scoped request transaction (`middleware/auth.ts:712`), and `device_commands` has no RLS, so no system context is needed. Do **not** wrap in `runOutsideDbContext`: that would let the command commit while the decommission rolls back.

Set `device_remove_expires_at = now() + DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS`. Return `uninstallQueued` in the body and the audit `details`.

Keep `disconnectAgent(...)` unchanged — the agent must lose its WS channel and fall back to REST heartbeat, which is the delivery path.

- [ ] **Step 4: Run + commit**

```bash
pnpm --filter=@breeze/api test --run src/routes/devices/
git commit -am "feat(api): DELETE /devices/:id accepts uninstallAgent

Defaults false; behaviour unchanged until the UI opts in.

Refs #3986"
```

---

### Task 8: Restore releases the device-remove reason

**Files:** `apps/api/src/routes/devices/core.ts:1494-1535`, tests in `core.decommission.test.ts` — note **restore has no behavioural test anywhere in the API today**, only the 403 matrix at `core.permissions.test.ts:363`.

- [ ] **Step 1: Write the failing tests**

```ts
it('cancels a pending device_remove uninstall on restore', ...);
it('leaves a tenant-offboarding uninstall live, stripping only device_remove', ...);
it('reports uninstallAlreadyDispatched when the row is already sent', ...);
```

- [ ] **Step 2: Implement — and understand the race you are NOT closing**

Call `releaseDeviceRemoveReason(deviceId, 'device_restored')`.

`claimPendingCommandsForDevice` commits `pending → sent` **before** the HTTP response is built (`commandDispatch.ts:93-104`), and `handlers_uninstall.go:52-75` hands teardown to a **detached helper** and acks immediately. So once a row is `sent`, cancelling it cannot recall the uninstall — there is no safe claimed-state transition today.

**Decision (owner call — see the note below):** restore still **succeeds**, cancels only `pending`, and returns `uninstallAlreadyDispatched: true` when a `sent` row exists, so the UI can say plainly that the machine may already have uninstalled and needs a reinstall. Restore is a user-facing recovery action and must not be wedged for up to the drain window by a race that lasts seconds.

The genuine fix is an agent-side pre-teardown fence (agent calls a `begin` endpoint that CASes `sent → executing`; restore and begin serialize). That requires a Go agent change, which this plan's Global Constraints exclude. **File it as a follow-up issue and link it from here** — do not silently drop it.

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter=@breeze/api test --run src/routes/devices/core.decommission.test.ts
git commit -am "fix(api): restoring a device releases its pending uninstall

Refs #3986"
```

---

### Task 9: Narrow the agent surface — route, role, handler, and result

**This is the highest-risk task in the plan. Read all of it before editing.** The first draft narrowed only the route allowlist and the command-type allowlist; an independent review found that insufficient. All four layers below are required.

**Files:** `apps/api/src/middleware/agentAuth.ts`, `apps/api/src/routes/agents/heartbeat.ts`, `apps/api/src/routes/agents/commands.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('still 403s a removed device with NO device_remove drain', ...);            // unchanged for uninstallAgent:false
it('still 403s a removed device whose drain deadline has passed', ...);
it('still 403s a removed device carrying only an abuse-queued uninstall', ...); // the incident guard
it('admits a draining removed device on heartbeat', ...);
it('refuses a draining removed device on recovery-keys, inventory, elevation, and an extension agent path', ...);
it('refuses a WATCHDOG credential on a draining removed device', ...);
it('returns only self_uninstall — no config, upgrades, trust keys or rotation — in a drain heartbeat', ...);
it('rejects a non-UUID command result while draining', ...);
it('rejects a result for a non-self_uninstall command while draining', ...);
```

- [ ] **Step 2: Layer 1 — auth gate (`agentAuth.ts:419`)**

```ts
const deviceDraining =
  device.status === 'decommissioned' && (await isDeviceUninstallDraining(device.id));
if (device.status === 'decommissioned' && !deviceDraining) {
  throw new HTTPException(403, { message: 'Device has been decommissioned' });
}
```
Leave the `quarantined` throw at `:423` alone. **Only a device with an unexpired `device_remove` drain is admitted** — a plain removed device keeps today's 403, so `uninstallAgent:false` gains no surface whatsoever.

**Admit only the main-agent credential.** The middleware also accepts watchdog credentials, and the watchdog heartbeat branch (`heartbeat.ts:298`) writes without the terminal-status guard. Gate on `role === 'agent'`; a watchdog on a draining device gets the 403.

Note `lastSeenIp` is written at `agentAuth.ts:489`, *before* the drain routing at `:589`. A draining device will therefore update `last_seen_ip`. Decide explicitly and comment it — either accept it (it is genuinely the last IP we saw) or move the write behind the gate.

- [ ] **Step 3: Layer 2 — route allowlist (`agentAuth.ts:595`)**

Predicate becomes `(tenantState === 'draining' || deviceDraining) && !isDrainAllowedAgentPath(c)`. This is what keeps inventory, `PUT /:id/security/recovery-keys` (BitLocker/FileVault ingest), `POST /:id/elevation-requests` (PAM), and every extension's `<prefix>/agent/:id/*` namespace (`extensions/gateway.ts:60-65`) refused.

- [ ] **Step 4: Layer 3 — one derived claim allowlist (`agentAuth.ts:637`)**

```ts
claimTypeAllowlist: (tenantState === 'draining' || deviceDraining)
  ? (['self_uninstall'] as const) : undefined,
```
Replace the three local `agent.tenantDraining ? [...] : undefined` ternaries (`heartbeat.ts:378`, `:853`, `commands.ts:188`) with this one value. `claimPendingCommandsForDevice`'s `typeAllowlist` defaults to **unrestricted** (`commandDispatch.ts:61-68`), so a future claim site that forgets the ternary silently gets everything.

- [ ] **Step 5: Layer 4 — handler-level narrowing (the layer the first draft missed)**

Being on the route allowlist is not the same as being harmless. A drain heartbeat currently still runs metrics insertion (`heartbeat.ts:717`), IP-history updates (`:759`), **threshold-scan command creation** (`:777`), and OneDrive state writes (`:803`) — and its response still carries config changes, upgrade targets, helper upgrades, manifest trust keys, and token-rotation signals (`:1127`, `:1338`), all of which the Go agent acts on (`heartbeat.go:4284`).

Add an **early minimal drain branch** in the heartbeat handler: claim and return `self_uninstall` and nothing else — no metrics, no config/policy, no upgrade targets, no trust keys, no rotation signalling. Return before the normal processing path.

In the result route (`commands.ts:205-265`), while draining: reject every **non-UUID** commandId (the `sw-install-…` branch at `:216-242` writes `applySoftwareInstallResult` with no `device_commands` row and is gated only on the device id matching), and reject any command whose `type !== 'self_uninstall'`.

- [ ] **Step 6: Do NOT touch these**

- **`agentWs.ts:749`** — the independent `decommissioned` refusal that keeps the WS control channel shut. `agentWs.ts:786-793` explains why WS can never be narrowed by command type: ~20 call sites push commands over the socket with no `device_commands` row, so `typeAllowlist` cannot see them.
- **`mtls.ts:642,680`** (`renew-cert`) — a separate `agentBearerAuthMiddleware` that deliberately admits drain mode so an agent quarantined mid-drain can still collect its uninstall (`tenantStatus.ts:259-266`). Confirm, do not widen.
- **`heartbeat.ts:615-631`** — the terminal-status write guard. It now runs on every beat of a draining device (0 rows matched, audit skipped, `lastSeenAt` not bumped, so the device correctly stays "Removed" in the UI). Verify the command claim is **not** gated on `updatedRows` — it is not today (`heartbeat.ts:849`) — and add a comment, because a refactor that moved the claim inside the guard would silently break delivery.

- [ ] **Step 7: Fix the now-stale reasoning in `offlineDetector.ts:695-707`**

Its status exclusion stays **correct** and must not be removed, but its justification ("it can never heartbeat again … agentAuthMiddleware 403s decommissioned devices") becomes false. Update the comment; leave the predicate.

- [ ] **Step 8: Run + commit**

```bash
pnpm --filter=@breeze/api test --run src/middleware/ src/routes/agents/
git commit -am "feat(api): narrow a draining removed device to self_uninstall delivery only

Refs #3986"
```

---

### Task 10: Drain window in the stale-command reaper

**Files:** `apps/api/src/jobs/staleCommandReaper.ts:190-211`

- [ ] **Step 1: Write the failing tests**

```ts
it('does not reap a device_remove uninstall inside its deadline', ...);
it('reaps it once device_remove_expires_at has passed', ...);
it('STILL reaps an abuse-queued uninstall on a decommissioned device at 30 minutes', ...);
```

That third test is the regression guard for the incident this whole provenance scheme exists to prevent. It must fail if someone later relaxes the reason clause.

- [ ] **Step 2: Implement — a second arm, do not widen the first**

```sql
OR (
  ${deviceCommands.type} = 'self_uninstall'
  AND ${deviceCommands.uninstallReasons} @> ARRAY['device_remove']::text[]
  AND ${deviceCommands.deviceRemoveExpiresAt} > now()
)
```

Two traps: **do not copy the existing arm's `JOIN partners`** (it is an INNER join, so an org with `partner_id IS NULL` drops out of the EXISTS and is not exempt today); and the exemption keys on the **reason plus an unexpired deadline**, never on `devices.status` alone — abuse suspension queues uninstalls onto already-decommissioned devices (`abuse.ts:130-135`, no status filter), so a status-only predicate would exempt them.

When the deadline passes, the row is reaped to `failed`/timeout, the device stops satisfying the predicate, and auth reverts to 403. The drain closes itself; **no new sweeper job.**

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter=@breeze/api test --run src/jobs/staleCommandReaper.test.ts
git commit -am "feat(api): hold a device_remove uninstall for its drain window

Refs #3986"
```

---

### Task 11: Teach tenant offboarding about shared ownership

`tenantOffboarding` currently dedupes against **any** pending/sent uninstall regardless of origin (`:200-211`) and cancels **every** pending/sent uninstall on abort (`:291-322`). With two reason-owners possible on one row, that is now wrong in both directions: a tenant abort would cancel a uninstall the user explicitly asked for via Remove, and a tenant drain would count a device-remove row as its own.

**Files:** `apps/api/src/services/tenantOffboarding.ts:164-229`, `:291-322`, `:380-394`

- [ ] **Step 1:** Stamp `uninstall_reasons = ARRAY['tenant_offboarding']` on rows it inserts; when a row already exists, **append** its reason rather than skipping.
- [ ] **Step 2:** On abort, `array_remove(uninstall_reasons,'tenant_offboarding')` and cancel only when no reason remains.
- [ ] **Step 3:** `countOutstandingUninstalls` counts only rows carrying its own reason.
- [ ] **Step 4:** Run the offboarding integration suites, which are the ones most likely to catch a mistake here:

```bash
pnpm --filter @breeze/api test:integration -- src/__tests__/integration/offboardingDrainSuspendedEntry.integration.test.ts src/__tests__/integration/offboardingEntryDeadlock.integration.test.ts
```

- [ ] **Step 5: Commit**

```bash
git commit -am "refactor(api): tenant offboarding owns only its own uninstall reason

Refs #3986"
```

---

### Task 12: Integration tests — delivery, isolation, and the incident guard

Unit tests mock Drizzle; none of them prove a queued uninstall survives and is claimable. Place these in `src/__tests__/integration/` **exactly** — a file outside that directory runs in zero CI jobs, and a `runIf` guard skips silently.

**Files:** Create `apps/api/src/__tests__/integration/deviceUninstallDrain.integration.test.ts`

- [ ] **Step 1: Write the tests**

1. **Delivery.** Seed partner→org→device; `DELETE /devices/:id` with `uninstallAgent:true`; assert a `pending` row stamped `device_remove` with a deadline; assert auth admits `/heartbeat` and refuses `PUT /:id/security/recovery-keys`; claim via heartbeat and assert the response carries `self_uninstall` **and nothing else** (queue a `run_script` first and assert it is not delivered, and assert no config/upgrade/trust-key payload); ack `completed`; assert the next heartbeat 403s.
2. **Restore.** Queue, then `POST /devices/:id/restore`; assert the row is cancelled and the device 403s again.
3. **THE INCIDENT GUARD.** Suspend a partner (queues fleet uninstalls, including onto an already-decommissioned device) → age past the 30-minute timeout → run the reaper → un-suspend → agent heartbeat. **Assert zero commands claimed.** This is the test that fails if provenance is ever loosened.
4. **Overlap.** Device removed while its tenant is offboarding: one row, two reasons; restore strips one; the tenant drain still counts and delivers it.

- [ ] **Step 2: Run and CONFIRM IT RAN** (read the passed count, do not trust a green exit)

```bash
pnpm --filter @breeze/api test:docker:up
pnpm --filter @breeze/api test:integration -- src/__tests__/integration/deviceUninstallDrain.integration.test.ts
pnpm --filter @breeze/api test:docker:down
```

- [ ] **Step 3: Commit**

```bash
git commit -am "test(api): prove uninstall delivery, isolation, and abuse-reversal safety

Closes #3986"
```

---

### Task 13 (separate cleanup PR, AFTER PR3 is deployed): remove the purge WS block

**Do not do this in PR2.** Deleting `core.ts:1559-1571` while the UI still cannot request an uninstall would leave a window in which Remove never uninstalls *and* purge no longer uninstalls either — no single-device uninstall path at all. Ship it as a fourth, trivial PR once PR3 is live.

- [ ] Delete the `isAgentConnected` / `sendCommandToAgent` block and its now-unused imports; keep or drop `uninstallCommandSent` in the audit details, and say which in the commit message.

# PR3 — Web: the Remove dialog

Branch: `feat/3987-remove-dialog` (off `main`, after PR1 and PR2 have merged). `Closes #3987`.

**Do not open this PR until PR2 is deployed.** Sending `uninstallAgent: true` to an API that ignores it produces a dialog that promises an uninstall and silently does nothing — worse than the bug we started with.

---

### Task 14: `RemoveDeviceDialog`

`ConfirmDialog` (`apps/web/src/components/shared/ConfirmDialog.tsx`) already accepts `children: ReactNode` rendered under the message, so **no new modal primitive is required**. It owns no state for children — the radio value lives in the caller.

**Files:**
- Create: `apps/web/src/components/devices/RemoveDeviceDialog.tsx`
- Create: `apps/web/src/components/devices/RemoveDeviceDialog.test.tsx`

**Interfaces:**
- Produces:
```ts
export type RemoveAgentChoice = 'uninstall' | 'leave';
export function RemoveDeviceDialog(props: {
  open: boolean;
  device: Pick<Device, 'hostname' | 'status' | 'lastSeenAt'>;
  value: RemoveAgentChoice;
  onChange: (v: RemoveAgentChoice) => void;
  onClose: () => void;
  onConfirm: () => void;
  isLoading?: boolean;
}): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

```tsx
it('defaults to uninstall', () => {
  render(<RemoveDeviceDialog {...base} />);
  expect(screen.getByTestId('remove-agent-uninstall')).toBeChecked();
  expect(screen.getByTestId('remove-agent-leave')).not.toBeChecked();
});

it('says the uninstall runs now when the device is online', () => {
  render(<RemoveDeviceDialog {...base} device={{ ...dev, status: 'online' }} />);
  expect(screen.getByTestId('remove-agent-uninstall-hint')).toHaveTextContent(/runs now/i);
});

it('says the uninstall is queued when the device is offline', () => {
  render(<RemoveDeviceDialog {...base} device={{ ...dev, status: 'offline' }} />);
  expect(screen.getByTestId('remove-agent-uninstall-hint')).toHaveTextContent(/next time it checks in/i);
});
```

- [ ] **Step 2: Implement**

```tsx
<ConfirmDialog
  open={open} onClose={onClose} onConfirm={onConfirm}
  title={t('deviceActions.confirm.remove.title')}
  message={t('deviceActions.confirm.remove.message', { hostname: device.hostname })}
  confirmLabel={t('deviceActions.confirm.remove.confirm')}
  variant="destructive" isLoading={isLoading}
  confirmTestId="confirm-remove-device"
>
  <fieldset className="mt-4 space-y-3">
    <legend className="sr-only">{t('deviceActions.confirm.remove.agentLegend')}</legend>
    {/* radio 'uninstall' (default) + hint, radio 'leave' + hint */}
  </fieldset>
</ConfirmDialog>
```

Copy (add these keys to all 8 locales):
- title: `Remove {{hostname}}?`
- message: `It'll be taken out of your active fleet and stop being monitored. History is kept and you can restore it later.`
- option `uninstall`: **`Uninstall the Breeze agent from this machine`**; hint when online → `Runs now.`; hint when not online → `Queued — runs the next time this machine checks in. Cancelled after {{hours}} days if it never does.`
- option `leave`: **`Leave the agent installed`**; hint → `The machine keeps running the agent and can't be managed from Breeze.`

The hint must be state-aware — a dialog that says "runs now" for a machine that has been offline for three weeks is the same class of dishonesty as the copy this whole change is fixing.

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @breeze/web exec vitest run src/components/devices/RemoveDeviceDialog.test.tsx
git add apps/web/src/components/devices/RemoveDeviceDialog* apps/web/src/locales
git commit -m "feat(web): Remove dialog with an agent-uninstall choice

Refs #3987"
```

---

### Task 14b (rider, carried from PR1's final review): fix the shared skip-dialog copy

PR1 routed the bulk `decommission` action through the existing `confirmDecommissionedSkip` dialog so a bulk Remove no longer fires `DELETE`s at already-removed devices. That dialog's copy is shared with the agent-command bulk actions and ends with *"Any that are offline will run this when they next check in."* — true for a queued command, **false for a Remove**, which applies immediately.

The dialog's behaviour is correct; only the trailing clause is wrong, and fixing it needs a new key across all 8 locale dirs — which is why it was parked out of PR1 rather than bolted onto its fix wave.

- [ ] Split the message so the bulk-Remove path gets its own key without the check-in clause; leave the command path's copy unchanged.
- [ ] Add the new key to all 8 locale dirs, translated (never the bare English word in a non-English locale).
- [ ] `pnpm --filter @breeze/web exec vitest run src/lib/i18n/ src/components/devices/`

---

### Task 15: Wire the dialog through the dispatchers

**Files:** `apps/web/src/services/deviceActions.ts:386`, `apps/web/src/components/devices/DevicesPage.tsx:796`, `apps/web/src/components/devices/DeviceDetailPage.tsx:363`

- [ ] **Step 1: Extend the service function**

```ts
export async function decommissionDevice(
  deviceId: string,
  opts: { uninstallAgent: boolean },
): Promise<{ success: boolean; uninstallQueued?: boolean }> {
  const response = await fetchWithAuth(`/devices/${deviceId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uninstallAgent: opts.uninstallAgent }),
  });
  ...
}
```

`services/deviceActions.ts` is whole-file allowlisted in `runActionAllowlist.ts`, so the `no-silent-mutations` guard needs no work — **keep the mutation in this file** rather than inlining a `fetchWithAuth` into a component. If you do move it into a component under `TARGET_GLOBS`, you must wrap it in `runAction` and bump the `expect(absoluteFiles.length).toBe(91)` assertion in `no-silent-mutations.test.ts`.

Make `opts` **required**, not optional-with-a-default. A caller that forgets it should fail to compile, not silently pick a behaviour.

- [ ] **Step 2: Hold the radio state in the dispatchers**

Both `DevicesPage` and `DeviceDetailPage` currently open a `ConfirmDialog` for `decommission`. Replace with `RemoveDeviceDialog`, hold `RemoveAgentChoice` in component state (default `'uninstall'`), and pass `{ uninstallAgent: choice === 'uninstall' }`. Reset to `'uninstall'` each time the dialog opens — a sticky choice from a previous device is a footgun.

- [ ] **Step 3: Bulk path — ask once for the whole selection**

`bulkDecommissionDevices` (`deviceActions.ts:473`) loops `decommissionDevice`. Thread one `uninstallAgent` through the loop; the bulk bar shows the same two options once. Mixed online/offline selections should show the queued wording.

- [ ] **Step 4: Run the affected suites**

```bash
pnpm --filter @breeze/web exec vitest run src/components/devices/ src/services/__tests__/deviceActions.test.ts src/lib/__tests__/no-silent-mutations.test.ts
```

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(web): send uninstallAgent from the Remove dialog

Closes #3987"
```

---

### Task 16: E2E coverage (greenfield)

Decommission/restore/permanent-delete has **zero** end-to-end coverage today — a grep for `decommission` across all of `e2e-tests/` returns nothing, and there is no devices page object.

**Files:** Create `e2e-tests/tests/device_remove.spec.ts`; extend `e2e-tests/pages/` with a minimal devices page object.

- [ ] **Step 1: Add the missing testids first**

Per `e2e-tests/README.md`, specs query by `data-testid` only. These do not exist yet and must be added in `DeviceList.tsx` / `DeviceCard.tsx`: the bulk Remove button (`DeviceList.tsx:2151` has none today — its siblings at `:2123/:2133/:2143` do) and the row/card Remove, Restore, and Delete-permanently menu items. Adding testids is additive and breaks nothing.

- [ ] **Step 2: Write the spec**

Cover: remove with "leave installed" → device disappears from the default list, appears under the Removed filter, offers Restore and Delete permanently; restore → returns to the active list. Assert the dialog defaults to Uninstall.

- [ ] **Step 3: Run + commit**

```bash
cd e2e-tests && pnpm test device_remove.spec.ts
```

---

## Self-review

**Spec coverage.** #3986: provenance migration (T5) · durable queue (T6, T7) · surface narrowing across route/role/handler/result (T9) · drain window (T10) · restore releases its own reason (T8) · shared ownership with tenant offboarding (T11) · delivery, isolation and the abuse-reversal incident guard proven against real Postgres (T12) · WS best-effort block removed in a separate post-PR3 cleanup (T13). #3987: menu parity (T1) · Remove/Delete-permanently split (T1, T2) · two-option radio defaulting to uninstall with state-aware hints (T14, T15) · label sweep + locale parity (T2, T3) · filter-builder derived label (T4) · bulk path (T15) · E2E (T16).

**Deliberately not covered, and why.** `admin.json`'s mTLS quarantine copy (different flow — file separately, noted in T2). `DeviceFilters.tsx` (dead code — noted in T4). Pending-uninstall *state surfaced in the UI* — #3986 lists it, but it depends on an API read model that PR2 does not build; it should be its own follow-up rather than a half-built badge. Mobile needs no changes (no decommission UI; status coercion only).

**Type consistency.** `RemoveAgentChoice` (T14) → `{ uninstallAgent: boolean }` (T15) → `uninstallAgent` body field (T7). `isDeviceUninstallDraining` / `queueDeviceUninstall` / `releaseDeviceRemoveReason` (T6) are consumed by T7/T8/T9/T10 under exactly those names. Action strings stay `'decommission'` / `'restore'` / `'permanent-delete'` throughout — only labels change.

**Rollout.** PR1 → PR2 → deploy → PR3 → deploy → PR4 (T13 cleanup). PR2 is behaviour-neutral on its own (`uninstallAgent` defaults false) and its migration adds two nullable columns with no backfill, so it is safe to deploy ahead of the UI. The purge WS block stays until PR3 is live, or there would be a window with no single-device uninstall path at all. Every branch targets `main` directly; do not stack, or CI will not run at all.
