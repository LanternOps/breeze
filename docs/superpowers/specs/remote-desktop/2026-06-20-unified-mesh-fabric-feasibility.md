# Unified Mesh Fabric — Feasibility Study

**Date:** 2026-06-20
**Status:** Feasibility study (thesis validation) — not an implementation spec
**Author:** Todd Hebebrand + Claude

## Purpose

Prove or disprove a single thesis: **one network fabric can serve all of —
ZTNA, peer-to-peer patch/file distribution, native file sharing, and the
"Virtual Office" concept — built on one shared stack**, rather than four
independent subsystems each reinventing identity, NAT traversal, and relays.

This document does **not** design any one capability. It establishes the shared
substrate, gives a per-capability feasibility verdict, fixes the build order,
and — most importantly — enumerates the redundancy traps where "one stack"
silently degrades into three. Each capability gets its own brainstorm → spec →
plan cycle later.

**Verdict up front: the thesis holds.** Three of the four capabilities are the
same two primitives (authenticated identity + NAT-traversed peer reachability)
applied to different payloads; the fourth (Virtual Office) is a grouping policy
over those primitives. It holds *only if* identity, NAT traversal, and the relay
are built exactly once, and the network is treated as a first-class
tenant-isolation boundary. The single biggest feasibility worry —
self-hosters operating their own relays — is already a solved operational
pattern in the codebase.

## Locked assumptions (from brainstorm)

