# `docker/secrets/`

## `.empty-jwk`

An intentionally empty, tracked regular file. It is the default `file:`
source for the optional M365 executor signing-key secrets in
`docker-compose.yml` and `deploy/docker-compose.prod.yml`
(`m365_graph_read_executor_signing_private_jwk`,
`m365_graph_actions_executor_signing_private_jwk`,
`m365_comms_executor_signing_private_jwk`) whenever the corresponding
`M365_*_SIGNING_PRIVATE_JWK_SOURCE_FILE` env var is left unset — which is the
common case, since these features are off by default.

Docker Compose's standalone (non-swarm) file-secret support bind-mounts the
source file into the container and remounts it read-only. Before this file
existed, the default source was `/dev/null`. Bind-mounting the `/dev/null`
character device and remounting it read-only inside an overlayfs rootfs is
rejected by the kernel on a number of host kernel/storage-driver combinations,
failing `docker compose up` with `remount-ro ... operation not permitted` —
even for deployments that never touch the M365 write-actions feature (issue
#2991). A regular file has no such restriction, so pointing the default here
instead of at `/dev/null` avoids the failure while keeping the secret mount
present (required by
`scripts/security/check-supply-chain-hardening.sh`) and functionally
equivalent — an all-zero-length "key" the API's config validator still
correctly treats as absent.

**Keep this file empty.** `apps/api/src/config/composeSecretFileDefaults.test.ts`
asserts every `file:` secret default in the tracked Compose files resolves to
an existing regular file (not a directory, not a device node) — this file is
what makes that assertion pass for the M365 JWK secrets.
