# Self-Hosted Instance Backup — Design

**Date:** 2026-10-05
**Status:** Draft for review. Advisor quorum: Fable (author) + Codex (gpt-6-astra, xhigh, read-only). Codex agreed with the direction (default-on sidecar, direct DB polling, system-scoped tables, CLI-only restore, platform-admin gating) and returned five blocking amendments. All five are folded in below and marked **[Q]**.
**Trigger:** On 2026-09-30 a self-hosted MSP turned on the AI agents feature through `.env`, the API refused to boot, and they rebuilt the VM. Every policy, org, device and user was lost: nothing had ever been backed up, and nothing in the product had told them so.

## Goals

1. **Protected by default.** Every self-hosted install takes encrypted backups with no configuration.
2. **Off-box disaster recovery.** An operator can add an S3-compatible destination so a backup survives losing the VM.
3. **Visible.** Platform admins see backup health in the UI. The product says loudly when protection is missing or stale.
4. **Recoverable without the broken install.** Recovery works from a bare host using only the recovery kit and the backup files. It needs no working `.env`, Compose file or API.
5. **Reversible config edits.** A bad `.env` edit can be undone with one command.

## Non-goals

- **Partner- or org-level backup and restore.** Restoring one tenant into a live shared database means ID remapping and re-keying across hundreds of tables, and every new column would change it. Decided out of scope on 2026-10-05.
- **Restore from the UI.** A UI cannot restore over the database it runs on.
- **Hosted.** `IS_HOSTED=true` hides every surface, and the API routes refuse (404). Hosted runs its own backups (`scripts/ops/offsite-backup.sh`).
- **Managed-database deployments** (`deploy/docker-compose.prod.yml` points `DATABASE_URL` at an external database). These operators use their provider's backups. v1 targets the root `docker-compose.yml` only.
- **External object storage.** When `S3_BUCKET` is set, software uploads and artifacts live in the operator's own bucket, which is already off-box. The recovery manifest records the bucket identity, and the docs say plainly that the bucket is the operator's responsibility. No MinIO ships in the default Compose.
- **UI download of backups (v1)** **[Q]**. A browser download of a full-instance dump is high-value exfiltration. Export stays on the CLI.

## Current state (what exists, what is broken)

- `scripts/backup.sh` / `scripts/restore.sh` run on the host and are opt-in.
  - Prerequisites: a host `pg_dump`, `mc`/`aws`, and `openssl`.
  - Database dumps are **plaintext**. Only the config tarball is encrypted, with `openssl enc -aes-256-cbc`, which is unauthenticated.
  - The documented `DATABASE_URL=…@localhost:5432` cannot reach the default Compose Postgres, which publishes no port.
  - `restore.sh` accepts `pg_restore` exit 1, then treats a successful `SELECT count(*) FROM devices` as verification **[Q]**.
- `apps/docs/src/content/docs/security/backup.mdx` contradicts itself about what `--all` covers.
- `guided-setup.sh --upgrade` deliberately leaves the Compose file untouched (`print_upgrade_compose_reminder`), so a new Compose service never reaches an existing install on its own **[Q]**.
- Platform admin, the only gate on `/admin/*`, comes solely from `BREEZE_PLATFORM_ADMINS` (`services/platformAdminBootstrap.ts`). `.env.example` leaves it empty and `guided-setup.sh` never sets it. **Most self-hosted installs have no platform admin.**
- The setup wizard (`components/setup/SetupWizard.tsx`, steps Account → Organization → Regional → Install Agent) tracks completion per user (`users.setup_completed_at`). `GET /config` does not expose `IS_HOSTED`.

## Architecture

