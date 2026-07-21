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

extract_yaml_job() {
  local job="$1"
  local workflow="$2"
  local output="$3"
  awk -v header="  ${job}:" '
    $0 == header { in_job = 1 }
    in_job && /^  [[:alnum:]_-]+:/ && $0 != header { exit }
    in_job { print }
  ' "$workflow" > "$output"
  [[ -s "$output" ]] || fail "$workflow must define the $job job"
}

require_order() {
  local first_pattern="$1"
  local second_pattern="$2"
  local file="$3"
  local message="$4"
  local first_line second_line
  first_line="$(grep -nEm1 -- "$first_pattern" "$file" | cut -d: -f1 || true)"
  second_line="$(grep -nEm1 -- "$second_pattern" "$file" | cut -d: -f1 || true)"
  if [[ -z "$first_line" || -z "$second_line" || "$first_line" -ge "$second_line" ]]; then
    fail "$message"
  fi
}

GUARD_TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$GUARD_TMP_DIR"' EXIT

if [[ -e docker-compose.override.yml ]]; then
  fail "docker-compose.override.yml must not exist; Docker Compose auto-loads it and can weaken production defaults"
fi

# SR-007: workflows that build/publish artifacts must declare a top-level
# (workflow-global) least-privilege `permissions:` block so build jobs don't
# inherit the repo/org default GITHUB_TOKEN scopes. Jobs needing more (release
# publish, GHCR push, OIDC signing) override per-job. A column-0 `permissions:`
# is the workflow-global one; per-job blocks are indented.
require_grep '^permissions:' .github/workflows/release.yml \
  "release workflow must declare a top-level least-privilege permissions: block (SR-007)"
require_grep '^permissions:' .github/workflows/ci.yml \
  "CI workflow must declare a top-level least-privilege permissions: block (SR-007)"

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
require_grep 'RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS must be set in production for both BINARY_SOURCE=github' apps/api/src/config/validate.ts \
  "production config validation must require a release artifact public key for both BINARY_SOURCE=github and BINARY_SOURCE=local"

require_grep 'VERSION_METADATA_URL=' apps/api/src/routes/agents/download.ts \
  "generated Linux installer must fetch version metadata"
require_grep 'verify_sha256.*TMPFILE.*EXPECTED_SHA256' apps/api/src/routes/agents/download.ts \
  "generated Linux installer must verify downloaded binary checksum"
require_grep 'Refusing to install without a trusted checksum' apps/api/src/routes/agents/download.ts \
  "generated Linux installer must fail closed without checksum metadata"

require_grep 'checksums\.txt' agent/internal/agentapp/watchdog_bootstrap.go \
  "watchdog bootstrap must fetch release checksums.txt"
require_grep 'verifyFileSHA256' agent/internal/agentapp/watchdog_bootstrap.go \
  "watchdog bootstrap must verify SHA-256 before install"
require_grep 'checksum mismatch' agent/internal/agentapp/watchdog_bootstrap_test.go \
  "watchdog bootstrap tests must cover checksum mismatch"

require_grep '"packageManager": "pnpm@10\.34\.5"' package.json \
  "package.json must pin pnpm to a reproducible version"
require_grep "PNPM_VERSION: '10\.34\.5'" .github/workflows/security.yml \
  "security workflow must pin PNPM_VERSION to 10.34.5"
# Defense-in-depth: every site that installs pnpm must pin the same version
# as the packageManager field, so a single uncoordinated bump can't sneak in.
require_grep "PNPM_VERSION: '10\.34\.5'" .github/workflows/ci.yml \
  "CI workflow must pin PNPM_VERSION to 10.34.5"
require_grep "PNPM_VERSION: '10\.34\.5'" .github/workflows/release.yml \
  "release workflow must pin PNPM_VERSION to 10.34.5"
for dockerfile in apps/api/Dockerfile apps/web/Dockerfile docker/Dockerfile.api docker/Dockerfile.web; do
  require_grep 'npm install -g pnpm@10\.34\.5' "$dockerfile" \
    "$dockerfile must pin pnpm to 10.34.5"
done

# The customer-Graph-read credential boundary ships as a separately built
# executor. Keep its image, CI/release coverage, and deployment boundary from
# silently disappearing while the feature remains dark by default.
EXECUTOR_DOCKERFILE=apps/m365-graph-read-executor/Dockerfile
[[ -f "$EXECUTOR_DOCKERFILE" ]] || fail "$EXECUTOR_DOCKERFILE must package the isolated Graph-read executor"
require_grep '^FROM[[:space:]]+node:24-alpine@sha256:[0-9a-f]{64}[[:space:]]+AS[[:space:]]+build' "$EXECUTOR_DOCKERFILE" \
  "executor build stage must digest-pin Node while retaining the tag"
