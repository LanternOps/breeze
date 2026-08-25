# Device "Remove" + Durable Agent Uninstall — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offboarding a device becomes one honest action — "Remove" — that asks whether to uninstall the Breeze agent and actually delivers that uninstall to offline machines, while "Delete permanently" becomes a separate data-purge action.

**Architecture:** A removed device's agent keeps a *narrowed* authenticated surface (REST heartbeat only, `self_uninstall`-only command claim, no WebSocket) for exactly as long as it has an undelivered uninstall queued. That drain state is **derived**, never stored — `status='decommissioned' AND EXISTS(pending/sent self_uninstall)` — so there is no new column, no migration, no new status value, no new sweeper job, and nothing that can drift. The existing `tenantDraining` mechanism is mirrored rather than reinvented.

**Tech Stack:** Hono + Drizzle + Postgres (API), Astro + React + i18next (web), Vitest, Playwright. Go agent is **not** modified.

Closes #3986 (API), #3987 (Web).

---

## Global Constraints

- **NEVER write a backfill migration.** Queuing `self_uninstall` for already-decommissioned devices would uninstall agents fleet-wide on deploy. The derived drain flag is false for every device in the field today and must stay that way. There is no migration in this plan at all.
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

Behaviour-neutral until PR3 ships: `uninstallAgent` defaults to `false`, so a Remove from today's UI behaves exactly as it does now.

---

### Task 5: The drain service (derived predicate + queue + cancel)

One module owns the predicate so it cannot drift between the auth middleware, the reaper, and the routes.

**Files:**
- Create: `apps/api/src/services/deviceUninstallDrain.ts`
- Create: `apps/api/src/services/deviceUninstallDrain.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 6-9):
  - `isDeviceUninstallDraining(deviceId: string): Promise<boolean>`
  - `queueDeviceUninstall(tx: DbOrTx, deviceId: string, actorUserId: string | null): Promise<{ queued: boolean }>`
  - `cancelDeviceUninstall(deviceId: string, reason: string): Promise<{ cancelledPending: number; alreadyDispatched: number }>`
  - `DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS: number`

- [ ] **Step 1: Write the failing tests**

```ts
describe('queueDeviceUninstall', () => {
  it('inserts one pending self_uninstall with removeConfig and targetRole agent', async () => { /* assert insert values */ });
  it('does not queue a second row when one is already pending or sent', async () => { /* dedupe */ });
});

