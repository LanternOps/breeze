# SSL.com Public Release Signing Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the public Viewer/Helper Windows signing provider switch so invalid configuration fails closed, SSL.com never receives Azure OIDC permission, and every SSL.com signature is pinned to the expected LanternOps certificate.

**Architecture:** Extend the existing workflow-security checker with public-release signing invariants, then split the current mixed-provider Windows signer into a resolver, mutually exclusive Azure and SSL.com jobs, and the existing `sign-windows-tauri` convergence gate. Keep all downstream job IDs and public Agent-family artifact behavior stable, and update the public code-signing documentation to describe the provider-neutral contract.

**Tech Stack:** GitHub Actions YAML, Node.js 22 built-in test runner, PowerShell 7, Windows Authenticode, Azure Artifact Signing, SSL.com `esigner-codesign` v1.3.2, Astro/Starlight documentation, pnpm 10.34.5.

## Global Constraints

- `vars.WINDOWS_SIGNING_PROVIDER` accepts only empty, `azure`, or `sslcom`; empty resolves to `azure`, and every other value fails before credentials are exposed.
- Only `sign-windows-tauri-azure` may declare `id-token: write`; `sign-windows-tauri-sslcom` must declare only `contents: read`.
- The SSL.com action reference must remain exactly `SSLcom/esigner-codesign@cf5f6c1d38ad10f47e3ed9aca873f429b1a8d85b`.
- The SSL.com job must require `SSLCOM_USERNAME`, `SSLCOM_PASSWORD`, `SSLCOM_CREDENTIAL_ID`, `SSLCOM_TOTP_SECRET`, and `SSLCOM_CERT_SHA256` from the selected GitHub Environment.
- `SSLCOM_CERT_SHA256` must normalize to exactly 64 lowercase hexadecimal characters and must match the SHA-256 hash of every Viewer/Helper leaf signer certificate.
- Both providers must require a signer certificate and an RFC 3161 timestamp on both MSI files before upload.
- Public Agent-family Windows EXEs and `breeze-agent.msi` remain unsigned and outside every SSL.com job or step.
- Existing downstream jobs continue to depend on the `sign-windows-tauri` job ID.
- No username, password, TOTP seed, credential ID, PIN, or certificate thumbprint value may be committed or printed.
- Use at most one independent code-review dispatch after all implementation tasks. In inline mode without explicit delegation authorization, run the same checklist as a fresh-eye self-review; fixes are verified with targeted tests unless they change the signing trust boundary.

---

### Task 1: Enforce and implement the split public signing topology

**Files:**
- Modify: `.github/scripts/check-workflow-security.mjs`
- Modify: `.github/scripts/check-workflow-security.test.mjs`
- Modify: `.github/workflows/release.yml:1506-1695`

**Interfaces:**
- Consumes: `inspectWorkflowText(file: string, text: string): Violation[]`, the current release workflow artifact names, and the existing downstream `sign-windows-tauri` dependency.
- Produces: `publicReleaseSigningViolations(file: string, lines: ActiveLine[]): Violation[]` (job slicing reuses the existing `workflowJobs(lines)` helper — do not add a second slicer); jobs `resolve-windows-signing-provider`, `sign-windows-tauri-azure`, `sign-windows-tauri-sslcom`, and `sign-windows-tauri`; resolver output `provider: "azure" | "sslcom"`.

- [ ] **Step 1: Add failing synthetic workflow tests for the trust-boundary invariants**

Add tests that call `inspectWorkflowText('release.yml', fixture)` and assert stable rule IDs. Use a complete passing fixture with these exact job IDs, then mutate one property per test:

```js
const SSL_ACTION = 'SSLcom/esigner-codesign@cf5f6c1d38ad10f47e3ed9aca873f429b1a8d85b';

function publicSigningFixture() {
  return `on: push