require_grep '^FROM[[:space:]]+node:24-alpine@sha256:[0-9a-f]{64}[[:space:]]+AS[[:space:]]+runner' "$EXECUTOR_DOCKERFILE" \
  "executor runtime stage must digest-pin Node while retaining the tag"
require_grep '^USER[[:space:]]+node$' "$EXECUTOR_DOCKERFILE" \
  "executor runtime must run as the non-root node user"
require_grep '^HEALTHCHECK .*\/healthz' "$EXECUTOR_DOCKERFILE" \
  "executor image must declare its bounded health endpoint"
require_grep '^CMD[[:space:]]+\["node",[[:space:]]*"dist/index\.cjs"\]' "$EXECUTOR_DOCKERFILE" \
  "executor image must start only its compiled bounded runtime"
reject_grep '^RUN[[:space:]].*apk[[:space:]]+(upgrade|add)' "$EXECUTOR_DOCKERFILE" \
  "executor runtime must not resolve mutable Alpine packages during the image build"
reject_grep '^(COPY|ADD)[[:space:]].*(\.env|\.pem|\.key|secret)' "$EXECUTOR_DOCKERFILE" \
  "executor image must not copy env, certificate, key, or secret files"
reject_grep '^COPY[[:space:]]+\.[[:space:]]+\.' "$EXECUTOR_DOCKERFILE" \
  "executor image must use an explicit deterministic build context allowlist"
require_grep 'directory: "/apps/m365-graph-read-executor"' .github/dependabot.yml \
  "Dependabot must maintain the executor Dockerfile's digest-pinned base image"

ci_success_block="$GUARD_TMP_DIR/ci-success.yml"
extract_yaml_job ci-success .github/workflows/ci.yml "$ci_success_block"
require_grep 'needs: .*test-m365-graph-read-executor' "$ci_success_block" \
  "ci-success must depend on executor tests"
require_grep 'needs: .*build-m365-graph-read-executor' "$ci_success_block" \
  "ci-success must depend on the executor build"
require_grep 'TEST_M365_GRAPH_READ_EXECUTOR_RESULT:.*needs\.test-m365-graph-read-executor\.result' "$ci_success_block" \
  "ci-success must read the executor test result"
require_grep 'BUILD_M365_GRAPH_READ_EXECUTOR_RESULT:.*needs\.build-m365-graph-read-executor\.result' "$ci_success_block" \
  "ci-success must read the executor build result"
require_grep '\[\[ "\$\{TEST_M365_GRAPH_READ_EXECUTOR_RESULT\}" != "success" \]\]' "$ci_success_block" \
  "ci-success must fail unless executor tests succeed"
require_grep '\[\[ "\$\{BUILD_M365_GRAPH_READ_EXECUTOR_RESULT\}" != "success" \]\]' "$ci_success_block" \
  "ci-success must fail unless the executor build succeeds"

security_audit_block="$GUARD_TMP_DIR/security-audit.yml"
extract_yaml_job security-audit .github/workflows/ci.yml "$security_audit_block"
require_grep 'run: bash scripts/security/check-m365-graph-read-runtime\.sh' "$security_audit_block" \
  "blocking CI must run the real Compose signing-secret runtime smoke"

executor_release_block="$GUARD_TMP_DIR/executor-release.yml"
extract_yaml_job build-docker-m365-graph-read-executor .github/workflows/release.yml "$executor_release_block"
require_grep 'executor-image-digest:.*steps\.push-executor-digest\.outputs\.digest' "$executor_release_block" \
  "release must expose the exact untagged executor build digest"
require_grep 'outputs: type=image,name=.*m365-graph-read-executor,push-by-digest=true,name-canonical=true,push=true' "$executor_release_block" \
  "release must push an unadvertised executor digest before tagging"
require_grep 'image-ref:.*m365-graph-read-executor@\$\{\{ steps\.push-executor-digest\.outputs\.digest \}\}' "$executor_release_block" \
  "release Trivy scan must target the exact pushed executor digest"
require_grep "severity: 'HIGH,CRITICAL'" "$executor_release_block" \
  "release executor scan must block HIGH and CRITICAL findings"
require_grep "exit-code: '1'" "$executor_release_block" \
  "release executor scan must be blocking"
