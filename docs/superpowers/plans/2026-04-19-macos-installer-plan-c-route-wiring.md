# macOS Installer App — Plan C: Route Wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the macOS branch of `GET /enrollment-keys/:id/installer/macos` to issue a bootstrap token (Plan A) and return a renamed `Breeze Installer.app.zip` (built by Plan B's CI). Old `install.sh`-based zip remains accessible behind a `?legacy=1` query param for one release cycle as a rollback escape hatch.

**Architecture:** Extract the bootstrap-token issuance logic from Plan A's `POST /:id/bootstrap-token` route into a shared service helper (`issueBootstrapTokenForKey`) so both the standalone route and the installer-download path call the same code. Add a fetcher for the new `Breeze Installer.app.zip` GitHub release asset. Add a zip-rename helper that walks the entries of the installer-app zip and rewrites the `.app` directory name to embed the token + API host. Modify the installer route to use these new pieces.

**Tech Stack:** Hono, Drizzle, `node-stream-zip` (read) + `archiver` (write), Vitest. No new infra.

**Requires:** Plan A merged (bootstrap endpoint + token issuance). Plan B merged (`Breeze Installer.app.zip` published as a release asset). If Plan B's first release hasn't shipped yet, the installer route will gracefully fall back to the legacy zip via the env-var gate documented in Task 4.

---

## File Structure

**Create:**
- `apps/api/src/services/installerAppZip.ts` — `renameAppInZip` helper
- `apps/api/src/services/installerAppZip.test.ts` — unit tests for rename helper
- `apps/api/src/services/installerBootstrapTokenIssuance.ts` — extracted issuance helper

**Modify:**
- `apps/api/src/services/binarySource.ts` — add `getGithubInstallerAppUrl()`
- `apps/api/src/services/installerBuilder.ts` — add `fetchMacosInstallerAppZip()` + `probeMacosInstallerApp()`
- `apps/api/src/routes/enrollmentKeys.ts` — modify `GET /:id/installer/macos` branch; refactor `POST /:id/bootstrap-token` to call shared issuance helper
- `apps/api/src/routes/enrollmentKeys.test.ts` — update existing macOS installer tests

**Verify (no edits expected):**
- `apps/api/src/routes/installer.test.ts` (Plan A) — should still pass.

---

## Task 1: Extract bootstrap-token issuance into a shared helper

**Files:**
- Create: `apps/api/src/services/installerBootstrapTokenIssuance.ts`
- Modify: `apps/api/src/routes/enrollmentKeys.ts` — `POST /:id/bootstrap-token` route now calls the helper

- [ ] **Step 1: Create the helper**

```ts
// apps/api/src/services/installerBootstrapTokenIssuance.ts
import { db } from '../db';
import { eq } from 'drizzle-orm';
import { enrollmentKeys, installerBootstrapTokens } from '../db/schema/installerBootstrapTokens';
// NB: enrollmentKeys is exported from db/schema/orgs.ts; adjust import to wherever
// installerBootstrapTokens lives (Plan A added apps/api/src/db/schema/installerBootstrapTokens.ts).
import {
  generateBootstrapToken,
  bootstrapTokenExpiresAt,
} from './installerBootstrapToken';

export interface IssueBootstrapTokenInput {
  parentEnrollmentKeyId: string;
  createdByUserId: string;
  maxUsage?: number;
}

export interface IssuedBootstrapToken {
  token: string;
  expiresAt: Date;
  parentKeyName: string;
}

export class BootstrapTokenIssuanceError extends Error {
  constructor(public code: 'parent_not_found' | 'parent_expired' | 'parent_exhausted', message: string) {
    super(message);
    this.name = 'BootstrapTokenIssuanceError';
  }
}

/**
 * Issues a single-use bootstrap token tied to an existing parent enrollment
 * key. Used by both the standalone POST /enrollment-keys/:id/bootstrap-token
 * route AND the macOS installer download route — they were two duplicate
 * code paths in Plan A; this helper unifies them.
 *
 * Caller is responsible for:
 *  - access control (ensureOrgAccess on parentKey.orgId)
 *  - audit logging
 *
 * Throws BootstrapTokenIssuanceError on parent-key validation failures so
 * the caller can map to its own HTTP shape.
 */
export async function issueBootstrapTokenForKey(
  input: IssueBootstrapTokenInput,
): Promise<IssuedBootstrapToken> {
  const [parent] = await db
    .select()
    .from(enrollmentKeys)
    .where(eq(enrollmentKeys.id, input.parentEnrollmentKeyId))
    .limit(1);
  if (!parent) {
    throw new BootstrapTokenIssuanceError('parent_not_found', 'Enrollment key not found');
  }
  if (parent.expiresAt && new Date(parent.expiresAt) < new Date()) {
    throw new BootstrapTokenIssuanceError('parent_expired', 'Enrollment key has expired');
  }
  if (parent.maxUsage !== null && parent.usageCount >= parent.maxUsage) {
    throw new BootstrapTokenIssuanceError('parent_exhausted', 'Enrollment key usage exhausted');
  }

  const token = generateBootstrapToken();
  const expiresAt = bootstrapTokenExpiresAt();

  await db.insert(installerBootstrapTokens).values({
    token,
    orgId: parent.orgId,
    parentEnrollmentKeyId: parent.id,
    siteId: parent.siteId,
    maxUsage: input.maxUsage ?? 1,
    createdBy: input.createdByUserId,
    expiresAt,
  });

  return { token, expiresAt, parentKeyName: parent.name };
}
```

