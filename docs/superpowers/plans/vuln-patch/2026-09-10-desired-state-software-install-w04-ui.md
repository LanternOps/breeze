---
tracking_issue: LanternOps/breeze#5505
---

# Desired-State Software Install — W04 Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a technician arm/disarm `remediationOptions.autoInstall` on a software policy from the web UI, see a blast-radius warning before arming it, see which rules can never be auto-installed because they have no linked catalog item, see which deployments in the deployment list were created by policy remediation rather than a human, and see an honest error (never a silent no-op) when the server refuses to arm install for lack of `devices.execute` or MFA.

**Architecture:** Extend the existing `PolicyForm` (react-hook-form + zod) with a `catalogId` field per rule, an `autoInstall` checkbox gated to allowlist+enforce mode, a client-computed authoring warning, and a best-effort dry-run device-count fetch. Wire `ComplianceDashboard` to fetch the software catalog for the rule-linking picker, extend its local `Policy` type, migrate its policy-save handler (`handleFormSubmit`) to the repo's `runAction` contract so a 403 (`MFA_REQUIRED` or `DEVICES_EXECUTE_REQUIRED`) is never silently swallowed, and surface W02's per-device install-remediation status (including the loop-terminating `'gave_up'` state, per spec Risks §1) in the existing violations list. Add a "Policy-owned" badge to `DeploymentList` keyed off the new `software_policy_id` column that W03 adds to `software_deployments`.

**Tech Stack:** Astro + React Islands, react-hook-form + zod, Vitest + jsdom + Testing Library, i18next (8 locales, strict key parity enforced by `localeParity.test.ts`).

**Spec:** `docs/superpowers/specs/vuln-patch/2026-09-10-desired-state-software-install-design.md` (see especially "Corrections after ground-truth verification"). Cross-wave contract (authoritative over the spec where they disagree): `/private/tmp/claude-501/-Users-toddhebebrand--herdr-worktrees-breeze-warranty-testing/4b860881-d3d0-4020-ad1e-65daf215df86/scratchpad/contract-A-desired-state.md`.

## Global Constraints

- **Web files only.** This wave (W04, sub-issue #5509) may not touch anything under `apps/api`. Every fact below about server behavior is either already shipped (verified in this pass) or an explicit, flagged dependency on another wave — never implemented here.
- **Depends on W01 (`autoInstall` field + server gate), W03 (`software_policy_id` on `software_deployments`), and W06 (#5522, both halves — the install-preview endpoint AND the widened violations projection).** None of the three has landed as of this writing (`git log` shows only Lenovo-warranty commits on this branch). Code in this plan is written against their documented contracts (below), not against code that exists yet.
- **W03's column needs no extra API route work for the deployment-list label.** `GET /software/deployments` (`apps/api/src/routes/software.ts:1525` `db.select().from(softwareDeployments)`) is a wildcard select with no column list — once W03 adds `software_policy_id` (camelCase `softwarePolicyId` per Drizzle convention) to the schema, it flows into the JSON response automatically via `...item` at `:1537`. Verified by reading the route; no dependency to flag here.
- **W06 (#5522) owns both the dry-run device count and the install-status projection.** No route today returns an accurate count of devices a policy's `missing` violations would install to (`GET /software-policies/violations?policyId=X`, `apps/api/src/routes/softwarePolicies.ts:688-733`, returns `{ data: rows, total: rows.length }` capped at `limit` — not a real count, silently undercounts exactly the broad policies spec Risk §2 warns about), and nothing exposes W02's three `software_compliance_status` install-remediation columns over HTTP at all. As of this plan's first draft neither gap was owned by any wave; the coordinator has since filed **W06 (#5522)** to close both, plan at `docs/superpowers/plans/vuln-patch/2026-09-10-desired-state-software-install-w06-install-preview-endpoint.md`. This plan's Task 2 and Task 4 are written against W06's documented contract (verified against that plan doc, not trusted from a summary — see each task's own verify-or-proceed step) and **both degrade gracefully if W06 has not landed when this wave is implemented**:
  - **W06 Task 2** — `GET /software-policies/:id/install-preview` → `200 { eligibleDeviceCount: number }`. Consumed by Task 2 below. Treated as **advisory only, never a gate**: any non-2xx response (including 404 because the route doesn't exist yet) renders a "preview unavailable" message and the checkbox stays fully usable. Safe because the *actual* blast-radius bound is W02's per-pass cap (`SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS`), a backend safety net independent of whether this UI preview exists.
  - **W06 Task 3** — widens `GET /software-policies/violations`'s existing compliance projection (`apps/api/src/routes/softwarePolicies.ts:481-488`) to add `installRemediationStatus`, `lastInstallRemediationAttempt`, `installRemediationAttempts`. Consumed by Task 4 below. Every render Task 4 adds is gated on `installRemediationStatus` being present and non-`'none'`, so an unlanded W06 means those fields are simply absent from the response and nothing extra renders — the same as today.
  - Both verify-or-proceed steps (Task 2 Step 1a, Task 4 Step 1) grep the actual landed route file rather than trusting this summary, per the coordinator's instruction, mirroring the "W01/W02-owned identifiers this wave imports" verify-or-stop discipline W03's plan uses for its own upstream dependency — except where W03 must hard-stop (a compile-time import with no real name to import), W04's dependency is a runtime JSON field this plan already codes defensively against absence, so an unlanded W06 means "proceed in degraded mode", not "stop".
- **The authoring-warning field (`catalogId` per rule) does not exist in the web rule editor today.** `PolicyForm.tsx`'s `softwareRuleSchema` (`:7-13`) has no `catalogId` field, even though the server-side `SoftwarePolicyRuleDefinition.catalogId` has existed since before this feature (spec: `softwarePolicies.ts:28`, contract: `:25-32`). Without adding a way to *set* `catalogId` from the UI, "warn when rules lack `catalogId`" would fire on 100% of existing policies with no way to resolve it. This plan therefore adds a catalog-item picker to each rule row (Task 1) — a necessary, in-scope prerequisite for the warning to be actionable, not scope creep.
- **`'skipped'` cannot be fully disambiguated from currently-projected data.** W02 collapses three distinct causes (no `catalogId` on the rule, the per-pass cap, or no install method for the device's platform) into one `installRemediationStatus: 'skipped'` value with no persisted sub-reason column. Task 4 gives the one cause reconstructable from already-projected data (no `catalogId` on the device's own `missing` violation) a specific explanation, and hedges honestly on the other two rather than fabricating precision the data doesn't support — flagged as a further gap for the coordinator, same treatment as the dry-run endpoint gap above.
- **i18n locale parity is enforced by `apps/web/src/lib/i18n/localeParity.test.ts`.** Every leaf key in `en/*.json` must exist with the same type and interpolation tokens in all 7 other locale directories (`de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`) or that suite goes red. Each task below adds its new keys to `en/policies.json` only, as part of the same step that references them (so that task's own tests go green immediately using the English string). Task 6 is the single consolidation pass that backfills all 7 other locales and runs `localeParity.test.ts` — **the plan is not done until Task 6 lands**; `localeParity.test.ts` is expected to be red between Task 1 and Task 6, which is normal mid-plan, not a regression to chase.
- **`no-silent-mutations.test.ts` (`apps/web/src/lib/__tests__/no-silent-mutations.test.ts`) does not currently cover `ComplianceDashboard.tsx`.** It is in neither `TARGET_GLOBS` (the enforced set) nor `RUN_ACTION_ALLOWLIST` nor `RUN_ACTION_MIGRATION_BACKLOG` — an existing gap, not something this plan is required to fully close. Task 3 migrates only `handleFormSubmit` (the handler this feature's authorization requirement touches) to `runAction`; `handleConfirmDelete`, `handleCheckCompliance`, and `handleRemediate` are deliberately left on their current bare-`fetchWithAuth` pattern — out of scope for this wave. Because of that partial state, **do not add `ComplianceDashboard.tsx` to `TARGET_GLOBS`** (the AST guard would then flag the three untouched handlers and fail CI for work this plan didn't do). Task 3 does add the file to `RUN_ACTION_MIGRATION_BACKLOG` with a comment recording the partial migration, per the array's own "migrate opportunistically... move each into TARGET_GLOBS as it's done" philosophy.
- **`CLAUDE.md` "Web Mutation Handlers — runAction"**: every mutating `fetchWithAuth` call this plan adds or touches must be wrapped in `runAction`, and a 403 must never be silently swallowed. The `ActionError` catch pattern (`if (err instanceof ActionError && err.status === 401) return; if (!(err instanceof ActionError)) showToast(...)`) is used verbatim in Task 3, matching the established sibling pattern in `apps/web/src/components/devices/ManualAssetModal.tsx:199-241`.
- **`CLAUDE.md` "URL State in Components"**: not applicable — this wave adds no new tabs or selectable list items that need shareable state.
- **Test commands**: `cd apps/web && npx vitest run <path>`. Never `pnpm --filter <pkg> test -- --run <path>` (the bare `--` makes vitest fall back to watch mode over the whole suite — confirmed repo-wide gotcha). Vitest's path filter is a plain substring match — a trailing `/` silently skips sibling `*.test.tsx` files, so scope test runs to explicit file paths, not directories.
- **Red-first, every task.** Write the assertion, run it, watch it fail against the unmodified code, then implement.

## File Structure

**Modify:**
- `apps/web/src/components/software/PolicyForm.tsx` — rule-level `catalogId` picker, `autoInstall` checkbox, authoring warning, dry-run preview block.
- `apps/web/src/components/software/ComplianceDashboard.tsx` — local `Policy`/`PolicyFormValues`-adjacent types, software-catalog fetch, `handleFormSubmit` payload + `runAction` migration, per-device install-remediation status display.
- `apps/web/src/components/software/DeploymentList.tsx` — `DeploymentRow.softwarePolicyId` + "Policy-owned" badge.
- `apps/web/src/lib/runActionAllowlist.ts` — add `ComplianceDashboard.tsx` to `RUN_ACTION_MIGRATION_BACKLOG` (partial-migration note).
- `apps/web/src/locales/en/policies.json` (+7 non-English locale files in Task 6) — new keys under `policyForm`, `complianceDashboard`, `deploymentList`.

**Create:**
- `apps/web/src/components/software/PolicyForm.autoInstall.test.tsx` — PolicyForm's first direct unit-test file (today it's exercised only indirectly through `ComplianceDashboard.ownerScope.test.tsx`).
- `apps/web/src/components/software/ComplianceDashboard.autoInstall.test.tsx`
- `apps/web/src/components/software/DeploymentList.policyOwned.test.tsx`

## 0. Ground Truth

Quoted verbatim, `path:line`, from the state of the repo at plan-writing time (`fix/lenovo-warranty-provider` branch, worktree `warranty-testing`).

**`apps/web/src/components/software/PolicyForm.tsx`**

```
7:  const softwareRuleSchema = z.object({
8:    name: z.string().min(1, "Software name is required").max(500),
9:    vendor: z.string().max(200).optional().or(z.literal("")),
10:   minVersion: z.string().max(100).optional().or(z.literal("")),
11:   maxVersion: z.string().max(100).optional().or(z.literal("")),
12:   reason: z.string().max(1000).optional().or(z.literal("")),
13: });
```
No `catalogId`. Also no `autoInstall` in `policyFormSchema` (`:14-28`), which has `autoUninstall: z.boolean().optional()` (`:26`) but nothing else install-related.

```
32: type PolicyFormProps = {
33:   onSubmit?: (values: PolicyFormValues) => void | Promise<void>;
34:   onCancel?: () => void;
35:   defaultValues?: Partial<PolicyFormValues>;
36:   submitLabel?: string;
37:   loading?: boolean;
38:   /** Show the ownership-scope selector (create-only, partner-scope users). */
39:   showOwnerScope?: boolean;
40: };
```
No `policyId` or `catalogItems` prop. `PolicyForm` currently performs **zero** `fetchWithAuth` calls — it is a pure controlled form.

```
70:  const { fields, append, remove } = useFieldArray({
71:    control,
72:    name: "software",
73:  });
74:  const watchMode = watch("mode");
75:  const watchEnforceMode = watch("enforceMode");
```

Autouninstall + gracePeriod block (`:295-318`):
```
294:          {watchEnforceMode && (
295:            <label className="flex items-center gap-2">
296:              <input
297:                type="checkbox"
298:                className="h-4 w-4 rounded border-border"
299:                {...register("autoUninstall")}
300:              />
301:              <span className="text-sm">
302:                {i18n.t("policies:software.policyForm.autoUninstall")}
303:              </span>
304:            </label>
305:          )}
```
`allowUnknown` (the existing precedent for an allowlist-only field, `:270-282`):
```
270:        {watchMode === "allowlist" && (
271:          <label className="flex items-center gap-2 px-1">
272:            <input
273:              type="checkbox"
274:              className="h-4 w-4 rounded border-border"
275:              {...register("allowUnknown")}
276:            />
```

**`apps/web/src/components/software/ComplianceDashboard.tsx`**

Local `Policy` type (`:20-44`) — no `catalogId` on rules, no `autoInstall` on `remediationOptions`:
```
20: type Policy = {
...
28:   rules?: {
29:     software: Array<{
30:       name: string;
31:       vendor?: string;
32:       minVersion?: string;
33:       maxVersion?: string;
34:       reason?: string;
35:     }>;
36:     allowUnknown?: boolean;
37:   };
38:   isActive: boolean;
39:   enforceMode: boolean;
40:   remediationOptions?: {
41:     autoUninstall?: boolean;
42:     gracePeriod?: number;
43:   } | null;
```

`handleFormSubmit` (`:216-268`) — builds the PATCH/POST body directly from `fetchWithAuth`, no `runAction`:
```
239:        remediationOptions: values.enforceMode
240:          ? {
241:              autoUninstall: values.autoUninstall,
242:              gracePeriod: values.gracePeriod,
243:            }
244:          : undefined,
...
248:      const res = await fetchWithAuth(url, {
249:        method,
250:        body: JSON.stringify(body),
251:      });
252:      if (!res.ok) {
253:        const data = await res.json().catch(() => ({}));
254:        throw new Error(
255:          (data as { error?: string }).error || i18n.t(...),
256:        );
257:      }
```
Catch block (`:266-275`) shows `err.message` verbatim in a toast — for a `{error:'MFA required', code:'MFA_REQUIRED'}` body this renders the raw string "MFA required", not any friendly copy, and there is no `code`-aware handling anywhere in this file.

`policyToFormDefaults` (`:400-411`):
```
400:  const policyToFormDefaults = (policy: Policy): Partial<PolicyFormValues> => ({
...
403:    software: policy.rules?.software?.map((s) => ({
404:      name: s.name,
405:      vendor: s.vendor ?? "",
406:      minVersion: s.minVersion ?? "",
407:      maxVersion: s.maxVersion ?? "",
408:      reason: s.reason ?? "",
409:    })) ?? [
410:      { name: "", vendor: "", minVersion: "", maxVersion: "", reason: "" },
411:    ],
412:    allowUnknown: policy.rules?.allowUnknown ?? false,
413:    enforceMode: policy.enforceMode,
414:    autoUninstall: policy.remediationOptions?.autoUninstall ?? false,
415:    gracePeriod: policy.remediationOptions?.gracePeriod ?? 24,
416:  });
```

`refresh()` (`:105-138`) fetches policies/overview/violations via `Promise.all` and throws if any of the three `!res.ok` — a good reason NOT to fold a new catalog fetch into this same `Promise.all` (a catalog-fetch hiccup must not blank the whole dashboard).

**`apps/web/src/components/software/DeploymentList.tsx`**

Already uses `runAction`/`handleActionError` (`:13`, `:169`, `:181`) — the sibling pattern to copy for any *new* mutation, though this task adds a read-only label, no new mutation.

```
34: type DeploymentRow = {
35:   id: string;
36:   orgId?: string;
37:   name: string;
38:   deploymentType?: string;
39:   scheduleType: string;
40:   scheduledAt?: string | null;
41:   createdAt: string;
42:   status: SoftwareDeploymentAggregateStatus;
43:   counts: SoftwareDeploymentCounts;
44: };
```
No `softwarePolicyId`.

Row rendering, Name column (`:391-399`):
```
391:                        <td className="px-4 py-3">
392:                          <p className="font-medium text-foreground">
393:                            {item.name}
394:                          </p>
395:                          <p className="text-xs text-muted-foreground">
396:                            {item.id}
397:                          </p>
398:                        </td>
```

**Partner-wide badge precedent** (`ComplianceDashboard.tsx:499-514`), the exact visual pattern to copy for "Policy-owned":
```
499:                      {policy.orgId === null && (
500:                        <span
501:                          className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
502:                          title={i18n.t(...)}
503:                          data-testid="software-policy-partner-wide-badge"
504:                        >
505:                          <Layers className="h-3 w-3" />
506:                          {i18n.t("policies:software.complianceDashboard.allOrgs")}
507:                        </span>
508:                      )}
```

**`apps/web/src/lib/runAction.ts`** — `RunActionOptions.friendly?: (code: string) => string | undefined`, called with `body.code` when present, else `body.error` (`:27-32`, `:75-83`). `ActionError` carries `.status` and `.code` (`:5-19`).

**MFA-refusal UI precedent — `apps/web/src/components/devices/ManualAssetModal.tsx:199,234`**:
```
199:  const mfaFriendly = (code: string) => (code === 'MFA_REQUIRED' ? t('manualAssetModal.errors.mfaRequired') : undefined);
...
228:      result = await runAction<{ warnings?: { code: string; message: string }[] }>({
229:        request: () =>
230:          fetchWithAuth(isEdit ? `/devices/manual/${existing!.id}` : '/devices/manual', {
231:            method: isEdit ? 'PATCH' : 'POST',
232:            body: JSON.stringify(body),
233:          }),
234:        errorFallback: isEdit ? t('manualAssetModal.errors.updateFailed') : t('manualAssetModal.errors.createFailed'),
235:        friendly: mfaFriendly,
```
This is the exact pattern Task 3 copies (with `i18n.t()` in place of the hook's `t()`, matching `ComplianceDashboard.tsx`'s existing convention of calling the global `i18n.t()` for static keys).

**Server-side MFA refusal shape** (from the cross-wave contract, D3, citing `apps/api/src/middleware/auth.ts:885-908`): `c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)`.

**Server-side permission refusal shape — corrected after this plan's first draft.** The contract's "Contract corrections found during plan authoring" section (added after W01's plan-authoring pass) fixes the exact body for the non-MFA refusal: `{ error: ARM_INSTALL_EXECUTE_DENIED_MESSAGE, code: 'DEVICES_EXECUTE_REQUIRED' }`, 403 — **it also carries a `code`**, not a bare message as this plan's first draft assumed. Both refusal paths are therefore coded, and both get their own `friendly` mapping in Task 3 rather than one coded case plus a generic fallback.

**`apps/web/src/lib/asList.ts:34-52`** — `asList<T>(payload, ...aliasKeys)` coerces `{data:[...]}` / `{<alias>:[...]}` / bare-array API responses to `T[]`, failing closed to `[]` with a console warning on an unrecognized shape. Used by `DeploymentWizard.tsx:344` and `SoftwareCatalog.tsx` for the exact same `/software/catalog` endpoint this plan also calls, with the alias `'catalog'`.

**`GET /software/catalog`** (used already by `SoftwareCatalog.tsx:252` and `DeploymentWizard.tsx:342`) returns rows shaped `{ id, orgId?, name, vendor, category, description, ... }` (`SoftwareCatalog.tsx:262-270` normalization).

**i18n locale files** — all 8 locale directories mirror `en/policies.json`'s structure at identical line numbers for the sections this plan touches (`complianceDashboard` ends at line 1353, `deploymentList` spans 1354-1429, `policyForm` ends at line 1619, confirmed identical across `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`). `apps/web/src/lib/i18n/localeParity.test.ts` enforces that every English leaf key exists, with matching type and interpolation tokens (`{{count}}` etc.), in every other locale.

## Task 1: `PolicyForm` — catalog-item link per rule, `autoInstall` checkbox, authoring warning

**Files:**
- Modify: `apps/web/src/components/software/PolicyForm.tsx`
- Modify: `apps/web/src/locales/en/policies.json`
- Create: `apps/web/src/components/software/PolicyForm.autoInstall.test.tsx`

**Interfaces:**
- Consumes: nothing from other tasks in this plan.
- Produces (for Task 2 and Task 3 to build on):
  - `CatalogOption = { id: string; name: string; vendor?: string }` (exported from `PolicyForm.tsx`).
  - `PolicyFormValues.software[number].catalogId?: string`
  - `PolicyFormValues.autoInstall?: boolean`
  - New `PolicyFormProps.catalogItems?: CatalogOption[]` (defaults to `[]`).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/software/PolicyForm.autoInstall.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PolicyForm from "./PolicyForm";

const CATALOG = [
  { id: "cat-1", name: "Zoom", vendor: "Zoom Video" },
  { id: "cat-2", name: "1Password", vendor: "AgileBits" },
];

function fillRequired() {
  fireEvent.change(screen.getByPlaceholderText("e.g. Block Unauthorized Software"), {
    target: { value: "Required Apps" },
  });
  fireEvent.change(screen.getByPlaceholderText("Name *"), {
    target: { value: "Zoom" },
  });
}

describe("PolicyForm — catalog link + autoInstall arming (#5509)", () => {
  it("renders a catalog-link select for each software rule, defaulting to none", () => {
    render(<PolicyForm catalogItems={CATALOG} />);
    const select = screen.getByTestId("software-rule-catalog-0") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select.value).toBe("");
    expect(screen.getByText("Zoom (Zoom Video)")).toBeInTheDocument();
    expect(screen.getByText("1Password (AgileBits)")).toBeInTheDocument();
  });

  it("includes the selected catalogId in the submitted values", async () => {
    const onSubmit = vi.fn();
    render(<PolicyForm catalogItems={CATALOG} onSubmit={onSubmit} />);
    fillRequired();
    fireEvent.change(screen.getByTestId("software-rule-catalog-0"), {
      target: { value: "cat-1" },
    });
    fireEvent.click(screen.getByText("Save Policy"));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].software[0].catalogId).toBe("cat-1");
  });

  it("hides the auto-install checkbox unless mode is allowlist and enforce is on", () => {
    render(<PolicyForm catalogItems={CATALOG} />);
    expect(screen.queryByTestId("policy-auto-install-checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Enforce (auto-remediate)"));
    expect(screen.queryByTestId("policy-auto-install-checkbox")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "allowlist" } });
    expect(screen.getByTestId("policy-auto-install-checkbox")).toBeInTheDocument();
  });

  it("warns when auto-install is armed but a rule has no linked catalog item", () => {
    render(<PolicyForm catalogItems={CATALOG} />);
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "allowlist" } });
    fireEvent.click(screen.getByLabelText("Enforce (auto-remediate)"));
    expect(screen.queryByTestId("autoinstall-catalog-warning")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("policy-auto-install-checkbox"));
    expect(screen.getByTestId("autoinstall-catalog-warning")).toHaveTextContent(
      "1 of 1 rule(s) have no linked catalog item",
    );
    fireEvent.change(screen.getByTestId("software-rule-catalog-0"), {
      target: { value: "cat-1" },
    });
    expect(screen.queryByTestId("autoinstall-catalog-warning")).not.toBeInTheDocument();
  });
});
```

Note: `PolicyForm.tsx` has no `htmlFor`/`id` pairing on the Mode `<select>` today (`<label htmlFor="policy-mode">` / `<select id="policy-mode">` — already present at `:139-159`, so `getByLabelText("Mode")` already resolves; verified by reading the existing markup, not assumed).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/software/PolicyForm.autoInstall.test.tsx`
Expected: FAIL — `getByTestId("software-rule-catalog-0")` not found (no such element yet), and `PolicyForm` doesn't accept a `catalogItems` prop.

