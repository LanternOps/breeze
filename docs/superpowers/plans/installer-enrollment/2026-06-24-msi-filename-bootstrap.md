# MSI Filename-Bootstrap Enrollment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve one static, CI-signed `breeze-agent.msi` and carry enrollment in a single-use bootstrap token embedded in the download filename, eliminating the per-download signing-VM round-trip — full parity with the macOS `.app` flow.

**Architecture:** The Windows download handler stops calling `MsiSigningService.buildAndSignMsi` and instead issues a bootstrap token (reusing the macOS `installerBootstrapTokens` infrastructure), serving the unmodified signed MSI with a `Content-Disposition` filename of `Breeze Agent [TOKEN@HOST].msi`. At install time a WiX immediate custom action captures the launched MSI path; a deferred CA runs a new `breeze-agent.exe bootstrap` command that parses `[TOKEN@HOST]` from the filename (or a `BOOTSTRAP_TOKEN` property), redeems it at `POST /api/v1/installer/bootstrap` for a fresh child enrollment key, and enrolls. Explicit `msiexec` property installs keep the existing direct-enroll path.

**Tech Stack:** Hono + Drizzle (API, TypeScript), Go + Cobra (agent), WiX v4 (MSI), GitHub Actions + PowerShell (CI), Vitest (API tests), Go `testing` (agent tests).

## Global Constraints

- **Spec:** `docs/superpowers/specs/installer-enrollment/2026-06-24-msi-filename-bootstrap-design.md` — authoritative; re-read before each task.
- **Migrations:** hand-written SQL in `apps/api/migrations/`, named `YYYY-MM-DD-<slug>.sql`, idempotent (`ADD COLUMN IF NOT EXISTS`, `pg_policies`/`DO $$` guards), no inner `BEGIN;`/`COMMIT;`, never edit a shipped migration. Run `pnpm db:check-drift` after schema edits.
- **No new tenant table** is created (only a column added to the existing `installer_bootstrap_tokens`), so no `rls-coverage.integration.test.ts` allowlist change is required.
- **Go:** `cd agent && go test -race ./...`; table-driven tests; tests alongside source.
- **API tests:** Vitest, alongside source; mock Drizzle/services as the existing `enrollmentKeys_installer.test.ts` and `installer.test.ts` do.
- **Versions:** bare semver, no `v` prefix in copy.
- **Scope guard:** Do **not** delete `MsiSigningService`, its env vars, or the signing VM — only remove its download-path call sites. Deletion is a deferred follow-up PR (spec Non-goals).
- **Commits:** end messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Branch:** all work on `spec/msi-filename-bootstrap` (already checked out).

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/api/migrations/2026-06-24-installer-bootstrap-token-platform.sql` | Add `installer_platform` to bootstrap tokens | Create |
| `apps/api/src/db/schema/installerBootstrapTokens.ts` | Drizzle schema for bootstrap tokens | Modify |
| `apps/api/src/services/installerBootstrapTokenIssuance.ts` | Token issuance helper | Modify (accept + persist platform) |
| `apps/api/src/routes/installer.ts` | `/bootstrap` redemption | Modify (propagate platform to child key) |
| `apps/api/src/services/installerBuilder.ts` | Installer asset helpers | Modify (add `serveWindowsBootstrapMsi` helper) |
| `apps/api/src/routes/enrollmentKeys.ts` | Installer download routes | Modify (Windows → bootstrap path; remove signing call sites) |
| `apps/api/src/routes/enrollmentKeys_installer.test.ts` | Download-route tests | Modify |
| `apps/api/src/routes/installer.test.ts` | Redemption tests | Modify |
| `agent/internal/agentapp/installer_filename.go` | Parse `[TOKEN@HOST]` from MSI filename | Create |
| `agent/internal/agentapp/installer_filename_test.go` | Parser tests | Create |
| `agent/internal/agentapp/bootstrap.go` | `bootstrap` command + redeem client | Create |
| `agent/internal/agentapp/bootstrap_test.go` | Bootstrap resolution + redeem tests | Create |
| `agent/internal/agentapp/main.go` | Register `bootstrapCmd` | Modify |
| `agent/installer/breeze.wxs` | `BOOTSTRAP_TOKEN` property + capture/deferred CAs | Modify |
| `.github/workflows/release.yml` | Drop template MSI build/upload/skip | Modify |
| `agent/installer/build-msi.ps1` | Remove `-Template` mode | Modify |

---

## Task 1: Carry installer platform on the bootstrap token

**Files:**
- Create: `apps/api/migrations/2026-06-24-installer-bootstrap-token-platform.sql`
- Modify: `apps/api/src/db/schema/installerBootstrapTokens.ts`
- Modify: `apps/api/src/services/installerBootstrapTokenIssuance.ts`
- Modify: `apps/api/src/routes/installer.ts:159-171` (child-key insert), `apps/api/src/routes/installer.ts:75` (signature area)
- Test: `apps/api/src/routes/installer.test.ts`

**Interfaces:**
- Produces: `issueBootstrapTokenForKey(input: { parentEnrollmentKeyId, createdByUserId, maxUsage?, installerPlatform?: "windows" | "macos" })` — persists `installerPlatform` (default `"macos"` for back-compat). The redeemed child enrollment key gets `installerPlatform` from the token row.

- [ ] **Step 1: Write the failing migration drift expectation**

Add the column to the Drizzle schema first so drift detection has a target. In `apps/api/src/db/schema/installerBootstrapTokens.ts`, add to the table definition (alongside the existing columns):

```ts
  installerPlatform: text("installer_platform"),