- [ ] **Step 2: Refactor the existing `POST /:id/bootstrap-token` route to use the helper**

In `apps/api/src/routes/enrollmentKeys.ts`, replace the inline body of the `/:id/bootstrap-token` POST handler (added in Plan A Task 7) with:

```ts
import {
  issueBootstrapTokenForKey,
  BootstrapTokenIssuanceError,
} from '../services/installerBootstrapTokenIssuance';

// ... inside the handler body, AFTER ensureOrgAccess check:
try {
  const { token, expiresAt } = await issueBootstrapTokenForKey({
    parentEnrollmentKeyId: parent.id,
    createdByUserId: auth.user.id,
    maxUsage,
  });

  writeEnrollmentKeyAudit(c, auth, {
    orgId: parent.orgId,
    action: 'enrollment_key.bootstrap_token_issued',
    keyId: parent.id,
    keyName: parent.name,
    details: { maxUsage },
  });

  return c.json({ token, expiresAt: expiresAt.toISOString(), maxUsage });
} catch (err) {
  if (err instanceof BootstrapTokenIssuanceError) {
    if (err.code === 'parent_not_found') return c.json({ error: err.message }, 404);
    return c.json({ error: err.message }, 410);
  }
  throw err;
}
```

The `db.select` for the parent key + the `ensureOrgAccess` call before this block stay as they were — those are auth-side concerns the helper deliberately doesn't own.

- [ ] **Step 3: Run existing route tests**

```bash
cd apps/api && npx vitest run src/routes/enrollmentKeys.test.ts -t "bootstrap-token"
```
Expected: Plan A's 4 tests still pass — the helper extraction is behaviour-preserving.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/installerBootstrapTokenIssuance.ts apps/api/src/routes/enrollmentKeys.ts
git commit -m "refactor(api): extract bootstrap-token issuance to shared helper"
```

---

## Task 2: GitHub release URL for the installer app

**Files:**
- Modify: `apps/api/src/services/binarySource.ts`

- [ ] **Step 1: Add the URL helper**

Append to `apps/api/src/services/binarySource.ts`:

```ts
/**
 * URL of the notarized Breeze Installer.app.zip for the current release.
 * Asset is uploaded by the build-macos-installer-app job in release.yml.
 */
export function getGithubInstallerAppUrl(): string {
  return `${githubDownloadBase()}/Breeze%20Installer.app.zip`;
}
```

- [ ] **Step 2: Type-check**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep -i installerApp
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/binarySource.ts
git commit -m "feat(api): URL helper for installer app GitHub asset"
```

---

## Task 3: Zip-rename helper (TDD)

