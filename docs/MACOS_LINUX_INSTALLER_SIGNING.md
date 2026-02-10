# macOS & Linux Agent Packaging and Signing

See also: `docs/ARTIFACT_SIGNING_OPERATIONS.md` for official Breeze signing vs independent fork/self-host signing responsibilities.

## Current State

Raw agent binaries are built in CI and released for `darwin` and `linux` architectures.

Current install path relies on shell scripts and service definitions already in the repo:
- macOS install script: `agent/scripts/install/install-darwin.sh`
- Linux install script: `agent/scripts/install/install-linux.sh`
- macOS launchd files: `agent/service/launchd/com.breeze.agent.plist`, `agent/service/launchd/com.breeze.agent-user.plist`
- Linux systemd/XDG files: `agent/service/systemd/breeze-agent.service`, `agent/service/systemd/breeze-agent-user.service`, `agent/service/xdg/breeze-agent-user.desktop`

## Do We Need Installer/Signing Work?

| Platform | Requirement Level | Why |
|---|---|---|
| **macOS** | **Yes (strongly recommended / effectively required for production)** | Unsigned or unnotarized binaries/packages trigger Gatekeeper friction and poor MDM rollout UX. |
| **Linux** | **Recommended (not OS-enforced)** | Linux allows unsigned binaries, but enterprise deployment and trust are much better with signed DEB/RPM packages and signed repos. |

## macOS Plan

### 1. Apple Signing + Notarization Prerequisites

- Apple Developer account with Team ID
- **Developer ID Application** certificate (for signing binaries)
- **Developer ID Installer** certificate (for signing `.pkg`)
- Notary credentials configured for `notarytool` (API key or keychain profile)

### 2. Installer Format

Use a signed and notarized `.pkg` as the primary enterprise artifact.

Install targets should match existing scripts:
- Binary: `/usr/local/bin/breeze-agent`
- Config/data: `/Library/Application Support/Breeze`
- Logs: `/Library/Logs/Breeze`
- Daemon plist: `/Library/LaunchDaemons/com.breeze.agent.plist`
- User helper plist: `/Library/LaunchAgents/com.breeze.agent-user.plist`

### 3. Build + Sign + Notarize Sequence (Baseline)

```bash
# from repo root
mkdir -p dist/macos-root/usr/local/bin
mkdir -p dist/macos-root/Library/LaunchDaemons
mkdir -p dist/macos-root/Library/LaunchAgents

# build binary
cd agent
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build \
  -ldflags="-s -w -X main.version=${BUILD_VERSION}" \
  -o ../dist/macos-root/usr/local/bin/breeze-agent ./cmd/breeze-agent
cd ..

# copy service definitions
cp agent/service/launchd/com.breeze.agent.plist dist/macos-root/Library/LaunchDaemons/
cp agent/service/launchd/com.breeze.agent-user.plist dist/macos-root/Library/LaunchAgents/

# sign binary
codesign --force --timestamp --options runtime \
  --sign "Developer ID Application: <ORG> (<TEAM_ID>)" \
  dist/macos-root/usr/local/bin/breeze-agent

# build unsigned pkg
pkgbuild \
  --root dist/macos-root \
  --identifier com.breeze.agent \
  --version "${BUILD_VERSION}" \
  --install-location / \
  dist/breeze-agent-unsigned.pkg

# sign pkg
productsign \
  --sign "Developer ID Installer: <ORG> (<TEAM_ID>)" \
  dist/breeze-agent-unsigned.pkg \
  dist/breeze-agent.pkg

# notarize + staple
xcrun notarytool submit dist/breeze-agent.pkg --keychain-profile "AC_NOTARY" --wait
xcrun stapler staple dist/breeze-agent.pkg

# local verification
spctl --assess --type install --verbose dist/breeze-agent.pkg
pkgutil --check-signature dist/breeze-agent.pkg
```

### 4. Enrollment Integration (macOS)

macOS packages do not have MSI-style public properties for easy per-install key injection.

Recommended models:
- **MDM/scripted enrollment (preferred):** install package, then run `breeze-agent enroll` using org-managed secret delivery.
- **Root-only enrollment file:** write enrollment values to `/Library/Application Support/Breeze/enrollment.env` (`0600`), consume once in postinstall helper logic, then delete.

Avoid exposing enrollment secrets in installer logs or persistent command histories.

### 5. CI/CD Notes (macOS)

- Signing/notarization should run on a macOS GitHub runner.
- Build/sign each architecture artifact you ship.
- Upload notarized `.pkg` plus checksums to releases.

## Linux Plan

### 1. Package Format

Recommended release outputs:
- `.deb` for Debian/Ubuntu
- `.rpm` for RHEL/CentOS/Fedora
- Optional `.tar.gz` fallback for advanced/manual installs