```

- [ ] **Step 2: Write the migration**

Create `apps/api/migrations/2026-06-24-installer-bootstrap-token-platform.sql`:

```sql
-- Carry the installer platform on the bootstrap token so the lazily-created
-- child enrollment key can record whether it came from a Windows or macOS
-- installer. Nullable + no default: existing rows and macOS callers leave it
-- null/"macos"; the Windows download path sets "windows".
ALTER TABLE installer_bootstrap_tokens
  ADD COLUMN IF NOT EXISTS installer_platform text;
```

- [ ] **Step 3: Verify no drift**

Run: `cd /Users/toddhebebrand/breeze && export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`
Expected: no drift reported (schema matches migrations).

- [ ] **Step 4: Write the failing test for platform propagation**

In `apps/api/src/routes/installer.test.ts`, add a test asserting that redeeming a token whose row has `installerPlatform: "windows"` creates a child enrollment key with `installerPlatform: "windows"`. Follow the file's existing mock style for the token row and `enrollmentKeys` insert capture. Skeleton:

```ts
it("propagates installer_platform from token to child enrollment key", async () => {
  // Arrange: token row with installerPlatform "windows", non-consumed, unexpired,
  // parent key resolvable (reuse the file's existing happy-path mock setup).
  // Capture the .values() passed to db.insert(enrollmentKeys).
  // Act: POST /bootstrap with the token.
  // Assert: captured child-key values include installerPlatform: "windows".
  expect(capturedChildKeyValues.installerPlatform).toBe("windows");
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze && pnpm --filter @breeze/api exec vitest run src/routes/installer.test.ts -t "propagates installer_platform"`
Expected: FAIL — child key currently hardcodes `installerPlatform: "macos"`.

- [ ] **Step 6: Plumb platform through issuance**

In `apps/api/src/services/installerBootstrapTokenIssuance.ts`, extend the input interface and the insert:

```ts
export interface IssueBootstrapTokenInput {
  parentEnrollmentKeyId: string;
  createdByUserId: string;
  maxUsage?: number;
  installerPlatform?: "windows" | "macos";
}
```

In the `db.insert(installerBootstrapTokens).values({ ... })` call, add:

```ts
    installerPlatform: input.installerPlatform ?? "macos",
```

- [ ] **Step 7: Use the token's platform on redemption**

In `apps/api/src/routes/installer.ts`, the child-key insert (currently hardcoded `installerPlatform: "macos"` at ~line 170) becomes:

```ts
        installerPlatform: row.installerPlatform ?? "macos",
```

(`row` is the selected `installerBootstrapTokens` row already in scope.)

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze && pnpm --filter @breeze/api exec vitest run src/routes/installer.test.ts`
Expected: PASS (new test + existing redemption tests).

- [ ] **Step 9: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/api/migrations/2026-06-24-installer-bootstrap-token-platform.sql \
  apps/api/src/db/schema/installerBootstrapTokens.ts \
  apps/api/src/services/installerBootstrapTokenIssuance.ts \
  apps/api/src/routes/installer.ts \
  apps/api/src/routes/installer.test.ts
git commit -m "feat(installer): carry installer platform on bootstrap token

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Windows download serves static MSI with a filename bootstrap token

**Files:**
- Modify: `apps/api/src/services/installerBuilder.ts` (add helper)
- Modify: `apps/api/src/routes/enrollmentKeys.ts:1068-1171` (authed download `GET /:id/installers/:platform`)
- Test: `apps/api/src/routes/enrollmentKeys_installer.test.ts`

**Interfaces:**
- Consumes: `issueBootstrapTokenForKey({ ..., installerPlatform: "windows" })` (Task 1), `fetchRegularMsi()` (existing, `installerBuilder.ts`).
- Produces: `serveWindowsBootstrapMsi(c, { msi: Buffer, token: string, apiHost: string }): Response` — sets `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="Breeze Agent [<token>@<apiHost>].msi"`, `Content-Length`, `Cache-Control: no-store`, returns the MSI body.

- [ ] **Step 1: Write the failing test — no signing-service call, token filename**

In `apps/api/src/routes/enrollmentKeys_installer.test.ts`, add a test for the Windows download with **no** signing service configured (its current default mock) asserting the response now serves a raw MSI named with the token, and that `buildAndSignMsi` is never called. Reuse the file's existing parent-key + auth mocks. Skeleton:

```ts
it("windows download serves a static MSI named with the bootstrap token", async () => {
  // issueBootstrapTokenForKey mock returns { id: "tok1", token: "ABCDE12345", expiresAt, parentKeyName }
  // PUBLIC_API_URL = "https://eu.2breeze.app"
  const res = await app.request(`/enrollment-keys/${keyId}/installers/windows`, { headers: authHeaders });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/octet-stream");
  expect(res.headers.get("content-disposition")).toBe(
    'attachment; filename="Breeze Agent [ABCDE12345@eu.2breeze.app].msi"',
  );
  // The static signed MSI is served as-is.
  const body = Buffer.from(await res.arrayBuffer());
  expect(body.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Write the failing test — no child enrollment key created at download**

Add a test asserting the Windows bootstrap download does **not** insert an `enrollmentKeys` child row (the child key is minted on redemption, not download):

```ts
it("windows bootstrap download does not create a child enrollment key", async () => {
  await app.request(`/enrollment-keys/${keyId}/installers/windows`, { headers: authHeaders });
  expect(enrollmentKeysInsertSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/toddhebebrand/breeze && pnpm --filter @breeze/api exec vitest run src/routes/enrollmentKeys_installer.test.ts -t "bootstrap"`
Expected: FAIL — current Windows path builds a zip / signs and creates a child key.

- [ ] **Step 4: Add the `serveWindowsBootstrapMsi` helper**

In `apps/api/src/services/installerBuilder.ts`, add (near the other Windows helpers):

```ts
import type { Context } from "hono";

/**
 * Serves the static, CI-signed MSI with the bootstrap token embedded in the
 * download filename — the Windows analogue of the macOS renamed-app zip. The
 * MSI bytes are never modified, so the Authenticode signature stays intact and
 * every customer shares one file hash (SmartScreen reputation accrues).
 */
export function serveWindowsBootstrapMsi(
  c: Context,
  args: { msi: Buffer; token: string; apiHost: string },
): Response {
  const filename = `Breeze Agent [${args.token}@${args.apiHost}].msi`;
  c.header("Content-Type", "application/octet-stream");
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  c.header("Content-Length", String(args.msi.length));
  c.header("Cache-Control", "no-store");
  return c.body(args.msi as unknown as ArrayBuffer);
}
```

- [ ] **Step 5: Rewrite the Windows branch of the authed download handler**

In `apps/api/src/routes/enrollmentKeys.ts`, add `serveWindowsBootstrapMsi` to the `installerBuilder` import. Then insert a Windows bootstrap path that runs **before** the existing signing/child-key block — mirroring the macOS block at lines 978-1066. Place it immediately after the macOS block (after line 1066), before the `signingService`/`binaryBuffer` fetch:

```ts
    // ----------------------------------------------------------------
    // Windows — static signed MSI + bootstrap token in the filename.
    // No per-customer signing, no child key here; the bootstrap endpoint
    // mints the child key lazily on consume (mirrors the macOS path above).
    // ----------------------------------------------------------------
    if (platform === "windows") {
      let issued;
      try {
        issued = await issueBootstrapTokenForKey({
          parentEnrollmentKeyId: parentKey.id,
          createdByUserId: auth.user.id,
          maxUsage: childMaxUsage,
          installerPlatform: "windows",
        });
      } catch (err) {
        if (err instanceof BootstrapTokenIssuanceError) {
          if (err.code === "parent_not_found")
            return c.json({ error: err.message }, 404);
          return c.json({ error: err.message }, 410);
        }
        throw err;
      }

      let msi: Buffer;
      try {
        msi = await fetchRegularMsi();
      } catch (err) {
        console.error("[installer] failed to fetch signed MSI:", err);
        return c.json({ error: "MSI not available" }, 503);
      }

      const apiHost = new URL(serverUrl).host;

      writeEnrollmentKeyAudit(c, auth, {
        orgId: parentKey.orgId,
        action: "enrollment_key.installer_download",
        keyId: parentKey.id,
        keyName: parentKey.name,
        details: {
          platform,
          mode: "bootstrap-msi",
          tokenId: issued.id,
          count: childMaxUsage,
        },
      });

      return serveWindowsBootstrapMsi(c, { msi, token: issued.token, apiHost });
    }
```

- [ ] **Step 6: Remove the now-dead Windows signing/zip branch**

In the same file, delete the `if (platform === "windows") { ... }` block inside the post-child-key `try` (the `signingService ? buildAndSignMsi : buildWindowsInstallerZip` branch, ~lines 1119-1171). The new early-return Windows path above replaces it entirely; the remaining code after the child-key insert is macOS-only. Also remove the now-unreachable `if (platform === "windows" && !signingService)` binary fetch at ~line 1075 (Windows no longer reaches the child-key block).

Verify after editing: the only `buildAndSignMsi` references left in this file are in the public `serveInstaller` path and the installer-link probe (handled in Task 3).

Run: `cd /Users/toddhebebrand/breeze && grep -n "buildAndSignMsi\|buildWindowsInstallerZip" apps/api/src/routes/enrollmentKeys.ts`
Expected: matches only at the `serveInstaller` (~1695) and probe (~1396) sites.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd /Users/toddhebebrand/breeze && pnpm --filter @breeze/api exec vitest run src/routes/enrollmentKeys_installer.test.ts`
Expected: PASS. Update any pre-existing Windows-path assertions in this file that assumed the zip/`.msi` signed output to expect the new bootstrap behavior.

- [ ] **Step 8: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/api/src/services/installerBuilder.ts \
  apps/api/src/routes/enrollmentKeys.ts \
  apps/api/src/routes/enrollmentKeys_installer.test.ts
git commit -m "feat(installer): windows download serves static MSI with filename bootstrap token

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Convert the public download + installer-link probe paths

**Files:**
- Modify: `apps/api/src/routes/enrollmentKeys.ts` — `serveInstaller` (~1597-1760) and the installer-link probe (~1395-1415)
- Test: `apps/api/src/routes/enrollmentKeys_installer.test.ts`

**Interfaces:**
- Consumes: `serveWindowsBootstrapMsi`, `issueBootstrapTokenForKey` (Task 2).

- [ ] **Step 1: Write the failing test for the public download path**

Add a test exercising the public `serveInstaller` Windows path (the short-code / public-download route this helper backs) asserting the same token-filename MSI response and no `buildAndSignMsi` call. Mirror the Task 2 test but drive it through the public route the file already tests.

```ts
it("public windows download serves a static MSI named with the bootstrap token", async () => {
  const res = await app.request(publicWindowsDownloadPath, {});
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toMatch(
    /^attachment; filename="Breeze Agent \[[A-Z0-9]{10}@[^\]]+\]\.msi"$/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze && pnpm --filter @breeze/api exec vitest run src/routes/enrollmentKeys_installer.test.ts -t "public windows"`
Expected: FAIL.

- [ ] **Step 3: Rewrite the `serveInstaller` Windows branch**

In `serveInstaller` (~1674-1716), replace the Windows `signingService ? buildAndSignMsi : buildWindowsInstallerZip` branch with the bootstrap flow. `serveInstaller` takes a resolved parent key (`row`) and a `platform`; for `platform === "windows"`:

```ts
    if (platform === "windows") {
      const issued = await issueBootstrapTokenForKey({
        parentEnrollmentKeyId: row.id,
        createdByUserId: row.createdBy,
        maxUsage: 1,
        installerPlatform: "windows",
      });
      const msi = await fetchRegularMsi();
      const apiHost = new URL(serverUrl).host;
      // audit as elsewhere in serveInstaller, then:
      return serveWindowsBootstrapMsi(c, { msi, token: issued.token, apiHost });
    }
```

Match `serveInstaller`'s existing variable names (`row`, `serverUrl`, audit helper) when wiring this in; keep the macOS branch untouched.

- [ ] **Step 4: Remove the Windows signing probe from installer-link creation**

In the installer-link creation route (~1395-1415), the Windows branch currently does `const signingService = MsiSigningService.fromEnv(); if (signingService) await signingService.probe();` then 503s when unreachable. The bootstrap path has no signing dependency, so a Windows installer link is always serviceable. Replace the Windows branch body so it no longer probes or 503s on signing — issuing a link only requires a valid parent key (already validated above this block). Leave the macOS branch unchanged.

Run: `cd /Users/toddhebebrand/breeze && grep -n "buildAndSignMsi\|signingService\|MsiSigningService" apps/api/src/routes/enrollmentKeys.ts`
Expected: no remaining references in `enrollmentKeys.ts` (the import of `MsiSigningService` can now be removed from this file).

- [ ] **Step 5: Remove the now-unused import**

Delete the `import { MsiSigningService } from "../services/msiSigning";` line from `enrollmentKeys.ts`. (The service file itself stays — deletion is the deferred follow-up per Global Constraints.)

- [ ] **Step 6: Run the full installer + enrollmentKeys test suites**

Run: `cd /Users/toddhebebrand/breeze && pnpm --filter @breeze/api exec vitest run src/routes/enrollmentKeys_installer.test.ts src/routes/installer.test.ts src/routes/enrollmentKeys.test.ts src/modules/mcpInvites/inviteLandingRoutes.test.ts`
Expected: PASS. Fix any remaining tests that asserted the old signed-MSI/zip Windows output.

- [ ] **Step 7: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/api/src/routes/enrollmentKeys.ts apps/api/src/routes/enrollmentKeys_installer.test.ts
git commit -m "feat(installer): bootstrap windows MSI on public + installer-link paths; drop signing probe

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Agent filename-token parser

**Files:**
- Create: `agent/internal/agentapp/installer_filename.go`
- Test: `agent/internal/agentapp/installer_filename_test.go`

**Interfaces:**
- Produces: `parseInstallerFilenameToken(name string) (token string, host string, err error)` — extracts the first `[TOKEN@HOST]` group from a basename. `token` is exactly 10 chars of `[A-Z0-9]`; `host` matches `[a-zA-Z0-9.\-]+`. Returns `errNoFilenameToken` when no match. Mirrors `FilenameTokenParser.swift`'s regex `\[([A-Z0-9]{10})@([a-zA-Z0-9.\-]+)\]`.

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/agentapp/installer_filename_test.go`:

```go
package agentapp

import "testing"

func TestParseInstallerFilenameToken(t *testing.T) {
	cases := []struct {
		name      string
		input     string
		wantTok   string
		wantHost  string
		wantError bool
	}{
		{"clean", "Breeze Agent [ABCDE12345@eu.2breeze.app].msi", "ABCDE12345", "eu.2breeze.app", false},
		{"browser dup suffix", "Breeze Agent [ABCDE12345@us.2breeze.app] (1).msi", "ABCDE12345", "us.2breeze.app", false},
		{"full path", `C:\Users\me\Downloads\Breeze Agent [Z9Y8X7W6V5@host.example.com].msi`, "Z9Y8X7W6V5", "host.example.com", false},
		{"host with hyphen", "Breeze Agent [ABCDE12345@my-rmm.example].msi", "ABCDE12345", "my-rmm.example", false},
		{"no brackets", "breeze-agent.msi", "", "", true},
		{"token too short", "Breeze Agent [ABCDE1234@host].msi", "", "", true},
		{"token lowercase", "Breeze Agent [abcde12345@host].msi", "", "", true},
		{"empty", "", "", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tok, host, err := parseInstallerFilenameToken(tc.input)
			if tc.wantError {
				if err == nil {
					t.Fatalf("expected error, got token=%q host=%q", tok, host)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tok != tc.wantTok || host != tc.wantHost {
				t.Fatalf("got (%q,%q), want (%q,%q)", tok, host, tc.wantTok, tc.wantHost)
			}
		})
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/agentapp/ -run TestParseInstallerFilenameToken`
Expected: FAIL — `parseInstallerFilenameToken` undefined.

- [ ] **Step 3: Implement the parser**

Create `agent/internal/agentapp/installer_filename.go`:

```go
package agentapp

import (
	"errors"
	"regexp"
)

// errNoFilenameToken is returned when a filename carries no [TOKEN@HOST] group.
var errNoFilenameToken = errors.New("no bootstrap token in installer filename")

// installerTokenRe mirrors FilenameTokenParser.swift: a 10-char base36 token
// and a host, wrapped in square brackets. The token charset is uppercase to
// avoid ambiguity; the host allows letters, digits, dots, and hyphens.
var installerTokenRe = regexp.MustCompile(`\[([A-Z0-9]{10})@([a-zA-Z0-9.\-]+)\]`)

// parseInstallerFilenameToken extracts the bootstrap token and API host from an
// installer path or basename. It searches anywhere in the string, so a browser
// "(1)" dedup suffix or a full path does not break matching.
func parseInstallerFilenameToken(name string) (token string, host string, err error) {
	m := installerTokenRe.FindStringSubmatch(name)
	if m == nil {
		return "", "", errNoFilenameToken
	}
	return m[1], m[2], nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/agentapp/ -run TestParseInstallerFilenameToken`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/agentapp/installer_filename.go agent/internal/agentapp/installer_filename_test.go
git commit -m "feat(agent): parse [TOKEN@HOST] from installer filename

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Agent `bootstrap` command

**Files:**
- Create: `agent/internal/agentapp/bootstrap.go`
- Test: `agent/internal/agentapp/bootstrap_test.go`
- Modify: `agent/internal/agentapp/main.go:168-230` (command registration)

**Interfaces:**
- Consumes: `parseInstallerFilenameToken` (Task 4), `enrollDevice` + the `serverURL`/`enrollmentSecret`/`enrollSiteID` package globals (existing, `main.go`).
- Produces:
  - `resolveBootstrapInputs(installData string) (token, server string, err error)` — pure resolver over the WiX `--install-data` payload `"<OriginalDatabase>|<BOOTSTRAP_TOKEN>|<SERVER_URL>"`. Precedence: (1) `BOOTSTRAP_TOKEN`+`SERVER_URL` properties; (2) filename `[TOKEN@HOST]` → `https://HOST`. Returns `errNoBootstrapInput` when neither resolves.
  - `redeemBootstrapToken(server, token string) (*bootstrapResult, error)` — `POST {server}/api/v1/installer/bootstrap` with header `X-Breeze-Bootstrap-Token`; returns `{ServerURL, EnrollmentKey, EnrollmentSecret string}`.
  - `bootstrapCmd` Cobra command: `breeze-agent bootstrap --install-data <payload> [--quiet]`. On `errNoBootstrapInput`, logs and exits 0 (soft — install proceeds unenrolled). On redeem/enroll failure, exits non-zero (rollback).

- [ ] **Step 1: Write the failing resolver tests**

Create `agent/internal/agentapp/bootstrap_test.go`:

```go
package agentapp

import (
	"errors"
	"testing"
)

func TestResolveBootstrapInputs(t *testing.T) {
	cases := []struct {
		name       string
		data       string
		wantToken  string
		wantServer string
		wantErr    error
	}{
		{
			name:       "filename token only",
			data:       `C:\dl\Breeze Agent [ABCDE12345@eu.2breeze.app].msi||`,
			wantToken:  "ABCDE12345",
			wantServer: "https://eu.2breeze.app",
		},
		{
			name:       "property token + server wins over filename",
			data:       `C:\dl\Breeze Agent [ABCDE12345@eu.2breeze.app].msi|ZZZZZ99999|https://us.2breeze.app`,
			wantToken:  "ZZZZZ99999",
			wantServer: "https://us.2breeze.app",
		},
		{
			name:    "no token anywhere",
			data:    `C:\dl\breeze-agent.msi||`,
			wantErr: errNoBootstrapInput,
		},
		{
			name:    "property token without server falls back to filename",
			data:    `C:\dl\Breeze Agent [ABCDE12345@eu.2breeze.app].msi|ZZZZZ99999|`,
			wantToken:  "ABCDE12345",
			wantServer: "https://eu.2breeze.app",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tok, server, err := resolveBootstrapInputs(tc.data)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("want err %v, got %v", tc.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tok != tc.wantToken || server != tc.wantServer {
				t.Fatalf("got (%q,%q), want (%q,%q)", tok, server, tc.wantToken, tc.wantServer)
			}
		})
	}
}

func TestRedeemBootstrapToken(t *testing.T) {
	// httptest server returns a fixed payload; assert the header is sent and
	// the response fields are parsed.
	// (Implement against redeemBootstrapToken using net/http/httptest.)
}
```

- [ ] **Step 2: Run the resolver test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/agentapp/ -run TestResolveBootstrapInputs`
Expected: FAIL — `resolveBootstrapInputs` / `errNoBootstrapInput` undefined.

- [ ] **Step 3: Implement the resolver, redeem client, and command**

Create `agent/internal/agentapp/bootstrap.go`:

```go
package agentapp

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"breeze-agent/internal/config"
	"breeze-agent/internal/logging"
)

var errNoBootstrapInput = errors.New("no bootstrap token from filename or properties")

// bootstrapInstallData is the WiX CustomActionData payload, packed by the
// SetBootstrapData type-51 CA as "<OriginalDatabase>|<BOOTSTRAP_TOKEN>|<SERVER_URL>".
var bootstrapInstallData string

type bootstrapResult struct {
	ServerURL        string `json:"serverUrl"`
	EnrollmentKey    string `json:"enrollmentKey"`
	EnrollmentSecret string `json:"enrollmentSecret"`
	SiteID           string `json:"siteId"`
}

// resolveBootstrapInputs decides which token/server to use. Property token +
// server take precedence (explicit silent-install intent); otherwise the
// [TOKEN@HOST] in the installer filename is used, with the host promoted to an
// https:// server URL. Mirrors the macOS payload-then-filename precedence.
func resolveBootstrapInputs(data string) (token, server string, err error) {
	parts := strings.SplitN(data, "|", 3)
	var installerPath, propToken, propServer string
	if len(parts) > 0 {
		installerPath = parts[0]
	}
	if len(parts) > 1 {
		propToken = strings.TrimSpace(parts[1])
	}
	if len(parts) > 2 {
		propServer = strings.TrimSpace(parts[2])
	}

	if propToken != "" && propServer != "" {
		return propToken, propServer, nil
	}

	if tok, host, ferr := parseInstallerFilenameToken(installerPath); ferr == nil {
		return tok, "https://" + host, nil
	}
	return "", "", errNoBootstrapInput
}

// redeemBootstrapToken exchanges a single-use token for a child enrollment key.
func redeemBootstrapToken(server, token string) (*bootstrapResult, error) {
	url := strings.TrimRight(server, "/") + "/api/v1/installer/bootstrap"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader([]byte("{}")))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Breeze-Bootstrap-Token", token)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("bootstrap redeem failed: %d %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out bootstrapResult
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("bootstrap redeem: bad response: %w", err)
	}
	if out.EnrollmentKey == "" {
		return nil, errors.New("bootstrap redeem: response missing enrollmentKey")
	}
	if out.ServerURL == "" {
		out.ServerURL = server
	}
	return &out, nil
}

// runBootstrap resolves enrollment inputs, redeems the token, and enrolls.
// Soft-exits 0 when there is genuinely no token (manual install with no token
// and no properties), so the install completes with an unenrolled agent that
// idles in the wait-for-enrollment loop. A present-but-bad token is a real
// error and exits non-zero so the MSI rolls back cleanly.
func runBootstrap() {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		cfg = config.Default()
	}
	initEnrollLogging(cfg, quietEnroll)
	log := logging.L("bootstrap")

	token, server, err := resolveBootstrapInputs(bootstrapInstallData)
	if err != nil {
		log.Info("no bootstrap token present; skipping enrollment (agent will idle until enrolled)")
		if !quietEnroll {
			fmt.Println("No enrollment token found; install will complete unenrolled.")
		}
		return // exit 0 — soft
	}

	log.Info("redeeming bootstrap token", "server", server)
	res, err := redeemBootstrapToken(server, token)
	if err != nil {
		log.Error("bootstrap token redemption failed", "error", err.Error())
		fmt.Fprintf(os.Stderr, "Bootstrap failed: %v\n", err)
		os.Exit(1) // hard — roll back the install
	}

	// Hand off to the existing enroll path via the package globals it reads.
	serverURL = res.ServerURL
	enrollmentSecret = res.EnrollmentSecret
	if res.SiteID != "" {
		enrollSiteID = res.SiteID
	}
	enrollDevice(res.EnrollmentKey)
}
```

- [ ] **Step 4: Register the command in `main.go`**

In `agent/internal/agentapp/main.go`, add the command var (near `enrollCmd`, ~line 175):

```go
var bootstrapCmd = &cobra.Command{
	Use:    "bootstrap",
	Short:  "Redeem an installer bootstrap token and enroll (used by the MSI)",
	Hidden: true,
	Run: func(cmd *cobra.Command, args []string) {
		runBootstrap()
	},
}
```

In `init()` add the flags + registration (alongside the `enrollCmd` block, ~lines 216-226):

```go
	bootstrapCmd.Flags().StringVar(&bootstrapInstallData, "install-data", "", "Packed WiX CustomActionData: <OriginalDatabase>|<BOOTSTRAP_TOKEN>|<SERVER_URL>")
	bootstrapCmd.Flags().BoolVar(&quietEnroll, "quiet", false, "Suppress stdout progress output (errors still go to stderr)")
```

```go
	rootCmd.AddCommand(bootstrapCmd)
```

Note: `quietEnroll` is the existing package global already bound by `enrollCmd`. Cobra binds per-command flag sets, so binding the same variable on `bootstrapCmd` is fine — each command parses only its own invocation.

- [ ] **Step 5: Implement `TestRedeemBootstrapToken` against httptest**

Fill in the stub from Step 1:

```go
func TestRedeemBootstrapToken(t *testing.T) {
	var gotToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-Breeze-Bootstrap-Token")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"serverUrl":"` + "http://x" + `","enrollmentKey":"deadbeef","enrollmentSecret":"s","siteId":"site1"}`))
	}))
	defer srv.Close()

	res, err := redeemBootstrapToken(srv.URL, "ABCDE12345")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotToken != "ABCDE12345" {
		t.Fatalf("token header not sent, got %q", gotToken)
	}
	if res.EnrollmentKey != "deadbeef" || res.SiteID != "site1" {
		t.Fatalf("unexpected result: %+v", res)
	}
}
```

Add the `net/http`, `net/http/httptest` imports to the test file.

- [ ] **Step 6: Run the agent tests + build**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/agentapp/ -run "TestResolveBootstrapInputs|TestRedeemBootstrapToken|TestParseInstallerFilenameToken" && go build ./...`
Expected: PASS + clean build.