- [ ] **Step 3: Implement — schema, props, rule-row picker, checkbox, warning**

Edit `apps/web/src/components/software/PolicyForm.tsx`. First, add `useMemo` to the React import:

```tsx
import { useMemo } from "react";
import { useForm, useFieldArray } from "react-hook-form";
```

Extend the rule schema and top-level schema:

```tsx
const softwareRuleSchema = z.object({
  name: z.string().min(1, "Software name is required").max(500),
  vendor: z.string().max(200).optional().or(z.literal("")),
  minVersion: z.string().max(100).optional().or(z.literal("")),
  maxVersion: z.string().max(100).optional().or(z.literal("")),
  reason: z.string().max(1000).optional().or(z.literal("")),
  // Links this rule to a software-catalog item so an armed autoInstall
  // policy has something concrete to install (#5509). Empty string = no
  // link, matching the other optional string fields' convention above.
  catalogId: z.string().optional().or(z.literal("")),
});
const policyFormSchema = z.object({
  name: z.string().min(1, "Policy name is required").max(200),
  description: z.string().max(4000).optional().or(z.literal("")),
  mode: z.enum(["allowlist", "blocklist", "audit"]),
  ownerScope: z.enum(["organization", "partner"]).optional(),
  software: z
    .array(softwareRuleSchema)
    .min(1, "At least one software rule is required"),
  allowUnknown: z.boolean().optional(),
  enforceMode: z.boolean(),
  autoUninstall: z.boolean().optional(),
  // Arms desired-state install remediation (#5505). Only meaningful on an
  // allowlist policy — 'missing' violations, the only kind autoInstall
  // acts on, are only ever emitted for allowlist rule mismatches.
  autoInstall: z.boolean().optional(),
  gracePeriod: z.coerce.number().int().min(0).max(2160).optional(),
});
export type PolicyFormValues = z.infer<typeof policyFormSchema>;
export type CatalogOption = { id: string; name: string; vendor?: string };
type PolicyFormProps = {
  onSubmit?: (values: PolicyFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<PolicyFormValues>;
  submitLabel?: string;
  loading?: boolean;
  showOwnerScope?: boolean;
  /** Existing policy id when editing — undefined while creating (#5509).
   *  Feeds the install dry-run preview in Task 2; a brand-new policy has no
   *  id to query yet. */
  policyId?: string;
  /** Software catalog items available to link a rule to. Fetched once by
   *  the parent (ComplianceDashboard); an empty array degrades the picker
   *  to "no catalog items" rather than blocking the form. */
  catalogItems?: CatalogOption[];
};
```

Update the `useForm` default values and `append(...)` call:

```tsx
export default function PolicyForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel = "Save Policy",
  loading,
  showOwnerScope = false,
  policyId,
  catalogItems = [],
}: PolicyFormProps) {
  useTranslation("policies");
  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<PolicyFormValues>({
    resolver: zodResolver(policyFormSchema) as never,
    defaultValues: {
      name: "",
      description: "",
      mode: "blocklist",
      software: [
        { name: "", vendor: "", minVersion: "", maxVersion: "", reason: "", catalogId: "" },
      ],
      allowUnknown: false,
      enforceMode: false,
      autoUninstall: false,
      autoInstall: false,
      gracePeriod: 24,
      ...defaultValues,
    },
  });
  const { fields, append, remove } = useFieldArray({
    control,
    name: "software",
  });
  const watchMode = watch("mode");
  const watchEnforceMode = watch("enforceMode");
  const watchAutoInstall = watch("autoInstall");
  const watchSoftware = watch("software");
  const rulesWithoutCatalog = useMemo(
    () => watchSoftware.filter((rule) => !rule.catalogId).length,
    [watchSoftware],
  );
  const isLoading = loading ?? isSubmitting;
```

