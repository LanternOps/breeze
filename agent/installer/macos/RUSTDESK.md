# RustDesk in the macOS installer

The Nodes Unlimited macOS `.pkg` bundles RustDesk so remote access works
immediately after enrollment, pointed at our self-hosted relay rather than the
public one.

## What we ship, and why we don't build it

We ship **the vendor's official prebuilt release, verbatim**. RustDesk is a
Flutter app; building it from source needs full Xcode, CocoaPods and a
from-source vcpkg tree — days of work, and full Xcode is not on the build
machines. More to the point, a from-source build would be signed by *us*, making
Nodes Unlimited the party vouching for a remote-control binary. The vendor's
release is already signed with a Developer ID Application cert and notarized by
Apple, so taking it as-is is both cheaper and a stronger provenance story.

`build-rustdesk.sh` never re-signs it. Re-signing a notarized third-party bundle
replaces the vendor's signature and invalidates the stapled ticket — it would
turn a trusted binary into one Gatekeeper rejects. For the same reason RustDesk
is **not** in `build-pkg.sh`'s `BINARIES` array, which runs `codesign --force`.

### Pinned version

| | |
|---|---|
| Version | **1.4.9** |
| arm64 (`rustdesk-1.4.9-aarch64.dmg`) | `f7935597b247d42c8f2a2ed71176a9f5868018cd9e1a33b8096418a668c8caf0` |
| amd64 (`rustdesk-1.4.9-x86_64.dmg`) | `fa1129a0635019f9c5841937942cc2b08be028a192f47c009edde7e53812904e` |
| Signing authority | `Developer ID Application: zhou huabing (HZF9JMC8YN)` |

The version and both digests are pinned in `build-rustdesk.sh`. Never track
`latest`: an installer that resolves its third-party payload at build time has no
reproducible output and no way to notice the upstream artifact changing
underneath it.

To bump: change `RUSTDESK_VERSION`, run `EXPECT_SHA256_OVERRIDE=print
./build-rustdesk.sh <arch>` for each arch to print the observed digests, read the
upstream release notes, then paste the digests in. Only ever paste a digest from
a download you performed yourself.

`build-rustdesk.sh` refuses to proceed unless all of these hold: pinned SHA-256
matches, the vendor DMG carries a stapled notarization ticket, and the extracted
bundle passes `codesign --verify --strict --deep`, `spctl -a -t exec`,
`xcrun stapler validate`, the expected team ID, the hardened-runtime flag, a
secure timestamp, and the expected CPU architecture.

Upstream staples the ticket to the **DMG**, not to the `.app` inside it, so the
script staples it onto the extracted bundle itself. Stapling adds a ticket
resource; it does not re-sign, and the signature is re-verified immediately
after.

### Not a universal binary — by design

RustDesk does not need to be universal. The DMG contains
`Nodes Unlimited Installer.app`, which embeds both `nu-agent-amd64.pkg` and
`nu-agent-arm64.pkg` and picks one at runtime (`Architecture.swift`). The Intel
pkg carries Intel RustDesk, the ARM pkg carries ARM RustDesk, and the DMG as a
whole stays universal. Upstream ships separate per-arch DMGs, which fits exactly.

## Relay configuration

RustDesk is pointed at the NU self-hosted hbbs/hbbr relay on Titan01 (Coolify
service `nu-rmm`). Source of truth for the values:
`nodes-unlimited-rmm/docs/rustdesk-production.md`.

**The real values are NOT in this repo.** `bloomingbrands/breeze` is public, and
`CLAUDE.md` forbids committing IP addresses, server hostnames or internal infra
mappings to it. They live in `agent/installer/macos/.env`, which is gitignored
(matched by the bare `.env` rule in the root `.gitignore`). A committed
`.env.example` documents the shape.

```bash
cp agent/installer/macos/.env.example agent/installer/macos/.env
# fill in, then build normally — build-pkg.sh sources it automatically
./build-pkg.sh arm64
```

| Variable | Meaning |
|---|---|
| `NU_RUSTDESK_RELAY_HOST` | **One** variable for the relay host, no port. Titan01's public IP today because Coolify env uses the IP; when DNS is intentional, this is the single line that changes. |
| `NU_RUSTDESK_ID_PORT` | hbbs / rendezvous port, default `21116` |
| `NU_RUSTDESK_RELAY_PORT` | hbbr / relay port, default `21117` |
| `NU_RUSTDESK_PUBLIC_KEY` | The relay's Ed25519 **public** key (`id_ed25519.pub`), base64. Safe to ship in an installer. The private `id_ed25519` must never be referenced or embedded. |