```
┌─────────────── host ───────────────────────────────────────────────┐
│  ./backups/  (BREEZE_BACKUP_DIR)          install dir (.env, compose,│
│     sets/<ts>/ manifest.json + *.age      certs)  ── ro mount ──┐   │
│     config-history/                                             │   │
│                                                                 ▼   │
│  ┌──────────┐  pg_dump / meta writes  ┌──────────────────────────┐  │
│  │ postgres │◄────────────────────────│ backup  (api image,      │  │
│  └──────────┘   role breeze_backup    │  `node dist/backup/run`) │──┼──► S3/B2/R2/MinIO
│       ▲                               └──────────────────────────┘  │     (optional)
│       │ settings/runs rows (system scope)          ▲ ro: api_data,  │
│  ┌──────────┐                                      │    caddy_data  │
│  │   api    │  /admin/system/backups  (UI)         │                │
│  └──────────┘                                                       │
└─────────────────────────────────────────────────────────────────────┘
 Recovery: scripts/breeze-recover.sh → `docker run <api image> recover …`
           (no Compose, no .env; inputs = recovery kit + backup set)
```

### 1. The `backup` service: the API image with a different command

Codex recommended a TypeScript runner that shares `secretCrypto` rather than a second implementation of the crypto contract **[Q]**. The simplest way to get that is to **reuse the API image** and run a different entrypoint (`node dist/backup/runner.js`). No new image is published.

- The API image's runner stage gains `postgresql16-client` and `age`. That is a few MB.
  - Client major must equal the server major. The runner refuses to start, with a clear error, if the server major is higher than the client major.
  - Off-box upload uses the `@aws-sdk/client-s3` the API already depends on, so no rclone.
- **Why reuse instead of a separate image:** a new first-party image has to be added to `release.yml`, `promote-release-images.yml`, the signed-image inventory, `verify-release-images.sh`, and the `guided-setup --upgrade` digest rewrite. Reuse gets signing, multi-arch and digest pinning for free. The API **container** still never runs `pg_dump` and never holds off-box credentials, so the separation of duties that motivated a sidecar is kept.
- **Compose:**
  - `backup` uses `${BREEZE_API_IMAGE_REF}` with `restart: unless-stopped`, depends on `postgres: service_healthy`, and does **not** depend on `api`. Backups therefore keep running when the API won't boot.
  - It connects as a new role, **`breeze_backup`**, rather than the `breeze` superuser **[Q]**. The role is created and kept in sync by `ensureAppRole.ts`-style startup code. It has `LOGIN BYPASSRLS`, `pg_read_all_data`, and DML only on the two backup tables. Its password comes from `BREEZE_BACKUP_DB_PASSWORD`, which guided-setup generates; if that is unset, the password is derived like `breeze_app`'s.
  - Mounts:
    - `${BREEZE_BACKUP_DIR:-./backups}:/backups` read-write;
    - the install dir at `/install` read-only (it reads `.env`, the compose files and `certs/` only);
    - `api_data` and `caddy_data` read-only **[Q]**. `caddy_data` holds the ACME account and any internal CA.
  - The env block is minimal: DB connection, `APP_ENCRYPTION_KEY` (+ `APP_ENCRYPTION_KEYRING`, `APP_ENCRYPTION_KEY_ID`) to unseal the off-box secret, `BREEZE_BACKUP_RECIPIENT`, `IS_HOSTED`. It gets no JWT, no Redis and no AI keys.

### 2. Backup set format (versioned, authenticated) [Q]

Every new backup set is encrypted with **age**, using X25519 recipient mode.

- **Why age:**
  - It is authenticated, streaming, and a standard format.
  - It is readable by the `age` CLI on any machine, so recovery doesn't depend on Breeze tooling.
  - `openssl enc` cannot do authenticated modes. This replaces the CBC format for new sets; `restore.sh` keeps reading the legacy format.
- **The server holds only the public recipient** (`age1…`). The private identity (`AGE-SECRET-KEY-1…`) exists **only in the recovery kit** (§6). A compromised or seized server cannot decrypt off-box copies, and a stolen backup is useless without the kit.

A set is a directory, published atomically: it is written to `sets/.partial-<id>/`, fsynced, then renamed to `sets/<UTC-ts>-<id>/`. It contains:

| File | Contents |
|---|---|
| `db.dump.age` | `pg_dump -Fc -Z 6` of the whole database (all schemas, ownership kept; roles are not in the dump and are re-provisioned by `restore`, §7) |
| `config.tar.age` | `.env`, active compose files + overrides, `certs/`, `docker/secrets/` |
| `api_data.tar.age` | `api_data` volume |
| `caddy_data.tar.age` | `caddy_data` volume |
| `manifest.json` | **Plaintext**, no secrets. Contains: format version; set id; timestamps; Breeze version and **API image digest**; PG server version + extensions (`pgvector`, …); the `breeze_migrations` ledger head (last filename + count); per-file size + sha256 of the ciphertext; the recipient fingerprint; and the external `S3_BUCKET` identity if one is set. |

**Consistency.** The DB dump is a consistent snapshot (pg_dump runs in one repeatable-read transaction). The volume tars are taken right after it and are *not* atomic with it; `manifest.json` records both timestamps. The volumes hold report files and certs, not referential data, so a small skew is acceptable. The docs say so.

**Per-run check.** While dumping, the runner tees the plaintext `pg_dump` stream into `pg_restore --list` (proves the archive is readable) and into `age`. After publishing, it re-reads each ciphertext and checks its sha256 and age header against the manifest. The identity is never needed. Scratch restores into the live cluster are rejected for v1 **[Q]**: they share disk, I/O and failure scope.

### 3. Schedule, retention, capacity

