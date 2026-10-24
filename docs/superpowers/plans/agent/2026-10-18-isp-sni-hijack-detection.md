# Control-Plane Block Detection and Reporting Implementation Plan (#8868)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a network filter, captive portal or untrusted TLS interceptor stands between a device and its control plane, the agent records what answered, keeps that record until the server has it, and the console shows "blocked by a network filter (`<host>`)" instead of a bare `tls: first record does not look like a TLS handshake` or "offline".

**Architecture:** The ECH dialer (`agent/internal/ech`) already sees every control-plane TLS handshake and already detects the plaintext-HTTP filter signature. It gains a capture wrapper on the raw TCP connection, so it can read the filter's reply (status line and `Location` host) and the untrusted issuer from a failed certificate check, with no extra connection. The heartbeat package turns that per-host evidence into a persisted *episode*, sends it as one additive optional heartbeat object on whichever transport succeeds, and drops it only after a 200. The API strict-parses the object into two `devices` columns (watchdogInstall #8620 pattern). The web shows a device-detail notice and a device-list badge. A monitor kind for partner alerts is a separate, deferrable PR.

**Tech Stack:** Go 1.26 `crypto/tls` / `crypto/x509` / `net`; Hono + Zod + Drizzle; React (Astro islands) + i18next; Vitest; `go test -race`.

**Spec:** issue #8868 (problem statement) plus the **Decisions** section below. No separate spec doc exists. This plan is gap-only on top of the shipped ECH work: spec `docs/superpowers/specs/agent/2026-10-16-agent-ech-design.md`, plan `docs/superpowers/plans/2026-10-16-agent-ech.md`, lab recipe `docs/superpowers/plans/2026-10-16-agent-ech-lab.md`. Siblings: #8869 (ECH, shipped), #8870 (second control-plane domain, out of scope; see D4 for the handoff).

## What is already on `origin/main` (do not rebuild)

| Asked for in #8868 | State on main (base `d49876c54d`) |
|---|---|
| Detect `RecordHeaderError` starting `HTTP/` | Done: `ech.IsFilterSignature` (`agent/internal/ech/signature.go`) |
| Log once per streak at WARN | Done: `Dialer.update` warn latch (`agent/internal/ech/dialer.go`, "control plane answered the TLS handshake with plaintext HTTP; ...") |
| Distinct health status | Partial: `control_plane` health component, free-text reason, 10-minute window (`heartbeat.go` `controlPlaneComponent`). The `heartbeat` component still carries raw `err.Error()` (`doHeartbeatPost`). |
| Field in the heartbeat payload | Partial: `echActive` and `filterSignatureSeenAt` (a timestamp, no evidence). The API only increments Prometheus counters (`routes/agents/heartbeat.ts` ~1200, `routes/metrics.ts`). |
| Enrollment-time message | Done: `filterSignatureHint` (`agent/internal/agentapp/enroll_error.go`) plus one-shot ECH (`oneshot_ech.go`) |
| Failover treats blocked as down | Done: a signature is a failed dial, so `recordHeartbeatFailure` → backup probe and `decideWatchdogServerURL` count it. |
| Capture status line and `Location` | **Missing** |
| Typed, persisted, surfaced block state | **Missing.** The health observations are stored (`agent_health_observations.components`), but no web component reads `GET /devices/:id/health`. |
| Delivery when the primary is blocked | **Missing.** The state is in memory only and is lost on restart. Nothing reaches the server unless ECH or the backup carries the beat. |
| Installer one-liner hint | **Missing** (`apps/web/src/lib/installCommands.ts` `winFetchChecksum` catch drops the exception) |
| Watchdog restart churn while blocked | **Missing.** A blocked agent's `LastHeartbeat` never advances, so the watchdog restarts it, and the restart drops the in-memory ECH mode. |

## Decisions (quorum: Claude position, then `codex exec` read-only xhigh; outcome per decision)

**D1. Signals.** Two signals, both free, both captured passively on the connection that failed:
- *Plaintext reply.* `crypto/tls` reads ahead into its own buffer, so the bytes after the 5-byte header are lost unless captured. Wrap the raw TCP conn in `captureConn`. It tees reads only while the first byte is not a TLS record type (0x14–0x17); a real server's first byte stops capture at once. On a filter signature, and only on the first signature of a streak, drain the same raw conn until `\r\n\r\n`, 4096 bytes, 1 s, or the caller's deadline (whichever comes first). Then parse the status line and the `Location` host. Never resume TLS on that conn.
- *Untrusted certificate.* On `x509.UnknownAuthorityError` (directly or inside `*tls.CertificateVerificationError`), take the leaf issuer from the error's certificates.
- **Rejected:** the issue's separate plaintext `GET /` probe. It carries no SNI, so the filter may treat it differently or pass it to the real edge, which makes it weaker evidence than the filter's actual reply to our ClientHello. Deferred unless the lab shows the capture missing the status line.
- **Rejected:** DNS-vs-DoH comparison. DNS redirection already shows up as one of the two signals.
- **Rejected:** a DoH canary. DoH does not run reliably on the blocked path (codex).
- Quorum: agree on passive capture. I dropped the canary on codex's evidence.

**D2. Classification** (closed wire enum, `kind`):
- `web_filter`: plaintext reply with a parseable status line other than 511.
- `captive_portal`: plaintext reply with status 511.
- `plaintext_unknown`: the filter signature with no parseable reply (fragmented reply, drain failed, or the HTTPS-proxy path where the dialer is bypassed).
- `untrusted_certificate`: the server certificate fails with UnknownAuthority.
- Not reported, because there is no positive evidence: resets, timeouts, refused connections, `x509.HostnameError`, expired certificates, and TLS alerts (including an mTLS client-certificate rejection).
- The brief's `isp_filter` and `corporate_tls_inspection` are deliberately not used. An office firewall's block page has exactly the shape of an ISP's. An untrusted chain can be inspection, private PKI, or a broken self-hosted chain. The UI copy names the possibilities and does not attribute.
- A *trusted* inspection proxy completes the handshake and is never reported. `untrusted_certificate` is never bypassed: no `InsecureSkipVerify`, no pin override, and it never engages ECH.
- The three plaintext kinds are the positive filter signature. The #8870 trigger keys on that signature, not on the heuristic (`ech.BlockKind.PlaintextSignature()`).
- Brief's Location-host vendor families: **rejected.** A curated vendor table goes stale and hides the one datum the MSP needs for an unknown vendor.
- Quorum: codex wanted neutral names and the signature kept apart from the heuristic. Adopted.

