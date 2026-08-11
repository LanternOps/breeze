# BYO Signing Phase 1: Release Unsigned Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the exact pre-signing Windows and macOS build outputs as `-unsigned` release assets, and extend the signed release-artifact manifest with `sourceCommit` plus `intendedUse: "signing-input"` / `platformTrust: "none"` entries for them — without weakening any existing integrity guarantee on the signed set.

**Architecture:** The Windows exe build moves out of the signing-gated `build-windows-msi` job into a new unconditional-on-tags `build-windows-unsigned` job that uploads `-unsigned` artifacts; `build-windows-msi` then downloads those artifacts as its signing inputs, which makes the published unsigned files byte-identical pre-sign inputs *by construction* and makes unsigned publication independent of `vars.ENABLE_WINDOWS_SIGNING`. macOS unsigned capture is a copy step inserted between the (already unconditional) artifact downloads and the step-gated signing in `build-macos-agent`. The manifest generator in `create-release` classifies `-unsigned` names before its extension-based branches and records the release's source commit; a new assertion step proves the classification and the signed-set non-regression before the manifest is signed.

**Tech Stack:** GitHub Actions YAML, PowerShell, bash, Python (inline manifest generator), TypeScript (manifest parser tolerance)

## Global Constraints

- Exact new artifact filenames (from the approved spec, table in Deliverable 1): `breeze-agent-windows-amd64-unsigned.exe`, `breeze-backup-windows-amd64-unsigned.exe`, `breeze-watchdog-windows-amd64-unsigned.exe`, `breeze-user-helper-windows-amd64-unsigned.exe`, and `breeze-{agent,backup,desktop-helper,watchdog}-darwin-{amd64,arm64}-unsigned` (8 darwin files, no extension). No unsigned `Breeze Installer.app.zip`, no unsigned MSI or PKG.
- The `-unsigned` suffix goes **before** the `.exe` extension on Windows and at the end of the extensionless darwin names; the suffix rule in the manifest classifier MUST be evaluated before the `.exe`/`.msi` extension branch.
- Unsigned manifest entries get `intendedUse: "signing-input"` AND `platformTrust: "none"`; signed-set entries keep their existing `platformTrust` values byte-for-byte and never gain `intendedUse`.
- `sourceCommit` = the checked-out release commit, resolved as `git rev-parse 'HEAD^{commit}'` in the `create-release` job (see Task 3 note: this is `$GITHUB_SHA` for lightweight tags but stays correct for annotated tags, where `GITHUB_SHA` can name the tag object).
- Unsigned uploads must not be gated on `vars.ENABLE_WINDOWS_SIGNING` / `vars.ENABLE_MACOS_SIGNING` — the capture path runs on every `v*` tag. (The `release-integrity-gate` still fails a tag release when signing is disabled; flipping that end-state is rollout step 4 of the spec, explicitly out of scope here.)
- `release-integrity-gate` must not regress: all existing `require_success` assertions stay; this plan only *adds* a requirement (the new `build-windows-unsigned` job) and a manifest-content assertion step.
- `scripts/security/check-supply-chain-hardening.sh` greps `release.yml` for sentinel strings (`^permissions:`, `^  release-integrity-gate:`, `needs: .*release-integrity-gate`, `ENABLE_MACOS_SIGNING must be true for tag releases`, `Required signed/notarized release asset missing or empty`, `release-artifact-manifest\.json` + `.minisig` + `.ed25519`) — none of these strings may be removed or reworded.
- The `-unsigned` files must NOT flow into the `binaries-init` Docker image (`build-binaries-image` downloads `breeze-agent-*` patterns which now match them) — Task 4 strips them from image staging.
- API-side: `apps/api/src/services/releaseArtifactManifest.ts` is a hand-rolled tolerant parser (NOT zod); new fields must be proven tolerated by unit test, not assumed.
- No migrations are touched in this deliverable (repo rule "never edit a shipped migration" is n/a but binding).
- Workflow YAML has no unit runner: every workflow edit is validated with `actionlint` (installed at `/opt/homebrew/bin/actionlint`), `python3 -c 'import yaml; yaml.safe_load(...)'`, the supply-chain hardening script, and (for the Python generator) a local fixture run.
- `actionlint` has pre-existing shellcheck findings in `release.yml` (e.g. SC2046 at lines 751/1015) — capture a baseline before editing and require **no new findings**, not zero findings.
- Conventional-commit messages; every commit ends with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Work on a dedicated branch off `main` (e.g. `byo-signing-1-unsigned-artifacts`); do not commit to `main` directly.

---

### Task 1: Unconditional Windows exe build job publishing `-unsigned` artifacts; rewire `build-windows-msi` to consume them

**Files:**
- Modify: `/Users/toddhebebrand/orca/workspaces/breeze/constrained-signed-installer/.github/workflows/release.yml`
  - `build-windows-msi` job: header at line 254, signing-var gate at lines 256–259, `Setup Go` at 273–277, `Download Go dependencies` at 279–282, `Get version from tag` at 299–306, `Build Windows resources and binary` step at 308–425, `Scan Windows binaries for plaintext threat signatures (#2797)` step at 427–448, sign steps at 485–579, `Build MSI` at 581–591, MSI sign at 593–616, `Verify signatures` at 618–638, uploads at 640–683.
  - `release-integrity-gate` job: `needs` at line 1907, env block at 1916–1923, `require_success` calls at 1940–1947.
  - `create-release` job: `needs` at line 1957, `if` conditions at 1958–1976, download pattern at line 1989 (already matches `breeze-agent-*`, `breeze-backup-*`, `breeze-watchdog-*`, `breeze-user-helper-*` — the new artifact names need no pattern change).
- Test: `actionlint`, YAML parse, `bash scripts/security/check-supply-chain-hardening.sh`, targeted `grep` assertions (no unit runner for workflows).

**Interfaces:**
- Consumes: `build-agent` matrix job (ordering only — the Windows exes are rebuilt resource-stamped, not taken from the matrix).
- Produces: four CI artifacts `breeze-{agent,backup,watchdog,user-helper}-windows-amd64-unsigned`, each containing the single file of the same name + `.exe`; `build-windows-msi` consumes exactly these as signing inputs; `create-release` picks them up via the existing `breeze-agent-*`/`breeze-backup-*`/`breeze-watchdog-*`/`breeze-user-helper-*` download patterns (line 1989) and its copy loops (lines 1997–2030).

