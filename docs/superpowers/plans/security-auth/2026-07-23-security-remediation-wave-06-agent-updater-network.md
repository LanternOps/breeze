# Security Remediation Wave 06: Agent Updater and Network Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-directed versions, signed manifests, outbound downloads, and local log files fail safely under hostile control-plane input, DNS changes, redirects, proxy environment variables, key substitution, and filesystem links.

**Architecture:** One Go SemVer package decides main-agent, helper, and watchdog updates. One agent-side HTTP transport revalidates every URL and dial-time address for both updater and managed-software downloads. Organization/site policy supplies the only approved private software origins, while the configured control-plane origin is an explicit private-network exception. Manifest verification becomes key-ID exact, then gains a signed monotonic delegation protocol before rotation is unfrozen. Unix log opening/rotation moves behind no-follow platform helpers; Windows behavior remains unchanged.

**Tech Stack:** Go 1.25, `golang.org/x/mod/semver`, `golang.org/x/sys/unix`, Hono, TypeScript, Drizzle ORM, PostgreSQL, Zod, Vitest.

**Implementation Branch:** `fix/security-review-agent-network`

## Global Constraints

- Begin development after Wave 05's compatibility interfaces are merged; development may proceed while Wave 05 collects audit-mode evidence, but fleet promotion waits for the Wave 05 compatibility decision.
- Start the execution branch from freshly fetched `origin/main`. Preserve #1105's enrollment post-transaction warranty boundary: delegation lookup may perform database work, but no new network or queue call belongs inside `withSystemDbAccessContext`. Preserve heartbeat's watchdog restart-log dedupe exports and tests, and reset its module-global cache in every affected test setup.
- Use test-driven changes and `go test -race`. Updater, heartbeat, config, logging, and remote tools ship to customer machines and require the full high-rigor gate.
- Malformed server target versions always fail closed. Only the main agent with current version exactly `dev` receives the documented development compatibility exception.
- Do not add a highest-ever-version watermark. Normal automatic downgrade remains blocked; recovery uses a higher-version forward fix or the explicit operator recovery path.
- Agent dial-time enforcement is authoritative. API literal checks and origin allowlists are defense in depth, not a substitute.
- Universally unsafe destinations are never allowlisted: loopback, link-local, unspecified, multicast, and metadata endpoints.
- The configured `server_url` and `backup_server_url` may be private. Private managed-software sources require an exact organization/site origin allowlist.
- Security-sensitive download clients ignore `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`. This release does not silently send authenticated updater traffic through an environment-selected proxy.
- Never log bearer headers, signed manifests, signatures, public-key material, proxy credentials, resolved private addresses, or download URLs containing capability query strings.
- Existing agents and servers must interoperate during rollout. Private software downloads remain disabled for agents that have not advertised network-policy capability version 1.
- Manifest rotation remains frozen until exact-ID handling and signed delegation are deployed and fleet adoption is proven.
- Apply one independent review round. Rerun the full agent race suite when review changes version precedence, URL/address classification, manifest trust, filesystem opening, or config persistence.

## Approved Deviations

Ruled before execution, 2026-07-28. These override the task text they name.

**D1 — the managed-software capability gate ships behind a mode env var (Tasks 5 and 9).**
As written, Task 5 denies *every* managed-software command to a device reporting
`outboundNetworkPolicyVersion = 0`, including a plainly public download URL. The API ships
before the fleet upgrades, so on deploy day every software deployment to a not-yet-updated
agent fails — the same fleet-outage shape Waves 3, 4, and 5 each avoided with a mode variable.
Ship the gate behind `MANAGED_SOFTWARE_POLICY_MODE`:

- `compat` (**default**): a private-origin destination still requires capability ≥ 1 and fails
  closed exactly as Task 5 specifies — that is the security fix, and it is on from the first
  deploy. An apparently-public destination remains permitted to a capability-0 device.
- `enforce`: Task 5's original behavior — every managed-software command requires capability ≥ 1,
  public destinations included.

The capability-0-public-hostname-that-pivots-private case Task 5 calls out is *not* excused by
`compat`: the agent-side dial-time policy (Task 2) is the authoritative defense there and ships
in the same wave. `compat` accepts that a capability-0 agent keeps its current, pre-Wave-06
exposure on public URLs until the operator flips `enforce` — it never grants a capability-0
agent something it could not already do. Task 9 owns the variable (validate.ts, `.env.example`,
both compose files, runbook rows, and a canary-ring row for the `compat → enforce` flip);
Task 5 owns the gate itself and must test both modes; Task 10's regression list gains a
compat-mode case.

**D2 — partner-wide ownership of the download policy is deferred (Task 4).**
Task 4 persists `softwareDownloadPolicy` on organization and site settings only, which sits
against the repository's partner-wide-first principle for config surfaces. Accepted as written
for this wave: the policy lives in existing settings JSONB rather than a new table, so the
partner-ownership migration playbook does not literally apply, and widening ownership mid-wave
would grow an already-large security branch. A follow-up issue tracks adding a partner tier so
the effective allowlist becomes a partner + organization + site union.

