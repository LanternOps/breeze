# Agent: Encrypted Client Hello (ECH) for control-plane TLS — design

**Issue:** #8869 · **Related:** #8868 (detect ISP filter), #8870 (second domain), #8872 (abuse contact surface)
**Date:** 2026-10-16 · **Status:** builder check done (7 questions, all settled below as the author's calls); awaiting approval

## Intent and why

On 2026-10-15 the hosted control-plane domain was rated "Malicious" by two commercial reputation feeds, and consumer/SMB ISP gateways running CUJO AI security features (Comcast xFi Advanced Security, Spectrum Security Shield; Rogers ships the same product) began hijacking every agent connection. The filter matches the **plaintext hostname in the TLS ClientHello (SNI)**, on **every port** (443 and Cloudflare's alternate HTTPS ports were tested), and answers in plaintext with a `302` to its block page. DNS is untouched. The agent logs `tls: first record does not look like a TLS handshake` and the device goes offline. Nothing server-side can reach those devices, and delisting is a slow, opaque process with no public appeal.

TLS Encrypted Client Hello removes the signal the filter keys on: the real hostname travels encrypted; the wire shows only the edge's public cover name (`cloudflare-ech.com`), which an ISP cannot block without breaking a large share of the web. The hosted zone already publishes an ECH config in its DNS HTTPS record; the agent builds on Go 1.26, whose `crypto/tls` has had client-side ECH since 1.23. A spike (2026-10-16) got `ECHAccepted=true` against both regions with no infrastructure change.

Second, lesser motive: a cheap, generic detector for "a filter answered on 443", which #8868 also wants.

## Goals

1. An agent behind an SNI-blocking gateway reconnects to the control plane **without any human action** on the device or the gateway, within a few retry cycles.
2. **Zero regression for every other agent.** A healthy agent's connections are byte-for-byte what they are today unless the filter signature is observed.
3. The fleet can be told to stop using ECH **without a release** (server-pushed kill switch).
4. Operators can see which devices are on ECH (health payload), so the rollout is observable.
5. Self-hosted deployments whose edge publishes no ECH config get exactly today's behaviour; no new required configuration.

## Non-goals

- Privacy as a feature. The hostname is still visible on the first (plain) attempt; the goal is reachability, not hiding the domain from everyone.
- ECH for policy-gated third-party egress (`netpolicy` clients used by tools), the UniFi collector, backup storage sessions, or the network diagnostic.
- Making the *downloaders* (PowerShell one-liner, macOS installer app, Linux `install.sh`) work on a filtered network — see §6; that is the follow-on wave.
- Working around DNS-based blocking. If a filter starts poisoning DNS for the hostname, that is #8870's problem (second domain + `backup_server_url`), not this one.
- QUIC/HTTP3.

## Anti-goals (what would make this a failure even if it "works")

- **An agent that is less reachable because of ECH.** Any ECH-path failure — DoH unreachable, record missing, config rejected, handshake error, timeout — must land on plain SNI on the *next attempt at the latest*, with no extra backoff. A broken ECH config must never be retried forever.
- A slow DoH lookup delaying a heartbeat or a WebSocket reconnect. Key lookup never sits in front of a dial.
- Behaviour change for self-hosters with corporate TLS inspection: those proxies terminate TLS and never produce the filter signature, so ECH must never engage there (and if it somehow does, the fallback rule above still saves them).
- Persisting a bad state across restarts (e.g. "ECH on" with a dead config and no cooldown).

## Constraints

- Go 1.26, standard library TLS only; no new third-party modules. HTTPS-record lookup goes over DNS-over-HTTPS with the JSON API (`Accept: application/dns-json`), parsing the presentation-format `ech=` SvcParam; avoid pulling in a wire-format DNS parser.
- DoH resolvers: `https://cloudflare-dns.com/dns-query`, then `https://dns.google/resolve` as fallback. Both are hard to block and both serve HTTPS records. The DoH request itself goes through the normal dialer (plain SNI to the resolver) and through `netcache`, so a DNS outage does not break the lookup path more than it breaks everything else.
- Cover/public name comes from the ECH config itself (Go reads it from the config list); the agent never hard-codes `cloudflare-ech.com`.
- Must coexist with the custom-CA `tls.Config` self-hosters set (`heartbeat.go:1075`, `watchdog/failover.go:175`, `websocket/client.go:388`): the ECH config list is an *addition* to that config, cloned per attempt, never a replacement.
- Strict host policy for hosted builds (`hostpolicy`) is unaffected: the URL/host the agent talks to does not change.
- No change to the MSI, the installer scripts, or enrollment flow.

## Decided behaviour

### 1. Plain first; ECH only after the filter signature

Per host (control-plane host and backup host separately), the dialer has three modes: `plain` (default), `ech`, `cooldown`.

- In `plain`, dial exactly as today. If the TLS handshake fails with `*tls.RecordHeaderError` whose `RecordHeader` begins with `HTTP/` (a plaintext HTTP answer on the TLS port), record a **filter signature**. After **2 signatures within 10 minutes** (my call; one could be a captive portal), switch the host to `ech` and schedule an ECH config fetch. The signature counter also feeds #8868's health message ("blocked by a network security filter").
- In `ech`, each dial: TCP connect (via `netcache` as today) → `tls.Client` with the host's normal config **plus** `EncryptedClientHelloConfigList`. On success, stay in `ech` (sticky while it works) and set `ech_active=true`. On `*tls.ECHRejectionError` with a non-empty `RetryConfigList`: persist it and retry **once, immediately** with the new list. On any other ECH-path error (no cached config, DoH failed, rejection with empty retry list, handshake error): **fall back to plain within the same dial** (one more TCP connect), and count an ECH failure.
- **3 consecutive ECH failures** → `cooldown` for **1 hour** (my call), during which the host is dialled plain only; after cooldown, back to `plain` with the signature counter reset (so the filter must be observed again before ECH re-engages).
- `ech` is **sticky until restart or cooldown**. The edge accepts ECH whether or not a filter is present, so there is no natural signal that the filter went away; a periodic plain re-probe would cost reconnects for no reachability gain and is out of scope for v1 (noted as a possible follow-up). A restart always starts `plain`, which bounds how long a host stays on ECH after the filter is gone. A plain handshake that *does* succeed inside `ech` mode (the per-dial fallback) moves the host back to `plain`.
- **Signature counting:** signatures are deduplicated per host into a 30-second window, so one filter event seen by heartbeat, WebSocket and the log shipper at once counts once. The threshold is 2 *events* within 10 minutes; that is what makes the captive-portal rationale hold.

### 2. Key discovery and caching

- `internal/ech` fetches the HTTPS record for the host over DoH, extracts `ech=`, base64-decodes it, and stores `{host, configList, fetchedAt, ttl}` in `<data dir>/ech-cache.json` (same tmp+rename pattern as `netcache`). Fetch is triggered when a host enters `ech` mode and when a cached entry is older than its TTL (min 5 min, max 24 h); it runs in the background and never blocks a dial. A dial in `ech` mode with no cached config falls back to plain for that attempt.
- `RetryConfigList` from a rejection replaces the cached list (that is the edge telling us the current key).

### 3. Kill switch and opt-out

- Server-pushed: a boolean `echEnabled` on the heartbeat response (same channel that already carries `backup_server_url`). Default true when absent (so older API versions don't disable it). When false, every **new** dial is plain and no DoH fetches happen; live ECH connections are **not** torn down (no `ForceReconnect`) — a fleet-wide kill that force-reconnected every socket would be a reconnect storm on the very metric the rollout watches, and a connection that is working is not the problem the switch exists for. They drain on their own reconnect cycle. API side: driven by env `AGENT_ECH_ENABLED` (default `true`), no UI for v1.
- The server flag is persisted under its **own** key (`ech_server_enabled`) via the existing `SetAndPersist` path, never under the operator's key, so (a) a server `true` can never overwrite a local opt-out and (b) the **watchdog** — a separate process whose failover response carries no config channel — honours the kill switch when it reloads `agent.yaml` at failover entry. The watchdog otherwise runs the same dialer with its own in-memory state.
- Local: `ech: false` in `agent.yaml` (default true), operator-owned. Either switch wins when off.

### 4. Observability

- The health observation wire schema is **strict v1** on the API (`apps/api/src/routes/agents/schemas.ts`, `agentHealthObservationWireV1Schema.strict()`, `healthStatus: …catch(undefined)`): adding unknown fields inside it would make every older API silently drop the *whole* observation for every upgraded agent. So: (a) the filter block state goes into the existing `components` map as `control_plane` with `state`/`reason` (fits v1 unchanged; this is #8868's "blocked by a network security filter" message), and (b) `echActive` (bool) and `filterSignatureSeenAt` (RFC 3339, nullable) are **new top-level heartbeat keys**, which older servers strip harmlessly (the same additive pattern `HelperInstallIssue` relies on). API change is additive: accept the two keys and count them (Prometheus counters `breeze_agent_heartbeat_ech_total{active}` and `breeze_agent_filter_signature_reports_total`); **no device-row columns and no migration in v1** — the per-device view is the `control_plane` component already visible in the health observation. No agent↔API deploy-order dependency. No web UI work in v1.
- Logs: one INFO per mode change per host (`plain→ech`, `ech→cooldown`, …), one WARN per filter-signature streak (reuse the `netcache` once-per-streak latch pattern), DEBUG for individual ECH attempts. No per-dial INFO noise.

### 5. One-shot commands: `enroll`, `bootstrap`, `support`

The 2-signature threshold protects a long-running agent from engaging ECH on a captive-portal blip. A one-shot CLI command has no steady state to protect and no second attempt: on the **first** filter signature it fetches the ECH config (synchronously, bounded to ~5 s total across both DoH resolvers) and retries the request with ECH once, then falls back to plain and reports the normal error. This is what makes the MSI's `BootstrapEnroll` / `EnrollAgent` custom actions succeed on a filtered network: the MSI ships the agent binary, so enrollment is the only network step.

Scope of "the request": **every control-plane call the command makes before it exits** — enrollment POST, bootstrap-token redeem, release/manifest fetches, support-session enroll — not just the first. `pkg/api` currently builds several bare `http.Client`s (`pkg/api/client.go` ~290/403/479/526) and `bootstrap.go` another; they get one transport-injection point so a single `ech.Dialer` serves them all. `enroll` and `bootstrap` run elevated (SYSTEM/root under the MSI/pkg) and **persist** `ech-cache.json` into the service data dir so the service's first ECH dial already has a key; `support` runs in the user workspace and does not persist.

### 6. Fresh installs on a filtered network — scope boundary

Everything that downloads the agent *before* the agent exists cannot use ECH: the PowerShell one-liner (`apps/web/src/lib/installCommands.ts`, Schannel/.NET), the macOS installer app (`agent/installer/macos-app`, URLSession), Linux `install.sh` (curl). On a filtered network they fail at the first HTTPS call to the control plane. This design does **not** fix that. The follow-on wave ("install bootstrap from an unblockable artifact source") should have the installers fetch the binary + checksum from the project's GitHub Releases when the control-plane fetch fails with a TLS/transport error, verified against the signed release manifest (`RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` already exists for this), then run `enroll` (which gets §5). Tracked as its own issue; until it lands, the documented workaround is: download the MSI/pkg from any unfiltered network (or the console on a phone), copy it over, run it.

### 7. Where it plugs in

Control-plane transports only: the heartbeat transport (`agent/internal/heartbeat/heartbeat.go` ~1067–1075), the WebSocket dialer (`agent/internal/websocket/client.go` ~386, gorilla `Dialer.NetDialTLSContext`), the watchdog failover probe (`agent/internal/watchdog/failover.go` ~173–175), and the log shipper's transport. Each gets a `DialTLSContext` from one shared `ech.Dialer` that wraps `netcache.Shared().DialContext` and takes the caller's `tls.Config` as the base. `netpolicy` and all other transports are untouched.

## Task 0 — extend the spike before writing agent code

The 2026-10-16 spike proved only a bare TLS 1.3 handshake + one HTTP/1.1 GET under ECH. Before any agent code: repeat it as (1) an authenticated heartbeat-shaped POST over the heartbeat transport settings (h2 via `ForceAttemptHTTP2`), (2) the same with an mTLS client certificate where the deployment uses one (`mtls.BuildTLSConfig`), and (3) a WebSocket upgrade (HTTP/1.1) through the edge. If the edge treats ECH differently on any of these, that is an infrastructure pre-check to resolve first, and the plan changes.

## Left to the builder

- Package layout and naming inside `agent/internal/ech` (state machine, DoH client, cache, dialer wrapper), as long as the dial wrapper is independently testable with a fake TCP dialer and a fake DoH responder.
- Exact representation of the per-host state (in-memory is fine; only the config list cache is persisted — mode is *not* persisted across restarts, which is deliberate: a restart starts plain).
- How the heartbeat-response flag reaches the dialer (a setter on the shared dialer is fine).
- Test strategy details. Required coverage: plain → signature → ech transition; ech success sticky; rejection-with-retry path; every ECH failure class falling back to plain in the same dial; cooldown entry/exit; kill switch (both) forcing plain; DoH timeout never delaying a dial; self-hoster custom CA preserved on the ECH path; no behaviour change on a host that never sees the signature (a byte-equal dial path assertion is ideal).
- Lab verification recipe: a local listener that answers 443 with the plaintext 302 (for the signature) plus a real ECH handshake against the hosted edge; and one real run on a filtered gateway (a currently blocked customer PC is available for a supervised test).

## Rollout

Ships in the next agent release behind the server flag defaulting on. Watch `ech_active` counts and the WS reconnect rate after promote; the kill switch is the rollback. Release note must say: the installer downloaders cannot use ECH yet; on a filtered network, download the MSI/pkg elsewhere and run it (enrollment inside it works).

## Deviations at implementation

1. **No device-row columns, no migration (spec section 4).** `echActive` / `filterSignatureSeenAt` are optional top-level heartbeat keys surfaced as Prometheus counters; the per-device view is the `control_plane` entry in the strict v1 health observation, which avoids a schema change on a hot table.
2. **`support` persists the ECH cache in its own user-workspace data dir (section 5).** `config.GetDataDir()` already resolves there, so nothing is special-cased.
3. **No custom-CA `tls.Config` exists in the agent (Constraints).** The agent uses the OS trust store only, so "base config" means the mTLS config or nil.
4. **A plain success inside ECH mode returns the host to plain (also while ECH is switched off locally or by the server), and a cache miss never counts as an ECH failure; the DoH fetch's failure does.** This keeps bursts of dials from each triggering a fetch while still bounding a broken fetch path with the cooldown.
5. **`ech.Shared()` reads no config; each process calls `ech.Configure`.** Loading config inside the shared accessor would call `config.Load("")`, which takes the config package's non-reentrant `persistMu` and rebinds the global viper instance to the default config path. That is wrong for the watchdog and `support`, so the dialer starts with both flags true and the agent, watchdog, helper and one-shot commands each call `ech.Configure(cfg.ECH, cfg.ECHServerEnabled)` with the config they already hold.
6. **An absent `ech_enabled` in `configUpdate` means "no change", not "default true".** The agent acts only on a heartbeat response that carries the key. An API rolled back to a pre-ECH build sends no key, so agents switched off stay off. That is the safer reading: a rollback cannot silently re-enable ECH on devices an operator turned it off for.
7. **`pkg/api.NewClientWithTLS` (the mTLS renewal and confirm clients) now shares the control-plane transport.** It is built by the same `ech.NewClient` as the heartbeat client (HTTP/2, `HTTPS_PROXY`, netcache dial, 10 s handshake budget), for consistency with the heartbeat client.
8. **`echActive` is wire truth, and the kill switch on a live ECH connection has its own health message (#8869 lab).** The dialer records the last ECH-accepted and the last plain-success handshake per host, and `echActive` is true only when the most recent successful dial was ECH-accepted (tracked as a last-success-kind flag, so two successes sharing a timestamp still order correctly). It is not derived from the mode (a heartbeat delivered over the per-dial plain fallback, or sent before the first accepted ECH handshake, used to report `echActive: true` and inflate `breeze_agent_heartbeat_ech_total{active="true"}`, which the kill-switch precheck relies on), and it is not gated on the switches: turning ECH off leaves the live connection on ECH, so `echActive` stays true until a plain dial succeeds. While `echActive` is true and ECH is switched off, `control_plane` is `warning` with `encrypted client hello disabled by control plane; the next reconnect dials plain` (server kill switch) or `encrypted client hello disabled by configuration; the next reconnect dials plain` (local `ech: false`; it wins when both are off, since re-enabling the server switch would not change that device), instead of the filter message the lab saw.