Update the `append` button:

```tsx
          <button
            type="button"
            onClick={() =>
              append({
                name: "",
                vendor: "",
                minVersion: "",
                maxVersion: "",
                reason: "",
                catalogId: "",
              })
            }
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
          >
```

Add the catalog-link select to each rule row. Replace the rule-row grid (currently `sm:grid-cols-2 md:grid-cols-5`) with a 6th field:

```tsx
                <div className="flex-1 grid gap-2 sm:grid-cols-2 md:grid-cols-6">
                  <input
                    placeholder={i18n.t("policies:software.policyForm.name")}
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    {...register(`software.${index}.name`)}
                  />
                  <input
                    placeholder={i18n.t("policies:software.policyForm.vendor")}
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    {...register(`software.${index}.vendor`)}
                  />
                  <input
                    placeholder={i18n.t("policies:software.policyForm.minVer")}
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    {...register(`software.${index}.minVersion`)}
                  />
                  <input
                    placeholder={i18n.t("policies:software.policyForm.maxVer")}
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    {...register(`software.${index}.maxVersion`)}
                  />
                  <input
                    placeholder={i18n.t("policies:software.policyForm.reason")}
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    {...register(`software.${index}.reason`)}
                  />
                  <select
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    title={i18n.t("policies:software.policyForm.catalogLink")}
                    data-testid={`software-rule-catalog-${index}`}
                    {...register(`software.${index}.catalogId`)}
                  >
                    <option value="">
                      {i18n.t("policies:software.policyForm.catalogLinkNone")}
                    </option>
                    {catalogItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.vendor ? `${item.name} (${item.vendor})` : item.name}
                      </option>
                    ))}
                  </select>
                </div>
```

Add the `autoInstall` checkbox next to `autoUninstall` (still inside the existing `grid gap-3 md:grid-cols-2 items-center` container):

```tsx
          {watchEnforceMode && watchMode === "allowlist" && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border"
                data-testid="policy-auto-install-checkbox"
                {...register("autoInstall")}
              />
              <span className="text-sm">
                {i18n.t("policies:software.policyForm.autoInstall")}
              </span>
            </label>
          )}
```

Add the authoring warning immediately after that block (still inside the "Policy Settings" `<div>`, before the grace-period block):

```tsx
        {watchEnforceMode && watchMode === "allowlist" && watchAutoInstall && rulesWithoutCatalog > 0 && (
          <p
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700"
            data-testid="autoinstall-catalog-warning"
          >
            {i18n.t("policies:software.policyForm.autoInstallCatalogWarning", {
              count: rulesWithoutCatalog,
              total: watchSoftware.length,
            })}
          </p>
        )}
```

Add the four new keys to `apps/web/src/locales/en/policies.json`. Find the `policyForm` section's last key (`"saving": "Saving..."` at line 1618, immediately before the closing `},` of that object at line 1619) and insert before it:

```json
      "saving": "Saving...",
      "catalogLink": "Linked catalog item",
      "catalogLinkNone": "None — not linked",
      "autoInstall": "Auto-install missing software",
      "autoInstallCatalogWarning": "{{count}} of {{total}} rule(s) have no linked catalog item and will be detected as missing but never installed."
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/software/PolicyForm.autoInstall.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/software/PolicyForm.tsx \
        apps/web/src/components/software/PolicyForm.autoInstall.test.tsx \
        apps/web/src/locales/en/policies.json
git commit -m "$(cat <<'EOF'
feat(web): PolicyForm — catalog-item link per rule, autoInstall checkbox, authoring warning (#5505 W04)

Adds the client-side half of arming desired-state install remediation:
a catalogId picker per software rule (previously unsettable from the
UI, even though the server schema has supported it), an autoInstall
checkbox gated to allowlist+enforce mode (missing violations — the
only kind autoInstall acts on — only fire for allowlist rules), and a
warning when a rule with no linked catalog item can never be
auto-installed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz
EOF
)"
```

## Task 2: `PolicyForm` — dry-run device-count preview

**Files:**
- Modify: `apps/web/src/components/software/PolicyForm.tsx`
- Modify: `apps/web/src/locales/en/policies.json`
- Modify: `apps/web/src/components/software/PolicyForm.autoInstall.test.tsx`