**D3. Report contract.**
- One optional top-level heartbeat object: `controlPlaneBlock: {kind, host, firstSeenAt, lastSeenAt, clearedAt?, clearedBy?, httpStatus?, locationHost?, certIssuer?}`.
- `host` is the control-plane hostname that was blocked, not a primary/backup slot, because promotion swaps the slots (codex).
- `locationHost` is lowercased, port stripped, and must match `^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$`, or it is dropped.
- `certIssuer` is issuer Organization[0], else CommonName, printable ASCII 0x20–0x7E, trimmed, ≤64 characters, or it is dropped.
- **The Location path, query, fragment and userinfo never leave the agent, not even in logs.** WARN attributes are shipped to the server (`logging.go` shippingHandler, codex), so "local only" is not possible.
- The existing WARN line gains `kind`, `http_status` and `location_host`. A new once-per-streak WARN for `untrusted_certificate` carries `cert_issuer`.
- ECH: when an ECH handshake carries the beat, the episode stays open. ECH success proves the host is reachable, not that the filter is gone. The server stores `reachableViaEch` from the beat's `echActive`.
- Clearing: a plain handshake to the host (`clearedBy: plain_success`), a heartbeat 200 to the host without ECH (covers the proxy path), or 24 h with no dial outcome to the host (`clearedBy: unobserved`). The 10-minute window in `controlPlaneComponent` is unchanged and never clears an episode.
- **Backoff unchanged.** This deviates from #8868 item 3. The WS step cap is 60 s (±30% jitter); heartbeat runs on its own tick. Blocked dials cost the server nothing. A fleet-wide vendor listing that lifts all at once must not reconnect faster than today. Quorum agrees.