**Files:**
- Create: `apps/api/src/services/installerAppZip.ts`
- Create: `apps/api/src/services/installerAppZip.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/api/src/services/installerAppZip.test.ts
import { describe, it, expect } from 'vitest';
import archiver from 'archiver';
import StreamZip from 'node-stream-zip';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renameAppInZip } from './installerAppZip';

/** Build a fixture zip containing a fake `.app` directory. */
async function buildFixtureZip(appName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 0 } });
    const chunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    archive.append('fake-binary', { name: `${appName}/Contents/MacOS/BreezeInstaller`, mode: 0o755 });
    archive.append('<plist/>', { name: `${appName}/Contents/Info.plist` });
    archive.append('codesign-data', { name: `${appName}/Contents/_CodeSignature/CodeResources` });
    archive.append('pkg-bytes', { name: `${appName}/Contents/Resources/breeze-agent-amd64.pkg` });
    archive.append('pkg-bytes', { name: `${appName}/Contents/Resources/breeze-agent-arm64.pkg` });
    archive.finalize().catch(reject);
  });
}

async function listEntries(zipBuf: Buffer): Promise<string[]> {
  const tmp = join(tmpdir(), `installer-zip-test-${Date.now()}.zip`);
  await writeFile(tmp, zipBuf);
  try {
    const z = new StreamZip.async({ file: tmp });
    const entries = Object.keys(await z.entries());
    await z.close();
    return entries.sort();
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

describe('renameAppInZip', () => {
  it('renames the app directory in every entry path', async () => {
    const input = await buildFixtureZip('Breeze Installer.app');
    const out = await renameAppInZip(input, {
      oldAppName: 'Breeze Installer.app',
      newAppName: 'Breeze Installer [A7K2XQ@us.2breeze.app].app',
    });
    const entries = await listEntries(out);
    expect(entries).toEqual([
      'Breeze Installer [A7K2XQ@us.2breeze.app].app/Contents/Info.plist',
      'Breeze Installer [A7K2XQ@us.2breeze.app].app/Contents/MacOS/BreezeInstaller',
      'Breeze Installer [A7K2XQ@us.2breeze.app].app/Contents/Resources/breeze-agent-amd64.pkg',
      'Breeze Installer [A7K2XQ@us.2breeze.app].app/Contents/Resources/breeze-agent-arm64.pkg',
      'Breeze Installer [A7K2XQ@us.2breeze.app].app/Contents/_CodeSignature/CodeResources',
    ]);
  });

  it('preserves entry contents byte-for-byte', async () => {
    const input = await buildFixtureZip('Breeze Installer.app');
    const out = await renameAppInZip(input, {
      oldAppName: 'Breeze Installer.app',
      newAppName: 'Breeze Installer [BBBBBB@host.local].app',
    });
    const tmp = join(tmpdir(), `installer-zip-content-${Date.now()}.zip`);
    await writeFile(tmp, out);
    const z = new StreamZip.async({ file: tmp });
    const data = await z.entryData('Breeze Installer [BBBBBB@host.local].app/Contents/Info.plist');
    await z.close();
    await unlink(tmp);
    expect(data.toString()).toBe('<plist/>');
  });

  it('throws if no entry matches the old app name', async () => {
    const input = await buildFixtureZip('Different.app');
    await expect(
      renameAppInZip(input, {
        oldAppName: 'Breeze Installer.app',
        newAppName: 'Breeze Installer [A7K2XQ@x.example].app',
      }),
    ).rejects.toThrow(/no entries matched/i);
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd apps/api && npx vitest run src/services/installerAppZip.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/installerAppZip.ts
import archiver from 'archiver';
import StreamZip from 'node-stream-zip';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface RenameAppInZipOpts {
  oldAppName: string;  // e.g. "Breeze Installer.app"
  newAppName: string;  // e.g. "Breeze Installer [A7K2XQ@us.2breeze.app].app"
}

/**
 * Walks every entry in `sourceZip` and rewrites its path so that the
 * leading `oldAppName` directory becomes `newAppName`. Entry contents
 * are preserved byte-for-byte — this is just a metadata rewrite.
 *
 * The Mac code signature lives inside `Contents/_CodeSignature/` and
 * is hashed from `Contents/` contents, NOT the bundle's own directory
 * name. Renaming the top-level folder leaves both `codesign --verify`
 * and `xcrun stapler validate` passing.
 *
 * Throws if no entry begins with `oldAppName/` — guards against feeding
 * in the wrong fixture (e.g. a release where the build output renamed
 * its top-level directory).
 */
export async function renameAppInZip(
  sourceZip: Buffer,
  opts: RenameAppInZipOpts,
): Promise<Buffer> {
  const workDir = await mkdtemp(join(tmpdir(), 'installer-app-zip-'));
  const inputPath = join(workDir, 'in.zip');
  await writeFile(inputPath, sourceZip);
  try {
    const reader = new StreamZip.async({ file: inputPath });
    const entries = await reader.entries();
    let matched = 0;

    const out = archiver('zip', { zlib: { level: 0 } }); // store-only; .app contents already small or pre-compressed
    const chunks: Buffer[] = [];
    out.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve, reject) => {
      out.on('end', () => resolve());
      out.on('error', reject);
    });

    for (const entry of Object.values(entries)) {
      const oldPrefix = `${opts.oldAppName}/`;
      let newPath = entry.name;
      if (entry.name === opts.oldAppName) {
        newPath = opts.newAppName;
        matched++;
      } else if (entry.name.startsWith(oldPrefix)) {
        newPath = opts.newAppName + entry.name.slice(opts.oldAppName.length);
        matched++;
      }
      if (entry.isDirectory) {
        out.append('', { name: newPath, mode: entry.attr });
      } else {
        const data = await reader.entryData(entry.name);
        out.append(data, { name: newPath, mode: entry.attr });
      }
    }
    await reader.close();

    if (matched === 0) {
      throw new Error(
        `installerAppZip: no entries matched old app name "${opts.oldAppName}" — wrong fixture?`,
      );
    }

    await out.finalize();
    await done;
    return Buffer.concat(chunks);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run, verify pass**

```bash
cd apps/api && npx vitest run src/services/installerAppZip.test.ts
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/installerAppZip.ts apps/api/src/services/installerAppZip.test.ts
git commit -m "feat(api): zip-rename helper for installer app"
```

---

## Task 4: Installer-app fetcher with feature gate

**Files:**
- Modify: `apps/api/src/services/installerBuilder.ts`

- [ ] **Step 1: Add fetcher + probe**

Append to `apps/api/src/services/installerBuilder.ts`:

```ts
import { getGithubInstallerAppUrl } from './binarySource';

