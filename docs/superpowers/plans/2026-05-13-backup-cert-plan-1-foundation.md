# Backup Certification — Plan 1: Foundation + Advisory CI Gate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the "stamp" mechanism (source-hash manifest, Ed25519 signing/verification, append-only repo storage, advisory CI gate) for the backup certification system, without any lab infrastructure. Produces immediate value: any change to backup-critical code is detected and surfaces in CI, even before real cert runs exist.

**Architecture:** Pure tooling — TypeScript scripts that read `cert-manifests/BACKUP_CRITICAL_PATHS.yaml`, walk the source tree, compute SHA-256 hashes, build canonical JSON, sign with Ed25519, verify signatures. CI runs these scripts on every PR. No new services, no lab dependencies.

**Tech Stack:** Node 22, TypeScript via tsx, `@noble/ed25519` for signing, `yaml` for parsing the path list, `glob` for path matching, Vitest for unit tests, GitHub Actions for CI. Child processes use `node:child_process` `execFileSync` (never `exec` / `execSync` with a string command) to avoid shell injection.

**Spec reference:** `docs/superpowers/specs/2026-05-13-backup-certification-design.md` §§ 3, 6, 7, 14.1, 14.2, 14.3, 14.5 (the advisory-only subset; §14.4 release gate enforcement deferred to Plan 3).

**Out of scope for Plan 1:**
- Lab adapters (proxmox, winrm, smb) → Plan 2
- Action verb implementations (seed, trigger_backup, etc.) → Plan 2
- Cert API instance docker-compose → Plan 2
- Corpus generator → Plan 2
- First real cert run / first signed manifest → Plan 2
- Flipping the gate from advisory to required → Plan 3
- Release workflow integration (`--cert-bypass` flag) → Plan 3
- Meta-test (intentionally-tampered forge) → Plan 3
- Full doc set (runbook, incident playbook, templates.md) — Plan 1 ships skeletons; Plan 3 fills them out.

---

## File Structure (created by this plan)

**Source-of-truth files (committed):**
- `cert-manifests/BACKUP_CRITICAL_PATHS.yaml` — initial scope list
- `cert-manifests/BYPASSES.md` — append-only log (empty template)
- `cert-manifests/README.md` — directs readers to docs/backup-certification/
- `internal/release-keys/breeze-cert.2026-Q2.pub` — first signing public key (private in 1Password)
- `.github/CODEOWNERS` — append-only protection for cert-manifests/

**Scripts (the toolkit):**
- `scripts/cert/canonicalJson.ts` — canonical JSON encoder
- `scripts/cert/canonicalJson.test.ts`
- `scripts/cert/sourceHashes.ts` — walk BACKUP_CRITICAL_PATHS.yaml and hash matched files
- `scripts/cert/sourceHashes.test.ts`
- `scripts/cert/manifest.ts` — manifest schema, sign, verify
- `scripts/cert/manifest.test.ts`
- `scripts/cert/sign-cert-manifest.ts` — CLI: take an unsigned manifest, sign it
- `scripts/cert/verify-cert-manifest.ts` — CLI: verify all manifests in cert-manifests/
- `scripts/cert/cert-diff.ts` — CLI: show which features need re-cert at HEAD
- `scripts/cert/scan-backup-source.ts` — CLI used by CI to detect source-hash drift
- `scripts/cert/check-append-only.ts` — CLI: enforce no modifications to existing files under cert-manifests/
- `scripts/cert/gitHelpers.ts` — small wrapper around `execFileSync('git', ...)` for safe git invocations

**Docs (skeletons; Plan 3 fills):**
- `docs/backup-certification/README.md`
- `docs/backup-certification/key-management.md`
- `docs/backup-certification/bypass-policy.md`

**CI:**
- `.github/workflows/backup-cert-check.yml` — advisory CI workflow

**Modified files:**
- `package.json` (root) — add scripts `cert:scan`, `cert:verify`, `cert:diff`, `cert:append-only-check`, `cert:sign`, `cert:test`
- Add `tsx`, `@noble/ed25519`, `yaml`, `glob`, `vitest`, `@types/node` to root devDependencies (only items not already present)

---

## Task 1: Add tooling dependencies

**Files:**
- Modify: `package.json` (root)

- [ ] **Step 1: Inspect current root devDependencies**

Run:
```bash
grep -A 20 '"devDependencies"' /Users/toddhebebrand/breeze/package.json
```

Expected: current list. Note which of `tsx`, `@noble/ed25519`, `yaml`, `glob`, `vitest`, `@types/node` are missing.

- [ ] **Step 2: Add missing devDependencies**

Run from repo root:
```bash
pnpm add -Dw tsx @noble/ed25519 yaml glob vitest @types/node
```

The `-w` flag installs at the workspace root. If any of these already exist with compatible versions, that's fine — pnpm dedups.

- [ ] **Step 3: Add cert scripts to root package.json**

In `package.json`, add to the `scripts` block:

```json
"cert:scan": "tsx scripts/cert/scan-backup-source.ts",
"cert:verify": "tsx scripts/cert/verify-cert-manifest.ts",
"cert:diff": "tsx scripts/cert/cert-diff.ts",
"cert:append-only-check": "tsx scripts/cert/check-append-only.ts",
"cert:sign": "tsx scripts/cert/sign-cert-manifest.ts",
"cert:test": "vitest run scripts/cert"
```

- [ ] **Step 4: Verify pnpm install is happy**

Run:
```bash
pnpm install
```

Expected: completes without error.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(cert): add tooling deps and pnpm scripts for backup cert system"
```

---

## Task 2: Safe git helpers

**Files:**
- Create: `scripts/cert/gitHelpers.ts`

Every git call in Plan 1 must use `execFileSync` (not `exec`/`execSync` with a single command string) to avoid shell injection. Centralize the wrappers here so consumers can't misuse.

- [ ] **Step 1: Implement git helpers**

Create `scripts/cert/gitHelpers.ts`:

```ts
import { execFileSync } from 'node:child_process';

function git(args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    if (opts.allowFail) return '';
    throw e;
  }
}

export function gitHeadCommit(): string {
  return git(['rev-parse', 'HEAD']);
}

export function gitMergeBaseWithMain(): string | null {
  const out = git(['merge-base', 'HEAD', 'origin/main'], { allowFail: true });
  return out || null;
}

export function gitDiffNames(base: string, head = 'HEAD'): string[] {
  const out = git(['diff', '--name-only', `${base}...${head}`]);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

export function gitDiffNameStatus(
  base: string,
  head = 'HEAD'
): Array<{ status: string; file: string }> {
  const out = git(['diff', '--name-status', `${base}...${head}`]);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status, file: rest.join('\t') };
    });
}

export function gitDiffNamesAgainstWorkingTree(): string[] {
  const out = git(['diff', '--name-only', 'HEAD']);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}
```

- [ ] **Step 2: Smoke-test (no unit test — these are thin wrappers)**

Run:
```bash
pnpm tsx -e "import('./scripts/cert/gitHelpers').then(g => console.log('HEAD:', g.gitHeadCommit()))"
```

Expected: prints the current HEAD commit SHA.

- [ ] **Step 3: Commit**

```bash
git add scripts/cert/gitHelpers.ts
git commit -m "feat(cert): safe git helpers using execFileSync"
```

---

## Task 3: Canonical JSON encoder

**Files:**
- Create: `scripts/cert/canonicalJson.ts`
- Create: `scripts/cert/canonicalJson.test.ts`

Canonical JSON is the byte-level-deterministic form of a JS object: keys sorted lexicographically at every level, no extra whitespace, UTF-8 encoded, with predictable handling of numbers. This is what we sign.

- [ ] **Step 1: Write the failing tests**

Create `scripts/cert/canonicalJson.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canonicalize } from './canonicalJson';