**Interfaces:**
- Consumes: `PolicyFormProps.policyId` (produced by Task 1), `watchMode`/`watchEnforceMode`/`watchAutoInstall` (Task 1). `GET /software-policies/:id/install-preview` → `200 { eligibleDeviceCount: number }` — **W06 (#5522) Task 2**, field name verified in Step 1 below against W06's own plan doc, not assumed.
- Produces: nothing new for later tasks — this is a leaf feature.
- **Dependency on W06, degrades gracefully if unlanded.** The implementation below calls this endpoint and degrades gracefully (see Global Constraints) if it 404s or errors, so this task ships correctly regardless of when/whether W06 has landed by the time this task is implemented.

- [ ] **Step 1: Verify W06's install-preview endpoint contract (or proceed in degraded mode)**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
grep -n "install-preview" apps/api/src/routes/softwarePolicies.ts
```

Expected, per W06's plan (`docs/superpowers/plans/vuln-patch/2026-09-10-desired-state-software-install-w06-install-preview-endpoint.md`, Task 2's Interfaces block): a route `GET /software-policies/:id/install-preview` returning `200 { eligibleDeviceCount: number }` on success. Three outcomes:
- **Grep finds the route:** confirmed — proceed with implementation exactly as written below.
- **Grep finds nothing:** W06 has not landed yet. This is expected and does not block this task — proceed with implementation exactly as written below. `fetchWithAuth` will receive a 404 from the real API in that case (not a mock), which the code below already treats as "unavailable" rather than an error; the preview lights up with no further code change once W06 ships.
- **Grep finds a route under a different path or response shape:** stop this task and reconcile against the real contract — do not silently guess.

- [ ] **Step 2: Write the failing tests**

Append to `apps/web/src/components/software/PolicyForm.autoInstall.test.tsx`:

```tsx
vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
import { fetchWithAuth } from "../../stores/auth";
const fetchMock = vi.mocked(fetchWithAuth);
const jsonRes = (payload: unknown, ok = true, status = ok ? 200 : 404): Response =>
  ({ ok, status, statusText: ok ? "OK" : "ERROR", json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe("PolicyForm — dry-run device count preview (#5509)", () => {
  it("shows a 'new policy' message instead of fetching when there is no policyId yet", () => {
    render(<PolicyForm catalogItems={[]} />);
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "allowlist" } });
    fireEvent.click(screen.getByLabelText("Enforce (auto-remediate)"));
    fireEvent.click(screen.getByTestId("policy-auto-install-checkbox"));
    expect(screen.getByTestId("autoinstall-dry-run")).toHaveTextContent(
      "This is a new policy",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches and renders the eligible device count for an existing policy", async () => {
    fetchMock.mockResolvedValue(jsonRes({ eligibleDeviceCount: 42 }));
    render(<PolicyForm catalogItems={[]} policyId="pol-1" />);
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "allowlist" } });
    fireEvent.click(screen.getByLabelText("Enforce (auto-remediate)"));
    fireEvent.click(screen.getByTestId("policy-auto-install-checkbox"));
    await screen.findByText("This will install missing software on approximately 42 device(s).");
    expect(fetchMock).toHaveBeenCalledWith("/software-policies/pol-1/install-preview");
  });

  it("degrades to an 'unavailable' message when the preview endpoint fails or doesn't exist", async () => {
    fetchMock.mockResolvedValue(jsonRes({}, false, 404));
    render(<PolicyForm catalogItems={[]} policyId="pol-1" />);
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "allowlist" } });
    fireEvent.click(screen.getByLabelText("Enforce (auto-remediate)"));
    fireEvent.click(screen.getByTestId("policy-auto-install-checkbox"));
    await screen.findByTestId("autoinstall-dry-run");
    expect(screen.getByTestId("autoinstall-dry-run")).toHaveTextContent(
      "Device-count preview isn't available yet",
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/software/PolicyForm.autoInstall.test.tsx`
Expected: FAIL — `getByTestId("autoinstall-dry-run")` not found; `fetchWithAuth` mock target doesn't exist in `PolicyForm.tsx` yet.

- [ ] **Step 4: Implement**

Edit `apps/web/src/components/software/PolicyForm.tsx`. Add imports:

```tsx
import { useEffect, useMemo, useState } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { fetchWithAuth } from "../../stores/auth";
```

Add the dry-run state and effect inside the component, after the `rulesWithoutCatalog` `useMemo`:

```tsx
  type DryRunState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready"; eligibleDeviceCount: number }
    | { status: "unavailable" };
  const [dryRun, setDryRun] = useState<DryRunState>({ status: "idle" });
  useEffect(() => {
    if (!policyId || watchMode !== "allowlist" || !watchEnforceMode || !watchAutoInstall) {
      return;
    }
    let cancelled = false;
    setDryRun({ status: "loading" });
    (async () => {
      try {
        // Dependency on W06 (#5522) Task 2, which may not have landed yet
        // when this code runs (see plan Global Constraints). Any non-2xx
        // (including a plain 404 because the route doesn't exist) degrades
        // to "unavailable" below — this preview is advisory only and never
        // blocks arming; the real blast-radius bound is W02's per-pass cap.
        const response = await fetchWithAuth(`/software-policies/${policyId}/install-preview`);
        if (cancelled) return;
        if (!response.ok) {
          setDryRun({ status: "unavailable" });
          return;
        }
        const payload = await response.json();
        const count = Number((payload as { eligibleDeviceCount?: unknown })?.eligibleDeviceCount);
        if (!Number.isFinite(count)) {
          setDryRun({ status: "unavailable" });
          return;
        }
        setDryRun({ status: "ready", eligibleDeviceCount: count });
      } catch {
        if (!cancelled) setDryRun({ status: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [policyId, watchMode, watchEnforceMode, watchAutoInstall]);
```

Add the preview block right after the authoring-warning `<p>` added in Task 1:

```tsx
        {watchEnforceMode && watchMode === "allowlist" && watchAutoInstall && (
          <div
            className="rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-xs"
            data-testid="autoinstall-dry-run"
          >
            {!policyId ? (
              <p className="text-muted-foreground">
                {i18n.t("policies:software.policyForm.dryRunNewPolicy")}
              </p>
            ) : dryRun.status === "loading" ? (
              <p className="text-muted-foreground">
                {i18n.t("policies:software.policyForm.dryRunLoading")}
              </p>
            ) : dryRun.status === "ready" ? (
              <p>
                {i18n.t("policies:software.policyForm.dryRunResult", {
                  count: dryRun.eligibleDeviceCount,
                })}
              </p>
            ) : (
              <p className="text-muted-foreground">
                {i18n.t("policies:software.policyForm.dryRunUnavailable")}
              </p>
            )}
          </div>
        )}
```

Add the four new keys to `apps/web/src/locales/en/policies.json`, after the ones Task 1 added (still before the `policyForm` object's closing `},`):

```json
      "autoInstallCatalogWarning": "{{count}} of {{total}} rule(s) have no linked catalog item and will be detected as missing but never installed.",
      "dryRunLoading": "Checking how many devices this will affect...",
      "dryRunResult": "This will install missing software on approximately {{count}} device(s).",
      "dryRunUnavailable": "Device-count preview isn't available yet. Arming will still take effect on the next compliance pass.",
      "dryRunNewPolicy": "This is a new policy — device impact isn't known until the first compliance pass after you save."
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/software/PolicyForm.autoInstall.test.tsx`
Expected: PASS (7 tests total across both `describe` blocks).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/software/PolicyForm.tsx \
        apps/web/src/components/software/PolicyForm.autoInstall.test.tsx \
        apps/web/src/locales/en/policies.json
git commit -m "$(cat <<'EOF'
feat(web): PolicyForm — dry-run device-count preview before arming autoInstall (#5505 W04)

Shows "this will install missing software on ~N device(s)" before an
operator arms autoInstall on an existing policy, per spec Risks §2
(arming on a broad policy could otherwise queue thousands of installs
with no warning). Calls GET /software-policies/:id/install-preview
(W06 #5522 Task 2), verified against that wave's own plan doc rather
than assumed. The preview is advisory only: any non-2xx response
(including a 404 if W06 hasn't landed yet) degrades to an
"unavailable" message without blocking the checkbox, since the actual
blast-radius bound is W02's per-pass cap.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz
EOF
)"
```

## Task 3: `ComplianceDashboard` — wire arming into the save flow, honest 403 handling

**Files:**
- Modify: `apps/web/src/components/software/ComplianceDashboard.tsx`
- Modify: `apps/web/src/lib/runActionAllowlist.ts`
- Modify: `apps/web/src/locales/en/policies.json`
- Create: `apps/web/src/components/software/ComplianceDashboard.autoInstall.test.tsx`

**Interfaces:**
- Consumes: `PolicyForm`'s `CatalogOption` type, `catalogItems`/`policyId` props (Task 1/2). Server contract (not yet implemented, per W01): a write that would leave a policy armed for install must hold `devices.execute` + MFA, refusing with `403 { error: 'MFA required', code: 'MFA_REQUIRED' }` for the MFA case, or `403 { error: ARM_INSTALL_EXECUTE_DENIED_MESSAGE, code: 'DEVICES_EXECUTE_REQUIRED' }` for the missing-permission case (both per the cross-wave contract's post-W01 corrections — both refusals are coded, neither is a bare message).
- Produces: nothing new for later tasks in this plan.

- [ ] **Step 1: Write the failing tests (payload correctness)**

Create `apps/web/src/components/software/ComplianceDashboard.autoInstall.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

import ComplianceDashboard from './ComplianceDashboard';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 400): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const OVERVIEW = { total: 0, compliant: 0, violations: 0, unknown: 0 };

function mockEndpoints() {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith('/software-policies/compliance/overview')) return Promise.resolve(json(OVERVIEW));
    if (url.startsWith('/software-policies/violations')) return Promise.resolve(json({ data: [] }));
    if (url.startsWith('/software-policies?')) return Promise.resolve(json({ data: [] }));
    if (url === '/software/catalog') return Promise.resolve(json({ data: [] }));
    if (url === '/software-policies' && (init as RequestInit)?.method === 'POST') {
      return Promise.resolve(json({ id: 'new-1' }));
    }
    return Promise.resolve(json({ data: [] }));
  });
}

function postBody(): Record<string, unknown> {
  const post = fetchMock.mock.calls.find(
    (c) => c[0] === '/software-policies' && (c[1] as RequestInit)?.method === 'POST',
  );
  expect(post).toBeTruthy();
  return JSON.parse((post![1] as RequestInit).body as string);
}

function openCreateAndFill() {
  fireEvent.click(screen.getByText('Create Policy'));
  fireEvent.change(screen.getByPlaceholderText('e.g. Block Unauthorized Software'), {
    target: { value: 'Required Apps' },
  });
  fireEvent.change(screen.getByPlaceholderText('Name *'), { target: { value: 'Zoom' } });
}

describe('ComplianceDashboard — autoInstall arming (#5509)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEndpoints();
  });

  it('sends remediationOptions.autoInstall when armed on an allowlist enforce policy', async () => {
    render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.queryByText('Loading software policy compliance...')).not.toBeInTheDocument());
    openCreateAndFill();
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'allowlist' } });
    fireEvent.click(screen.getByLabelText('Enforce (auto-remediate)'));
    fireEvent.click(screen.getByTestId('policy-auto-install-checkbox'));
    fireEvent.click(screen.getByText('Create Policy', { selector: 'button[type="submit"]' }));
    await waitFor(() => expect(postBody().remediationOptions).toMatchObject({ autoInstall: true }));
  });

  it('omits autoInstall when mode is switched away from allowlist, even if the checkbox had been checked', async () => {
    render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.queryByText('Loading software policy compliance...')).not.toBeInTheDocument());
    openCreateAndFill();
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'allowlist' } });
    fireEvent.click(screen.getByLabelText('Enforce (auto-remediate)'));
    fireEvent.click(screen.getByTestId('policy-auto-install-checkbox'));
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'blocklist' } });
    fireEvent.click(screen.getByText('Create Policy', { selector: 'button[type="submit"]' }));
    await waitFor(() => expect(postBody().remediationOptions?.autoInstall).toBeUndefined());
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/software/ComplianceDashboard.autoInstall.test.tsx`
Expected: FAIL — `getByTestId('policy-auto-install-checkbox')` renders (Task 1 landed), but `postBody().remediationOptions.autoInstall` is `undefined` because `ComplianceDashboard.tsx` doesn't read `values.autoInstall` yet.

- [ ] **Step 3: Implement — types, catalog fetch, payload**

Edit `apps/web/src/components/software/ComplianceDashboard.tsx`. Extend the local `Policy` type:

```tsx
type Policy = {
  id: string;
  name: string;
  description?: string;
  orgId?: string | null;
  partnerId?: string | null;
  mode: "allowlist" | "blocklist" | "audit";
  rules?: {
    software: Array<{
      name: string;
      vendor?: string;
      minVersion?: string;
      maxVersion?: string;
      reason?: string;
      catalogId?: string;
    }>;
    allowUnknown?: boolean;
  };
  isActive: boolean;
  enforceMode: boolean;
  remediationOptions?: {
    autoUninstall?: boolean;
    autoInstall?: boolean;
    gracePeriod?: number;
  } | null;
  createdAt?: string;
  updatedAt?: string;
};
```

Add the catalog-items fetch. Add `asList` to the imports and `useState`/`useEffect` (already imported at top — `useCallback, useEffect, useState` from `"react"`; add nothing new there):

```tsx
import { asList } from "@/lib/asList";
import PolicyForm, { type PolicyFormValues, type CatalogOption } from "./PolicyForm";
```

Inside the component, after the `submitting` state declaration:

```tsx
  const [catalogItems, setCatalogItems] = useState<CatalogOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth("/software/catalog");
        if (!res.ok || cancelled) return;
        const payload = await res.json();
        const rows = asList<Record<string, unknown>>(payload, "catalog");
        const items = rows
          .map((item) => ({
            id: String(item.id ?? ""),
            name: String(item.name ?? ""),
            vendor: item.vendor ? String(item.vendor) : undefined,
          }))
          .filter((item) => item.id.length > 0);
        if (!cancelled) setCatalogItems(items);
      } catch (err) {
        // Non-fatal: the catalog-link picker in PolicyForm just shows no
        // options. The rest of the dashboard (policies, overview,
        // violations) loads independently via refresh() and must not be
        // blanked by a catalog hiccup.
        console.warn(
          "[ComplianceDashboard] Failed to load software catalog for policy linking:",
          err,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
```

Update `policyToFormDefaults`:

```tsx
  const policyToFormDefaults = (policy: Policy): Partial<PolicyFormValues> => ({
    name: policy.name,
    description: policy.description ?? "",
    mode: policy.mode,
    software: policy.rules?.software?.map((s) => ({
      name: s.name,
      vendor: s.vendor ?? "",
      minVersion: s.minVersion ?? "",
      maxVersion: s.maxVersion ?? "",
      reason: s.reason ?? "",
      catalogId: s.catalogId ?? "",
    })) ?? [
      { name: "", vendor: "", minVersion: "", maxVersion: "", reason: "", catalogId: "" },
    ],
    allowUnknown: policy.rules?.allowUnknown ?? false,
    enforceMode: policy.enforceMode,
    autoUninstall: policy.remediationOptions?.autoUninstall ?? false,
    autoInstall: policy.remediationOptions?.autoInstall ?? false,
    gracePeriod: policy.remediationOptions?.gracePeriod ?? 24,
  });
```

Update the `remediationOptions` construction inside `handleFormSubmit` (leave the surrounding function structure as-is for this step — Step 3 of Task 3 only fixes the payload; Step 7 below migrates the transport):

```tsx
        remediationOptions: values.enforceMode
          ? {
              autoUninstall: values.autoUninstall,
              // Arming is meaningless outside allowlist mode — only
              // allowlist rules ever produce a 'missing' violation
              // (softwarePolicyService.ts emits it only for allowlist rule
              // mismatches). Guard here so a stale `true` react-hook-form
              // kept from before the operator switched mode away from
              // allowlist (the checkbox unmounts but RHF retains its last
              // value) never reaches the server. Mirrors the allowUnknown
              // guard two lines above in the rules block.
              autoInstall: values.mode === "allowlist" ? values.autoInstall : undefined,
              gracePeriod: values.gracePeriod,
            }
          : undefined,
```

Also update the `rules.software` mapping a few lines above it, to forward `catalogId`:

```tsx
        rules: {
          software: values.software.map((s) => ({
            name: s.name,
            vendor: s.vendor || undefined,
            minVersion: s.minVersion || undefined,
            maxVersion: s.maxVersion || undefined,
            reason: s.reason || undefined,
            catalogId: s.catalogId || undefined,
          })),
          allowUnknown:
            values.mode === "allowlist" ? values.allowUnknown : undefined,
        },
```

Pass the new props to `PolicyForm` in the create/edit modal JSX:

```tsx
              <PolicyForm
                key={selectedPolicy?.id ?? "create"}
                onSubmit={handleFormSubmit}
                onCancel={closeModal}
                defaultValues={
                  modalMode === "edit" && selectedPolicy
                    ? policyToFormDefaults(selectedPolicy)
                    : { ownerScope: defaultOwnerScope }
                }
                submitLabel={
                  modalMode === "create"
                    ? i18n.t("policies:software.complianceDashboard.createPolicy")
                    : i18n.t("policies:software.complianceDashboard.updatePolicy")
                }
                loading={submitting}
                showOwnerScope={modalMode === "create" && isPartnerScope}
                policyId={modalMode === "edit" ? (selectedPolicy?.id || undefined) : undefined}
                catalogItems={catalogItems}
              />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/software/ComplianceDashboard.autoInstall.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing tests (honest 403 handling)**

Append to `apps/web/src/components/software/ComplianceDashboard.autoInstall.test.tsx`:

```tsx
describe('ComplianceDashboard — honest 403 refusal on arming (#5509)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the MFA-required friendly message on a 403 MFA_REQUIRED refusal, and keeps the modal open', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/software-policies' && (init as RequestInit)?.method === 'POST') {
        return Promise.resolve(json({ error: 'MFA required', code: 'MFA_REQUIRED' }, false, 403));
      }
      if (url.startsWith('/software-policies/compliance/overview')) return Promise.resolve(json(OVERVIEW));
      if (url.startsWith('/software-policies/violations')) return Promise.resolve(json({ data: [] }));
      if (url.startsWith('/software-policies?')) return Promise.resolve(json({ data: [] }));
      if (url === '/software/catalog') return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({ data: [] }));
    });
    render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.queryByText('Loading software policy compliance...')).not.toBeInTheDocument());
    openCreateAndFill();
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'allowlist' } });
    fireEvent.click(screen.getByLabelText('Enforce (auto-remediate)'));
    fireEvent.click(screen.getByTestId('policy-auto-install-checkbox'));
    fireEvent.click(screen.getByText('Create Policy', { selector: 'button[type="submit"]' }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('multi-factor authentication'),
        }),
      ),
    );
    // Modal stayed open — the create form is still on screen.
    expect(screen.getByText('Create Software Policy')).toBeInTheDocument();
  });

  it('shows the devices.execute-permission friendly message on a 403 DEVICES_EXECUTE_REQUIRED refusal', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/software-policies' && (init as RequestInit)?.method === 'POST') {
        return Promise.resolve(
          json(
            { error: 'Arming automatic install requires devices.execute', code: 'DEVICES_EXECUTE_REQUIRED' },
            false,
            403,
          ),
        );
      }
      if (url.startsWith('/software-policies/compliance/overview')) return Promise.resolve(json(OVERVIEW));
      if (url.startsWith('/software-policies/violations')) return Promise.resolve(json({ data: [] }));
      if (url.startsWith('/software-policies?')) return Promise.resolve(json({ data: [] }));
      if (url === '/software/catalog') return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({ data: [] }));
    });
    render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.queryByText('Loading software policy compliance...')).not.toBeInTheDocument());
    openCreateAndFill();
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'allowlist' } });
    fireEvent.click(screen.getByLabelText('Enforce (auto-remediate)'));
    fireEvent.click(screen.getByTestId('policy-auto-install-checkbox'));
    fireEvent.click(screen.getByText('Create Policy', { selector: 'button[type="submit"]' }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('devices.execute'),
        }),
      ),
    );
    expect(screen.getByText('Create Software Policy')).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/software/ComplianceDashboard.autoInstall.test.tsx`
Expected: FAIL — the current `handleFormSubmit` shows `err.message`, which for the MFA case is the raw server string `"MFA required"` (not the friendly copy containing "multi-factor authentication") and for the `DEVICES_EXECUTE_REQUIRED` case is whatever raw `error` string the server sent, with no `code`-aware mapping at all — both new tests fail their message-content assertions.

- [ ] **Step 7: Implement — migrate `handleFormSubmit` to `runAction`**

Add the import at the top of `apps/web/src/components/software/ComplianceDashboard.tsx`:

```tsx
import { runAction, ActionError } from "@/lib/runAction";
```

Replace the whole `handleFormSubmit` function:

```tsx
  // Both arming-refusal codes are coded 403s per the cross-wave contract
  // (post-W01 correction): MFA_REQUIRED from the existing requireMfa()
  // gate, DEVICES_EXECUTE_REQUIRED from assertMayArmInstall's own
  // permission check ({ error: ARM_INSTALL_EXECUTE_DENIED_MESSAGE, code:
  // 'DEVICES_EXECUTE_REQUIRED' }). Neither is a bare, uncoded message, so
  // both get an explicit friendly mapping rather than falling through to
  // the server's raw string for one of the two.
  const armInstallFriendly = (code: string) => {
    if (code === "MFA_REQUIRED") {
      return i18n.t("policies:software.complianceDashboard.armInstallRequiresMfa");
    }
    if (code === "DEVICES_EXECUTE_REQUIRED") {
      return i18n.t("policies:software.complianceDashboard.armInstallRequiresPermission");
    }
    return undefined;
  };

  const handleFormSubmit = async (values: PolicyFormValues) => {
    setSubmitting(true);
    const isEdit = modalMode === "edit" && selectedPolicy;
    const body = {
      name: values.name,
      description: values.description || undefined,
      mode: values.mode,
      // Ownership is immutable after create — only send the intent on create.
      // The server derives the partner from the caller's own token (#2126).
      ownerScope: modalMode === "create" ? values.ownerScope : undefined,
      rules: {
        software: values.software.map((s) => ({
          name: s.name,
          vendor: s.vendor || undefined,
          minVersion: s.minVersion || undefined,
          maxVersion: s.maxVersion || undefined,
          reason: s.reason || undefined,
          catalogId: s.catalogId || undefined,
        })),
        allowUnknown:
          values.mode === "allowlist" ? values.allowUnknown : undefined,
      },
      enforceMode: values.enforceMode,
      remediationOptions: values.enforceMode
        ? {
            autoUninstall: values.autoUninstall,
            autoInstall: values.mode === "allowlist" ? values.autoInstall : undefined,
            gracePeriod: values.gracePeriod,
          }
        : undefined,
    };
    const url = isEdit
      ? `/software-policies/${selectedPolicy.id}`
      : "/software-policies";
    const method = isEdit ? "PATCH" : "POST";
    try {
      await runAction({
        request: () => fetchWithAuth(url, { method, body: JSON.stringify(body) }),
        errorFallback: i18n.t(
          /* i18n-dynamic */ isEdit
            ? "policies:software.complianceDashboard.failedToUpdatePolicy"
            : "policies:software.complianceDashboard.failedToCreatePolicy",
        ),
        friendly: armInstallFriendly,
        successMessage: i18n.t(
          /* i18n-dynamic */ isEdit
            ? "policies:software.complianceDashboard.policyUpdated"
            : "policies:software.complianceDashboard.policyCreated",
        ),
      });
    } catch (err) {
      // runAction already toasted an ActionError (including the friendly
      // MFA_REQUIRED copy above, or the server's raw message for any other
      // refusal — never a silent no-op). A non-ActionError (e.g. a bug in
      // parseSuccess) still needs its own toast.
      if (!(err instanceof ActionError)) {
        showToast({ type: "error", message: "Failed to save policy" });
      }
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    setModalMode("closed");
    setSelectedPolicy(null);
    // The save genuinely succeeded — a throw from refresh() must not read
    // back as a failed save (runAction's own catch above already handled
    // that case).
    try {
      await refresh();
    } catch (err) {
      console.error(
        "[ComplianceDashboard] refresh() failed after a successful policy save",
        err,
      );
    }
  };
```

Add the new key to `apps/web/src/locales/en/policies.json`. Find the `complianceDashboard` section's last key (`"policyCreated": "Policy created successfully"` at line 1353, immediately before that object's closing `},`) and insert before it:

```json
      "policyCreated": "Policy created successfully",
      "armInstallRequiresMfa": "Arming automatic install requires multi-factor authentication. Complete MFA, then try again.",
      "armInstallRequiresPermission": "Arming automatic install requires the devices.execute permission. Ask an administrator to grant it, then try again."