- **First backup on first start.** The runner takes a set as soon as it starts and finds no set at all **[Q]**, then runs on schedule: daily at a configured hour (default 02:00 in the server's timezone).
- **Local retention** defaults to **7** daily sets and is configurable from 2 to 30.
- **Pre-flight space check.** Before each run, free space on `/backups` must be at least 2× the last set's size plus 2 GB. If it isn't, the run fails with `insufficient_space`; it never prunes to make room.
- **Pruning and failures.** Pruning runs only after a successful publish and **never deletes the newest good set**. A failed run leaves the previous good set untouched **[Q]**.
- **Off-box retention is independent [Q].** It defaults to 30 daily and 12 monthly. Uploads are append-only under `<prefix>/sets/<set-id>/`, and pruning local sets never deletes off-box sets. Where the provider supports it, the docs recommend bucket versioning or object lock.

### 4. Config history (undo a bad `.env` edit)

- **Capture.** Every 60s the runner hashes `/install/.env` and the compose files. On a change it writes a timestamped copy to `config-history/` (mode 0600, root-owned, plaintext). It keeps the last 30 copies.
  - These copies sit on the same disk as `.env` and carry the same exposure. They are plaintext on purpose: undoing a bad edit has to work without the recovery kit.
  - They go into backup sets only inside `config.tar.age`.
- **Known-good marking [Q].** A copy is marked `known_good` after the API has reported healthy (`http://api:3001/health`) for 5 continuous minutes on that config hash. Polling also captures broken edits, so the undo target is "last known good", not "previous".
- **Undo.** `scripts/breeze-recover.sh config --last-good` (or `--at <ts>`) restores the copy to `.env`, keeping the current file as `.env.rejected-<ts>`, then prints the `docker compose up -d` line. It needs no kit and no running API. This path alone would have recovered the 2026-09-30 incident.

### 5. Settings, runs, "back up now"

Two new system-scoped tables follow the `ai_kill_state` template: `FORCE ROW LEVEL SECURITY`, one policy `USING/WITH CHECK (current_setting('breeze.scope', true) = 'system')`, listed in `INTENTIONAL_UNSCOPED` + `EXEMPT_TABLES` in `rls-coverage.integration.test.ts` with a justification. They have no `org_id`, so no cascade or export-policy registration applies.

**`instance_backup_settings`** has a single row, `id = 'global'` with a CHECK:
- `schedule_hour`, `local_retention_days`;
- `recipient` (`age1…`), `recipient_set_at`;
- off-box settings: `offsite_enabled`, `offsite_endpoint`, `offsite_bucket`, `offsite_prefix`, `offsite_region`, `offsite_access_key_id`, `offsite_secret_access_key`, `offsite_retention_daily`, `offsite_retention_monthly`, `offsite_force_path_style`;
- `kit_confirmed_at`, `kit_confirmed_by`;
- `updated_at`, `updated_by`.

`offsite_secret_access_key` is sealed with `encryptSecret` (v3 + column AAD), registered in `encryptedColumnRegistry.ts` so key rotation covers it **[Q]**, and masked in every response.

**`instance_backup_runs`** has:
- `id`, `request_id` (nullable, unique), `kind` (`scheduled | manual | initial | pre_upgrade`);
- `status` (`queued | running | succeeded | failed`), `claimed_at`, `started_at`, `finished_at`;
- `set_id`, `bytes`, `offsite_status` (`skipped | uploaded | failed`), `offsite_error`, `error_code`, `error_detail`.

**`instance_backup_heartbeat`** is a single row: `seen_at`, `runner_version`, `free_bytes`, `last_config_hash`. It is kept separate from settings so heartbeat writes never contend with admin edits **[Q]**.

**Runner rules [Q]:**

- **Single-run lock.** The runner holds the advisory lock `pg_try_advisory_lock(hashtext('breeze.instance_backup'))` for every run.
- **Atomic claims.** "Back up now" inserts a `queued` run with a fresh `request_id`. The runner claims it with `UPDATE … SET status='running', claimed_at=now() WHERE id=$1 AND status='queued'`.
- **Missing state vs read failure.**
  - A **missing table** (an old DB) means "defaults, local only".
  - A **missing row** means defaults.
  - A **read error** means "keep the last settings that loaded successfully, and record a failure". A failed read never silently turns off-box off.
- **No recipient.** With no recipient set, the runner still takes local sets. It writes them as `*.unencrypted` (0600), which is the same exposure as `postgres_data` on the same disk, and refuses off-box upload. Status shows **"Not encrypted — finish setup"**.

### 6. Recovery kit [Q]

One passphrase decrypts, but it doesn't retrieve: if the off-box credentials existed only inside the lost database, recovery could not even download the backup. The kit is therefore a single printable page (and a `.txt`):

- the age **identity** (private key);
- the instance name/URL and the set naming;
- the off-box endpoint, bucket, prefix, and **a read-only access key for that prefix**. The UI asks for one; if the operator only has a read-write key, it warns, explains the risk, and includes that key;
- the exact recovery commands (§7).

**Generation.** The kit is generated **client-side**:
- **Setup wizard and admin UI:** the browser generates the age keypair with the `age-encryption` npm package and POSTs only the recipient. The identity never reaches the server.
- **Guided setup:** `guided-setup.sh` generates it with `docker run <api image> age-keygen` and shows it in the terminal.

**Confirmation and rotation.** The kit must be confirmed ("I have stored this somewhere other than this server"), recorded as `kit_confirmed_at`. "Generate a new kit" rotates the recipient. Older sets stay readable with the old kit, and the UI says so.

### 7. Recovery CLI (independent of the broken install) [Q]

`scripts/breeze-recover.sh` is a small POSIX script, shipped in the repo and downloadable on its own. It **never sources `.env` and never invokes `docker compose`**: Compose aborts on interpolation before any container starts if `.env` is broken or missing. It runs the pinned API image recorded in the set manifest, `docker run --rm -it <image@digest> recover …`, with explicit mounts.

- `config --last-good | --at <ts>` restores `.env` from config history (§4).
- `list [--offsite]` lists local sets, or off-box sets using the kit's credentials.
- `fetch <set-id>` downloads an off-box set to the local backup dir.
- `restore <set-id> [--to <install dir>]` is a full restore. It prompts for the identity on the TTY (never as an argument), then:
  1. Refuses unless the application writers (`api`, `worker`) are stopped. It checks via the Docker socket only when the operator passes `--allow-docker-check`; otherwise it asks the operator to confirm.
  2. Requires an **empty** target database, or `--replace` with typed confirmation, which drops and recreates it.
  3. Provisions roles (`breeze_app`, `breeze_backup`) and extensions (`vector`, …) recorded in the manifest **before** `pg_restore`.
  4. Runs `pg_restore --exit-on-error --single-transaction`. **Any** error fails the restore [Q].
  5. Restores config, `api_data` and `caddy_data` to explicit destinations, not read-only mounts.
  6. Verifies the result: the migration ledger head equals the manifest's, row counts for a fixed list of anchor tables are non-zero where the manifest recorded non-zero, and `pg_restore --list` object count matches.
  7. Prints the image digest to start with and the `docker compose up -d` line.
- `export <set-id> <dest>` copies an encrypted set somewhere for the operator. This is the CLI replacement for a UI download.

`restore.sh` / `backup.sh` keep working for legacy installs. `backup.sh` gains a deprecation note pointing at the service. `restore.sh` keeps the legacy CBC reader.

### 8. Platform-admin provisioning [Q]

Backup settings stay **platform-admin only**. A partner admin's authority doesn't extend to exporting every partner.

- **New installs.** `guided-setup.sh` writes `BREEZE_PLATFORM_ADMINS=<BREEZE_BOOTSTRAP_ADMIN_EMAIL>`. An existing non-empty list is never overwritten.
- **Existing installs.** `guided-setup.sh --upgrade` asks once, if the list is empty: "Which existing user is the instance operator?" It validates the user exists via `docker compose exec api` and appends that user.
- **Manual installs.** A new CLI, `docker compose exec api node dist/cli/platform-admin.js grant <email>`, promotes an existing user and is audit-logged. Bootstrap stays promote-only and never revokes.

### 9. Admin UI: `/admin/system`, "Backups" tab

This adds a tab to `SystemPage.tsx` (alongside `connections` and `deprecations`), so it needs no new nav entry. Routes live at `/admin/system/backups/*` behind `platformAdminMiddleware`. Mutations require `requireMfa()`. Every route returns 404 when `isHosted()`.

The tab has:
- **Status:** two independent tiles **[Q]**:
  - **Rollback protection (local):** last good set, age, size, free space.
  - **Disaster recovery (off-box):** last upload, or **"Not configured"** shown as a warning, never as neutral.
  - Plus service heartbeat and encryption state.
- **History:** the last 30 runs with status and error.
- **Settings:** schedule hour and local retention. Off-box: endpoint, bucket, prefix, region, keys, retention, plus **Test connection** (PUT/HEAD/DELETE of a probe object under the prefix).
- **Recovery kit:** shows whether it is confirmed and the recipient fingerprint, plus "Generate a new kit".
- **Back up now:** queues a manual run and polls its row.

**Settings rule 9:**
- **Home:** Admin → System → Backups.
- **Level:** platform only, no partner/org override.
- **Resolver:** `getInstanceBackupSettings()`, used by the API and the runner.
- **Count:** the concept is configured in 0 places before and 1 after.

### 10. Banner

`InstanceBackupBanner` uses the `MigrationRequiredBanner` pattern: self-host only, platform admins only, not dismissible, and it clears when the condition clears. Conditions are checked in priority order:

1. The service is not running: heartbeat older than 10 min, or never seen. This covers installs that haven't merged the Compose change.
2. Encryption isn't set up: no recipient, or the kit isn't confirmed.
3. No successful set in 48 h.
4. Off-box is not configured, or the last upload failed. This one is dismissible for 30 days, because local-only is a legitimate choice.

It reads a new `GET /config` field, `isHosted`, plus a lightweight `GET /admin/system/backups/status`.

### 11. Setup wizard step: "Backups"

**Instance onboarding vs per-user setup [Q].** The wizard is per-user, but backup setup is instance-wide. The step appears only when all of these hold:
- the user is a platform admin;
- `!isHosted`;
- `instance_backup_settings.kit_confirmed_at IS NULL`.

A second admin therefore never sees it once the kit is confirmed.

The step:
1. Explains in two sentences what is already happening (local nightly backups).
2. Generates the kit client-side and requires the confirmation checkbox before continuing.
3. Offers off-box setup, with Test connection, or "Local only for now".

The step can be skipped; the banner stays until the conditions clear. It goes before "Install Agent" (index 3), because `EnrollDeviceStep` completes setup.

### 12. Rollout to existing installs [Q]

- **Guided installs.** `guided-setup.sh --enable-backups` is idempotent. It:
  1. adds the `backup` service to the active Compose file (or an override file if the operator uses one) and generates `BREEZE_BACKUP_DB_PASSWORD`;
  2. generates the kit (§6) and requires confirmation;
  3. runs `docker compose up -d backup`;
  4. waits for the initial set to succeed and prints its id.

  `--upgrade` offers to run `--enable-backups` when the `backup` service is absent.
- **Manual installs.** The upgrade notes for the release carry a copy-paste service block. The banner (§10, condition 1) nags until the service is running.

### 13. Pre-upgrade backup

- **v1:** `guided-setup.sh --upgrade` takes a `pre_upgrade` set with the current image **before** pulling the new one. It inserts a `queued` run and waits for it. On failure it aborts the upgrade unless the operator passes `--skip-pre-upgrade-backup` **[Q]**. The docs state that raw `docker compose pull && up -d` upgrades skip this.
- **Deferred (W3):** API-side coordination when there are pending migrations. Codex found that `upgradePreflight` runs outside the migration advisory lock (`databaseStartup.ts:105`, `autoMigrate.ts:609`). A correct version must request and wait **under** that lock, with matching request/completion IDs, handling for a missing table, and cancellation on timeout. Otherwise a second migrator could proceed mid-dump.

## Waves

| Wave | Scope | Ships when |
|---|---|---|
| **W1: engine + recovery** | API image adds pg16 client + age; `backup/runner` (set format, age, manifest, per-run check, retention, space pre-flight, config history + known-good, advisory lock); `breeze_backup` role; the three tables + RLS + allowlists; off-box S3 upload + independent retention; `breeze-recover.sh` (`config`, `list`, `fetch`, `restore`, `export`); Compose service; guided-setup `--enable-backups` + new-install kit + pre-upgrade backup; `platform-admin grant` CLI + guided-setup admin provisioning | Integration test: **backup → destroy DB + volumes → recover from kit + set → API boots, ledger + anchor counts match**. Off-box path tested against MinIO in CI. A manual clean-host recovery drill (fresh VM, only kit + bucket) is recorded in the PR. |
| **W2: UI** | `GET /config.isHosted`; `/admin/system/backups` routes + tab; Test connection; client-side kit generation; banner; wizard step | Unit + route tests (hosted → 404, non-admin → 403, secret masked, MFA on mutations); Playwright: wizard step + tab on a wt-stack. |
| **W3: hardening** | API pre-migration coordination under the migration lock; isolated, resource-limited scheduled restore drills (separate container + temp volume, opt-in) | Integration tests for lock coordination: concurrent migrator, timeout, absent table. |

W1 is useful on its own: CLI-only, the banner-less baseline. W2 depends on W1's tables.

## Testing contract

- **Crypto.** `encryptSecret` ⇄ runner unseal uses the same module, so there is no cross-language vector. Rotation is tested via `encryptedColumnRegistry`. Tamper tests: flip one byte in each `*.age` file and the per-run check must fail. Every age file must fail when decrypted with the wrong identity.
- **Restore strictness.** Inject a failing object into a dump and `restore` must exit non-zero with nothing left half-applied.
- **Failure semantics.** Each of these has a test:
  - a full disk, an off-box outage, or a settings read error leaves the last good set intact and records `error_code`;
  - a read error does not disable off-box;
  - two runners never run concurrently.
- **RLS.** `rls-coverage` allowlist entries. As `breeze_app`, every access to the three tables is denied outside system scope.
- **Hosted.** Every route returns 404 under `IS_HOSTED=true`. The `backup` service is absent from hosted Compose.

## Decisions for Todd

1. **Recovery-kit model:** the server holds only the public key; losing the kit means backups can't be decrypted. The alternative, a passphrase stored in `.env`, is simpler but puts the decryption secret inside every config backup and on the server. **Recommend the kit model.**
2. **Reuse the API image** for the `backup` service instead of publishing a new `backup` image. **Recommend reuse** (no release-pipeline changes; shares `secretCrypto`).
3. **Unencrypted local fallback** before a kit exists (0600, local only, never off-box). The alternative is no backups until the kit is confirmed. **Recommend the fallback**: protection beats purity, and the exposure equals `postgres_data`'s.
4. **Local retention default 7.** Disk headroom is the constraint; off-box carries the long tail.
