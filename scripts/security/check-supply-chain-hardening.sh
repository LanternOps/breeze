#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_grep() {
  local pattern="$1"
  local file="$2"
  local message="$3"
  if ! grep -Eq -- "$pattern" "$file"; then
    fail "$message"
  fi
}

reject_grep() {
  local pattern="$1"
  local file="$2"
  local message="$3"
  if grep -Eq -- "$pattern" "$file"; then
    fail "$message"
  fi
}

if [[ -e docker-compose.override.yml ]]; then
  fail "docker-compose.override.yml must not exist; Docker Compose auto-loads it and can weaken production defaults"
fi

require_grep '^  release-integrity-gate:' .github/workflows/release.yml \
  "release workflow must include release-integrity-gate"
require_grep 'needs: .*release-integrity-gate' .github/workflows/release.yml \
  "create-release must depend on release-integrity-gate"
require_grep 'ENABLE_MACOS_SIGNING must be true for tag releases' .github/workflows/release.yml \
  "macOS tag releases must fail when signing is disabled"
require_grep 'Required signed/notarized release asset missing or empty' .github/workflows/release.yml \
  "release workflow must verify required signed/notarized assets"
require_grep 'release-artifact-manifest\.json' .github/workflows/release.yml \
  "release workflow must generate a release artifact manifest"
require_grep 'release-artifact-manifest\.json\.minisig' .github/workflows/release.yml \
  "tag releases must publish a detached release artifact manifest signature"
require_grep 'release-artifact-manifest\.json\.ed25519' .github/workflows/release.yml \
  "tag releases must publish a Node-verifiable release artifact manifest signature"
require_grep 'RELEASE_MANIFEST_MINISIGN_PRIVATE_KEY' .github/workflows/release.yml \
  "tag releases must require a dedicated release manifest signing key"
require_grep 'RELEASE_MANIFEST_MINISIGN_PUBLIC_KEY' .github/workflows/release.yml \
  "tag releases must verify the release manifest with the configured public key"
require_grep 'RELEASE_MANIFEST_ED25519_PRIVATE_KEY' .github/workflows/release.yml \
  "tag releases must require a dedicated Ed25519 release manifest signing key"
require_grep 'RELEASE_MANIFEST_ED25519_PUBLIC_KEY' .github/workflows/release.yml \
  "tag releases must verify the Ed25519 release manifest signature before publishing"
require_grep 'minisign -S' .github/workflows/release.yml \
  "release workflow must sign the release artifact manifest"
require_grep 'minisign -V' .github/workflows/release.yml \
  "release workflow must verify the release artifact manifest signature before publishing"
require_grep 'releaseArtifactManifest' apps/api/src/services/installerBuilder.ts \
  "installer fallback fetches must use API-side release artifact manifest verification"
require_grep 'RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS' apps/api/src/services/releaseArtifactManifest.ts \
  "API release artifact verification must pin an Ed25519 public-key trust root"
require_grep 'verifySignature' apps/api/src/services/releaseArtifactManifest.ts \
  "API release artifact verification must verify Ed25519 signatures in Node"
require_grep 'public key is required for GitHub fallback asset verification in production' apps/api/src/services/releaseArtifactManifest.ts \
  "API release artifact verification must fail closed in production without a public-key trust root"
require_grep 'RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS must be set in production when BINARY_SOURCE=github' apps/api/src/config/validate.ts \
  "production config validation must require a release artifact public key for GitHub fallback binaries"

require_grep 'VERSION_METADATA_URL=' apps/api/src/routes/agents/download.ts \
  "generated Linux installer must fetch version metadata"
require_grep 'verify_sha256.*TMPFILE.*EXPECTED_SHA256' apps/api/src/routes/agents/download.ts \
  "generated Linux installer must verify downloaded binary checksum"
require_grep 'Refusing to install without a trusted checksum' apps/api/src/routes/agents/download.ts \
  "generated Linux installer must fail closed without checksum metadata"

require_grep 'checksums\.txt' agent/cmd/breeze-agent/watchdog_bootstrap.go \
  "watchdog bootstrap must fetch release checksums.txt"
require_grep 'verifyFileSHA256' agent/cmd/breeze-agent/watchdog_bootstrap.go \
  "watchdog bootstrap must verify SHA-256 before install"
require_grep 'checksum mismatch' agent/cmd/breeze-agent/watchdog_bootstrap_test.go \
  "watchdog bootstrap tests must cover checksum mismatch"