- [ ] **Step 7: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/agentapp/bootstrap.go agent/internal/agentapp/bootstrap_test.go agent/internal/agentapp/main.go
git commit -m "feat(agent): bootstrap command redeems filename token and enrolls

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: WiX custom actions for filename bootstrap

**Files:**
- Modify: `agent/installer/breeze.wxs:46-64` (properties), `agent/installer/breeze.wxs:290-348` (custom actions + sequence)

**Interfaces:**
- Consumes: `breeze-agent.exe bootstrap --install-data` (Task 5).
- The deferred CA receives `CustomActionData = "<OriginalDatabase>|<BOOTSTRAP_TOKEN>|<SERVER_URL>"`.

- [ ] **Step 1: Declare the `BOOTSTRAP_TOKEN` property**

In `agent/installer/breeze.wxs`, after the `ENROLLMENT_SECRET` property block (~line 62), add:

```xml
    <Property Id="BOOTSTRAP_TOKEN" Secure="yes" Hidden="yes" />
```

- [ ] **Step 2: Add the capture + deferred bootstrap custom actions**

After the `EnrollAgent` custom action (~line 297), add:

```xml
    <!-- Capture the launched MSI path + bootstrap inputs while the original
         session properties are still readable (immediate CA). OriginalDatabase
         points at the user's downloaded file here; by deferred execution the
         package is cached to C:\Windows\Installer and the [TOKEN@HOST] name is
         gone. Packed pipe-delimited because deferred CAs only see CustomActionData. -->
    <CustomAction
      Id="SetBootstrapData"
      Property="BootstrapEnroll"
      Value="[OriginalDatabase]|[BOOTSTRAP_TOKEN]|[SERVER_URL]" />

    <CustomAction
      Id="BootstrapEnroll"
      FileRef="filBreezeAgentExe"
      ExeCommand="bootstrap --install-data &quot;[CustomActionData]&quot; --quiet"
      Execute="deferred"
      Impersonate="no"
      Return="check"
      HideTarget="yes" />
```