**Steps:**

- [ ] Create the working branch: `git checkout main && git pull && git checkout -b byo-signing-1-unsigned-artifacts`
- [ ] Capture the actionlint baseline: `actionlint .github/workflows/release.yml > /tmp/actionlint-baseline.txt 2>&1 || true` (pre-existing shellcheck findings are expected).
- [ ] In `.github/workflows/release.yml`, insert a new job **immediately before** the `build-windows-msi:` job (line 254), with this exact content (job-level default `permissions: contents: read` from line 24–25 applies; deliberately NO `environment:`, NO secrets, NO `vars.ENABLE_WINDOWS_SIGNING` gate):

  ```yaml
    build-windows-unsigned:
      name: Build Windows Agent Binaries (unsigned)
      if: >-
        github.ref_type == 'tag'
        && startsWith(github.ref, 'refs/tags/v')
      runs-on: windows-latest
      needs: [build-agent]
      steps:
        - name: Checkout
          uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
          with:
            persist-credentials: false

        - name: Setup Go
          uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7
          with:
            go-version: ${{ env.GO_VERSION }}
            cache-dependency-path: agent/go.sum

        - name: Download Go dependencies
          working-directory: agent
          shell: pwsh
          run: go mod download

        - name: Get version from tag
          id: version
          shell: pwsh
          env:
            REF_NAME: ${{ github.ref_name }}
          run: |
            $version = $env:REF_NAME.Substring(1)
            "version=$version" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
  ```