require_grep 'docker buildx imagetools create' "$executor_release_block" \
  "release must promote the scanned executor digest without rebuilding"
require_grep '--tag "\$\{EXECUTOR_REPOSITORY\}:\$\{VERSION\}"' "$executor_release_block" \
  "release must publish the exact semver executor tag"
require_grep '--tag "\$\{EXECUTOR_REPOSITORY\}:sha-\$\{SHORT_SHA\}"' "$executor_release_block" \
  "release must publish the executor commit-SHA tag"
[[ "$(grep -o -- '--tag' "$executor_release_block" | wc -l | tr -d ' ')" == 2 ]] || \
  fail "executor release must publish only exact semver and commit-SHA tags"
reject_grep 'type=raw,value=latest|pattern=\{\{major\}\}|pattern=\{\{major\}\}\.\{\{minor\}\}' "$executor_release_block" \
  "executor release must not publish latest, major, or minor mutable tags"
[[ "$(grep -c 'docker/build-push-action@' "$executor_release_block")" == 1 ]] || \
  fail "executor release must build the image exactly once"
require_order 'id: push-executor-digest' 'name: Scan exact executor digest' "$executor_release_block" \
  "executor release must build before scanning"
require_order 'name: Scan exact executor digest' 'name: Promote scanned executor digest' "$executor_release_block" \
  "executor release promotion must occur only after its exact digest passes scanning"
require_order 'name: Promote scanned executor digest' 'name: Upload executor digest' "$executor_release_block" \
  "executor digest artifact must describe the promoted image"
require_grep 'breeze-m365-graph-read-executor:security-scan' .github/workflows/security.yml \
  "security workflow must build and scan the executor image"
[[ -x scripts/security/check-m365-graph-read-runtime.sh ]] || \
  fail "scripts/security/check-m365-graph-read-runtime.sh must be executable"

for compose in docker-compose.yml deploy/docker-compose.prod.yml; do
  reject_grep '^  m365-graph-read-executor:' "$compose" \
    "$compose must not deploy the executor without an identity-capable private environment"
  require_grep 'M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED:[[:space:]]+\$\{M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED:-false\}' "$compose" \
    "$compose must keep customer Graph-read onboarding disabled by default"
  require_grep 'M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE:[[:space:]]+/run/secrets/m365_graph_read_executor_signing_private_jwk' "$compose" \
    "$compose must load the API executor-signing private JWK from a Docker secret"
  require_grep '^  m365_graph_read_executor_signing_private_jwk:' "$compose" \
    "$compose must define the API executor-signing private-JWK secret"

  api_block="$GUARD_TMP_DIR/$(basename "$compose").api.yml"
  awk '
    /^  api:/ { in_api = 1 }
    in_api && /^  [[:alnum:]_-]+:/ && $0 !~ /^  api:/ { exit }
    in_api { print }
  ' "$compose" > "$api_block"
  require_grep '^[[:space:]]+-[[:space:]]+no-new-privileges:true' "$api_block" \
    "$compose API service must set no-new-privileges"
  require_grep '^[[:space:]]+-[[:space:]]+ALL' "$api_block" \
    "$compose API service must drop all Linux capabilities"
  require_grep '^[[:space:]]+-[[:space:]]+/tmp:size=64m,mode=1777' "$api_block" \
    "$compose API service must use a bounded tmpfs"
  reject_grep '^[[:space:]]+(uid|gid|mode):' "$api_block" \
    "$compose must not claim Docker Compose applies uid/gid/mode to file-backed secrets"
done

for deployment_template in .env.example deploy/.env.example; do
  require_grep '--read-only' "$deployment_template" \
    "$deployment_template must document the executor read-only filesystem requirement"
  require_grep '--cap-drop=ALL' "$deployment_template" \
    "$deployment_template must document dropping all executor capabilities"
  require_grep '--security-opt=no-new-privileges' "$deployment_template" \
    "$deployment_template must document executor no-new-privileges"
  require_grep '--tmpfs /tmp:rw,noexec,nosuid,size=64m' "$deployment_template" \
    "$deployment_template must document the executor tmpfs requirement"
  require_grep 'm365-graph-read-executor@sha256:<digest>' "$deployment_template" \
    "$deployment_template must require a digest-addressed executor image"
  require_grep 'numeric owner 1001:1001 and mode 0400' "$deployment_template" \
    "$deployment_template must document standalone Compose file-secret ownership requirements"
