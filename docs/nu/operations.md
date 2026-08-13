# NU Operations

Release, deploy, rollback, backup, and agent-staging runbook for the NU
(Nodes Unlimited) Breeze stack on Coolify/titan01.
See also [known-issues.md](known-issues.md), [msi.md](msi.md),
[branding.md](branding.md).

## Server release runbook

1. **Fetch/merge upstream** into the fork branch.
2. **Gates:** `pnpm build`; `go build ./...` + `go test` in `agent/`; targeted
   test suites for anything touched.
3. **PR to main**, merge.
4. **Tag** in the fork's own namespace: `nu-vX.Y.Z-nu.N` (any `nu-v*` tag
   triggers the workflow; the tag namespace exists so upstream `v*` tags never
   collide with fork releases).
5. **`.github/workflows/nu-images.yml`** builds and pushes
   `ghcr.io/bloomingbrands/breeze/api` and `.../web` (amd64 only, on purpose).
   Tag policy: the literal git tag for pinning; `APP_VERSION` build-arg strips
   the `nu-v` prefix.
6. **Deploy via Coolify API:** `GET /api/v1/deploy?uuid=<uuid>` (per-resource
   uuid). Remember the Coolify landmines in
   [known-issues.md](known-issues.md#coolify-landmines) — especially
   LocalFileVolume NULL content writing an empty file on Deploy.
7. **Smoke:** run the NU smoke script. ⚠️ As of 2026-08-13 `deploy/nu/` contains
   only `Caddyfile`, `docker-compose.nu.yml`, `env.nu.example` — the referenced
   `deploy/nu/smoke.sh` is the scripted check; as a manual fallback verify login,
   agent heartbeat, and device list manually.

## Cutover / rollback

Images are selected by the `BREEZE_API_IMAGE` / `BREEZE_WEB_IMAGE` env rows on
the Coolify service.

- **Cutover:** set both rows to the new `ghcr.io/bloomingbrands/breeze/{api,web}:nu-vX.Y.Z-nu.N`
  tags, redeploy.
- **Rollback:** CLEAR both rows (compose falls back to the upstream default
  images) and redeploy. Write env rows via the Coolify REST API only — service
  envs are Laravel encrypted casts
  ([known-issues.md](known-issues.md#coolify-landmines)).

## Database backup / restore

```sh
# backup
docker exec <pg-container> pg_dump -U postgres -d breeze | gzip > breeze-$(date +%F).sql.gz
# restore
gunzip -c breeze-YYYY-MM-DD.sql.gz | docker exec -i <pg-container> psql -U postgres -d breeze
```

Take a backup before any deploy that includes migrations.

## Agent release staging

Script: `agent/installer/release/stage-release.sh`. It builds every
agent-family binary CGO-off (M5 crash — [known-issues.md](known-issues.md)),
writes a signed `release-artifact-manifest`, and lays the set out ready to copy
into the server's binaries volume:

```
/var/lib/docker/volumes/<uuid>_breeze-api-data/_data/binaries
```

Key facts (from the script):

- `VERSION` defaults to the current fleet version; it must match the server's
  `BREEZE_VERSION`/`APP_VERSION` — binarySync treats a disagreeing volume
  `VERSION` file as a "stale binaries volume" and falls back to pulling stock
  upstream binaries from GitHub (the exact binaries we are replacing).
- Signing key: `~/.nu-agent-signing/nu-release-manifest.ed25519.key`. The
  manifest signed with OUR key at the volume root is the whole trust chain —
  it makes the server register assets against the public key embedded in our
  agent (`agent/internal/updater/updater.go: embeddedManifestPublicKeys`)
  instead of re-signing per deployment.
- Components default to `agent watchdog` (deliberately NOT `backup`); targets
  cover darwin/linux/windows on amd64+arm64, including windows-arm64 which
  upstream never shipped.
- Filenames are PROTOCOL: `breeze-{component}-{os}-{arch}[.exe]`
  (`apps/api/src/services/binarySync.ts parseBinaryFilename()`); rename them
  and the server silently discovers zero binaries. See
  [branding.md](branding.md).

**Ordering rule:** the volume `VERSION` file governs agent update ordering.
NEVER bump it without staging matching signed binaries FIRST — and never let an
agent artifact version drift from it (semver prerelease trap,
[known-issues.md](known-issues.md#semver-prerelease-version-trap)).

## Standing duties

- **Back up `~/.nu-agent-signing/` off-machine.** It holds both the release
  manifest signing key (above) and the macOS "NU Agent Signing" .p12. Both are
  unrecoverable; losing the .p12 drops TCC permissions fleet-wide on the next
  build ([known-issues.md](known-issues.md#stable-code-signing-identity-vs-tcc)).