- [ ] **Move** (cut from `build-windows-msi`, paste into `build-windows-unsigned` after the `Get version from tag` step, verbatim, unchanged) the step `Build Windows resources and binary` — currently lines 308–425 including its leading comments — and the step `Scan Windows binaries for plaintext threat signatures (#2797)` — currently lines 427–448 including its leading comment block. These carry the go-winres resource stamping, the four `go build`s into `dist\`, the #949 manifest guard, and the #2797 threat-signature scan; they run identically in the new job.
- [ ] Append to `build-windows-unsigned`, after the moved scan step, these exact staging + upload steps:

  ```yaml
        - name: Stage unsigned Windows exes (BYO signing inputs)
          shell: pwsh
          run: |
            $ErrorActionPreference = "Stop"
            New-Item -Path dist-unsigned -ItemType Directory -Force | Out-Null
            foreach ($component in @("agent", "backup", "watchdog", "user-helper")) {
              $src = "dist\breeze-$component-windows-amd64.exe"
              if (-not (Test-Path $src)) { throw "missing expected build output: $src" }
              Copy-Item $src "dist-unsigned\breeze-$component-windows-amd64-unsigned.exe"
            }

        - name: Upload unsigned agent EXE artifact
          uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
          with:
            name: breeze-agent-windows-amd64-unsigned
            path: dist-unsigned/breeze-agent-windows-amd64-unsigned.exe
            retention-days: 30

        - name: Upload unsigned backup EXE artifact
          uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
          with:
            name: breeze-backup-windows-amd64-unsigned
            path: dist-unsigned/breeze-backup-windows-amd64-unsigned.exe
            retention-days: 30

        - name: Upload unsigned watchdog EXE artifact
          uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
          with:
            name: breeze-watchdog-windows-amd64-unsigned
            path: dist-unsigned/breeze-watchdog-windows-amd64-unsigned.exe
            retention-days: 30

        - name: Upload unsigned user-helper EXE artifact
          uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
          with:
            name: breeze-user-helper-windows-amd64-unsigned
            path: dist-unsigned/breeze-user-helper-windows-amd64-unsigned.exe
            retention-days: 30
  ```

- [ ] Rewire `build-windows-msi` to consume the unsigned artifacts:
  - Change its `needs:` (currently `needs: [build-agent]`, line 261) to `needs: [build-agent, build-windows-unsigned]`.
  - Delete its `Setup Go` (273–277) and `Download Go dependencies` (279–282) steps (Go is no longer used in this job; `agent/installer/build-msi.ps1` is pure WiX — verified it contains no `go build`/`go-winres` calls).
  - In place of the two moved steps (after `Get version from tag`, before `Validate signing configuration` at current line 450), insert exactly:

  ```yaml
        - name: Download unsigned Windows exes (signing inputs)
          uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8
          with:
            pattern: 'breeze-*-windows-amd64-unsigned'
            path: dist-unsigned/
            merge-multiple: true

        # The published -unsigned assets are byte-identical to the files signed
        # below by construction: the signing job's inputs ARE the unsigned
        # artifacts (BYO signing, Deliverable 1).
        - name: Stage exes for signing
          shell: pwsh
          run: |
            $ErrorActionPreference = "Stop"
            New-Item -Path dist -ItemType Directory -Force | Out-Null
            foreach ($component in @("agent", "backup", "watchdog", "user-helper")) {
              $src = "dist-unsigned\breeze-$component-windows-amd64-unsigned.exe"
              if (-not (Test-Path $src)) { throw "missing unsigned input artifact: $src" }
              Copy-Item $src "dist\breeze-$component-windows-amd64.exe"
            }
  ```

  - Leave everything else in `build-windows-msi` untouched: the `vars.ENABLE_WINDOWS_SIGNING` job gate, the `signing-prerelease`/`signing-production` environment, `.NET`/WiX setup, `Validate signing configuration`, `Azure Login`, all eight per-exe sign steps (stable + prerelease variants — the unsigned capture is upstream of both, so one capture covers both variants), `Build MSI`, MSI signing, `Verify signatures`, and the signed-artifact uploads. All signing-step file paths (`dist\breeze-*-windows-amd64.exe`) are unchanged.
- [ ] Wire the new job into `release-integrity-gate`:
  - `needs` (line 1907): append `build-windows-unsigned` to the list.
  - Env block (after line 1916's `BUILD_WINDOWS_MSI_RESULT`): add `BUILD_WINDOWS_UNSIGNED_RESULT: ${{ needs.build-windows-unsigned.result }}`.
  - After `require_success "build-windows-msi" "$BUILD_WINDOWS_MSI_RESULT"` (line 1940): add `require_success "build-windows-unsigned" "$BUILD_WINDOWS_UNSIGNED_RESULT"`.
- [ ] Wire the new job into `create-release`:
  - `needs` (line 1957): append `build-windows-unsigned`.
  - `if` block: after the `needs.release-integrity-gate.result == 'success'` line (line 1965), add `&& needs.build-windows-unsigned.result == 'success'` (strict success — the job runs on every tag; `create-release` only runs on tags).
- [ ] Validate: `python3 -c 'import yaml; yaml.safe_load(open(".github/workflows/release.yml"))'` — expect no output, exit 0.
- [ ] Validate: `actionlint .github/workflows/release.yml > /tmp/actionlint-after.txt 2>&1 || true; diff /tmp/actionlint-baseline.txt /tmp/actionlint-after.txt` — expect only line-number shifts on pre-existing findings, no new rule IDs. (Line numbers WILL shift; compare finding content, not positions: `grep -o 'SC[0-9]*\|expression .*' /tmp/actionlint-baseline.txt | sort | uniq -c` vs the same for the after-file.)
- [ ] Validate: `bash scripts/security/check-supply-chain-hardening.sh` — expect exit 0.
- [ ] Assert the moved steps landed exactly once each: `grep -c 'Build Windows resources and binary' .github/workflows/release.yml` → `1`; `grep -c 'Scan Windows binaries for plaintext threat signatures' .github/workflows/release.yml` → `1`; `grep -c 'build-windows-unsigned' .github/workflows/release.yml` → expect `5` (job key, build-windows-msi needs, gate needs, gate env, create-release needs) plus `1` for the `require_success` line and `1` for the create-release `if` line = `7` total.
- [ ] Commit:

  ```bash
  git add .github/workflows/release.yml
  git commit -m "feat(release): build windows exes unconditionally and publish unsigned signing inputs

  Moves the resource-stamped Windows exe build (go-winres stamping, #949
  manifest guard, #2797 threat-signature scan) out of the
  ENABLE_WINDOWS_SIGNING-gated build-windows-msi job into a new
  build-windows-unsigned job that runs on every v* tag and uploads
  breeze-{agent,backup,watchdog,user-helper}-windows-amd64-unsigned.exe.
  build-windows-msi now downloads those artifacts as its signing inputs,
  so the published unsigned assets are byte-identical pre-sign inputs by
  construction, and unsigned publication no longer depends on the signing
  toggle. release-integrity-gate additionally requires the new job.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

### Task 2: Publish unsigned darwin binaries from `build-macos-agent` pre-sign

**Files:**
- Modify: `/Users/toddhebebrand/orca/workspaces/breeze/constrained-signed-installer/.github/workflows/release.yml` — `build-macos-agent` job (line 685 pre-Task-1; job runs on all tags, signing is step-gated on `vars.ENABLE_MACOS_SIGNING`): insert new steps between the last artifact download (`Download watchdog darwin/arm64 artifact`, lines 740–744) and `Import certificate into keychain` (line 746). Signing mutates `staging/` in place at `Sign binaries` (line 770), so capture MUST precede line 746.
- Test: same workflow validators as Task 1.

**Interfaces:**
- Consumes: the eight `breeze-{agent,backup,desktop-helper,watchdog}-darwin-{amd64,arm64}` artifacts already downloaded into `staging/` (lines 698–744). Note: on macOS these ARE the untouched `build-agent` matrix outputs — this job signs in place and never rebuilds, so the unsigned copies equal the matrix outputs (unlike Windows).
- Produces: four CI artifacts `breeze-{agent,backup,desktop-helper,watchdog}-darwin-unsigned`, each containing that component's two arch files named `breeze-<component>-darwin-{amd64,arm64}-unsigned`. Artifact names match the existing `create-release` download patterns (`breeze-agent-*`, `breeze-backup-*`, `breeze-desktop-helper-*`, `breeze-watchdog-*`, line 1989) and copy loops.

**Steps:**

- [ ] In `build-macos-agent`, insert after the `Download watchdog darwin/arm64 artifact` step and before `Import certificate into keychain`, with NO `if:` condition (must run whether or not `ENABLE_MACOS_SIGNING` is set — job-level gating already restricts to tags only):

  ```yaml
        # BYO signing (Deliverable 1): capture the exact pre-sign inputs. The
        # sign step below mutates staging/ in place, so this MUST run before
        # any codesign invocation. Deliberately not gated on
        # vars.ENABLE_MACOS_SIGNING — unsigned publication is independent of
        # the signing toggle.
        - name: Stage unsigned darwin binaries (BYO signing inputs)
          run: |
            set -euo pipefail
            mkdir -p staging-unsigned
            count=0
            for bin in staging/breeze-agent-darwin-amd64 staging/breeze-agent-darwin-arm64 \
                       staging/breeze-backup-darwin-amd64 staging/breeze-backup-darwin-arm64 \
                       staging/breeze-desktop-helper-darwin-amd64 staging/breeze-desktop-helper-darwin-arm64 \
                       staging/breeze-watchdog-darwin-amd64 staging/breeze-watchdog-darwin-arm64; do
              if [ ! -f "$bin" ]; then
                echo "::error::missing expected darwin binary for unsigned capture: $bin"
                exit 1
              fi
              cp "$bin" "staging-unsigned/$(basename "$bin")-unsigned"
              count=$((count + 1))
            done
            if [ "$count" -ne 8 ]; then
              echo "::error::expected 8 unsigned darwin binaries, staged $count"
              exit 1
            fi

        - name: Upload unsigned agent darwin binaries
          uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
          with:
            name: breeze-agent-darwin-unsigned
            path: staging-unsigned/breeze-agent-darwin-*-unsigned
            retention-days: 30

        - name: Upload unsigned backup darwin binaries
          uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
          with:
            name: breeze-backup-darwin-unsigned
            path: staging-unsigned/breeze-backup-darwin-*-unsigned
            retention-days: 30

        - name: Upload unsigned desktop-helper darwin binaries
          uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
          with:
            name: breeze-desktop-helper-darwin-unsigned
            path: staging-unsigned/breeze-desktop-helper-darwin-*-unsigned
            retention-days: 30

        - name: Upload unsigned watchdog darwin binaries
          uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
          with:
            name: breeze-watchdog-darwin-unsigned
            path: staging-unsigned/breeze-watchdog-darwin-*-unsigned
            retention-days: 30
  ```

- [ ] Confirm no glob interference: the later `Sign binaries` / `Notarize binaries` / verify loops iterate `staging/breeze-*-darwin-*` — the unsigned copies live in `staging-unsigned/`, outside those globs, so the signed path is untouched. Assert: `grep -n 'staging-unsigned' .github/workflows/release.yml` shows hits only inside the five new steps.
- [ ] Validate: `python3 -c 'import yaml; yaml.safe_load(open(".github/workflows/release.yml"))'` — exit 0.
- [ ] Validate: `actionlint .github/workflows/release.yml` — no new finding kinds vs `/tmp/actionlint-baseline.txt`.
- [ ] Validate: `bash scripts/security/check-supply-chain-hardening.sh` — exit 0 (the `ENABLE_MACOS_SIGNING must be true for tag releases` sentinel at current line 930 is untouched).
- [ ] Commit:

  ```bash
  git add .github/workflows/release.yml
  git commit -m "feat(release): publish unsigned darwin signing-input binaries pre-sign

  Captures the eight darwin agent/backup/desktop-helper/watchdog binaries
  into staging-unsigned/ with an explicit -unsigned suffix before any
  codesign mutation in build-macos-agent, and uploads them as four
  per-component artifacts. Not gated on ENABLE_MACOS_SIGNING. The signed
  path (sign/notarize/pkg/verify) is untouched.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

### Task 3: Manifest generator — `sourceCommit` + `signing-input` classification (unsigned rule before the extension branch)

**Files:**
- Modify: `/Users/toddhebebrand/orca/workspaces/breeze/constrained-signed-installer/.github/workflows/release.yml` — the inline Python generator inside the `Prepare release assets` step of `create-release` (pre-Task-1 lines: heredoc opens at 2065, `DARWIN_BINARY_RE` at 2084–2086, `platform_trust` at 2088–2099, asset loop at 2101–2110, manifest dict at 2112–2117).
- Test: local fixture run of the edited Python block + `jq` assertions (no unit runner for inline workflow Python).

**Interfaces:**
- Consumes: files in `release-assets/` (now including the 12 unsigned files copied in by the existing `breeze-agent-*`/`breeze-backup-*`/`breeze-desktop-helper-*`/`breeze-user-helper-*`/`breeze-watchdog-*` loops at lines 1997–2030), `GITHUB_REPOSITORY`, `GITHUB_REF_NAME`, and a new `SOURCE_COMMIT` env resolved from the checked-out workspace.
- Produces: `release-artifact-manifest.json` with top-level `sourceCommit` and, for `-unsigned` assets only, `platformTrust: "none"` + `intendedUse: "signing-input"`. The API parser (`apps/api/src/services/releaseArtifactManifest.ts:139-159`) validates only `schemaVersion`/`repository`/`release`/`assets` and passes unknown keys through — Task 5 proves this with tests.

**Steps:**

- [ ] In the `Prepare release assets` step, immediately before the `python3 <<'PY'` line (2065), insert these two shell lines (the job checked out the tag at line 1980–1983, so `HEAD` is the release commit; `^{commit}` peels annotated tags):

  ```bash
          SOURCE_COMMIT="$(git rev-parse 'HEAD^{commit}')"
          export SOURCE_COMMIT
  ```

- [ ] Inside the Python heredoc, insert after the `DARWIN_BINARY_RE` definition (currently ending line 2086) and replace the `platform_trust` function (2088–2099) so the block reads exactly (remember: heredoc content sits at the same YAML indent as the `python3` line — top-level Python code has no extra indent):

  ```python
          # BYO signing (Deliverable 1): unsigned build outputs published as
          # inputs for self-hosters to sign with their own certificates. The
          # -unsigned rule MUST be evaluated before the extension branches —
          # breeze-agent-windows-amd64-unsigned.exe would otherwise classify
          # as windows-authenticode-required.
          UNSIGNED_INPUT_RE = re.compile(
              r"^breeze-(agent|backup|watchdog|user-helper)-windows-amd64-unsigned\.exe$"
              r"|^breeze-(agent|backup|desktop-helper|watchdog)-darwin-(amd64|arm64)-unsigned$"
          )

          def is_signing_input(name):
              return UNSIGNED_INPUT_RE.match(name) is not None

          def platform_trust(name):
              if is_signing_input(name):
                  return "none"
              if name.endswith(".msi") or name.endswith(".exe"):
                  return "windows-authenticode-required"
              if (
                  name.endswith(".pkg")
                  or name.endswith(".app.zip")
                  or name.endswith(".dmg")
              ):
                  return "macos-developer-id-notarization-required"
              if DARWIN_BINARY_RE.match(name):
                  return "macos-developer-id-notarization-required"
              return "release-workflow-produced"
  ```

- [ ] Replace the asset loop body (currently 2101–2110) with:

  ```python
          assets = []
          for path in sorted(release_dir.iterdir(), key=lambda item: item.name):
              if not path.is_file() or path.name in excluded:
                  continue
              entry = {
                  "name": path.name,
                  "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                  "size": path.stat().st_size,
                  "platformTrust": platform_trust(path.name),
              }
              if is_signing_input(path.name):
                  entry["intendedUse"] = "signing-input"
              assets.append(entry)
  ```

- [ ] Replace the manifest dict (currently 2112–2117) with:

  ```python
          manifest = {
              "schemaVersion": 1,
              "repository": os.environ["GITHUB_REPOSITORY"],
              "release": os.environ["GITHUB_REF_NAME"],
              "sourceCommit": os.environ["SOURCE_COMMIT"],
              "assets": assets,
          }
  ```

  (`schemaVersion` stays `1`: the additions are backward-compatible optional fields; the API parser hard-requires `schemaVersion === 1` at `releaseArtifactManifest.ts:150`, so bumping it would break every deployed API.)
- [ ] Validate the edited block by running it against a local fixture. Extract the heredoc body into a temp file and run it exactly as CI would:

  ```bash
  work="$(mktemp -d)"
  mkdir -p "$work/release-assets"
  cd "$work"
  # signed-set representatives + unsigned representatives + a linux binary
  printf 'a' > "release-assets/breeze-agent-windows-amd64.exe"
  printf 'b' > "release-assets/breeze-agent-windows-amd64-unsigned.exe"
  printf 'c' > "release-assets/breeze-user-helper-windows-amd64-unsigned.exe"
  printf 'd' > "release-assets/breeze-agent.msi"
  printf 'e' > "release-assets/breeze-agent-darwin-amd64"
  printf 'f' > "release-assets/breeze-agent-darwin-amd64-unsigned"
  printf 'g' > "release-assets/breeze-desktop-helper-darwin-arm64-unsigned"
  printf 'h' > "release-assets/breeze-agent-linux-amd64"
  printf 'i' > "release-assets/Breeze Installer.app.zip"
  # extract the python between the heredoc markers of the Prepare step
  awk '/python3 <<.PY./{flag=1;next}/^          PY$/{flag=0}flag' \
    /Users/toddhebebrand/orca/workspaces/breeze/constrained-signed-installer/.github/workflows/release.yml \
    | sed 's/^          //' > gen.py
  GITHUB_REPOSITORY=LanternOps/breeze GITHUB_REF_NAME=v9.9.9 \
    SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567 \
    python3 gen.py
  ```

  Note: if the awk extraction matches more than one heredoc (`Verify signing-input manifest entries` from Task 4 also uses `<<'PY'` once that task lands — in THIS task there is exactly one), pin it by line range instead. Expect `gen.py` to run cleanly and write `release-assets/release-artifact-manifest.json`.
- [ ] Assert fixture output (all must exit 0):

  ```bash
  jq -e '.sourceCommit == "0123456789abcdef0123456789abcdef01234567"' release-assets/release-artifact-manifest.json
  jq -e '.schemaVersion == 1' release-assets/release-artifact-manifest.json
  jq -e '.assets[] | select(.name == "breeze-agent-windows-amd64-unsigned.exe") | (.platformTrust == "none" and .intendedUse == "signing-input")' release-assets/release-artifact-manifest.json
  jq -e '.assets[] | select(.name == "breeze-user-helper-windows-amd64-unsigned.exe") | (.platformTrust == "none" and .intendedUse == "signing-input")' release-assets/release-artifact-manifest.json
  jq -e '.assets[] | select(.name == "breeze-agent-darwin-amd64-unsigned") | (.platformTrust == "none" and .intendedUse == "signing-input")' release-assets/release-artifact-manifest.json
  jq -e '.assets[] | select(.name == "breeze-desktop-helper-darwin-arm64-unsigned") | (.platformTrust == "none" and .intendedUse == "signing-input")' release-assets/release-artifact-manifest.json
  jq -e '.assets[] | select(.name == "breeze-agent-windows-amd64.exe") | (.platformTrust == "windows-authenticode-required" and (has("intendedUse") | not))' release-assets/release-artifact-manifest.json
  jq -e '.assets[] | select(.name == "breeze-agent.msi") | .platformTrust == "windows-authenticode-required"' release-assets/release-artifact-manifest.json
  jq -e '.assets[] | select(.name == "breeze-agent-darwin-amd64") | .platformTrust == "macos-developer-id-notarization-required"' release-assets/release-artifact-manifest.json
  jq -e '.assets[] | select(.name == "Breeze Installer.app.zip") | .platformTrust == "macos-developer-id-notarization-required"' release-assets/release-artifact-manifest.json
  jq -e '.assets[] | select(.name == "breeze-agent-linux-amd64") | .platformTrust == "release-workflow-produced"' release-assets/release-artifact-manifest.json
  jq -e '[.assets[] | select(.intendedUse == "signing-input")] | length == 4' release-assets/release-artifact-manifest.json
  ```

- [ ] Validate the workflow file: `python3 -c 'import yaml; yaml.safe_load(open(".github/workflows/release.yml"))'` and `actionlint .github/workflows/release.yml` (no new finding kinds); `bash scripts/security/check-supply-chain-hardening.sh` — exit 0.
- [ ] Commit:

  ```bash
  git add .github/workflows/release.yml
  git commit -m "feat(release): manifest sourceCommit + signing-input classification for unsigned assets

  The release-artifact-manifest generator now records the peeled release
  commit (git rev-parse HEAD^{commit} — GITHUB_SHA can name the tag
  object for annotated tags) as top-level sourceCommit, and classifies
  the published -unsigned assets as platformTrust \"none\" with
  intendedUse \"signing-input\". The -unsigned rule runs before the
  .exe/.msi extension branch so unsigned Windows exes cannot classify as
  windows-authenticode-required. Signed-set classification is unchanged;
  schemaVersion stays 1 (additive optional fields).

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

### Task 4: Workflow-level manifest assertions + keep the binaries-init image signed-only

**Files:**
- Modify: `/Users/toddhebebrand/orca/workspaces/breeze/constrained-signed-installer/.github/workflows/release.yml`
  - `create-release`: insert a new step between `Prepare release assets` (heredoc `PY` terminator, pre-Task line 2121) and `Sign release artifact manifest` (pre-Task line 2123) — assertions must fail BEFORE the manifest signature is produced.
  - `build-binaries-image`: insert a step between `Download helper artifacts` (pre-Task lines 2343–2348) and `Write VERSION file` (pre-Task lines 2350–2353). Its download patterns (`breeze-agent-*` etc., lines 2329–2348) now match the unsigned artifacts, which would otherwise bloat the GHCR `binaries` image; the API's local scan would ignore them (`binarySync.ts:96-99` anchors `^breeze-agent-(os)-(arch)(\.exe)?$`, so `-unsigned` names never register), but shipping unusable bytes in the image and the `/target` volume is pure waste.
- Test: workflow validators; the checksum/integrity machinery needs NO change — `Generate release checksums` (`sha256sum *`, pre-Task lines 2222–2225) and `Verify release asset integrity requirements` (dynamic `find` over `release-assets/`, pre-Task lines 2227–2277) automatically include the unsigned files.

**Interfaces:**
- Consumes: `release-assets/release-artifact-manifest.json` from Task 3; the checked-out workspace for `git rev-parse`.
- Produces: a hard release-blocking assertion that (a) `sourceCommit` is present, 40-hex, and equals the checked-out commit; (b) exactly the 12 expected `-unsigned` assets exist, each `platformTrust: "none"` + `intendedUse: "signing-input"`; (c) no other asset carries `-unsigned` or `intendedUse` or `platformTrust: "none"`; (d) signed-set spot checks for every trust class are unchanged. This is the "assert manifest gains sourceCommit + intendedUse entries with correct classification order; assert the integrity gate still passes" requirement from the spec's Testing section.

**Steps:**

- [ ] Insert into `create-release`, immediately after the `Prepare release assets` step and before `Sign release artifact manifest`:

  ```yaml
        # BYO signing (Deliverable 1) non-regression: the manifest must gain
        # sourceCommit and exactly the expected signing-input entries, and the
        # signed set's platform-trust classification must be unchanged. Runs
        # before the manifest is signed so a violation blocks the release.
        - name: Verify signing-input manifest entries
          if: startsWith(github.ref, 'refs/tags/')
          run: |
            set -euo pipefail
            SOURCE_COMMIT="$(git rev-parse 'HEAD^{commit}')"
            export SOURCE_COMMIT
            python3 <<'PY'
            import json
            import os
            import re

            with open("release-assets/release-artifact-manifest.json") as fh:
                manifest = json.load(fh)

            source_commit = manifest.get("sourceCommit")
            assert isinstance(source_commit, str) and re.fullmatch(r"[0-9a-f]{40}", source_commit), \
                f"sourceCommit missing or malformed: {source_commit!r}"
            assert source_commit == os.environ["SOURCE_COMMIT"], \
                f"sourceCommit {source_commit} != checked-out commit {os.environ['SOURCE_COMMIT']}"

            EXPECTED_UNSIGNED = {
                "breeze-agent-windows-amd64-unsigned.exe",
                "breeze-backup-windows-amd64-unsigned.exe",
                "breeze-watchdog-windows-amd64-unsigned.exe",
                "breeze-user-helper-windows-amd64-unsigned.exe",
                "breeze-agent-darwin-amd64-unsigned",
                "breeze-agent-darwin-arm64-unsigned",
                "breeze-backup-darwin-amd64-unsigned",
                "breeze-backup-darwin-arm64-unsigned",
                "breeze-desktop-helper-darwin-amd64-unsigned",
                "breeze-desktop-helper-darwin-arm64-unsigned",
                "breeze-watchdog-darwin-amd64-unsigned",
                "breeze-watchdog-darwin-arm64-unsigned",
            }
            by_name = {a["name"]: a for a in manifest["assets"]}
            missing = EXPECTED_UNSIGNED - set(by_name)
            assert not missing, f"missing unsigned signing-input assets: {sorted(missing)}"
            for name in sorted(EXPECTED_UNSIGNED):
                entry = by_name[name]
                assert entry.get("platformTrust") == "none", \
                    f"{name}: platformTrust {entry.get('platformTrust')!r} != 'none'"
                assert entry.get("intendedUse") == "signing-input", \
                    f"{name}: intendedUse {entry.get('intendedUse')!r} != 'signing-input'"
            for name, entry in by_name.items():
                if name in EXPECTED_UNSIGNED:
                    continue
                assert "-unsigned" not in name, \
                    f"unexpected -unsigned asset outside the expected set: {name}"
                assert "intendedUse" not in entry, \
                    f"{name}: signed-set asset must not carry intendedUse"
                assert entry.get("platformTrust") != "none", \
                    f"{name}: signed-set asset must not have platformTrust 'none'"
            # Signed-set spot checks, one per trust class (classification-order
            # non-regression for the extension branches).
            assert by_name["breeze-agent.msi"]["platformTrust"] == "windows-authenticode-required"
            assert by_name["breeze-agent-windows-amd64.exe"]["platformTrust"] == "windows-authenticode-required"
            assert by_name["breeze-agent-darwin-arm64"]["platformTrust"] == "macos-developer-id-notarization-required"
            assert by_name["breeze-agent-linux-amd64"]["platformTrust"] == "release-workflow-produced"
            print(f"OK: {len(EXPECTED_UNSIGNED)} signing-input assets verified; sourceCommit={source_commit}")
            PY
  ```

  (Indentation note: the heredoc body must sit at the same YAML indent as the `python3` line, exactly like the existing generator block — the Python then sees flush-left top-level code.)
- [ ] Insert into `build-binaries-image`, after `Download helper artifacts` and before `Write VERSION file`:

  ```yaml
        # BYO signing (Deliverable 1): -unsigned signing inputs are published
        # release assets only. Keep them out of the binaries-init image — the
        # API's local scanner would ignore them (parseBinaryFilename anchors on
        # breeze-<component>-<os>-<arch>[.exe]) but they'd bloat the image and
        # the /target volume for nothing.
        - name: Drop unsigned signing-input files from image staging
          run: |
            set -euo pipefail
            find staging -type f -name '*-unsigned*' -print -delete
  ```

- [ ] Validate: `python3 -c 'import yaml; yaml.safe_load(open(".github/workflows/release.yml"))'`; `actionlint .github/workflows/release.yml` (no new finding kinds); `bash scripts/security/check-supply-chain-hardening.sh` — all clean.
- [ ] Sanity-run the assertion block itself against the Task 3 fixture manifest to prove the Python is syntactically sound: from the Task 3 `$work` dir, extract JUST this new heredoc into `verify.py` (by line range via `sed -n 'START,ENDp'` on the workflow file, then `sed 's/^            //'` to strip the YAML indent), edit nothing, and run `SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567 python3 verify.py` — expected outcome: **AssertionError naming the 8 missing unsigned assets** (the fixture deliberately contains only 4 of the 12 expected names). That failure IS the pass criterion here: it proves the file parses and the assertions execute in order (sourceCommit check passed, missing-set check fired).
- [ ] Commit:

  ```bash
  git add .github/workflows/release.yml
  git commit -m "feat(release): assert signing-input manifest entries; keep binaries image signed-only

  Adds a release-blocking verification step (before the manifest is
  signed) that sourceCommit matches the checked-out commit and that
  exactly the 12 expected -unsigned assets carry platformTrust none +
  intendedUse signing-input while the signed set's classification is
  unchanged. Also strips -unsigned files from build-binaries-image
  staging so the GHCR binaries-init image ships only servable binaries.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

### Task 5: API manifest-parser tolerance — typed optional fields + unit tests

**Files:**
- Modify: `/Users/toddhebebrand/orca/workspaces/breeze/constrained-signed-installer/apps/api/src/services/releaseArtifactManifest.ts` — `ReleaseArtifactManifestAsset` type (lines 16–21), `ReleaseArtifactManifest` type (lines 23–28). The parser is hand-rolled and tolerant: `parseManifest` (139–159) checks only `schemaVersion === 1`, `repository`/`release` strings, `assets` array; extra JSON keys pass through untouched, and `expectedPlatformTrust` enforcement (281–288) is opt-in per call. NO behavioral change is needed — this task pins the tolerance with types and regression tests so Deliverable 3 can't silently break it.
- Test: `/Users/toddhebebrand/orca/workspaces/breeze/constrained-signed-installer/apps/api/src/services/releaseArtifactManifest.test.ts` (co-located; currently 267 lines, closes with `});` at line 267).

**Interfaces:**
- Consumes: manifests produced by Task 3 (top-level `sourceCommit`, per-asset `intendedUse`, `platformTrust: "none"`).
- Produces: unit-test proof that (a) such manifests verify successfully with `platformTrust: "none"` surfaced in the result, and (b) a caller passing `expectedPlatformTrust: "windows-authenticode-required"` is REJECTED for a `"none"` entry (the existing mismatch check at `releaseArtifactManifest.ts:281-288` — the fail-closed seam Deliverable 3c builds on). `VerifiedReleaseArtifact` deliberately does NOT gain `intendedUse` here; surfacing it is Deliverable 3c scope.

**Steps:**

- [ ] Add the two new tests to `releaseArtifactManifest.test.ts`, inserted immediately before the final `});` (line 267). These are characterization tests: they are **expected to pass on the first run** because the parser is already tolerant — if either fails, the parser is NOT tolerant and the failure output defines exactly what to fix in `parseManifest`/`selectManifestAsset` before proceeding.

  ```ts
    it("tolerates sourceCommit and intendedUse manifest fields (BYO signing inputs)", async () => {
      // Deliverable 1 of the self-host BYO-signing design adds a top-level
      // sourceCommit and per-asset intendedUse/platformTrust:"none" for
      // -unsigned signing-input assets. The parser is deliberately tolerant
      // of unknown fields; this pins that contract so older APIs keep
      // verifying newer manifests.
      const asset = Buffer.from("unsigned-signing-input");
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicDer = publicKey.export({
        format: "der",
        type: "spki",
      }) as Buffer;
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = publicDer
        .subarray(publicDer.length - 32)
        .toString("base64");
      const manifest = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          repository: "lanternops/breeze",
          release: "v1.2.3",
          sourceCommit: "0123456789abcdef0123456789abcdef01234567",
          assets: [
            {
              name: "breeze-agent-windows-amd64-unsigned.exe",
              sha256: createSha256(asset),
              size: asset.length,
              platformTrust: "none",
              intendedUse: "signing-input",
            },
          ],
        }),
      );
      const signature = Buffer.from(
        sign(null, manifest, privateKey).toString("base64"),
      );

      await expect(
        verifyReleaseArtifactBuffer({
          assetName: "breeze-agent-windows-amd64-unsigned.exe",
          assetBuffer: asset,
          manifestBytes: manifest,
          signatureBytes: signature,
          expectedRepository: "lanternops/breeze",
          expectedRelease: "v1.2.3",
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          assetName: "breeze-agent-windows-amd64-unsigned.exe",
          platformTrust: "none",
        }),
      );
    });

    it("rejects a signing-input entry when the caller expects authenticode trust", async () => {
      // The expectedPlatformTrust mismatch check is the fail-closed seam that
      // Deliverable 3c's positive allowlist builds on: an -unsigned entry
      // (platformTrust "none") must never satisfy a caller that demands
      // windows-authenticode-required.
      const asset = Buffer.from("unsigned-signing-input");
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicDer = publicKey.export({
        format: "der",
        type: "spki",
      }) as Buffer;
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = publicDer
        .subarray(publicDer.length - 32)
        .toString("base64");
      const manifest = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          repository: "lanternops/breeze",
          release: "v1.2.3",
          sourceCommit: "0123456789abcdef0123456789abcdef01234567",
          assets: [
            {
              name: "breeze-agent-windows-amd64-unsigned.exe",
              sha256: createSha256(asset),
              size: asset.length,
              platformTrust: "none",
              intendedUse: "signing-input",
            },
          ],
        }),
      );
      const signature = Buffer.from(
        sign(null, manifest, privateKey).toString("base64"),
      );

      await expect(
        verifyReleaseArtifactBuffer({
          assetName: "breeze-agent-windows-amd64-unsigned.exe",
          assetBuffer: asset,
          manifestBytes: manifest,
          signatureBytes: signature,
          expectedRepository: "lanternops/breeze",
          expectedPlatformTrust: "windows-authenticode-required",
        }),
      ).rejects.toThrow("platform trust mismatch");
    });
  ```

  (`generateKeyPairSync`, `sign`, and `createSha256` are already imported/defined in this file — lines 1 and 43–45.)
- [ ] Run the suite: `pnpm --filter @breeze/api test -- src/services/releaseArtifactManifest.test.ts` — expect all tests green, including the two new ones. If the tolerance test fails, fix `parseManifest` to ignore unknown keys (it should not need it) and re-run until green.
- [ ] In `releaseArtifactManifest.ts`, document the fields in the structural types (no runtime effect — the fields are already passed through — this makes the contract visible to Deliverable 3 work). Change lines 16–21 to:

  ```ts
  type ReleaseArtifactManifestAsset = {
    name?: unknown;
    sha256?: unknown;
    size?: unknown;
    platformTrust?: unknown;
    // BYO signing (Deliverable 1): "signing-input" marks published unsigned
    // build outputs. Tolerated here; positive rejection at registration/serve
    // time is Deliverable 3c.
    intendedUse?: unknown;
  };
  ```

  and lines 23–28 to:

  ```ts
  type ReleaseArtifactManifest = {
    schemaVersion?: unknown;
    repository?: unknown;
    release?: unknown;
    // BYO signing (Deliverable 1): the release's peeled source commit SHA,
    // recorded so downstream signing workflows can pin their checkout.
    sourceCommit?: unknown;
    assets?: unknown;
  };
  ```

- [ ] Re-run: `pnpm --filter @breeze/api test -- src/services/releaseArtifactManifest.test.ts` — green. Then typecheck the package build path used by CI: `pnpm --filter @breeze/api build` (or the repo's turbo typecheck if faster) — no errors.
- [ ] Note (no action): editing `releaseArtifactManifest.ts` puts this PR in the path filters of `.github/workflows/ci-smoke-binary-source-github.yml` (lines 22–30), so the github-mode smoke will run on the PR against the pinned published release `0.65.8` — its manifest lacks the new optional fields, which is exactly the backward-compat case; it must stay green with zero changes to the smoke workflow.
- [ ] Commit:

  ```bash
  git add apps/api/src/services/releaseArtifactManifest.ts apps/api/src/services/releaseArtifactManifest.test.ts
  git commit -m "test(api): pin release-manifest tolerance for sourceCommit/intendedUse fields

  The hand-rolled manifest parser already passes unknown fields through;
  these characterization tests pin that contract for the BYO-signing
  manifest additions (top-level sourceCommit, per-asset intendedUse +
  platformTrust none) and prove expectedPlatformTrust still fails closed
  against signing-input entries. Types document the new optional fields.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

