---
tracking_issue: LanternOps/breeze#5650
---
# Fleet Designer W04: Legacy Intent Inventory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A thousand imported legacy scripts become a hundred intents: scripts imported through Recipe 6 can be tagged `legacy-import`, the designer classifies each as obsolete, covered or needed, and approved replacement scripts are created by the apply step.

**Architecture:** `POST /script-bundle/import` gains an optional `tags: string[]` that `importBundle` merges into every entry's tags (through the existing `ensureTagIds` + `linkTags`, so `skip`/`rename`/`new-version` all behave). The evidence bundle already flags `legacyImport` scripts (W01); this wave adds the `legacy` prompt guidance and a fixture-driven test of the classification contract. Apply step 4 creates approved scripts by building a `ScriptBundleEnvelope` from the proposals and calling `importBundle(auth, envelope, { availability: 'org', orgId, mode: 'rename', tags: ['fleet-design'] })` — reusing the importer's secret scan, parameter validation and tag linking instead of a second create path — and records each created script in the ledger.

**Tech Stack:** TypeScript, Hono + Zod, Drizzle, Vitest, React.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-11-fleet-designer-agent-design.md` §4.7, §4.8 step 4, §4.14 (intent-inventory classifier fixtures). No migration.

## Global Constraints

- No schema change. Tags live in `script_tags` / `script_to_tags` (`apps/api/src/db/schema/scripts.ts:117-134`); `POST /scripts` cannot attach tags, so every tagged creation goes through `importBundle`.
- Script creation in apply requires `scripts:write` in addition to `devices:write` (route check before any step runs); the importer's own `resolveScriptCreateScope` and secret-variable rejection stay in force.
- Rollback leaves created scripts in place and only removes the `fleet-design` tag (spec §4.8); the ledger row records `scriptId`.
- Tests: `cd apps/api && npx vitest run <path>`; the whole unit suite before the PR.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Branch `feature/5650-fleet-designer/wave-5654`; PR body `Closes #5654`. `get_feature_status` first.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/src/routes/scriptBundle.ts:44-54`, `apps/api/src/services/scriptBundle/index.ts:332-338`, `:689+` | `tags` on import (Task 1) |
| `apps/api/src/services/aiAgents/runnerPrompt.ts` (`buildFleetDesignTaskPrompt`) | legacy guidance (Task 2) |
| `apps/api/src/services/aiAgents/fleetDesignLegacy.test.ts` | classifier contract fixtures (Task 2) |
| `apps/api/src/services/fleetDesign/apply.ts`, `rollback.ts`, `preview.ts` | step 4 (Task 3) |
| `apps/api/src/routes/fleetDesign.ts` | `scripts:write` gate (Task 3) |
| `apps/web/src/components/scripts/ScriptBundleImport*.tsx` (grep `script-bundle/import`), `components/fleetDesign/FleetDesignViewer.tsx`, `ApplyDrawer.tsx`, locales | import tag toggle; legacy section rendering; scripts in the drawer (Task 4) |

---

### Task 1: `tags` on bundle import

**Files:**
- Modify: `apps/api/src/routes/scriptBundle.ts:44-54` (add `tags: z.array(z.string().min(1).max(50)).max(10).optional()` to `importBodySchema`, pass through to `importBundle`)
- Modify: `apps/api/src/services/scriptBundle/index.ts:332-338` (`BundleTargetOptions` gains `tags?: string[]`), and every place `entry.tags ?? []` feeds `ensureTagIds` (grep in the file: the new-version branch ~:816 and the insert branch after `insertScriptRow`) → `mergeTags(entry.tags, options.tags)` where `mergeTags` dedupes case-insensitively and caps at `MAX_BUNDLE_TAGS_PER_SCRIPT`
- Test: `apps/api/src/services/scriptBundle/index.test.ts`, `apps/api/src/routes/scriptBundle.test.ts` (extend)

- [ ] **Step 1: Failing tests** — import with `tags: ['legacy-import']` links the tag on an imported entry, a renamed entry and a new-version entry (three modes); an entry that already carries `legacy-import` is not double-linked; the route rejects 11 tags.
Run: `cd apps/api && npx vitest run src/services/scriptBundle src/routes/scriptBundle.test.ts` → FAIL.
- [ ] **Step 2: Implement** as listed.
- [ ] **Step 3: Run, commit**