**D3 — the unsafe-address classification is a positive test, not the constraint's closed list (Task 2).**
The Global Constraints name loopback, link-local, unspecified, multicast, and metadata endpoints as
the universally unsafe set, and RFC1918/ULA as the allowlist-gated private set. Implemented
literally, every other range classifies public and is dialable with no allowlist entry — including
`100.64.0.0/10` CGNAT, which is Tailscale's range, making a tailnet-joined endpoint an SSRF pivot
onto arbitrary tailnet peers. Classification is therefore inverted to a positive test
(`IsGlobalUnicast() && !IsPrivate()`) plus an explicit reserved-prefix table:

- `100.64.0.0/10` joins RFC1918 and IPv6 ULA as **allowlist-gated private** — a legitimate CDN is
  never CGNAT, so exact-origin approval is the right gate rather than an outright ban;
- `240.0.0.0/4`, `198.18.0.0/15`, `192.0.0.0/24`, `0.0.0.0/8`, and `255.255.255.255` are
  **forbidden** outright, alongside the constraint's named classes;
- embedded-IPv4 extraction additionally covers IPv4-compatible `::/96` and IPv4-translated
  `::ffff:0:0/96`, matching the existing worst-of-wrapper-and-embedded rule.

The named classes stay unallowlistable exactly as the constraint requires; this widens what is
caught, never narrows it.

**D4 — the agent must actually consume `require_manifest_signing_key_id` (Tasks 6 and 9).**
The plan splits this control across two tasks and wires neither end to the other: Task 6 gave the
agent a `RequireManifestSigningKeyID` config field and plumbed it to all eight updater construction
sites, and Task 9 made the API send `configUpdate.require_manifest_signing_key_id=true` when the
operator opts in — but no task taught `applyConfigUpdate` to read that key. The server's instruction
is silently discarded, so the flag can only ever be set by hand-editing `agent.yaml`, and the
wave's own end-state gates ("require ID only after the missing-ID count stays zero for seven
consecutive days"; "missing-ID compatibility has been disabled" as a rotation precondition) are
unreachable through the config surface this wave ships.

Task 9 therefore also wires the agent side: `applyConfigUpdate` reads
`require_manifest_signing_key_id` (accepting snake_case and camelCase, like its neighbours), sets
the config field, and persists via `SaveTo`, with a Go test proving a pushed `true` survives a
reload. Consumers re-read `h.config.RequireManifestSigningKeyID` at updater-construction time, so a
pushed change takes effect on the next update check; the helper-manager options captured at startup
(`heartbeat.go:610/640`) need a restart, which is the same limitation `backup_server_url` already
has and is acceptable. Agents older than this build still ignore the key — the operator-facing
surfaces must say so rather than implying fleet-wide effect.

## Finding Coverage

| Finding | Owning tasks | Red-green regression | Enforcement acceptance |
|---|---|---|---|
| `P1-UPD-003` | Task 1 | Start with failing prerelease, malformed target, optional-`v`, `dev`, helper, and watchdog tables; make them green through `versionpolicy.Decide`. | Stable-to-prerelease and every malformed server target are denied; only main-agent current `dev` receives compatibility. |
| `P1-UPD-001` | Tasks 6 and 7 | Start with failing exact-key-ID, unknown/mismatched ID, unseen second TOFU key, delegation replay, rollback epoch, and tamper tests; make them green with keyed verification and signed delegation. | A present ID selects one key only, a second key requires valid monotonic delegation, and production rotation remains frozen until exact adoption gates pass. |
| `P1-UPD-002` | Tasks 2 and 3 | Start with failing redirect-limit, HTTPS downgrade, authorization-leak, timeout, overflow, private-control-plane, and hostile-proxy tests; make them green through the shared updater transport. | Updater credentials stay same-origin, every redirect is revalidated, private configured control planes work, and environment proxies receive no request. |
| `SSRF-AGENT-001` | Tasks 2, 4, and 5 | Start with failing loopback/link-local/metadata, DNS-rebinding, mixed-answer, unapproved LAN, approved org/site origin, and version-0 capability tests; make them green at dial time and command dispatch. | Universally unsafe destinations never connect; approved private software works only with exact tenant policy and agent capability 1. |
| `P1-AGENT-LOG-001` | Task 8 | Start with failing directory/current/backup symlink, reopen race, rotation race, mode-repair, and stderr-survival tests; make them green with Unix no-follow descriptors. | Symlink targets receive zero bytes, regular logs/backups are `0600` under `0700`, file logging disables safely, and Windows behavior is unchanged. |

Before implementation, run this migration reservation gate from the Wave 06 worktree:

```bash
git fetch --prune origin
test "$(git merge-base HEAD origin/main)" = "$(git rev-parse origin/main)"
predecessor=2026-08-06-d-device-mtls-certificate-history.sql
first_reserved=2026-08-06-e-agent-outbound-network-capability.sql
second_reserved=2026-08-06-f-manifest-key-delegations.sql
test -e "apps/api/migrations/$predecessor"
test ! -e "apps/api/migrations/$first_reserved"
test ! -e "apps/api/migrations/$second_reserved"
current_highest="$(find apps/api/migrations -maxdepth 1 -type f -name '*.sql' -exec basename {} \; | LC_ALL=C sort | tail -1)"
test "$current_highest" = "$predecessor"
[[ "$predecessor" < "$first_reserved" ]]
[[ "$current_highest" < "$first_reserved" ]]
[[ "$first_reserved" < "$second_reserved" ]]
```