done
require_grep '^  security-audit:' .github/workflows/ci.yml \
  "CI must include a blocking security-audit job"
require_grep 'SECURITY_AUDIT_RESULT' .github/workflows/ci.yml \
  "ci-success must depend on the security-audit job"
reject_grep 'continue-on-error:[[:space:]]*true' .github/workflows/security.yml \
  "security workflow must not make dependency audits advisory-only"

# The dependency audit runs on osv-scanner (npm retired the audit endpoints that
# `pnpm audit` calls, so it fails closed at every pnpm version). Both audit sites
# must keep invoking the real gate, and the scanner binary must stay pinned and
# checksum-verified before install.
for audit_workflow in .github/workflows/ci.yml .github/workflows/security.yml; do
  require_grep 'scripts/security/check-npm-audit\.sh' "$audit_workflow" \
    "$audit_workflow must run the blocking dependency audit gate"
  require_grep 'scripts/security/install-osv-scanner\.sh' "$audit_workflow" \
    "$audit_workflow must install osv-scanner via the checksum-verified installer"
done
require_grep 'OSV_SCANNER_VERSION:-[0-9]+\.[0-9]+\.[0-9]+' scripts/security/install-osv-scanner.sh \
  "osv-scanner install must pin an explicit version"
require_grep 'sha256sum -c -' scripts/security/install-osv-scanner.sh \
  "osv-scanner install must verify the downloaded binary checksum"
reject_grep 'curl .*\|[[:space:]]*(sudo )?(tar|sh|bash)' scripts/security/install-osv-scanner.sh \
  "osv-scanner install must not pipe remote payloads into a shell or archiver"
require_grep 'produced no parseable report' scripts/security/check-npm-audit.sh \
  "dependency audit must fail closed when osv-scanner produces no report"
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
  # Defense-in-depth: even without the Watchtower service present, an
  # auto-update opt-in label on a tracked compose file would re-introduce
  # the supply-chain risk the broader rule above forbids (#603).
  reject_grep 'com\.centurylinklabs\.watchtower\.enable[[:space:]]*[:=][[:space:]]*"?(true|1|yes)"?' "$compose" \
    "$compose must not declare Watchtower auto-update opt-in labels (com.centurylinklabs.watchtower.enable=true) on any service"
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
# Registration is now gated by a single runtime flag (ENABLE_REGISTRATION),
# read by the UI from /api/v1/config — the build-time PUBLIC_ENABLE_REGISTRATION
# was removed (#1308), so there is no separate UI flag to guard.

reject_grep 'REDISCLI_AUTH' scripts/prod/deploy.sh \
  "production deploy script must not expose Redis auth through process environment"
require_grep 'AUTH %s' scripts/prod/deploy.sh \
  "production deploy script must feed Redis AUTH through stdin"

for dockerfile in apps/api/Dockerfile apps/web/Dockerfile docker/Dockerfile.api docker/Dockerfile.web; do
  require_grep '^FROM[[:space:]]+node:24-alpine@sha256:[0-9a-f]{64}[[:space:]]+AS[[:space:]]+base' "$dockerfile" \
    "$dockerfile must digest-pin the Node base image while retaining the tag for Dependabot refreshes"
  reject_grep '^FROM[[:space:]]+node:[^[:space:]@]+([[:space:]]|$)' "$dockerfile" \
    "$dockerfile must not use tag-only Node base image references"
done
for dockerfile in apps/api/Dockerfile apps/web/Dockerfile; do
  require_grep '^FROM[[:space:]]+node:24-alpine@sha256:[0-9a-f]{64}[[:space:]]+AS[[:space:]]+runner' "$dockerfile" \
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
require_grep "envFlag\\('ENABLE_REGISTRATION', false\\)" apps/api/src/routes/config.ts \
  "public /config must default the registration UI flag to disabled"
require_grep 'ENABLE_REGISTRATION=false' .env.example \
  "root env example must default registration off"
require_grep 'ENABLE_REGISTRATION=false' deploy/.env.example \
  "deploy env example must default API registration off"

require_grep 'not\.toContain.*AGENT_BINARY_DIR' apps/api/src/routes/agents/download.test.ts \
  "agent public 404 tests must assert AGENT_BINARY_DIR is not disclosed"
require_grep 'not\.toContain.*VIEWER_BINARY_DIR' apps/api/src/routes/viewers/download.test.ts \
  "viewer public 404 tests must assert VIEWER_BINARY_DIR is not disclosed"

echo "Supply-chain hardening checks passed."