require_grep '"packageManager": "pnpm@9\.15\.7"' package.json \
  "package.json must pin pnpm to an audit-endpoint-compatible version"
require_grep "PNPM_VERSION: '9\.15\.7'" .github/workflows/security.yml \
  "security workflow must use pnpm 9.15.7+ for blocking audit"
require_grep '^  security-audit:' .github/workflows/ci.yml \
  "CI must include a blocking security-audit job"
require_grep 'SECURITY_AUDIT_RESULT' .github/workflows/ci.yml \
  "ci-success must depend on the security-audit job"
reject_grep 'continue-on-error:[[:space:]]*true' .github/workflows/security.yml \
  "security workflow must not make dependency audits advisory-only"
reject_grep 'Login response:' .github/workflows/ci.yml \
  "CI smoke tests must not print full login responses"
require_grep '::add-mask::\$\{TOKEN\}' .github/workflows/ci.yml \
  "CI smoke tests must mask login tokens before writing outputs"

require_grep 'permissions:' .github/workflows/secret-scan.yml \
  "secret scan workflow must declare explicit permissions"
require_grep 'contents:[[:space:]]*read' .github/workflows/secret-scan.yml \
  "secret scan workflow must only need contents: read"
require_grep 'checksums="gitleaks_\$\{version\}_checksums\.txt"' .github/workflows/secret-scan.yml \
  "Gitleaks install must verify the release checksum file before installing"
require_grep 'sha256sum -c -' .github/workflows/secret-scan.yml \
  "Gitleaks install must verify the downloaded tarball checksum"
reject_grep 'curl .*\|[[:space:]]*sudo tar' .github/workflows/secret-scan.yml \
  "Gitleaks install must not pipe remote tarballs directly into sudo tar"

require_grep 'cargo-audit:' .github/workflows/security.yml \
  "security workflow must run cargo audit for Tauri dependencies"
require_grep 'directory: "/apps/helper/src-tauri"' .github/dependabot.yml \
  "Dependabot must cover helper Cargo dependencies"
require_grep 'directory: "/apps/viewer/src-tauri"' .github/dependabot.yml \
  "Dependabot must cover viewer Cargo dependencies"
require_grep 'directory: "/apps/api"' .github/dependabot.yml \
  "Dependabot must cover API Dockerfiles before digest pinning can be maintained"
require_grep 'directory: "/apps/web"' .github/dependabot.yml \
  "Dependabot must cover Web Dockerfiles before digest pinning can be maintained"
require_grep 'directory: "/docker"' .github/dependabot.yml \
  "Dependabot must cover release/security Dockerfiles before digest pinning can be maintained"
require_grep 'language: \[javascript-typescript, go\]' .github/workflows/codeql.yml \
  "CodeQL must analyze both TypeScript and Go"

require_grep "severity: 'HIGH,CRITICAL'" .github/workflows/security.yml \
  "Trivy must fail on HIGH and CRITICAL vulnerabilities"
require_grep '^  trivy-image-scan:' .github/workflows/security.yml \
  "security workflow must scan built Docker images"
require_grep "format: 'sarif'" .github/workflows/security.yml \
  "Trivy filesystem scan must emit SARIF"
require_grep "format: 'cyclonedx'" .github/workflows/security.yml \
  "Trivy filesystem scan must emit an SBOM"

require_grep '^\.env\*' .dockerignore \
  ".dockerignore must exclude root env files from Docker build context"
require_grep '^\*\*/\.env\*' .dockerignore \
  ".dockerignore must exclude nested env files from Docker build context"
require_grep '^\*\.env' .dockerignore \
  ".dockerignore must exclude non-dot env files from Docker build context"
require_grep '^\*\*/\*\.env' .dockerignore \
  ".dockerignore must exclude nested non-dot env files from Docker build context"
require_grep '^!\*\*/\.env\.\*\.example' .dockerignore \
  ".dockerignore must explicitly allow nested env example templates"
require_grep '^BREEZE_API_IMAGE_DIGEST=sha256:' deploy/.env.example \
  "deploy env example must require digest-pinned API image digests"
require_grep '^BREEZE_WEB_IMAGE_DIGEST=sha256:' deploy/.env.example \
  "deploy env example must require digest-pinned Web image digests"
require_grep '^BREEZE_BINARIES_IMAGE_DIGEST=sha256:' deploy/.env.example \
  "deploy env example must require digest-pinned binaries image digests"