```

Finally, record the partial `runAction` migration in `apps/web/src/lib/runActionAllowlist.ts`. Add to `RUN_ACTION_MIGRATION_BACKLOG`, matching the array's existing comment convention:

```ts
  // ComplianceDashboard.tsx: handleFormSubmit (policy create/update, the
  // handler that arms autoInstall — #5505 W04) migrated to runAction.
  // handleConfirmDelete / handleCheckCompliance / handleRemediate remain on
  // bare fetchWithAuth — out of this wave's scope. Not yet added to
  // TARGET_GLOBS: doing so would flag those three untouched handlers.
  'apps/web/src/components/software/ComplianceDashboard.tsx',
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/software/ComplianceDashboard.autoInstall.test.tsx`
Expected: PASS (4 tests total across both `describe` blocks).

- [ ] **Step 9: Run the full ComplianceDashboard suite to check for regressions**

Run: `cd apps/web && npx vitest run src/components/software/ComplianceDashboard.ownerScope.test.tsx src/components/software/ComplianceDashboard.autoInstall.test.tsx`
Expected: PASS (both files).

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/software/ComplianceDashboard.tsx \
        apps/web/src/components/software/ComplianceDashboard.autoInstall.test.tsx \
        apps/web/src/lib/runActionAllowlist.ts \
        apps/web/src/locales/en/policies.json
git commit -m "$(cat <<'EOF'
feat(web): ComplianceDashboard — wire autoInstall arming into policy save, honest 403 handling (#5505 W04)

Fetches the software catalog for PolicyForm's new catalog-link picker
(non-fatal on failure), forwards catalogId + autoInstall through the
policy create/update payload with the same allowlist-only guard the
existing allowUnknown field already uses, and migrates handleFormSubmit
to runAction so a 403 refusal (MFA_REQUIRED, or DEVICES_EXECUTE_REQUIRED
from the server-side assertMayArmInstall gate W01 ships) always surfaces
a friendly, code-specific message to the operator and the modal stays
open for retry — never a silent no-op, per CLAUDE.md's runAction
contract.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz
EOF
)"
```

## Task 4: `ComplianceDashboard` — surface install-remediation status per device

