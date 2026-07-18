# `breeze-ext` Packer/Signer + Two-Replica Reconcile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `breeze-ext` deterministic packer and Ed25519 signer that produces `.breeze-ext` bundles the already-shipped Plan 02 verifier accepts byte-exactly, then use real signed bundles to prove two-replica reconciliation and required/optional failure policy.

**Scope note:** This plan implements the exit criteria of issue #2619. It corresponds to **Task 3 of the Plan 04 toolchain plan** (`2026-07-15-runtime-extension-platform-04-toolchain.md`), not to the Plan 05 Workspace plan — the issue's "Plan 05" label is a misnomer carried forward from PR #2617. Plan 04's other tasks (testkit, scaffolder, publish adapters, dev host, CI templates) are explicitly out of scope.

**Architecture:** A new `@breeze/extension-cli` package owns artifact production: canonical JSON, deterministic ZIP, integrity inventory, Ed25519 signing, inspection. It has no dependency on `apps/api`. The wire-format conformance test lives in `apps/api` (which takes the CLI as a devDependency) so the dependency arrow points from app to package, and so the test exercises the genuine `verifyExtensionBundle`.

**Tech Stack:** TypeScript 5.7, Node.js 22, Commander, Zod 4, Vitest 4, `archiver`, Ed25519 via `node:crypto`, PostgreSQL.