describe('cancelDeviceUninstall', () => {
  it('cancels pending rows and reports how many were already dispatched', async () => {
    // a 'sent' row must NOT be counted as cancelled — the agent may already
    // have handed teardown to the detached helper and cannot be recalled.
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm --filter=@breeze/api test --run src/services/deviceUninstallDrain.test.ts
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
export const DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS = Math.max(
  1, envInt('DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS', 72),
);

const NON_TERMINAL = ['pending', 'sent'] as const;

/**
 * A removed device is "draining" for exactly as long as it has an
 * undelivered self_uninstall. Derived, never stored: when the command
 * terminalizes (agent ack, reaper timeout, or restore), the device stops
 * draining and agentAuth returns to a hard 403. Nothing to clean up.
 */
export async function isDeviceUninstallDraining(deviceId: string): Promise<boolean> {
  const [row] = await db.select({ one: sql`1` }).from(deviceCommands)
    .where(and(
      eq(deviceCommands.deviceId, deviceId),
      eq(deviceCommands.type, 'self_uninstall'),
      inArray(deviceCommands.status, [...NON_TERMINAL]),
    ))
    .limit(1);
  return Boolean(row);
}

export async function queueDeviceUninstall(tx, deviceId, actorUserId) {
  const existing = await tx.select({ id: deviceCommands.id }).from(deviceCommands)
    .where(and(
      eq(deviceCommands.deviceId, deviceId),
      eq(deviceCommands.type, 'self_uninstall'),
      inArray(deviceCommands.status, [...NON_TERMINAL]),
    )).limit(1);
  if (existing.length > 0) return { queued: false };

  await tx.insert(deviceCommands).values({
    deviceId,
    type: 'self_uninstall',
    payload: { removeConfig: true },
    status: 'pending',
    targetRole: 'agent',
    createdBy: actorUserId,
  });
  return { queued: true };
}
```

Notes the implementer must not skip:
- **Take an explicit `actorUserId`; do not reach into `auth` inside the service.** `queueCommand` (`services/commandQueue.ts:492`) passes `createdBy: userId || null` straight through with no guard, which is issue #3978's failure mode for synthetic agent auth. Our caller is behind `authMiddleware` + `requireMfa()` so `auth.user.id` is a real `users` row — but keeping the parameter explicit is what makes that reviewable.
- **Do not use `queueCommandForExecution`** (`commandQueue.ts:644`) — it hard-fails on `device.status !== 'online'` at `:673`, and we have just set the device to `decommissioned`.
- `cancelDeviceUninstall` must include `...terminalPayloadErasureSet()` (`services/sensitiveCommandPayload.ts:79`) in its `.set()`, matching every other terminalizer in the codebase.
- Mirror `tenantOffboarding.cancelDrainUninstallsForOrgIds` (`:291-322`) for the cancel shape, narrowed to one `deviceId`.

- [ ] **Step 4: Run + commit**

```bash
pnpm --filter=@breeze/api test --run src/services/deviceUninstallDrain.test.ts
git add apps/api/src/services/deviceUninstallDrain*.ts
git commit -m "feat(api): device uninstall drain service (derived state, no schema change)

Refs #3986"
```

---

### Task 6: `DELETE /devices/:id` accepts `uninstallAgent`

**Files:**
- Modify: `apps/api/src/routes/devices/core.ts:1408-1489`, `apps/api/src/routes/devices/schemas.ts`
- Test: `apps/api/src/routes/devices/core.decommission.test.ts`

- [ ] **Step 1: Extend the existing test rig FIRST**

`core.decommission.test.ts` mocks `db.insert` as a bare `vi.fn()` with no chain. The moment the handler calls `db.insert(...).values(...)`, every test in the file throws `Cannot read properties of undefined (reading 'values')`. Extend `rigDecommission()` to stub the insert chain before writing new tests, or the whole file goes red for the wrong reason.

Also note `expect(set).toHaveBeenCalledTimes(2)` (the status flip + the replacement-linkage clear). This task adds an **insert**, not an update, so the count stays 2 — but if you add any third `db.update()` this assertion breaks and the fix is to assert the specific `set` payloads, not to bump the number.

- [ ] **Step 2: Write the failing tests**

```ts
it('defaults to NOT queueing an uninstall', async () => {
  const res = await app.request(`/devices/${DEVICE_ID}`, { method: 'DELETE', headers: AUTH });
  expect(res.status).toBe(200);
  expect(insertValues).not.toHaveBeenCalled();
});

it('queues a durable self_uninstall when uninstallAgent is true', async () => {
  const res = await app.request(`/devices/${DEVICE_ID}`, {
    method: 'DELETE', headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ uninstallAgent: true }),
  });
  expect(res.status).toBe(200);
  expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
    deviceId: DEVICE_ID, type: 'self_uninstall',
    payload: { removeConfig: true }, status: 'pending', targetRole: 'agent',
  }));
  expect(await res.json()).toMatchObject({ uninstallQueued: true });
});

it('audits whether the uninstall was queued', async () => {
  // writeRouteAudit details must carry uninstallQueued so an operator can
  // answer "did we ask this machine to uninstall?" from the audit trail alone.
});
```

- [ ] **Step 3: Implement**

Add `uninstallAgent: z.boolean().optional().default(false)` to the DELETE body schema in `schemas.ts`. The route currently takes no body — accept an **optional** body so existing callers sending none still work.

Queue inside the **same transaction** as the status write, so a rolled-back decommission cannot leave an orphan uninstall. The route runs under `withDbAccessContext` (an org/partner-scoped request transaction — `middleware/auth.ts:712`); `device_commands` has **no RLS** (intentionally system-scoped per CLAUDE.md), so the insert passes without a system context. Do **not** wrap it in `runOutsideDbContext` — that would let the command commit while the decommission rolls back.

Return `uninstallQueued: boolean` in the response body and put it in the audit `details` alongside the existing `remoteSessionTeardown` / `agentWsDisconnect` keys.

Keep `disconnectAgent(...)` exactly as it is. The agent must lose its WS channel; it re-polls over REST heartbeat, which is the actual delivery path.

- [ ] **Step 4: Run + commit**

```bash
pnpm --filter=@breeze/api test --run src/routes/devices/
git commit -am "feat(api): DELETE /devices/:id accepts uninstallAgent and queues a durable uninstall