```bash
git add apps/api/src/routes/scriptBundle.ts apps/api/src/services/scriptBundle/index.ts apps/api/src/services/scriptBundle/index.test.ts apps/api/src/routes/scriptBundle.test.ts
git commit -m "feat(scripts): optional tags on bundle import (legacy-import discovery)"
```

### Task 2: Legacy guidance and the classification contract

**Files:**
- Modify: `apps/api/src/services/aiAgents/runnerPrompt.ts` (`buildFleetDesignTaskPrompt`)
- Create: `apps/api/src/services/aiAgents/fleetDesignLegacy.test.ts`

- [ ] **Step 1: Failing tests**

`fleetDesignLegacy.test.ts` exercises the W01 contract with three fixtures and pins the prompt:
```ts
it('prompt lists every legacy-import script with id, name, tags and description head, and the three buckets', () => {
  const evidence = evidenceFixture({ scripts: [{ id: S1, name: 'Old disk cleanup', tags: ['legacy-import'], legacyImport: true, description: 'Deletes temp files weekly', language: 'powershell', osTypes: ['windows'] }] });
  const prompt = buildFleetDesignTaskPrompt(ctxWith(evidence));
  expect(prompt).toContain(`legacy: ${S1} Old disk cleanup`);
  expect(prompt).toMatch(/obsolete \| covered \| needed/);
  expect(prompt).toContain('coveredBy names the module, template or playbook that replaces it');
});
it('accepts obsolete, covered (with coveredBy) and needed (with a replacement script) entries', () => {
  const s = validSubmission();
  s.legacy = [
    { scriptId: S1, scriptName: 'Old disk cleanup', intent: 'Free disk space weekly', bucket: 'covered', coveredBy: 'disk_cleanup module', notes: 'Built-in disk cleanup replaces it.' },
    { scriptId: S2, scriptName: 'Map drive H', intent: 'Map a departmental share', bucket: 'obsolete', notes: 'Share decommissioned.' },
    { scriptId: S3, scriptName: 'Reset print spooler', intent: 'Restart spooler when stuck', bucket: 'needed', notes: 'No module covers it.' },
  ];
  s.automation.push({ functionKey: 'file_server', playbooks: [], scripts: [{ name: 'Restart print spooler', purpose: 'Restart spooler when stuck', osTypes: ['windows'], language: 'powershell', content: 'Restart-Service Spooler' }] });
  expect(fleetDesignSubmissionSchema.safeParse(s).success).toBe(true);
});
it('rejects covered without coveredBy', () => { /* superRefine added below */ });
```
Run → FAIL on the prompt text and the new refinement.

- [ ] **Step 2: Implement**

In `buildFleetDesignTaskPrompt`, render the automation.scripts block as `legacy: <id> <name> [tags] — <description head>` for `legacyImport` scripts and `script: …` for the rest; extend the `legacy` section guidance: *`legacy: one entry per script listed above as legacy. bucket obsolete | covered | needed. coveredBy names the module, template or playbook that replaces it (required for covered). For needed, propose the replacement under automation.scripts and say so in notes. Never modify or delete anything — a human decides what happens to each bucket.`* In `packages/shared/src/validators/fleetDesign.ts` add to the top-level `superRefine`: `v.legacy.forEach((l, i) => { if (l.bucket === 'covered' && !l.coveredBy) ctx.addIssue({ code: 'custom', path: ['legacy', i, 'coveredBy'], message: 'a covered script must name what covers it' }); });`

- [ ] **Step 3: Run, commit**

```bash
git add apps/api/src/services/aiAgents/runnerPrompt.ts apps/api/src/services/aiAgents/fleetDesignLegacy.test.ts packages/shared/src/validators/fleetDesign.ts packages/shared/src/validators/fleetDesign.test.ts
git commit -m "feat(ai): legacy intent inventory guidance and contract"
```

### Task 3: Apply step 4 — scripts through the bundle importer

