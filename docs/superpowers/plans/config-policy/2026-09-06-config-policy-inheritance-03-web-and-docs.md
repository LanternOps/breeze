# Config Policy Inheritance — W03 Web and Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web app derives every inheritance state from the API (`parentPolicyId`, `parentPolicy`, `childPolicies`, `inheritedFromPolicyId`), the create flow persists the parent, the feature tabs stop conflating id kinds, and the docs describe the feature.

**Architecture:** `ConfigPolicyCreatePage` posts `parentPolicyId` and fills its picker from `GET /configuration-policies/eligible-parents`. `ConfigPolicyDetailPage` seeds `linkedPolicyId`, the parent name, and `parentFeatureLinks` from `policy.parentPolicy` and deletes both the `?linked=` initializer and the direct parent fetch. `FeatureTabShell` is unchanged; three tabs adopt it for inheritance and two re-sync selection when the parent arrives. The list page badges children and renders the 409 children list on delete. `DeviceEffectiveConfigTab` shows "inherited from".

**Tech Stack:** React (Astro islands), react-i18next (8 locales), Vitest + Testing Library (jsdom), `runAction` for mutations.

**Spec:** `docs/superpowers/specs/config-policy/2026-09-06-config-policy-inheritance-design.md` (sections *API*, *Web*)

**Depends on:** W01 merged (API shapes). Independent of W02 except the provenance fields in Task 8, which render as absent until W02 lands.

## Global Constraints

- No `window.location.search` reads for inheritance anywhere in `apps/web/src/components/configurationPolicies/`.
- Every new string is added to all 8 locales: `en, de-DE, fr-FR, fr-CA, es-419, it-IT, pt-BR, tr-TR` (`apps/web/src/locales/<loc>/policies.json`, and `devices.json` for the effective-config tab). Reuse `configPolicyDetailPage.inheritingFrom`, `.parentPolicy`, `.overrideIndividualTabsToCustomizeSettings`.
- Mutation handlers go through `runAction`; the delete 409 is surfaced inside the confirm modal, not as a toast alone.
- Tests use `data-testid` (add them where a test needs a hook); one red test before each behaviour change.
- Per-tab payload matrix (Task 5) is the authority for what `featurePolicyId` each tab may send. A tab not in the matrix is a plan failure; complete the matrix before touching tabs.

---

### Task 1: Client types

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/ConfigPolicyList.tsx:15-31` (`ConfigPolicy`), `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx:66-79` (`PolicyDetail`), `apps/web/src/components/configurationPolicies/featureTabs/types.ts` (export a `ParentPolicySummary`)
- Test: none (types); `tsc` in Task 9 covers it

- [ ] **Step 1:** Add to `ConfigPolicy`: `parentPolicyId?: string | null;`. Add to `PolicyDetail`:

```ts
  parentPolicyId: string | null;
  parentPolicy: ParentPolicySummary | null;
  childPolicies: { id: string; name: string }[];