jobs:
  resolve-windows-signing-provider:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      provider: \${{ steps.provider.outputs.provider }}
    steps:
      - id: provider
        env:
          RAW_PROVIDER: \${{ vars.WINDOWS_SIGNING_PROVIDER }}
        run: |
          case "\${RAW_PROVIDER:-azure}" in
            azure|sslcom) echo "provider=\${RAW_PROVIDER:-azure}" >> "$GITHUB_OUTPUT" ;;
            *) exit 1 ;;
          esac
  sign-windows-tauri-azure:
    needs: [resolve-windows-signing-provider]
    if: needs.resolve-windows-signing-provider.outputs.provider == 'azure'
    permissions:
      contents: read
      id-token: write
    steps:
      - shell: pwsh
        run: |
          if (-not $sig.SignerCertificate) { throw }
          if (-not $sig.TimeStamperCertificate) { throw }
  sign-windows-tauri-sslcom:
    needs: [resolve-windows-signing-provider]
    if: needs.resolve-windows-signing-provider.outputs.provider == 'sslcom'
    permissions:
      contents: read
    steps:
      - uses: ${SSL_ACTION}
        with:
          username: \${{ secrets.SSLCOM_USERNAME }}
          password: \${{ secrets.SSLCOM_PASSWORD }}
          credential_id: \${{ secrets.SSLCOM_CREDENTIAL_ID }}
          totp_secret: \${{ secrets.SSLCOM_TOTP_SECRET }}
      - shell: pwsh
        env:
          SSLCOM_CERT_SHA256: \${{ secrets.SSLCOM_CERT_SHA256 }}
        run: |
          $expected = $env:SSLCOM_CERT_SHA256
          $actual = $sig.SignerCertificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256)
          if (-not $sig.TimeStamperCertificate) { throw }
          O=LANTERNOPS LLC
  sign-windows-tauri:
    needs: [resolve-windows-signing-provider, sign-windows-tauri-azure, sign-windows-tauri-sslcom]
    if: \${{ !cancelled() && needs.resolve-windows-signing-provider.result != 'skipped' }}
    permissions:
      contents: read
    steps:
      - env:
          PROVIDER: \${{ needs.resolve-windows-signing-provider.outputs.provider }}
          AZURE_RESULT: \${{ needs.sign-windows-tauri-azure.result }}
          SSLCOM_RESULT: \${{ needs.sign-windows-tauri-sslcom.result }}
        run: echo convergence
`;
}
```

The fixture must mirror the real step layout so the Step 3 patterns can match both: the `env:` mapping precedes the `run:` block, `$env:SSLCOM_CERT_SHA256` is read inside the script, and the gate consumes both signer results through `needs.*.result` env vars.

Add a passing-fixture baseline plus one assertion per mutation, using the exact rule IDs:

```js
const PUBLIC_SIGNING_RULES = [
  'windows-signing-provider-must-fail-closed',
  'windows-signing-provider-least-privilege',
  'sslcom-signing-must-pin-certificate',
  'windows-signing-must-require-timestamp',
  'sslcom-signing-must-not-touch-agent',
  'windows-signing-provider-must-converge',
];

test('passing public signing fixture raises no public-signing violations', () => {
  const rules = new Set(inspectWorkflowText('release.yml', publicSigningFixture()).map(({ rule }) => rule));
  for (const rule of PUBLIC_SIGNING_RULES) assert.equal(rules.has(rule), false, rule);
});

test('public signing resolver rejects unknown providers', () => {
  const text = publicSigningFixture().replace('*) exit 1 ;;', '*) echo "provider=azure" >> "$GITHUB_OUTPUT" ;;');
  assert.equal(inspectWorkflowText('release.yml', text).some(({ rule }) => rule === 'windows-signing-provider-must-fail-closed'), true);
});

test('SSL.com signer cannot receive OIDC', () => {
  const text = publicSigningFixture().replace('sign-windows-tauri-sslcom:\n', 'sign-windows-tauri-sslcom:\n    permissions:\n      id-token: write\n');
  assert.equal(inspectWorkflowText('release.yml', text).some(({ rule }) => rule === 'windows-signing-provider-least-privilege'), true);
});

test('SSL.com signer requires a pinned certificate and timestamp', () => {
  const text = publicSigningFixture()
    .replaceAll('SSLCOM_CERT_SHA256', 'REMOVED_CERT_PIN')
    .replaceAll('TimeStamperCertificate', 'REMOVED_TIMESTAMP');
  const rules = new Set(inspectWorkflowText('release.yml', text).map(({ rule }) => rule));
  assert.equal(rules.has('sslcom-signing-must-pin-certificate'), true);
  assert.equal(rules.has('windows-signing-must-require-timestamp'), true);
});

test('SSL.com signer cannot mention public Agent-family artifacts', () => {
  const text = publicSigningFixture().replace('O=LANTERNOPS LLC', 'O=LANTERNOPS LLC\n          breeze-agent.msi');
  assert.equal(inspectWorkflowText('release.yml', text).some(({ rule }) => rule === 'sslcom-signing-must-not-touch-agent'), true);
});

test('convergence gate must consume both signer results', () => {
  const text = publicSigningFixture().replace(/ +AZURE_RESULT:[^\n]*\n/u, '');
  assert.equal(inspectWorkflowText('release.yml', text).some(({ rule }) => rule === 'windows-signing-provider-must-converge'), true);
});
```

