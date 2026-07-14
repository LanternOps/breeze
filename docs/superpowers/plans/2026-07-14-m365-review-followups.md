# M365 Review Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two final M365 foundation review follow-ups before publishing the branch.

**Architecture:** Keep the existing executor and permission-profile boundaries unchanged. Tighten the Azure Key Vault reference contract to accept only service-generated 32-character hexadecimal versions, and strengthen tests so every profile's security-relevant mapping is asserted exactly.

**Tech Stack:** TypeScript, Vitest, Azure Key Vault Secrets SDK, pnpm.

## Global Constraints

- No route, control-plane service, schema, or migration changes.
- Credential material remains executor-only.
- Azure Key Vault references require a canonical vault host, generated M365 secret name, UUID connection id, and 32-character hexadecimal version.
- Permission profiles remain code-owned at manifest version 1.
- Preserve the unrelated untracked `.githooks/` directory.

---

### Task 1: Enforce production Key Vault versions

**Files:**
- Modify: `apps/api/src/executors/m365/credentials/azureKeyVaultProvider.test.ts`
- Modify: `apps/api/src/executors/m365/credentials/azureKeyVaultProvider.ts`

**Interfaces:**
- Consumes: `SecretClientPort.setSecret()` version output and `akv://` credential references.
- Produces: references whose version segment matches `/^[0-9a-f]{32}$/i`.

- [ ] **Step 1: Replace the test fixture version and add a rejection regression**

Define:

```ts
const SECRET_VERSION = '0123456789abcdef0123456789abcdef';
const REFERENCE = `akv://vault.example/${SECRET_NAME}/${SECRET_VERSION}`;
```

Make the mocked client return `SECRET_VERSION`, replace literal `version-1` references, and add:

```ts
it('rejects the former test-only version literal before accessing Key Vault', async () => {
  const port = client();
  const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
  await expect(provider.get(
    `akv://vault.example/${SECRET_NAME}/version-1`,
    'customer-graph-read',
  )).rejects.toThrow('Invalid Azure Key Vault credential reference');
  expect(port.getSecret).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused provider test and verify RED**

Run: `pnpm --filter @breeze/api exec vitest run src/executors/m365/credentials/azureKeyVaultProvider.test.ts`

Expected: FAIL because production still accepts `version-1`.

- [ ] **Step 3: Remove the test-only production exception**

Replace the version expression with:

```ts
const KEY_VAULT_VERSION_RE = /^[0-9a-f]{32}$/i;
```

- [ ] **Step 4: Run the focused provider test and verify GREEN**

Run: `pnpm --filter @breeze/api exec vitest run src/executors/m365/credentials/azureKeyVaultProvider.test.ts`

Expected: all provider tests pass.

### Task 2: Assert exact permission-profile contracts

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/profiles.test.ts`

**Interfaces:**
- Consumes: `M365_PERMISSION_PROFILES`.
- Produces: exact regression coverage for profile id, owner axis, auth mode, credential domain, executor, manifest version, and delegated/application grant class.

- [ ] **Step 1: Replace the weak isolation assertion with a table-driven contract**

Add an expected mapping for all four profiles and assert each manifest with `toMatchObject`, including `version`, `ownerAxis`, `authMode`, `credentialDomain`, `executor`, and whether delegated or application permissions are empty.

- [ ] **Step 2: Run focused profile tests**

Run: `pnpm --filter @breeze/api exec vitest run src/services/m365ControlPlane/profiles.test.ts`

Expected: all profile tests pass; this is coverage hardening of existing intended behavior, so no production RED phase is expected.

### Task 3: Verify and publish

**Files:**
- No additional source files.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: one review-follow-up commit and a draft pull request.

- [ ] **Step 1: Run combined tests and static verification**

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/services/m365ControlPlane/profiles.test.ts src/executors/m365/credentials/azureKeyVaultProvider.test.ts
pnpm --filter @breeze/api exec eslint src/services/m365ControlPlane/profiles.test.ts src/executors/m365/credentials/azureKeyVaultProvider.ts src/executors/m365/credentials/azureKeyVaultProvider.test.ts
pnpm --filter @breeze/api exec tsc --noEmit --pretty false
pnpm --filter @breeze/api build
git diff --check
```

Expected: exit 0 for every command; the API build may retain its pre-existing `src/db/seed.ts` CJS/`import.meta` warning.

- [ ] **Step 2: Commit the follow-ups**

```bash
git add docs/superpowers/plans/2026-07-14-m365-review-followups.md \
  apps/api/src/services/m365ControlPlane/profiles.test.ts \
  apps/api/src/executors/m365/credentials/azureKeyVaultProvider.ts \
  apps/api/src/executors/m365/credentials/azureKeyVaultProvider.test.ts
git commit -m "test(m365): close foundation review follow-ups"
```

- [ ] **Step 3: Push and open a draft PR**

Push `feat/m365-control-plane-foundation` to `origin`, then open a draft PR against the remote default branch. The PR body must disclose the verified unchanged Pax8 RLS coverage failure rather than claiming the repository-wide RLS gate is green.