```

and in `types.ts`:

```ts
/** GET /configuration-policies/:id → parentPolicy (read-only embed; see spec "API"). */
export type ParentPolicySummary = {
  id: string;
  name: string;
  status: 'active' | 'inactive' | 'archived';
  orgId: string | null; // null = partner-wide parent
  featureLinks: FeatureLink[];
};
```

- [ ] **Step 2:** Commit — `git commit -m "feat(web): config policy parent/child types"`.

---

### Task 2: Create page — post `parentPolicyId`, eligible-parent picker, no `?linked=`

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/ConfigPolicyCreatePage.tsx:82-102, 243-247`
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/PolicyLinkSelector.tsx` (accept `options` override or a `fetchUrl` with query; simplest: pass the full eligible-parents URL)
- Test: `apps/web/src/components/configurationPolicies/ConfigPolicyCreatePage.test.tsx` (append)

- [ ] **Step 1: Failing tests**

```ts
it('linked mode: fetches eligible parents for the chosen owner scope and posts parentPolicyId', async () => {
  // org-scoped: expect fetchWithAuth called with '/configuration-policies/eligible-parents?ownerScope=organization&orgId=<org>'
  // select a parent, submit → POST body contains parentPolicyId; navigation target has NO '?linked='
});
it('partner-wide linked mode: fetches eligible parents with ownerScope=partner', async () => {});
it('linked mode without a selected parent keeps Create disabled and does not POST', async () => {});
```

- [ ] **Step 2: Run → FAIL** (`cd apps/web && npx vitest run src/components/configurationPolicies/ConfigPolicyCreatePage.test.tsx`).

- [ ] **Step 3: Implement**
  - Compute the picker URL: `const eligibleUrl = usePartnerOwner ? '/configuration-policies/eligible-parents?ownerScope=partner' : orgScopedOrgId ? \`/configuration-policies/eligible-parents?ownerScope=organization&orgId=${orgScopedOrgId}\` : null;` and render `PolicyLinkSelector` only when `eligibleUrl` is set (an org-scoped creator with no org chosen sees the "select an organization" hint instead). Reset `linkedPolicyId` to `null` whenever `eligibleUrl` changes (a parent valid for org A is not valid for org B).
  - POST body: `const body = { ...values, ...(usePartnerOwner ? { ownerScope: 'partner' as const } : { orgId: orgScopedOrgId }), ...(mode === 'linked' && linkedPolicyId ? { parentPolicyId: linkedPolicyId } : {}) };`
  - Redirect: `void navigateTo(\`/configuration-policies/${policy.id}\`);` (delete the `params` line).
  - Map a `400 INVALID_PARENT_POLICY` and a `403 'MFA required'` to inline errors using the existing `extractApiError` path; no new copy needed for the 400 (server message is user-readable); for the 403 reuse whatever key the patch tab uses for its MFA message (`grep -rn "MFA required" apps/web/src/locales/en/policies.json`).
  - `PolicyLinkSelector`: it already takes a `fetchUrl` and reads `json.data`; the eligible-parents response is `{ data: [...] }`, so no change is required beyond passing the new URL. Show `ownerScope === 'partner'` options with an "All orgs" suffix (reuse the existing badge copy key from `PolicyForm.tsx`'s "All orgs" pattern).

- [ ] **Step 4: Run → PASS; commit** — `git commit -m "feat(web): linked policy create posts parentPolicyId from eligible parents"`.

---

### Task 3: Detail page — inheritance from the API, children list, no direct parent fetch

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx:186-193` (initializer), `:259-285` (effect), `:592-620` (banner), Overview tab section (children line)
- Test: `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.test.tsx` (append)

- [ ] **Step 1: Failing tests**

```ts
it('renders the Inheriting-from banner and inherited tabs from policy.parentPolicy with no URL param and no second fetch', async () => {
  // fetchWithAuth('/configuration-policies/child') → { ..., parentPolicyId: 'p', parentPolicy: { id: 'p', name: 'Baseline', status: 'active', featureLinks: [{ id: 'l1', featureType: 'device_lifecycle', featurePolicyId: null, inlineSettings: { enabled: true, purgeRemovedAfterDays: 45 } }] }, childPolicies: [] }
  // expect banner text 'Inheriting from' + 'Baseline'; expect fetchWithAuth NOT called with '/configuration-policies/p'
});
it('banner links to the parent only when the caller can open it (partner scope or same-org parent); otherwise shows the MSP hint', ...);
it('Overview shows "Inherited by N policies" with links when childPolicies is non-empty', ...);
it('a policy with parentPolicyId null renders no banner', ...);
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**
  - Delete the `window.location.search` initializer; `const linkedPolicyId = policy?.parentPolicyId ?? null;` (derive, not state). Delete the parent-fetch effect; `const parentFeatureLinks = policy?.parentPolicy?.featureLinks ?? []; const linkedPolicyName = policy?.parentPolicy?.name ?? null;`.
  - Banner condition unchanged except it reads the derived values. Link rule: `const canOpenParent = isPartnerScope || policy.parentPolicy?.orgId === policy.orgId` (the W01 embed carries `orgId`; a partner-wide parent has `orgId === null`, which an org-scoped caller cannot open). Render `<a>` when `canOpenParent`, else `<span>` + `configPolicyDetailPage.managedByYourMsp` ("Managed by your MSP").
  - Overview tab: under the description card, `configPolicyDetailPage.inheritedByPolicies` ("Inherited by {{count}} policies") with a list of `<a href="/configuration-policies/{id}">{name}</a>`; hidden when `childPolicies.length === 0`.
  - i18n: `managedByYourMsp`, `inheritedByPolicies` in all 8 locales.

- [ ] **Step 4: Run → PASS; commit** — `git commit -m "feat(web): detail page derives inheritance from the API; children list; no URL param"`.

---

### Task 4: List page — child badge and delete 409

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/ConfigPolicyList.tsx` (row badge), `apps/web/src/components/configurationPolicies/ConfigurationPoliciesPage.tsx:66-95` (`handleConfirmDelete`)
- Test: `apps/web/src/components/configurationPolicies/ConfigurationPoliciesPage.test.tsx` (append; create if absent following `ConfigPolicyCreatePage.test.tsx`'s harness)

- [ ] **Step 1: Failing tests**

```ts
it('shows an "inherits" badge on rows with parentPolicyId', ...);                       // data-testid="config-policy-inherits-badge"
it('delete 409 POLICY_HAS_CHILDREN renders the children inside the confirm modal and keeps it open', ...); // data-testid="config-policy-delete-children"
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**
  - Badge: next to the status pill, when `policy.parentPolicyId`, `<span data-testid="config-policy-inherits-badge" className="...">{t('configurationPoliciesPage.inheritsBadge')}</span>` ("Inherits").
  - Delete: `runAction` throws an `ActionError` carrying `status` and the parsed body (check `apps/web/src/lib/runAction.ts` for the body accessor; if the body is not retained, read it in `request` before rethrowing). On `status === 409 && body.error === 'POLICY_HAS_CHILDREN'`, set `deleteBlockedChildren = body.children` state rendered inside the modal under `configurationPoliciesPage.deleteBlockedByChildren` ("Delete the policies that inherit from this one first:"), keep the modal open, and skip the generic error toast for that case (it is already shown inline). Clear the state on close.
  - i18n: `inheritsBadge`, `deleteBlockedByChildren` in all 8 locales.

- [ ] **Step 4: Run → PASS; commit** — `git commit -m "feat(web): inherits badge; delete blocked-by-children modal state"`.

---

### Task 5: Per-tab payload matrix and the `featurePolicyId` fix

**Files:**
- Create: `docs/superpowers/plans/config-policy/2026-09-06-config-policy-inheritance-03-tab-matrix.md` (18 rows, committed with the code)
- Modify: every tab under `apps/web/src/components/configurationPolicies/featureTabs/*Tab.tsx` that sends `featurePolicyId: linkedPolicyId`
- Test: one assertion per changed tab in its existing `*.test.tsx` (save payload `featurePolicyId` is `null`)

- [ ] **Step 1: Build the matrix** — `grep -n "featurePolicyId" apps/web/src/components/configurationPolicies/featureTabs/*Tab.tsx`. For each of the 18 tabs record: `featurePolicyId meaning` (one of `none — inline settings`, `update ring`, `backup profile`, `software policy`, `peripheral profile`, `other: <what>`), `sends today`, `sends after`. Known rows: Patch → update ring (keep); Backup → profile (keep); Software Policy → software policy (keep, copies `parentLink.featurePolicyId` on override); Peripheral Control → same (keep); Alert Rule, Automation, Compliance, Device Lifecycle, Event Log, Helper, Maintenance, Monitoring, OneDrive Helper, Pam, Warranty, Vulnerability, Security, Sensitive Data, Remote Access → verify each; the ones that are inline-only send `null` after. Any tab whose `FEATURE_META.fetchUrl` is non-null and whose UI has a picker for a standalone entity is a "keep" row.

- [ ] **Step 2: Failing tests** — for each "inline-only" row, in the tab's test: render with `linkedPolicyId="parent-1"` and a parent link, click Override (or Save), assert `saveMock.mock.calls[0][1].featurePolicyId === null`.

- [ ] **Step 3: Run → FAIL** for each.

- [ ] **Step 4: Implement** — replace `featurePolicyId: linkedPolicyId` with `featurePolicyId: null` in those tabs (and remove the now-unused `linkedPolicyId` destructure where only that used it; keep it where `onRemove`/`onRevert` gating reads it). Do not touch the "keep" rows.

- [ ] **Step 5: Run → PASS; commit** — `git commit -m "fix(web): inline-settings tabs no longer stamp the parent policy id into featurePolicyId"`.

---

### Task 6: Inheritance display for Security, Sensitive Data, Remote Access

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/SecurityTab.tsx`, `SensitiveDataTab.tsx`, `RemoteAccessTab.tsx`
- Test: their `*.test.tsx` files (pattern: `DeviceLifecycleTab.test.tsx:129` "shows the inherited … read-only when only a parent link exists" and `OneDriveHelperTab.test.tsx:347` "inherited (parentLink only) shows Override and no direct Save")

- [ ] **Step 1: Failing tests** (per tab)

```ts
it('shows Configured (inherited) and seeds the form from parentLink when only a parent link exists', () => {
  render(<SecurityTab {...baseProps} parentLink={parentLinkWith({ /* one distinctive setting */ })} />);
  expect(screen.getByText(/Configured \(inherited\)/i)).toBeTruthy();
  // assert the distinctive setting is rendered read-only
});
it('Override saves a copy of the inherited settings as the policy\'s own link', () => {
  // click the Override button → saveMock called with (null, { featureType: 'security', featurePolicyId: null, inlineSettings: <parent settings> })
});
it('Revert to Parent removes the override', () => { /* existingLink + parentLink → Revert → removeMock called with existingLink.id */ });
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — mirror `PamTab.tsx:22-40`: destructure `parentLink`; `const isInherited = !!parentLink && !existingLink; const effectiveLink = existingLink ?? parentLink;` seed state from `effectiveLink` in the load effect (depend on `[existingLink, parentLink]`); pass `isConfigured={!!existingLink || isInherited} isInherited={isInherited} onOverride={isInherited ? handleSave : undefined} onRevert={!isInherited && parentLink && existingLink ? () => remove(existingLink.id) : undefined} onRemove={!parentLink ? handleRemove : undefined}` to `FeatureTabShell`.

- [ ] **Step 4: Run → PASS; commit** — `git commit -m "feat(web): security, sensitive-data, remote-access tabs render inheritance"`.

---

### Task 7: Software Policy and Peripheral Control re-sync when the parent arrives

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/SoftwarePolicyTab.tsx:29-33`, `PeripheralControlTab.tsx:~40-50`
- Test: their `*.test.tsx`

- [ ] **Step 1: Failing test** — render with `parentLink={undefined}`, then `rerender` with `parentLink={{ featurePolicyId: 'sp-parent', ... }}` and no `existingLink`; expect the selection to become `sp-parent` (the inherited summary is fetched / rendered).
- [ ] **Step 2: Run → FAIL.** **Step 3:** add `useEffect(() => { if (!existingLink) setSelectedPolicyId(parentLink?.featurePolicyId ?? null); }, [existingLink, parentLink]);`. With the embedded parent (Task 3) the parent arrives with the policy, so this is belt-and-braces, and it fixes the stale state on `handleLinkChanged` reverts too. **Step 4:** PASS; commit — `git commit -m "fix(web): reference tabs re-sync inherited selection"`.

---

### Task 8: Effective configuration tab — "inherited from"

**Files:**
- Modify: `apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx:62-72` (type), render block near `:352-366`
- Test: `apps/web/src/components/devices/DeviceEffectiveConfigTab.test.tsx` (append)

- [ ] **Step 1: Failing test** — a feature with `inheritedFromPolicyId: 'p1', inheritedFromPolicyName: 'Baseline'` renders `data-testid="effective-config-inherited-from"` containing "Baseline"; a feature without it renders nothing.
- [ ] **Step 2: Run → FAIL.** **Step 3:** add `inheritedFromPolicyId?: string | null; inheritedFromPolicyName?: string | null;` to `ResolvedFeature`; render `<p data-testid="effective-config-inherited-from">{t('deviceEffectiveConfigTab.inheritedFrom', { name })}</p>` ("Inherited from {{name}}") under the source-policy line; add the key to all 8 `devices.json`. **Step 4:** PASS; commit — `git commit -m "feat(web): effective config shows inherited-from provenance"`.

---

### Task 9: Docs and release notes

**Files:**
- Modify: the configuration-policies page under `apps/docs/src/content` (`grep -rli "configuration polic" apps/docs/src/content | head`), following the `update-breeze-docs` skill
- Modify: the release-notes draft per the `update-breeze-release-notes` skill (next unreleased version entry)

- [ ] **Step 1:** Docs: a "Baseline policies (inheritance)" section: what a parent is, the ownership rule in one table, one level only, override/revert, parent status does not gate inheritance, delete blocked while children exist, MFA on transitions that enable patch/maintenance. Screenshots optional.
- [ ] **Step 2:** Release notes: the two bullets from the spec's *Release notes* section, plus "PostgreSQL 15+ required (`security_invoker` view)".
- [ ] **Step 3:** Commit — `git commit -m "docs: configuration policy inheritance"`.

---

### Task 10: Typecheck, full web suites, PR

- [ ] **Step 1:** `cd apps/web && npx tsc --noEmit -p tsconfig.json && npx eslint src/components/configurationPolicies src/components/devices/DeviceEffectiveConfigTab.tsx`.
- [ ] **Step 2:** `npx vitest run src/components/configurationPolicies src/components/devices/DeviceEffectiveConfigTab src/lib/i18n --pool=threads --maxWorkers=2` green (the i18n suite catches locale gaps).
- [ ] **Step 3:** Browser walk on a wt-stack (`worktree-stack` skill): create a partner-wide baseline with an event-log link; as a partner user create an org child linked to it; reload the child → banner present; override one tab, revert it; open the parent → "Inherited by 1 policies"; try to delete the parent → blocked list; device effective-config tab shows "Inherited from" once W02 is merged. Record PASS/FAIL per step in the PR body.
- [ ] **Step 4:** Merge `origin/main`, re-run Step 2, push, open the PR with `Closes #<wave sub-issue>`, run `pr-review-toolkit:review-pr`, fix confirmed findings inline, **stop at the open PR**.