Defaults to false so behaviour is unchanged until the UI opts in.

Refs #3986"
```

---

### Task 7: Restore cancels the pending uninstall

Without this, restoring a removed device leaves a queued uninstall that fires on the next check-in and wipes a device the user just brought back.

**Files:** `apps/api/src/routes/devices/core.ts:1494-1535`, test in `core.decommission.test.ts` (add a `describe('POST /devices/:id/restore')` — **there is no behavioural test for restore anywhere in the API today**, only the 403 permission matrix at `core.permissions.test.ts:363`).

- [ ] **Step 1: Write the failing tests**

```ts
it('cancels a pending self_uninstall when the device is restored', async () => { /* ... */ });

it('reports when the uninstall was already dispatched and cannot be recalled', async () => {
  // a 'sent' row means the agent claimed it; handlers_uninstall.go hands
  // teardown to a DETACHED helper and acks immediately, so cancelling the
  // row cannot stop the uninstall. Restore must still succeed (otherwise an
  // agent that never acks wedges restore for the whole drain window) but
  // must tell the truth.
  expect(await res.json()).toMatchObject({ uninstallAlreadyDispatched: true });
});
```

- [ ] **Step 2: Implement**

Call `cancelDeviceUninstall(deviceId, 'device_restored')` in the restore handler. Cancel only `pending`; count `sent` separately and surface it as `uninstallAlreadyDispatched` in the response and the audit details. Do not block the restore on it.

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter=@breeze/api test --run src/routes/devices/core.decommission.test.ts
git commit -am "fix(api): restoring a device cancels its pending uninstall

Refs #3986"
```

---

### Task 8: Narrow agentAuth instead of hard-403 (both layers)

**This is the highest-risk task in the plan.** Read the whole task before editing.

**Files:** `apps/api/src/middleware/agentAuth.ts:419-421` and `:589-597`, `:626-638`

- [ ] **Step 1: Write the failing tests**

```ts
it('still 403s a removed device with no queued uninstall', async () => { /* unchanged behaviour */ });
it('admits a removed device that has a pending uninstall, on heartbeat only', async () => { /* 200 */ });
it('refuses a removed+draining device on a non-drain route', async () => {
  // recovery-keys, inventory, elevation-requests, and an extension agent path
  // must all still 403 — this is the security assertion, assert at least
  // recoveryKeys and one extension gateway path explicitly.
});
```

- [ ] **Step 2: Implement — narrow BOTH layers**

At `:419`, replace the unconditional throw:

```ts
const deviceDraining =
  device.status === 'decommissioned' && (await isDeviceUninstallDraining(device.id));
if (device.status === 'decommissioned' && !deviceDraining) {
  throw new HTTPException(403, { message: 'Device has been decommissioned' });
}
```

Leave the `quarantined` throw at `:423` alone.

At `:595`, the route allowlist predicate becomes `if ((tenantState === 'draining' || deviceDraining) && !isDrainAllowedAgentPath(c))`. **This is the layer that matters.** `DRAIN_ALLOWED_ACTIONS` (`:270`) already restricts to `{heartbeat, commands, logs, rotate-token}`; without this line a removed device keeps inventory push, `PUT /:id/security/recovery-keys` (BitLocker/FileVault ingest), `POST /:id/elevation-requests` (PAM), and every extension's `<prefix>/agent/:id/*` namespace (`extensions/gateway.ts:60-65`).

At `:637`, derive **one** value on the agent context rather than repeating a ternary at each claim site:

```ts
claimTypeAllowlist: (tenantState === 'draining' || deviceDraining)
  ? (['self_uninstall'] as const) : undefined,
```

`claimPendingCommandsForDevice`'s `typeAllowlist` defaults to *unrestricted* (`commandDispatch.ts:61-68`), so any future claim site that forgets the ternary silently gets full access. One derived value removes that trap.

- [ ] **Step 3: Do NOT touch these**