/**
 * Fetches the notarized Breeze Installer.app.zip from the GitHub release.
 * Returns null if the asset is not available (e.g. first release after
 * Plan B merged but before the next tag is cut). Caller falls back to
 * the legacy install.sh zip in that case.
 */
export async function fetchMacosInstallerAppZip(): Promise<Buffer | null> {
  if (getBinarySource() === 'github') {
    const url = getGithubInstallerAppUrl();
    const resp = await fetch(url, { redirect: 'follow' });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Failed to fetch installer app zip: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const path = join(binaryDir, 'Breeze Installer.app.zip');
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * HEAD probe for the installer app asset. Mirrors probeMacosPkg.
 * Returns true if reachable, false if 404, throws otherwise.
 */
export async function probeMacosInstallerApp(): Promise<boolean> {
  if (getBinarySource() === 'github') {
    const url = getGithubInstallerAppUrl();
    try {
      const resp = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.status === 404) return false;
      return resp.ok;
    } catch {
      return false;
    }
  }
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  try {
    await stat(join(binaryDir, 'Breeze Installer.app.zip'));
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Type-check**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep -i installerApp
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/installerBuilder.ts
git commit -m "feat(api): fetch + probe installer app zip"
```

---

## Task 5: Wire the installer route to use the new app

**Files:**
- Modify: `apps/api/src/routes/enrollmentKeys.ts` — `GET /:id/installer/macos` branch

- [ ] **Step 1: Update the macOS branch**

Find the `if (platform === 'macos')` block in the installer download handler (around line 666 of `enrollmentKeys.ts`). Replace it with the new flow that prefers the installer-app path and falls back to the legacy zip on `?legacy=1` or when the asset is missing.

```ts
import {
  fetchMacosInstallerAppZip,
  buildMacosInstallerZip,
  fetchMacosPkgs,
} from '../services/installerBuilder';
import { renameAppInZip } from '../services/installerAppZip';
import {
  issueBootstrapTokenForKey,
  BootstrapTokenIssuanceError,
} from '../services/installerBootstrapTokenIssuance';

// Inside the existing handler, replacing the macOS branch.
// `parentKey`, `auth`, `globalSecret`, `serverUrl`, `childMaxUsage` are already in scope.

if (platform === 'macos') {
  const wantLegacy = c.req.query('legacy') === '1';

  // Lazy: try the new app-bundle path unless the caller forced legacy.
  const appZip = wantLegacy ? null : await fetchMacosInstallerAppZip();

  if (appZip) {
    // New path — bootstrap token + renamed app zip. No child enrollment key
    // is created here; the bootstrap endpoint creates it lazily on consume.
    let issued;
    try {
      issued = await issueBootstrapTokenForKey({
        parentEnrollmentKeyId: parentKey.id,
        createdByUserId: auth.user.id,
        maxUsage: childMaxUsage,
      });
    } catch (err) {
      if (err instanceof BootstrapTokenIssuanceError) {
        if (err.code === 'parent_not_found') return c.json({ error: err.message }, 404);
        return c.json({ error: err.message }, 410);
      }
      throw err;
    }

    const apiHost = new URL(serverUrl).host;
    const newAppName = `Breeze Installer [${issued.token}@${apiHost}].app`;
    const renamedZip = await renameAppInZip(appZip, {
      oldAppName: 'Breeze Installer.app',
      newAppName,
    });

    writeEnrollmentKeyAudit(c, auth, {
      orgId: parentKey.orgId,
      action: 'enrollment_key.installer_download',
      keyId: parentKey.id,
      keyName: parentKey.name,
      details: { platform, mode: 'app-bundle', token: issued.token, count: childMaxUsage },
    });

    c.header('Content-Type', 'application/zip');
    c.header('Content-Disposition', `attachment; filename="${newAppName}.zip"`);
    c.header('Content-Length', String(renamedZip.length));
    c.header('Cache-Control', 'no-store');
    return c.body(renamedZip as unknown as ArrayBuffer);
  }

  // Legacy path — fall back to the install.sh zip when:
  //  (a) caller explicitly passed ?legacy=1, OR
  //  (b) the installer-app asset is not yet on the GitHub release for this version.
  // The existing legacy block creates the child key inline (Plan A's lazy-creation
  // path doesn't apply here because there's no token to lazily resolve later).
  const macosPkgs = await fetchMacosPkgs();

  // Re-create the child enrollment key inline (the original Plan A code lives here).
  // ... existing block unchanged: rawChildKey + childKey insert + buildMacosInstallerZip + audit + response.
}
```

(The legacy block stays identical to today's implementation. Plan C only adds the new branch above it; nothing in the existing code needs to be deleted in this plan. Removal of the legacy fallback is a Plan C followup once the new path has shipped successfully for one release.)

- [ ] **Step 2: Update existing macOS installer test**

In `apps/api/src/routes/enrollmentKeys.test.ts`, the existing test for `GET /:id/installer/macos` will continue to pass IF the test mocks `fetchMacosInstallerAppZip` to return `null` (the legacy path). Add a new test case for the app-bundle path:

```ts
describe('GET /:id/installer/macos with installer app', () => {
  it('returns a renamed app zip when installer app is available', async () => {
    // Mock fetchMacosInstallerAppZip to return a valid fixture zip
    vi.mocked(fetchMacosInstallerAppZip).mockResolvedValue(
      await buildFixtureAppZip('Breeze Installer.app'),  // helper from installerAppZip.test.ts
    );
    // ... mock parent key lookup, ensureOrgAccess, etc. (existing pattern)

    const res = await app.request(
      `/enrollment-keys/${parentKeyId}/installer/macos?count=1`,
      { headers: { authorization: `Bearer ${jwt}` } },
    );
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition');
    expect(cd).toMatch(/Breeze Installer \[[A-Z0-9]{6}@[^\]]+\]\.app\.zip/);
  });

  it('falls back to legacy zip when ?legacy=1 is passed', async () => {
    vi.mocked(fetchMacosInstallerAppZip).mockResolvedValue(/* unused */ Buffer.alloc(0));
    // ... same parent-key mocks ...
    const res = await app.request(
      `/enrollment-keys/${parentKeyId}/installer/macos?count=1&legacy=1`,
      { headers: { authorization: `Bearer ${jwt}` } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('breeze-agent-macos.zip');
  });

  it('falls back to legacy zip when installer app asset is missing (404)', async () => {
    vi.mocked(fetchMacosInstallerAppZip).mockResolvedValue(null);
    // ... mocks ...
    const res = await app.request(
      `/enrollment-keys/${parentKeyId}/installer/macos?count=1`,
      { headers: { authorization: `Bearer ${jwt}` } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('breeze-agent-macos.zip');
  });
});
```

(Helper `buildFixtureAppZip` already exists in `installerAppZip.test.ts` — extract to a shared `__fixtures__` module or duplicate it inline.)

- [ ] **Step 3: Run tests**

```bash
cd apps/api && npx vitest run src/routes/enrollmentKeys.test.ts -t "installer/macos"
```
Expected: original tests still pass + 3 new tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/enrollmentKeys.ts apps/api/src/routes/enrollmentKeys.test.ts
git commit -m "feat(api): macOS installer route returns renamed app zip"
```

---

## Task 6: End-to-end smoke test

**Files:** none (manual verification)

Requires: Plan A + Plan B both deployed. Plan B's CI must have published `Breeze Installer.app.zip` as a GitHub release asset for the version your local API is configured to download.

- [ ] **Step 1: Start the API + ensure it can reach the release**

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev up -d
# Verify the installer app asset is reachable for the current BINARY_VERSION:
cd apps/api && pnpm tsx -e "
  import { probeMacosInstallerApp } from './src/services/installerBuilder';
  probeMacosInstallerApp().then(r => console.log('reachable:', r));
"
```
Expected: `reachable: true`. If false, either the release hasn't shipped yet (set `BINARY_VERSION=latest` and re-test) or Plan B's CI didn't upload the asset (check GitHub release page).

- [ ] **Step 2: Download an installer**

```bash
JWT=$(./scripts/dev-login.sh)
PARENT_KEY_ID="REPLACE_WITH_REAL_KEY_ID"
curl -sS -OJ \
  -H "Authorization: Bearer $JWT" \
  "http://localhost:3001/api/v1/enrollment-keys/$PARENT_KEY_ID/installer/macos?count=1"
```
Expected: a file named `Breeze Installer [TOKEN@host].app.zip` lands in the current dir, ~55 MB.

- [ ] **Step 3: Extract + verify Gatekeeper acceptance**

```bash
unzip -q "Breeze Installer "*.app.zip
APP_PATH=$(ls -d "Breeze Installer "*.app | head -1)
spctl -a -t exec -vv "$APP_PATH"
```
Expected: `accepted` + `source=Notarized Developer ID` — the rename did not invalidate the staple.

- [ ] **Step 4: Launch the installer**

```bash
open "$APP_PATH"
```
Expected: window opens, fetches bootstrap, shows ConfirmView with the org name. Clicking Install triggers the native admin password dialog. After auth + ~10s, DoneView appears. Agent appears in the web console as a new device.

- [ ] **Step 5: Verify the legacy fallback still works**

```bash
curl -sS -OJ \
  -H "Authorization: Bearer $JWT" \
  "http://localhost:3001/api/v1/enrollment-keys/$PARENT_KEY_ID/installer/macos?count=1&legacy=1"
```
Expected: a file named `breeze-agent-macos.zip` (the old path), unzippable to the install.sh + 2 PKGs + enrollment.json bundle.

- [ ] **Step 6: Confirm CI green**

```bash
cd apps/api && pnpm test
```
Expected: all green.

No commit — verification only.

---

## Self-Review Notes

- **Spec coverage:** Plan C delivers Spec §"Components #5 — installer builder service" (zip rename helper, fetcher) and the route change (Spec §"Components #2 — Installer route"). Combined with Plan A (token + endpoint) and Plan B (Swift app + CI), the full spec ships.
- **No placeholders:** all TypeScript, all Vitest cases, all curl commands are concrete.
- **Type consistency:** `IssueBootstrapTokenInput`, `IssuedBootstrapToken`, `BootstrapTokenIssuanceError`, `RenameAppInZipOpts`, `fetchMacosInstallerAppZip` — defined where first used and referenced consistently.
- **Behaviour-preserving for legacy callers:** the route change is gated on whether `fetchMacosInstallerAppZip()` returns a buffer. Until the first release that publishes `Breeze Installer.app.zip`, every download still returns the legacy zip. There is no flag day.
- **Rollback path:** removing the new branch and reverting the import edits restores prior behaviour exactly. `?legacy=1` exists for individual-call rollback (e.g., a single customer reports the new installer broken — they can hit `?legacy=1` to get the working old path while we investigate).
- **One known unknown:** the existing enrollmentKeys.test.ts mock harness for the macOS branch — Plan A's tests already mock the legacy-path dependencies (`fetchMacosPkgs`, `buildMacosInstallerZip`); we now need to add `fetchMacosInstallerAppZip` to that mock surface. If the mock pattern doesn't cleanly accept additions, refactor the route's macOS branch into a smaller `serveMacosInstaller` helper first and test the helper directly.

---

## Plan C Followups (not in this plan)

- Remove the legacy `?legacy=1` fallback after one full release cycle with no rollback needed.
- Delete `MACOS_INSTALL_SCRIPT` constant + `buildMacosInstallerZip` helper + `install.sh` references once legacy is removed.
- Surface the bootstrap token in the audit-log UI so support can correlate "user says installer didn't work" → which token → which IP consumed it (or didn't).
- Cron sweep for expired-but-never-consumed bootstrap tokens (Plan A followup) — moved here because Plan C makes it more visible (every install download issues one).
- Apply the same filename-token + bootstrap-endpoint pattern to Windows MSI as a future cleanup, retiring the `sign.2breeze.app` signing VM (see macOS spec appendix for the rationale).
