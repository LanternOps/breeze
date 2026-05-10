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

### TOFU pinning is additive, not exclusive

Once an agent has pinned its first key on enrollment, the pin set grows monotonically:

- **Same `keyId` with a different pubkey** is rejected (`ErrManifestTrustRotationRejected`). The agent logs a `SECURITY` error and suspends auto-update until the conflict resolves or the agent restarts. This is the rotation-attack defense.
- **A new `keyId`** delivered by the API in any subsequent heartbeat is silently appended to the pin set. There is no operator confirmation step, and the agent has no mechanism to reject "unexpected" new keyIds.

What this means in practice: an attacker who gains *host-level write access to the API* (not just DB access) can insert a new row into `manifest_signing_keys`, have it delivered via the next heartbeat, and have agents pin it. Once pinned, the attacker can sign arbitrary manifests under the new keyId and agents will accept them. The TOFU defense only protects against `keyId` *reuse* with a different key — not against entirely new keyIds.

This is within the documented threat boundary (host compromise out of scope), but operators should be aware:
- Retiring a `keyId` server-side (`status='retired'`) stops the API from delivering it but does **not** cause agents to remove it from their local pin file. Re-enrollment is currently the only way to clear the agent's pin set.
- Agents that have been compromise-pinned with an attacker's keyId will continue trusting it indefinitely until re-enrolled.

If you need exclusive (non-additive) pinning, run an out-of-band signing pipeline and pin a single key via `BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS` instead — keys delivered via heartbeat will still be pinned, but the env-pinned key is checked first and is not removable from the in-memory trust set.

## What if I want to rotate the per-deployment key?

Today: not supported automatically. The TOFU pin is intentional — a server pushing a different key for the same `keyId` is treated as an attacker and rejected by `config.PinManifestKeys`. To rotate:

1. Insert a new row into `manifest_signing_keys` (different `key_id`, `status='active'`).
2. Set the old row's `status='retired'`.
3. New manifests are signed with the new key. Agents pick up the new pinned key on their next heartbeat (the heartbeat ack now contains both).
4. Once every agent has both keys pinned, you can stop signing with the old key.

A future release will likely make this an admin command. File an issue if you need it sooner.