for image_ref_var in CADDY_IMAGE_REF CLOUDFLARED_IMAGE_REF REDIS_IMAGE_REF COTURN_IMAGE_REF BILLING_IMAGE_REF; do
  require_grep "^${image_ref_var}=.*@sha256:" deploy/.env.example \
    "deploy env example must digest-pin ${image_ref_var}"
done

for compose in docker-compose.yml deploy/docker-compose.prod.yml; do
  reject_grep 'image:[[:space:]].*:latest([[:space:]]|$)' "$compose" \
    "$compose must not use :latest image refs"
  reject_grep 'image:[[:space:]].*:local([[:space:]]|$)' "$compose" \
    "$compose must not use mutable local image refs"
  reject_grep '^[[:space:]]*build:' "$compose" \
    "$compose must not build images during production deploys"
  reject_grep 'BREEZE_VERSION:-latest' "$compose" \
    "$compose must not default BREEZE_VERSION to latest"
  reject_grep '/var/run/docker\.sock' "$compose" \
    "$compose must not mount the raw Docker socket"
  reject_grep 'watchtower' "$compose" \
    "$compose must not include Watchtower by default"
  reject_grep '--requirepass[[:space:]]+\$\{?REDIS_PASSWORD' "$compose" \
    "$compose must not expose REDIS_PASSWORD in redis-server command args"
  reject_grep 'REDISCLI_AUTH' "$compose" \
    "$compose must not expose Redis auth through healthcheck process environment"
  reject_grep 'redis-cli.*([[:space:]]-a[[:space:]]|[[:space:]]--pass([=[:space:]]|$))' "$compose" \
    "$compose must not expose Redis auth through redis-cli command args"
  reject_grep 'redis-cli.*REDIS_PASSWORD' "$compose" \
    "$compose must not expose REDIS_PASSWORD in Redis healthcheck args"
  reject_grep 'REDIS_URL:[[:space:]]+redis://:\$\{REDIS_PASSWORD' "$compose" \
    "$compose must not expose REDIS_PASSWORD in API container env"
  require_grep '/run/secrets/redis_password' "$compose" \
    "$compose must feed Redis auth through a mounted secret"
  require_grep 'AUTH %s' "$compose" \
    "$compose Redis healthcheck must feed AUTH through stdin instead of args or environment"
  require_grep 'REDIS_PASSWORD_FILE:[[:space:]]+/run/secrets/redis_password' "$compose" \
    "$compose must pass Redis auth to the API through REDIS_PASSWORD_FILE"
  require_grep 'ENROLLMENT_KEY_PEPPER:[[:space:]]+\$\{ENROLLMENT_KEY_PEPPER:\?Set ENROLLMENT_KEY_PEPPER' "$compose" \
    "$compose must require ENROLLMENT_KEY_PEPPER for production API startup"
  require_grep 'MFA_RECOVERY_CODE_PEPPER:[[:space:]]+\$\{MFA_RECOVERY_CODE_PEPPER:\?Set MFA_RECOVERY_CODE_PEPPER' "$compose" \
    "$compose must require MFA_RECOVERY_CODE_PEPPER for production API startup"
done
reject_grep '/var/run/docker\.sock' docker-compose.monitoring.yml \
  "monitoring compose must not mount the raw Docker socket"
reject_grep 'docker_sd_configs' monitoring/promtail.yml \
  "Promtail must not use Docker socket service discovery"
require_grep '/var/lib/docker/containers' docker-compose.monitoring.yml \
  "monitoring compose must mount Docker JSON log files read-only for Promtail"
require_grep '/var/lib/docker/containers/\*/\*\.log' monitoring/promtail.yml \
  "Promtail must scrape Docker JSON log files without the Docker socket"
require_grep 'COMPOSE_FILE="\$\{REPO_ROOT\}/deploy/docker-compose\.prod\.yml"' scripts/prod/deploy.sh \
  "production deploy script must use the production compose file"
require_grep 'require_digest_ref BILLING_IMAGE_REF' scripts/prod/deploy.sh \
  "production deploy script must validate digest-pinned billing image refs"