describe('canonicalize', () => {
  it('sorts object keys lexicographically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested object keys', () => {
    expect(canonicalize({ outer: { y: 1, x: 2 } })).toBe(
      '{"outer":{"x":2,"y":1}}'
    );
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles strings with quotes and backslashes', () => {
    expect(canonicalize({ s: 'a"b\\c' })).toBe('{"s":"a\\"b\\\\c"}');
  });

  it('produces no whitespace', () => {
    const out = canonicalize({ a: 1, b: [1, 2, { c: 3 }] });
    expect(out).not.toMatch(/\s/);
  });

  it('rejects undefined values inside objects', () => {
    expect(() => canonicalize({ a: undefined })).toThrow();
  });

  it('rejects NaN and Infinity', () => {
    expect(() => canonicalize({ a: NaN })).toThrow();
    expect(() => canonicalize({ a: Infinity })).toThrow();
  });

  it('encodes integers and decimals correctly', () => {
    expect(canonicalize({ a: 1 })).toBe('{"a":1}');
    expect(canonicalize({ a: 1.5 })).toBe('{"a":1.5}');
  });

  it('is byte-identical for re-encoded output', () => {
    const obj = { z: 1, a: { c: 2, b: 3 } };
    const once = canonicalize(obj);
    const twice = canonicalize(JSON.parse(once));
    expect(twice).toBe(once);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run:
```bash
pnpm cert:test -- canonicalJson
```

Expected: FAIL — module `./canonicalJson` not found.

- [ ] **Step 3: Implement canonicalize**

Create `scripts/cert/canonicalJson.ts`:

```ts
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalize: non-finite number not allowed (${value})`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) {
        throw new Error(`canonicalize: undefined value at key "${k}"`);
      }
      parts.push(JSON.stringify(k) + ':' + canonicalize(v));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`canonicalize: unsupported type ${typeof value}`);
}
```

- [ ] **Step 4: Re-run tests, expect pass**

Run:
```bash
pnpm cert:test -- canonicalJson
```

Expected: all 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cert/canonicalJson.ts scripts/cert/canonicalJson.test.ts
git commit -m "feat(cert): canonical JSON encoder for signing"
```

---

## Task 4: BACKUP_CRITICAL_PATHS.yaml and cert-manifests/README

**Files:**
- Create: `cert-manifests/BACKUP_CRITICAL_PATHS.yaml`
- Create: `cert-manifests/README.md`

- [ ] **Step 1: Create the path list**

Create `cert-manifests/BACKUP_CRITICAL_PATHS.yaml`:

```yaml
# Changes to any path matched by this file invalidate every Cert Manifest
# that references it. CI checks this on every PR.
#
# This file IS part of its own scope (self-referential): changing what
# counts as backup-critical invalidates every existing manifest.
#
# Spec: docs/superpowers/specs/2026-05-13-backup-certification-design.md §7

schemaVersion: 1
include:
  - cert-manifests/BACKUP_CRITICAL_PATHS.yaml
  - agent/internal/backup/**
  - agent/internal/heartbeat/handlers_backup.go
  - agent/internal/heartbeat/handlers_vault.go
  - apps/api/src/routes/backup/**
  - apps/api/src/routes/c2c/**
  - apps/api/src/db/schema/backup.ts
  - apps/api/src/db/schema/backupVerification.ts
  - apps/api/src/db/schema/c2c.ts
  - apps/api/src/db/schema/drPlans.ts
  - apps/api/src/services/backupEncryption.ts
  - apps/api/src/services/backupSnapshotStorage.ts
  - packages/shared/src/types/backup*.ts
  - apps/api/migrations/*backup*.sql
  - apps/api/migrations/*c2c*.sql
  - apps/api/migrations/*vault*.sql
  - apps/api/migrations/*dr*.sql

# Files matched here are excluded even if matched by include. Use for
# test files, generated artifacts, or anything that shouldn't trigger
# re-cert when modified.
exclude:
  - '**/*.test.ts'
  - '**/*_test.go'
```

- [ ] **Step 2: Verify glob patterns match expected files**

Run from repo root:
```bash
pnpm tsx -e "
import { globSync } from 'glob';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
const cfg = parse(readFileSync('cert-manifests/BACKUP_CRITICAL_PATHS.yaml','utf8'));
const inc = cfg.include.flatMap((p: string) => globSync(p, {dot:false, nodir:true}));
const exc = new Set(cfg.exclude.flatMap((p: string) => globSync(p, {dot:false, nodir:true})));
const final = inc.filter((p: string) => !exc.has(p));
console.log('Matched files:', final.length);
final.slice(0,15).forEach((f: string) => console.log('  '+f));
"
```

Expected: 50–200 files matched. Spot-check that `agent/internal/backup/backup.go` is in the list and that `agent/internal/backup/backup_collect_test.go` is **not** (excluded by `**/*_test.go`).

- [ ] **Step 3: Create the cert-manifests README**

Create `cert-manifests/README.md`:

```markdown
# cert-manifests/

This directory holds **append-only** signed Cert Manifests for the Backup
Certification System. Each subdirectory corresponds to a certified feature;
each JSON file in a subdirectory is a single Cert Manifest signed by an
Ed25519 key checked in under `internal/release-keys/`.

**Do not modify existing files in this directory.** New manifests are added
by `pnpm cert:sign`; the `check-append-only` CI step rejects any PR that
modifies an existing file here.

- `BACKUP_CRITICAL_PATHS.yaml` — the source-hash scope. Editing this
  invalidates every manifest.
- `BYPASSES.md` — append-only log of `--cert-bypass` releases (Plan 3).
- `<feature>/<utc>-<sha>.json` — a signed Cert Manifest.
- `<feature>/latest.json` — pointer to the most recent manifest for HEAD.

See `docs/backup-certification/` and
`docs/superpowers/specs/2026-05-13-backup-certification-design.md` for the
full design.
```

- [ ] **Step 4: Commit**

```bash
git add cert-manifests/BACKUP_CRITICAL_PATHS.yaml cert-manifests/README.md
git commit -m "feat(cert): declare initial backup-critical path list"
```

---

## Task 5: Source-hash scanner

**Files:**
- Create: `scripts/cert/sourceHashes.ts`
- Create: `scripts/cert/sourceHashes.test.ts`

The scanner reads `BACKUP_CRITICAL_PATHS.yaml`, expands the globs, computes SHA-256 of each matched file's content, and returns a deterministic `{path: sha256}` map. Path keys are repo-relative POSIX-style strings.

- [ ] **Step 1: Write the failing tests**

Create `scripts/cert/sourceHashes.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { computeSourceHashes } from './sourceHashes';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-sh-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(rel: string, contents: string) {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

describe('computeSourceHashes', () => {
  it('returns sha256 for each matched file, keyed by POSIX-style relative path', async () => {
    writeFile('a/foo.go', 'hello');
    writeFile('a/bar.go', 'world');
    writeFile('paths.yaml', `schemaVersion: 1\ninclude:\n  - a/**\nexclude: []\n`);
    const result = await computeSourceHashes(tmpDir, 'paths.yaml');
    expect(Object.keys(result).sort()).toEqual(['a/bar.go', 'a/foo.go']);
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(result['a/foo.go']).toBe(
      'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });

  it('respects exclude patterns', async () => {
    writeFile('a/foo.go', 'hello');
    writeFile('a/foo_test.go', 'hello test');
    writeFile(
      'paths.yaml',
      `schemaVersion: 1\ninclude:\n  - a/**\nexclude:\n  - '**/*_test.go'\n`
    );
    const result = await computeSourceHashes(tmpDir, 'paths.yaml');
    expect(Object.keys(result)).toEqual(['a/foo.go']);
  });

  it('produces deterministic key order', async () => {
    writeFile('z.go', 'z');
    writeFile('a.go', 'a');
    writeFile('m.go', 'm');
    writeFile('paths.yaml', `schemaVersion: 1\ninclude:\n  - '*.go'\nexclude: []\n`);
    const result = await computeSourceHashes(tmpDir, 'paths.yaml');
    expect(Object.keys(result)).toEqual(['a.go', 'm.go', 'z.go']);
  });

  it('uses forward slashes even on Windows-style inputs', async () => {
    writeFile('nested/dir/file.go', 'x');
    writeFile('paths.yaml', `schemaVersion: 1\ninclude:\n  - nested/**\nexclude: []\n`);
    const result = await computeSourceHashes(tmpDir, 'paths.yaml');
    expect(Object.keys(result)[0]).toBe('nested/dir/file.go');
  });

  it('throws if the paths file is missing', async () => {
    await expect(computeSourceHashes(tmpDir, 'missing.yaml')).rejects.toThrow(
      /BACKUP_CRITICAL_PATHS.*not found|ENOENT/i
    );
  });

  it('throws if the paths file has wrong schemaVersion', async () => {
    writeFile('paths.yaml', `schemaVersion: 99\ninclude: []\nexclude: []\n`);
    await expect(computeSourceHashes(tmpDir, 'paths.yaml')).rejects.toThrow(
      /schemaVersion/
    );
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run:
```bash
pnpm cert:test -- sourceHashes
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the scanner**

Create `scripts/cert/sourceHashes.ts`:

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { globSync } from 'glob';
import { parse as parseYaml } from 'yaml';

export type SourceHashes = Record<string, string>;

interface PathsConfig {
  schemaVersion: number;
  include: string[];
  exclude: string[];
}

function readConfig(repoRoot: string, pathsFile: string): PathsConfig {
  const full = path.join(repoRoot, pathsFile);
  if (!fs.existsSync(full)) {
    throw new Error(
      `BACKUP_CRITICAL_PATHS file not found at ${full}`
    );
  }
  const raw = parseYaml(fs.readFileSync(full, 'utf8'));
  if (raw?.schemaVersion !== 1) {
    throw new Error(
      `Unsupported schemaVersion in ${pathsFile}: expected 1, got ${raw?.schemaVersion}`
    );
  }
  return {
    schemaVersion: raw.schemaVersion,
    include: Array.isArray(raw.include) ? raw.include : [],
    exclude: Array.isArray(raw.exclude) ? raw.exclude : [],
  };
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function expand(repoRoot: string, patterns: string[]): Set<string> {
  const out = new Set<string>();
  for (const pat of patterns) {
    const matches = globSync(pat, {
      cwd: repoRoot,
      dot: false,
      nodir: true,
      absolute: false,
      posix: true,
    });
    for (const m of matches) {
      out.add(toPosix(m));
    }
  }
  return out;
}

function sha256File(absPath: string): string {
  const buf = fs.readFileSync(absPath);
  const hex = createHash('sha256').update(buf).digest('hex');
  return `sha256:${hex}`;
}

export async function computeSourceHashes(
  repoRoot: string,
  pathsFile = 'cert-manifests/BACKUP_CRITICAL_PATHS.yaml'
): Promise<SourceHashes> {
  const cfg = readConfig(repoRoot, pathsFile);
  const included = expand(repoRoot, cfg.include);
  const excluded = expand(repoRoot, cfg.exclude);
  const finalSet = [...included].filter((p) => !excluded.has(p)).sort();

  const out: SourceHashes = {};
  for (const rel of finalSet) {
    out[rel] = sha256File(path.join(repoRoot, rel));
  }
  return out;
}
```

- [ ] **Step 4: Re-run tests, expect pass**

Run:
```bash
pnpm cert:test -- sourceHashes
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Smoke-test against the real repo**

Run from repo root:
```bash
pnpm tsx -e "
import { computeSourceHashes } from './scripts/cert/sourceHashes';
computeSourceHashes(process.cwd()).then(h => {
  const keys = Object.keys(h);
  console.log('files:', keys.length);
  console.log('first 5:', keys.slice(0,5));
});
"
```

Expected: prints ~50–200 files, including `agent/internal/backup/backup.go`. No errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/cert/sourceHashes.ts scripts/cert/sourceHashes.test.ts
git commit -m "feat(cert): source-hash scanner over BACKUP_CRITICAL_PATHS"
```

---

## Task 6: Manifest schema, signing, and verification

**Files:**
- Create: `scripts/cert/manifest.ts`
- Create: `scripts/cert/manifest.test.ts`

This module owns the manifest type, sign(manifest, privKey), verify(manifest, pubKeys), and the canonical bytes that get signed.

- [ ] **Step 1: Write the failing tests**

Create `scripts/cert/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import {
  buildUnsignedManifest,
  signManifest,
  verifyManifest,
  type CertManifest,
  type UnsignedCertManifest,
} from './manifest';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

async function makeKeypair() {
  const priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  return { priv, pub };
}

function sampleUnsigned(overrides: Partial<UnsignedCertManifest> = {}): UnsignedCertManifest {
  return buildUnsignedManifest({
    feature: 'file-level-backup-windows-s3',
    certifiedAt: '2026-05-13T14:38:47Z',
    git: { commit: 'a'.repeat(40), tag: null },
    sourceHashes: { 'agent/internal/backup/backup.go': 'sha256:' + '0'.repeat(64) },
    evidence: {
      s3Object: 's3://bucket/x.tar.zst',
      bundleSha256: 'sha256:' + '1'.repeat(64),
    },
    ...overrides,
  });
}

describe('manifest', () => {
  it('round-trips: sign → verify with known key', async () => {
    const { priv, pub } = await makeKeypair();
    const unsigned = sampleUnsigned();
    const signed = await signManifest(unsigned, priv, 'breeze-cert-2026-Q2', pub);
    const result = await verifyManifest(signed, [
      { keyId: 'breeze-cert-2026-Q2', publicKey: pub },
    ]);
    expect(result.ok).toBe(true);
  });

  it('verify fails if signature is tampered', async () => {
    const { priv, pub } = await makeKeypair();
    const unsigned = sampleUnsigned();
    const signed = await signManifest(unsigned, priv, 'k', pub);
    const tampered: CertManifest = {
      ...signed,
      signature: { ...signed.signature, value: signed.signature.value.slice(0, -2) + 'AA' },
    };
    const result = await verifyManifest(tampered, [{ keyId: 'k', publicKey: pub }]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/signature/i);
  });

  it('verify fails if a sourceHash is tampered', async () => {
    const { priv, pub } = await makeKeypair();
    const unsigned = sampleUnsigned();
    const signed = await signManifest(unsigned, priv, 'k', pub);
    const tampered: CertManifest = {
      ...signed,
      sourceHashes: {
        ...signed.sourceHashes,
        'agent/internal/backup/backup.go': 'sha256:' + 'f'.repeat(64),
      },
    };
    const result = await verifyManifest(tampered, [{ keyId: 'k', publicKey: pub }]);
    expect(result.ok).toBe(false);
  });

  it('verify fails for unknown keyId', async () => {
    const { priv, pub } = await makeKeypair();
    const unsigned = sampleUnsigned();
    const signed = await signManifest(unsigned, priv, 'unknown-key', pub);
    const result = await verifyManifest(signed, [
      { keyId: 'some-other-key', publicKey: new Uint8Array(32) },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown key/i);
  });

  it('signature is deterministic for identical payloads', async () => {
    const { priv, pub } = await makeKeypair();
    const unsigned = sampleUnsigned();
    const signed1 = await signManifest(unsigned, priv, 'k', pub);
    const signed2 = await signManifest(
      JSON.parse(JSON.stringify(unsigned)),
      priv,
      'k',
      pub
    );
    expect(signed1.signature.value).toBe(signed2.signature.value);
  });

  it('buildUnsignedManifest rejects bad fields', () => {
    expect(() =>
      buildUnsignedManifest({
        feature: '',
        certifiedAt: '2026-05-13T14:38:47Z',
        git: { commit: 'a'.repeat(40), tag: null },
        sourceHashes: { 'x': 'sha256:' + '0'.repeat(64) },
        evidence: { s3Object: 's3://x', bundleSha256: 'sha256:' + '0'.repeat(64) },
      })
    ).toThrow(/feature/);
    expect(() =>
      buildUnsignedManifest({
        feature: 'f',
        certifiedAt: 'not-iso',
        git: { commit: 'a'.repeat(40), tag: null },
        sourceHashes: { 'x': 'sha256:' + '0'.repeat(64) },
        evidence: { s3Object: 's3://x', bundleSha256: 'sha256:' + '0'.repeat(64) },
      })
    ).toThrow(/certifiedAt/);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run:
```bash
pnpm cert:test -- manifest
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the manifest module**

Create `scripts/cert/manifest.ts`:

```ts
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { canonicalize } from './canonicalJson';

// @noble/ed25519 v2 needs sha512 wired in.
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export interface CertManifestGit {
  commit: string;
  tag: string | null;
}

export interface CertManifestEvidence {
  s3Object: string;
  bundleSha256: string;
}

export interface CertManifestSignatureFields {
  alg: 'ed25519';
  keyId: string;
  publicKey: string; // base64
  value: string; // base64
}

export interface UnsignedCertManifest {
  schemaVersion: 1;
  feature: string;
  certifiedAt: string; // ISO-8601 UTC
  git: CertManifestGit;
  sourceHashes: Record<string, string>;
  evidence: CertManifestEvidence;
}

export interface CertManifest extends UnsignedCertManifest {
  signature: CertManifestSignatureFields;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export function buildUnsignedManifest(
  input: Omit<UnsignedCertManifest, 'schemaVersion'>
): UnsignedCertManifest {
  if (!input.feature) throw new Error('feature is required');
  if (!ISO_UTC.test(input.certifiedAt)) {
    throw new Error(`certifiedAt must be ISO-8601 UTC (got "${input.certifiedAt}")`);
  }
  if (!/^[0-9a-f]{40}$/.test(input.git.commit)) {
    throw new Error('git.commit must be a 40-char hex SHA');
  }
  if (Object.keys(input.sourceHashes).length === 0) {
    throw new Error('sourceHashes cannot be empty');
  }
  for (const [k, v] of Object.entries(input.sourceHashes)) {
    if (!SHA256.test(v)) {
      throw new Error(`sourceHashes["${k}"] must be sha256:<64-hex>`);
    }
  }
  if (!SHA256.test(input.evidence.bundleSha256)) {
    throw new Error('evidence.bundleSha256 must be sha256:<64-hex>');
  }
  return { schemaVersion: 1, ...input };
}

function payloadBytes(unsigned: UnsignedCertManifest): Uint8Array {
  return new TextEncoder().encode(canonicalize(unsigned));
}

function b64encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function b64decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export async function signManifest(
  unsigned: UnsignedCertManifest,
  privateKey: Uint8Array,
  keyId: string,
  publicKey: Uint8Array
): Promise<CertManifest> {
  const msg = payloadBytes(unsigned);
  const sig = await ed.signAsync(msg, privateKey);
  return {
    ...unsigned,
    signature: {
      alg: 'ed25519',
      keyId,
      publicKey: b64encode(publicKey),
      value: b64encode(sig),
    },
  };
}

export interface KnownKey {
  keyId: string;
  publicKey: Uint8Array;
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
}

export async function verifyManifest(
  manifest: CertManifest,
  knownKeys: KnownKey[]
): Promise<VerifyResult> {
  if (manifest.signature.alg !== 'ed25519') {
    return { ok: false, error: `unsupported alg: ${manifest.signature.alg}` };
  }
  const known = knownKeys.find((k) => k.keyId === manifest.signature.keyId);
  if (!known) {
    return { ok: false, error: `unknown keyId "${manifest.signature.keyId}"` };
  }
  const embedded = b64decode(manifest.signature.publicKey);
  if (
    embedded.length !== known.publicKey.length ||
    !embedded.every((b, i) => b === known.publicKey[i])
  ) {
    return {
      ok: false,
      error: `publicKey in manifest does not match known key "${known.keyId}"`,
    };
  }
  const { signature, ...unsigned } = manifest;
  const msg = payloadBytes(unsigned);
  const sig = b64decode(signature.value);
  let valid = false;
  try {
    valid = await ed.verifyAsync(sig, msg, known.publicKey);
  } catch (e) {
    return { ok: false, error: `signature error: ${(e as Error).message}` };
  }
  if (!valid) return { ok: false, error: 'signature verification failed' };
  return { ok: true };
}
```

- [ ] **Step 4: Re-run tests, expect pass**

Run:
```bash
pnpm cert:test -- manifest
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cert/manifest.ts scripts/cert/manifest.test.ts
git commit -m "feat(cert): manifest schema with Ed25519 sign/verify"
```

---

## Task 7: Generate first signing keypair

**Files:**
- Create: `internal/release-keys/breeze-cert.2026-Q2.pub`
- Create (then delete): `internal/release-keys/breeze-cert.2026-Q2.priv`

The private key goes into 1Password; only the public key is committed.

- [ ] **Step 1: Generate the keypair**

Run from repo root:
```bash
mkdir -p internal/release-keys
pnpm tsx -e "
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { writeFileSync } from 'node:fs';
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));
const priv = ed.utils.randomPrivateKey();
ed.getPublicKeyAsync(priv).then(pub => {
  writeFileSync('internal/release-keys/breeze-cert.2026-Q2.pub', Buffer.from(pub).toString('base64') + '\n');
  writeFileSync('internal/release-keys/breeze-cert.2026-Q2.priv', Buffer.from(priv).toString('base64') + '\n', { mode: 0o600 });
  console.log('pub :', Buffer.from(pub).toString('base64'));
  console.log('priv saved to internal/release-keys/breeze-cert.2026-Q2.priv (mode 0600)');
});
"
```

Expected: prints the base64 public key. Both files appear under `internal/release-keys/`.

- [ ] **Step 2: Move the private key to 1Password**

Manual step:
1. Open 1Password → vault `Engineering`.
2. Create item `breeze-cert signing key (2026-Q2)`.
3. Paste the contents of `internal/release-keys/breeze-cert.2026-Q2.priv` into the password field.
4. Add a note pointing to `docs/backup-certification/key-management.md` and noting: "Generated 2026-05-13. Active for signing through 2026-12-31. Rotates 2027-Q1."

- [ ] **Step 3: Securely delete the local private key**

```bash
shred -u internal/release-keys/breeze-cert.2026-Q2.priv 2>/dev/null || rm -P internal/release-keys/breeze-cert.2026-Q2.priv
ls internal/release-keys/
```

Expected: only the `.pub` file remains.

- [ ] **Step 4: Verify internal/ is gitignored**

Run:
```bash
git check-ignore internal/release-keys/anything-here || echo "NOT IGNORED"
```

Expected: prints the path (meaning it IS ignored). If output is `NOT IGNORED`, abort and fix `.gitignore` before proceeding — `internal/` must be gitignored per CLAUDE.md ("No Internal Infrastructure Details in Public Code").

- [ ] **Step 5: Carve an exception for release-keys/*.pub**

Inspect the relevant `.gitignore` (root or `internal/.gitignore`). Ensure the carve-out pattern allows `*.pub` under `internal/release-keys/`:

If `internal/` is in the root `.gitignore` unconditionally, add to the root `.gitignore`:

```
# Allow signing public keys to be committed even though internal/ is otherwise ignored.
!internal/release-keys/
internal/release-keys/*
!internal/release-keys/*.pub
```

(If a different release-keys carve-out already exists from prior work, leave it; verify the `*.pub` exception covers our file.)

- [ ] **Step 6: Force-add the pub key**

```bash
git add -f internal/release-keys/breeze-cert.2026-Q2.pub
git status
```

Expected: the `.pub` file is staged. Confirm NO `.priv` file is staged or present.

- [ ] **Step 7: Commit**

```bash
git add .gitignore
git commit -m "feat(cert): publish first backup-cert signing public key (2026-Q2)"
```

---

## Task 8: Manifest verifier CLI

**Files:**
- Create: `scripts/cert/verify-cert-manifest.ts`

This CLI walks `cert-manifests/**` and verifies every manifest against the public keys in `internal/release-keys/`.

- [ ] **Step 1: Implement the CLI**

Create `scripts/cert/verify-cert-manifest.ts`:

```ts
#!/usr/bin/env tsx
import * as fs from 'node:fs';
import * as path from 'node:path';
import { globSync } from 'glob';
import { verifyManifest, type CertManifest, type KnownKey } from './manifest';

const REPO_ROOT = process.cwd();
const MANIFESTS_GLOB = 'cert-manifests/**/*.json';
const PUBKEYS_GLOB = 'internal/release-keys/breeze-cert.*.pub';

function loadKnownKeys(): KnownKey[] {
  const files = globSync(PUBKEYS_GLOB, { cwd: REPO_ROOT, absolute: true });
  if (files.length === 0) {
    console.error('No public keys found at', PUBKEYS_GLOB);
    process.exit(2);
  }
  return files.map((f) => {
    const base = path.basename(f, '.pub'); // e.g. breeze-cert.2026-Q2
    const keyId = base.replace(/^breeze-cert\./, 'breeze-cert-');
    const b64 = fs.readFileSync(f, 'utf8').trim();
    return { keyId, publicKey: new Uint8Array(Buffer.from(b64, 'base64')) };
  });
}

async function main() {
  const keys = loadKnownKeys();
  const manifestPaths = globSync(MANIFESTS_GLOB, {
    cwd: REPO_ROOT,
    absolute: true,
    nodir: true,
  }).filter((p) => !p.endsWith('/latest.json'));

  if (manifestPaths.length === 0) {
    console.log('No cert manifests to verify (yet). OK.');
    process.exit(0);
  }

  let failed = 0;
  for (const mp of manifestPaths) {
    const raw = JSON.parse(fs.readFileSync(mp, 'utf8')) as CertManifest;
    const result = await verifyManifest(raw, keys);
    const rel = path.relative(REPO_ROOT, mp);
    if (result.ok) {
      console.log(`OK   ${rel}`);
    } else {
      console.log(`FAIL ${rel}  — ${result.error}`);
      failed += 1;
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} manifest(s) failed verification.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
```

- [ ] **Step 2: Smoke-test (no manifests yet, should print OK)**

```bash
pnpm cert:verify
```

Expected: `No cert manifests to verify (yet). OK.` exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/cert/verify-cert-manifest.ts
git commit -m "feat(cert): CLI to verify all cert manifests against known keys"
```

---

## Task 9: Source-hash scanner CLI

**Files:**
- Create: `scripts/cert/scan-backup-source.ts`

Reports current source-hash state. Used by CI to detect drift between HEAD and the most recent manifest per feature. Advisory mode — always exits 0.

- [ ] **Step 1: Implement the CLI**

Create `scripts/cert/scan-backup-source.ts`:

```ts
#!/usr/bin/env tsx
import * as fs from 'node:fs';
import * as path from 'node:path';
import { globSync } from 'glob';
import { computeSourceHashes } from './sourceHashes';

interface ManifestSlim {
  feature: string;
  git: { commit: string };
  sourceHashes: Record<string, string>;
}

async function main() {
  const repoRoot = process.cwd();
  const currentHashes = await computeSourceHashes(repoRoot);

  const manifestPaths = globSync('cert-manifests/*/latest.json', {
    cwd: repoRoot,
    absolute: true,
    nodir: true,
  });

  if (manifestPaths.length === 0) {
    console.log('No latest.json pointers found — Plan 1 advisory phase, this is expected.');
    console.log(`Tracked backup-critical files at HEAD: ${Object.keys(currentHashes).length}`);
    process.exit(0);
  }

  let drift = 0;
  for (const mp of manifestPaths) {
    const m = JSON.parse(fs.readFileSync(mp, 'utf8')) as ManifestSlim;
    const stale: string[] = [];
    for (const [file, hash] of Object.entries(m.sourceHashes)) {
      if (currentHashes[file] !== hash) {
        stale.push(file);
      }
    }
    const missing = Object.keys(m.sourceHashes).filter(
      (f) => currentHashes[f] === undefined
    );
    if (stale.length === 0 && missing.length === 0) {
      console.log(`OK    ${m.feature}: unchanged since cert at ${m.git.commit.slice(0, 7)}`);
    } else {
      drift += 1;
      console.log(`DRIFT ${m.feature}: ${stale.length} changed, ${missing.length} missing`);
      stale.slice(0, 20).forEach((f) => console.log(`  ~ ${f}`));
      if (stale.length > 20) console.log(`  ... +${stale.length - 20} more`);
      missing.forEach((f) => console.log(`  - ${f} (file no longer exists)`));
    }
  }

  if (drift > 0) {
    console.log(`\n${drift} feature(s) need re-cert. (Advisory mode — not failing CI yet.)`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
```

- [ ] **Step 2: Smoke-test**

```bash
pnpm cert:scan
```

Expected: `No latest.json pointers found ... Tracked backup-critical files at HEAD: <N>`. Exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/cert/scan-backup-source.ts
git commit -m "feat(cert): scan-backup-source CLI for CI drift detection (advisory mode)"
```

---

## Task 10: cert-diff CLI

**Files:**
- Create: `scripts/cert/cert-diff.ts`

Developer ergonomics: "what does my branch change that needs re-cert?" Uses the safe git helpers from Task 2.

- [ ] **Step 1: Implement the CLI**

Create `scripts/cert/cert-diff.ts`:

```ts
#!/usr/bin/env tsx
import * as fs from 'node:fs';
import { globSync } from 'glob';
import { computeSourceHashes } from './sourceHashes';
import {
  gitMergeBaseWithMain,
  gitDiffNames,
  gitDiffNamesAgainstWorkingTree,
} from './gitHelpers';

interface ManifestSlim {
  feature: string;
  git: { commit: string };
  sourceHashes: Record<string, string>;
}

function listChangedSinceMain(): Set<string> {
  const base = gitMergeBaseWithMain();
  if (base) {
    return new Set(gitDiffNames(base));
  }
  return new Set(gitDiffNamesAgainstWorkingTree());
}

async function main() {
  const changed = listChangedSinceMain();
  const currentHashes = await computeSourceHashes(process.cwd());
  const tracked = new Set(Object.keys(currentHashes));
  const changedAndTracked = [...changed].filter((p) => tracked.has(p));

  if (changedAndTracked.length === 0) {
    console.log('No backup-critical changes on this branch. No re-cert needed.');
    return;
  }

  console.log(`This branch modifies ${changedAndTracked.length} backup-critical file(s):`);
  changedAndTracked.forEach((p) => console.log(`  ~ ${p}`));

  const manifestPaths = globSync('cert-manifests/*/latest.json', { absolute: true });
  if (manifestPaths.length === 0) {
    console.log(
      '\nNo signed manifests yet (Plan 1 advisory phase). Once Plan 2 produces manifests, this branch will trigger re-cert for each affected feature.'
    );
    return;
  }

  const affected = new Set<string>();
  for (const mp of manifestPaths) {
    const m = JSON.parse(fs.readFileSync(mp, 'utf8')) as ManifestSlim;
    for (const f of changedAndTracked) {
      if (m.sourceHashes[f] !== undefined) {
        affected.add(m.feature);
        break;
      }
    }
  }
  console.log(`\nFeatures requiring re-cert before merge:`);
  for (const f of affected) console.log(`  • ${f}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
```

- [ ] **Step 2: Smoke-test on the current branch**

```bash
pnpm cert:diff
```

Expected (Plan 1 branch creates cert tooling, not backup code): `No backup-critical changes on this branch. No re-cert needed.`

- [ ] **Step 3: Commit**

```bash
git add scripts/cert/cert-diff.ts
git commit -m "feat(cert): cert-diff CLI showing which features need re-cert"
```

---

## Task 11: Sign-manifest CLI

**Files:**
- Create: `scripts/cert/sign-cert-manifest.ts`

This is the CLI that real cert runs in Plan 2 will use. Plan 1 needs it minimally usable for the smoke test in Task 15.

- [ ] **Step 1: Implement the CLI**

Create `scripts/cert/sign-cert-manifest.ts`:

```ts
#!/usr/bin/env tsx
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { buildUnsignedManifest, signManifest } from './manifest';
import { computeSourceHashes } from './sourceHashes';
import { gitHeadCommit } from './gitHelpers';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

interface Args {
  feature: string;
  keyId: string;
  privKeyFile: string;
  pubKeyFile: string;
  bundleS3Object: string;
  bundleSha256: string;
  outDir?: string;
}

function parseArgs(): Args {
  const args: Record<string, string> = {};
  for (const s of process.argv.slice(2)) {
    const m = s.match(/^--([^=]+)=(.+)$/);
    if (!m) throw new Error(`Bad arg: ${s}`);
    args[m[1]] = m[2];
  }
  const required = [
    'feature', 'keyId', 'privKeyFile', 'pubKeyFile',
    'bundleS3Object', 'bundleSha256',
  ];
  for (const k of required) {
    if (!args[k]) throw new Error(`Missing --${k}`);
  }
  return args as unknown as Args;
}

async function main() {
  const a = parseArgs();
  const repoRoot = process.cwd();
  const commit = gitHeadCommit();
  const sourceHashes = await computeSourceHashes(repoRoot);
  const certifiedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const unsigned = buildUnsignedManifest({
    feature: a.feature,
    certifiedAt,
    git: { commit, tag: null },
    sourceHashes,
    evidence: { s3Object: a.bundleS3Object, bundleSha256: a.bundleSha256 },
  });
  const priv = new Uint8Array(
    Buffer.from(fs.readFileSync(a.privKeyFile, 'utf8').trim(), 'base64')
  );
  const pub = new Uint8Array(
    Buffer.from(fs.readFileSync(a.pubKeyFile, 'utf8').trim(), 'base64')
  );
  const signed = await signManifest(unsigned, priv, a.keyId, pub);

  const outDir = a.outDir ?? path.join('cert-manifests', a.feature);
  fs.mkdirSync(outDir, { recursive: true });
  const filename = `${certifiedAt.replace(/[:]/g, '-')}-${commit.slice(0, 7)}.json`;
  const fullPath = path.join(outDir, filename);
  fs.writeFileSync(fullPath, JSON.stringify(signed, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(signed, null, 2) + '\n');
  console.log(`Signed manifest written: ${fullPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
```

- [ ] **Step 2: Commit (no smoke test — happens in Task 15)**

```bash
git add scripts/cert/sign-cert-manifest.ts
git commit -m "feat(cert): sign-cert-manifest CLI"
```

---

## Task 12: Append-only check CLI

**Files:**
- Create: `scripts/cert/check-append-only.ts`

Walks the diff between origin/main and HEAD; rejects any modification of an existing file under `cert-manifests/` (except `latest.json`, which is intentionally mutable, and `BYPASSES.md`, which is append-only by convention).

- [ ] **Step 1: Implement the CLI**

Create `scripts/cert/check-append-only.ts`:

```ts
#!/usr/bin/env tsx
import { gitMergeBaseWithMain, gitDiffNameStatus } from './gitHelpers';

const PROTECTED_DIR = 'cert-manifests/';
const ALLOWED_MUTABLE_PATTERNS = [
  /^cert-manifests\/[^/]+\/latest\.json$/,
  /^cert-manifests\/BYPASSES\.md$/,
];

function isAllowedMutable(p: string): boolean {
  return ALLOWED_MUTABLE_PATTERNS.some((re) => re.test(p));
}

function main() {
  const base = gitMergeBaseWithMain();
  if (!base) {
    console.log('No origin/main — skipping append-only check.');
    process.exit(0);
  }
  const entries = gitDiffNameStatus(base);
  const offending: string[] = [];
  for (const { status, file } of entries) {
    if (!file.startsWith(PROTECTED_DIR)) continue;
    if (status === 'D') {
      offending.push(`deleted: ${file}`);
      continue;
    }
    // status M, or R<score> for rename, or T for type change — all are modifications
    if (status === 'M' || status.startsWith('R') || status === 'T') {
      if (!isAllowedMutable(file)) {
        offending.push(`modified: ${file}`);
      }
    }
  }
  if (offending.length === 0) {
    console.log('OK: cert-manifests/ is append-only on this branch.');
    process.exit(0);
  }
  console.error('FAIL: cert-manifests/ must be append-only. Offending changes:');
  for (const f of offending) console.error(`  - ${f}`);
  console.error('\nFix forward: create a new manifest file instead of editing.');
  process.exit(1);
}

main();
```

- [ ] **Step 2: Smoke-test**

```bash
pnpm cert:append-only-check
```

Expected: `OK: cert-manifests/ is append-only on this branch.` (or the "no origin/main" message if running locally without an origin/main reference).

- [ ] **Step 3: Commit**

```bash
git add scripts/cert/check-append-only.ts
git commit -m "feat(cert): enforce append-only on cert-manifests/ via CI check"
```

---

## Task 13: CI workflow — advisory mode

**Files:**
- Create: `.github/workflows/backup-cert-check.yml`

Three jobs: source-scan (advisory), manifest-verify (strict — any bad signature fails), append-only (strict).

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/backup-cert-check.yml`:

```yaml
name: backup-cert-check

on:
  pull_request:
  push:
    branches: [main]

jobs:
  source-scan:
    name: Source-hash scan (advisory)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - name: Run scan-backup-source
        run: |
          pnpm cert:scan | tee scan-output.txt
      - name: Comment on PR with drift summary
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const text = fs.readFileSync('scan-output.txt','utf8');
            if (!text.includes('DRIFT')) return;
            const body = [
              '### Backup cert source-hash scan',
              '',
              '> _Advisory — not blocking yet._',
              '',
              '```',
              text.trim(),
              '```',
              '',
              'Run `pnpm cert:diff` locally to see which features need re-cert.',
            ].join('\n');
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body,
            });

  manifest-verify:
    name: Verify cert manifest signatures
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm cert:verify

  append-only:
    name: Enforce cert-manifests/ append-only
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm cert:append-only-check
```

- [ ] **Step 2: Validate locally if you have actionlint**

```bash
command -v actionlint && actionlint .github/workflows/backup-cert-check.yml || echo "actionlint not installed, skipping"
```

Expected: no errors, or "skipping".

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/backup-cert-check.yml
git commit -m "ci(cert): backup-cert-check workflow in advisory mode"
```

---

## Task 14: CODEOWNERS and BYPASSES template

**Files:**
- Create: `.github/CODEOWNERS`
- Create: `cert-manifests/BYPASSES.md`

- [ ] **Step 1: Create CODEOWNERS**

Create `.github/CODEOWNERS`:

```
# CODEOWNERS for Breeze RMM
# Declares review ownership. Append-only directories like
# cert-manifests/ require explicit review for any change.

# Backup certification
/cert-manifests/                                        @cthtodd
/internal/release-keys/                                 @cthtodd
/docs/backup-certification/                             @cthtodd
/scripts/cert/                                          @cthtodd
/.github/workflows/backup-cert-check.yml                @cthtodd
```

(If `@cthtodd` is not the correct GitHub handle for Todd Hebebrand, update before committing — check via `gh api user` or by looking at a recent PR.)

- [ ] **Step 2: Create BYPASSES template**

Create `cert-manifests/BYPASSES.md`:

```markdown
# Backup Certification — Bypass Log

This file is **append-only**. Each entry documents a release that shipped
without a valid Cert Manifest for some feature, using the
`--cert-bypass` flag.

Each entry must include:
- Date (UTC ISO-8601)
- Release tag or commit
- Feature(s) skipped
- Reason (engineering justification)
- Approver 1 (the requesting engineer)
- Approver 2 (a second person, never the same as Approver 1)
- Planned re-cert date

Format:

    ## YYYY-MM-DDTHH:MM:SSZ — <release>

    **Features bypassed:** feature-slug-1, feature-slug-2

    **Reason:** <one paragraph>

    **Approver 1:** @handle
    **Approver 2:** @handle
    **Planned re-cert by:** YYYY-MM-DD

    ---

See `docs/backup-certification/bypass-policy.md` for when bypasses are
acceptable and how to record one.

---

<!-- entries begin below this line; do not edit entries above. -->
```

- [ ] **Step 3: Commit**

```bash
git add .github/CODEOWNERS cert-manifests/BYPASSES.md
git commit -m "feat(cert): CODEOWNERS + BYPASSES log template"
```

---

## Task 15: End-to-end smoke test — sign a fixture manifest

Proves the toolchain works without depending on Plan 2 lab infrastructure.

- [ ] **Step 1: Temporarily restore the private key**

Manually:
1. Open 1Password → `breeze-cert signing key (2026-Q2)`.
2. Copy the base64 private key into a local file `/tmp/breeze-cert.priv` (do NOT commit, do NOT place in repo).
3. Set permissions:
   ```bash
   chmod 600 /tmp/breeze-cert.priv
   wc -c /tmp/breeze-cert.priv
   ```
   Expected: ~45 bytes.

- [ ] **Step 2: Sign a fixture manifest**

```bash
pnpm cert:sign \
  --feature=_fixture-smoke \
  --keyId=breeze-cert-2026-Q2 \
  --privKeyFile=/tmp/breeze-cert.priv \
  --pubKeyFile=internal/release-keys/breeze-cert.2026-Q2.pub \
  --bundleS3Object=s3://placeholder/fixture.tar.zst \
  --bundleSha256=sha256:0000000000000000000000000000000000000000000000000000000000000000
```

Expected: `Signed manifest written: cert-manifests/_fixture-smoke/<filename>.json`. A `latest.json` pointer is also created.

- [ ] **Step 3: Verify the fixture**

```bash
pnpm cert:verify
```

Expected: `OK   cert-manifests/_fixture-smoke/...json`. Exit 0.

- [ ] **Step 4: Tamper and re-verify, expect failure**

```bash
pnpm tsx -e "
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = 'cert-manifests/_fixture-smoke';
const file = readdirSync(dir).find(f => f !== 'latest.json' && f.endsWith('.json'));
const full = join(dir, file);
const m = JSON.parse(readFileSync(full, 'utf8'));
const k = Object.keys(m.sourceHashes)[0];
m.sourceHashes[k] = 'sha256:' + 'f'.repeat(64);
writeFileSync(full, JSON.stringify(m, null, 2) + '\n');
console.log('Tampered:', full);
"
pnpm cert:verify
```

Expected: exit code 1, message like `FAIL cert-manifests/_fixture-smoke/...json — signature verification failed`.

- [ ] **Step 5: Clean up the fixture**

```bash
rm -rf cert-manifests/_fixture-smoke
shred -u /tmp/breeze-cert.priv 2>/dev/null || rm -P /tmp/breeze-cert.priv
ls cert-manifests/
```

Expected: `_fixture-smoke/` gone, `/tmp/breeze-cert.priv` gone. `cert-manifests/` shows only `BACKUP_CRITICAL_PATHS.yaml`, `BYPASSES.md`, `README.md`.

- [ ] **Step 6: Confirm working tree is clean**

```bash
pnpm cert:verify
git status
```

Expected: `No cert manifests to verify (yet). OK.` Working tree clean — no commit needed for the smoke test.

---

## Task 16: Skeleton documentation

**Files:**
- Create: `docs/backup-certification/README.md`
- Create: `docs/backup-certification/key-management.md`
- Create: `docs/backup-certification/bypass-policy.md`

Skeletons populated with what we know now. Plan 3 adds runbook, architecture, incident playbook, templates.

- [ ] **Step 1: Create README**

Create `docs/backup-certification/README.md`:

```markdown
# Backup Certification System

Internal system that proves Breeze RMM backup features actually work,
by signing source-hashed evidence of byte-exact restore tests.

## What it certifies

For each backup feature (file-level, Hyper-V, MSSQL, C2C, BMR, etc.), a
**Cert Manifest** is a signed JSON document attesting that the named
feature passed every assertion in a real test run on the day it was
signed, against a specific set of backup-critical source files.

## What invalidates a certification

A Cert Manifest is valid iff every hash in its `sourceHashes` field
matches the current tree at the listed path. Modify any backup-critical
file → manifest invalidates → release must wait for re-cert (or use a
documented bypass).

## How it's structured

- **Design spec:** `docs/superpowers/specs/2026-05-13-backup-certification-design.md`
- **Scope of backup-critical code:** `cert-manifests/BACKUP_CRITICAL_PATHS.yaml`
- **Signed manifests:** `cert-manifests/<feature>/<utc>-<sha>.json` (append-only)
- **Public signing keys:** `internal/release-keys/breeze-cert.*.pub`
- **Bypass log:** `cert-manifests/BYPASSES.md`
- **CI gate:** `.github/workflows/backup-cert-check.yml`

## Phases

- **Plan 1 (deployed):** advisory CI gate, signing toolkit, no real cert
  runs yet.
- **Plan 2 (planned):** lab adapters (Proxmox, WinRM, SMB), action verbs,
  first real cert run for file-level Windows S3 + Vault.
- **Plan 3 (planned):** flip CI gate from advisory to required, release
  workflow integration, meta-test, full documentation set.

## Subdocs

- `key-management.md` — signing key lifecycle.
- `bypass-policy.md` — when bypasses are acceptable and how to log one.
- (`runbook.md`, `architecture.md`, `incident-playbook.md`, `templates.md`
  arrive with Plan 3.)
```

- [ ] **Step 2: Create key-management.md**

Create `docs/backup-certification/key-management.md`:

```markdown
# Backup-Cert Signing Key Management

## Active key

- **Key ID:** `breeze-cert-2026-Q2`
- **Algorithm:** Ed25519
- **Public key path (committed):** `internal/release-keys/breeze-cert.2026-Q2.pub`
- **Private key location:** 1Password, vault **Engineering**, item
  **breeze-cert signing key (2026-Q2)**.
- **Generated:** 2026-05-13
- **Signing eligibility ends:** 2026-12-31 (rotates 2027-Q1)
- **Verification eligibility:** indefinite — old keys remain valid for
  verifying historical manifests forever.

## Rotation procedure

1. Generate a new keypair locally (see Task 7 of Plan 1 for the exact
   command).
2. Save the new private key to 1Password as `breeze-cert signing key
   (<YYYY>-<Q>)`.
3. Commit the new public key as
   `internal/release-keys/breeze-cert.<YYYY>-<Q>.pub` and remove the
   local private file via `shred -u`.
4. Update this document's "Active key" section. The previous key stays
   in `internal/release-keys/` — never delete a public key.
5. From the rotation date onward, sign new manifests with the new key.
   Old manifests remain valid.

## Compromise procedure

If the active private key is suspected compromised:
1. Immediately rotate (above).
2. Open `cert-manifests/REVOCATIONS.md` (create if missing) and list the
   compromised `keyId` with the compromise date.
3. Update `scripts/cert/verify-cert-manifest.ts` to reject manifests
   signed by a revoked key whose `certifiedAt` is **after** the
   compromise date.
4. Trigger re-cert runs for any feature whose latest manifest was signed
   with the compromised key after the compromise date.

## CI access

Automated cert runs (Plan 2+) will need the private key in CI's secret
store. When that lands:
- Use a dedicated GitHub Actions secret `BREEZE_CERT_PRIVKEY_2026_Q2`.
- Rotate the secret immediately when rotating the key.
- Never check the private key into the repo, not even in private
  branches.
```

- [ ] **Step 3: Create bypass-policy.md**

Create `docs/backup-certification/bypass-policy.md`:

```markdown
# Backup-Cert Bypass Policy

A `--cert-bypass` release ships without a valid Cert Manifest for one
or more features. It is the last-resort path.

## When a bypass is acceptable

- **Production-critical hotfix.** A bug in non-backup code is causing
  data loss or service outage, the fix is small, and waiting for a cert
  run is unacceptable.
- **Cert lab outage.** The cert infrastructure itself is down and the
  release contains no backup-critical changes but cannot be re-certified.
- **Bug in the cert system.** A manifest fails verification because the
  cert tooling has a bug. Fix forward, log bypass, re-cert when fixed.

## When a bypass is NOT acceptable

- "We're running late."
- "The cert was almost done but timed out."
- "The change is small, what could go wrong?"
- "Backup is unchanged, but we modified config policy code listed in
  `BACKUP_CRITICAL_PATHS`." → Either run the cert, or amend the paths
  file to exclude config-policy code if it genuinely doesn't affect
  backup correctness (separate PR, requires design evolution).

## Procedure

1. The engineer requesting the bypass opens a PR adding an entry to the
   bottom of `cert-manifests/BYPASSES.md`. Never edit existing entries.
2. Entry must include:
   - UTC timestamp
   - Release tag or commit
   - Features bypassed
   - Reason (one paragraph, specific)
   - Approver 1: the requesting engineer's handle
   - Approver 2: a second engineer's handle (must differ from Approver 1)
   - Planned re-cert date (a real calendar date, not "soon")
3. The PR requires approval from Approver 2 plus a code-owner reviewer.
4. After merge, the release workflow accepts the bypass tied to that
   PR's commit and proceeds with the release.
5. Bypass debt is tracked: if the planned re-cert date passes without a
   fresh manifest, CI flags it.

## What a bypass does NOT do

- It does not create a valid Cert Manifest.
  `cert-manifests/<feature>/latest.json` is unchanged.
- It does not retroactively certify anything. It logs a known unknown —
  explicit, visible, auditable.
```

- [ ] **Step 4: Commit**

```bash
git add docs/backup-certification/
git commit -m "docs(cert): plan 1 skeleton docs (README, key-mgmt, bypass policy)"
```

---

## Task 17: End-to-end verification pass and PR

Final sanity check, push, open PR, watch CI.

- [ ] **Step 1: Run unit tests**

```bash
pnpm cert:test
```

Expected: all tests pass (canonicalJson 9, sourceHashes 6, manifest 6 = 21 total).

- [ ] **Step 2: Run all cert CLIs**

```bash
pnpm cert:scan
pnpm cert:verify
pnpm cert:diff
pnpm cert:append-only-check
```

Expected: each exits 0 with sensible output.

- [ ] **Step 3: Confirm file inventory**

```bash
ls cert-manifests/
ls scripts/cert/
ls internal/release-keys/
ls docs/backup-certification/
ls .github/workflows/backup-cert-check.yml
ls .github/CODEOWNERS
```

Expected: every file from the File Structure section exists; no `.priv` file present.

- [ ] **Step 4: Push the branch and open PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(cert): backup certification — Plan 1 foundation" --body "$(cat <<'EOF'
## Summary

Implements Plan 1 of the Backup Certification System:
- Source-hash scanner over `cert-manifests/BACKUP_CRITICAL_PATHS.yaml`.
- Ed25519 manifest sign/verify toolkit.
- Append-only enforcement on `cert-manifests/`.
- Advisory CI gate (`backup-cert-check` workflow).
- Skeleton documentation under `docs/backup-certification/`.

No lab infrastructure yet (Plan 2). No real cert runs yet (Plan 2). The
CI gate is advisory — it reports drift but does not fail PRs (Plan 3
flips it to required).

Spec: `docs/superpowers/specs/2026-05-13-backup-certification-design.md`
Plan: `docs/superpowers/plans/2026-05-13-backup-cert-plan-1-foundation.md`

## Test plan

- [ ] CI: backup-cert-check workflow passes (manifest-verify with no
      manifests, source-scan in advisory mode, append-only check shows OK).
- [ ] Local: `pnpm cert:test` — 21 unit tests pass.
- [ ] Local: smoke test (Task 15) — sign fixture, verify, tamper,
      re-verify fails, clean up.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR created. CI runs `backup-cert-check.yml`. In the GitHub UI:
- `source-scan` prints `Tracked backup-critical files at HEAD: <N>` and posts no DRIFT comment.
- `manifest-verify` prints `No cert manifests to verify (yet). OK.`
- `append-only` prints `OK: cert-manifests/ is append-only on this branch.`

- [ ] **Step 5: Address review and merge**

After review, squash-merge per `CLAUDE.md`:
```bash
gh pr merge --squash --admin
```

Plan 1 is complete.

---

## Self-review

**Spec coverage (Plan 1 subset):**
- §3 Contract → enforced by Task 9 (scan-backup-source) + Task 13 (advisory CI).
- §6.2 Cert Manifest schema → Task 6 (manifest.ts).
- §6.3 Key management → Task 7 (generation) + Task 16 (docs).
- §6.4 Append-only → Task 12 (check-append-only) + Task 14 (CODEOWNERS) + Task 13 (CI).
- §7 BACKUP_CRITICAL_PATHS.yaml → Task 4.
- §14.1 source-scan → Task 9 + Task 13.
- §14.2 manifest-verify → Task 8 + Task 13.
- §14.3 backup-cert-gate aggregator → deferred to Plan 3 (intentional; this plan is advisory only).
- §14.5 local dev ergonomics → Task 10 (`cert:diff`).

**Placeholder scan:** searched body for TBD/TODO/FIXME — none in plan instructions. The `BYPASSES.md` template intentionally contains placeholder field labels (`YYYY-MM-DD`, `<handle>`) for future entries.

**Type consistency:** `signManifest` / `verifyManifest` signatures match between `manifest.ts` and `manifest.test.ts`. `CertManifest` / `UnsignedCertManifest` / `KnownKey` types are consistent across all CLI consumers. Git helpers in `gitHelpers.ts` are used uniformly across `cert-diff.ts` and `check-append-only.ts`.

**Security note:** All child-process invocations use `execFileSync('git', [...])` from `gitHelpers.ts` — never `exec` or `execSync` with a single command string. No shell metacharacter interpolation anywhere.

**Out-of-scope items explicitly listed** at the top so Plan 2 and Plan 3 have a clear seam to pick up from.