**D4. Delivery and handoff.**
- There is no separate channel. The episode is main-agent state, persisted at `<data dir>/control-plane-block.json` (0600; temp file + rename, as in `ech/cache.go`). It is attached in `doHeartbeatPost`, so the primary POST, the backup probe and any future #8870 alternate all carry a fresh snapshot.
- An active episode is sent on every beat. A cleared episode is sent until one beat carrying it gets a 200, then it is dropped. The tracker holds at most one active episode and one pending-cleared episode, and a new episode replaces an undelivered cleared one. Codex: "until acceptance, not 24 h after clearance". Adopted, with the 200 as the acceptance, so no new ack field is needed.
- **Single writer:** only the main agent's heartbeat owns the file. Watchdog, helper, backup and one-shot processes keep their own in-memory `ech.Shared()` and never persist.
- Codex wanted watchdog-failover delivery now. **Deferred (disagree):** the watchdog reports only while the main agent is down, the episode survives on disk until the agent is back, and a second reporter needs server-side merge ordering for one projection.
- Instead, the restart churn codex found is fixed here. The heartbeat writes a `ControlPlaneBlockedAt` liveness marker (the #8934 `ServerUnavailableAt` pattern), so the watchdog does not restart a live but blocked agent, and the restart does not throw away its ECH mode.
- Holding the restart also keeps the watchdog out of FAILOVER for a blocked agent. Nothing is lost by that:
  - The main agent already probes the backup itself with a full heartbeat after `backupProbeThreshold` failures (`recordHeartbeatFailure`), and that heartbeat carries the episode.
  - FAILOVER would dial the same filtered hosts.
- **Stated limit:** the console learns of a block only when *some* transport succeeds. That can be ECH, the backup URL, a future #8870 alternate, or the device moving to another network. A device blocked on every path still shows "offline" until then. The episode is waiting on disk and arrives with the first successful beat.
- **Known loss mode:** a 200 counts as acceptance even when the API found the object invalid (for example, a newer agent kind sent to an older API). The agent then drops a cleared episode the server never recorded, and the server's stale active record ages out through the D5 2 h rule. An explicit `controlPlaneBlockAck` in the response is deferred.
- **#8870 handoff:**
  - `(*heartbeat.blockTracker).Current(host) (ControlPlaneBlockReport, bool)` is the trigger for the DNS-TXT alt-host discovery.
  - Discovery runs only when `ech.BlockKind(r.Kind).PlaintextSignature()` holds for the current primary. It never runs for `untrusted_certificate` (must not be bypassed).
  - `captive_portal` is excluded too, because an alternate would not help.
  - `failover.go` / `decideWatchdogServerURL` keep treating blocked and down alike.

**D5. Version gate: none.**
- The object is additive and optional, and an older API strips it (`heartbeatSchema` is non-strict at the top level).
- Absence means *no change*, not "clear" (codex: absence-as-clear lets an older binary erase evidence).
- An active stored episode goes stale only after beats keep arriving for 2 h without it. A current agent re-asserts an active episode on every beat, so 2 h of beats without it means the agent no longer holds it (downgrade). This rule needs no `MIN_AGENT_VERSION_*`.
- UI copy shows only when the column is set, so there is nothing to gate.

**D6. Server.**
- Follow `services/watchdogInstallHealth.ts`: strict parse, transition-only write plan, read-time view.
- Two `devices` columns:
  - `control_plane_block_kind varchar(24)`: closed enum, non-null only while active, export `included`. It drives the list badge and the monitor.
  - `control_plane_block jsonb`: the last episode plus `reachableViaEch`, `reportedAt` (server clock) and `staleAt`, export **`excludedOpen`**. That is the privacy treatment for network-supplied host and issuer text; health components are already `excludedOpen`.
- **Partner alert:** the monitor-kind model (`services/monitors/kinds/*` plus an `alertConditions` handler, timeSync as template), **not** connection-health. Connection-health models integration connection rows (`connection_health_incidents`, `KNOWN_CONDITIONS` contract), and a device has no connection row. The alert ships as its own PR (W3) and may trail.
- Installer: keep the base exception message and add the existing captive-portal/web-filter hint.
- Quorum: agree.

## Global Constraints

- Go `1.26.9` (`agent/go.mod`), standard library only, no new modules. Logging via the package's existing `log` (`logging.L("ech")` / heartbeat logger).
- Capture limits (exact): tee cap **4096 bytes**; drain budget **min(1 s, caller deadline remaining)**; drain only on the **first signature of a streak** per host; the 0x14–0x17 first byte stops capture.
- `http.Transport.DialTLSContext` plain path stays byte-for-byte as today: same `ServerName`, `NextProtos`, MinVersion, 10 s handshake budget. The capture wrapper adds reads to a buffer only.
- Episode limits (exact): persisted lastSeenAt-only updates at most every **5 min**; `unobserved` expiry **24 h**; server staleness **2 h** of beats without the object; server refresh write at most every **1 h** while active; cleared notice shown for **7 days**; server clamps all agent times into **[now − 30 d, now]**.
- Wire enums (exact strings): kind `web_filter | captive_portal | plaintext_unknown | untrusted_certificate`; clearedBy `plain_success | unobserved`. `httpStatus` is an integer 100–599.
- Never log or send the auth token, the Location path/query/fragment/userinfo, captured bytes, or certificate bytes.
- Public repo: test fixtures use `*.example` / `*.invalid` hosts. No ISP account details, customer names, real IPs or hostnames in code, tests, docs or PR text. Vendor product names already in public docs (`advanced-install.mdx`) may stay; add none.
- Migration slot `apps/api/migrations/2026-12-31-230000-device-control-plane-block.sql`. Newest committed is `2026-12-31-170000-m365-consent-sessions-v2-only.sql`. Re-check `ls apps/api/migrations | sort | tail -1` on fresh main before writing; if bumped, take the next free `HHMMSS` and say so in the PR.
- Web mutations: none are added. `runAction` and `no-silent-mutations.test.ts` stay untouched (verify that the test still passes).
- Locales: every new web key goes in all 8 dirs `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/devices.json`, with real translations. No API locale keys are added, so `apps/api/src/i18n/localeParity.test.ts` must stay green unchanged.

## Review Focus

1. A healthy TLS server whose ServerHello arrives split across reads, or a trusted corporate inspection proxy: the handshake must succeed exactly as today, capture nothing and report nothing. → Task 1 `TestCaptureConn_TLSFirstByteStopsCapture`, Task 2 `TestDial_TrustedServerNoEvidence`.
2. A filter that drips headers or never sends `\r\n\r\n`: the dial must return within the drain bound and the caller's deadline, never hang. → Task 2 `TestDial_FilterDripDrainIsBounded`.
3. A `Location` carrying `token=`, userinfo, a port, mixed case or a path: only the lowercase host may leave the agent, including in the WARN log. → Task 1 `TestParsePlaintextReply_RedactsLocation`, Task 2 `TestDial_FilterWarnHasNoPath`.
4. The agent restarts mid-episode, then the network is fixed: the persisted episode must be cleared, delivered once, then dropped. → Task 3 `TestBlockTracker_RestartThenPlainSuccessDeliversOnce`.
5. A downgraded or older agent stops sending the object while the device stays online: the badge must go away after 2 h and not before, and a malformed object must never clear stored state. → Task 7 `planControlPlaneBlockWrite` absent/invalid cases.

---

## PR split and file ownership

| PR | Branch | Owns | Merge order |
|---|---|---|---|
| **W1 agent** | `feature/8868-block-detect/agent` | `agent/internal/ech/{capture,evidence}.go` (+tests), `ech/dialer.go`, `ech/state.go`, `agent/internal/heartbeat/control_plane_block.go` (+test), `heartbeat/heartbeat.go`, `heartbeat/server_unavailable_liveness.go` (or a sibling file), `agent/internal/state/state.go`, `agent/internal/ipc/message.go`, `agent/internal/watchdog/checks.go`, `agent/cmd/breeze-watchdog/main.go`, `docs/superpowers/plans/2026-10-16-agent-ech-lab.md` | first (an old API strips the key) |
| **W2 API+web** | `feature/8868-block-detect/server` (base **main**, not W1) | `apps/api/src/services/controlPlaneBlockHealth.ts` (+test), `routes/agents/{schemas,heartbeat}.ts`, migration, `db/schema/devices.ts`, `services/tenantExportPolicyRegistry.ts`, `routes/devices/{helpers,core}.ts`, `apps/web/src/components/devices/{DeviceInfoTab,DeviceList}.tsx` (+tests), 8 locale `devices.json`, `apps/web/src/lib/installCommands.ts` (+test), `apps/docs/src/content/docs/agents/advanced-install.mdx` | independent of W1; either order |
| **W3 alert (optional)** | `feature/8868-block-detect/monitor` | monitor kind + handler (Task 11) | after W2 |

Branch every PR from fresh `origin/main` so it gets CI. A stacked PR gets no CI; run `gh workflow run CI --ref <branch>` if one is ever stacked. `pnpm test` skips RLS/integration suites, and W2 touches an org-cascade table's columns, so W2 must run the export-policy contract suite (Task 8).

---

## W1 — Agent

### Task 1: Capture conn and plaintext-reply parser

**Files:**
- Create: `agent/internal/ech/capture.go`, `agent/internal/ech/evidence.go`
- Test: `agent/internal/ech/capture_test.go`, `agent/internal/ech/evidence_test.go`

**Interfaces:**
- Produces:
  ```go
  // capture.go
  const captureLimit = 4096
  type captureConn struct{ net.Conn /* mu, buf, capturing bool, decided bool */ }
  func newCaptureConn(c net.Conn) *captureConn
  func (c *captureConn) Read(p []byte) (int, error)          // tees up to captureLimit while capturing
  func (c *captureConn) Captured() []byte                     // copy
  func (c *captureConn) drainHeaders(ctx context.Context, max time.Duration) // reads via c until "\r\n\r\n", cap, deadline, EOF; resets the read deadline after
  // evidence.go
  type BlockKind string
  const (
      BlockWebFilter            BlockKind = "web_filter"
      BlockCaptivePortal        BlockKind = "captive_portal"
      BlockPlaintextUnknown     BlockKind = "plaintext_unknown"
      BlockUntrustedCertificate BlockKind = "untrusted_certificate"
  )
  func (k BlockKind) PlaintextSignature() bool // true for the first three
  type BlockEvidence struct {
      Kind         BlockKind
      HTTPStatus   int    // 0 = unknown
      LocationHost string // sanitized or ""
      CertIssuer   string // sanitized or ""
      SeenAt       time.Time
  }
  func plaintextEvidence(captured []byte, now time.Time) BlockEvidence
  func certEvidence(err error, now time.Time) (BlockEvidence, bool)
  func SanitizeHost(raw string) string // exported: heartbeat reuses it for Host
  ```

- [ ] **Step 1: Write failing tests.**
  - `TestCaptureConn_TLSFirstByteStopsCapture`: pipe that writes `0x16 0x03 0x03 ...` in 3 chunks; after reading all → `Captured()` is empty.
  - `TestCaptureConn_PlaintextCappedAt4096`: writes `"HTTP/1.1 302 Found\r\n"` + 10 KiB → `len(Captured()) == 4096`, and the reader still gets every byte.
  - `TestCaptureConn_DrainStopsAtHeaderEnd`: header end after 2 writes → drain returns once `\r\n\r\n` is buffered, well under `max`.
  - `TestParsePlaintextReply_Comcast302` / `_Spectrum302`: fixtures shaped like the issue's two replies with hosts `warn.filter-a.example` / `block.filter-b.example` and `?url=http://cp.example/&token=abc` → `{Kind: web_filter, HTTPStatus: 302, LocationHost: "warn.filter-a.example"}`.
  - `TestParsePlaintextReply_511IsCaptivePortal` → `captive_portal`, status 511.
  - `TestParsePlaintextReply_RedactsLocation`: `Location: https://User:pw@WARN.Filter.EXAMPLE:8443/p/a?token=x#f` → `LocationHost == "warn.filter.example"`, and no field contains `token`, `pw` or `/p/a`.
  - `TestParsePlaintextReply_Unparseable` (`"HTTP/"` only, garbage status, relative Location) → `plaintext_unknown`, status 0. A relative Location → host "".
  - `TestCertEvidence_UnknownAuthority`: a self-signed leaf with issuer O `"Example Inspect CA"` wrapped in `*tls.CertificateVerificationError` → `{Kind: untrusted_certificate, CertIssuer: "Example Inspect CA"}`. `x509.HostnameError` and an expired-cert error → `ok == false`. An issuer with non-ASCII bytes or more than 64 characters → sanitized or trimmed.
- [ ] **Step 2: Run** `cd agent && go test -race -count=1 ./internal/ech/ -run 'TestCaptureConn|TestParsePlaintextReply|TestCertEvidence' -v`. Expected: FAIL (undefined).
- [ ] **Step 3: Implement.** The first `Read` decides: a byte in 0x14–0x17 means `capturing=false` permanently. Parse with `http.ReadResponse(bufio.NewReader(bytes.NewReader(captured)), nil)`. Status 511 → captive_portal; another valid status → web_filter; a parse error → plaintext_unknown. Location host via `url.Parse` → `Hostname()` → `SanitizeHost`. Use the `D3` regex for the host and printable ASCII ≤64 for the issuer.
- [ ] **Step 4: Run the Step 2 command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent/ech): capture and classify a filter's reply to the TLS handshake (#8868)`.