Use `replaceAll` for the pin/timestamp mutations — both strings appear more than once in the fixture, and a single `replace` leaves a surviving reference that lets the checker pass vacuously.

- [ ] **Step 2: Run the new tests and confirm the checker does not yet enforce them**

Run: `node --test .github/scripts/check-workflow-security.test.mjs`

Expected: FAIL because one or more new mutation tests report no matching violation.

- [ ] **Step 3: Add focused job-section parsing and release-signing violations**

In `.github/scripts/check-workflow-security.mjs`, add constants for the six rule IDs above and three small helpers that do not exist yet: `escapeRegExp(value)`, `requirePattern(section, pattern, rule, violations, file)`, and `forbidPattern(section, pattern, rule, violations, file)`. Job sections come from the existing `workflowJobs(lines)` helper (`{ name, lines }` per direct child of `jobs:`) — do not write a second slicer. A pattern check runs against the section's joined `content` (`section.lines.map((line) => line.content).join('\n')`); `requirePattern` reports a violation when the section is missing entirely **or** the pattern does not match, anchored at `section.lines[0].line` (line 1 when the section is missing); `forbidPattern` reports only when a present section matches.

The release-specific checker must return immediately unless `file === 'release.yml'`, and stay silent when none of the four signing job IDs are present, so unrelated workflows and existing unit fixtures remain unaffected.

Implement the checks with order-independent assertions (a single ordered regex across the section breaks on the real step layout, where `env:` mappings precede `run:` blocks):

```js
const PUBLIC_AGENT_WINDOWS_ASSETS = [
  'breeze-agent-windows-amd64.exe',
  'breeze-backup-windows-amd64.exe',
  'breeze-watchdog-windows-amd64.exe',
  'breeze-user-helper-windows-amd64.exe',
  'breeze-agent.msi',
];
const SSLCOM_ACTION = 'SSLcom/esigner-codesign@cf5f6c1d38ad10f47e3ed9aca873f429b1a8d85b';
const SSLCOM_SECRETS = [
  'SSLCOM_USERNAME',
  'SSLCOM_PASSWORD',
  'SSLCOM_CREDENTIAL_ID',
  'SSLCOM_TOTP_SECRET',
  'SSLCOM_CERT_SHA256',
];

function publicReleaseSigningViolations(file, lines) {
  if (file !== 'release.yml') return [];
  const jobs = new Map(workflowJobs(lines).map((job) => [job.name, job]));
  const resolver = jobs.get('resolve-windows-signing-provider');
  const azure = jobs.get('sign-windows-tauri-azure');
  const sslcom = jobs.get('sign-windows-tauri-sslcom');
  const gate = jobs.get('sign-windows-tauri');
  if (!resolver && !azure && !sslcom && !gate) return [];

  const violations = [];
  // Resolver: explicit empty-to-azure normalization plus a failing default arm.
  requirePattern(resolver, /RAW_PROVIDER[\s\S]*:-azure[\s\S]*azure\|sslcom[\s\S]*\*\)[\s\S]*exit 1/u,
    'windows-signing-provider-must-fail-closed', violations, file);
  // OIDC lives in the Azure job and nowhere else.
  requirePattern(azure, /id-token:\s*write/u,
    'windows-signing-provider-least-privilege', violations, file);
  for (const section of [resolver, sslcom, gate]) {
    forbidPattern(section, /id-token:/u,
      'windows-signing-provider-least-privilege', violations, file);
  }
  requirePattern(sslcom, new RegExp(escapeRegExp(SSLCOM_ACTION), 'u'),
    'sslcom-signing-must-pin-certificate', violations, file);
  for (const secret of SSLCOM_SECRETS) {
    requirePattern(sslcom, new RegExp(`secrets\\.${secret}\\b`, 'u'),
      'sslcom-signing-must-pin-certificate', violations, file);
  }
  // The section must read the pin from the environment AND hash the signer
  // certificate with SHA-256; asserted separately, not as one ordered regex.
  requirePattern(sslcom, /\$env:SSLCOM_CERT_SHA256/u,
    'sslcom-signing-must-pin-certificate', violations, file);
  requirePattern(sslcom, /GetCertHashString\(\s*\[System\.Security\.Cryptography\.HashAlgorithmName\]::SHA256/u,
    'sslcom-signing-must-pin-certificate', violations, file);
  // Both providers must prove an RFC 3161 timestamp (design: Verification).
  for (const section of [azure, sslcom]) {
    requirePattern(section, /TimeStamperCertificate/u,
      'windows-signing-must-require-timestamp', violations, file);
  }
  for (const asset of PUBLIC_AGENT_WINDOWS_ASSETS) {
    forbidPattern(sslcom, new RegExp(escapeRegExp(asset), 'u'),
      'sslcom-signing-must-not-touch-agent', violations, file);
  }
  // Gate: runs on !cancelled() and consumes both signer results.
  requirePattern(gate, /!cancelled\(\)/u,
    'windows-signing-provider-must-converge', violations, file);
  requirePattern(gate, /needs\.sign-windows-tauri-azure\.result/u,
    'windows-signing-provider-must-converge', violations, file);
  requirePattern(gate, /needs\.sign-windows-tauri-sslcom\.result/u,
    'windows-signing-provider-must-converge', violations, file);
  return violations;
}
```