Expected: exit 0 only after rebasing onto current `origin/main` with Wave 05's `-d-` migration as
the exact predecessor. If the predecessor is absent, another migration is newer, either filename is
occupied, or ordering no longer holds, stop and revise the central program plus every affected wave
plan before writing schema or SQL.

---

### Task 1: Replace home-grown version comparison with one SemVer decision package

**Files:**

- Create: `agent/internal/versionpolicy/semver.go`
- Create: `agent/internal/versionpolicy/semver_test.go`
- Modify: `agent/internal/heartbeat/version_downgrade.go`
- Modify: `agent/internal/heartbeat/version_downgrade_test.go`
- Modify: `agent/internal/heartbeat/watchdog_upgrade_test.go`
- Modify: `agent/go.mod`
- Modify: `agent/go.sum`

Add `golang.org/x/mod@v0.38.0` and expose:

```go
package versionpolicy

type CurrentPolicy uint8

const (
	MainAgentCurrent CurrentPolicy = iota
	InstalledComponentCurrent
	AbsentComponentCurrent
)

type Decision struct {
	Allowed bool
	Reason  string
}

func Normalize(raw string) (string, bool)
func Decide(target, current string, policy CurrentPolicy) Decision
```

`Normalize` trims surrounding whitespace, permits exactly one optional lowercase `v`, adds `v` for `x.y.z`, and accepts only `semver.IsValid`. It preserves prerelease/build text. `Decide` applies:

- malformed target: deny for every policy;
- main current `dev`: allow a valid target;
- any other malformed current: deny;
- absent helper/watchdog: allow valid target only through `AbsentComponentCurrent`;
- `semver.Compare(target, current) < 0`: deny;
- equal or higher: allow.

Reasons are bounded constants: `invalid_target`, `development_current`, `invalid_current`, `fresh_install`, `downgrade`, and `same_or_upgrade`.

- [ ] Add failing table tests for optional `v`, prerelease precedence, build metadata, leading zeroes, extra segments, empty target, stable-to-prerelease downgrade, prerelease-to-stable upgrade, `dev` main current, malformed non-`dev` main current, absent helper, unreadable installed helper, and watchdog parity. Run `cd agent && go test -race ./internal/versionpolicy ./internal/heartbeat`; expect the new package to be absent and the current prerelease tests to expose the vulnerable comparison.
- [ ] Run `cd agent && go get golang.org/x/mod@v0.38.0`, then implement `versionpolicy`.
- [ ] Reduce `heartbeat/version_downgrade.go` to adapters that call `versionpolicy.Decide`; remove `parseSemver` and numeric tuple comparison.
- [ ] Route main agent, helper, and watchdog decisions through the adapters. An installed binary with unreadable version uses `InstalledComponentCurrent`, not the fresh-install policy.
- [ ] Run `cd agent && go test -race ./internal/versionpolicy ./internal/heartbeat ./internal/helper`; expect zero failures and no race report.
- [ ] Commit this task as `fix(agent): enforce standards compliant update precedence`.

### Task 2: Build the shared dial-time outbound network policy

**Files:**

- Create: `agent/internal/netpolicy/http.go`
- Create: `agent/internal/netpolicy/address.go`
- Create: `agent/internal/netpolicy/http_test.go`
- Create: `agent/internal/netpolicy/address_test.go`

Expose:

```go
package netpolicy

type Purpose string

const (
	ControlPlaneDownload Purpose = "control_plane_download"
	ManagedSoftwareDownload Purpose = "managed_software_download"
)

type Policy struct {
	Purpose               Purpose
	ControlPlaneOrigins   []string
	ApprovedPrivateOrigins []string
	MaxRedirects          int
	RequestTimeout        time.Duration
	MaxResponseBytes      int64
	Resolver              Resolver
	Dialer                *net.Dialer
}

func NewClient(policy Policy) (*http.Client, error)
func ValidateURL(rawURL string, policy Policy) error
func CopyBounded(dst io.Writer, src io.Reader, max int64) (int64, error)
```

Origin comparison uses normalized `scheme://hostname:effective-port`, with lowercase DNS names, no userinfo, no fragments, and no wildcard/suffix matching.

The transport rules are:

1. only HTTP or HTTPS for the configured control plane; managed software requires HTTPS;
2. reject empty host, userinfo, invalid port, and ambiguous IP encodings;
3. before each dial, resolve the request hostname with the injected/default resolver;
4. reject the whole resolution if any answer is loopback, link-local unicast/multicast, unspecified, multicast, or a metadata address;
5. reject RFC1918 and IPv6 ULA answers unless the exact request origin is a configured control-plane origin or approved private origin;
6. connect only to an address from that validated resolution while retaining the original hostname as TLS `ServerName`;
7. validate each redirect with the same policy, stop after 10, and reject HTTPS-to-HTTP;
8. strip `Authorization`, `Proxy-Authorization`, and cookies when normalized origin changes;
9. set `Transport.Proxy = nil`; environment proxy variables have no effect;
10. enforce request timeout and byte bound at the consumer.

