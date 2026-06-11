# Release manifest signing keys

These are the keys the GitHub release workflow uses to sign every release's
`release-artifact-manifest.json`. Two parallel signature schemes:

| Algorithm | Public key file | Private key | Verifier |
|---|---|---|---|
| Ed25519 (raw) | `release-manifest.ed25519.pub` | GitHub secret `RELEASE_MANIFEST_ED25519_PRIVATE_KEY` | The Breeze agent (embedded) and the API |
| Minisign | `release-manifest.minisign.pub` | GitHub secret `RELEASE_MANIFEST_MINISIGN_PRIVATE_KEY` | Minisign verifiers (humans, CI checks) |

The local `.key` files are gitignored copies of the GitHub secrets used for
local signing experiments — never commit them.

## ⚠ When you rotate `release-manifest.ed25519.pub`

The agent embeds the **raw 32-byte Ed25519 public key** (the SPKI suffix of
this `.pub` file, base64-encoded) at
`agent/internal/updater/updater.go` in `trustedUpdateManifestPublicKeys`.
**If you rotate the signing key, the embedded list must include the new
public key in the same release** — otherwise auto-update breaks for every
agent that ships from then on (this is exactly how PR #568 broke
v0.65.5/v0.65.6, fixed by `6744d54a`).

To extract the raw Ed25519 bytes from this file:

```bash
openssl pkey -pubin -in release-manifest.ed25519.pub -outform DER \
  | tail -c 32 | base64
# → yzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso=
```

Paste that base64 string into `trustedUpdateManifestPublicKeys`. Keep the
old key in the slice for at least one release so existing agents can still
verify the previous manifests during their upgrade window.

The regression test
`agent/internal/updater/updater_test.go::TestEmbeddedTrustRootMatchesRepoPubKey`
runs in CI and fails the build if the embedded list doesn't include the
current public key — so a rotation that updates one but not the other won't
ship.

## Recovering agents stuck on a wrong-key build

If an agent fleet is on a version with a broken embedded key (so they can't
auto-update past it), use the server-orchestrated recovery script:

```bash
docker compose exec -w /app/apps/api api node dist/scripts/recover-stuck-agents.cjs --apply
```

It dispatches `dev_update` commands that bypass manifest signature
verification (using the API's own bearer-token chain of trust instead). See
`apps/api/scripts/recover-stuck-agents.ts` for the full flow and safety
checks.