Call `publicReleaseSigningViolations(file, lines)` from `inspectWorkflowText` after the existing developer-signing checks; the existing final sort through `compareViolations` covers the new entries.

- [ ] **Step 4: Run the synthetic tests and confirm the checker passes them**

Run: `node --test .github/scripts/check-workflow-security.test.mjs`

Expected: PASS for the new passing fixture and every single-mutation rejection.

- [ ] **Step 5: Run the checker against the current release workflow to capture the intended red state**

Run: `node .github/scripts/check-workflow-security.mjs`

Expected: FAIL on `release.yml` — the pre-split workflow still carries the mixed `sign-windows-tauri` job, so the checker (keyed on that job ID) reports the missing resolver/azure/sslcom sections and a gate without the convergence topology. This red state is intentional and must not be committed on its own; the Step 6 workflow rewrite lands in the same commit (Step 10), so CI never sees it.

- [ ] **Step 6: Replace the mixed signer with resolver and provider-isolated jobs**

In `.github/workflows/release.yml`, replace the existing `sign-windows-tauri` body with this topology:

```yaml
  resolve-windows-signing-provider:
    name: Resolve Windows signing provider
    if: >-
      vars.ENABLE_WINDOWS_SIGNING == 'true'
      && github.ref_type == 'tag'
      && startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      provider: ${{ steps.provider.outputs.provider }}
    steps:
      - name: Validate provider
        id: provider
        shell: bash
        env:
          RAW_PROVIDER: ${{ vars.WINDOWS_SIGNING_PROVIDER }}
        run: |
          set -euo pipefail
          provider="${RAW_PROVIDER:-azure}"
          case "$provider" in
            azure|sslcom) echo "provider=$provider" >> "$GITHUB_OUTPUT" ;;
            *) echo "::error::WINDOWS_SIGNING_PROVIDER must be empty, azure, or sslcom"; exit 1 ;;
          esac

  sign-windows-tauri-azure:
    name: Sign Windows Tauri artifacts (Azure)
    needs: [build-viewer, build-helper, resolve-windows-signing-provider]
    if: needs.resolve-windows-signing-provider.outputs.provider == 'azure'
    runs-on: windows-latest
    permissions:
      contents: read
      id-token: write
    environment:
      name: ${{ contains(github.ref_name, '-') && 'signing-prerelease' || 'signing-production' }}

  sign-windows-tauri-sslcom:
    name: Sign Windows Tauri artifacts (SSL.com)
    needs: [build-viewer, build-helper, resolve-windows-signing-provider]
    if: needs.resolve-windows-signing-provider.outputs.provider == 'sslcom'
    runs-on: windows-latest
    permissions:
      contents: read
    environment:
      name: ${{ contains(github.ref_name, '-') && 'signing-prerelease' || 'signing-production' }}

  sign-windows-tauri:
    name: Windows Tauri signing convergence gate
    needs: [resolve-windows-signing-provider, sign-windows-tauri-azure, sign-windows-tauri-sslcom]
    if: ${{ !cancelled() && needs.resolve-windows-signing-provider.result != 'skipped' }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
```