Explicit metadata addresses include `169.254.169.254`, `169.254.170.2`, `100.100.100.200`, and any address returned for `metadata.google.internal`. Public CDN addresses are not pinned. No policy decision reads `IS_HOSTED`; the configured origins and signed command policy are the authorities in hosted and self-hosted deployments.

- [ ] Add failing address tests for IPv4/IPv6 loopback, unspecified, link-local, multicast, RFC1918, ULA, mapped IPv4, metadata endpoints, mixed public/private DNS answers, approved exact private origin, configured private control plane, and a private address under an unapproved lookalike hostname.
- [ ] Add failing HTTP tests using an injected resolver/dialer for initial unsafe target, redirect to unsafe target, DNS answer change between validation and dial, HTTPS downgrade, 11 redirects, same-origin auth retention, cross-origin auth/cookie stripping, hostile `HTTP_PROXY`, timeout, and response-size overflow.
- [ ] Implement address classification and origin normalization without doing DNS during configuration parsing.
- [ ] Implement the custom transport and redirect callback. Dial only after re-resolution; never validate merely the proxy address.
- [ ] Run `cd agent && go test -race ./internal/netpolicy`; expect all network and concurrency cases to pass.
- [ ] Commit this task as `feat(agent): add shared outbound network policy`.

### Task 3: Move updater downloads onto the shared policy

**Files:**

- Modify: `agent/internal/updater/updater.go`
- Modify: `agent/internal/updater/updater_test.go`
- Create: `agent/internal/updater/updater_security_test.go`
- Modify: `agent/internal/heartbeat/handlers_devupdate.go`
- Modify: `agent/internal/heartbeat/handlers_devupdate_test.go`

`updater.New` constructs `netpolicy.Policy` with:

- purpose `ControlPlaneDownload`;
- `ServerURL` and configured backup server as `ControlPlaneOrigins`;
- 10 redirects;
- five-minute timeout;
- `maxUpdateBinaryBytes` bound;
- no approved software origins.

Add `BackupServerURL string` to `updater.Config` and update every construction site. `downloadFromURL` may follow a signed-manifest URL from the control-plane origin to a public CDN, but the policy strips bearer authorization on origin change. It rejects a private redirect unless that origin is one of the configured control planes. Use `CopyBounded` instead of unbounded `io.Copy`.

The `dev_update` path remains disabled by default and must use the same network client when explicitly enabled; its checksum-only trust model is not broadened.

- [ ] Add failing updater regressions for private configured server, public CDN redirect, redirect auth stripping, redirect to loopback/RFC1918/metadata, DNS rebinding, HTTPS downgrade, oversized binary, and hostile proxy environment.
- [ ] Replace the default `http.Client` and local host/scheme comparison with `netpolicy.NewClient`.
- [ ] Pass primary and backup server origins at every main/helper/watchdog updater construction.
- [ ] Route `dev_update` through the same client while preserving the `AllowDevUpdate` gate.
- [ ] Run `cd agent && go test -race ./internal/updater ./internal/heartbeat`; expect zero failures and no race report.
- [ ] Commit this task as `fix(agent): guard updater network destinations`.

### Task 4: Add explicit organization/site policy and a capability handshake

**Files:**

- Create: `packages/shared/src/validators/softwareDownloadPolicy.ts`
- Create: `packages/shared/src/validators/softwareDownloadPolicy.test.ts`
- Modify: `packages/shared/src/validators/index.ts`
- Create: `apps/api/src/services/softwareDownloadPolicy.ts`
- Create: `apps/api/src/services/softwareDownloadPolicy.test.ts`
- Modify: `apps/api/src/routes/software.ts`
- Modify: `apps/api/src/routes/software.test.ts`
- Modify: `apps/api/src/db/schema/devices.ts`
- Create: `apps/api/migrations/2026-08-06-e-agent-outbound-network-capability.sql`
- Modify: `apps/api/src/db/autoMigrate.test.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.test.ts`
- Modify: `agent/internal/heartbeat/heartbeat.go`
- Modify: `agent/internal/heartbeat/heartbeat_test.go`

Define:

```ts
export const softwareDownloadPolicySchema = z.object({
  version: z.literal(1),
  approvedPrivateOrigins: z.array(privateSoftwareOriginSchema).max(32),
}).strict();

export type SoftwareDownloadPolicy = z.infer<typeof softwareDownloadPolicySchema>;
```

Each origin must be an exact HTTPS origin with hostname and optional port, no path other than `/`, query, fragment, userinfo, wildcard, or IP literal in the universally unsafe classes. Normalize away the trailing slash.

Persist policy under the existing JSONB settings key `softwareDownloadPolicy` on organizations and sites; no new tenant table is required. Add these authenticated/MFA-protected endpoints under `softwareRoutes`, guarded by `requireSoftwareWrite` and current org/site scope:

- `GET /download-policy`
- `PUT /download-policy`
- `PUT /download-policy/sites/:siteId`

The service merges settings without overwriting unrelated keys and returns the effective union of organization plus target-site approved origins.

