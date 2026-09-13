# Recovery Supply-Chain Register

This register documents the trust inputs used by recovery bundle generation and bare-metal recovery media, and whether each input is pinned and verified.

| input | source | pinning | verification | current state |
| --- | --- | --- | --- | --- |
| Recovery helper binary | [recovery-binary-manifest.json](/Users/toddhebebrand/breeze/apps/api/src/services/recovery-binary-manifest.json) plus local file or pinned GitHub release tag | repo-checked manifest entry by platform, arch, source type, source ref, version | SHA-256 digest match required before bundle build | verified for manifest-covered entries |
| Recovery bundle signature key | `RECOVERY_SIGNING_KEYS_JSON` or current signing env vars | config-backed key ids | artifact detail resolves public key by stored `signingKeyId` | verified |
| Current public signing key | `/api/v1/backup/bmr/signing-key` | current key only | direct API exposure | verified |
| Historical signing keys | `RECOVERY_SIGNING_KEYS_JSON` | config-backed array | resolved by `signingKeyId` in artifact detail | supported |
| Recovery media artifact metadata | DB JSON metadata on recovery media rows | persisted per artifact | includes helper digest, source ref, verification status, signing key id | verified for new artifacts |
| Linux recovery boot ISO (W04b) | `breeze-recovery-linux-{amd64,arm64}.iso`, built once per release by the `build-recovery-media` CI job (`agent/recovery-media/`) from the same `breeze-backup` binary `build-agent` produces | listed in `release-artifact-manifest.json` like every other release asset (`platformTrust: "release-workflow-produced"`, `edition: "self-host"`) | release manifest Ed25519 signature; `GET /backup/bmr/boot-media` best-effort echoes the manifest's sha256/size for display (`releaseArtifactManifest.lookupReleaseManifestAssetForDisplay` — informational only, not a trust decision) | verified — served through the same GitHub-release download proxy as every other component binary (`/download/recovery-iso/linux/:arch`), no separate per-recovery build step |

## Legacy handling

- Existing artifacts built before provenance enforcement remain accessible.
- They are identified by missing provenance flags in metadata, and should be treated as legacy outputs rather than verified builds.