**Base:** branch `feat/runtime-ext-05-packer`, cut from `feat/runtime-ext-02-operations` (PR #2617, unmerged). The verifier and reconciler this plan tests against exist only on that branch.

---

## Global Constraints

- **`apps/api/src/extensions/bundleVerifier.ts` is FROZEN public surface.** The packer conforms to it. Do not modify it, and do not modify any Plan 02 verification behavior to accommodate the packer. If the packer cannot produce bytes it accepts, the packer is wrong.
- Never log, persist, embed in an error message, or commit as a fixture: private key material, bundle bytes, config secrets, raw exceptions/stacks, or SQL. Private keys are read from a file path or an environment variable name and held only in memory.
- No test fixture may contain a real private key committed to the repo. Generate keypairs at test runtime.
- Determinism contract: identical source tree + identical `SOURCE_DATE_EPOCH` + identical lockfile ⇒ byte-identical artifact. Cross-library-version byte-identity is explicitly NOT promised (digests are re-pinned per release).
- The CLI package must not import from `apps/api` or any Breeze-private app module.
- `pnpm-workspace.yaml` already globs `packages/*`; no workspace change is needed.

## Frozen Wire Format (transcribe exactly)

Read `apps/api/src/extensions/bundleVerifier.ts` before implementing. Summary, authoritative values:

**Archive:** ZIP. Reserved members are exactly `integrity.json` and `signature` (`bundleVerifier.ts:56`). Reserved members MUST NOT appear in the integrity inventory — the verifier throws if they do (`:208-212`).

**`integrity.json`** — strict Zod, extra keys rejected at both object levels (`:181-190`):

```json
{
  "algorithm": "sha256",
  "members": {
    "<archive-relative path>": { "sha256": "<64 lowercase hex>", "size": <non-negative int> }
  }
}
```

Every non-reserved archive member must appear, exactly 1:1 — the verifier checks both directions (`:273-291`). `manifest.json` is non-reserved and MUST be inventoried. `size` is the **uncompressed** byte length.

**`signature`** — **raw Ed25519 signature bytes**, nothing else. Verified with `crypto.verify(null, payload, publicKey, signature)` (`:254-266`). It is NOT a JSON envelope; there is no keyId, algorithm, or payload-hash field. (Plan 04 Task 3 Step 5 describes an envelope; that text is stale and is corrected by Task 9 of this plan.)

**Canonical signing payload** (`canonicalSigningPayload`, `:237-252`) — UTF-8 canonical JSON over exactly these five fields, no more:

```
apiVersion        // manifest.apiVersion
name              // manifest.name
version           // manifest.version
manifestSha256    // sha256 hex of the raw manifest.json BYTES
integritySha256   // sha256 hex of the raw integrity.json BYTES
```

`canonicalJson` (`:217-229`): object keys sorted by `Object.keys(...).sort()`, no whitespace, `JSON.stringify` for scalars and for key strings, arrays preserved in order. Hashes are **bare lowercase hex** — no `sha256:` prefix.

Ordering is load-bearing: write `integrity.json` first, hash its bytes, then sign. The signature covers the integrity doc, which covers every payload member. There is no recursive archive hash.

**Member name rules** (`assertSafeMemberName`, `:93-106`) — the packer must never emit a name that violates these:
- no leading `/`, no backslash anywhere, no empty/`.`/`..` path segment (so no `./` prefix)
- no name ending in `.node`
- forward slashes only
- no duplicate names (the verifier detects duplicates via central-directory count vs deduped map, `:137`)
- no symlink entries (Unix mode `S_IFLNK` in the high 16 bits of external attributes, `:108-112`)

**Archive limits** (`DEFAULT_ARCHIVE_LIMITS`, `:65-68`) — the packer must refuse to exceed: 10,000 members; 32 MiB per member; 128 MiB total uncompressed payload.

**Digest forms — do not mix:**
| Where | Form |
|---|---|
| `extensions.yaml` pinned digest, `VerifiedExtensionBundle.artifactDigest` | `sha256:<hex>` |
| `integrity.json` member hashes, `breeze_migrations.checksum` | bare `<hex>` |
| artifact store filename | `sha256-<hex>.breeze-ext` |

## Verification Gates

Every task that touches `packages/extension-cli`:
```
pnpm -F @breeze/extension-cli typecheck && pnpm -F @breeze/extension-cli test
```

Every task that touches `apps/api` (there is **no** `typecheck` script in `apps/api` — this is the real command):
```
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Unit tests: `pnpm -F @breeze/api test:run <paths>`. Integration: `pnpm -F @breeze/api test:integration --run <paths>`.

Integration DB is Docker Postgres on **:5433**. Set both `DATABASE_URL` and `DATABASE_URL_APP` to it — root `.env.test` sets neither and defaults to :5432. `pnpm -F @breeze/api test:docker:up` is idempotent. The `breeze-postgres-test` container is **shared across worktrees** — never run `test:docker:down -v`.

---

### Task 1: Create the `@breeze/extension-cli` package skeleton

**Files:**
- Create: `packages/extension-cli/package.json`
- Create: `packages/extension-cli/tsconfig.json`
- Create: `packages/extension-cli/vitest.config.ts`
- Create: `packages/extension-cli/src/index.ts`
- Create: `packages/extension-cli/src/cli.ts`
- Create: `packages/extension-cli/src/cli.test.ts`

**Interfaces:**
- Produces: the `breeze-ext` binary entrypoint and the package's public module surface.

- [ ] **Step 1: Write a failing CLI-surface test**

Assert that the Commander program registers exactly the commands `validate`, `pack`, `sign`, `inspect`; that `--help` exits 0; and that importing `src/index.ts` performs no filesystem or network work at module load.

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm -F @breeze/extension-cli test --run src/cli.test.ts`

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Create the package**

Mirror `packages/extension-sdk/package.json` conventions: `"private": true`, `"type": "module"`, `main`/`types`/`exports` pointing at `./src/index.ts`, and `test` / `typecheck` scripts. Add a `"bin": { "breeze-ext": "./src/cli.ts" }`. Dependencies: `commander`, `zod`, `archiver`, `@breeze/extension-sdk` (workspace, for manifest parsing). Dev: `@types/archiver`, `@types/node`, `typescript`, `vitest`. Pin the same major versions the sibling packages already use.

`tsconfig.json` mirrors `packages/extension-sdk/tsconfig.json`.

- [ ] **Step 4: Wire the command skeletons**

Each of the four commands is registered with its flags and a handler that delegates to a module in `src/commands/`. Subcommand bodies land in later tasks; this task only fixes the surface. `src/cli.ts` must not execute on import — guard the `program.parse()` behind a main-module check so tests can import it.

- [ ] **Step 5: Run verification**

Run: `pnpm install && pnpm -F @breeze/extension-cli typecheck && pnpm -F @breeze/extension-cli test`

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/extension-cli pnpm-lock.yaml
git commit -m "feat(extensions): scaffold breeze-ext CLI package"
```

### Task 2: Canonical JSON and the integrity inventory

**Files:**
- Create: `packages/extension-cli/src/artifact/canonicalJson.ts`
- Create: `packages/extension-cli/src/artifact/canonicalJson.test.ts`
- Create: `packages/extension-cli/src/artifact/integrity.ts`
- Create: `packages/extension-cli/src/artifact/integrity.test.ts`

**Interfaces:**
- Produces: `canonicalJson(value): string`, `buildIntegrityDocument(members): Buffer`, `signingPayload(manifest, manifestBytes, integrityBytes): Buffer`.

- [ ] **Step 1: Write failing canonicalization tests**

Cover: key sorting is bytewise via `Object.keys().sort()`; nested objects sort at every level; arrays preserve order; no whitespace anywhere; string keys and string values both go through `JSON.stringify` (so escaping matches); `null`, numbers, and booleans serialize as `JSON.stringify` does.

Include a **drift guard**: a test that constructs a payload and asserts our `signingPayload` output is byte-identical to the verifier's exported `canonicalSigningPayload`. Because the CLI package may not import `apps/api`, express this in Task 2 as a locked-down golden-vector test (hard-coded expected bytes for a fixture manifest), and let Task 6's conformance test in `apps/api` do the live cross-check against the real export.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm -F @breeze/extension-cli test --run src/artifact`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement `canonicalJson`**

Transcribe the algorithm from `bundleVerifier.ts:217-229` exactly. Do not "improve" it — a divergence here silently produces unverifiable bundles.

- [ ] **Step 4: Implement the integrity document builder**

Input: an ordered list of `{ path, bytes }` payload members. Output: the `integrity.json` **bytes**.

- Throw if any path is a reserved member (`integrity.json`, `signature`).
- Throw if any path is duplicated.
- `algorithm` is the literal `"sha256"`.
- `members` maps path → `{ sha256: <bare lowercase hex>, size: <uncompressed byte length> }`.
- Emit keys in sorted order and serialize via `canonicalJson` so the bytes are deterministic. The verifier's Zod schema is `.strict()` at both levels — emit no other keys.

- [ ] **Step 5: Implement `signingPayload`**

Exactly five fields, per the Frozen Wire Format section. Hashes bare hex. Return a UTF-8 `Buffer`.

- [ ] **Step 6: Run verification**

Run: `pnpm -F @breeze/extension-cli typecheck && pnpm -F @breeze/extension-cli test --run src/artifact`

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/extension-cli/src/artifact
git commit -m "feat(extensions): canonical JSON and integrity inventory"
```

### Task 3: Deterministic ZIP writer

**Files:**
- Create: `packages/extension-cli/src/artifact/deterministicZip.ts`
- Create: `packages/extension-cli/src/artifact/deterministicZip.test.ts`

**Interfaces:**
- Produces: `writeDeterministicZip(members: Array<{ path: string; bytes: Buffer }>, destination: string, options: { sourceDateEpoch: number }): Promise<void>`.

- [ ] **Step 1: Write failing determinism and rejection tests**

```ts
it('packs identical inputs to identical bytes', async () => {
  const first = await packToBuffer(MEMBERS, { sourceDateEpoch: 0 });
  const second = await packToBuffer(MEMBERS, { sourceDateEpoch: 0 });
  expect(sha256(first)).toBe(sha256(second));
});

it('is insensitive to input member order', async () => {
  const forward = await packToBuffer(MEMBERS, { sourceDateEpoch: 0 });
  const reversed = await packToBuffer([...MEMBERS].reverse(), { sourceDateEpoch: 0 });
  expect(sha256(forward)).toBe(sha256(reversed));
});
```

Also cover rejection of: absolute paths, `..` segments, `./` prefixes, backslashes, empty segments, `.node` suffixes, duplicate names, case-fold collisions (`Server/a.js` vs `server/a.js`), and each of the three archive limits (member count, per-member bytes, total bytes). Assert that a different `sourceDateEpoch` changes the bytes (proving the timestamp is actually applied, not ignored).

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm -F @breeze/extension-cli test --run src/artifact/deterministicZip.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the writer**

Use `archiver` in `zip` mode. Determinism requires pinning every varying field explicitly:

- Add entries in **bytewise-sorted path order** (`Buffer.compare` on the UTF-8 bytes, not locale `localeCompare`).
- Fixed `date` per entry, derived from `sourceDateEpoch` (seconds since epoch; default `0` when the env var is absent).
- Fixed `mode`: `0o644` for files. Emit **no directory entries** — the verifier does not need them and they are one more source of drift.
- Fixed `zlib: { level: 9 }`.
- No symlink entries, ever.
- Never emit a `.node` member.

Validate every path against the member-name rules from the Frozen Wire Format section *before* writing anything, and enforce the archive limits, so a bad tree fails before an artifact exists.

- [ ] **Step 4: Run verification**

Run: `pnpm -F @breeze/extension-cli typecheck && pnpm -F @breeze/extension-cli test --run src/artifact`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension-cli/src/artifact/deterministicZip.ts packages/extension-cli/src/artifact/deterministicZip.test.ts
git commit -m "feat(extensions): deterministic zip writer"
```

### Task 4: `breeze-ext pack`

**Files:**
- Create: `packages/extension-cli/src/commands/pack.ts`
- Create: `packages/extension-cli/src/commands/pack.test.ts`
- Create: `packages/extension-cli/src/artifact/collectPayload.ts`
- Create: `packages/extension-cli/src/artifact/collectPayload.test.ts`

**Interfaces:**
- Produces: `breeze-ext pack <sourceDir> --out <path>` and `packExtension(options): Promise<{ artifactPath: string; digest: string }>`.

- [ ] **Step 1: Write failing pack tests**

Cover: a fixture source tree packs to an archive containing `manifest.json`, `integrity.json`, the server entry, and migrations; `integrity.json` inventories every non-reserved member and nothing else; `manifest.json` IS inventoried; the manifest is parsed and rejected when invalid; the command refuses a source tree that already contains a file named `integrity.json` or `signature`; symlinks in the source tree are refused rather than followed; the output filename is `<name>-<version>.breeze-ext` when `--out` is a directory.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm -F @breeze/extension-cli test --run src/commands/pack.test.ts src/artifact/collectPayload.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement payload collection**

Walk the source directory. Use `lstat`, not `stat`, so symlinks are detected and refused instead of silently dereferenced. Normalize paths to forward slashes relative to the source root. Sort bytewise. Parse `manifest.json` through `parseExtensionManifestV1` from `@breeze/extension-sdk` and fail on any manifest the host would reject — packing an unverifiable bundle is a wasted release cycle.

- [ ] **Step 4: Implement `pack`**

Order is load-bearing:
1. Collect payload members (manifest, server, optional web, optional migrations).
2. Build `integrity.json` bytes over those members.
3. Write the ZIP: payload members **plus** `integrity.json`, no `signature` yet.
4. Print the artifact path and its `sha256:<hex>` digest.

An unsigned artifact is a valid intermediate; `sign` completes it.

- [ ] **Step 5: Run verification**

Run: `pnpm -F @breeze/extension-cli typecheck && pnpm -F @breeze/extension-cli test`

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/extension-cli/src/commands/pack.ts packages/extension-cli/src/commands/pack.test.ts packages/extension-cli/src/artifact/collectPayload.ts packages/extension-cli/src/artifact/collectPayload.test.ts
git commit -m "feat(extensions): deterministic bundle packing"
```

### Task 5: `breeze-ext sign`

**Files:**
- Create: `packages/extension-cli/src/artifact/signature.ts`
- Create: `packages/extension-cli/src/artifact/signature.test.ts`
- Create: `packages/extension-cli/src/commands/sign.ts`
- Create: `packages/extension-cli/src/commands/sign.test.ts`

**Interfaces:**
- Produces: `breeze-ext sign <artifact> --key <path> | --key-env <VAR>` and `signArtifact(options): Promise<{ artifactPath: string; digest: string }>`.

- [ ] **Step 1: Write failing signing tests**

Cover: signing an unsigned artifact produces a `signature` member whose bytes verify under the matching public key via `crypto.verify(null, payload, publicKey, signature)`; a different keypair fails verification; a mutated `integrity.json` invalidates the signature; the `signature` member is raw bytes, not JSON; re-signing an already-signed artifact is refused (or replaces the member — pick one and test it); a non-Ed25519 key is rejected with a clear message.

Add an explicit **secret-hygiene test**: capture stdout, stderr, and any thrown error from a failed signing run with a real (test-generated) private key, and assert none of them contain the key's PEM or raw bytes. Generate keypairs with `generateKeyPairSync('ed25519')` at test time; commit no key material.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm -F @breeze/extension-cli test --run src/artifact/signature.test.ts src/commands/sign.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement signing**

Read the private key from `--key <path>` or `--key-env <VAR>` (the variable *name*, never the key on the command line — argv is world-readable via `ps`). Load with `createPrivateKey`; reject any key whose `asymmetricKeyType` is not `ed25519`.

Read `manifest.json` and `integrity.json` bytes back out of the packed artifact, rebuild the signing payload with the same `signingPayload` function `pack` used, and sign with `crypto.sign(null, payload, privateKey)`. Write the resulting **raw signature bytes** as the `signature` member.

The artifact is rewritten deterministically through the same ZIP writer, with `signature` included as one more member. Print the final `sha256:<hex>` — this is the digest that goes in `extensions.yaml`, and it necessarily differs from the unsigned digest.

Never place key material, key paths' contents, or raw crypto exceptions into logs or error messages.

- [ ] **Step 4: Run verification**

Run: `pnpm -F @breeze/extension-cli typecheck && pnpm -F @breeze/extension-cli test`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension-cli/src/artifact/signature.ts packages/extension-cli/src/artifact/signature.test.ts packages/extension-cli/src/commands/sign.ts packages/extension-cli/src/commands/sign.test.ts
git commit -m "feat(extensions): ed25519 bundle signing"
```

### Task 6: Wire-format conformance against the real verifier

**Files:**
- Create: `apps/api/src/extensions/packerConformance.test.ts`
- Modify: `apps/api/package.json`

**Interfaces:**
- Consumes: `@breeze/extension-cli` (new devDependency of `apps/api`) and the frozen `verifyExtensionBundle`.

**This is the load-bearing task — exit criterion 1 of issue #2619.**

- [ ] **Step 1: Write the positive conformance test**

Pack and sign a fixture extension with the real CLI, then run the real `verifyExtensionBundle` over the result with a matching `TrustedPublisher` and a pinned digest. Assert it resolves, and that `bundle.manifest.name`, `bundle.artifactDigest`, and `bundle.files` match what the packer reported.

Also assert `signingPayload` from the CLI is byte-identical to `canonicalSigningPayload` from the verifier for the same inputs — the live drift guard Task 2 deferred here.

- [ ] **Step 2: Write the negative conformance tests**

Each must make `verifyExtensionBundle` **reject**:
- a payload member's bytes mutated after signing
- signed with a keypair the trust config does not list
- an extra member added to the archive after signing (not in the inventory)
- an inventoried member deleted from the archive
- `integrity.json` mutated after signing
- a reserved member added to the inventory
- the pinned digest not matching the artifact
- a `selection.version` that disagrees with the manifest

- [ ] **Step 3: Prove the negative tests are load-bearing**

For each negative case, temporarily neutralize the control it targets and confirm the test goes red; restore, and record the result in the task report. A security test that passes whether or not the control exists is worse than no test — it manufactures false confidence. Do not commit the neutralized state.

- [ ] **Step 4: Run verification**

Run: `pnpm -F @breeze/api test:run src/extensions/packerConformance.test.ts` and `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/extensions/packerConformance.test.ts apps/api/package.json pnpm-lock.yaml
git commit -m "test(extensions): packer output verifies against the frozen verifier"
```

### Task 7: `breeze-ext inspect`

**Files:**
- Create: `packages/extension-cli/src/commands/inspect.ts`
- Create: `packages/extension-cli/src/commands/inspect.test.ts`

**Interfaces:**
- Produces: `breeze-ext inspect <artifact> [--json]`.

- [ ] **Step 1: Write failing inspection tests**

Cover: `--json` reports artifact digest, manifest identity, signature validity, inventory validity, and the migration list; a tampered member is reported with a stable machine-readable code (`integrity_mismatch`); exit code is nonzero on any verification failure and zero on a clean artifact; human output contains no environment data, no absolute checkout paths, and no key material.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm -F @breeze/extension-cli test --run src/commands/inspect.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement inspection**

Inspection re-derives the inventory from the archive and compares. Signature validity is reported only when a public key is supplied (`--public-key`); with no key, report `signature: "unverified"` rather than implying validity. Do not reimplement the verifier's trust decisions — `inspect` is an author-side diagnostic, and it must never be presented as equivalent to host verification.

- [ ] **Step 4: Run verification**

Run: `pnpm -F @breeze/extension-cli typecheck && pnpm -F @breeze/extension-cli test`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension-cli/src/commands/inspect.ts packages/extension-cli/src/commands/inspect.test.ts
git commit -m "feat(extensions): artifact inspection"
```

### Task 8: Two-replica reconcile and failure policy

**Files:**
- Create: `apps/api/src/extensions/twoReplicaReconcile.integration.test.ts`
- Create: `apps/api/src/extensions/__fixtures__/twoReplica.ts`

**Interfaces:**
- Consumes: the reconciler, migrator, state store, and artifact store from Plan 02; real signed bundles from Tasks 4–5.

**Exit criteria 2 and 3 of issue #2619.**

- [ ] **Step 1: Build the two-replica harness**

Two independent reconciler instances against the same `:5433` database, each with its own artifact-store root and its own state-store connection, run concurrently. The harness must be able to (a) start both and await convergence, and (b) observe how many times each migration actually applied.

Read `reconciler.ts`, `migrator.ts`, and `stateStore.ts` first and build the harness against their real seams. If those seams do not permit two genuinely independent instances in one process, report that as a BLOCKED finding rather than faking concurrency — a harness where both "replicas" share a lock manager proves nothing about advisory-lock serialization.

- [ ] **Step 2: Write the happy-path two-replica test**

One **required** and one **optional** signed extension, both packed and signed by the real CLI. Assert: both replicas activate both extensions; each migration is applied exactly once (advisory-lock serialized, verified against the migration ledger, not by counting log lines); both replicas converge on the same active set.

- [ ] **Step 3: Write the failure-policy tests**

- A failing **required** extension aborts boot on **both** replicas.
- A failing **optional** extension leaves **both** replicas booting, with the extension recorded failed and withdrawn from the active set.

Induce failure through a genuinely failing extension (e.g. a migration that violates a constraint), not by stubbing the reconciler's error path.

- [ ] **Step 4: Run verification**

Run:
```
pnpm -F @breeze/api test:docker:up
DATABASE_URL=postgresql://...:5433/... DATABASE_URL_APP=postgresql://...:5433/... \
  pnpm -F @breeze/api test:integration --run src/extensions/twoReplicaReconcile.integration.test.ts
```
and the `apps/api` typecheck command.

Expected: all PASS. Do **not** run `test:docker:down -v`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/extensions/twoReplicaReconcile.integration.test.ts apps/api/src/extensions/__fixtures__/twoReplica.ts
git commit -m "test(extensions): two-replica reconcile and failure policy"
```

### Task 9: Correct the stale Plan 04 signature spec

**Repository:** `breeze-workspace` (a separate repo — commit there, not in Breeze).

**Files:**
- Modify: `docs/superpowers/plans/2026-07-15-runtime-extension-platform-04-toolchain.md`

- [ ] **Step 1: Correct Task 3 Step 5**

Replace the sentence describing a `signature` member containing "the key ID, algorithm, signature, and signing-payload SHA-256" with the shipped reality: the `signature` member is raw Ed25519 signature bytes over the canonical signing payload, and publisher/key selection comes from `extensions.yaml` trust configuration rather than from anything inside the artifact.

- [ ] **Step 2: Note the plan-numbering correction**

Add a line to the plan sequence in `2026-07-15-runtime-extension-platform-plan.md` noting that the packer/signer of Plan 04 Task 3 was delivered separately under issue #2619 and this plan file.

- [ ] **Step 3: Commit in `breeze-workspace`**

```bash
git add docs/superpowers/plans
git commit -m "docs: correct signature envelope spec to shipped raw-bytes format"
```

## Plan Verification

- [ ] `pnpm -F @breeze/extension-cli typecheck && pnpm -F @breeze/extension-cli test` — all PASS.
- [ ] `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json` — clean.
- [ ] Bundles produced by `breeze-ext pack` + `sign` verify against an **unmodified** `verifyExtensionBundle` (Task 6).
- [ ] Every negative conformance test is demonstrated to fail when its control is neutralized (Task 6 Step 3).
- [ ] Two API replicas reconcile one required and one optional signed extension; migrations apply exactly once; both converge (Task 8).
- [ ] A failing required extension aborts boot on both replicas; a failing optional one leaves both booting, recorded failed and withdrawn (Task 8).
- [ ] `git diff` confirms `apps/api/src/extensions/bundleVerifier.ts` is unmodified on this branch.
- [ ] No committed key material: `git log -p` over the branch contains no `PRIVATE KEY` block.