- [ ] **Step 3: Sequence the new actions**

In `<InstallExecuteSequence>`, immediately after the existing `EnrollAgent` line (~line 346), add:

```xml
      <!-- Filename/property bootstrap enrollment: only when explicit
           SERVER_URL+ENROLLMENT_KEY were NOT supplied (those take the
           EnrollAgent path above). SetBootstrapData (immediate) must run before
           the deferred BootstrapEnroll so CustomActionData is populated. -->
      <Custom Action="SetBootstrapData" Before="BootstrapEnroll" Condition="NOT Installed AND NOT (SERVER_URL AND ENROLLMENT_KEY)" />
      <Custom Action="BootstrapEnroll" Before="InstallServices" After="EnrollAgent" Condition="NOT Installed AND NOT (SERVER_URL AND ENROLLMENT_KEY)" />
```

(Both run `Before="InstallServices"` so the service starts with a valid `agent.yaml`, exactly like `EnrollAgent`. The two enrollment CAs are mutually exclusive via opposite `SERVER_URL AND ENROLLMENT_KEY` conditions.)

- [ ] **Step 4: Validate the WiX source builds (CI / Windows VM)**

This step requires a Windows + WiX v4 environment (the Windows test VM, Tailscale `100.101.150.55`, or CI). The plan's local checkpoint is a structural lint; the authoritative build happens in CI (Task 7 runs the same `build-msi.ps1`).