**Scope addition from the coordinator, added after this plan's first draft.** Spec Risks §1 requires the consecutive-attempt give-up counter to be "visible in the UI" — the plan as first written never rendered any of W02's three `software_compliance_status` columns, so a technician had no way to see that a device had silently stopped being auto-installed. W06 (#5522), Task 3, widens `GET /software-policies/violations`'s existing compliance projection (`apps/api/src/routes/softwarePolicies.ts:481-488`) to carry them. This task consumes that.

**Files:**
- Modify: `apps/web/src/components/software/ComplianceDashboard.tsx`
- Modify: `apps/web/src/locales/en/policies.json`
- Modify: `apps/web/src/components/software/ComplianceDashboard.autoInstall.test.tsx`

**Interfaces:**
- Consumes: `GET /software-policies/violations` response rows' `compliance.installRemediationStatus: string | null`, `compliance.lastInstallRemediationAttempt: string | null`, `compliance.installRemediationAttempts: number` — **W06 Task 3**, field names verified in Step 1 below against W06's own plan doc, not assumed. Also `compliance.violations[].rule.catalogId?: string` — **W01, contract D9** — already flowing through this same route's pre-existing `violations` field regardless of W06, since W06 Task 3 does not touch that field.
- Produces: nothing consumed by a later task in this plan.

### 4.0 Ground truth for this task

`ViolationRow` (`apps/web/src/components/software/ComplianceDashboard.tsx:53-66`), unmodified by Tasks 1-3:
```
53: type ViolationRow = {
54:   device: {
55:     id: string;
56:     hostname: string;
57:   };
58:   compliance: {
59:     policyId: string;
60:     violations?: Array<{
61:       type: string;
62:     }>;
63:     remediationStatus?: string;
64:     lastChecked: string;
65:   };
66: };
```

The "Recent Violations" render block (`:619-643`), the only place `remediationStatus` is rendered anywhere in `apps/web/src` today (confirmed: `grep -rln "remediationStatus" apps/web/src` returns exactly this one file) — the pattern this task extends rather than inventing a new one:
```
619:  {violations.map((row) => (
620:    <div
621:      key={`${row.compliance.policyId}:${row.device.id}`}
622:      className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
623:    >
624:      <div>
625:        <p className="font-medium">{row.device.hostname}</p>
626:        <p className="text-xs text-muted-foreground">
627:          {Array.isArray(row.compliance.violations)
628:            ? row.compliance.violations.length
629:            : 0}{" "}
630:          {i18n.t("policies:software.complianceDashboard.violationS")}
631:        </p>
632:      </div>
633:      <div className="text-xs text-muted-foreground">
634:        {i18n.t("policies:software.complianceDashboard.remediation")}
635:        {row.compliance.remediationStatus ??
636:          i18n.t("policies:software.complianceDashboard.none")}
637:      </div>
638:      <div className="text-xs text-muted-foreground">
639:        {i18n.t("policies:software.complianceDashboard.checked")}
640:        {formatDateTime(row.compliance.lastChecked)}
641:      </div>
642:    </div>
643:  ))}
```

**Why `'skipped'` cannot be fully disambiguated from data alone — read before implementing.** W02's plan doc (`docs/superpowers/plans/vuln-patch/2026-09-10-desired-state-software-install-w02-compliance-worker.md:542-560`) defines `SoftwarePolicyInstallRemediationStatus` and documents that a single `'skipped'` value covers THREE causes — "the rule carries no catalogId ..., the per-pass cap was reached, or (W03) the catalog item has no install method for this device's OS" — and **no column persists which of the three fired**; `installRemediationAttempts`/`installRemediationStatus` are the only two install-specific fields on the row. Of the three causes, exactly one is reconstructable from data this route already returns: whether the device's own `missing` violation lacks a `catalogId` (visible via `compliance.violations[].rule.catalogId`, W01 D9). The other two — per-pass cap and platform mismatch — have no per-device signal anywhere in the projected response. This task therefore gives the no-catalogId case a specific, actionable explanation (pointing at the exact fix — Task 1's new catalog-link picker) and gives the other two a single honest, hedged sentence, rather than fabricating certainty the data does not support. **This is a further gap worth flagging to the coordinator**, same as the dry-run endpoint: a future wave could add a persisted skip-reason column for full precision.

- [ ] **Step 1: Verify W06 Task 3's projected field names (or proceed in degraded mode)**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
grep -n "installRemediationStatus\|lastInstallRemediationAttempt\|installRemediationAttempts" apps/api/src/routes/softwarePolicies.ts
```

Expected, per W06's plan (`docs/superpowers/plans/vuln-patch/2026-09-10-desired-state-software-install-w06-install-preview-endpoint.md`, Task 3 Step 4), inside `GET /violations`'s existing `compliance` projection:
```ts
installRemediationStatus: softwareComplianceStatus.installRemediationStatus,
lastInstallRemediationAttempt: softwareComplianceStatus.lastInstallRemediationAttempt,
installRemediationAttempts: softwareComplianceStatus.installRemediationAttempts,
```

Unlike W03's dependency on W01/W02 (a compile-time TypeScript import that cannot proceed at all without the real export name), this is a runtime JSON field on an HTTP response, and every render this task adds is already gated on `row.compliance.installRemediationStatus` being present and truthy (Step 3 below). Three outcomes:
- **Grep finds exactly these three fields:** confirmed — proceed with implementation exactly as written below.
- **Grep finds nothing:** W06 has not landed yet. This is expected and does not block this task — proceed with implementation exactly as written below. The new UI renders nothing extra (the same as today) until W06 ships the projection, then lights up with no further code change, because the gate is "is the field present and non-`'none'`", not "does the field exist in the type".
- **Grep finds different field names than the three above:** W06 landed under a different contract than its own plan doc promised. **Stop this task and reconcile against the real names** — do not silently rename to match; report the mismatch.

- [ ] **Step 2: Write the failing tests**

Append to `apps/web/src/components/software/ComplianceDashboard.autoInstall.test.tsx`:

```tsx
describe('ComplianceDashboard — install-remediation status display (#5509, coordinator scope addition)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockViolationsWith(complianceOverrides: Record<string, unknown>) {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/software-policies/compliance/overview')) return Promise.resolve(json(OVERVIEW));
      if (url.startsWith('/software-policies/violations')) {
        return Promise.resolve(
          json({
            data: [
              {
                device: { id: 'dev-1', hostname: 'workstation-1' },
                compliance: {
                  policyId: 'pol-1',
                  violations: [{ type: 'missing', rule: { name: 'Zoom' } }],
                  lastChecked: '2026-09-10T10:00:00Z',
                  ...complianceOverrides,
                },
              },
            ],
          }),
        );
      }
      if (url.startsWith('/software-policies?')) return Promise.resolve(json({ data: [] }));
      if (url === '/software/catalog') return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({ data: [] }));
    });
  }

  it('renders nothing extra when installRemediationStatus is absent', async () => {
    mockViolationsWith({});
    render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.queryByText('Loading software policy compliance...')).not.toBeInTheDocument());
    expect(screen.queryByTestId('install-remediation-dev-1')).not.toBeInTheDocument();
  });

  it("shows 'gave_up' as a visually distinct terminal state (not styled like 'failed'), with the consecutive attempt count", async () => {
    mockViolationsWith({ installRemediationStatus: 'gave_up', installRemediationAttempts: 3 });
    render(<ComplianceDashboard />);
    const block = await screen.findByTestId('install-remediation-dev-1');
    expect(block).toHaveTextContent('Gave up after repeated failures');
    expect(block).toHaveTextContent('3 attempt(s)');
    const badge = screen.getByText('Gave up after repeated failures');
    expect(badge.className).toContain('text-destructive');
    expect(badge.className).not.toContain('text-amber-700');
  });

  it('shows the last install-attempt time when present', async () => {
    mockViolationsWith({
      installRemediationStatus: 'failed',
      lastInstallRemediationAttempt: '2026-09-10T09:30:00Z',
    });
    const block = await screen.findByTestId('install-remediation-dev-1');
    expect(block).toHaveTextContent('Last install attempt:');
  });

  it('explains a skipped device with a missing catalog link distinctly from the generic cap/platform hedge', async () => {
    mockViolationsWith({
      installRemediationStatus: 'skipped',
      violations: [{ type: 'missing', rule: { name: 'Zoom' } }], // no catalogId
    });
    const block = await screen.findByTestId('install-remediation-dev-1');
    expect(block).toHaveTextContent('has no linked catalog item');
  });

  it('falls back to the generic cap/platform hedge for a skipped device whose rule already has a catalog link', async () => {
    mockViolationsWith({
      installRemediationStatus: 'skipped',
      violations: [{ type: 'missing', rule: { name: 'Zoom', catalogId: 'cat-1' } }],
    });
    const block = await screen.findByTestId('install-remediation-dev-1');
    expect(block).toHaveTextContent('per-pass install cap');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/software/ComplianceDashboard.autoInstall.test.tsx`
Expected: FAIL — `getByTestId('install-remediation-dev-1')` not found in every test that expects it; `ViolationRow` doesn't carry the new fields yet so nothing renders.

- [ ] **Step 4: Implement**

Edit `apps/web/src/components/software/ComplianceDashboard.tsx`. Extend `ViolationRow`:

```tsx
type ViolationRow = {
  device: {
    id: string;
    hostname: string;
  };
  compliance: {
    policyId: string;
    violations?: Array<{
      type: string;
      rule?: {
        catalogId?: string;
      };
    }>;
    remediationStatus?: string;
    installRemediationStatus?: string;
    lastInstallRemediationAttempt?: string;
    installRemediationAttempts?: number;
    lastChecked: string;
  };
};
```

Add module-level constants and helpers (placed near `parsePolicyMode`, before the component — pure functions, no component state needed):

```tsx
const installStatusLabelKeys: Record<string, string> = {
  pending: "policies:software.complianceDashboard.installStatusPending",
  in_progress: "policies:software.complianceDashboard.installStatusInProgress",
  completed: "policies:software.complianceDashboard.installStatusCompleted",
  failed: "policies:software.complianceDashboard.installStatusFailed",
  gave_up: "policies:software.complianceDashboard.installStatusGaveUp",
  skipped: "policies:software.complianceDashboard.installStatusSkipped",
};

const installStatusBadgeStyles: Record<string, string> = {
  pending: "bg-blue-100 text-blue-700",
  in_progress: "bg-blue-100 text-blue-700",
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-amber-100 text-amber-700",
  // 'gave_up' is a distinct terminal state from 'failed' (spec Risks §1: the
  // install-loop guard's give-up state must be visible, not just another
  // shade of "broken") — destructive red instead of amber so it reads as
  // "Breeze stopped trying", not "one attempt failed".
  gave_up: "bg-destructive/10 text-destructive",
  skipped: "bg-slate-100 text-slate-600",
};

function installStatusBadgeClass(status: string): string {
  return installStatusBadgeStyles[status] ?? installStatusBadgeStyles.failed;
}

// A 'skipped' status collapses three causes W02 does not persist separately
// (see this task's Ground Truth — no column stores WHICH one fired): no
// catalogId on the rule, the per-pass cap, or no install method for the
// device's platform (W03). Of those three, only the first is reconstructable
// from data already on this row — the violation's own rule carries catalogId
// (W01, contract D9) — so that is the only case given a specific, actionable
// explanation. The other two collapse into one honest, hedged sentence
// rather than a false claim of precision this data can't support.
function installSkipHasMissingCatalogLink(row: ViolationRow): boolean {
  return (row.compliance.violations ?? []).some(
    (violation) => violation.type === "missing" && !violation.rule?.catalogId,
  );
}
```

Insert a new block between the existing "Remediation:" `<div>` (`:633-637`) and the "Checked:" `<div>` (`:638-641`):

```tsx
              <div className="text-xs text-muted-foreground">
                {i18n.t("policies:software.complianceDashboard.remediation")}
                {row.compliance.remediationStatus ??
                  i18n.t("policies:software.complianceDashboard.none")}
              </div>
              {row.compliance.installRemediationStatus &&
                row.compliance.installRemediationStatus !== "none" && (
                  <div
                    className="flex flex-col items-start gap-1 text-xs text-muted-foreground sm:items-end"
                    data-testid={`install-remediation-${row.device.id}`}
                  >
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${installStatusBadgeClass(
                        row.compliance.installRemediationStatus,
                      )}`}
                    >
                      {i18n.t(
                        /* i18n-dynamic */ installStatusLabelKeys[
                          row.compliance.installRemediationStatus
                        ] ?? installStatusLabelKeys.failed,
                      )}
                    </span>
                    {row.compliance.installRemediationStatus === "skipped" && (
                      <span>
                        {installSkipHasMissingCatalogLink(row)
                          ? i18n.t(
                              "policies:software.complianceDashboard.installSkippedNoCatalog",
                            )
                          : i18n.t(
                              "policies:software.complianceDashboard.installSkippedCapOrPlatform",
                            )}
                      </span>
                    )}
                    {!!row.compliance.installRemediationAttempts && (
                      <span>
                        {i18n.t(
                          "policies:software.complianceDashboard.installAttempts",
                          { count: row.compliance.installRemediationAttempts },
                        )}
                      </span>
                    )}
                    {row.compliance.lastInstallRemediationAttempt && (
                      <span>
                        {i18n.t(
                          "policies:software.complianceDashboard.installLastAttempt",
                        )}
                        {formatDateTime(row.compliance.lastInstallRemediationAttempt)}
                      </span>
                    )}
                  </div>
                )}
              <div className="text-xs text-muted-foreground">
                {i18n.t("policies:software.complianceDashboard.checked")}
                {formatDateTime(row.compliance.lastChecked)}
              </div>
```

Add the ten new keys to `apps/web/src/locales/en/policies.json`, in the `complianceDashboard` object, after the two keys Task 3 added (`"armInstallRequiresPermission"` is now the last key before the object's closing `},`):

```json
      "armInstallRequiresPermission": "Arming automatic install requires the devices.execute permission. Ask an administrator to grant it, then try again.",
      "installStatusPending": "Install queued",
      "installStatusInProgress": "Installing…",
      "installStatusCompleted": "Installed",
      "installStatusFailed": "Install failed",
      "installStatusGaveUp": "Gave up after repeated failures",
      "installStatusSkipped": "Skipped this pass",
      "installSkippedNoCatalog": "A required rule has no linked catalog item, so there's nothing to install. Add a catalog link in the policy editor to fix this.",
      "installSkippedCapOrPlatform": "Not a failure — either the per-pass install cap was reached or this device's platform has no install method for the software. May be attempted again next pass.",
      "installAttempts": "{{count}} attempt(s)",
      "installLastAttempt": "Last install attempt: "
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/software/ComplianceDashboard.autoInstall.test.tsx`
Expected: PASS (9 tests total across all three `describe` blocks in the file).

- [ ] **Step 6: Run the full ComplianceDashboard suite to check for regressions**

Run: `cd apps/web && npx vitest run src/components/software/ComplianceDashboard.ownerScope.test.tsx src/components/software/ComplianceDashboard.autoInstall.test.tsx`
Expected: PASS (both files).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/software/ComplianceDashboard.tsx \
        apps/web/src/components/software/ComplianceDashboard.autoInstall.test.tsx \
        apps/web/src/locales/en/policies.json
git commit -m "$(cat <<'EOF'
feat(web): surface install-remediation status per device in the compliance view (#5505 W04, coordinator scope addition)

Spec Risks §1 requires the install-loop give-up counter to be "visible
in the UI"; nothing did that until now. Renders a status badge (queued
/ installing / installed / failed / skipped / gave up) per device in
the Recent Violations list, giving 'gave_up' distinct destructive
styling rather than another shade of "failed" so the give-up state
reads as terminal, not transient. Shows the consecutive attempt count
when non-zero and the last-attempt time. For 'skipped' — which W02
collapses three causes into (no catalogId, the per-pass cap, or no
install method for the platform) with no persisted sub-reason — gives
the one case reconstructable from already-projected data (no catalogId
on the violation's own rule) a specific, actionable explanation, and
hedges honestly on the other two rather than fabricating certainty.
Consumes W06 Task 3's widened GET /violations projection; degrades to
rendering nothing extra (today's behavior) if W06 has not landed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz
EOF
)"
```

## Task 5: `DeploymentList` — "Policy-owned" badge

**Files:**
- Modify: `apps/web/src/components/software/DeploymentList.tsx`
- Modify: `apps/web/src/locales/en/policies.json`
- Create: `apps/web/src/components/software/DeploymentList.policyOwned.test.tsx`

**Interfaces:**
- Consumes: `software_policy_id` on `GET /software/deployments` rows, produced by W03 (flows automatically per the Global Constraints note — no API change needed in this wave).
- Produces: nothing consumed elsewhere in this plan.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/software/DeploymentList.policyOwned.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import DeploymentList from "./DeploymentList";
import { fetchWithAuth } from "../../stores/auth";

vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
vi.mock("../shared/Toast", () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const jsonResponse = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: "OK", json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const POLICY_OWNED = {
  id: "dep-policy-1",
  orgId: "org-1",
  name: "Required Apps — auto-install",
  scheduleType: "immediate",
  createdAt: "2026-09-10T10:00:00Z",
  status: "pending",
  softwarePolicyId: "pol-1",
  counts: { pending: 3, inProgress: 0, completed: 0, failed: 0, cancelled: 0, total: 3 },
};

const MANUAL = {
  id: "dep-manual-1",
  orgId: "org-1",
  name: "Chrome Rollout",
  scheduleType: "immediate",
  createdAt: "2026-09-10T09:00:00Z",
  status: "pending",
  softwarePolicyId: null,
  counts: { pending: 1, inProgress: 0, completed: 0, failed: 0, cancelled: 0, total: 1 },
};

describe("DeploymentList — policy-owned badge (#5509)", () => {
  it("labels a policy-originated deployment as policy-owned", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [POLICY_OWNED, MANUAL], pagination: { page: 1, limit: 20, total: 2 } }),
    );
    render(<DeploymentList />);
    await waitFor(() => expect(screen.getByTestId("deployment-row-dep-policy-1")).toBeInTheDocument());
    expect(screen.getByTestId("deployment-policy-owned-dep-policy-1")).toHaveTextContent("Policy-owned");
    expect(screen.queryByTestId("deployment-policy-owned-dep-manual-1")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/software/DeploymentList.policyOwned.test.tsx`
Expected: FAIL — `getByTestId("deployment-policy-owned-dep-policy-1")` not found.

- [ ] **Step 3: Implement**

Edit `apps/web/src/components/software/DeploymentList.tsx`. Add `ShieldCheck` to the lucide-react import:

```tsx
import {
  AlertTriangle,
  CheckCircle,
  Loader2,
  PlayCircle,
  ShieldCheck,
  XCircle,
} from "lucide-react";
```

Extend `DeploymentRow`:

```tsx
type DeploymentRow = {
  id: string;
  orgId?: string;
  name: string;
  deploymentType?: string;
  scheduleType: string;
  scheduledAt?: string | null;
  createdAt: string;
  status: SoftwareDeploymentAggregateStatus;
  counts: SoftwareDeploymentCounts;
  /** Set when this deployment was created by policy remediation rather than
   *  a human operator (software_policy_id on software_deployments, #5505
   *  W03). Null/undefined for an ordinary manual deployment. */
  softwarePolicyId?: string | null;
};
```

Replace the Name column's `<td>` body:

```tsx
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-foreground">
                              {item.name}
                            </p>
                            {item.softwarePolicyId && (
                              <span
                                className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                                title={i18n.t(
                                  "policies:software.deploymentList.policyOwnedTooltip",
                                )}
                                data-testid={`deployment-policy-owned-${item.id}`}
                              >
                                <ShieldCheck className="h-3 w-3" />
                                {i18n.t("policies:software.deploymentList.policyOwned")}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {item.id}
                          </p>
                        </td>
```

Add the two new keys to `apps/web/src/locales/en/policies.json`. Find the `deploymentList` section's last key (`"managerUnavailableSummary_other"` at line 1428, immediately before that object's closing `},`) and insert before it:

```json
      "managerUnavailableSummary_other": "{{count}} devices are missing their package manager. This is a one-time device setup task — install winget (Windows) or Homebrew (macOS) on them; until then every package-manager deployment to them will fail.",
      "policyOwned": "Policy-owned",
      "policyOwnedTooltip": "Created automatically by a software policy's auto-install remediation"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/software/DeploymentList.policyOwned.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the existing DeploymentList suite to check for regressions**

Run: `cd apps/web && npx vitest run src/components/software/DeploymentList.test.tsx src/components/software/DeploymentList.policyOwned.test.tsx`
Expected: PASS (both files).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/software/DeploymentList.tsx \
        apps/web/src/components/software/DeploymentList.policyOwned.test.tsx \
        apps/web/src/locales/en/policies.json
git commit -m "$(cat <<'EOF'
feat(web): DeploymentList — label policy-owned deployments (#5505 W04)

Renders a "Policy-owned" badge next to any deployment whose
software_policy_id is set (W03's new column on software_deployments),
so a technician can tell a policy-remediation-created deployment apart
from one they created by hand. No API change needed: GET
/software/deployments already wildcard-selects the row and will
include the new column once W03 lands.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz
EOF
)"
```

## Task 6: Locale parity — backfill the 7 non-English locales

**Files:**
- Modify: `apps/web/src/locales/de-DE/policies.json`
- Modify: `apps/web/src/locales/es-419/policies.json`
- Modify: `apps/web/src/locales/fr-CA/policies.json`
- Modify: `apps/web/src/locales/fr-FR/policies.json`
- Modify: `apps/web/src/locales/it-IT/policies.json`
- Modify: `apps/web/src/locales/pt-BR/policies.json`
- Modify: `apps/web/src/locales/tr-TR/policies.json`

**Interfaces:**
- Consumes: the 22 keys added to `en/policies.json` across Tasks 1-5 — `policyForm`: `catalogLink`, `catalogLinkNone`, `autoInstall`, `autoInstallCatalogWarning`, `dryRunLoading`, `dryRunResult`, `dryRunUnavailable`, `dryRunNewPolicy` (8, Tasks 1-2); `complianceDashboard`: `armInstallRequiresMfa`, `armInstallRequiresPermission` (Task 3), `installStatusPending`, `installStatusInProgress`, `installStatusCompleted`, `installStatusFailed`, `installStatusGaveUp`, `installStatusSkipped`, `installSkippedNoCatalog`, `installSkippedCapOrPlatform`, `installAttempts`, `installLastAttempt` (10, Task 4) — 12 total; `deploymentList`: `policyOwned`, `policyOwnedTooltip` (2, Task 5).
- Produces: nothing — this is the plan's final consolidation task.

- [ ] **Step 1: Run `localeParity.test.ts` to confirm it is currently red**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts`
Expected: FAIL — each of the 7 non-English locale files is missing the 22 keys Tasks 1-5 added to `en/policies.json`.

- [ ] **Step 2: Add the keys to `de-DE/policies.json`**

In the `complianceDashboard` object, after `"policyCreated": "Richtlinie erfolgreich erstellt"` (immediately before that object's closing `},`):

```json
      "policyCreated": "Richtlinie erfolgreich erstellt",
      "armInstallRequiresMfa": "Die Aktivierung der automatischen Installation erfordert Multi-Faktor-Authentifizierung. Schließen Sie die MFA ab und versuchen Sie es erneut.",
      "armInstallRequiresPermission": "Die Aktivierung der automatischen Installation erfordert die Berechtigung devices.execute. Bitten Sie einen Administrator, sie zu erteilen, und versuchen Sie es dann erneut.",
      "installStatusPending": "Installation eingereiht",
      "installStatusInProgress": "Wird installiert…",
      "installStatusCompleted": "Installiert",
      "installStatusFailed": "Installation fehlgeschlagen",
      "installStatusGaveUp": "Nach wiederholten Fehlschlägen aufgegeben",
      "installStatusSkipped": "Diesen Durchlauf übersprungen",
      "installSkippedNoCatalog": "Eine erforderliche Regel hat keinen verknüpften Katalogeintrag, daher gibt es nichts zu installieren. Fügen Sie im Richtlinien-Editor eine Katalogverknüpfung hinzu, um dies zu beheben.",
      "installSkippedCapOrPlatform": "Kein Fehler — entweder wurde die Installationsobergrenze pro Durchlauf erreicht, oder für die Plattform dieses Geräts gibt es keine Installationsmethode für die Software. Wird eventuell im nächsten Durchlauf erneut versucht.",
      "installAttempts": "{{count}} Versuch(e)",
      "installLastAttempt": "Letzter Installationsversuch: "
```

In the `deploymentList` object, after `"managerUnavailableSummary_other": "Auf {{count}} Geräten fehlt der Paketmanager. Das ist eine einmalige Geräteeinrichtung – installieren Sie dort winget (Windows) oder Homebrew (macOS); bis dahin schlägt jede Paketmanager-Bereitstellung darauf fehl."`:

```json
      "policyOwned": "Richtliniengesteuert",
      "policyOwnedTooltip": "Automatisch erstellt durch die Auto-Installations-Remediation einer Softwarerichtlinie"
```

In the `policyForm` object, after `"saving": "Speichern..."`:

```json
      "catalogLink": "Verknüpfter Katalogeintrag",
      "catalogLinkNone": "Keiner — nicht verknüpft",
      "autoInstall": "Fehlende Software automatisch installieren",
      "autoInstallCatalogWarning": "{{count}} von {{total}} Regel(n) haben keinen verknüpften Katalogeintrag und werden als fehlend erkannt, aber nie installiert.",
      "dryRunLoading": "Wird geprüft, wie viele Geräte betroffen sind...",
      "dryRunResult": "Dies installiert fehlende Software auf etwa {{count}} Gerät(en).",
      "dryRunUnavailable": "Die Geräteanzahl-Vorschau ist noch nicht verfügbar. Die Aktivierung wirkt trotzdem beim nächsten Compliance-Durchlauf.",
      "dryRunNewPolicy": "Dies ist eine neue Richtlinie — die Auswirkung auf Geräte ist erst nach dem ersten Compliance-Durchlauf nach dem Speichern bekannt."
```

- [ ] **Step 3: Add the keys to `es-419/policies.json`**

`complianceDashboard`, after `"policyCreated": "Política creada exitosamente"`:

```json
      "policyCreated": "Política creada exitosamente",
      "armInstallRequiresMfa": "Activar la instalación automática requiere autenticación multifactor. Complete la MFA y vuelva a intentarlo.",
      "armInstallRequiresPermission": "Activar la instalación automática requiere el permiso devices.execute. Pida a un administrador que lo conceda y vuelva a intentarlo.",
      "installStatusPending": "Instalación en cola",
      "installStatusInProgress": "Instalando…",
      "installStatusCompleted": "Instalado",
      "installStatusFailed": "Falló la instalación",
      "installStatusGaveUp": "Se desistió tras fallos repetidos",
      "installStatusSkipped": "Omitido en este ciclo",
      "installSkippedNoCatalog": "Una regla obligatoria no tiene un elemento de catálogo vinculado, así que no hay nada que instalar. Agregue un vínculo de catálogo en el editor de políticas para solucionarlo.",
      "installSkippedCapOrPlatform": "No es un error: se alcanzó el límite de instalaciones por ciclo o la plataforma de este dispositivo no tiene un método de instalación para el software. Es posible que se intente de nuevo en el próximo ciclo.",
      "installAttempts": "{{count}} intento(s)",
      "installLastAttempt": "Último intento de instalación: "
```

`deploymentList`, after `"managerUnavailableSummary_other": "A {{count}} dispositivos les falta su gestor de paquetes. Es una tarea de configuración única del dispositivo: instala winget (Windows) o Homebrew (macOS) en ellos; hasta entonces, todas las implementaciones con gestor de paquetes fallarán."`:

```json
      "policyOwned": "Gestionado por política",
      "policyOwnedTooltip": "Creado automáticamente por la remediación de instalación automática de una política de software"
```

`policyForm`, after `"saving": "Guardando..."`:

```json
      "catalogLink": "Elemento de catálogo vinculado",
      "catalogLinkNone": "Ninguno — no vinculado",
      "autoInstall": "Instalar automáticamente el software faltante",
      "autoInstallCatalogWarning": "{{count}} de {{total}} regla(s) no tienen un elemento de catálogo vinculado y se detectarán como faltantes, pero nunca se instalarán.",
      "dryRunLoading": "Comprobando cuántos dispositivos se verán afectados...",
      "dryRunResult": "Esto instalará el software faltante en aproximadamente {{count}} dispositivo(s).",
      "dryRunUnavailable": "La vista previa del número de dispositivos aún no está disponible. La activación tendrá efecto de todos modos en el próximo análisis de cumplimiento.",
      "dryRunNewPolicy": "Esta es una política nueva — el impacto en los dispositivos no se conocerá hasta el primer análisis de cumplimiento después de guardar."
```

- [ ] **Step 4: Add the keys to `fr-CA/policies.json`**

`complianceDashboard`, after `"policyCreated": "Politique créée avec succès"`:

```json
      "policyCreated": "Politique créée avec succès",
      "armInstallRequiresMfa": "L'activation de l'installation automatique nécessite l'authentification multifacteur. Complétez la MFA, puis réessayez.",
      "armInstallRequiresPermission": "L'activation de l'installation automatique nécessite la permission devices.execute. Demandez à un administrateur de l'accorder, puis réessayez.",
      "installStatusPending": "Installation en file d'attente",
      "installStatusInProgress": "Installation en cours…",
      "installStatusCompleted": "Installé",
      "installStatusFailed": "Échec de l'installation",
      "installStatusGaveUp": "Abandonné après des échecs répétés",
      "installStatusSkipped": "Ignoré pour ce cycle",
      "installSkippedNoCatalog": "Une règle obligatoire n'a pas d'élément de catalogue lié, donc il n'y a rien à installer. Ajoutez un lien de catalogue dans l'éditeur de politiques pour corriger cela.",
      "installSkippedCapOrPlatform": "Ce n'est pas un échec — soit la limite d'installations par cycle a été atteinte, soit la plateforme de cet appareil n'a pas de méthode d'installation pour le logiciel. Une nouvelle tentative pourrait avoir lieu au prochain cycle.",
      "installAttempts": "{{count}} tentative(s)",
      "installLastAttempt": "Dernière tentative d'installation : "
```

`deploymentList`, after `"managerUnavailableSummary_other": "Le gestionnaire de paquets est absent sur {{count}} appareils. Il s'agit d'une configuration ponctuelle : installez-y winget (Windows) ou Homebrew (macOS); d'ici là, tout déploiement par gestionnaire de paquets échouera."`:

```json
      "policyOwned": "Géré par une politique",
      "policyOwnedTooltip": "Créé automatiquement par la remédiation d'installation automatique d'une politique logicielle"
```

`policyForm`, after `"saving": "Enregistrement..."`:

```json
      "catalogLink": "Élément de catalogue lié",
      "catalogLinkNone": "Aucun — non lié",
      "autoInstall": "Installer automatiquement les logiciels manquants",
      "autoInstallCatalogWarning": "{{count}} règle(s) sur {{total}} n'ont pas d'élément de catalogue lié et seront détectées comme manquantes, mais jamais installées.",
      "dryRunLoading": "Vérification du nombre d'appareils touchés...",
      "dryRunResult": "Ceci installera les logiciels manquants sur environ {{count}} appareil(s).",
      "dryRunUnavailable": "L'aperçu du nombre d'appareils n'est pas encore disponible. L'activation prendra quand même effet lors de la prochaine vérification de conformité.",
      "dryRunNewPolicy": "Il s'agit d'une nouvelle politique — l'impact sur les appareils ne sera connu qu'après la première vérification de conformité suivant l'enregistrement."
```

- [ ] **Step 5: Add the keys to `fr-FR/policies.json`**

`complianceDashboard`, after `"policyCreated": "Politique créée avec succès"`:

```json
      "policyCreated": "Politique créée avec succès",
      "armInstallRequiresMfa": "L'activation de l'installation automatique nécessite l'authentification multifacteur. Terminez la MFA, puis réessayez.",
      "armInstallRequiresPermission": "L'activation de l'installation automatique nécessite la permission devices.execute. Demandez à un administrateur de l'accorder, puis réessayez.",
      "installStatusPending": "Installation en file d'attente",
      "installStatusInProgress": "Installation en cours…",
      "installStatusCompleted": "Installé",
      "installStatusFailed": "Échec de l'installation",
      "installStatusGaveUp": "Abandon après des échecs répétés",
      "installStatusSkipped": "Ignoré lors de ce passage",
      "installSkippedNoCatalog": "Une règle obligatoire n'a pas d'élément de catalogue lié, il n'y a donc rien à installer. Ajoutez un lien de catalogue dans l'éditeur de politique pour corriger cela.",
      "installSkippedCapOrPlatform": "Ce n'est pas un échec : soit la limite d'installations par passage a été atteinte, soit la plateforme de cet appareil n'a pas de méthode d'installation pour ce logiciel. Une nouvelle tentative pourra avoir lieu au prochain passage.",
      "installAttempts": "{{count}} tentative(s)",
      "installLastAttempt": "Dernière tentative d'installation : "
```

`deploymentList`, after `"managerUnavailableSummary_other": "Le gestionnaire de paquets est absent sur {{count}} appareils. Il s'agit d'une configuration ponctuelle : installez-y winget (Windows) ou Homebrew (macOS) ; d'ici là, tout déploiement par gestionnaire de paquets échouera."`:

```json
      "policyOwned": "Géré par une politique",
      "policyOwnedTooltip": "Créé automatiquement par la remédiation d'installation automatique d'une politique logicielle"
```

`policyForm`, after `"saving": "Enregistrement..."`:

```json
      "catalogLink": "Élément de catalogue lié",
      "catalogLinkNone": "Aucun — non lié",
      "autoInstall": "Installer automatiquement les logiciels manquants",
      "autoInstallCatalogWarning": "{{count}} règle(s) sur {{total}} n'ont pas d'élément de catalogue lié et seront détectées comme manquantes mais jamais installées.",
      "dryRunLoading": "Vérification du nombre d'appareils concernés...",
      "dryRunResult": "Cela installera les logiciels manquants sur environ {{count}} appareil(s).",
      "dryRunUnavailable": "L'aperçu du nombre d'appareils n'est pas encore disponible. L'activation prendra tout de même effet lors du prochain contrôle de conformité.",
      "dryRunNewPolicy": "Il s'agit d'une nouvelle politique — l'impact sur les appareils ne sera connu qu'après le premier contrôle de conformité suivant l'enregistrement."
```

- [ ] **Step 6: Add the keys to `it-IT/policies.json`**

`complianceDashboard`, after `"policyCreated": "Criterio creato correttamente"`:

```json
      "policyCreated": "Criterio creato correttamente",
      "armInstallRequiresMfa": "L'attivazione dell'installazione automatica richiede l'autenticazione a più fattori. Completa la MFA, quindi riprova.",
      "armInstallRequiresPermission": "L'attivazione dell'installazione automatica richiede l'autorizzazione devices.execute. Chiedi a un amministratore di concederla, quindi riprova.",
      "installStatusPending": "Installazione in coda",
      "installStatusInProgress": "Installazione in corso…",
      "installStatusCompleted": "Installato",
      "installStatusFailed": "Installazione non riuscita",
      "installStatusGaveUp": "Rinuncia dopo ripetuti fallimenti",
      "installStatusSkipped": "Saltato in questo passaggio",
      "installSkippedNoCatalog": "Una regola obbligatoria non ha un elemento del catalogo collegato, quindi non c'è nulla da installare. Aggiungi un collegamento al catalogo nell'editor dei criteri per risolvere il problema.",
      "installSkippedCapOrPlatform": "Non è un errore: è stato raggiunto il limite di installazioni per passaggio oppure la piattaforma di questo dispositivo non ha un metodo di installazione per il software. Potrebbe essere ritentato al passaggio successivo.",
      "installAttempts": "{{count}} tentativo/i",
      "installLastAttempt": "Ultimo tentativo di installazione: "
```

`deploymentList`, after `"managerUnavailableSummary_other": "Su {{count}} dispositivi manca il gestore di pacchetti. È una configurazione una tantum dei dispositivi: installa winget (Windows) o Homebrew (macOS); fino ad allora ogni distribuzione tramite gestore di pacchetti fallirà."`:

```json
      "policyOwned": "Gestito da criterio",
      "policyOwnedTooltip": "Creato automaticamente dalla remediation di installazione automatica di un criterio software"
```

`policyForm`, after `"saving": "Salvataggio..."`:

```json
      "catalogLink": "Elemento del catalogo collegato",
      "catalogLinkNone": "Nessuno — non collegato",
      "autoInstall": "Installa automaticamente il software mancante",
      "autoInstallCatalogWarning": "{{count}} di {{total}} regola/e non hanno un elemento del catalogo collegato e verranno rilevate come mancanti ma mai installate.",
      "dryRunLoading": "Verifica di quanti dispositivi saranno interessati...",
      "dryRunResult": "Questo installerà il software mancante su circa {{count}} dispositivo/i.",
      "dryRunUnavailable": "L'anteprima del numero di dispositivi non è ancora disponibile. L'attivazione avrà comunque effetto alla prossima verifica di conformità.",
      "dryRunNewPolicy": "Questo è un nuovo criterio — l'impatto sui dispositivi non sarà noto fino alla prima verifica di conformità dopo il salvataggio."
```

- [ ] **Step 7: Add the keys to `pt-BR/policies.json`**

`complianceDashboard`, after `"policyCreated": "Política criada com sucesso"`:

```json
      "policyCreated": "Política criada com sucesso",
      "armInstallRequiresMfa": "Ativar a instalação automática requer autenticação multifator. Conclua o MFA e tente novamente.",
      "armInstallRequiresPermission": "Ativar a instalação automática requer a permissão devices.execute. Peça a um administrador para concedê-la e tente novamente.",
      "installStatusPending": "Instalação na fila",
      "installStatusInProgress": "Instalando…",
      "installStatusCompleted": "Instalado",
      "installStatusFailed": "Falha na instalação",
      "installStatusGaveUp": "Desistiu após falhas repetidas",
      "installStatusSkipped": "Ignorado nesta passagem",
      "installSkippedNoCatalog": "Uma regra obrigatória não tem um item de catálogo vinculado, então não há nada para instalar. Adicione um vínculo de catálogo no editor de políticas para corrigir isso.",
      "installSkippedCapOrPlatform": "Não é uma falha — o limite de instalações por passagem foi atingido ou a plataforma deste dispositivo não tem um método de instalação para o software. Pode ser tentado novamente na próxima passagem.",
      "installAttempts": "{{count}} tentativa(s)",
      "installLastAttempt": "Última tentativa de instalação: "
```

`deploymentList`, after `"managerUnavailableSummary_other": "Falta o gerenciador de pacotes em {{count}} dispositivos. É uma configuração única dos dispositivos: instale o winget (Windows) ou o Homebrew (macOS) neles; até lá, toda implantação por gerenciador de pacotes vai falhar."`:

```json
      "policyOwned": "Gerenciado por política",
      "policyOwnedTooltip": "Criado automaticamente pela remediação de instalação automática de uma política de software"
```

`policyForm`, after `"saving": "Salvando..."`:

```json
      "catalogLink": "Item de catálogo vinculado",
      "catalogLinkNone": "Nenhum — não vinculado",
      "autoInstall": "Instalar automaticamente o software ausente",
      "autoInstallCatalogWarning": "{{count}} de {{total}} regra(s) não têm um item de catálogo vinculado e serão detectadas como ausentes, mas nunca instaladas.",
      "dryRunLoading": "Verificando quantos dispositivos serão afetados...",
      "dryRunResult": "Isso instalará o software ausente em aproximadamente {{count}} dispositivo(s).",
      "dryRunUnavailable": "A prévia da contagem de dispositivos ainda não está disponível. A ativação ainda terá efeito na próxima verificação de conformidade.",
      "dryRunNewPolicy": "Esta é uma política nova — o impacto nos dispositivos só será conhecido após a primeira verificação de conformidade depois de salvar."
```

- [ ] **Step 8: Add the keys to `tr-TR/policies.json`**

`complianceDashboard`, after `"policyCreated": "Politika başarıyla oluşturuldu"`:

```json
      "policyCreated": "Politika başarıyla oluşturuldu",
      "armInstallRequiresMfa": "Otomatik yüklemeyi etkinleştirmek çok faktörlü kimlik doğrulama gerektirir. MFA'yı tamamlayıp tekrar deneyin.",
      "armInstallRequiresPermission": "Otomatik yüklemeyi etkinleştirmek devices.execute iznini gerektirir. Bir yöneticiden bu izni vermesini isteyin, ardından tekrar deneyin.",
      "installStatusPending": "Yükleme sırada",
      "installStatusInProgress": "Yükleniyor…",
      "installStatusCompleted": "Yüklendi",
      "installStatusFailed": "Yükleme başarısız",
      "installStatusGaveUp": "Tekrarlanan başarısızlıklardan sonra vazgeçildi",
      "installStatusSkipped": "Bu geçişte atlandı",
      "installSkippedNoCatalog": "Gerekli bir kuralın bağlı bir katalog öğesi yok, bu yüzden yüklenecek bir şey yok. Bunu düzeltmek için politika düzenleyicisinde bir katalog bağlantısı ekleyin.",
      "installSkippedCapOrPlatform": "Bu bir hata değil — geçiş başına yükleme sınırına ulaşıldı ya da bu cihazın platformunda yazılım için bir yükleme yöntemi yok. Bir sonraki geçişte tekrar denenebilir.",
      "installAttempts": "{{count}} deneme",
      "installLastAttempt": "Son yükleme denemesi: "
```

`deploymentList`, after `"managerUnavailableSummary_other": "{{count}} cihazda paket yöneticisi eksik. Bu, tek seferlik bir cihaz kurulum işidir — o cihazlara winget (Windows) veya Homebrew (macOS) yükleyin; o zamana kadar bu cihazlara yapılan her paket yöneticisi dağıtımı başarısız olacaktır."`:

```json
      "policyOwned": "Politika tarafından yönetiliyor",
      "policyOwnedTooltip": "Bir yazılım politikasının otomatik yükleme düzeltmesi tarafından otomatik olarak oluşturuldu"
```

`policyForm`, after `"saving": "Kaydediliyor..."`:

```json
      "catalogLink": "Bağlı katalog öğesi",
      "catalogLinkNone": "Yok — bağlı değil",
      "autoInstall": "Eksik yazılımı otomatik yükle",
      "autoInstallCatalogWarning": "{{total}} kuraldan {{count}} tanesinin bağlı bir katalog öğesi yok ve eksik olarak algılanacak ama asla yüklenmeyecek.",
      "dryRunLoading": "Kaç cihazın etkileneceği kontrol ediliyor...",
      "dryRunResult": "Bu, eksik yazılımı yaklaşık {{count}} cihaza yükleyecek.",
      "dryRunUnavailable": "Cihaz sayısı önizlemesi henüz kullanılamıyor. Etkinleştirme yine de bir sonraki uyumluluk taramasında geçerli olacak.",
      "dryRunNewPolicy": "Bu yeni bir politika — cihaz etkisi, kaydettikten sonraki ilk uyumluluk taramasına kadar bilinmeyecek."
```

- [ ] **Step 9: Run `localeParity.test.ts` to verify it now passes**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts`
Expected: PASS.

- [ ] **Step 10: Run every test file this plan touched or created, in one pass**

Run:
```bash
cd apps/web && npx vitest run \
  src/components/software/PolicyForm.autoInstall.test.tsx \
  src/components/software/ComplianceDashboard.autoInstall.test.tsx \
  src/components/software/ComplianceDashboard.ownerScope.test.tsx \
  src/components/software/DeploymentList.test.tsx \
  src/components/software/DeploymentList.policyOwned.test.tsx \
  src/lib/i18n/localeParity.test.ts \
  src/lib/__tests__/no-silent-mutations.test.ts
```
Expected: PASS (all 7 files). The `no-silent-mutations.test.ts` run confirms `ComplianceDashboard.tsx` was correctly left out of `TARGET_GLOBS` and that the `RUN_ACTION_MIGRATION_BACKLOG` entry added in Task 3 is a valid `apps/web/src/` path.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/locales/de-DE/policies.json \
        apps/web/src/locales/es-419/policies.json \
        apps/web/src/locales/fr-CA/policies.json \
        apps/web/src/locales/fr-FR/policies.json \
        apps/web/src/locales/it-IT/policies.json \
        apps/web/src/locales/pt-BR/policies.json \
        apps/web/src/locales/tr-TR/policies.json
git commit -m "$(cat <<'EOF'
i18n(web): locale parity for the autoInstall arming UI (#5505 W04)

Backfills the 22 keys Tasks 1-5 added to en/policies.json (catalog
link, autoInstall checkbox, authoring warning, dry-run preview, the two
coded arming-refusal messages — MFA_REQUIRED and
DEVICES_EXECUTE_REQUIRED — the six install-remediation status labels
plus the skip-reason/attempt-count/last-attempt copy, and the
policy-owned deployment badge) across all 7 other locale directories,
so localeParity.test.ts is green again. This is the plan's final task
— the feature is not done until this lands.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz
EOF
)"
```

## Self-Review

**1. Spec/task coverage:**
- "Arm/disarm `autoInstall` in the policy editor" → Task 1 (checkbox) + Task 3 (payload wiring, allowlist-mode guard).
- "A dry-run count before arming" → Task 2, with the endpoint dependency (now owned by W06, #5522) stated plainly in Global Constraints and the task's own Interfaces block, verified against W06's plan doc rather than trusted from the coordinator's summary, with a verify-or-proceed-in-degraded-mode step.
- "An authoring warning when `autoInstall` is armed on a policy whose rules lack `catalogId`" → Task 1 (also had to add the `catalogId` field itself — flagged as a necessary prerequisite, not scope creep).
- **Coordinator scope addition — the install-loop give-up counter must be "visible in the UI" (spec Risks §1)** → Task 4 (new). Surfaces `installRemediationStatus` (with `'gave_up'` given visually distinct destructive styling, never the same treatment as `'failed'`), the consecutive attempt count when non-zero, the last-attempt time, and — for `'skipped'` — the one sub-reason (no linked catalog item) reconstructable from already-projected data, with an honest hedge for the other two (per-pass cap, platform mismatch) that the current schema cannot distinguish. Depends on W06 Task 3 (also newly filed), with its own verify-or-proceed step; the further "no persisted skip sub-reason" gap is flagged to the coordinator in Global Constraints, the same treatment as the dry-run endpoint gap.
- "Label policy-owned deployments as such" → Task 5, using W03's `software_policy_id` (verified to flow through the existing wildcard-select route with no API change).
- "Handle the [403] refusal honestly" → Task 3 Steps 5-8, mirroring the established `ManualAssetModal.tsx` `mfaFriendly`/`runAction`/`ActionError` pattern; both coded refusals — `MFA_REQUIRED` and `DEVICES_EXECUTE_REQUIRED` (the exact shapes fixed by the cross-wave contract's post-W01 correction, picked up mid-authoring) — get their own friendly message and are covered by separate tests.

**2. Placeholder scan:** No "TBD"/"handle appropriately"/"similar to Task N" language. Every code step contains complete, real TSX/TS/JSON. The two places this plan intentionally calls or projects data that may not exist yet (`GET /software-policies/:id/install-preview` in Task 2, the three `installRemediationStatus`/`lastInstallRemediationAttempt`/`installRemediationAttempts` fields in Task 4) are each declared as a W06 dependency in at least three places (Global Constraints, the task's own Interfaces block, and an inline code comment at the call/render site) with an explicit verify-or-proceed-in-degraded-mode step, rather than presented as already-real.

**3. Type consistency:** `CatalogOption` is defined once (Task 1, `PolicyForm.tsx`) and imported by name in Task 3 (`ComplianceDashboard.tsx`) rather than redefined. `PolicyFormValues.software[number].catalogId` (Task 1) is the same field read by Task 3's payload construction and `policyToFormDefaults`, and by Task 4's `installSkipHasMissingCatalogLink` (reading the analogous `compliance.violations[].rule.catalogId` on the read side). `DeploymentRow.softwarePolicyId` (Task 5) matches the camelCase Drizzle convention the contract (D7) specifies for the column W03 ships. `dryRun`'s `DryRunState` union in Task 2 is local to `PolicyForm.tsx` and not referenced elsewhere, so no cross-task drift risk there. The three install-remediation field names in Task 4 (`installRemediationStatus`, `lastInstallRemediationAttempt`, `installRemediationAttempts`) are spelled identically in Global Constraints, this task's Ground Truth, its Step 1 verify command, its `ViolationRow` type extension, and its render block — copied verbatim from W06's plan doc (itself copied verbatim from W02's), never re-derived.

**4. Scope boundary check:** No `apps/api` file is modified anywhere in this plan (grep the plan for `apps/api/` — the only occurrences are in Ground Truth citations, dependency notes, and code comments, never in a `Modify:`/`Create:` line or a `git add`).

**5. Task/key-count consistency after the coordinator's scope addition:** six tasks total (was five); Task 4 is new, the former Tasks 4-5 (`DeploymentList`, locale parity) are renumbered to 5-6 throughout, including every internal cross-reference (`File Structure`, Global Constraints' locale-parity bullet, Task 6's own Interfaces/Step-1 text). Twenty-two `en/policies.json` keys total (was twelve): 8 from Tasks 1-2, 2 from Task 3, 10 from the new Task 4, 2 from Task 5 — verified by grepping the plan for `installStatusPending`/`installLastAttempt` (the first/last of Task 4's ten keys) and confirming exactly one block of ten appears under each of the 8 locale sections Task 6 touches.