Install targets should match existing scripts:
- Binary: `/usr/local/bin/breeze-agent`
- Config: `/etc/breeze`
- Data: `/var/lib/breeze`
- Logs: `/var/log/breeze`
- Systemd unit: `/etc/systemd/system/breeze-agent.service`
- User helper: `/usr/lib/systemd/user/breeze-agent-user.service`
- XDG fallback: `/etc/xdg/autostart/breeze-agent-user.desktop`

### 2. Signing Model

Linux does not enforce code signing at execution time, but enterprise trust should include:
- Package signing (`dpkg-sig` for `.deb`, `rpmsign` for `.rpm`)
- Repository metadata signing (APT `Release.gpg`/`InRelease`, YUM/DNF repo metadata)
- Optional signature for raw archives (`cosign` or `minisign`)

### 3. Build + Package Sequence (Baseline)

Use `nfpm` (recommended for reproducible DEB/RPM generation) with config committed in repo.

```bash
# from repo root
mkdir -p dist

cd agent
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build \
  -ldflags="-s -w -X main.version=${BUILD_VERSION}" \
  -o ../dist/breeze-agent-linux-amd64 ./cmd/breeze-agent
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build \
  -ldflags="-s -w -X main.version=${BUILD_VERSION}" \
  -o ../dist/breeze-agent-linux-arm64 ./cmd/breeze-agent
cd ..

# package (example; config files created in agent/packaging/linux)
nfpm package --packager deb --target dist/breeze-agent_${BUILD_VERSION}_amd64.deb --config agent/packaging/linux/nfpm-amd64.yaml
nfpm package --packager rpm --target dist/breeze-agent-${BUILD_VERSION}.x86_64.rpm --config agent/packaging/linux/nfpm-amd64.yaml

# sign packages (example)
dpkg-sig --sign builder dist/breeze-agent_${BUILD_VERSION}_amd64.deb
rpmsign --addsign dist/breeze-agent-${BUILD_VERSION}.x86_64.rpm
```

### 4. Enrollment Integration (Linux)

Recommended models:
- **Scripted enrollment (preferred):** install package, then run `breeze-agent enroll <KEY> --server <URL>` through your deployment tool.
- **One-shot systemd enrollment unit:** deployment tool writes root-only environment file, one-shot unit enrolls once and removes the secret file.

As with macOS, avoid writing enrollment keys to world-readable files or verbose logs.

### 5. CI/CD Notes (Linux)

- Build/package/sign Linux artifacts on `ubuntu-latest`.
- Store GPG private key material in CI secrets and import at job runtime.
- Publish signed packages and checksums; if hosting repos, publish signed metadata.

## Files to Create

| File | Purpose |
|---|---|
| `agent/packaging/macos/scripts/preinstall` | macOS package preinstall checks/setup |
| `agent/packaging/macos/scripts/postinstall` | macOS package postinstall (permissions/service load hooks) |
| `agent/packaging/linux/nfpm-amd64.yaml` | Linux package manifest for amd64 |
| `agent/packaging/linux/nfpm-arm64.yaml` | Linux package manifest for arm64 |
| `.github/workflows/release.yml` | Add macOS notarization + Linux package/signing jobs |

## Acceptance Checks (Required Before Release)

### macOS

```bash
# install
sudo installer -pkg breeze-agent.pkg -target /

# verify signing/notarization
spctl --assess --type install --verbose breeze-agent.pkg
pkgutil --check-signature breeze-agent.pkg

# verify service presence
sudo launchctl list | grep com.breeze.agent

# uninstall check (via script)
sudo bash agent/scripts/install/uninstall-darwin.sh
```

Expected outcomes:
- Package installs without Gatekeeper block on a clean machine.
- LaunchDaemon is loadable and agent starts.
- Uninstall removes binary + daemon plist and preserves config intentionally.

### Linux

```bash
# deb path
sudo dpkg -i breeze-agent_<VERSION>_amd64.deb
systemctl status breeze-agent --no-pager

# rpm path
sudo rpm -Uvh breeze-agent-<VERSION>.x86_64.rpm
systemctl status breeze-agent --no-pager

# uninstall examples
sudo dpkg -r breeze-agent || true
sudo rpm -e breeze-agent || true
```

Expected outcomes:
- Install succeeds and `breeze-agent` service is enabled/runnable.
- Upgrade preserves config and replaces binaries/service definitions cleanly.
- Uninstall removes package-managed files and preserves intentional config/data where specified.

## Phased Approach

### Phase 1: Improve Existing Binary Distribution
1. Keep current raw binaries + checksums.
2. Add signing where practical (macOS binary signing first).

### Phase 2: Enterprise-Ready Packaging
3. Produce notarized macOS `.pkg`.
4. Produce signed Linux `.deb` and `.rpm`.
5. Update release workflow to publish these artifacts.

### Phase 3: Deployment UX Improvements
6. Add deployment-tool-friendly enrollment handoff (no secret leakage in logs).
7. Optionally publish signed APT/YUM repositories for one-command fleet rollout.