Local check (non-Windows): confirm the XML is well-formed and the new IDs are referenced consistently. Use `xmllint` (no external-entity resolution) rather than a Python stdlib parser.

Run: `cd /Users/toddhebebrand/breeze && xmllint --noout --nonet agent/installer/breeze.wxs && echo well-formed && grep -c "BootstrapEnroll" agent/installer/breeze.wxs`
Expected: `well-formed` and a count of `3` (CA `Property` target, CA `Id`, sequence ref); also confirm `SetBootstrapData` appears as both a CA `Id` and a sequence ref.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/installer/breeze.wxs
git commit -m "feat(installer): WiX bootstrap CAs read filename token at install time

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Drop the template MSI from CI and the build script

**Files:**
- Modify: `.github/workflows/release.yml:544-554` (Build Template MSI step), `:632-636` (template upload), `:2030-2036` (publish skip), `:556` (comment)
- Modify: `agent/installer/build-msi.ps1:20,86-98,113` (`-Template` switch + padding args)

**Interfaces:** none (build/release only).

- [ ] **Step 1: Remove the `-Template` mode from `build-msi.ps1`**

In `agent/installer/build-msi.ps1`:
- Delete the `[switch]$Template` parameter (line 20).
- Delete the `$templateArgs = @() ... }` block (lines 86-98).
- Change the `$wixArgs` assignment to drop `+ $templateArgs` (line 113 becomes just the array, no concatenation).