| Constraint | Decision | Consequence |
|---|---|---|
| **Deployment** | Both hosted and self-hosted, **fully self-contained** (zero Breeze-cloud dependency for self-hosters) | Coordinator + relays ship in the self-host bundle; a self-hoster on a public-IP VPS co-locates a relay |
| **Overlay (L1)** | **Build on `wireguard-go`** — own coordinator + ACL/registry + DERP-style relay | Maximum control + tight integration with mTLS identity and config-policy hierarchy; we own NAT traversal, relay, key exchange |
| **ZTNA client** | A person **must run a dedicated ZTNA client** (native node), not browser-via-gateway | The technician is a first-class fabric node, identified the same way agents are |
| **Relationship to RMM** | ZTNA is **additive, not a replacement** — mTLS (#1688) already hardens today's device-level control-plane access | Fabric is **not** on the critical path for existing RMM access; feasibility bar is "cleanly adds capabilities," not "carries the whole product" |
| **Endpoint-user auth** | Tie in **SSO** so the access decision is **user identity × device identity** | ZTNA becomes identity-aware; ACLs are group-based; reuses existing Entra/Graph group resolution |
| **File distribution** | **Unified** — one content-distribution layer serves both patch distribution and native file sharing | Collapses two phases into one generic layer with two consumers |
| **File-share permissions** | Driven by the **same L0 identity/RBAC** as ZTNA — no separate content-permission system | One identity model governs both reachability and file access |

## Pre-existing building blocks (this is why it's feasible)

| Concern | Already in the codebase |
|---|---|
| Device cryptographic identity | mTLS agent certs in flight — PR #1688 (tenant-status gate on mTLS renew-cert); `agentTokenHash` on `devices` |
| NAT traversal — operational pattern | **coturn** (TURN + STUN) with RFC-5389 time-limited HMAC creds: `generateTurnCredentials` / `getIceServers` in `apps/api/src/routes/remote/helpers.ts` (`TURN_SECRET`, 60–900s TTL, per-session/user/device scope); docs instruct self-hosters to *"Install and configure coturn"* — **self-hosters already run their own relay** |
| User SSO / IdP | M365/Entra SSO (`services/c2cM365.ts`, `routes/c2c/m365Auth.ts`); Cloudflare Access JWT trust + SSO redirect login (PR #1058, `services/cfAccessJwt.ts`) |
| Group membership resolution | OneDrive helper spec: `graph_group` (Entra/M365, server-side via Graph) + `local_ad_group` (on-prem/hybrid, agent-side from local token) — exactly the engine ZTNA/file ACLs want |
| Logged-in user / SID / session | `agent/internal/sessionbroker/session.go`, `agent/internal/collectors/sessions.go` |
| Policy distribution to agents | Config-policy hierarchy (partner→org→site→device_group→device) + priority merge; `ConfigUpdate` in heartbeat |
| Content signing | Release-manifest Ed25519 signing (`RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`) |
| Content/DLP chokepoint | client-ai subsystem DLP gate (reusable pattern for user-sourced file-share content) |
| Tenant isolation rigor | RLS + contract test (`rls-coverage.integration.test.ts`) — the cultural model for a network-layer isolation guard |

## The shared fabric (the actual "one stack")

Three layers. The four capabilities are consumers of these layers, not peers of
each other.

### L0 — Identity (user × device)

The access decision is a **composite of two identities**:

- **Device identity** — mTLS cert/key (#1688). Proves *which managed node*.
- **User identity** — SSO (Entra/OIDC, reusing the existing IdP integrations).
  Proves *which human*, and resolves **group membership** via the OneDrive
  helper's existing `graph_group` (server-side) / `local_ad_group` (agent-side)
  engine.

ACLs are written against **(verified user + group) × (device + posture) ×
Virtual Office zone**, not hand-maintained device lists. This is what turns a
device-mesh into true identity-aware ZTNA, and the **same identity model governs
file-share RBAC** — who may send, receive, or open shared content is decided by
the user's SSO identity/group, not a separate permission system.

The WireGuard keypair is **issued under / bound to** the device mTLS identity:
one enrollment, one revocation, one root of trust feeds the mesh, P2P peer-auth,
and file-share auth alike.

**Graceful degradation (mandatory):** orgs with no IdP configured fall back to
device-only mTLS ACLs. SSO-gating is an *enhancement* of the access decision,
not a hard dependency — otherwise the self-contained constraint breaks for
IdP-less self-hosters.

### L1 — Mesh connectivity

- **Data plane:** `wireguard-go` (userspace — no kernel module; cross-platform
  Win/macOS/Linux) embedded in the agent and the ZTNA client.
- **Coordinator (Breeze-owned):** key registry, peer-config + ACL distribution
  delivered through the **config-policy hierarchy**, Virtual Office zone
  resolution. Authenticated by L0 mTLS identity. Ships in the self-host bundle.
- **NAT traversal:** **reuse STUN** (endpoint discovery for hole-punching) and
  the **coturn operational model** (ephemeral HMAC creds, self-hoster-runs-it,
  the existing DO footprint). **Caveat — TURN ≠ DERP for WireGuard:** WireGuard
  doesn't speak ICE/TURN (it fires UDP at an `endpoint:port`), so the *relay*
  fallback needs a small **DERP-style packet relay** (Tailscale's model). STUN +
  ops model + creds are reusable; the WG-specific relay is net-new but small,
  and self-hosters already run a relay box today.

### L2 — Coordination / control

Metadata plane: swarm state for content distribution, file-transfer signaling.
**The L2 decision resolves by sequencing** (see Build order): ZTNA needs almost
no L2; content distribution is the first real consumer. **Do not add NATS up
front** — reuse the existing WS/coordinator until swarm fan-out is the
demonstrated driver, then decide.

### L3 — Bulk data

Direct peer transfer over L1 paths (LAN-direct within a Virtual Office), relayed
only on traversal failure.

## Per-capability feasibility

### 🟢 ZTNA — foundation-defining (build first)

ZTNA *is* L0 + L1: composite identity + NAT-traversed reachability + ACLs. The
native client is a `wireguard-go` node keyed by the same identity, ACL'd by the
coordinator. The only net-new work beyond the fabric is the **ACL policy model**
(who-reaches-what), which maps onto the config-policy hierarchy. Independently
sellable (competitors charge for exactly this). **Risk: low–medium**, and it is
the unavoidable fabric work regardless.

### 🟢 Virtual Office — an L1 policy primitive, not a subsystem

A zone = `{ public egress IP(s), associated internal CIDRs }`. The coordinator
already learns each node's reflexive/public address from STUN; two nodes that
resolve to the same zone get LAN-direct WireGuard paths. The **same zone object
scopes both ZTNA reachability and content-distribution swarm membership.** This
is the refinement over Action1 (which peers only within one subnet): a Virtual
Office peers *across* multiple internal subnets behind one circuit.
**Risk: low** — a grouping table + a resolution rule in the coordinator.

### 🟡 Unified content distribution — patch + file sharing (one layer, two consumers)

Patch distribution and native file sharing are the **same primitive**: move
bytes efficiently between fabric nodes, scoped by policy. L2 becomes a generic
**content-distribution coordinator** keyed on `(content-hash, recipient set,
Virtual Office scope)`. Two consumers:

- **Patch distribution** — system-sourced, **pre-signed** artifact (verified
  against `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`), fanned to a device cohort.
- **File sharing** — user-sourced blob, **hashed on ingest** (no release key to
  verify against), to a recipient set; **permissions/RBAC driven by L0 identity**
  (SSO user + group).

Same segmentation, swarm, tenant-scoped cache, and direct-path transport. A 1:1
file transfer is just a swarm of size one. This **collapses the former Phase 2
(P2P) + Phase 3 (file share) into one build**; file sharing becomes a thin
source + UI on top, not a parallel transport.

**Price of unifying (must be designed in):** user-sourced arbitrary content
raises the isolation/abuse/DLP bar far above patch-only. Patches are
system-sourced and signed; letting a user distribute arbitrary bytes to a
recipient set means the network-layer tenant boundary (trap #6) plus a
**content/DLP chokepoint** (reuse the client-ai DLP pattern) matter much more.
**Risk: medium** — the swarm coordinator + cache isolation + DLP gate are real
engineering, though none of it is novel.

## Build order

Each phase forces the next to be correct.

- **Phase 0 — Identity (largely in flight).** Extend mTLS (#1688) so the same
  identity issues/binds WireGuard keys for agents, ZTNA clients, and service
  nodes; wire SSO into the access decision (user × device) with group resolution
  reused from the OneDrive helper. Prerequisite for everything.
- **Phase 1 — Fabric MVP + ZTNA.** `wireguard-go` in agent + ZTNA client; the
  coordinator (key registry, peer-config + ACL via config-policy); STUN reuse +
  DERP-style relay. Ship **ZTNA first** — forces the fabric to be correct, is
  independently sellable. **Virtual Office** lands here as the coordinator's
  zone-resolution rule.
- **Phase 2 — Generic content distribution.** L2 swarm coordinator + content
  segmentation/signing (reuse release-manifest signing) + tenant-scoped cache +
  DLP gate. **Patch distribution and file sharing both ship as consumers** of
  this layer.

The historical "Phase 3 native file sharing" is **absorbed into Phase 2**.

## Redundancy traps — where "one stack" silently becomes three

1. **NAT traversal built 3×.** WebRTC's (existing, remote desktop) + the mesh's
   + a P2P-specific one. *Discipline:* the fabric's traversal (STUN reuse +
   DERP) is the only new one; content distribution uses mesh paths, not its own
   hole-punching.
2. **WebRTC-vs-mesh for peer data (reverses the lighter-weight option on
   purpose).** Reusing WebRTC data channels for P2P was the right answer *only
   if not building an overlay*. Since the overlay is being built for ZTNA,
   **content distribution rides the overlay; WebRTC stays remote-desktop-only.**
   Using both = two peer-data systems.
3. **Two relay fleets.** coturn (WebRTC) + DERP (mesh). *Discipline:* co-locate —
   same footprint, same HMAC-cred pattern, self-hoster runs one box; different
   daemons, one operational model.
4. **Multiple identities.** *Discipline:* WireGuard public key issued under / bound
   to the mTLS identity; SSO layered on for the user dimension; one enrollment,
   one revocation; P2P peer-auth and file-share auth both derive from the node
   identity.
5. **The N-channel agent** (WS + WG + NATS + mTLS-HTTP). *Discipline:* WG tunnel
   is the substrate; one logical control channel; bulk over WG; NATS only if/when
   Phase 2 fan-out demands it.
6. **The new tenant-isolation surface RLS does not cover.** The network fabric
   creates a cross-tenant **peering / relay / cache** boundary that RLS cannot
   reach. Customer A's node must never peer with, relay through-to, or pull
   cached segments belonging to B. *Discipline:* isolation in the coordinator
   ACLs + relay + cache is its own enforcement layer and deserves a **contract
   test in the spirit of `rls-coverage`** — a network-layer isolation guard.

## Why the self-contained constraint is met

The hardest requirement (self-hosters run the whole fabric with zero
Breeze-cloud dependency) is satisfied because:

- The coordinator is "just another Breeze service" — it ships in the compose
  bundle next to api/web/postgres/redis and distributes WireGuard configs/ACLs
  the same way it already distributes config policies.
- The relay reuses the **coturn operational pattern self-hosters already run**
  (the DO/public-IP-VPS box, ephemeral HMAC creds). The WG-specific DERP relay
  is a new daemon but the same "self-hoster runs a relay" model.
- Userspace `wireguard-go` needs no kernel module / admin OS dependency on the
  agent.

## Open questions deferred to per-capability specs

- **L2 transport:** dedicated bus (NATS) vs. reuse WS/gRPC — decide at Phase 2
  when swarm fan-out scale is measurable.
- **DERP relay reuse depth:** extend coturn to relay WG UDP via TURN allocations
  vs. a purpose-built DERP daemon — prototype both for the relay path.
- **ZTNA ACL model shape:** how user/group/zone/device-posture predicates compose
  in the config-policy hierarchy.
- **File-share product scope:** push/pull/drop semantics, retention, recipient
  sets — pinned to "Breeze-native transfer between fabric nodes," explicitly
  fenced off from the M365 OneDrive helper (Graph-based, off-fabric).
- **DLP gate placement** for user-sourced content (ingest-time vs. transfer-time).

## Verdict

**The thesis holds.** One fabric — mTLS×SSO composite identity, a `wireguard-go`
mesh, a self-hostable coordinator/relay reusing the coturn pattern — genuinely
serves ZTNA, Virtual Office, P2P patch distribution, and native file sharing,
built **Identity(+SSO) → Fabric + ZTNA → Virtual Office → Generic content
distribution (patch + file-share)**. It holds *only if* identity, NAT traversal,
and the relay are built exactly once, and the network is treated as a
first-class tenant-isolation boundary with its own contract test. The biggest
feasibility worry (self-hosted relays) is already a solved pattern in the stack.