- `agentWs.ts:749` — the independent `decommissioned` refusal. It is what keeps the WS control channel shut. `agentWs.ts:786-793` explains why WS can never be narrowed by command type: ~20 call sites push commands over the socket with **no** `device_commands` row, so `typeAllowlist` cannot see them. REST-open/WS-shut is the whole security property.
- `mtls.ts:642,680` (`renew-cert`) — a separate `agentBearerAuthMiddleware`, deliberately admitting drain mode so an agent quarantined mid-drain can still collect its uninstall (`tenantStatus.ts:259-266`). Confirm it behaves for a removed device; do not widen it.
- `heartbeat.ts:615-631` — the terminal-status write guard. It now runs on **every** beat of a draining removed device rather than as a rare race backstop: the device UPDATE matches 0 rows, `updatedRows` is empty, the state-change audit is skipped, and `lastSeenAt` is not bumped, so the device correctly stays "Removed" in the UI while draining. **Verify the command claim is not gated on `updatedRows`** — it is not today (`heartbeat.ts:849` runs unconditionally) — and add a comment saying so, because a future refactor that moves the claim inside the guard would silently break delivery.

- [ ] **Step 4: Update the stale reasoning in `offlineDetector.ts:695-707`**

Its status exclusion stays **correct** and must not be removed, but its comment justifies itself with "it can never heartbeat again to clear it (agentAuthMiddleware 403s decommissioned devices)", which this task makes false. Update the comment; leave the predicate.

- [ ] **Step 5: Run the auth + agent suites, then commit**

```bash
pnpm --filter=@breeze/api test --run src/middleware/ src/routes/agents/
git commit -am "feat(api): narrow a draining removed device's agent surface instead of 403

Refs #3986"
```

---

### Task 9: Drain window in the stale-command reaper

**Files:** `apps/api/src/jobs/staleCommandReaper.ts:190-211`

- [ ] **Step 1: Write the failing test**

```ts
it('does not reap a self_uninstall on a removed device inside the drain window', ...);
it('reaps it once the window has passed', ...);
it('still reaps an abuse-queued self_uninstall on an ACTIVE device at 30 minutes', ...);
```

That third test is the important one — it is the regression guard for the hazard the existing comment at `:191-199` describes.

- [ ] **Step 2: Implement — add a second arm, do not widen the first**

`self_uninstall` currently times out at 30 minutes (`commandTimeouts.ts:85` → `MEDIUM_TIMEOUT_TYPES` → `THIRTY_MINUTES`). Add an OR-arm inside the same `NOT (...)`:

```sql
OR (
  ${deviceCommands.type} = 'self_uninstall'
  AND EXISTS (
    SELECT 1 FROM ${devices}
    WHERE ${devices.id} = ${deviceCommands.deviceId}
      AND ${devices.status} = 'decommissioned'
  )
  AND ${deviceCommands.createdAt} > now() - (${DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS} || ' hours')::interval
)
```

Two traps:
- **Do not copy the existing arm's `JOIN partners`.** It is an INNER join, so an org with `partner_id IS NULL` drops out of the EXISTS and its uninstalls are not exempt today. The new arm is devices-only and must stay that way.
- Abuse-suspension uninstalls target **active** devices, and the tenant drain explicitly skips decommissioned ones (`tenantOffboarding.ts:175`), so `devices.status = 'decommissioned'` cleanly separates our rows from both. No new hazard — but the third test above is what proves it.

When the window passes, the row is reaped to `failed` with `{status:'timeout'}`, the device stops satisfying the derived predicate, and `agentAuth` reverts to the hard 403. The drain closes itself; **no new sweeper job is needed.**

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter=@breeze/api test --run src/jobs/staleCommandReaper.test.ts src/services/commandTimeouts.test.ts
git commit -am "feat(api): hold a removed device's uninstall for the drain window

Refs #3986"
```

---

### Task 10: Delete the WS best-effort block from permanent delete

**Files:** `apps/api/src/routes/devices/core.ts:1559-1571`

- [ ] **Step 1: Delete it**

Remove the `isAgentConnected` / `sendCommandToAgent` block entirely, along with the now-unused imports. Keep `uninstallCommandSent` out of the audit details, or keep the key with a fixed `false` if you would rather not change the audit shape — state which in the commit message.

Removal is safe because the uninstall now happens at **Remove** time, and permanent delete requires the device to already be removed (`core.ts:1555`). Purge becomes purely a data operation.

- [ ] **Step 2: Update `cascadeDelete.test.ts` Half B if it asserts on the removed block, run, commit**

```bash
pnpm --filter=@breeze/api test --run src/routes/devices/
git commit -am "refactor(api): permanent delete no longer sends a best-effort uninstall