- [ ] **Step 2: Remove the Build Template MSI + upload + skip from `release.yml`**

In `.github/workflows/release.yml`:
- Delete the entire `- name: Build Template MSI` step (lines 544-554).
- Update the comment at line 556 from "Only sign the regular MSI — template MSI is re-signed server-side by jsign after patching" to: `# Sign the agent MSI (Azure Trusted Signing).`
- Delete the template artifact upload step (the `name: breeze-agent-template-msi` / `path: dist/breeze-agent-template.msi` block, ~lines 633-636 with its enclosing `- uses: actions/upload-artifact` step).
- In the release-asset publish logic (~lines 2030-2036), delete the `if name.endswith("-template.msi"): ...skip...` branch and its comment, since no template MSI is produced anymore.

- [ ] **Step 3: Verify no lingering template references**

Run: `cd /Users/toddhebebrand/breeze && grep -rn "template.msi\|Template MSI\|breeze-agent-template\|\$Template\|-Template" .github/workflows/release.yml agent/installer/build-msi.ps1`
Expected: no matches.

- [ ] **Step 4: Lint the workflow YAML**

Run: `cd /Users/toddhebebrand/breeze && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('valid yaml')"`
Expected: `valid yaml`.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add .github/workflows/release.yml agent/installer/build-msi.ps1
git commit -m "chore(release): drop template MSI; ship one signed breeze-agent.msi

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Full-suite verification + manual VM matrix