### Task 2: Dialer records evidence per host

**Files:**
- Modify: `agent/internal/ech/dialer.go` (`attempt.handshake`, `plainInitial`, `plainFallback`, `noteSignature`, `Status`, `update` WARN), `agent/internal/ech/state.go` (`hostState`)
- Test: `agent/internal/ech/dialer_test.go`. Reuse `startFilterListener` (its 302 already carries a `/warn` path) and `startTLSServer` / `startTLSServerWith` from `agent/internal/ech/echtest_test.go`, plus `echtest.Start` → `*Rig{Host, Addr, Pool, Dialer}` (`Pool` is the CA).

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - The `HostStatus` field `Evidence BlockEvidence` (zero when none).
  - `hostState.NoteEvidence(ev BlockEvidence)`.
  - Plain attempts (`cfg.EncryptedClientHelloConfigList == nil`) dial through `newCaptureConn`. ECH attempts do not.
  - A new accessor `func (d *Dialer) streakWarned(host string) bool` reads `d.warned[host]` under `d.mu`.
  - On a handshake error, *before* `raw.Close()`:
    - Filter signature: if `!streakWarned(host)` (released before I/O), `drainHeaders` reads through the `captureConn`, never through `RecordHeaderError.Conn`. Then always `NoteEvidence(plaintextEvidence(...))`. A latched streak re-uses the already-captured bytes without draining.
    - Otherwise, if `certEvidence` returns ok: `NoteEvidence`, plus a WARN once per streak (a separate latch `certWarned`, cleared by `notePlainSuccess`) with `cert_issuer`. It never calls `noteSignature`, so it never engages ECH.

- [ ] **Step 1: Write failing tests.**
  - `TestDial_Filter302RecordsEvidence`: the listener answers with the Task 1 Comcast-shaped fixture → `Status(host).Evidence == {web_filter, 302, "warn.filter-a.example", ...}`, and the error still satisfies `IsFilterSignature`.
  - `TestDial_FilterSplitReplyStillParsed`: the listener writes `"HTTP/1.1 302 Found\r\n"`, sleeps 50 ms, then writes the headers → web_filter.
  - `TestDial_FilterDripDrainIsBounded`: the listener writes `"HTTP/1.1 302"` and then nothing → the dial returns in < 1.5 s with `plaintext_unknown`. With ctx deadline 200 ms → it returns in < 400 ms.
  - `TestDial_SecondSignatureInStreakDoesNotDrain`: a dripping listener (`"HTTP/1.1 302"`, then silence). The first dial takes ≥ 900 ms (it drained). The second dial within the streak returns in < 100 ms.
  - `TestDial_FilterWarnHasNoPath`: capture the log handler → the WARN has `kind=web_filter location_host=warn.filter-a.example`, and no record contains `token` or `/warn`.
  - `TestDial_UntrustedCertRecordsEvidenceNoECH`: a self-signed `httptest.NewTLSServer` → evidence `untrusted_certificate`, mode stays `ModePlain` after 3 dials 31 s apart (fake clock), and exactly one WARN.
  - `TestDial_TrustedServerNoEvidence`: `startTLSServer` with its CA in the base `RootCAs` → success, zero `Evidence`, and `Captured()` empty. This doubles as the trusted-inspection-proxy case.
  - `TestDial_ClientCertAlertNoEvidence`: a server pinned to `MaxVersion: tls.VersionTLS12` with `ClientAuth: RequireAnyClientCert`, and no client cert. Under 1.2 the alert arrives at handshake time; under 1.3 it would arrive after, which makes the test vacuous. Assert the dial **errors** and `Evidence` is zero.