Add `devices.outbound_network_policy_version integer NOT NULL DEFAULT 0` in an idempotent expand-only migration and Drizzle model. Agent heartbeat sends:

```json
{"securityCapabilities":{"outboundNetworkPolicyVersion":1}}
```

The API writes only recognized integer version 1. Old agents omit the object and remain version 0. Existing readers tolerate the new column.

- [ ] Add failing shared validator tests for valid DNS/private-IP origins, normalization, HTTP, userinfo, paths, wildcard, loopback, link-local, metadata, more than 32 entries, and unknown keys.
- [ ] Add failing API tests for read/update, wrong organization, denied site, missing `devices.write`, missing MFA, unrelated settings preservation, organization/site union, and audit metadata with no URL query data.
- [ ] Add a failing migration test for idempotent column creation/default and a mixed-version test proving an old heartbeat leaves version 0 while a capable heartbeat records 1.
- [ ] Implement the validator, service, routes, capability field, migration, and heartbeat persistence.
- [ ] Run `pnpm --filter @breeze/shared exec vitest run src/validators/softwareDownloadPolicy.test.ts` and `pnpm --filter @breeze/api test:run -- src/services/softwareDownloadPolicy.test.ts src/routes/software.test.ts src/routes/agents/heartbeat.test.ts src/db/autoMigrate.test.ts`; expect zero failures.
- [ ] Run `pnpm --filter @breeze/api db:check-drift` and `pnpm --filter @breeze/api check:migrations`; expect no drift or ordering failure.
- [ ] Commit this task as `feat(security): define private software source policy`.

### Task 5: Move managed-software downloads onto the shared policy

**Files:**

- Modify: `apps/api/src/services/softwareDeployment.ts`
- Modify: `apps/api/src/services/softwareDeployment.test.ts`
- Modify: `apps/api/src/routes/software.ts`
- Modify: `apps/api/src/routes/software.test.ts`
- Modify: `agent/internal/remote/tools/software_install.go`
- Modify: `agent/internal/remote/tools/software_test.go`
- Create: `agent/internal/remote/tools/software_network_test.go`

Both the canonical deployment service and legacy software route send:

```ts
downloadPolicy: {
  version: 1,
  approvedPrivateOrigins: effectiveApprovedOrigins,
}
```

Before dispatch, parse `downloadUrl` and require
`device.outboundNetworkPolicyVersion >= 1` for **every** managed-software command, including an
apparently public hostname. A capability-0 agent cannot defend against DNS rebinding or a
public-to-private redirect, so mark that device result failed with bounded reason
`agent_network_policy_upgrade_required` and do not enqueue any arbitrary managed-software URL.
Public and approved-private origins remain compatible only for capability-1 agents.

`InstallSoftware` parses `downloadPolicy` strictly. Missing policy is compatible only for a destination that resolves entirely public. Private answers fail closed when policy is missing, malformed, version is not 1, or origin is absent. Create a `ManagedSoftwareDownload` client with 15-minute timeout, 10 redirects, 500 MiB bound, and the supplied approved origins.

- [ ] Add failing API tests for public URL denied to an old agent and allowed to a capable agent,
  approved private URL to a capable agent, private URL to a version-0 agent, org/site allowlist
  union, unapproved private URL, and no command on denial in both dispatch paths. Include a
  capability-0 public hostname whose DNS/redirect fixture pivots private and prove it is rejected
  before enqueue.
- [ ] Add failing agent tests for public direct/redirect, approved RFC1918/ULA, unapproved private DNS, DNS rebinding, loopback/metadata despite allowlist, redirect outside allowlist, HTTPS downgrade, overflow, timeout, and hostile environment proxy.
- [ ] Add the policy to both command constructors and apply the capability gate before `sendCommandToAgent`.
- [ ] Replace `newInstallerHTTPClient` and `downloadFile` transport logic with `netpolicy.NewClient` and `CopyBounded`.
- [ ] Run `pnpm --filter @breeze/api test:run -- src/services/softwareDeployment.test.ts src/routes/software.test.ts`.
- [ ] Run `cd agent && go test -race ./internal/netpolicy ./internal/remote/tools`; expect zero failures and no race report.
- [ ] Commit this task as `fix(agent): enforce managed software destination policy`.

### Task 6: Verify manifests against the exact API signing key ID

**Files:**

- Modify: `agent/internal/updater/updater.go`
- Modify: `agent/internal/updater/updater_test.go`
- Modify: `agent/internal/config/manifestkeys.go`
- Modify: `agent/internal/config/manifestkeys_test.go`
- Modify: `agent/internal/config/config.go`
- Modify: `agent/internal/config/config_test.go`
- Modify: `apps/api/src/routes/agentVersions.test.ts`

Change trust assembly from a slice to:

```go
type ManifestPublicKeys map[string]ed25519.PublicKey

var embeddedManifestPublicKeys = ManifestPublicKeys{
	"release-artifact-manifest-ed25519": mustDecodeKey("yzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso="),
}

type downloadInfo struct {
	URL               string `json:"url"`
	Checksum          string `json:"checksum"`
	Manifest          string `json:"manifest"`
	ManifestSignature string `json:"manifestSignature"`
	SigningKeyID      string `json:"signingKeyId"`
}
```

