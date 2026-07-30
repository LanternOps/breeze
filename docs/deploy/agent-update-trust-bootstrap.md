# Agent update trust bootstrap (self-host)

This page covers two related topics for self-hosted Breeze deployments:

1. How agent-update trust works on self-host (`BINARY_SOURCE=local`).
2. How to recover a fleet stuck on v0.65.7 / v0.65.8 after upgrading to v0.65.9.

Hosted SaaS users (us.2breeze.app / eu.2breeze.app) do not need to read this — agents trust the LanternOps build-time key directly.

## How trust is established

Agent updates are gated by an Ed25519-signed release manifest. The agent verifies each downloaded manifest against a set of trusted public keys before installing. Self-host needs a way to deliver a deployment-specific public key to every agent so that locally-signed manifests verify cleanly.

| Step | Mechanism |
|---|---|
| API generates Ed25519 signing keypair on first boot | `manifest_signing_keys` table; private key encrypted with `APP_ENCRYPTION_KEY` |
| `syncBinaries` signs every locally-registered manifest | Active key from `manifest_signing_keys`; written to `agent_versions.releaseManifest` / `manifestSignature` / `signingKeyId` |
| API exposes the public key to agents | `manifestTrustKeys` field on enrollment response (`POST /agents/enroll`) and on every heartbeat response (`POST /agents/:id/heartbeat`) |
| Agent persists the pubkey TOFU-style | `pinned_manifest_pub_keys: ["<keyId>:<base64-pubkey>", ...]` in `agent.yaml` |
| Agent merges pinned keys with the embedded LanternOps key when verifying | `(*Updater).trustedManifestKeys()` |

A new self-host install is fully automatic: enrollment lands a pinned key, and the very first manifest the agent verifies works.

## Recovering a fleet stuck after the v0.65.7 → v0.65.8 → v0.65.9 path

If you upgraded through v0.65.8 with `BINARY_SOURCE=local`, agents are stuck on v0.65.7 (or v0.65.8) because:

- v0.65.8 introduced strict manifest-signing checks on the API (#568). The local-binary sync path didn't sign anything (#625), so the API returned 409 to every agent's update poll.
- v0.65.7 / v0.65.8 agents have no per-deployment pin mechanism. Even after v0.65.9 starts signing manifests, those agents would reject the new signature because they only trust the LanternOps build-time key.

After deploying v0.65.9 to your API:

```sh
# From inside the API container (or your tooling host with DATABASE_URL set):
pnpm recover:stuck-agents               # dry-run shows which devices would be queued
pnpm recover:stuck-agents -- --apply    # actually queue dev_update commands
```

The script:

- Finds devices on any version in `BROKEN_AGENT_VERSIONS` (currently `0.65.5`, `0.65.6`, `0.65.7`, `0.65.8`).
- Queues a `dev_update` command pointing at the latest registered binary for each device's platform/arch. `dev_update` uses `UpdateFromURL`, which verifies a checksum the API computed during sync rather than the manifest signature — so it bypasses the broken-trust paths entirely.
- Is idempotent — re-running won't double-queue commands.
- Refuses to dispatch when the latest registered binary is itself a broken version (operator forgot to bump `BREEZE_VERSION` past 0.65.8).

Agents pick up the command on their next heartbeat (~60s) and self-update. Once on v0.65.9 they receive the per-deployment pubkey via heartbeat, pin it, and resume normal auto-update from there.

If you can't deploy v0.65.9 yet, set `BREEZE_VERSION=0.65.7` in `/opt/breeze/.env` and `docker compose up -d binaries-init api web` — the fleet will sit on v0.65.7 quietly without 409 loops.

> **Note (as of 2026-05-10)**: the v0.65.7 fallback works only while
> v0.65.7 binaries are still in your local `breeze_binaries` volume.
> If you've garbage-collected old versions, this fallback no longer
> applies — your only recovery path is forward to v0.65.9.

## What this protects against (and what it doesn't)

The per-deployment signing key + TOFU pinning is meaningfully better than
shipping unsigned manifests, but the trust posture is narrower than the
hosted-SaaS model where the LanternOps build-time key is baked into agent
binaries:

| Attack | Defense |
|---|---|
| Tampering with `agent_versions.downloadUrl` via SQL injection or RLS bypass | Defended — manifest signature verifies the URL pinned at sign time |
| Read-only DB compromise + replay of an old signed manifest | Partially defended — manifests pin version + checksum + size; replaying yesterday's manifest for today's binary fails the checksum check |
| API write access without the signing key, attempting to rotate in an attacker pubkey | Defended — TOFU rejects rotation; agents log a SECURITY error |
| Compromise of the API host (signing key + APP_ENCRYPTION_KEY both live there) | **Not defended.** An attacker with host access can sign arbitrary manifests with the deployment key. Rotate keys + audit binary checksums after any host compromise. |
| MITM between API and agent | Defended by TLS at the transport layer; signing is defense in depth |

Self-host operators who want stronger separation should run a build pipeline
that signs manifests with an HSM-backed key and pin the corresponding pubkey
via `BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS`.

### TOFU pinning is frozen after the first key

An agent pins exactly ONE deployment key and then stops accepting new trust
material. `config.PinManifestKeys` implements the whole state machine:

- **No deployment key pinned yet** → the first well-formed key is accepted (enrollment or heartbeat; `config.BootstrapPinnedManifestKeys` applies the same rule to the enrollment response). The embedded LanternOps release root does not count as a deployment key, so every agent still gets its one bootstrap.
- **Same `keyId`, same pubkey** → idempotent; the config file is not even rewritten.
- **Same `keyId`, different pubkey** → rejected (`ErrManifestTrustRotationRejected`). The agent logs a `SECURITY` error and suspends auto-update until the conflict resolves or the agent restarts. This is the rotation-attack defense.
- **Any previously unseen `keyId`** (including a second one delivered in the same payload) → rejected (`ErrManifestTrustExpansionRejected`), logged as a `SECURITY` error. Auto-update is not suspended: the already-pinned key is untouched and still valid.

Every rejection is atomic — `agent.yaml` is left byte-for-byte unchanged.

This closes the previous behaviour, where a new `keyId` was silently appended:
an attacker with host-level write access to the API could insert a row into
`manifest_signing_keys`, have it delivered via the next heartbeat, and have
agents pin and then trust it. Agents now refuse the new key outright.

Verification is also bound to the key ID: the download response's
`signingKeyId` selects the ONE key the signature is checked against. An unknown
ID, a malformed ID, or a signature made by a *different* key the agent
legitimately trusts all fail closed — the agent never falls back to trying its
other keys. A response that omits `signingKeyId` is verified against the whole
trusted key set and logs one bounded warning per process; setting
`require_manifest_signing_key_id: true` in `agent.yaml` turns that case into a
hard failure (`manifest signing key ID required`).

Operators should still be aware:
- Retiring a `keyId` server-side (`status='retired'`) stops the API from delivering it but does **not** cause agents to remove it from their local pin file. Re-enrollment is currently the only way to clear the agent's pin set.
- A malformed entry in `pinned_manifest_pub_keys` is no longer skipped — it makes the whole trust set unusable and updates fail closed with a bounded error, rather than silently demoting the deployment back to the embedded vendor root.

## What if I want to rotate the per-deployment key?

Today: not supported, and the previous "just add a new `key_id`" recipe no
longer works — agents reject an unseen `keyId` with
`ErrManifestTrustExpansionRejected`, because "the API can introduce a new key"
was itself the attack. Introducing a key without re-enrolling requires a signed
delegation from the already-pinned key; that protocol is tracked separately and
is not in this release.

Until then, the only supported ways to change a deployment's key are:

1. Re-enroll the affected agents (clears and re-bootstraps the pin set), or
2. Run an out-of-band signing pipeline and distribute the key via
   `BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS` (use the `<keyId>:<base64>` form so it
   participates in exact-ID verification).

A server pushing a different key for the same `keyId` is still treated as an
attacker and rejected by `config.PinManifestKeys`.