An explicit `export` always beats the file, so CI can inject values without a
`.env` on disk. The relay host's firewall must allow **21115-21119/tcp** and
**21116/udp**.

Setting the host without the key is a **build error**: a relay with no key means
RustDesk connects with authentication disabled. Setting neither is allowed but
warns loudly at build *and* install time — RustDesk then falls back to the
**public rustdesk.com relay**. That is a privacy problem, not a broken machine,
so it warrants a warning rather than a failed rollout on a lab box that must not
be disrupted.

`SKIP_RUSTDESK=1 ./build-pkg.sh <arch>` builds an agent-only pkg for testing.

## Configuration mechanism

On macOS the supported route is the TOML config — the Windows
filename-encoding trick has no macOS analogue. `scripts/postinstall` merges
these into the `[options]` table of `RustDesk2.toml`, preserving every other
setting already in the file:

```toml
[options]
custom-rendezvous-server = '<host>:21116'
relay-server = '<host>:21117'
key = '<id_ed25519.pub>'
```

All three key names were **verified against the pinned 1.4.9 binary** (they
appear as option keys in `liblibrustdesk.dylib`) rather than taken on trust.
`api-server` is deliberately left unset — the rustdesk-api domain is not
published, and a wrong value there breaks the client's address book. Both
servers are written as explicit `host:port`; RustDesk resolves them through
`check_port()`, which would append the same defaults anyway, but writing them
out keeps the shipped config unambiguous and greppable on a customer machine.

Written to:

- `/var/root/Library/Preferences/com.carriez.RustDesk/RustDesk2.toml` — the
  background service runs as root; this is the one that matters for unattended
  access.
- `/Users/<user>/Library/Preferences/com.carriez.RustDesk/RustDesk2.toml` for
  every account with UID >= 500 — the GUI app runs as the console user and reads
  its own copy. Without this the tech sees the public relay in the UI even though
  the service is talking to ours.

`preinstall` deliberately does **not** stop RustDesk. On an upgrade macOS keeps
the running process on its already-open inodes, so it continues on the old bundle
and nobody gets disconnected — booting out `com.carriez.RustDesk_service` would
kill the exact remote session a tech might be installing through. The consequence
is that a new bundle and a changed relay config take effect on the next RustDesk
restart or reboot, not immediately.

## Uninstall / teardown

Everything below is what a full removal must cover.

**In the pkg payload — a manifest-derived sweep catches these automatically:**

- `/Applications/RustDesk.app` (the whole bundle; 678 payload entries)

It is staged into the payload root rather than installed by postinstall
specifically so that it lands in the BOM. `build-pkg.sh` also writes a component
plist setting `BundleIsRelocatable=NO`, because pkgbuild's default for a
discovered bundle tells the installer to look `com.carriez.rustdesk` up in Launch
Services and write to wherever a copy already lives — a user's `~/Downloads`, an
external volume, anywhere. That would put our managed RustDesk at an
unpredictable path and defeat both the postinstall config write and the
uninstaller.

**NOT in the pkg payload — a manifest-derived sweep will MISS these, and they are
the residue left on a client machine:**

| Path | Created by |
|---|---|
| `/Library/LaunchDaemons/com.carriez.RustDesk_service.plist` | RustDesk at runtime, via osascript, when the user enables unattended access |
| `/Library/LaunchAgents/com.carriez.RustDesk_server.plist` | same |
| `/var/root/Library/Preferences/com.carriez.RustDesk/` (`RustDesk.toml`, `RustDesk2.toml`) | our postinstall + RustDesk service |
| `/Users/<user>/Library/Preferences/com.carriez.RustDesk/` (`RustDesk.toml`, `RustDesk2.toml`) | our postinstall + RustDesk GUI |
| `~/Library/Logs/RustDesk/`, `/var/root/Library/Logs/RustDesk/` | RustDesk at runtime |
| TCC grants for `com.carriez.rustdesk` (Screen Recording, Accessibility, Input Monitoring) | macOS, on first use |

The two launchd jobs are the important ones: leave them behind and launchd keeps
trying to start a binary that no longer exists. The uninstaller must explicitly
`launchctl bootout` both labels and remove both plists, and remove the preference
directories for root and for every user, in addition to whatever it derives from
the payload manifest.

`RustDesk.toml` holds the machine's RustDesk ID and its private key. Removing it
means the device gets a new ID if RustDesk is ever reinstalled — correct for a
decommission, worth knowing before using the uninstaller as a repair step.