### Task 6: Final verification sweep

**Files:**
- Test only — no new edits expected. Touches nothing unless a check fails.

**Interfaces:**
- Consumes: the four commits from Tasks 1–5.
- Produces: verified branch ready for PR.

**Steps:**

- [ ] Full-file YAML parse: `python3 -c 'import yaml; yaml.safe_load(open(".github/workflows/release.yml"))'` — exit 0.
- [ ] `actionlint .github/workflows/release.yml` — compare finding kinds against `/tmp/actionlint-baseline.txt`; no new rule violations.
- [ ] `bash scripts/security/check-supply-chain-hardening.sh` — exit 0.
- [ ] Structural greps against the final workflow (each must match):
  - `grep -n 'build-windows-unsigned:' .github/workflows/release.yml` — job exists.
  - `grep -n "needs: \[build-agent, build-windows-unsigned\]" .github/workflows/release.yml` — signing job rewired.
  - `grep -c 'unsigned' .github/workflows/release.yml` — sanity: dozens of hits, all inside the Task 1/2/3/4 additions (`git diff main -- .github/workflows/release.yml | grep '^+.*unsigned' | wc -l` matches the grep count delta).
  - `grep -n 'sourceCommit' .github/workflows/release.yml` — generator + assertion step (2 regions).
  - `grep -n "intendedUse" .github/workflows/release.yml` — generator + assertion step.