Gate condition semantics — this is `!cancelled() && result != 'skipped'`, deliberately not `always() && result == 'success'`:

- Signing disabled (`ENABLE_WINDOWS_SIGNING != 'true'` or non-tag run): resolver skips, gate skips, and the downstream `success || skipped` conditions plus `release-integrity-gate` behave exactly as today.
- Resolver **failed** (invalid provider value): the gate must *run and fail* (the empty provider output hits Step 8's default arm), not skip — a skipped gate reads as "signing disabled" to `create-release`'s `success || skipped` check. `release-integrity-gate`'s `require_success` would still block a tag release, but the gate failing at the cause is the primary defense, not a downstream side effect.

Copy the current artifact downloads, the Azure validation/login/signing steps, and the canonical uploads into the Azure job without changing action pins, paths, profile selection, or artifact names. Copy the two SSL.com action steps (`command: sign`, per-file `file_path`, `override: true`) and the canonical uploads into the SSL.com job; per the approved design, flip `malware_block: false` to `malware_block: true` and add `clean_logs: true` — this deliberately changes the value shipped by #3762, and the step comment explaining the eSigner options must be updated to match. Extend the SSL.com validation step's required-secret list and `env:` block with `SSLCOM_CERT_SHA256`.

In **both** signer jobs, extend the copied "Verify signatures" step so each MSI must also present a non-null `$sig.SignerCertificate` and `$sig.TimeStamperCertificate` (the RFC 3161 timestamp proof) in addition to the existing `Status` check — the current step checks `Status` only, and the design's Verification section requires signer + timestamp for both providers.

- [ ] **Step 7: Add authoritative SSL.com certificate-pin verification**

Use this normalization and comparison inside the SSL.com verification loop after the shared status/signer/timestamp checks:

```powershell
$expected = ($env:SSLCOM_CERT_SHA256 -replace '[^0-9A-Fa-f]', '').ToLowerInvariant()
if ($expected -notmatch '^[0-9a-f]{64}$') {
  throw 'SSLCOM_CERT_SHA256 must contain exactly 64 hexadecimal characters'
}
$actual = ($sig.SignerCertificate.GetCertHashString(
  [System.Security.Cryptography.HashAlgorithmName]::SHA256
) -replace '[^0-9A-Fa-f]', '').ToLowerInvariant()
if ($actual -ne $expected) {
  throw "Unexpected SSL.com signer certificate for $target (SHA-256 $actual)"
}
$subject = $sig.SignerCertificate.Subject
if ($subject -notmatch '(?i)(?:^|,\s*)(?:O|CN)=LANTERNOPS LLC(?:,|$)') {
  throw "Unexpected SSL.com signer subject for $target: $subject"
}
```

Pass `SSLCOM_CERT_SHA256: ${{ secrets.SSLCOM_CERT_SHA256 }}` only to the SSL.com validation and verification steps. Do not print the expected pin or any credential value.

- [ ] **Step 8: Add the fail-closed convergence assertion**

The gate's only step must compare the selected provider with both job results:

```yaml
      - name: Assert single-provider convergence
        shell: bash
        env:
          PROVIDER: ${{ needs.resolve-windows-signing-provider.outputs.provider }}
          AZURE_RESULT: ${{ needs.sign-windows-tauri-azure.result }}
          SSLCOM_RESULT: ${{ needs.sign-windows-tauri-sslcom.result }}
        run: |
          set -euo pipefail
          case "$PROVIDER" in
            azure)
              [ "$AZURE_RESULT" = success ] && [ "$SSLCOM_RESULT" = skipped ] ;;
            sslcom)
              [ "$AZURE_RESULT" = skipped ] && [ "$SSLCOM_RESULT" = success ] ;;
            *)
              echo "::error::provider resolution failed or produced an unexpected value"
              exit 1 ;;
          esac
          echo "Provider '$PROVIDER' converged (azure=$AZURE_RESULT, sslcom=$SSLCOM_RESULT)."
```

The default `*)` arm is what turns a failed resolver into a failed gate (its output is empty when it never ran) — see the Step 6 gate-condition rationale. Errors may name the provider and job results only; never a secret. Preserve all existing downstream `needs: [sign-windows-tauri]` references.

- [ ] **Step 9: Run targeted and repository workflow checks**

Run:

```bash
corepack pnpm test:workflow-security
actionlint -color .github/workflows/release.yml
bash scripts/security/check-supply-chain-hardening.sh
```

(`test:workflow-security` already runs `node --test` over both test files and then the checker binary — don't duplicate those invocations.)

Expected: every command exits 0; the workflow checker reports no violations; `actionlint` reports no expression, job dependency, or YAML errors.

- [ ] **Step 10: Commit the workflow and invariant tests**

```bash
git add .github/scripts/check-workflow-security.mjs \
  .github/scripts/check-workflow-security.test.mjs \
  .github/workflows/release.yml
git commit -m "ci(release): harden SSL.com signing provider isolation"
```

### Task 2: Make public code-signing documentation provider-neutral

**Files:**
- Modify: `apps/docs/src/content/docs/deploy/code-signing.mdx:26-71`

**Interfaces:**
- Consumes: the Task 1 public workflow contract and the unchanged self-host Agent-family boundary.
- Produces: end-user documentation that identifies Viewer/Helper signatures by LanternOps publisher rather than promising one CA, while keeping public Agent artifacts explicitly unsigned.

- [ ] **Step 1: Update the artifact table and Windows overview**

Change the Viewer and Helper Windows signing method cells to `LanternOps Authenticode (Azure Artifact Signing or SSL.com eSigner)`. Replace the Azure-only opening paragraph with:

```mdx
The Windows **Viewer and Helper** installers are Authenticode-signed by LanternOps in the GitHub Actions release workflow. The release operator can use Azure Artifact Signing or SSL.com eSigner; both paths are timestamped and must pass the same publisher verification before an artifact is uploaded.
```

Leave the public Agent paragraph intact, including the explicit statement that its EXEs and MSI are unsigned signing inputs.

- [ ] **Step 2: Replace the Azure-only four-step description**

Use these exact operational guarantees:

```mdx
1. The release workflow selects exactly one configured Windows signing provider and fails if the provider value is invalid.

2. Azure authenticates with a short-lived OIDC token. SSL.com eSigner uses environment-protected credentials and a pinned LanternOps certificate thumbprint. The two providers run in separate jobs so SSL.com never receives Azure's OIDC permission.

3. The selected provider Authenticode-signs and RFC 3161-timestamps the Viewer and Helper installers.

4. The workflow verifies the signer certificate and timestamp before upload. The SSL.com path also requires the exact configured SHA-256 certificate thumbprint.

5. Signed artifacts are uploaded to the GitHub release together with a signed release manifest.
```

Replace the Azure-specific aside with a provider-neutral caution explaining that users should verify the publisher as LanternOps and that public Agent packages remain unsigned by design.

- [ ] **Step 3: Update the SmartScreen troubleshooting paragraph**

Remove the promise that Azure is always the publisher. State that reputation can take time for any newly introduced certificate, then retain the instruction to verify with `Get-AuthenticodeSignature` and the self-host signing link.

- [ ] **Step 4: Build the documentation**

Run: `corepack pnpm --filter @breeze/docs build`

Expected: Astro/Starlight build exits 0 with no broken MDX syntax or internal links.

- [ ] **Step 5: Commit the documentation**

```bash
git add apps/docs/src/content/docs/deploy/code-signing.mdx
git commit -m "docs(release): describe switchable Windows signing"
```

### Task 3: Final security verification and review gate

**Files:**
- Review only: `.github/workflows/release.yml`
- Review only: `.github/scripts/check-workflow-security.mjs`
- Review only: `.github/scripts/check-workflow-security.test.mjs`
- Review only: `apps/docs/src/content/docs/deploy/code-signing.mdx`

**Interfaces:**
- Consumes: Tasks 1-2 and the approved design at `docs/superpowers/specs/2026-08-21-sslcom-public-release-signing-hardening-design.md`.
- Produces: a review-ready branch whose automated checks prove provider isolation, certificate pinning, downstream convergence, and the unsigned public Agent boundary.

- [ ] **Step 1: Run the complete local verification set from a clean shell**

```bash
corepack pnpm test:workflow-security
bash scripts/security/check-supply-chain-hardening.sh
actionlint -color .github/workflows/release.yml
corepack pnpm --filter @breeze/docs build
git diff --check origin/main...HEAD
git status --short
```

Expected: all checks exit 0; `git diff --check` has no output; status is clean. (Diff against the merge base, not `HEAD~2` — the branch already carries the design/plan doc commits and may gain a review-fix commit.)

- [ ] **Step 2: Perform the permitted review gate**

Use `superpowers:requesting-code-review` once for the complete two-commit implementation when the user selected delegated execution. In inline mode without delegation authorization, perform a fresh-eye self-review against the same checklist. Compare the branch against the approved design and focus on GitHub expression semantics, skipped-job convergence, OIDC isolation, secret exposure, certificate hash normalization, and accidental Agent-family signing.

- [ ] **Step 3: Resolve findings with targeted tests**

For each valid finding, first add or tighten a mutation test in `.github/scripts/check-workflow-security.test.mjs`, run it to see the failure, make the smallest workflow/checker change, and rerun Task 3 Step 1. Commit fixes with:

```bash
git add .github/scripts/check-workflow-security.mjs \
  .github/scripts/check-workflow-security.test.mjs \
  .github/workflows/release.yml \
  apps/docs/src/content/docs/deploy/code-signing.mdx
git commit -m "fix(release): address signing hardening review"
```

Skip this commit when the independent review is clean.

- [ ] **Step 4: Record rollout prerequisites without configuring secrets**

In the implementation handoff, list the five SSL.com secrets required in both `signing-prerelease` and `signing-production`, state that the TOTP value is the enrollment seed rather than the rotating six-digit code, and require a prerelease tag with local signature inspection before changing the stable environment. Do not create secrets, change repository variables, dispatch a workflow, or publish a release until the user confirms the reset PIN/TOTP state and authorizes those external mutations.

---

## Post-review amendments (2026-08-21)

The PR review found gaps that changed several decisions above. The task
snippets earlier in this document record what was originally planned; where they
conflict with the list below, the list below is what shipped.

1. **CodeSignTool is staged locally against a verified digest.** Pinning the
   `SSLcom/esigner-codesign` commit does not pin what the action runs: it
   downloads CodeSignTool from a mutable GitHub release asset with no checksum
   and executes it in the job holding the eSigner credentials, and installs
   Amazon Corretto from a floating "latest" index whose checksum it reads but
   never compares. Both are now suppressed via `CODESIGNTOOL_PATH` and
   `JAVA_VERSION`. The verified archive bundles its own JDK.

2. **`clean_logs: true` was dropped, not added.** It is a no-op in this action —
   `path.dirname()` is applied to the whole command string, so it deletes a path
   that never exists and `force: true` swallows the error. The plan's rationale
   for enabling it does not hold.

3. **Verification is shared, not provider-specific.** Both providers now call
   `.github/scripts/Verify-WindowsSignature.ps1`. Keeping two inline copies is
   what produced the asymmetry the review found: the Azure copy asserted only
   that *some* timestamped signature existed and never checked the publisher.

4. **The subject check is not a regex and is not merely diagnostic.** It parses
   the DN via `X500DistinguishedName.Format()`. The planned regex rejected a
   legitimate `O="LanternOps, LLC"` certificate. On the Azure path — which pins
   no thumbprint, by design — the subject assertion is the *only* publisher
   binding, so it is authoritative there.

5. **`SSLCOM_ENVIRONMENT_LABEL` is a new required secret.** The stable/prerelease
   certificate split relies entirely on GitHub Environment scoping, which is
   invisible in YAML and unverifiable by lint. Both signing environments are
   currently empty and every `AZURE_*` secret lives at repository level, so the
   likeliest operator error would sign prereleases with the production
   certificate. This label makes that fail loudly.

6. **Lint rules bind to shape, not job names.** The planned rules keyed on four
   exact job names behind an early return, so a consistent rename disabled all of
   them — confirmed by deleting the certificate pin and subject check with CI
   green. Rules now locate each provider by the action or script that defines it,
   and a workflow that signs the Tauri MSIs must declare the full topology.

7. **The environments are not an approval boundary.** Neither carries required
   reviewers today — only a `v*` tag restriction. Statements to the contrary in
   the plan and in the first draft of the docs were corrected.

Still open, and deliberately not addressed here:

- Adding required reviewers to `signing-production` / `signing-prerelease` is an
  operator action, not a code change.
- Leaf-thumbprint rotation remains a single value. If staging a renewal without a
  release-day edit becomes necessary, `SSLCOM_CERT_SHA256` should become a
  separator-delimited allowlist.