for override in docker-compose.override.yml.ghcr docker-compose.override.yml.local-build; do
  reject_grep 'DEV_PUSH_ENABLED' "$override" \
    "$override must not enable dev push in GHCR/local-build deploy modes"
  reject_grep '^[[:space:]]+ports:' "$override" \
    "$override must not publish internal service ports in GHCR/local-build deploy modes"
  reject_grep 'MCP_BOOTSTRAP_TEST_MODE' "$override" \
    "$override must not carry MCP test-mode flags in GHCR/local-build deploy modes"
  reject_grep 'NODE_ENV:[[:space:]]+\$\{NODE_ENV' "$override" \
    "$override must not allow env-file NODE_ENV to override production runtime mode"
  reject_grep 'PUBLIC_API_URL:[[:space:]].*localhost' "$override" \
    "$override must not default service URLs to localhost in deploy modes"
  require_grep 'ENROLLMENT_KEY_PEPPER:[[:space:]]+\$\{ENROLLMENT_KEY_PEPPER:\?Set ENROLLMENT_KEY_PEPPER' "$override" \
    "$override must not weaken production ENROLLMENT_KEY_PEPPER requirements"
  require_grep 'MFA_RECOVERY_CODE_PEPPER:[[:space:]]+\$\{MFA_RECOVERY_CODE_PEPPER:\?Set MFA_RECOVERY_CODE_PEPPER' "$override" \
    "$override must not weaken production MFA_RECOVERY_CODE_PEPPER requirements"
done
reject_grep 'ENABLE_REGISTRATION:[[:space:]]+\$\{ENABLE_REGISTRATION:-true\}' docker-compose.override.yml.ghcr \
  "GHCR override must not default API registration on"
reject_grep 'PUBLIC_ENABLE_REGISTRATION:[[:space:]]+\$\{PUBLIC_ENABLE_REGISTRATION:-true\}' docker-compose.override.yml.ghcr \
  "GHCR override must not default public registration UI on"

reject_grep 'REDISCLI_AUTH' scripts/prod/deploy.sh \
  "production deploy script must not expose Redis auth through process environment"
require_grep 'AUTH %s' scripts/prod/deploy.sh \
  "production deploy script must feed Redis AUTH through stdin"

for dockerfile in apps/api/Dockerfile apps/web/Dockerfile docker/Dockerfile.api docker/Dockerfile.web; do
  require_grep '^FROM[[:space:]]+node:22-alpine@sha256:[0-9a-f]{64}[[:space:]]+AS[[:space:]]+base' "$dockerfile" \
    "$dockerfile must digest-pin the Node base image while retaining the tag for Dependabot refreshes"
  reject_grep '^FROM[[:space:]]+node:[^[:space:]@]+([[:space:]]|$)' "$dockerfile" \
    "$dockerfile must not use tag-only Node base image references"
done
for dockerfile in apps/api/Dockerfile apps/web/Dockerfile; do
  require_grep '^FROM[[:space:]]+node:22-alpine@sha256:[0-9a-f]{64}[[:space:]]+AS[[:space:]]+runner' "$dockerfile" \
    "$dockerfile must digest-pin the production Node runner image while retaining the tag for Dependabot refreshes"
done

require_grep '/run/secrets/metrics_scrape_token' monitoring/prometheus.yml \
  "Prometheus config must read metrics scrape token from a secret file"
require_grep 'metrics_scrape_token:' docker-compose.monitoring.yml \
  "monitoring compose must define the metrics scrape token secret"
require_grep 'environment: METRICS_SCRAPE_TOKEN' docker-compose.monitoring.yml \
  "monitoring compose must source metrics scrape token from the environment"

require_grep 'envFlag..ENABLE_REGISTRATION., false' apps/api/src/routes/system.ts \
  "system config status must default registration to disabled"
require_grep "envFlag\\('ENABLE_REGISTRATION', false\\)" apps/api/src/routes/auth/schemas.ts \
  "API registration must default to disabled"
require_grep 'PUBLIC_ENABLE_REGISTRATION=false' .env.example \
  "root env example must default public registration UI off"
require_grep 'ENABLE_REGISTRATION=false' deploy/.env.example \
  "deploy env example must default API registration off"

require_grep 'not\.toContain.*AGENT_BINARY_DIR' apps/api/src/routes/agents/download.test.ts \
  "agent public 404 tests must assert AGENT_BINARY_DIR is not disclosed"
require_grep 'not\.toContain.*VIEWER_BINARY_DIR' apps/api/src/routes/viewers/download.test.ts \
  "viewer public 404 tests must assert VIEWER_BINARY_DIR is not disclosed"

echo "Supply-chain hardening checks passed."