**Files:**
- Modify: `apps/api/src/services/fleetDesign/apply.ts` (add `[4, () => stepScripts(ctx)]` between steps 3 and 5), `preview.ts` (add `scripts: { itemRef; name; language; osTypes; alreadyExists: boolean }[]`), `rollback.ts` (untag), `apps/api/src/routes/fleetDesign.ts` (when `approval.automation.length > 0`, require `scripts:write` via `hasPermission(perms, 'scripts', 'write')` or the same `requirePermission` helper pattern used inline elsewhere → 403 `{ error: 'scripts_write_required' }`)
- Modify: `packages/shared/src/types/fleetDesignApply.ts` (`FleetDesignApplyPreview.scripts`)
- Tests: `apply.test.ts`, `rollback.test.ts`, `routes/fleetDesign.test.ts` (extend)

- [ ] **Step 1: Failing tests** — step 4 builds one envelope with every approved script (`bundleVersion: SCRIPT_BUNDLE_VERSION`, `scripts: [{ name, description: purpose, category: 'Fleet Design', tags: ['fleet-design'], osTypes, language, content, timeoutSeconds: 300, runAs: 'system' }]`) and calls `importBundle(auth, envelope, { availability: 'org', orgId, mode: 'rename', tags: ['fleet-design'] })`; records one ledger row per script ref with `createdRefs.scriptId` from the import result; a `ScriptScopeError` result fails the step (partial); rollback removes the `fleet-design` tag link and leaves the script; the route 403s without `scripts:write` when automation refs are present.
- [ ] **Step 2: Implement.** The importer's result shape (`BundleImportResult`, `scriptBundle/index.ts:665+`) maps entries to created ids — read it and map by entry index. Rules that referenced a script by proposal name (`action: { kind: 'script', ref }`) get their rationale suffix updated with the created id in step 3 if step 3 runs after step 4 — it does not (order is 1, 2, 3, 4, 5 per spec §4.8); instead step 4 appends `[script created: <id>]` to the rationale of the rules that named it via `updateFeatureLink` on the policy's alert_rule link (ledger row for the policy already exists; refresh `linksSnapshot`).
- [ ] **Step 3: Run, commit**

```bash
git add apps/api/src/services/fleetDesign apps/api/src/routes/fleetDesign.ts apps/api/src/routes/fleetDesign.test.ts packages/shared/src/types/fleetDesignApply.ts
git commit -m "feat(api): fleet design apply step 4 creates approved scripts through the bundle importer"
```

### Task 4: Web

**Files:**
- Modify: the bundle import UI (grep `script-bundle/import` under `apps/web/src/components/scripts/`) — add a "Tag as legacy import" toggle that sends `tags: ['legacy-import']`
- Modify: `apps/web/src/components/fleetDesign/FleetDesignViewer.tsx` — `legacy` section as a table (Script | Bucket | Covered by | Intent | Notes) with bucket badges; `automation` scripts selectable with a content preview (`<details>`)
- Modify: `ApplyDrawer.tsx` — "Creates scripts" block; show `scripts_write_required` copy when the API returns it
- Locales (8): `scripts.json` (`bundleImport.tagLegacy`, `bundleImport.tagLegacyHint`), `fleetDesign.json` (`legacy.bucket.obsolete|covered|needed`, `legacy.coveredBy`, `drawer.createsScripts`, `errors.scripts_write_required`)
- Tests: the import component test, `FleetDesignViewer.test.tsx`, `ApplyDrawer.test.tsx`, locale gates, `no-silent-mutations`

- [ ] **Step 1: Failing tests**, **Step 2: implement**, **Step 3: run** `cd apps/web && npx vitest run src/components/scripts src/components/fleetDesign src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts && npx astro check && pnpm lint`.
- [ ] **Step 4: Commit and PR**

```bash
git add apps/web/src
git commit -m "feat(web): legacy-import tag on bundle import; legacy inventory and script proposals in Fleet Design"
```
Before the PR: `cd apps/api && npx vitest run`; extend `fleetDesignApply.integration.test.ts` with one case (apply with one approved script → a `scripts` row tagged `fleet-design`; rollback untags it) and run it on the test stack. `Closes #5654`.