Pinned entries remain serialized as `keyId:base64`, but parsing retains the ID. When `SigningKeyID` is present, verify with that exact embedded or pinned key only. Unknown ID, wrong key under a known ID, malformed ID, or signature mismatch fails closed; never try every key after an ID mismatch.

Add `RequireManifestSigningKeyID bool` to agent config, mapstructure/YAML persistence, and `updater.Config`. When the response omits the ID:

- `false`: temporarily verify against the key set and emit one bounded warning per process;
- `true`: fail closed with `manifest signing key ID required`.

Harden TOFU:

- no deployment-pinned key: accept one valid first key;
- same ID and bytes: idempotent;
- same ID with different bytes: `ErrManifestTrustRotationRejected`;
- any unseen second deployment key: `ErrManifestTrustExpansionRejected`.

The embedded LanternOps root does not count as a deployment-pinned key.

- [ ] Add failing config tests for first bootstrap, identical replay, changed bytes, unseen second ID in the same call, unseen second ID in a later call, malformed entries, and atomic preservation after rejection.
- [ ] Add failing updater tests for exact embedded ID, exact deployment ID, unknown ID, signature made by a different trusted key, missing-ID compatibility, missing-ID required, and warning bounded to once.
- [ ] Add API response keyset tests proving `signingKeyId` survives `/agent-versions/:version/download`, `/agent-versions/:version/helper/download`, and `/agent-versions/:version/watchdog/download`.
- [ ] Implement keyed trust parsing and exact verification; remove the “try all keys” path whenever an ID is present.
- [ ] Run `cd agent && go test -race ./internal/config ./internal/updater` and `pnpm --filter @breeze/api test:run -- src/routes/agentVersions.test.ts`; expect all key-substitution cases to pass.
- [ ] Commit this task as `fix(agent): bind manifests to signing key IDs`.

### Task 7: Deploy signed monotonic key delegation before allowing rotation

**Files:**