- [ ] **Step 2: Run** `cd agent && go test -race -count=1 ./internal/ech/ -run 'TestDial_(Filter|Second|Untrusted|Trusted|ClientCert)' -v`. Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces. `Status` copies `st.lastEvidence`. Keep the existing WARN string verbatim (the lab recipe greps it) and add the attributes.
- [ ] **Step 4: Run** the Step 2 command, then `go test -race -count=1 ./internal/ech/...` (all existing ECH tests must stay green). Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent/ech): record filter and untrusted-certificate evidence per host (#8868)`.

### Task 3: Episode tracker with persistence

**Files:**
- Create: `agent/internal/heartbeat/control_plane_block.go`
- Test: `agent/internal/heartbeat/control_plane_block_test.go`

**Interfaces:**
- Consumes: `ech.HostStatus` (with `Evidence`, `LastPlainSuccessAt`, `LastECHAcceptedAt`), `ech.BlockKind`, `ech.SanitizeHost`, `ech.IsFilterSignature`.
- Produces:
  ```go
  type ControlPlaneBlockReport struct {
      Kind         string `json:"kind"`
      Host         string `json:"host"`
      FirstSeenAt  string `json:"firstSeenAt"`
      LastSeenAt   string `json:"lastSeenAt"`
      ClearedAt    string `json:"clearedAt,omitempty"`
      ClearedBy    string `json:"clearedBy,omitempty"`
      HTTPStatus   int    `json:"httpStatus,omitempty"`
      LocationHost string `json:"locationHost,omitempty"`
      CertIssuer   string `json:"certIssuer,omitempty"`
  }
  func newBlockTracker(path string, now func() time.Time) *blockTracker // loads path; corrupt/unreadable → empty + one WARN; path "" = in-memory only (tests)
  // Every method below is nil-receiver safe (no-op / nil / false): 100+ heartbeat tests build &Heartbeat{} literals.
  func (t *blockTracker) Observe(host string, st ech.HostStatus)
  func (t *blockTracker) ObserveRequestError(host string, err error) // proxy path: signature → plaintext_unknown; certEvidence → untrusted_certificate; never downgrades a richer kind in the same episode
  func (t *blockTracker) ObserveReached(host string, viaECH bool)    // heartbeat 200: !viaECH clears host's active episode (plain_success)
  func (t *blockTracker) Report() *ControlPlaneBlockReport           // active, else pending-cleared, else nil (RFC 3339 UTC)
  func (t *blockTracker) MarkDelivered(r *ControlPlaneBlockReport)   // drops pending-cleared iff same Host+FirstSeenAt and r.ClearedAt != ""
  func (t *blockTracker) Current(host string) (ControlPlaneBlockReport, bool) // active only; #8870 trigger
  ```
- Rules:
  - Evidence is *current* when `Evidence.SeenAt` is after `LastPlainSuccessAt`. Current evidence and no active episode for the host start one. Current evidence for the active host updates `LastSeenAt` and the evidence. The kind may change only from `plaintext_unknown` to a richer kind.
  - `LastPlainSuccessAt` after the episode's `LastSeenAt` → cleared `plain_success`.
  - No outcome at all (the max of `Evidence.SeenAt`, `LastPlainSuccessAt`, `LastECHAcceptedAt`) for 24 h → cleared `unobserved`.
  - A cleared episode moves to pending, replacing any older pending one.
  - Persist on start, kind change, clear and delivery; persist lastSeenAt-only changes at most every 5 min.

- [ ] **Step 1: Write failing tests** (fake clock, `t.TempDir()` path):
  - `TestBlockTracker_StartsAndUpdatesEpisode`
  - `TestBlockTracker_PlainSuccessClears`
  - `TestBlockTracker_ECHAcceptKeepsEpisodeOpen`
  - `TestBlockTracker_UnobservedExpiresAfter24h` (23h59m: still active; 24h01m: cleared `unobserved`)
  - `TestBlockTracker_RestartThenPlainSuccessDeliversOnce`: Observe, then new tracker on the same path → the active report survives. Plain success → `Report().ClearedBy == "plain_success"`. `MarkDelivered` → `Report() == nil`. A third tracker on the path → nil.
  - `TestBlockTracker_MarkDeliveredIgnoresOtherEpisode`
  - `TestBlockTracker_RequestErrorNeverDowngrades` (web_filter stays web_filter after a proxy-path signature error)
  - `TestBlockTracker_CorruptFileStartsEmpty`
  - `TestBlockTracker_FileMode0600` (skip on Windows)
  - `TestBlockTracker_LastSeenPersistThrottled` (two updates 1 min apart → one write, via file mtime or a write-counter seam)
  - `TestBlockTracker_NilReceiverSafe`
  - `TestBlockTracker_ObserveAndRequestErrorSameFailureOneEpisode`
- [ ] **Step 2: Run** `cd agent && go test -race -count=1 ./internal/heartbeat/ -run TestBlockTracker -v`. Expected: FAIL.
- [ ] **Step 3: Implement** with `sync.Mutex`. Use temp file + `os.Rename`, as in `ech/cache.go persistOnce`, but chmod the temp file to **0600** (cache.go uses 0644). Never hold the lock across file I/O; snapshot under the lock, then write.
  - Single writer: verify with `grep -rn 'heartbeat.New(' agent/` that only the main agent constructs a `Heartbeat`, and put the result in the commit message.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent/heartbeat): persisted control-plane block episodes (#8868)`.

### Task 4: Heartbeat wiring

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (the `HeartbeatPayload` struct near `FilterSignatureSeenAt`; `Heartbeat` construction, where `config.GetDataDir()` is in scope; `observeControlPlane`; `doHeartbeatPost`)
- Test: `agent/internal/heartbeat/control_plane_block_wiring_test.go`

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - Payload field `ControlPlaneBlock *ControlPlaneBlockReport json:"controlPlaneBlock,omitempty"`.
  - `Heartbeat.blocks *blockTracker`, rooted at `filepath.Join(config.GetDataDir(), "control-plane-block.json")`.
  - `classifiedSendFailure(err error, st ech.HostStatus) string`.
- Wiring:
  - `observeControlPlane` also calls `h.blocks.Observe` for `serverHost(serverURL)` and, when set, `serverHost(backupServerURL)`.
  - `doHeartbeatPost`: set `payload.ControlPlaneBlock = h.blocks.Report()` immediately before `json.Marshal`. That one line covers the primary and the backup probe.
  - On a send error: `h.blocks.ObserveRequestError(host, err)`, and the `heartbeat` component message becomes `classifiedSendFailure`. Exact strings:
    - `"control plane blocked by a network security filter (<locationHost or 'no detail'>)"` for web_filter / plaintext_unknown.
    - `"control plane held by a captive portal"`.
    - `"control plane certificate not trusted (issuer: <issuer or 'unknown'>)"`.
    - Otherwise unchanged `err.Error()`.
  - On a 200: `h.blocks.ObserveReached(host, ech.Shared().Status(host).ECHActive)`, then `h.blocks.MarkDelivered(sentReport)`.

- [ ] **Step 1: Write failing tests.**
  - `TestHeartbeatPayload_ControlPlaneBlockOmittedWhenNone` (marshalled JSON has no `controlPlaneBlock` key).
  - `TestDoHeartbeatPost_AttachesFreshReportToBackupProbe`: the primary fails with a filter signature, so the backup body contains `controlPlaneBlock.kind`.
  - `TestDoHeartbeatPost_200DeliversClearedOnce`.
  - `TestClassifiedSendFailure_Strings` (the exact strings above).
  - `TestControlPlaneBlockContractFixture`: this is the cross-language drift guard, replacing a Go-only key list. Create the shared fixture `agent/internal/heartbeat/testdata/control_plane_block_contract.json` as `{ "valid": [...], "invalid": [...] }` with payload objects.
    - The Go side asserts that every `valid` entry round-trips through `ControlPlaneBlockReport` unchanged.
    - The Go side also asserts that every `ech.SanitizeHost` / issuer-sanitizer output it can produce matches the fixture's `hostPattern` / `issuerPattern` strings.
    - Task 7's Vitest reads the same file (`../../../../agent/internal/heartbeat/testdata/control_plane_block_contract.json` from the API test, via `fs.readFileSync`). Every `valid` entry must parse `valid`, and every `invalid` entry must parse `invalid`.
- [ ] **Step 2: Run** `cd agent && go test -race -count=1 ./internal/heartbeat/ -run 'ControlPlaneBlock|ClassifiedSendFailure|AttachesFreshReport|DeliversCleared' -v`. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** the Step 2 command, then `go test -race -count=1 ./internal/heartbeat/...`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent/heartbeat): report control-plane block episodes (#8868)`.

### Task 5: Blocked-liveness marker (no watchdog restart churn)

**Files:**
- Modify:
  - `agent/internal/state/state.go`: add `ControlPlaneBlockedAt time.Time json:"control_plane_blocked_at,omitempty"` and `UpdateControlPlaneBlocked(path string, t time.Time) error`; zero it in `UpdateHeartbeat` like `ServerUnavailableAt`.
  - `agent/internal/ipc/message.go`: `StateSync.ControlPlaneBlockedAt string json:"controlPlaneBlockedAt,omitempty"`.
  - `agent/internal/heartbeat/server_unavailable_liveness.go`: `noteControlPlaneBlockedLiveness()`, with the same state-file + IPC flow as `noteServerUnavailableLiveness`. Its WARN is logged once per streak, not per call, because a blocked agent fails every tick for days.
  - `agent/internal/heartbeat/heartbeat.go`: in the `doHeartbeatPost` error path, call it when `ech.IsFilterSignature(err)` or `h.blocks.Current(host)` is a plaintext kind.
  - `agent/internal/watchdog/checks.go`: every place #8934 touched.
    - `lastSyncedControlPlaneBlocked`, `NoteControlPlaneBlocked(t)`, `LastKnownControlPlaneBlocked(s)` (mirror ~L289-305), and `AgentControlPlaneBlockedAlive`.
    - Include it in `AgentAlive`.
    - **Add it as a staleness reference in `CheckHeartbeatStaleness`** (~L364-376).
    - **Add a new `StaleControlPlaneBlocked` decision in `EvaluateStaleHeartbeat`** (~L466-480), checked right after `StaleServerUnavailable`. The restart decision lives here, not in `AgentAlive`.
  - `agent/cmd/breeze-watchdog/main.go`: every site that names the server-unavailable marker.
    - The `case watchdog.StaleServerUnavailable` journal branch (~852) and the `decision != StaleServerUnavailable` guard (~868).
    - The `AgentAlive` per-marker log fields (~645, ~1025-1029) and the `LastKnownServerUnavailable` log line (~860).
    - `verifyDeadline` (~1276).
    - The StateSync handler (~1152 journal field, ~1175 parse + note).
    - Find them all with `grep -n 'ServerUnavailable' agent/cmd/breeze-watchdog/main.go agent/internal/watchdog/checks.go`; each hit gets its `ControlPlaneBlocked` twin or a stated reason it does not.
- Test: the existing `*_test.go` beside each file

**Interfaces:**
- Produces: `func (h *HealthChecker) AgentControlPlaneBlockedAlive(s *state.AgentState) bool` (fresh within `staleThreshold`) and the decision constant `StaleControlPlaneBlocked`.
- Do **not** add it to the untrusted-certificate case. A self-hosted cert fix is the case where a restart after the fix is harmless; only the plaintext signature holds restarts.

- [ ] **Step 1: Write failing tests.**
  - `TestUpdateControlPlaneBlocked_PreservesLastHeartbeat`
  - `TestUpdateHeartbeat_ZeroesControlPlaneBlocked`
  - **`TestEvaluateStaleHeartbeat_FreshControlPlaneBlockedHoldsRestart`**: a stale heartbeat plus a fresh marker → `StaleControlPlaneBlocked`, not `StaleRestart`. This is the discriminating test.
  - `TestEvaluateStaleHeartbeat_StaleControlPlaneBlockedRestarts`
  - `TestCheckHeartbeatStaleness_UsesControlPlaneBlockedReference`
  - `TestAgentAlive_FreshControlPlaneBlockedMarker`
  - `TestNoteControlPlaneBlockedLiveness_SendsStateSyncWithoutLastHeartbeat`
  - `TestNoteControlPlaneBlockedLiveness_WarnsOncePerStreak`
  - A watchdog-main StateSync test mirroring the `ServerUnavailableAt` one
- [ ] **Step 2: Run** `cd agent && go test -race -count=1 ./internal/state/ ./internal/watchdog/ ./internal/heartbeat/ ./cmd/breeze-watchdog/ -run 'ControlPlaneBlocked' -v`. Expected: FAIL.
- [ ] **Step 3: Implement** by mirroring #8934 at every site the grep lists. An older watchdog ignores the field, and LastHeartbeat stays empty.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent): blocked-control-plane liveness marker holds watchdog restarts (#8868)`.

### Task 6: W1 gate, lab recipe, PR

**Files:**
- Modify: `docs/superpowers/plans/2026-10-16-agent-ech-lab.md` (§1: the expected WARN attributes, the `controlPlaneBlock` body and `control-plane-block.json`; add §1b with a self-signed TLS listener → `untrusted_certificate`, and a 511 listener → `captive_portal`)

- [ ] **Step 1:** `cd agent && go vet ./... && go test -race ./internal/ech/... ./internal/heartbeat/... ./internal/state/... ./internal/watchdog/... ./internal/ipc/... ./cmd/breeze-watchdog/...`. Record the pass counts from the real output.
- [ ] **Step 2:** `cd agent && GOOS=windows go build ./... && GOOS=darwin go build ./...`. Expected: exit 0.
- [ ] **Step 3:** Open W1 against main: `feat(agent): detect and report control-plane blocks (#8868)`, with body `Refs #8868`. No `Closes`, because W2 carries the user-facing half.

## W2 — API and web

### Task 7: API parse, write plan and view

**Files:**
- Create: `apps/api/src/services/controlPlaneBlockHealth.ts`, `apps/api/src/services/controlPlaneBlockHealth.test.ts`
- Modify: `apps/api/src/routes/agents/schemas.ts` (add `controlPlaneBlock: z.unknown().optional()` beside `watchdogInstall`), `apps/api/src/routes/agents/heartbeat.ts` (apply beside `planWatchdogInstallWrite` ~1228; **not** in the watchdog branch that returns early ~1065)

**Interfaces:**
- Produces:
  ```ts
  export const CONTROL_PLANE_BLOCK_KINDS = ['web_filter','captive_portal','plaintext_unknown','untrusted_certificate'] as const;
  export type ControlPlaneBlockKind = (typeof CONTROL_PLANE_BLOCK_KINDS)[number];
  export interface ControlPlaneBlockRecord { kind; host; firstSeenAt; lastSeenAt; clearedAt?; clearedBy?; httpStatus?; locationHost?; certIssuer?; reachableViaEch: boolean; reportedAt: string; staleAt?: string }
  export type ParsedControlPlaneBlock = { status: 'absent' } | { status: 'invalid' } | { status: 'valid'; value: ... };
  export function parseControlPlaneBlock(raw: unknown): ParsedControlPlaneBlock; // zod .strict(), regexes from D3
  export function planControlPlaneBlockWrite(row: { controlPlaneBlockKind: string | null; controlPlaneBlock: ControlPlaneBlockRecord | null }, parsed: ParsedControlPlaneBlock, echActive: boolean | undefined, now: Date): { controlPlaneBlockKind?: string | null; controlPlaneBlock?: ControlPlaneBlockRecord | null };
  export interface ControlPlaneBlockNotice { state: 'active' | 'cleared'; kind; host; firstSeenAt; lastSeenAt; clearedAt?: string; httpStatus?: number; locationHost?: string; certIssuer?: string; reachableViaEch: boolean }
  export function deriveControlPlaneBlockNotice(row, now: Date): ControlPlaneBlockNotice | null;
  ```
  A pure module: no DB, `now` injected, the same invariants comment as `watchdogInstallHealth.ts`.

- [ ] **Step 1: Write failing tests** in `controlPlaneBlockHealth.test.ts`:
  - parse: valid full; extra key → invalid; bad kind → invalid; `locationHost` `"Bad Host"` → invalid; `httpStatus` 99/600 → invalid; `certIssuer` 65 characters → invalid.
  - plan:
    - absent + nothing stored → `{}`.
    - absent + active stored, reportedAt 1h59m ago → `{}`.
    - absent + active stored, reportedAt 2h01m ago → `{controlPlaneBlockKind: null, controlPlaneBlock: {...staleAt}}`.
    - invalid → `{}` (never clears).
    - new active → kind set + record.
    - same active re-asserted within 1 h → `{}`.
    - same active after 1h01m → reportedAt refresh.
    - `echActive` flips → write.
    - cleared → kind null + clearedAt.
    - same cleared again → `{}`.
    - agent times one year old or in the future → clamped into [now−30 d, now].
  - view: active → state active; cleared 6 d ago → cleared; cleared 8 d ago → null; stale → null.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/controlPlaneBlockHealth.test.ts`. Expected: FAIL.
  - Add a contract-fixture test: read `agent/internal/heartbeat/testdata/control_plane_block_contract.json` (Task 4). Every `valid` entry → `status: 'valid'`; every `invalid` entry → `status: 'invalid'`.
- [ ] **Step 3: Implement** the service, then wire `heartbeat.ts`: `Object.assign(deviceUpdates, planControlPlaneBlockWrite(device, parseControlPlaneBlock(data.controlPlaneBlock), data.echActive, new Date()))`, beside the watchdogInstall line. The `device` row there comes from `db.select().from(devices)` (all columns, verified), so no select edit is needed.
- [ ] **Step 4: Add the route test** `apps/api/src/routes/agents/heartbeat.controlPlaneBlock.test.ts` (pattern: `heartbeat.ech.test.ts`): a beat with a valid object → the device update carries both columns; a garbage object → 200 and no column write; the watchdog-role beat → no write. Run it plus `npx vitest run src/routes/agents/schemas.heartbeatTolerance.test.ts src/routes/agents/heartbeat.ech.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): persist agent-reported control-plane block episodes (#8868)`.

### Task 8: Columns, migration, export policy, device responses

**Files:**
- Create: `apps/api/migrations/2026-12-31-230000-device-control-plane-block.sql`
- Modify:
  - `apps/api/src/db/schema/devices.ts`, after `watchdogInstallSince`: `controlPlaneBlockKind: varchar('control_plane_block_kind', { length: 24 })` and `controlPlaneBlock: jsonb('control_plane_block').$type<ControlPlaneBlockRecord>()`.
  - `apps/api/src/services/tenantExportPolicyRegistry.ts`, the devices `tablePolicy(...)` line ~441: `control_plane_block_kind` → `included`, `control_plane_block` → `excludedOpen`. Add a comment block beside the #8620 one (~429).
  - `apps/api/src/routes/devices/core.ts`:
    - List: follow the explicit `helperInstallIssue` select (~1359) and mapper (~1578) to add `controlPlaneBlockKind`.
    - Detail (~1793): `controlPlaneBlock: deriveControlPlaneBlockNotice(device, new Date())`.
    - **Do not** add either raw column to `PUBLIC_DEVICE_FIELDS` (`helpers.ts`). `helpers.test.ts` ~392 asserts that the watchdogInstall raw columns stay out, so extend that assertion to the two new columns.
- Test: a new `apps/api/src/services/tenantExportPolicyRegistry.controlPlaneBlock.test.ts` (template: `tenantExportPolicyRegistry.watchdogInstall.test.ts`) and a new `apps/api/src/routes/devices/core.controlPlaneBlock.test.ts` (template: `core.watchdogInstall.test.ts`).

- [ ] **Step 1: Write the migration.** Two `ALTER TABLE devices ADD COLUMN IF NOT EXISTS` statements. A `DO $$` block adds `devices_control_plane_block_kind_chk CHECK (control_plane_block_kind IS NULL OR control_plane_block_kind IN (...4 kinds...))` only if absent in `pg_constraint`. No inner `BEGIN/COMMIT`, no row writes (so no `breeze.scope`), no RLS change (the policies are table-level, already on `devices`). Read `apps/api/migrations/README.md` first.
- [ ] **Step 2: Write failing tests.**
  - `core.list-response-shape.test.ts`: list rows carry `controlPlaneBlockKind` and do **not** carry `controlPlaneBlock` (mirror its watchdogInstall-not-on-list case ~477).
  - `core.controlPlaneBlock.test.ts`: the detail response has `controlPlaneBlock`, null for a clean device and a notice for a blocked one.
  - The export-registry test.
  - The `helpers.test.ts` exclusion.
  
  Run them. Expected: FAIL, then PASS after Step 3.
- [ ] **Step 3: Apply the schema / registry / helpers / core edits.**
- [ ] **Step 4: Run** `bash scripts/check-migration-naming.sh` and `pnpm db:check-drift`, both against a per-worktree stack (`pnpm wt-stack`: copy root `.env`, blank AI keys, `BREEZE_WORKSPACE_ENABLED=false`, a free `BREEZE_DOCKER_SUBNET`). Then run the export-policy contract and org-cascade suites per `docs/agents/testing.md` (Integration Tests job; `pnpm test` does not run them). Expected: green. Tear the stack down.
- [ ] **Step 5: Commit** `feat(api): devices.control_plane_block columns + export policy (#8868)`.

### Task 9: Device notice, list badge, locales

**Files:**
- Modify: `apps/web/src/components/devices/DeviceInfoTab.tsx` (`ControlPlaneBlockNotice({ block }: { block: DeviceInfo["controlPlaneBlock"] })`, rendered beside `<WatchdogInstallNotice>` ~1335; extend the `DeviceInfo` type), `apps/web/src/components/devices/DeviceList.tsx` (a badge next to the helperInstallIssue badges ~1983/2368, shown when `controlPlaneBlockKind` is non-null), `apps/web/src/components/devices/deviceRowTransform.ts` (map the field), 8 × `apps/web/src/locales/*/devices.json`
- Test: `apps/web/src/components/devices/DeviceInfoTab.test.tsx`, a new `DeviceList.controlPlaneBlock.test.tsx` (pattern: `DeviceList.helperInstallIssue.test.tsx`)

**Copy (en, exact; keys under `deviceInfoTab.controlPlaneBlock.*` and `deviceList.controlPlaneBlockBadge`):**

| Key | Text |
|---|---|
| `title` | Blocked by a network filter (all plaintext kinds) |
| `titleUntrustedCertificate` | Server certificate not trusted |
| `web_filter` | A network security filter on this device's network is answering in place of the Breeze server ({{locationHost}}). This is usually an ISP gateway security feature, a firewall web filter, or a network sign-in page. |
| `captive_portal` | This device's network is holding connections at a sign-in (captive portal) page. |
| `plaintext_unknown` | Something on this device's network answered the Breeze connection with plain HTTP instead of TLS. |
| `untrusted_certificate` | The connection to the Breeze server presented a certificate this device does not trust (issued by {{certIssuer}}). This is usually TLS inspection by a firewall or proxy, a certificate problem on a self-hosted server, or an out-of-date trusted-root store on this device. Breeze will not bypass it. |
| `viaEch` | Currently reachable via Encrypted Client Hello. |
| `cleared` | Was blocked from {{from}} to {{to}}. |
| `howToFix` | How to fix |
| `noDetail` | no detail |
| `deviceList.controlPlaneBlockBadge` | Network filter |
| `deviceList.controlPlaneBlockBadgeCertificate` | Certificate not trusted |

- The `howToFix` link is `${DOCS_BASE_URL}/agents/advanced-install/#blocked-by-a-network-filter`, with `DOCS_BASE_URL` from `@breeze/shared` (`packages/shared/src/utils/docsMapping.ts`). No device notice has a shared docs-link helper today.
- When `locationHost` or `certIssuer` is absent, interpolate `noDetail`.
- `locationHost` and `certIssuer` come from the network, so an attacker on the path controls them. Render them as plain interpolated text only: never as a link, never through `Trans` components or `dangerouslySetInnerHTML`. Use i18next's default escaping.

- [ ] **Step 1: Write failing tests:**
  - Each kind renders its copy and the `howToFix` link. `untrusted_certificate` uses `titleUntrustedCertificate` and the certificate badge.
  - A `locationHost` of `<img src=x onerror=alert(1)>` renders as literal text.
  - Active with `reachableViaEch` shows `viaEch`.
  - Cleared shows `cleared`.
  - Null renders nothing.
  - The list badge shows for a non-null kind and is absent for null.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/devices/DeviceInfoTab.test.tsx src/components/devices/DeviceList.controlPlaneBlock.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the component, the badge and all 8 locales (real translations).
- [ ] **Step 4: Run** the Step 2 command plus `npx vitest run src/lib/i18n src/locales/humanizedKeyRegression.test.ts src/lib/__tests__/no-silent-mutations.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): show control-plane block notice and badge (#8868)`.

### Task 10: Installer one-liner, docs, W2 gate, PR

**Files:**
- Modify: `apps/web/src/lib/installCommands.ts`, `apps/web/src/lib/installCommands.test.ts`, `apps/docs/src/content/docs/agents/advanced-install.mdx`

- [ ] **Step 1: Write failing tests** in `installCommands.test.ts`:
  - The Windows command's metadata `catch` contains `$($_.Exception.GetBaseException().Message)` and `a captive portal or web filter may be intercepting this network`.
  - The unix `[ERROR]` echo contains `a captive portal or web filter may be intercepting this network`.
  - The existing PowerShell-parse/escaping tests still pass.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/lib/installCommands.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The Windows catch becomes `catch{throw "Breeze: could not fetch release integrity metadata from ${apiUrl} ($($_.Exception.GetBaseException().Message)) - a captive portal or web filter may be intercepting this network; refusing to install without a trusted checksum"}`. The unix echo (L39, which uses an em dash; keep it) appends ` A captive portal or web filter may be intercepting this network.` In the docs, add `### Blocked by a network filter` under the ECH section (anchor `blocked-by-a-network-filter`). It explains the four kinds in the same neutral terms, says what the device page shows, and gives the generic fix: allow the domain in the gateway/firewall feature or turn the feature off, or move the device to another network. For TLS inspection, add a bypass rule for the Breeze host on the inspecting device. Breeze never bypasses certificate checks. No ISP account steps, no customer data.
- [ ] **Step 4: Run** the Step 2 command. Then run the full W2 gate:
  - `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit; echo exit=$?` (read the exit code; never pipe to tail).
  - The same for `apps/web`.
  - `pnpm --filter @breeze/api test` and `pnpm --filter @breeze/web test`, in small batches if the host is loaded.
  
  Expected: exit 0 and green. Record the counts from the real output.
- [ ] **Step 5: Commit** and open W2 against main: `feat: surface control-plane blocks on the device page (#8868)`, body `Closes #8868` only if W1 has merged; otherwise `Refs #8868`. Fill in the settings-rule-9 checkbox as "not a setting".

## W3 — Partner alert (optional, separate PR)

### Task 11: `control_plane_blocked` monitor kind

**Files** (re-verify at W3 start with `grep -rn "'time_sync'" apps/api/src packages/shared/src apps/web/src`; this list mirrors the timeSync kind):
- Create:
  - `apps/api/src/services/alertConditions/handlers/controlPlaneBlocked.ts` (+test)
  - `apps/api/src/services/monitors/kinds/controlPlaneBlocked.ts`
  - Migration `apps/api/migrations/<next free slot after W2's>-monitor-kind-control-plane-blocked.sql`: `ALTER TYPE monitor_kind ADD VALUE IF NOT EXISTS 'control_plane_blocked';` (template: `2026-11-10-110100-monitor-kind-time-sync.sql`)
- Modify:
  - `apps/api/src/db/schema/monitorDefinitions.ts`: the kind enum, ~50-66.
  - `packages/shared/src/validators/monitors.ts`: the kind list ~36, and `monitorConditionSchemas.control_plane_blocked = z.object({ kinds: z.array(z.enum(CONTROL_PLANE_BLOCK_KINDS)).min(1).optional() }).strict()` (~298). Move `CONTROL_PLANE_BLOCK_KINDS` to `@breeze/shared` and re-export it from the Task 7 service.
  - `apps/api/src/services/alertConditions/types.ts`: the condition type and the union, ~187/219.
  - `apps/api/src/services/alertConditions/index.ts`: handler registration, ~34/55/64.
  - `apps/api/src/services/monitors/kinds/index.ts` and its test map (~37).
  - The web monitor-kind label map found by the grep above. Add locales if that map is localized.
- **No built-in entry.** `BuiltInMonitorDefault` has no enabled/disabled field, and adding one is out of scope. The kind ships opt-in; whether to add a built-in is a Todd decision (see the result file).

**Interfaces:** the handler reads `devices.controlPlaneBlockKind` for the device. The status is `breaching` when it is non-null (and in `kinds` when given) and `ok` when it is null. `agentDelivered: false`, `alertCategory: 'system'`, `defaultSeverity: 'low'`. Title: `Network filter blocking {{deviceName}}`.

- [ ] **Step 1: Write failing tests:** handler breaching / ok / kinds filter; the `kinds/index.test.ts` registry includes the kind; the shared schema accepts `{}` and `{kinds:['web_filter']}`, and rejects `{kinds:[]}` and unknown keys.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/alertConditions src/services/monitors`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the Step 2 command, the `packages/shared` tests, and any AI-tool monitor-schema tests the grep surfaces (`aiToolSchemas*.test.ts`). Run `apps/api/src/__tests__/mcp-coverage.test.ts` only if a route was added (none expected). Expected: PASS.
- [ ] **Step 5: Commit**, then open W3: `feat(monitors): control-plane blocked monitor kind (#8868)`, `Refs #8868`.

---

## Release and lab gate (owner-run, not agent-run)

- The local simulations (a 302 listener, a 511 listener, a self-signed TLS listener) are unit-tested in Tasks 1–2, so the lab adds only real-network proof. Use the recipe on #8869, plus `2026-10-16-agent-ech-lab.md` §1/§1b as updated in Task 6. The rig was torn down 10-17, so the owner rebuilds it.
- Expected on a blocked network:
  - One WARN with `kind=web_filter location_host=<vendor host>`.
  - `control-plane-block.json` appears.
  - With ECH engaged: the device page shows the notice and "reachable via Encrypted Client Hello".
  - After the filter is turned off, the notice switches to "Was blocked from … to …", and the file empties after the next 200.
- **Never run a lab agent on a host that has the installed agent.**
- W1 ships to customer machines. Promote only after the lab passes, alongside the four agent lab checks already owed before promote.

## Exit checklist

- [ ] W1:
  - `go test -race` green for ech, heartbeat, state, watchdog, ipc and `cmd/breeze-watchdog`.
  - Windows and darwin cross-builds pass.
  - No Location path in any log, verified by `TestDial_FilterWarnHasNoPath`.
- [ ] W2:
  - Migration sorts after the newest on main, and the naming hook passes.
  - `db:check-drift` is clean.
  - Export-policy and org-cascade integration suites pass on a wt-stack, and the stack is torn down.
  - API and web `tsc` exit 0 at a 12 GB heap.
  - The 8 locales are at parity.
  - `no-silent-mutations` is unchanged and green.
- [ ] No ISP/customer specifics, real hostnames or IPs in code, tests, docs or PR text.
- [ ] #8870 owner: `blockTracker.Current` + `BlockKind.PlaintextSignature()` is the trigger contract (D4).

## Deferred (not in this plan)

- Active plaintext probe (D1). Reconsider only if the lab shows the capture missing the status line.
- Watchdog-failover delivery of the episode (D4, codex disagreement): a second reporter needs merge ordering.
- Server-side episode history (a new table with full tenancy registration). The projection keeps only the latest episode.
- DNS-vs-DoH comparison and canary probes (D1).
- An explicit server ack (`controlPlaneBlockAck`) in place of 200-as-acceptance (D4, known loss mode).
- A built-in `control_plane_blocked` monitor, which needs an enabled-by-default field on `BuiltInMonitorDefault` (Task 11).
- Fleet-level "N devices blocked" view for the owner. The existing Prometheus counters cover the owner. A partner aggregate could be a connection-health source later.