**Files:** none (verification only).

- [ ] **Step 1: Run the API test suite for touched areas**

Run: `cd /Users/toddhebebrand/breeze && pnpm --filter @breeze/api exec vitest run src/routes/enrollmentKeys_installer.test.ts src/routes/installer.test.ts src/routes/enrollmentKeys.test.ts src/modules/mcpInvites/inviteLandingRoutes.test.ts`
Expected: PASS.

- [ ] **Step 2: Run the agent suite with race detector**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/agentapp/... && go build ./...`
Expected: PASS + clean build.

- [ ] **Step 3: Schema drift check**

Run: `cd /Users/toddhebebrand/breeze && export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`
Expected: no drift.

- [ ] **Step 4: Manual install matrix on the Windows test VM**

On the Windows test VM (Tailscale `100.101.150.55`, see the `windows_test_vm` memory), build a signed MSI via CI (or the VM), then verify each row enrolls/behaves as expected. Record PASS/FAIL per row:

| Scenario | Command / action | Expected |
|---|---|---|
| Filename token (double-click) | Save as `Breeze Agent [TOKEN@HOST].msi`, double-click | Enrolls; device appears in console |
| Browser dup suffix | Rename to `... [TOKEN@HOST] (1).msi`, install | Enrolls (regex tolerates suffix) |
| Silent properties | `msiexec /i breeze-agent.msi SERVER_URL=https://HOST ENROLLMENT_KEY=<64hex> /qn` | Enrolls via legacy `EnrollAgent` CA |
| Property token | `msiexec /i breeze-agent.msi BOOTSTRAP_TOKEN=<token> SERVER_URL=https://HOST /qn` | Enrolls via `BootstrapEnroll` CA |
| No token, no props | Rename to `breeze-agent.msi`, double-click | Installs; agent idles unenrolled; **no 1603 rollback** |
| Expired token | Use a token past TTL | Install rolls back (1603); `enroll-last-error.txt` / `agent.log` explain |