- Modify: `apps/api/src/db/schema/manifestSigningKeys.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Create: `apps/api/migrations/2026-08-06-f-manifest-key-delegations.sql`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Modify: `apps/api/src/services/manifestSigning.ts`
- Modify: `apps/api/src/services/manifestSigning.test.ts`
- Create: `apps/api/scripts/manifest-key-rotation.ts`
- Create: `apps/api/scripts/manifest-key-rotation.test.ts`
- Modify: `apps/api/src/routes/agents/enrollment.ts`
- Modify: `apps/api/src/routes/agents/enrollment.test.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.test.ts`
- Modify: `agent/pkg/api/client.go`
- Modify: `agent/internal/heartbeat/heartbeat.go`
- Modify: `agent/internal/config/manifestkeys.go`
- Modify: `agent/internal/config/manifestkeys_test.go`
- Modify: `agent/internal/config/config.go`

Define the wire record:

```ts
type ManifestKeyDelegation = {
  schemaVersion: 1;
  oldKeyId: string;
  newKeyId: string;
  newPublicKeyB64: string;
  epoch: number;
  notBefore: string;
  notAfter: string;
  signatureBase64: string;
};
```

Sign these exact UTF-8 bytes with the currently trusted old Ed25519 key:

```text
breeze-manifest-key-delegation-v1
<old key ID>
<new key ID>
<new public key base64>
<unsigned decimal epoch>
<UTC RFC3339 not-before>
<UTC RFC3339 not-after>
```

Create system-scoped `manifest_signing_key_delegations` with forced RLS and an exact system-only
policy matching `manifest_signing_keys`: `USING` and `WITH CHECK` both require
`current_setting('breeze.scope', true) = 'system'`. The table contains UUID, unique monotonic epoch,
old/new key IDs, new public key, validity window, signature, created time, and adopted/activated
time. Add it to `INTENTIONAL_UNSCOPED`; grant only what the existing system-context service role
requires, never tenant policy access. The migration is idempotent.

`prepare` in `manifest-key-rotation.ts` creates a new retired key plus delegation signed by the current active key; it does not activate the key. `activate` runs only when its `--epoch` equals the prepared epoch and an explicit `--confirm-adoption` flag is present. The script atomically retires old/activates new and records activation. It refuses a second prepared delegation, epoch reuse, expired window, or activation without confirmation.

Agent config adds `ManifestDelegationEpoch uint64`. Acceptance requires:

- old ID is currently trusted;
- signature verifies with exactly old ID;
- new ID is unseen;
- epoch is greater than persisted epoch;
- local time is inside the validity window with five-minute clock skew;
- public key is exactly 32 decoded bytes.

Persist the new `keyId:base64` and epoch in one `SaveTo`. Replays, rollback epochs, altered window/key/ID, unknown old ID, and expired/future records fail closed. Enrollment and heartbeat return active unexpired delegation records.

- [ ] Add failing migration/RLS tests proving forced RLS, exact system-only `USING`/`WITH CHECK`,
  tenant-context denial, system-context insert/select/update/delete, and migration idempotency.
- [ ] Add failing server tests for canonical signing, one prepared record, monotonic epoch, validity, no premature activation, and explicit confirmed activation.
- [ ] Add failing agent tests for valid adoption plus every replay/tamper/time/ID failure above; prove config remains byte-for-byte unchanged on rejection.
- [ ] Rebase onto latest `origin/main` and add an enrollment ordering regression: hold `withSystemDbAccessContext` unresolved, prove `queueWarrantySyncForDevice` and every delegation-related network/queue mock remain uncalled, then resolve the transaction and prove the existing warranty enqueue occurs. Delegation DB lookup may occur in system context; external handoff may not.
- [ ] Preserve `detectWatchdogStateCollapse`, watchdog restart-log decision/cache exports, and their tests in `heartbeat.ts`. In each heartbeat suite touched here, call `resetWatchdogRestartLogCacheForTests()` in setup so delegation assertions cannot inherit module-global dedupe state.
- [ ] Implement the system table, service, rotation CLI, wire responses, Go decoding, verification, and atomic persistence.
- [ ] Run `pnpm --filter @breeze/api test:run -- src/services/manifestSigning.test.ts scripts/manifest-key-rotation.test.ts src/routes/agents/enrollment.test.ts src/routes/agents/heartbeat.test.ts src/db/autoMigrate.test.ts`.
- [ ] Run `pnpm --filter @breeze/api test:rls-coverage` and `cd agent && go test -race ./internal/config ./internal/heartbeat ./internal/updater`; expect all gates green.
- [ ] Keep production rotation frozen. Do not run `activate` until every non-retired device that checked in during the preceding 30 days reports the prepared delegation epoch, dormant devices are explicitly retired or assigned administrator recovery, and missing-ID compatibility has been disabled.
- [ ] Commit this task as `feat(security): add signed manifest key delegation`.

### Task 8: Harden Unix log open, reopen, and rotation

**Files:**

- Modify: `agent/internal/logging/rotation.go`
- Create: `agent/internal/logging/rotation_unix.go`
- Create: `agent/internal/logging/rotation_unix_test.go`
- Create: `agent/internal/logging/rotation_windows.go`
- Create: `agent/internal/logging/rotation_windows_test.go`
- Modify: `agent/internal/agentapp/main.go`
- Modify: `agent/internal/agentapp/main_test.go`

Keep locking and rotation sequencing in `rotation.go`. Platform helpers expose:

```go
func secureLogDirectory(path string) error
func openSecureLogFile(path string) (*os.File, error)
func repairLogFileMode(file *os.File) error
func validateRotationPath(path string) error
```

On Unix:

- reject a symlink in any existing path component for the log directory;
- create directories `0700`, then `Lstat` and reject a symlinked directory;
- repair directory mode to `0700`;
- `unix.Open(path, O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW|O_CLOEXEC, 0600)`;
- wrap with `os.NewFile`, `Fstat`, require regular file, and `Fchmod(0600)`;
- apply the same checks on reopen and every backup source/destination;
- after rename, open each backup with no-follow and repair it to `0600`.

Define a typed `ErrUnsafeLogPath`. If current log or backup is a symlink, close/disable the rotating writer and never rename, truncate, chmod, or write the target. `agentapp` keeps system/stderr output alive. A permission-repair error equal to `EPERM`, `EROFS`, `ENOTSUP`, or `EOPNOTSUPP` emits one prominent bounded warning and continues only if the opened object is a regular non-symlink file; other errors fail file logging.

`rotation_windows.go` retains the current `os.OpenFile` behavior and tests it separately.

- [ ] Add failing Unix tests for directory symlink, current-log symlink, backup symlink, link swap before reopen, link swap during rotation, `0600` repair, `0700` repair, backup modes, close-on-exec, unsupported chmod warning, concurrent writes/rotation, and no bytes written to the symlink target.
- [ ] Add a failing agentapp test proving `ErrUnsafeLogPath` disables only file output while stderr/system logger remains usable.
- [ ] Split platform helpers and implement Unix no-follow descriptor handling with `golang.org/x/sys/unix`.
- [ ] Keep Windows semantics unchanged and add a Windows-build compile/test target.
- [ ] Run `cd agent && go test -race ./internal/logging ./internal/agentapp`; expect all Unix tests and the race detector to pass.
- [ ] Run `cd agent && GOOS=windows GOARCH=amd64 go test -exec=true ./internal/logging ./internal/agentapp`; expect both packages to cross-compile without attempting to execute a Windows binary. On the Windows CI runner, run `go test -race ./internal/logging ./internal/agentapp`; expect the Windows behavior tests to pass.
- [ ] Commit this task as `fix(agent): secure Unix log rotation paths`.

### Task 9: Wire compatibility controls and execute canary gates

**Files:**

- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `deploy/docker-compose.prod.yml`
- Modify: `apps/api/src/config/validate.ts`
- Modify: `apps/api/src/config/validate.test.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.test.ts`
- Create: `docs/operations/agent-network-and-manifest-rollout.md`

Add API configuration:

```env
# Keep false until every served update response includes signingKeyId and fleet adoption is proven.
AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID=false
```

Map it explicitly into API services. Heartbeat sends `configUpdate.require_manifest_signing_key_id=true` only when the API setting is true. The default stays false for rolling/server rollback compatibility. Document that environment proxies are ignored for updater and managed-software clients, private control planes are allowed by exact configured origin, and private software sources require policy plus agent capability 1.

Canary rings are: internal test devices, staging, 1% hosted, 10% hosted, 50% hosted, and 100%
hosted; self-hosted operators opt in on their schedule. Record a separate go/no-go decision at each
ring. Stop promotion on any unexplained updater failure, private-control-plane denial,
software-download denial, signature/key-ID failure, log-output loss, or race/crash regression.

- [ ] Add failing config/compose tests for explicit boolean validation, default false, both compose mappings, and heartbeat compatibility behavior.
- [ ] Implement configuration and the rollout runbook, including the exact stop conditions and higher-version forward-fix recovery.
- [ ] Ship SemVer, log hardening, network policy, and capability 1 first while missing key ID remains compatible.
- [ ] At each ring, verify updater success, public CDN redirects, configured private control plane, approved private software source, unapproved private denial, system/stderr logging, and file modes.
- [ ] Ship exact-ID preference and observe missing-ID count. Require ID only after the count remains zero for seven consecutive days and every active server version supplies `signingKeyId`.
- [ ] Deliver one prepared signed delegation and verify adoption epoch telemetry without activating the new key. Activate only after every non-retired device seen during the preceding 30 days reports that epoch and every remaining dormant device is explicitly retired or assigned administrator recovery; then prove manifests signed by the new exact ID succeed.
- [ ] If a canary fails, stop promotion and ship a higher SemVer forward fix or invoke the explicit operator recovery command. Do not publish an older automatic-update target.
- [ ] Commit this task as `docs(security): add agent network rollout controls`.

### Task 10: Run the complete Wave 06 verification and rollback exercise

- [ ] Run focused agent suites:

  ```bash
  cd agent
  go test -race \
    ./internal/versionpolicy \
    ./internal/netpolicy \
    ./internal/updater \
    ./internal/config \
    ./internal/logging \
    ./internal/remote/tools \
    ./internal/heartbeat \
    ./internal/helper \
    ./internal/agentapp
  ```

  Expect zero failures and no race reports.

- [ ] Run `cd agent && go test -race ./...`; expect the full agent to pass with no race report.
- [ ] Run API/shared gates:

  ```bash
  pnpm --filter @breeze/shared exec vitest run src/validators/softwareDownloadPolicy.test.ts
  pnpm --filter @breeze/api test:run -- \
    src/services/softwareDownloadPolicy.test.ts \
    src/services/softwareDeployment.test.ts \
    src/services/manifestSigning.test.ts \
    src/routes/software.test.ts \
    src/routes/agentVersions.test.ts \
    src/routes/agents/enrollment.test.ts \
    src/routes/agents/heartbeat.test.ts \
    src/config/validate.test.ts \
    src/db/autoMigrate.test.ts
  pnpm --filter @breeze/api test:rls-coverage
  pnpm --filter @breeze/api db:check-drift
  pnpm --filter @breeze/api build
  ```

  Expect zero failures, no RLS coverage gap, no schema drift, and a successful build.

- [ ] Run regression fixtures for stable-to-prerelease downgrade, malformed target, redirect to every unsafe address class, DNS rebinding, authorization stripping, HTTPS downgrade, private control plane, approved LAN origin, version-0 private-download denial, key-ID mismatch, delegation rollback, and Unix symlinks.
- [ ] Prove hostile `HTTP_PROXY` and `HTTPS_PROXY` endpoints receive zero updater/software requests and zero credentials.
- [ ] Prove a public CDN that changes IPs continues working, while a hostname that changes from public to private is denied at dial time.
- [ ] Prove Windows log builds/tests are unchanged and Unix current/backup files are regular `0600` files under a `0700` directory.
- [ ] Exercise server rollback while agents retain capability 1 and exact-ID preference; expect the preceding compatible server path to continue because missing-ID requirement has not been enabled prematurely.
- [ ] Exercise agent rollback by stopping promotion and installing a higher-version forward fix through the same signed-manifest path.
- [ ] Obtain one independent review covering SemVer edge cases, address classification, redirect/auth behavior, allowlist tenancy, capability mixed versions, exact key identity/delegation, and no-follow file semantics.
- [ ] Commit verification-only adjustments as `test(security): close Wave 06 agent hardening gates`.

## Completion Criteria

- Stable-to-prerelease and malformed targets cannot be installed automatically; `dev` compatibility is limited to the main agent.
- Updater and managed-software downloads share one redirect- and dial-time-enforced policy.
- Unsafe and rebinding destinations fail on the agent even when API validation misses them.
- Exact configured private control planes work; private software origins require organization/site approval and capability version 1.
- Origin changes remove authorization; HTTPS never downgrades; time, redirect, and byte limits hold.
- Manifest signatures use the exact supplied key ID; unseen second TOFU keys are rejected.
- Rotation remains frozen until signed monotonic delegation is deployed and adopted.
- Unix log paths and backups resist symlink attacks and retain `0600`/`0700`; Windows behavior is unchanged.
- Canary stop/rollback instructions use a higher-version forward fix or explicit recovery, never an assumed automatic downgrade.