- [ ] API tests: `pnpm --filter @breeze/api test -- src/services/releaseArtifactManifest.test.ts` — green.
- [ ] Re-run the Task 3 fixture end-to-end once more from a clean `mktemp -d` (guards against edits from Task 4 having disturbed the generator heredoc; pin the awk extraction to the FIRST `<<'PY'` heredoc or use a line range, since the assertion step added a second one).
- [ ] Review the diff as a whole: `git diff main --stat` — expected files: `.github/workflows/release.yml`, `apps/api/src/services/releaseArtifactManifest.ts`, `apps/api/src/services/releaseArtifactManifest.test.ts`, plus this plan doc if committed. Nothing else.
- [ ] Confirm out-of-scope items were NOT touched (they belong to later deliverables): no changes to `binarySync.ts`, `binarySource.ts`, `msiSigning.ts`, config schema, compose files, smoke workflows, or any migration.
- [ ] If any step above required a fix, commit it:

  ```bash
  git add -A
  git commit -m "chore(release): fixups from BYO-signing phase-1 verification sweep

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

## Out of scope (later deliverables / rollout steps — do NOT do these here)

- Creating releases with signing disabled: `release-integrity-gate` still hard-requires `build-windows-msi`, `build-macos-agent`, etc. on tags, and the macOS `Verify macOS signatures and notarization` step (lines 926–932) still fails closed when `ENABLE_MACOS_SIGNING != 'true'`. This plan only makes the unsigned *capture* independent of the signing vars; flipping the gate is rollout step 4 of the spec, after the hosted-distribution decision.
- Rejecting `intendedUse: "signing-input"` assets at registration/serve time (Deliverable 3c), deployment re-signing (3b), unified release source (3a), template repo (D2), guide (D4), `msiSigning.ts` cleanup (D5).
- Surfacing `intendedUse` in `VerifiedReleaseArtifact` — deferred to 3c where it gets an enforcing consumer.

## Verified current-state facts this plan relies on

- `build-windows-msi` is job-gated on `vars.ENABLE_WINDOWS_SIGNING` (lines 256–259) and rebuilds resource-stamped exes itself (step at 308–425); the generic `build-agent` matrix Windows exe is NOT the signing input.
- `build-macos-agent` runs on all tags (job `if` at 687–689 has no signing var); `ENABLE_MACOS_SIGNING` gates individual steps; signing mutates `staging/` in place (line 770 onward) — so pre-sign capture must precede line 746. Its pre-sign inputs are the untouched `build-agent` matrix outputs.
- Manifest generator: `platform_trust` at lines 2088–2099 classifies every `.exe`/`.msi` as `windows-authenticode-required` — hence the mandatory rule ordering.
- `create-release` artifact download pattern (line 1989) and copy loops (1997–2030) already match the new artifact names; `sha256sum *` checksums (2222–2225) and the dynamic integrity verification (2227–2277) automatically include unsigned files.
- `releaseArtifactManifest.ts` is NOT zod and NOT strict — unknown fields flow through (`parseManifest`, 139–159).
- Neither smoke workflow (`ci-smoke-binary-source-{github,local}.yml`) asserts manifest shape; the github one exercises a pinned published release (`0.65.8`) and is unaffected.
- `binarySync.ts` github-mode sync targets exact asset names (`AGENT_TARGETS` etc., lines 25–61) and local mode's `parseBinaryFilename` (91–107) is anchored — `-unsigned` names are never registered by the API in either mode.
- `agent/installer/build-msi.ps1` contains no Go usage — `build-windows-msi` can drop its Go toolchain steps.