- [ ] **Step 5: Confirm the served filename end-to-end**

From a browser against a dev/staging API, download a Windows installer and confirm the saved file is `Breeze Agent [TOKEN@HOST].msi` and that `MSI_SIGNING_URL` need not be set for the download to succeed.

- [ ] **Step 6: Final commit (if any verification fixups were needed)**

```bash
cd /Users/toddhebebrand/breeze
git add -A
git commit -m "test(installer): verification fixups for filename-bootstrap MSI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** §Components 1 (server download) → Tasks 2-3; 2 (agent bootstrap) → Tasks 4-5; 3 (WiX) → Task 6; 4 (retire signing path) → Tasks 2-3 (call sites) + Task 7 (template MSI); the dormant `MsiSigningService` deletion is explicitly out of scope per Non-goals. §Testing → Tasks 1-8. §Risks: `OriginalDatabase` timing (Task 6 immediate CA), fail-soft #411 boundary (Task 5 soft-exit + Task 8 manual rows), filename survival (Task 4 tests + Task 8), cross-region host (Task 5 `https://HOST` from filename), platform on child key (Task 1).
- **Type consistency:** `serveWindowsBootstrapMsi(c, {msi, token, apiHost})`, `parseInstallerFilenameToken(name) → (token, host, err)`, `resolveBootstrapInputs(data) → (token, server, err)`, `redeemBootstrapToken(server, token) → (*bootstrapResult, err)`, `issueBootstrapTokenForKey({..., installerPlatform})` are used identically across tasks.
- **Deferred:** deletion of `apps/api/src/services/msiSigning.ts`, its env vars, and signing-VM decommission — tracked as a follow-up PR.