Refs #3986"
```

---

### Task 11: Integration test — delivery to an offline agent

The unit tests mock Drizzle; none of them prove a queued uninstall survives and is claimable. This is the test that would have caught the original bug.

**Files:** Create `apps/api/src/__tests__/integration/deviceUninstallDrain.integration.test.ts`

Place it in `src/__tests__/integration/` exactly — a file outside that directory runs in **zero** CI jobs.

- [ ] **Step 1: Write the test**

Against real Postgres, with `import './setup';` first:

1. Seed partner → org → device (`createPartner`/`createOrganization`/`createUser` from `./db-utils`).
2. `DELETE /devices/:id` with `uninstallAgent: true`.
3. Assert a `pending` `self_uninstall` row exists with `target_role='agent'`.
4. Assert `agentAuthMiddleware` now **admits** the device on `/heartbeat` and **refuses** it on `PUT /:id/security/recovery-keys`.
5. Claim via the heartbeat path; assert the response body carries the `self_uninstall` command and only that command (queue an extra `run_script` first and assert it is NOT delivered).
6. Ack it `completed`; assert the device is no longer draining and the next heartbeat 403s.
7. Separately: queue, then `POST /devices/:id/restore`; assert the row is `cancelled` and the device 403s again.

- [ ] **Step 2: Run it and CONFIRM IT RAN** (a `runIf` guard skips silently)

```bash
pnpm --filter @breeze/api test:docker:up
pnpm --filter @breeze/api test:integration -- src/__tests__/integration/deviceUninstallDrain.integration.test.ts
pnpm --filter @breeze/api test:docker:down
```
Read the output and confirm a non-zero passed count — not just a green exit.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/deviceUninstallDrain.integration.test.ts
git commit -m "test(api): prove a queued uninstall reaches an offline removed device

Closes #3986"
```

# PR3 — Web: the Remove dialog

Branch: `feat/3987-remove-dialog` (off `main`, after PR1 and PR2 have merged). `Closes #3987`.

**Do not open this PR until PR2 is deployed.** Sending `uninstallAgent: true` to an API that ignores it produces a dialog that promises an uninstall and silently does nothing — worse than the bug we started with.

---

### Task 12: `RemoveDeviceDialog`

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

### Task 13: Wire the dialog through the dispatchers

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

### Task 14: E2E coverage (greenfield)

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

**Spec coverage.** #3986: durable queue (T5, T6) · claim narrowing both layers (T8) · drain window (T9) · restore cancels (T7) · WS best-effort deleted (T10) · delivery proven against real Postgres (T11). #3987: menu parity (T1) · Remove/Delete-permanently split (T1, T2) · two-option radio defaulting to uninstall with state-aware hints (T12, T13) · label sweep + locale parity (T2, T3) · filter-builder derived label (T4) · bulk path (T13) · E2E (T14).

**Deliberately not covered, and why.** `admin.json`'s mTLS quarantine copy (different flow — file separately, noted in T2). `DeviceFilters.tsx` (dead code — noted in T4). Pending-uninstall *state surfaced in the UI* — #3986 lists it, but it depends on an API read model that PR2 does not build; it should be its own follow-up rather than a half-built badge. Mobile needs no changes (no decommission UI; status coercion only).

**Type consistency.** `RemoveAgentChoice` (T12) → `{ uninstallAgent: boolean }` (T13) → `uninstallAgent` body field (T6). `isDeviceUninstallDraining` / `queueDeviceUninstall` / `cancelDeviceUninstall` (T5) are consumed by T6/T7/T8 under exactly those names. Action strings stay `'decommission'` / `'restore'` / `'permanent-delete'` throughout — only labels change.

**Rollout.** PR1 → PR2 → deploy → PR3. PR2 is behaviour-neutral on its own (`uninstallAgent` defaults false). No migration, so no deploy ordering constraint beyond "API before the UI that calls it". Every branch targets `main` directly; do not stack, or CI will not run at all.
