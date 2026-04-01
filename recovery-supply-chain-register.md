# Recovery Supply-Chain Register

This register documents the trust inputs used by recovery bundle and boot-media generation, and whether each input is pinned and verified.

| input | source | pinning | verification | current state |
| --- | --- | --- | --- | --- |
| Recovery helper binary | [recovery-binary-manifest.json](/Users/toddhebebrand/breeze/apps/api/src/services/recovery-binary-manifest.json) plus local file or pinned GitHub release tag | repo-checked manifest entry by platform, arch, source type, source ref, version | SHA-256 digest match required before bundle build | verified for manifest-covered entries |
| Recovery bundle signature key | `RECOVERY_SIGNING_KEYS_JSON` or current signing env vars | config-backed key ids | artifact detail resolves public key by stored `signingKeyId` | verified |
| Current public signing key | `/api/v1/backup/bmr/signing-key` | current key only | direct API exposure | verified |
| Historical signing keys | `RECOVERY_SIGNING_KEYS_JSON` | config-backed array | resolved by `signingKeyId` in artifact detail | supported |
| Boot-media template input | [recovery-boot-template-manifest.json](/Users/toddhebebrand/breeze/apps/api/src/services/recovery-boot-template-manifest.json) plus configured template directory | repo-checked manifest entry by source ref and version | deterministic template tree digest match required before boot-media build | verified for manifest-covered entries |
| Recovery media artifact metadata | DB JSON metadata on recovery media rows | persisted per artifact | includes helper digest, source ref, verification status, signing key id | verified for new artifacts |
| Boot-media artifact metadata | DB JSON metadata on boot media rows | persisted per artifact | includes template ref/digest, source bundle artifact, signing key id | verified for new artifacts |

## Legacy handling

- Existing artifacts built before provenance enforcement remain accessible.
- They are identified by missing provenance flags in metadata, and should be treated as legacy outputs rather than verified builds.
